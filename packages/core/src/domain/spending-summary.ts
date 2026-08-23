/**
 * Period-aware spending aggregation.
 *
 * Generalises `summarizeMonthlySpending` from calendar months to any period
 * kind, and adds the fields the UI needs so the browser performs no financial
 * arithmetic at all (`CD-003`, `H-022`).
 *
 * Two additions specifically remove calculations that were living in the
 * browser: `netCents` (the "Left over" figure) and `shareBasisPoints` (category
 * bar width). Both were the UI dividing or subtracting backend figures.
 *
 * Money classification rules are unchanged and still come from
 * `docs/money-flow-taxonomy.md`: spending is `SPEND + FEE − REFUND`, internal
 * transfers never appear in a spending total, and movement that cannot be
 * resolved is surfaced as uncertainty rather than counted either way.
 */
import type { Account, FlowType, Transaction } from "./types";
import { daysBetween } from "./dates";
import {
  baselineLabel,
  containsDate,
  periodForDate,
  periodFromKey,
  recentPeriods,
  statementPeriodForDate,
  type Period,
  type PeriodKind,
} from "./periods";

/** A transfer is trusted as internal only above this confidence (`H-016`). */
const TRUSTED_TRANSFER_CONFIDENCE = 0.8;

export type SpendingComparison = {
  direction: "up" | "down" | "flat" | "new";
  outflowChangeCents: number;
  baselineAverageOutflowCents: number;
  baselinePeriodCount: number;
  /** Rendered verbatim, e.g. "the last 2 months". */
  baselineLabel: string;
  /** False when the period is partial or there is no baseline. */
  comparable: boolean;
};

export type CategoryTotal = {
  category: string;
  displayName: string;
  outflowCents: number;
  grossOutflowCents: number;
  refundCents: number;
  transactionCount: number;
  /** Share of period outflow. Supplied so the UI never divides. */
  shareBasisPoints: number;
  comparison?: {
    direction: "up" | "down" | "flat" | "new";
    outflowChangeCents: number;
    changeBasisPoints?: number;
  };
};

export type AccountTotal = {
  id: string;
  displayName: string;
  institutionName: string;
  accountType: Account["type"];
  totalOutflowCents: number;
  totalInflowCents: number;
  excludedTransferOutflowCents: number;
  unclassifiedOutflowCents: number;
};

export type InstitutionTotal = {
  id: string;
  displayName: string;
  accountIds: string[];
  totalOutflowCents: number;
  totalInflowCents: number;
};

export type SpendingSummary = {
  period: Period;
  currency: string;
  totalOutflowCents: number;
  grossOutflowCents: number;
  totalInflowCents: number;
  /** Inflow minus outflow. Backend-owned so the UI stops subtracting. */
  netCents: number;
  refundCents: number;
  excludedTransferOutflowCents: number;
  excludedCreditCardPaymentOutflowCents: number;
  unclassifiedOutflowCents: number;
  unclassifiedCount: number;
  comparison: SpendingComparison;
  categoryTotals: CategoryTotal[];
  accountTotals: AccountTotal[];
  institutionTotals: InstitutionTotal[];
};

export type SummarizeOptions = {
  transactions: Transaction[];
  accounts: Account[];
  currency: string;
  asOfDate: string;
  kind: PeriodKind;
  /** Period key. Defaults to the period containing `asOfDate`. */
  key?: string;
  /** Required for `statement`; filters every other kind. */
  accountId?: string;
  /** Periods averaged for the comparison baseline. */
  baselineCount?: number;
  /** Resolves a category id to its display label. */
  categoryLabel?: (categoryId: string) => string;
  /** Aggregate over this explicit contiguous span instead of a named period.
   *  When set, `key` is ignored and period comparison is disabled (a custom span
   *  has no natural baseline). `kind` still labels the grain. */
  span?: { startDate: string; endDate: string; label?: string };
};

const CARD_PAYMENT_CATEGORIES = new Set(["credit_card_payment", "card_payment"]);

/**
 * Whether a transfer is trusted as internal.
 *
 * Untrusted transfers are not silently dropped — they become unclassified, so
 * money that may genuinely have left is never quietly excluded from spending.
 */
function isTrustedTransfer(t: Transaction, accountIds: Set<string>): boolean {
  if (!t.counterAccountId) return false;
  if (!accountIds.has(t.counterAccountId)) return false;
  return (t.transferMatchConfidence ?? 0) >= TRUSTED_TRANSFER_CONFIDENCE;
}

