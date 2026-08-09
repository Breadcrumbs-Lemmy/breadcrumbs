import { daysBetween, monthKey } from "./dates";
import { getCategoryMetadata, merchantKeyFromText } from "./normalization";
import type {
  Account,
  FlowType,
  MonthlySpendingAttribution,
  MonthlySpendingComparison,
  MonthlySpendingSummary,
  Transaction,
} from "./types";

const TRANSFER_LIKE_CATEGORIES = new Set([
  "transfer",
  "savings_transfer",
  "credit_card_payment",
  "debt_payment",
]);
const MINIMUM_TRUSTED_TRANSFER_MATCH_CONFIDENCE = 0.8;

type MutableSummary = Omit<MonthlySpendingSummary, "categoryTotals" | "merchantTotals" | "accountTotals" | "institutionTotals" | "comparison"> & {
  categoryTotals: Map<string, MutableCategoryTotal>;
  merchantTotals: Map<string, MutableMerchantTotal>;
  accountTotals: Map<string, MutableAttribution>;
  institutionTotals: Map<string, MutableAttribution>;
};

type MutableCategoryTotal = {
  category: string;
  displayName: string;
  requiredDefault: boolean;
  outflowCents: number;
  grossOutflowCents: number;
  refundCents: number;
  transactionCount: number;
  refundTransactionCount: number;
};

type MutableMerchantTotal = {
  normalizedMerchantId: string;
  displayName: string;
  merchantAmbiguity: boolean;
  ambiguousTransactionCount: number;
  unknownTransactionCount: number;
  outflowCents: number;
  grossOutflowCents: number;
  refundCents: number;
  transactionCount: number;
  refundTransactionCount: number;
};

type MutableAttribution = MonthlySpendingAttribution;

export function summarizeMonthlySpending(
  transactions: Transaction[],
  currency: string,
  accounts: Account[] = [],
): MonthlySpendingSummary[] {
  const accountLookup = new Map(accounts.map((account) => [account.id, account]));
  const normalizedTransactions = normalizeTransferPairs(
    transactions.filter((transaction) => transaction.currency === currency),
    accountLookup,
  );
  const months = new Map<string, MutableSummary>();

  for (const transaction of normalizedTransactions) {
    const month = monthKey(transaction.postedDate);
    const bucket = months.get(month) ?? createMonthBucket(month, currency);
    addTransactionToBucket(bucket, transaction, accountLookup);
    months.set(month, bucket);
  }

  const baseSummaries = [...months.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map(finalizeMonthBucket);

  return baseSummaries.map((summary, index) => ({
    ...summary,
    comparison: buildComparison(summary, baseSummaries.slice(Math.max(0, index - 2), index)),
  }));
}

/**
 * Read-time transfer pairing, shared across the screen endpoints.
 *
 * `summarizeMonthlySpending` pairs offsetting cross-account transfers on its own
 * cloned copy, so the Spending summary already excludes them. But the
 * Transactions and Insights endpoints call different core functions
 * (`queryTransactions`, `detectInsights`) that *read* `counterAccountId` /
 * `transferMatchConfidence` while nothing on those paths ever wrote them — so
 * the same inter-account transfer showed as `UNCLASSIFIED` there instead of
 * `TRANSFER_OUT`/`TRANSFER_IN`, and its counter-account was never linked. That
 * is the `CD-012` failure mode: a derived field only hand-written fixtures
 * populated. Applying this once at the read boundary (the way
 * `annotateRecurrenceSignals` is) makes pairing consistent across every screen.
 *
 * It is idempotent: `normalizeTransferPairs` only considers `UNCLASSIFIED`
 * transfer-like rows as candidates, so an already-paired row (now
 * `TRANSFER_OUT`/`TRANSFER_IN`) is skipped by the later internal pass inside
 * `summarizeMonthlySpending`, which keeps the Spending summary byte-for-byte
 * unchanged. Cross-currency rows are never matched (guarded in the pairing), so
 * passing an all-currency list here is safe.
 */
export function annotateTransferPairs(options: {
  transactions: Transaction[];
  accounts?: Account[];
}): Transaction[] {
  const accountLookup = new Map((options.accounts ?? []).map((account) => [account.id, account]));
  return normalizeTransferPairs(options.transactions, accountLookup);
}

function normalizeTransferPairs(
  transactions: Transaction[],
  accountLookup: Map<string, Account>,
): Transaction[] {
  const normalized = transactions.map((transaction) => ({ ...transaction }));
  const candidates = normalized
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => transaction.flowType === "UNCLASSIFIED" && isTransferLike(transaction));
  const paired = new Set<number>();

  for (const left of candidates) {
    if (paired.has(left.index)) continue;

    const match = candidates.find((right) => {
      if (left.index === right.index || paired.has(right.index)) return false;
      if (left.transaction.accountId === right.transaction.accountId) return false;
      if (left.transaction.currency !== right.transaction.currency) return false;
      if (left.transaction.amountCents + right.transaction.amountCents !== 0) return false;
      return Math.abs(daysBetween(left.transaction.postedDate, right.transaction.postedDate)) <= 3;
    });

    if (!match) continue;

    paired.add(left.index);
    paired.add(match.index);
    const leftTransaction = normalized[left.index];
    const rightTransaction = normalized[match.index];
    if (!leftTransaction || !rightTransaction) continue;
    markTransferPair(leftTransaction, rightTransaction, accountLookup);
  }

  return normalized;
}

