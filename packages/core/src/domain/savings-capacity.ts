/**
 * Savings capacity — a factual read of how much room the user's own cash flow
 * has already been leaving for saving.
 *
 * A savings *goal* is a declaration (`D-G2`): the user states a target and a
 * monthly contribution. But "how much should I even try to save?" is the
 * question most people can't answer without trawling months of statements — the
 * exact drudgery this product exists to remove. This module answers it from the
 * user's *own* imported history, and answers it as **two observed figures, not a
 * recommendation** (`D-G11`):
 *
 *  - `floorCents`  — the median monthly **surplus** (income minus everything they
 *    actually spent) over recent complete months. "In a typical recent month,
 *    about this much was left over after all your spending."
 *  - `ceilingCents` — the median monthly **income minus essential spending**
 *    (housing, utilities, groceries, transport, insurance, medical, childcare,
 *    debt). "If nothing beyond your essentials were spent, up to about this much
 *    could be set aside." An upper bound on the same cash flow, never a target.
 *
 * Both are statements about money that already moved through the user's
 * accounts, framed so the UI can present a range to pre-fill a goal — never as
 * advice about what they *ought* to do (the charter bans personalised financial
 * advice; a factual observation of one's own cash flow is not advice).
 *
 * Everything is a pure function of the inputs. Transfers between the user's own
 * accounts are excluded (they are neither income nor spending): the figures are
 * read off `summarizeMonthlySpending`, the single engine that already pairs and
 * removes them, so this module never re-implements that classification. `asOfDate`
 * defaults to the latest posted date, never the wall clock, keeping the result
 * deterministic.
 */
import { compareDates } from "./dates";
import { summarizeMonthlySpending } from "./monthly-spending";
import { periodForDate } from "./periods";
import type { Account, Transaction } from "./types";

/**
 * The core living costs treated as unavoidable when computing the ceiling.
 *
 * Deliberately *broader* than the taxonomy's `requiredDefault` set: that flag
 * marks groceries and transport as non-required (you *could* trim them), which
 * is the right call for a spending guardrail but wrong here — a ceiling that
 * counted the entire grocery bill as "savable" would be absurd. So essentials
 * here are the realistic non-discretionary floor of living: housing, utilities,
 * groceries, transport, insurance, medical, childcare, and debt service.
 * Everything else (dining, coffee, entertainment, streaming, shopping, travel …)
 * is treated as discretionary and therefore part of the room above essentials.
 * Savings transfers and credit-card payments are absent by design: they are
 * transfers, already excluded from spending upstream.
 */
export const ESSENTIAL_CATEGORIES: ReadonlySet<string> = new Set([
  "housing",
  "utilities",
  "groceries",
  "transportation",
  "insurance",
  "medical",
  "childcare",
  "debt_payment",
]);

/** How many recent complete months feed the medians, at most. Keeps "typical"
 *  recent without letting years of stale history dilute it. */
const DEFAULT_MAX_MONTHS = 12;

/** Below two complete months there is no "typical" — one month is an anecdote,
 *  not a pattern. The figures are still returned, but `hasEnoughData` is false so
 *  the UI can decline to pre-fill and invite the user to type their own. */
const MINIMUM_MONTHS_FOR_SUGGESTION = 2;

export type SavingsCapacityOptions = {
  transactions: Transaction[];
  currency: string;
  /** Used only to identify credit-card-payment transfers so they are excluded
   *  cleanly; the figures work without accounts, just less precisely. */
  accounts?: Account[];
  /** Reference "now". Defaults to the latest posted date, never the clock. */
  asOfDate?: string;
  /** Cap on how many recent complete months to consider. Default 12. */
  maxMonths?: number;
};

/** The observed capacity range. Amounts are integer cents. `ceilingCents` is
 *  always ≥ `floorCents`. When `hasEnoughData` is false the amounts are 0 (or a
 *  lone month's figures) and the UI should not present them as a range. */
