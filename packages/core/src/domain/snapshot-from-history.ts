/**
 * Builds a `FinancialSnapshot` from imported accounts and transactions.
 *
 * "Can I afford this?" evaluated a hand-written fixture for as long as it
 * existed: the browser imported `affordable-steady-paycheck.json` and asked
 * about someone else's paycheck. The verdict looked authoritative and was
 * about nothing. This module replaces that input with the user's own history.
 *
 * Everything here is *derivation*, and derivation is where false precision
 * gets in. Three rules hold it back:
 *
 *  1. **Nothing is invented.** Income and obligations come from repeating
 *     transactions that actually happened. A merchant that charged once is not
 *     a bill.
 *  2. **Estimates say so.** Every derived entity carries `source: "inferred"`
 *     and an `uncertainty.confidence` below 1, so the engine's own freshness
 *     and coverage rules can weigh them.
 *  3. **Coverage is reported honestly, not optimistically.** A CSV import knows
 *     nothing about accounts the user didn't import, so
 *     `userConfirmedNoOtherRequiredObligations` is false and balances are
 *     declared complete only when every included account actually carries one.
 *     That will produce `UNKNOWN` with `COVERAGE_INCOMPLETE` for thin data —
 *     which is the correct answer, and a better one than a confident number
 *     derived from a third of someone's financial life.
 */
import { detectRecurringSpending } from "./pattern-detection";
import { addDays, compareDates, daysBetween, parseDateParts } from "./dates";
import { categoryRequiredByDefault } from "./normalization";
import type {
  Account,
  Cadence,
  DataCoverage,
  FinancialSnapshot,
  ForecastConfig,
  IncomeSource,
  RecurringObligation,
  Transaction,
} from "./types";

export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  horizonDays: 30,
  minimumCashBufferCents: 25_000,
  staleBalanceHours: 72,
  staleManualBalanceDays: 7,
  reliableIncomeConfidence: 0.8,
};

/** Below three observations, a repeating interval is a coincidence. */
const MINIMUM_OCCURRENCES = 3;

export type SnapshotFromHistoryOptions = {
  accounts: Account[];
  transactions: Transaction[];
  currency: string;
  timezone?: string;
  /** Defaults to the latest posted date, keeping the result deterministic. */
  asOfDate?: string;
  config?: Partial<ForecastConfig>;
};

export type SnapshotDerivation = {
  snapshot: FinancialSnapshot;
  /** What was derived and what was skipped, so the UI can be honest about it. */
  notes: {
    incomeSourceCount: number;
    recurringObligationCount: number;
    /** Merchants that repeat but not often enough to trust yet. */
    skippedForInsufficientHistory: string[];
    accountsMissingBalance: string[];
    transactionsFromDate?: string;
  };
};