function markTransferPair(
  left: Transaction,
  right: Transaction,
  accountLookup: Map<string, Account>,
): void {
  const leftAccount = accountLookup.get(left.accountId);
  const rightAccount = accountLookup.get(right.accountId);
  const confidence = leftAccount && rightAccount ? 0.9 : 0.8;

  left.flowType = left.amountCents < 0 ? "TRANSFER_OUT" : "TRANSFER_IN";
  left.counterAccountId = right.accountId;
  left.transferMatchConfidence = confidence;

  right.flowType = right.amountCents < 0 ? "TRANSFER_OUT" : "TRANSFER_IN";
  right.counterAccountId = left.accountId;
  right.transferMatchConfidence = confidence;
}

function addTransactionToBucket(
  bucket: MutableSummary,
  transaction: Transaction,
  accountLookup: Map<string, Account>,
): void {
  const account = accountLookup.get(transaction.accountId);
  const institutionName = account?.institutionName ?? "Unassigned institution";
  const accountTotal = getAccountTotal(bucket.accountTotals, transaction, account, institutionName);
  const institutionTotal = getInstitutionTotal(bucket.institutionTotals, institutionName, transaction.accountId);
  const totals = [accountTotal, institutionTotal];
  const amount = Math.abs(transaction.amountCents);
  const creditCardPayment = isCreditCardPayment(transaction, accountLookup);
  const flowType = resolveFlowType(transaction, accountLookup);

  switch (flowType) {
    case "SPEND":
    case "FEE":
      bucket.grossOutflowCents += amount;
      bucket.totalOutflowCents += amount;
      addOutflowToAttributions(totals, amount);
      addCategoryOutflow(bucket.categoryTotals, transaction.category, amount);
      addMerchantOutflow(bucket.merchantTotals, transaction, amount);
      break;
    case "REFUND":
      bucket.refundCents += amount;
      bucket.totalOutflowCents -= amount;
      addRefundToAttributions(totals, amount);
      addCategoryRefund(bucket.categoryTotals, transaction.category, amount);
      addMerchantRefund(bucket.merchantTotals, transaction, amount);
      break;
    case "INCOME":
      bucket.totalInflowCents += amount;
      for (const total of totals) {
        total.totalInflowCents += amount;
        total.incomeTransactionCount += 1;
      }
      break;
    case "TRANSFER_OUT":
      bucket.excludedTransferOutflowCents += amount;
      if (creditCardPayment) bucket.excludedCreditCardPaymentOutflowCents += amount;
      for (const total of totals) {
        total.excludedTransferOutflowCents += amount;
        if (creditCardPayment) total.excludedCreditCardPaymentOutflowCents += amount;
      }
      break;
    case "TRANSFER_IN":
      bucket.excludedTransferInflowCents += amount;
      if (creditCardPayment) bucket.excludedCreditCardPaymentInflowCents += amount;
      for (const total of totals) {
        total.excludedTransferInflowCents += amount;
        if (creditCardPayment) total.excludedCreditCardPaymentInflowCents += amount;
      }
      break;
    case "UNCLASSIFIED":
      if (transaction.amountCents < 0) {
        bucket.unclassifiedOutflowCents += amount;
        for (const total of totals) total.unclassifiedOutflowCents += amount;
      } else if (transaction.amountCents > 0) {
        bucket.unclassifiedInflowCents += amount;
        for (const total of totals) total.unclassifiedInflowCents += amount;
      }
      break;
  }
}

