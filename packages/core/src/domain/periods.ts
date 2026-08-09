/**
 * Period bucketing for spending views.
 *
 * The product needs weekly, monthly, yearly, and — most importantly — credit
 * card statement periods. This module owns the calendar arithmetic so no other
 * layer has to guess where a period starts and ends.
 *
 * Statement periods are the reason this file exists rather than a `monthKey`
 * helper. A card closing on the 18th means the bill arriving in August covers
 * 19 July to 18 August. A calendar-month view can never reconcile to the
 * statement a user actually pays, which is precisely when they are trying to
 * work out where the money went.
 */
import { addDays, compareDates, daysBetween, formatDate, parseDateParts, clampDay } from "./dates";

export type PeriodKind = "week" | "month" | "year" | "statement";

export type Period = {
  kind: PeriodKind;
  /** Stable identifier. `2026-W32`, `2026-08`, `2026`, or `acct:2026-08-18`. */
  key: string;
  /** Rendered by the UI verbatim. The UI never composes period labels. */
  label: string;
  startDate: string;
  endDate: string;
  /** True when `asOfDate` falls inside the period, so it is still filling up. */
  partial: boolean;
  elapsedDays: number;
  totalDays: number;
  /** Present only for statement periods. */
  accountId?: string;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ISO-8601 week: weeks start Monday, week 1 contains the first Thursday. */
function isoWeekStart(date: string): string {
  const { year, month, day } = parseDateParts(date);
  const utc = Date.UTC(year, month - 1, day);
  const dow = new Date(utc).getUTCDay(); // 0 = Sunday
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(date, offset);
}

function isoWeekNumber(date: string): { year: number; week: number } {
  const start = isoWeekStart(date);
  const { year, month, day } = parseDateParts(start);
  const thursday = addDays(formatDate(year, month, day), 3);
  const t = parseDateParts(thursday);
  // ISO week 1 is the week containing 4 January, so W01's Monday anchors the
  // count. Anchoring on 1 January over-counts by one for every ISO year that
  // opens on a Fri/Sat/Sun, because 1 January's Monday then belongs to the
  // previous ISO year's final week. (`periodFromKey` already uses 4 January.)
  const jan4 = formatDate(t.year, 1, 4);
  const week = Math.floor(daysBetween(isoWeekStart(jan4), thursday) / 7) + 1;
  return { year: t.year, week };
}

function bounded(startDate: string, endDate: string, asOfDate: string): {
  partial: boolean;
  elapsedDays: number;
  totalDays: number;
} {
  const totalDays = daysBetween(startDate, endDate) + 1;
  const started = compareDates(asOfDate, startDate) >= 0;
  const finished = compareDates(asOfDate, endDate) >= 0;
  // A period is partial only while it is still filling. On its final day it is
  // complete: an earlier version treated the last day as partial, which
  // silently suppressed the month-end comparison — exactly when a user most
  // wants it.
  const partial = started && !finished;
  const elapsedDays = finished ? totalDays : started ? daysBetween(startDate, asOfDate) + 1 : 0;
  return { partial, elapsedDays, totalDays };
}

export function periodForDate(kind: Exclude<PeriodKind, "statement">, date: string, asOfDate: string): Period {
  if (kind === "week") {
    const startDate = isoWeekStart(date);
    const endDate = addDays(startDate, 6);
    const { year, week } = isoWeekNumber(date);
    const s = parseDateParts(startDate);
    return {
      kind,
      key: `${year}-W${String(week).padStart(2, "0")}`,
      label: `Week of ${MONTH_NAMES[s.month - 1]!.slice(0, 3)} ${s.day}`,
      startDate,
      endDate,
      ...bounded(startDate, endDate, asOfDate),
    };
  }

  const { year, month } = parseDateParts(date);

  if (kind === "month") {
    const startDate = formatDate(year, month, 1);
    const endDate = formatDate(year, month, clampDay(year, month, 31));
    return {
      kind,
      key: `${year}-${String(month).padStart(2, "0")}`,
      label: MONTH_NAMES[month - 1]!,
      startDate,
      endDate,
      ...bounded(startDate, endDate, asOfDate),
    };
  }

  const startDate = formatDate(year, 1, 1);
  const endDate = formatDate(year, 12, 31);
  return {
    kind,
    key: String(year),
    label: String(year),
    startDate,
    endDate,
    ...bounded(startDate, endDate, asOfDate),
  };
}

/**
 * The statement period containing `date` for a card closing on `closingDay`.
 *
 * A statement closing on the 18th runs 19th → 18th. Closing days beyond the
 * length of a month clamp to the last day, so a card closing on the 31st ends
 * on 28 February rather than silently rolling into March.
 */
export function statementPeriodForDate(
  date: string,
  closingDay: number,
  asOfDate: string,
  accountId: string,
  accountLabel: string,
): Period {
  const { year, month, day } = parseDateParts(date);
  const closeThisMonth = clampDay(year, month, closingDay);

  let endYear = year;
  let endMonth = month;
  if (day > closeThisMonth) {
    endMonth += 1;
    if (endMonth > 12) {
      endMonth = 1;
      endYear += 1;
    }
  }

  const endDate = formatDate(endYear, endMonth, clampDay(endYear, endMonth, closingDay));

  let startYear = endYear;
  let startMonth = endMonth - 1;
  if (startMonth < 1) {
    startMonth = 12;
    startYear -= 1;
  }
  const startDate = addDays(
    formatDate(startYear, startMonth, clampDay(startYear, startMonth, closingDay)),
    1,
  );

  const e = parseDateParts(endDate);
  return {
    kind: "statement",
    key: `${accountId}:${endDate}`,
    label: `${accountLabel} · closes ${MONTH_NAMES[e.month - 1]!.slice(0, 3)} ${e.day}`,
    startDate,
    endDate,
    accountId,
    ...bounded(startDate, endDate, asOfDate),
  };
}

/** The N most recent periods ending at or before `asOfDate`, oldest first. */
export function recentPeriods(
  kind: Exclude<PeriodKind, "statement">,
  asOfDate: string,
  count: number,
): Period[] {
  const out: Period[] = [];
  let cursor = asOfDate;
  for (let i = 0; i < count; i += 1) {
    const period = periodForDate(kind, cursor, asOfDate);
    out.unshift(period);
    cursor = addDays(period.startDate, -1);
  }
  return out;
}

export function periodFromKey(
  kind: Exclude<PeriodKind, "statement">,
  key: string,
  asOfDate: string,
): Period | undefined {
  if (kind === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return undefined;
    return periodForDate("month", `${m[1]}-${m[2]}-01`, asOfDate);
  }
  if (kind === "year") {
    const m = /^(\d{4})$/.exec(key);
    if (!m) return undefined;
    return periodForDate("year", `${m[1]}-01-01`, asOfDate);
  }
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return undefined;
  // Week 1 contains the first Thursday, so 4 January is always in it.
  const jan4 = `${m[1]}-01-04`;
  const firstWeekStart = isoWeekStart(jan4);
  const target = addDays(firstWeekStart, (Number(m[2]) - 1) * 7);
  return periodForDate("week", target, asOfDate);
}

export function containsDate(period: Period, date: string): boolean {
  return compareDates(date, period.startDate) >= 0 && compareDates(date, period.endDate) <= 0;
}

/** Human phrase for a comparison baseline. Backend owns this so the UI does
 *  not decide pluralisation or wording for a financial comparison. */
export function baselineLabel(kind: PeriodKind, count: number): string {
  if (count === 0) return "no earlier data";
  const unit = kind === "week" ? "week" : kind === "year" ? "year" : kind === "statement" ? "statement" : "month";
  if (count === 1) return `the ${unit} before`;
  return `the last ${count} ${unit}s`;
}