export type SavingsCapacitySuggestion = {
  currency: string;
  /** Median monthly surplus (income − all spending), floored at 0. */
  floorCents: number;
  /** Median monthly (income − essential spending), floored at 0, never below the
   *  floor. */
  ceilingCents: number;
  /** How many complete calendar months fed the medians. */
  monthsConsidered: number;
  /** True once at least `MINIMUM_MONTHS_FOR_SUGGESTION` complete months exist. */
  hasEnoughData: boolean;
};

/**
 * Observe the user's savings capacity from their transaction history.
 *
 * Buckets transactions into calendar months via the shared spending engine,
 * keeps only the months that lie *entirely* within the observed data window
 * (a partial first or last month would understate both income and spending),
 * takes the most recent `maxMonths` of them, and reports the median surplus and
 * the median income-above-essentials across that set.
 */
export function suggestSavingsCapacity(options: SavingsCapacityOptions): SavingsCapacitySuggestion {
  const currency = options.currency.toUpperCase();
  const maxMonths = Math.max(1, Math.floor(options.maxMonths ?? DEFAULT_MAX_MONTHS));
  const inCurrency = options.transactions.filter((transaction) => transaction.currency === currency);

  const empty: SavingsCapacitySuggestion = {
    currency,
    floorCents: 0,
    ceilingCents: 0,
    monthsConsidered: 0,
    hasEnoughData: false,
  };
  if (inCurrency.length === 0) return empty;

  const asOfDate = options.asOfDate ?? latestPostedDate(inCurrency);
  const earliest = earliestPostedDate(inCurrency);
  if (!asOfDate || !earliest) return empty;

  const summaries = summarizeMonthlySpending(inCurrency, currency, options.accounts ?? []);

  // A month counts only when the whole calendar month falls inside the observed
  // window [earliest, asOfDate]. That excludes a partial leading month (data
  // started mid-month) and a partial trailing month (asOfDate lands inside it) —
  // either would drag income and spending down and skew the estimate.
  const complete = summaries.filter((summary) => {
    const period = periodForDate("month", `${summary.month}-01`, asOfDate);
    return compareDates(period.startDate, earliest) >= 0 && compareDates(period.endDate, asOfDate) <= 0;
  });

  // Recent, not all-time: the trailing `maxMonths` complete months (ascending).
  const considered = complete.slice(Math.max(0, complete.length - maxMonths));
  if (considered.length === 0) return empty;

  const surplus: number[] = [];
  const aboveEssentials: number[] = [];
  for (const month of considered) {
    const essentialOutflow = month.categoryTotals
      .filter((total) => ESSENTIAL_CATEGORIES.has(total.category))
      .reduce((sum, total) => sum + total.outflowCents, 0);
    surplus.push(month.totalInflowCents - month.totalOutflowCents);
    aboveEssentials.push(month.totalInflowCents - essentialOutflow);
  }

  const floorCents = Math.max(0, median(surplus));
  // Element-wise (income − essential) ≥ (income − total), so the ceiling median
  // is ≥ the floor median; the explicit max makes the invariant self-evident and
  // guards the clamp-at-0 corner.
  const ceilingCents = Math.max(floorCents, Math.max(0, median(aboveEssentials)));

  return {
    currency,
    floorCents,
    ceilingCents,
    monthsConsidered: considered.length,
    hasEnoughData: considered.length >= MINIMUM_MONTHS_FOR_SUGGESTION,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function latestPostedDate(transactions: Transaction[]): string | undefined {
  let latest: string | undefined;
  for (const transaction of transactions) {
    if (!latest || compareDates(transaction.postedDate, latest) > 0) latest = transaction.postedDate;
  }
  return latest;
}

function earliestPostedDate(transactions: Transaction[]): string | undefined {
  let earliest: string | undefined;
  for (const transaction of transactions) {
    if (!earliest || compareDates(transaction.postedDate, earliest) < 0) earliest = transaction.postedDate;
  }
  return earliest;
}
