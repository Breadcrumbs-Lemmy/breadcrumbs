/**
 * Net-worth trend — a month-by-month line of "cash net worth" (what you have,
 * minus what you owe on cards and loans).
 *
 * The app stores only *current* balances, never history, so a trend has to be
 * reconstructed. Two sources are combined (see `docs/net-worth.md`):
 *   - **Reconstructed** points, back-cast from today's balance by unwinding the
 *     transaction record: `balance(monthEnd) = currentBalance − Σ (effect of
 *     every transaction dated after monthEnd)`.
 *   - **Recorded** points, from `NetWorthSnapshot`s the server saved at real
 *     observation times — these supersede the back-cast for any month they cover,
 *     so the line becomes measured rather than derived as snapshots accrue.
 *
 * Every figure here is a fact about the user's own balances — no projection, no
 * advice (`D-002`). All arithmetic lives in this module; the browser only
 * formats (`CD-011`).
 *
 * ### The one formula that makes this work
 * A transaction's effect on net worth is `cashDirection(flowType) × |amount|`,
 * the *same* for an asset account and a liability account:
 *   - On checking, a `SPEND` lowers your balance by the amount → net worth down.
 *   - On a card, a `SPEND` raises what you owe by the amount → net worth down.
 * Because the sign depends only on the flow (money toward you vs away), an
 * internal transfer (`TRANSFER_OUT` on A + `TRANSFER_IN` on B) and a card payment
 * (`TRANSFER_OUT` from cash + `TRANSFER_IN` reducing the card) both net to zero —
 * which is exactly right, and falls out for free.
 */
import type { Account, FlowType, Transaction } from "./types";
import { addMonths, clampDay, extractIsoDate, formatDate, monthKey, parseDateParts } from "./dates";

/** How far back the trend reaches by default, so an old import doesn't produce
 *  an unbounded line. Overridable per call. */
export const DEFAULT_NET_WORTH_MONTHS = 24;

/** Whether a point was measured from a saved observation or inferred from the
 *  transaction record. The UI treats them differently — see `D-N6`. */
export type NetWorthBasis = "recorded" | "reconstructed";

export type NetWorthPoint = {
  /** `YYYY-MM`. */
  month: string;
  /** The last calendar day of `month` (`YYYY-MM-DD`), for the axis. */
  monthEndDate: string;
  netWorthCents: number;
  /** Positive: cash assets at that month-end. */
  cashCents: number;
  /** Positive: amount owed on cards/loans at that month-end. */
  debtCents: number;
  basis: NetWorthBasis;
};

/** A measured observation of net worth the server persists over time (`D-N4`). */
export type NetWorthSnapshot = {
  /** `YYYY-MM-DD` — when this net worth was true (latest balance freshness). */
  observedDate: string;
  currency: string;
  netWorthCents: number;
  cashCents: number;
  debtCents: number;
};

export type NetWorthTrendOptions = {
  accounts: Account[];
  transactions: Transaction[];
  /** Recorded observations, newest-wins per month. */
  snapshots: NetWorthSnapshot[];
  currency: string;
  /** Data-derived "now" — the latest transaction date, never the wall clock. */
  asOfDate: string;
  maxMonths?: number;
};

export type NetWorthTrend = {
  currency: string;
  points: NetWorthPoint[];
  /** Today's measured cash net worth (matches the Accounts headline for this set). */
  currentNetWorthCents: number;
  /** Current minus the first covered point — the movement over the window. */
  changeCents: number;
  /** `YYYY-MM` where the honest line begins, or null when there's nothing to show. */
  coverageStartMonth: string | null;
  monthsCovered: number;
  hasData: boolean;
};

/**
 * The single sign rule (see the file header). Inflows raise net worth, outflows
 * lower it, and an unclassifiable flow moves nothing rather than guess a
 * direction — an honest zero beats an invented delta (`D-N6`).
 */