export function buildSnapshotFromHistory(
  options: SnapshotFromHistoryOptions,
): SnapshotDerivation {
  const currency = options.currency.toUpperCase();
  const accounts = options.accounts.filter((account) => account.currency === currency);
  const transactions = options.transactions
    .filter((transaction) => transaction.currency === currency)
    .slice()
    .sort((left, right) => compareDates(left.postedDate, right.postedDate));

  const asOfDate = options.asOfDate ?? latestPostedDate(transactions) ?? today();
  const config = { ...DEFAULT_FORECAST_CONFIG, ...options.config };

  const income = deriveIncomeSources(transactions, asOfDate, currency);
  const obligations = deriveRecurringObligations(transactions, accounts, asOfDate, currency);

  const accountsMissingBalance = accounts
    .filter((account) => account.includeInForecast && !hasKnownBalance(account))
    .map((account) => account.displayName);

  const earliest = transactions[0]?.postedDate;

  return {
    snapshot: {
      asOfDate,
      timezone: options.timezone ?? "America/Chicago",
      currency,
      config,
      coverage: buildCoverage(accounts, earliest, asOfDate, config.horizonDays),
      accounts,
      transactions,
      incomeSources: income.sources,
      recurringObligations: obligations.obligations,
      // Goals and planned purchases are declarations, not observations. Nothing
      // in a bank statement says "I intend to save $400 a month", and inventing
      // one would put a goal the user never set into their forecast.
      goals: [],
      plannedPurchases: [],
    },
    notes: {
      incomeSourceCount: income.sources.length,
      recurringObligationCount: obligations.obligations.length,
      skippedForInsufficientHistory: [...income.skipped, ...obligations.skipped],
      accountsMissingBalance,
      transactionsFromDate: earliest,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Coverage is what the engine uses to decide whether it may answer at all.
 *
 * Every field here is deliberately pessimistic. An import covers the accounts
 * that were imported and says nothing about the rest of someone's finances, so
 * claiming completeness would convert "we don't know" into a number.
 */
function buildCoverage(
  accounts: Account[],
  earliestTransaction: string | undefined,
  asOfDate: string,
  horizonDays: number,
): DataCoverage {
  const forecastAccounts = accounts.filter((account) => account.includeInForecast);
  // A derived income source and a derived bill both carry a cadence, and a
  // cadence projects forward. So what we derived *is* known through the
  // horizon — the schedule is the coverage.
  const horizonEnd = addDays(asOfDate, horizonDays);

  return {
    balancesDeclaredComplete:
      forecastAccounts.length > 0 && forecastAccounts.every(hasKnownBalance),
    incomeDeclaredCompleteThroughDate: horizonEnd,
    obligationsDeclaredCompleteThroughDate: horizonEnd,
    transactionsCompleteFromDate: earliestTransaction,
    // What derivation cannot establish is whether there are bills it never saw
    // — a payment made from an account that wasn't imported, an annual charge
    // outside the window. Only the person can say that, so this stays false
    // and the engine blocks with COVERAGE_INCOMPLETE until they do. That is
    // the gate working, not a bug to route around: an affordability verdict
    // computed over an unknown share of someone's obligations is worse than
    // no verdict.
    userConfirmedNoOtherRequiredObligations: false,
  };
}

function hasKnownBalance(account: Account): boolean {
  return account.freshness.status !== "estimated" && account.freshness.status !== "missing";
}

// ---------------------------------------------------------------------------

/**
 * Income: repeating deposits, grouped by merchant.
 *
 * `minimumExpectedAmountCents` is the smallest deposit actually observed, not
 * the average. The engine treats it as the conservative floor for the required
 * path, and a paycheck that varies should be planned around its bad month.
 */
function deriveIncomeSources(
  transactions: Transaction[],
  asOfDate: string,
  currency: string,
): { sources: IncomeSource[]; skipped: string[] } {
  const groups = groupByMerchant(transactions.filter((t) => t.flowType === "INCOME"));
  const sources: IncomeSource[] = [];
  const skipped: string[] = [];

  for (const [merchantId, items] of groups) {
    if (items.length < MINIMUM_OCCURRENCES) {
      skipped.push(items[0]!.merchantName);
      continue;
    }
    const cadence = detectCadence(items.map((t) => t.postedDate));
    if (!cadence) {
      skipped.push(items[0]!.merchantName);
      continue;
    }

    const amounts = items.map((t) => Math.abs(t.amountCents));
    const last = items[items.length - 1]!;
    const variability = amountVariability(amounts);

    sources.push({
      id: `income_inferred_${merchantId}`,
      label: last.merchantName,
      expectedAmountCents: median(amounts),
      minimumExpectedAmountCents: Math.min(...amounts),
      cadence: cadence.cadence,
      nextExpectedDate: nextDateAfter(last.postedDate, cadence.intervalDays, asOfDate),
      variability,
      // "Expected", never "confirmed": these deposits happened, but nothing here
      // knows whether the job still exists.
      reliability: variability === "fixed" ? "expected" : "uncertain",
      category: "other",
      active: true,
      freshness: {
        status: "usable",
        asOf: last.postedDate,
        source: "inferred",
        warnings: [],
      },
      uncertainty: {
        confidence: cadence.confidence,
        confidenceReason: `Derived from ${items.length} deposits from ${last.merchantName}.`,
        isEstimated: true,
        estimateMethod: "merchant_recurrence",
      },
      source: "inferred",
      currency,
    });
  }

  return { sources: sources.sort(byId), skipped };
}

/**
 * Obligations, from two sources that answer different questions.
 *
 * `detectRecurringSpending` exists to find things you could cancel, so it
 * **deliberately excludes required bills** — rent is not a subscription. That
 * is right for the Insights screen and exactly wrong here: rent is the single
 * most important item in an affordability forecast. Using that detector alone
 * produced a snapshot listing Netflix and Spotify and omitting a $1,450 rent
 * payment, which would have made every verdict optimistic.
 *
 * So required bills are detected directly from their own repetition, and
 * optional recurring charges come from the existing detector. `importance`
 * follows the shared category taxonomy rather than a judgement made here — the
 * engine treats required and optional differently on the solvency path.
 */
function deriveRecurringObligations(
  transactions: Transaction[],
  accounts: Account[],
  asOfDate: string,
  currency: string,
): { obligations: RecurringObligation[]; skipped: string[] } {
  const required = deriveRequiredBills(transactions, asOfDate, currency);
  const detection = detectRecurringSpending({ transactions, accounts, currency, analysisDate: asOfDate });
  const obligations: RecurringObligation[] = [...required.obligations];
  const skipped: string[] = [...required.skipped];

  for (const insight of detection.insights) {
    if (insight.evidence.kind !== "likely_subscription") continue;
    const evidence = insight.evidence;

    if (evidence.occurrenceCount < MINIMUM_OCCURRENCES && !evidence.twoChargeException) {
      skipped.push(evidence.merchant.displayName);
      continue;
    }

    const required = categoryRequiredByDefault(evidence.category.id);
    obligations.push({
      id: `obligation_inferred_${evidence.merchant.normalizedMerchantId}`,
      label: evidence.merchant.displayName,
      amountCents: evidence.amountCents.median,
      cadence: cadenceFromDetected(evidence.cadence, evidence.expectedNextChargeDate),
      nextDueDate: evidence.expectedNextChargeDate,
      category: evidence.category.id,
      required,
      importance: required ? "required" : "optional",
      autopay: false,
      accountId: evidence.accountIds[0],
      active: true,
      sourceTransactionIds: evidence.transactionIds,
      freshness: {
        status: "usable",
        asOf: evidence.lastChargeDate,
        source: "inferred",
        warnings: [],
      },
      uncertainty: {
        confidence: insight.confidenceScore / 100,
        confidenceReason: `Detected from ${evidence.occurrenceCount} charges at ${evidence.merchant.displayName}.`,
        isEstimated: true,
        estimateMethod: "merchant_recurrence",
      },
      source: "inferred",
      currency,
    });
  }

  return { obligations: obligations.sort(byId), skipped };
}

/**
 * Rent, utilities, insurance, loan payments — the charges that must be paid.
 *
 * Detected here rather than borrowed from the subscription detector, which
 * filters exactly these out. Same evidence standard as income: three
 * occurrences at a recognisable interval, and a spread narrow enough that the
 * interval is real.
 */
function deriveRequiredBills(
  transactions: Transaction[],
  asOfDate: string,
  currency: string,
): { obligations: RecurringObligation[]; skipped: string[] } {
  const candidates = transactions.filter(
    (transaction) =>
      transaction.flowType === "SPEND" && categoryRequiredByDefault(transaction.category),
  );
  const obligations: RecurringObligation[] = [];
  const skipped: string[] = [];

  for (const [merchantId, items] of groupByMerchant(candidates)) {
    if (items.length < MINIMUM_OCCURRENCES) {
      skipped.push(items[0]!.merchantName);
      continue;
    }
    const cadence = detectCadence(items.map((t) => t.postedDate));
    if (!cadence) {
      skipped.push(items[0]!.merchantName);
      continue;
    }

    const amounts = items.map((t) => Math.abs(t.amountCents));
    const last = items[items.length - 1]!;

    obligations.push({
      id: `obligation_required_${merchantId}`,
      label: last.merchantName,
      // The median, not the maximum: a required bill that varies slightly
      // should not be padded upward into a pessimistic forecast.
      amountCents: median(amounts),
      cadence: cadence.cadence,
      nextDueDate: nextDateAfter(last.postedDate, cadence.intervalDays, asOfDate),
      category: last.category,
      required: true,
      importance: "required",
      autopay: false,
      accountId: last.accountId,
      active: true,
      sourceTransactionIds: items.map((t) => t.id),
      freshness: { status: "usable", asOf: last.postedDate, source: "inferred", warnings: [] },
      uncertainty: {
        confidence: cadence.confidence,
        confidenceReason: `Derived from ${items.length} payments to ${last.merchantName}.`,
        isEstimated: true,
        estimateMethod: "merchant_recurrence",
      },
      source: "inferred",
      currency,
    });
  }

  return { obligations, skipped };
}

// ---------------------------------------------------------------------------
// Cadence detection

type DetectedCadence = { cadence: Cadence; intervalDays: number; confidence: number };

/** Tolerances are in days, matched against the median gap between charges. */
const CADENCE_WINDOWS: { kind: Cadence["kind"]; days: number; tolerance: number }[] = [
  { kind: "weekly", days: 7, tolerance: 2 },
  { kind: "biweekly", days: 14, tolerance: 3 },
  { kind: "semimonthly", days: 15, tolerance: 2 },
  { kind: "monthly", days: 30, tolerance: 5 },
  { kind: "quarterly", days: 91, tolerance: 10 },
  { kind: "annual", days: 365, tolerance: 20 },
];

function detectCadence(dates: string[]): DetectedCadence | undefined {
  if (dates.length < MINIMUM_OCCURRENCES) return undefined;
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    intervals.push(daysBetween(dates[i - 1]!, dates[i]!));
  }
  const medianInterval = median(intervals);
  const window = CADENCE_WINDOWS.find(
    (candidate) => Math.abs(medianInterval - candidate.days) <= candidate.tolerance,
  );
  if (!window) return undefined;

  // The median alone is not enough, and this is where false precision would get
  // in: gaps of 17 and 43 days have a median of 30, which looks monthly and
  // isn't. Spread is the check that catches it — and a spread this wide is
  // rejected outright rather than admitted at low confidence, because a
  // paycheck that isn't coming is worse in a forecast than no paycheck at all.
  const spread = Math.max(...intervals) - Math.min(...intervals);
  if (spread > window.tolerance * 2) return undefined;
  const confidence = spread <= window.tolerance ? 0.9 : 0.75;

  const anchor = dates[dates.length - 1]!;
  return { cadence: buildCadence(window.kind, anchor, dates), intervalDays: window.days, confidence };
}

function buildCadence(kind: Cadence["kind"], anchorDate: string, dates: string[]): Cadence {
  const { month, day } = parseDateParts(anchorDate);
  switch (kind) {
    case "weekly":
      return { kind: "weekly", intervalWeeks: 1, anchorDate };
    case "biweekly":
      return { kind: "biweekly", anchorDate };
    case "semimonthly": {
      const days = [...new Set(dates.map((d) => parseDateParts(d).day))].sort((a, b) => a - b);
      const pair: [number, number] = [days[0] ?? 1, days[1] ?? Math.min((days[0] ?? 1) + 15, 28)];
      return { kind: "semimonthly", daysOfMonth: pair };
    }
    case "quarterly":
      return { kind: "quarterly", dayOfMonth: day, anchorMonth: month };
    case "annual":
      return { kind: "annual", month, dayOfMonth: day };
    case "monthly":
    default:
      return { kind: "monthly", dayOfMonth: day };
  }
}

function cadenceFromDetected(kind: string, anchorDate: string): Cadence {
  return buildCadence(
    (["weekly", "biweekly", "monthly", "quarterly", "annual"].includes(kind)
      ? kind
      : "monthly") as Cadence["kind"],
    anchorDate,
    [anchorDate],
  );
}

/** The next occurrence strictly after `asOfDate`, walking forward from the last
 *  observed one so the forecast never opens on an event already in the past. */
function nextDateAfter(lastDate: string, intervalDays: number, asOfDate: string): string {
  let next = addDays(lastDate, intervalDays);
  let guard = 0;
  while (compareDates(next, asOfDate) <= 0 && guard < 400) {
    next = addDays(next, intervalDays);
    guard += 1;
  }
  return next;
}

// ---------------------------------------------------------------------------

function groupByMerchant(transactions: Transaction[]): Map<string, Transaction[]> {
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const key =
      transaction.normalizedMerchantId ?? transaction.merchantName.toLowerCase().replace(/\s+/g, "_");
    const list = groups.get(key) ?? [];
    list.push(transaction);
    groups.set(key, list);
  }
  return groups;
}

function amountVariability(amounts: number[]): IncomeSource["variability"] {
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  if (low === high) return "fixed";
  return (high - low) / high <= 0.1 ? "variable" : "irregular";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function latestPostedDate(transactions: Transaction[]): string | undefined {
  return transactions[transactions.length - 1]?.postedDate;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