function effectiveFlow(t: Transaction, accountIds: Set<string>): FlowType {
  if (t.flowType === "TRANSFER_OUT" || t.flowType === "TRANSFER_IN") {
    return isTrustedTransfer(t, accountIds) ? t.flowType : "UNCLASSIFIED";
  }
  return t.flowType;
}

function outflowTotal(transactions: Transaction[], accountIds: Set<string>): number {
  let gross = 0;
  let refunds = 0;
  for (const t of transactions) {
    const flow = effectiveFlow(t, accountIds);
    if (flow === "SPEND" || flow === "FEE") gross += Math.abs(t.amountCents);
    else if (flow === "REFUND") refunds += Math.abs(t.amountCents);
  }
  return gross - refunds;
}

export function summarizeSpending(options: SummarizeOptions): SpendingSummary {
  const {
    transactions,
    accounts,
    currency,
    asOfDate,
    kind,
    accountId,
    baselineCount = 3,
    categoryLabel = (id) => id,
  } = options;

  const accountIds = new Set(accounts.map((a) => a.id));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const period = resolvePeriod(options, accountById);
  const inCurrency = transactions.filter((t) => t.currency === currency);
  const scoped = accountId ? inCurrency.filter((t) => t.accountId === accountId) : inCurrency;
  const inPeriod = scoped.filter((t) => containsDate(period, t.postedDate));

  let gross = 0;
  let refunds = 0;
  let inflow = 0;
  let transfersOut = 0;
  let cardPaymentsOut = 0;
  let unclassifiedOut = 0;
  let unclassifiedCount = 0;

  const categories = new Map<string, CategoryTotal>();
  const accountTotals = new Map<string, AccountTotal>();

  for (const t of inPeriod) {
    const flow = effectiveFlow(t, accountIds);
    const abs = Math.abs(t.amountCents);
    const account = accountById.get(t.accountId);

    const at =
      accountTotals.get(t.accountId) ??
      ({
        id: t.accountId,
        displayName: account?.displayName ?? t.accountId,
        institutionName: account?.institutionName ?? "Unknown",
        accountType: account?.type ?? "other",
        totalOutflowCents: 0,
        totalInflowCents: 0,
        excludedTransferOutflowCents: 0,
        unclassifiedOutflowCents: 0,
      } satisfies AccountTotal);
    accountTotals.set(t.accountId, at);

    if (flow === "SPEND" || flow === "FEE") {
      gross += abs;
      at.totalOutflowCents += abs;
      const c =
        categories.get(t.category) ??
        ({
          category: t.category,
          displayName: categoryLabel(t.category),
          outflowCents: 0,
          grossOutflowCents: 0,
          refundCents: 0,
          transactionCount: 0,
          shareBasisPoints: 0,
        } satisfies CategoryTotal);
      c.grossOutflowCents += abs;
      c.outflowCents += abs;
      c.transactionCount += 1;
      categories.set(t.category, c);
    } else if (flow === "REFUND") {
      refunds += abs;
      at.totalOutflowCents -= abs;
      const c =
        categories.get(t.category) ??
        ({
          category: t.category,
          displayName: categoryLabel(t.category),
          outflowCents: 0,
          grossOutflowCents: 0,
          refundCents: 0,
          transactionCount: 0,
          shareBasisPoints: 0,
        } satisfies CategoryTotal);
      c.refundCents += abs;
      c.outflowCents -= abs;
      categories.set(t.category, c);
    } else if (flow === "INCOME") {
      inflow += abs;
      at.totalInflowCents += abs;
    } else if (flow === "TRANSFER_OUT") {
      transfersOut += abs;
      at.excludedTransferOutflowCents += abs;
      if (CARD_PAYMENT_CATEGORIES.has(t.category) || isCardPayment(t, accountById)) {
        cardPaymentsOut += abs;
      }
    } else if (flow === "UNCLASSIFIED" && t.amountCents < 0) {
      unclassifiedOut += abs;
      unclassifiedCount += 1;
      at.unclassifiedOutflowCents += abs;
    }
  }

  const totalOutflow = gross - refunds;

  // Share is computed here precisely so the UI does not have to divide.
  const categoryTotals = [...categories.values()]
    .map((c) => ({
      ...c,
      shareBasisPoints:
        totalOutflow > 0 ? Math.round((c.outflowCents / totalOutflow) * 10000) : 0,
    }))
    .sort((a, b) => b.outflowCents - a.outflowCents);

  // A custom span has no natural baseline — comparison is meaningless and must
  // not try to derive regular-grid periods from an arbitrary date range.
  const isSpan = Boolean(options.span);

  const comparison: SpendingComparison = isSpan
    ? {
        direction: "new",
        outflowChangeCents: 0,
        baselineAverageOutflowCents: 0,
        baselinePeriodCount: 0,
        baselineLabel: "",
        comparable: false,
      }
    : buildComparison({
        kind,
        period,
        transactions: scoped,
        accountIds,
        asOfDate,
        baselineCount,
        recentOutflow: totalOutflow,
        accountById,
        accountId,
      });

  if (!isSpan) {
    attachCategoryComparisons(categoryTotals, {
      kind,
      period,
      transactions: scoped,
      accountIds,
      asOfDate,
      baselineCount,
      accountById,
      accountId,
    });
  }

  const institutions = new Map<string, InstitutionTotal>();
  for (const at of accountTotals.values()) {
    const id = at.institutionName.toLowerCase().replace(/\s+/g, "_");
    const it =
      institutions.get(id) ??
      ({
        id,
        displayName: at.institutionName,
        accountIds: [],
        totalOutflowCents: 0,
        totalInflowCents: 0,
      } satisfies InstitutionTotal);
    it.accountIds.push(at.id);
    it.totalOutflowCents += at.totalOutflowCents;
    it.totalInflowCents += at.totalInflowCents;
    institutions.set(id, it);
  }

  return {
    period,
    currency,
    totalOutflowCents: totalOutflow,
    grossOutflowCents: gross,
    totalInflowCents: inflow,
    netCents: inflow - totalOutflow,
    refundCents: refunds,
    excludedTransferOutflowCents: transfersOut,
    excludedCreditCardPaymentOutflowCents: cardPaymentsOut,
    unclassifiedOutflowCents: unclassifiedOut,
    unclassifiedCount,
    comparison,
    categoryTotals,
    accountTotals: [...accountTotals.values()].sort(
      (a, b) => b.totalOutflowCents - a.totalOutflowCents,
    ),
    institutionTotals: [...institutions.values()].sort(
      (a, b) => b.totalOutflowCents - a.totalOutflowCents,
    ),
  };
}