function resolveFlowType(transaction: Transaction, accountLookup: Map<string, Account>): FlowType {
  if (transaction.flowType !== "TRANSFER_OUT" && transaction.flowType !== "TRANSFER_IN") {
    return transaction.flowType;
  }

  if (!transaction.counterAccountId) return "UNCLASSIFIED";
  if (!accountLookup.has(transaction.counterAccountId)) return "UNCLASSIFIED";
  if ((transaction.transferMatchConfidence ?? 0) < MINIMUM_TRUSTED_TRANSFER_MATCH_CONFIDENCE) {
    return "UNCLASSIFIED";
  }

  return transaction.flowType;
}

function createMonthBucket(month: string, currency: string): MutableSummary {
  return {
    month,
    currency,
    totalOutflowCents: 0,
    grossOutflowCents: 0,
    totalInflowCents: 0,
    refundCents: 0,
    categoryTotals: new Map(),
    merchantTotals: new Map(),
    accountTotals: new Map(),
    institutionTotals: new Map(),
    excludedTransferOutflowCents: 0,
    excludedTransferInflowCents: 0,
    excludedCreditCardPaymentOutflowCents: 0,
    excludedCreditCardPaymentInflowCents: 0,
    unclassifiedOutflowCents: 0,
    unclassifiedInflowCents: 0,
    freshness: {
      status: "usable",
      source: "fixture",
      warnings: [],
    },
    uncertainty: {
      confidence: 1,
      isEstimated: false,
    },
  };
}

function finalizeMonthBucket(bucket: MutableSummary): MonthlySpendingSummary {
  return {
    ...bucket,
    categoryTotals: [...bucket.categoryTotals.values()].sort(
      (left, right) => right.outflowCents - left.outflowCents || left.category.localeCompare(right.category),
    ),
    merchantTotals: [...bucket.merchantTotals.values()].sort(
      (left, right) =>
        right.outflowCents - left.outflowCents ||
        left.normalizedMerchantId.localeCompare(right.normalizedMerchantId),
    ),
    accountTotals: [...bucket.accountTotals.values()].sort(
      (left, right) => right.totalOutflowCents - left.totalOutflowCents || left.displayName.localeCompare(right.displayName),
    ),
    institutionTotals: [...bucket.institutionTotals.values()].sort(
      (left, right) => right.totalOutflowCents - left.totalOutflowCents || left.displayName.localeCompare(right.displayName),
    ),
    comparison: emptyComparison(bucket.month),
  };
}

function getAccountTotal(
  totals: Map<string, MutableAttribution>,
  transaction: Transaction,
  account: Account | undefined,
  institutionName: string,
): MutableAttribution {
  const existing = totals.get(transaction.accountId);
  if (existing) {
    existing.transactionCount += 1;
    return existing;
  }

  const created = createAttribution({
    id: transaction.accountId,
    displayName: account?.displayName ?? transaction.accountId,
    institutionName,
    accountType: account?.type,
    accountRole: account?.role,
  });
  created.transactionCount = 1;
  totals.set(transaction.accountId, created);
  return created;
}

function getInstitutionTotal(
  totals: Map<string, MutableAttribution>,
  institutionName: string,
  accountId: string,
): MutableAttribution {
  const id = `institution:${institutionName}`;
  const existing = totals.get(id);
  if (existing) {
    existing.transactionCount += 1;
    if (existing.accountIds && !existing.accountIds.includes(accountId)) existing.accountIds.push(accountId);
    return existing;
  }

  const created = createAttribution({
    id,
    displayName: institutionName,
    institutionName,
    accountIds: [accountId],
  });
  created.transactionCount = 1;
  totals.set(id, created);
  return created;
}

function createAttribution(input: {
  id: string;
  displayName: string;
  institutionName: string;
  accountIds?: string[];
  accountType?: Account["type"];
  accountRole?: Account["role"];
}): MutableAttribution {
  return {
    id: input.id,
    displayName: input.displayName,
    institutionName: input.institutionName,
    ...(input.accountIds ? { accountIds: input.accountIds } : {}),
    ...(input.accountType ? { accountType: input.accountType } : {}),
    ...(input.accountRole ? { accountRole: input.accountRole } : {}),
    totalOutflowCents: 0,
    grossOutflowCents: 0,
    totalInflowCents: 0,
    transactionCount: 0,
    incomeTransactionCount: 0,
    refundCents: 0,
    refundTransactionCount: 0,
    excludedTransferOutflowCents: 0,
    excludedTransferInflowCents: 0,
    excludedCreditCardPaymentOutflowCents: 0,
    excludedCreditCardPaymentInflowCents: 0,
    unclassifiedOutflowCents: 0,
    unclassifiedInflowCents: 0,
  };
}