function cashDirection(flowType: FlowType): number {
  switch (flowType) {
    case "INCOME":
    case "REFUND":
    case "TRANSFER_IN":
      return 1;
    case "SPEND":
    case "FEE":
    case "TRANSFER_OUT":
      return -1;
    case "UNCLASSIFIED":
    default:
      return 0;
  }
}

/**
 * An account's signed contribution to net worth, mirroring accounts-view
 * `netContribution` so the current point equals the Accounts headline: the sign
 * comes from the role, not the stored figure (providers disagree on whether a
 * card balance is +owed or −debt), and `excluded` accounts are already filtered
 * out before this is called.
 */
function contributionOf(account: Account): number {
  const magnitude = Math.abs(account.currentBalanceCents);
  return account.role === "liability" ? -magnitude : magnitude;
}

/**
 * "Cash net worth" set: everything except investments (whose value moves with
 * the market, not with transactions, so back-casting would draw a false line —
 * `D-N2`) and except `excluded` accounts. Scoped to the request currency
 * (single-currency, `D-N9`).
 */
function includedAccounts(accounts: Account[], currency: string): Account[] {
  return accounts.filter(
    (a) => a.currency === currency && a.type !== "investment" && a.role !== "excluded",
  );
}

/** Last calendar day of a `YYYY-MM` month, as `YYYY-MM-DD`. */
function monthEndDate(month: string): string {
  const { year, month: m } = parseDateParts(`${month}-01`);
  return formatDate(year, m, clampDay(year, m, 31));
}

/** Shift a `YYYY-MM` month by whole months, returning `YYYY-MM`. */
function shiftMonth(month: string, months: number): string {
  return monthKey(addMonths(`${month}-01`, months));
}