function isCardPayment(t: Transaction, accountById: Map<string, Account>): boolean {
  if (!t.counterAccountId) return false;
  return accountById.get(t.counterAccountId)?.type === "credit_card";
}

function resolvePeriod(
  options: SummarizeOptions,
  accountById: Map<string, Account>,
): Period {
  const { kind, key, asOfDate, accountId } = options;

  if (options.span) {
    const { span } = options;
    const totalDays = daysBetween(span.startDate, span.endDate) + 1;
    return {
      kind,
      key: `span:${span.startDate}:${span.endDate}`,
      label: span.label ?? `${span.startDate} – ${span.endDate}`,
      partial: false,
      startDate: span.startDate,
      endDate: span.endDate,
      elapsedDays: totalDays,
      totalDays,
    };
  }

  if (kind === "statement") {
    const account = accountId ? accountById.get(accountId) : undefined;
    const closingDay = account?.statementCycle?.closingDay;
    if (!account || !closingDay) {
      // No cycle known: fall back to the calendar month rather than inventing
      // a closing day. An inferred cycle presented as fact would be worse than
      // an honest month.
      return periodForDate("month", key ? `${key}-01` : asOfDate, asOfDate);
    }
    const anchor = key?.includes(":") ? key.split(":")[1]! : asOfDate;
    return statementPeriodForDate(anchor, closingDay, asOfDate, account.id, account.displayName);
  }

  if (key) {
    const fromKey = periodFromKey(kind, key, asOfDate);
    if (fromKey) return fromKey;
  }
  return periodForDate(kind, asOfDate, asOfDate);
}

type ComparisonContext = {
  kind: PeriodKind;
  period: Period;
  transactions: Transaction[];
  accountIds: Set<string>;
  asOfDate: string;
  baselineCount: number;
  accountById: Map<string, Account>;
  accountId?: string;
};

