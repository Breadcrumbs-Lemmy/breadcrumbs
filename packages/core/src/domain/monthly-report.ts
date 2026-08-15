/**
 * Monthly report — a composition, not a computation.
 *
 * The "where did my money go" report introduces **no new financial arithmetic**.
 * It calls the two engines that already answer the question on screen —
 * `summarizeSpending` (month totals + per-category breakdown) and
 * `detectInsights` (the narrative copy + recurring commitments) — for a single
 * month, feeds them the *same* transactions and the *same* period key, and
 * returns both. Every figure on the report is therefore a figure the Spending or
 * Insights screen would show for that month; there is no second source of truth
 * to drift (`CD-003`). See `docs/report.md` (D-R1..D-R10).
 *
 * The only genuinely new code here is `toReportCsv`: a pure, deterministic
 * serializer, so the exact exported bytes are covered by the same test
 * discipline as the math (D-R10).
 */
import { addDays } from "./dates";
import { detectInsights, type InsightsResult } from "./insights";
import { periodForDate } from "./periods";
import { summarizeSpending, type SpendingSummary } from "./spending-summary";
import type { Account, Transaction } from "./types";

/** `YYYY-MM` with a real month (01–12). The only month-key shape the report
 *  accepts; a bad month is treated as "no key" rather than fed to the calendar
 *  arithmetic (which would throw on e.g. `2022-13`). */
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthlyReport = {
  currency: string;
  /** The data's "now" — the latest posted date, never the wall clock (`CD-011`). */
  asOfDate: string;
  /** The month the caller explicitly asked for, or null when the default was used. */
  requestedKey: string | null;
  /** True when no key was given and the latest **complete** month was chosen. */
  fromLatestComplete: boolean;
  /** `summary.period` is the canonical month for the whole report. */
  summary: SpendingSummary;
  insights: InsightsResult;
};

export type BuildMonthlyReportOptions = {
  /** Already annotated (transfer pairs + recurrence) by the caller, exactly as
   *  the spending routes annotate before any engine sees a row. */
  transactions: Transaction[];
  accounts: Account[];
  currency: string;
  asOfDate: string;
  /** Explicit month (`YYYY-MM`). Omitted or malformed → latest complete month. */
  key?: string;
  categoryLabel?: (id: string) => string;
};

/**
 * The latest **fully-elapsed** calendar month at `asOfDate`.
 *
 * The current month is still filling (`partial`) until its final day, so the
 * honest default for a retrospective report steps back to the month before it.
 * On the last day of a month, that month is complete and is used as-is.
 */
function latestCompleteMonthKey(asOfDate: string): string {
  const current = periodForDate("month", asOfDate, asOfDate);
  if (!current.partial) return current.key;
  return periodForDate("month", addDays(current.startDate, -1), asOfDate).key;
}

export function buildMonthlyReport(options: BuildMonthlyReportOptions): MonthlyReport {
  const { transactions, accounts, currency, asOfDate, categoryLabel } = options;

  // A malformed key is treated as "no key" so the report never renders a month
  // the caller did not actually ask for. The server validates the key before it
  // reaches here, so this only guards direct core callers.
  const requestedKey = options.key && MONTH_KEY.test(options.key) ? options.key : null;
  const fromLatestComplete = requestedKey === null;
  const key = requestedKey ?? latestCompleteMonthKey(asOfDate);

  const shared = { transactions, accounts, currency, asOfDate, key, categoryLabel } as const;

  return {
    currency,
    asOfDate,
    requestedKey,
    fromLatestComplete,
    summary: summarizeSpending({ ...shared, kind: "month" }),
    insights: detectInsights({ ...shared, kind: "month" }),
  };
}

// ---- CSV export ------------------------------------------------------------

const CSV_HEADER = ["Category", "Spent", "Refunds", "Net", "Share %", "Transactions"] as const;

/**
 * Serialise a report's per-category breakdown to a clean, single RFC-4180 table
 * (D-R6). One row per category in the backend's sort order (largest net first),
 * then a `Total` row. No preamble rows — the month and currency ride in the
 * filename and the JSON, not the table body, so the CSV imports cleanly.
 */
export function toReportCsv(report: MonthlyReport): string {
  const { summary } = report;
  const rows: string[][] = [[...CSV_HEADER]];

  for (const c of summary.categoryTotals) {
    rows.push([
      c.displayName,
      hundredths(c.grossOutflowCents),
      hundredths(c.refundCents),
      hundredths(c.outflowCents),
      hundredths(c.shareBasisPoints),
      String(c.transactionCount),
    ]);
  }

  const totalTransactions = summary.categoryTotals.reduce((n, c) => n + c.transactionCount, 0);
  rows.push([
    "Total",
    hundredths(summary.grossOutflowCents),
    hundredths(summary.refundCents),
    hundredths(summary.totalOutflowCents),
    // The whole is 100% of itself; showing the sum of rounded parts could read
    // as 99.99/100.01 and look like an error.
    hundredths(summary.totalOutflowCents > 0 ? 10_000 : 0),
    String(totalTransactions),
  ]);

  // Trailing CRLF: each record, including the last, is terminated — the shape a
  // spreadsheet export produces and the CSV parser tolerates.
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Render an integer number of hundredths as a fixed two-decimal string using
 * pure integer arithmetic — no float ever touches the value, so `1234` is always
 * `"12.34"` and never `"12.340000000000001"`. Serves both money (cents →
 * dollars) and share (basis points → percent), which are both hundredths of
 * their unit. Negatives (a category whose refunds exceed its spend) keep the
 * sign on the whole part.
 */
function hundredths(value: number): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** RFC-4180 field escaping: quote a field containing a comma, quote, CR, or LF,
 *  doubling any interior quote. A category label is the only field that could. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