function addOutflowToAttributions(totals: MutableAttribution[], amount: number): void {
  for (const total of totals) {
    total.grossOutflowCents += amount;
    total.totalOutflowCents += amount;
  }
}

function addRefundToAttributions(totals: MutableAttribution[], amount: number): void {
  for (const total of totals) {
    total.refundCents += amount;
    total.refundTransactionCount += 1;
    total.totalOutflowCents -= amount;
  }
}

function addCategoryOutflow(
  totals: Map<string, MutableCategoryTotal>,
  category: string,
  amount: number,
): void {
  const metadata = getCategoryMetadata(category);
  const total = totals.get(category) ?? {
    category,
    displayName: metadata.displayName,
    requiredDefault: metadata.requiredDefault,
    outflowCents: 0,
    grossOutflowCents: 0,
    refundCents: 0,
    transactionCount: 0,
    refundTransactionCount: 0,
  };
  total.outflowCents += amount;
  total.grossOutflowCents += amount;
  total.transactionCount += 1;
  totals.set(category, total);
}

function addCategoryRefund(
  totals: Map<string, MutableCategoryTotal>,
  category: string,
  amount: number,
): void {
  const metadata = getCategoryMetadata(category);
  const total = totals.get(category) ?? {
    category,
    displayName: metadata.displayName,
    requiredDefault: metadata.requiredDefault,
    outflowCents: 0,
    grossOutflowCents: 0,
    refundCents: 0,
    transactionCount: 0,
    refundTransactionCount: 0,
  };
  total.outflowCents -= amount;
  total.refundCents += amount;
  total.refundTransactionCount += 1;
  totals.set(category, total);
}

function addMerchantOutflow(
  totals: Map<string, MutableMerchantTotal>,
  transaction: Transaction,
  amount: number,
): void {
  const normalizedMerchantId = transaction.normalizedMerchantId ?? merchantKeyFromText(transaction.merchantName);
  const total = totals.get(normalizedMerchantId) ?? {
    normalizedMerchantId,
    displayName: transaction.merchantName,
    merchantAmbiguity: false,
    ambiguousTransactionCount: 0,
    unknownTransactionCount: 0,
    outflowCents: 0,
    grossOutflowCents: 0,
    refundCents: 0,
    transactionCount: 0,
    refundTransactionCount: 0,
  };
  total.outflowCents += amount;
  total.grossOutflowCents += amount;
  total.transactionCount += 1;
  trackMerchantUncertainty(total, transaction, normalizedMerchantId);
  totals.set(normalizedMerchantId, total);
}

function addMerchantRefund(
  totals: Map<string, MutableMerchantTotal>,
  transaction: Transaction,
  amount: number,
): void {
  const normalizedMerchantId = transaction.normalizedMerchantId ?? merchantKeyFromText(transaction.merchantName);
  const total = totals.get(normalizedMerchantId) ?? {
    normalizedMerchantId,
    displayName: transaction.merchantName,
    merchantAmbiguity: false,
    ambiguousTransactionCount: 0,
    unknownTransactionCount: 0,
    outflowCents: 0,
    grossOutflowCents: 0,
    refundCents: 0,
    transactionCount: 0,
    refundTransactionCount: 0,
  };
  total.outflowCents -= amount;
  total.refundCents += amount;
  total.refundTransactionCount += 1;
  trackMerchantUncertainty(total, transaction, normalizedMerchantId);
  totals.set(normalizedMerchantId, total);
}