function baselinePeriods(ctx: ComparisonContext): Period[] {
  if (ctx.kind === "statement") return [];
  const window = recentPeriods(
    ctx.kind as Exclude<PeriodKind, "statement">,
    ctx.period.startDate,
    ctx.baselineCount + 1,
  );
  // recentPeriods includes the period containing startDate, which is this one.
  return window.filter((p) => p.key !== ctx.period.key);
}

function buildComparison(
  ctx: ComparisonContext & { recentOutflow: number },
): SpendingComparison {
  const baselines = baselinePeriods(ctx).filter((p) =>
    ctx.transactions.some((t) => containsDate(p, t.postedDate)),
  );

  if (baselines.length === 0) {
    return {
      direction: "new",
      outflowChangeCents: 0,
      baselineAverageOutflowCents: 0,
      baselinePeriodCount: 0,
      baselineLabel: baselineLabel(ctx.kind, 0),
      comparable: false,
    };
  }

  const totals = baselines.map((p) =>
    outflowTotal(
      ctx.transactions.filter((t) => containsDate(p, t.postedDate)),
      ctx.accountIds,
    ),
  );
  const average = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
  const change = ctx.recentOutflow - average;

  // A partial period is not comparable against complete ones. Reporting a fall
  // three days into a month would be a false comfort.
  const comparable = !ctx.period.partial;

  return {
    direction: !comparable ? "flat" : change > 0 ? "up" : change < 0 ? "down" : "flat",
    outflowChangeCents: comparable ? change : 0,
    baselineAverageOutflowCents: average,
    baselinePeriodCount: baselines.length,
    baselineLabel: baselineLabel(ctx.kind, baselines.length),
    comparable,
  };
}

function attachCategoryComparisons(categories: CategoryTotal[], ctx: ComparisonContext): void {
  const baselines = baselinePeriods(ctx).filter((p) =>
    ctx.transactions.some((t) => containsDate(p, t.postedDate)),
  );
  if (baselines.length === 0 || ctx.period.partial) return;

  for (const category of categories) {
    const totals = baselines.map((p) =>
      outflowTotal(
        ctx.transactions.filter(
          (t) => containsDate(p, t.postedDate) && t.category === category.category,
        ),
        ctx.accountIds,
      ),
    );
    const average = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
    const change = category.outflowCents - average;

    category.comparison = {
      direction:
        average === 0 && category.outflowCents > 0
          ? "new"
          : change > 0
            ? "up"
            : change < 0
              ? "down"
              : "flat",
      outflowChangeCents: change,
      changeBasisPoints: average > 0 ? Math.round((change / average) * 10000) : undefined,
    };
  }
}

/** N most recent periods of totals, for the trend view (`H-020`). */
export function spendingSeries(options: {
  transactions: Transaction[];
  accounts: Account[];
  currency: string;
  asOfDate: string;
  kind: Exclude<PeriodKind, "statement">;
  count: number;
  categoryLabel?: (id: string) => string;
}): {
  period: { kind: PeriodKind; count: number };
  points: {
    key: string;
    label: string;
    totalOutflowCents: number;
    totalInflowCents: number;
    partial: boolean;
  }[];
  categorySeries: {
    category: string;
    displayName: string;
    points: { key: string; outflowCents: number }[];
  }[];
} {
  const periods = recentPeriods(options.kind, options.asOfDate, options.count);
  const summaries = periods.map((p) =>
    summarizeSpending({
      transactions: options.transactions,
      accounts: options.accounts,
      currency: options.currency,
      asOfDate: options.asOfDate,
      kind: options.kind,
      key: p.key,
      categoryLabel: options.categoryLabel,
    }),
  );

  const categoryIds = new Set<string>();
  for (const s of summaries) for (const c of s.categoryTotals) categoryIds.add(c.category);

  return {
    period: { kind: options.kind, count: options.count },
    points: summaries.map((s) => ({
      key: s.period.key,
      label: s.period.label,
      totalOutflowCents: s.totalOutflowCents,
      totalInflowCents: s.totalInflowCents,
      partial: s.period.partial,
    })),
    categorySeries: [...categoryIds].map((id) => ({
      category: id,
      displayName: (options.categoryLabel ?? ((x: string) => x))(id),
      points: summaries.map((s) => ({
        key: s.period.key,
        outflowCents: s.categoryTotals.find((c) => c.category === id)?.outflowCents ?? 0,
      })),
    })),
  };
}