/** Inclusive list of `YYYY-MM` from `startMonth` to `endMonth`. */
function monthsBetween(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  for (let m = startMonth; m <= endMonth; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

/**
 * Compute the current measured net worth as a snapshot the server can persist
 * (`D-N4`). Returns null when there is nothing to trend (no cash/debt accounts
 * in this currency). `observedDate` is the latest balance-freshness date across
 * the included accounts — a real timestamp already in the data — falling back to
 * `asOfDate`, so no wall clock ever enters core.
 */
export function currentNetWorthObservation(options: {
  accounts: Account[];
  currency: string;
  asOfDate: string;
}): NetWorthSnapshot | null {
  const included = includedAccounts(options.accounts, options.currency);
  if (included.length === 0) return null;

  let cash = 0;
  let debt = 0;
  let latestAsOf = "";
  for (const account of included) {
    const contribution = contributionOf(account);
    if (account.role === "liability") debt += -contribution;
    else cash += contribution;

    const asOf = account.freshness.asOf ? extractIsoDate(account.freshness.asOf) : undefined;
    if (asOf && asOf > latestAsOf) latestAsOf = asOf;
  }

  return {
    observedDate: latestAsOf || options.asOfDate,
    currency: options.currency,
    netWorthCents: cash - debt,
    cashCents: cash,
    debtCents: debt,
  };
}

/**
 * Build the month-by-month trend: back-cast history, overlaid with recorded
 * snapshots, from an honest coverage start through the current month.
 */
export function buildNetWorthTrend(options: NetWorthTrendOptions): NetWorthTrend {
  const { accounts, transactions, snapshots, currency, asOfDate } = options;
  const maxMonths = options.maxMonths ?? DEFAULT_NET_WORTH_MONTHS;
  const included = includedAccounts(accounts, currency);

  if (included.length === 0) {
    return {
      currency,
      points: [],
      currentNetWorthCents: 0,
      changeCents: 0,
      coverageStartMonth: null,
      monthsCovered: 0,
      hasData: false,
    };
  }

  // Current measured cash/debt, per included account, so the last point equals
  // today's balances exactly.
  const includedIds = new Set(included.map((a) => a.id));
  const liabilityIds = new Set(included.filter((a) => a.role === "liability").map((a) => a.id));
  let currentCash = 0;
  let currentDebt = 0;
  for (const account of included) {
    const contribution = contributionOf(account);
    if (account.role === "liability") currentDebt += -contribution;
    else currentCash += contribution;
  }
  const currentNetWorthCents = currentCash - currentDebt;

  // Every included-account transaction, reduced to (date, net-worth delta, side).
  const scoped = transactions
    .filter((t) => t.currency === currency && includedIds.has(t.accountId))
    .map((t) => ({
      date: t.postedDate,
      delta: cashDirection(t.flowType) * Math.abs(t.amountCents),
      isLiability: liabilityIds.has(t.accountId),
    }));

  // Coverage start (D-N5): the *latest* first-transaction month across accounts
  // that have any history — the first month by which every such account has
  // begun contributing, so no account's line is its pre-import opening balance.
  // Accounts with no transactions stay flat at their current balance and don't
  // constrain this. Every first-month is ≤ asOfMonth (asOfDate is the latest
  // transaction), so we take the max of the first-months, or asOfMonth if there
  // are no transactions at all (just the current measured point).
  const firstTxnMonthByAccount = new Map<string, string>();
  for (const t of transactions) {
    if (t.currency !== currency || !includedIds.has(t.accountId)) continue;
    const month = monthKey(t.postedDate);
    const prev = firstTxnMonthByAccount.get(t.accountId);
    if (!prev || month < prev) firstTxnMonthByAccount.set(t.accountId, month);
  }
  const asOfMonth = monthKey(asOfDate);
  let coverageStart: string | null = null;
  for (const month of firstTxnMonthByAccount.values()) {
    if (coverageStart === null || month > coverageStart) coverageStart = month;
  }
  if (coverageStart === null) coverageStart = asOfMonth;

  // Never reach further back than the window cap, nor past the current month.
  const earliestAllowed = shiftMonth(asOfMonth, -(maxMonths - 1));
  if (coverageStart < earliestAllowed) coverageStart = earliestAllowed;
  if (coverageStart > asOfMonth) coverageStart = asOfMonth;

  // Latest snapshot per calendar month wins (recorded beats reconstructed).
  const snapshotByMonth = new Map<string, NetWorthSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.currency !== currency) continue;
    const month = monthKey(snapshot.observedDate);
    const existing = snapshotByMonth.get(month);
    if (!existing || snapshot.observedDate > existing.observedDate) {
      snapshotByMonth.set(month, snapshot);
    }
  }

  const points: NetWorthPoint[] = [];
  for (const month of monthsBetween(coverageStart, asOfMonth)) {
    const recorded = snapshotByMonth.get(month);
    if (recorded) {
      points.push({
        month,
        monthEndDate: monthEndDate(month),
        netWorthCents: recorded.netWorthCents,
        cashCents: recorded.cashCents,
        debtCents: recorded.debtCents,
        basis: "recorded",
      });
      continue;
    }

    // Back-cast: unwind every transaction dated after this month-end.
    const monthEnd = monthEndDate(month);
    let assetAfter = 0;
    let liabAfter = 0;
    for (const d of scoped) {
      if (d.date <= monthEnd) continue;
      if (d.isLiability) liabAfter += d.delta;
      else assetAfter += d.delta;
    }
    const cash = currentCash - assetAfter;
    const debt = currentDebt + liabAfter;

    points.push({
      month,
      monthEndDate: monthEnd,
      netWorthCents: cash - debt,
      cashCents: cash,
      debtCents: debt,
      // The current month reflects live balances — measured, not inferred.
      basis: month === asOfMonth ? "recorded" : "reconstructed",
    });
  }

  const first = points[0];
  return {
    currency,
    points,
    currentNetWorthCents,
    changeCents: first ? currentNetWorthCents - first.netWorthCents : 0,
    coverageStartMonth: first ? first.month : null,
    monthsCovered: points.length,
    hasData: true,
  };
}