function buildComparison(
  recent: MonthlySpendingSummary,
  baseline: MonthlySpendingSummary[],
): MonthlySpendingComparison {
  const baselineOutflowTotal = baseline.reduce((sum, summary) => sum + summary.totalOutflowCents, 0);
  const baselineAverage = baseline.length > 0 ? Math.round(baselineOutflowTotal / baseline.length) : 0;
  const categoryKeys = new Set<string>();
  for (const total of recent.categoryTotals) categoryKeys.add(total.category);
  for (const summary of baseline) {
    for (const total of summary.categoryTotals) categoryKeys.add(total.category);
  }

  return {
    recentMonth: recent.month,
    baselineMonths: baseline.map((summary) => summary.month),
    baselineMonthCount: baseline.length,
    recentOutflowCents: recent.totalOutflowCents,
    baselineAverageOutflowCents: baselineAverage,
    outflowChangeCents: recent.totalOutflowCents - baselineAverage,
    outflowChangePercentBasisPoints: percentChangeBasisPoints(recent.totalOutflowCents, baselineAverage),
    direction: comparisonDirection(recent.totalOutflowCents, baselineAverage),
    categoryComparisons: [...categoryKeys]
      .map((category) => buildCategoryComparison(category, recent, baseline))
      .sort(
        (left, right) =>
          right.recentOutflowCents - left.recentOutflowCents ||
          Math.abs(right.outflowChangeCents) - Math.abs(left.outflowChangeCents) ||
          left.category.localeCompare(right.category),
      ),
  };
}

function buildCategoryComparison(
  category: string,
  recent: MonthlySpendingSummary,
  baseline: MonthlySpendingSummary[],
): MonthlySpendingComparison["categoryComparisons"][number] {
  const recentTotal = recent.categoryTotals.find((total) => total.category === category);
  const baselineTotal = baseline.reduce((sum, summary) => {
    const total = summary.categoryTotals.find((candidate) => candidate.category === category);
    return sum + (total?.outflowCents ?? 0);
  }, 0);
  const baselineAverage = baseline.length > 0 ? Math.round(baselineTotal / baseline.length) : 0;
  const recentOutflow = recentTotal?.outflowCents ?? 0;

  return {
    category,
    displayName: getCategoryMetadata(category).displayName,
    requiredDefault: getCategoryMetadata(category).requiredDefault,
    recentOutflowCents: recentOutflow,
    baselineAverageOutflowCents: baselineAverage,
    outflowChangeCents: recentOutflow - baselineAverage,
    outflowChangePercentBasisPoints: percentChangeBasisPoints(recentOutflow, baselineAverage),
    direction: comparisonDirection(recentOutflow, baselineAverage),
    recentTransactionCount: recentTotal?.transactionCount ?? 0,
  };
}

function emptyComparison(month: string): MonthlySpendingComparison {
  return {
    recentMonth: month,
    baselineMonths: [],
    baselineMonthCount: 0,
    recentOutflowCents: 0,
    baselineAverageOutflowCents: 0,
    outflowChangeCents: 0,
    direction: "flat",
    categoryComparisons: [],
  };
}

function comparisonDirection(recent: number, baseline: number): MonthlySpendingComparison["direction"] {
  if (baseline === 0 && recent > 0) return "new";
  if (recent > baseline) return "up";
  if (recent < baseline) return "down";
  return "flat";
}

function percentChangeBasisPoints(recent: number, baseline: number): number | undefined {
  if (baseline === 0) return undefined;
  return Math.round(((recent - baseline) / baseline) * 10_000);
}

function isTransferLike(transaction: Transaction): boolean {
  return (
    TRANSFER_LIKE_CATEGORIES.has(transaction.category) ||
    /\b(payment|transfer|xfer|autopay)\b/i.test(transaction.merchantName)
  );
}

function isCreditCardPayment(transaction: Transaction, accountLookup: Map<string, Account>): boolean {
  const account = accountLookup.get(transaction.accountId);
  const counterAccount = transaction.counterAccountId ? accountLookup.get(transaction.counterAccountId) : undefined;
  return (
    transaction.category === "credit_card_payment" ||
    transaction.normalizedMerchantId === "credit_card_payment" ||
    account?.type === "credit_card" ||
    counterAccount?.type === "credit_card"
  );
}

function trackMerchantUncertainty(
  total: MutableMerchantTotal,
  transaction: Transaction,
  normalizedMerchantId: string,
): void {
  const unknown =
    normalizedMerchantId === "unknown_merchant" ||
    transaction.normalizationUncertaintyCodes?.includes("unknown_merchant") === true;
  const ambiguous =
    !unknown &&
    (transaction.merchantAmbiguity === true ||
      transaction.normalizationUncertaintyCodes?.includes("ambiguous_processor") === true);

  if (ambiguous || unknown) {
    total.merchantAmbiguity = true;
  }
  if (ambiguous) {
    total.ambiguousTransactionCount += 1;
  }
  if (unknown) {
    total.unknownTransactionCount += 1;
  }
}
