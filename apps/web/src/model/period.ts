/**
 * Period model for the spending views.
 *
 * The product needs weekly, monthly, and yearly views. All three are served by
 * `GET /api/v1/spending/summary?period=` — `H-018` is closed on the backend
 * side, and `packages/core/src/domain/periods.ts` owns the bucketing.
 *
 * This module deliberately contains **no aggregation**. It names periods and
 * describes what the UI is asking for. Bucketing transactions into weeks or
 * years is backend work (`CD-003`); doing it here would produce a second set of
 * totals that could disagree with the backend's own.
 *
 * The fourth kind is the one that matters most for the product's stated
 * purpose. See `statement` below.
 */

export type PeriodKind =
  | "week"
  | "month"
  | "year"
  /**
   * A credit card's statement cycle, which is **not** a calendar month.
   *
   * This exists because the core user problem is: "I spend a lot on my credit
   * card and then towards the end of the month I'm racing to figure out how,
   * and I still have to pay it off."
   *
   * A calendar-month view cannot answer that question. If a card closes on the
   * 18th, the bill landing in August is mostly July spending. Showing the user
   * "August: $2,707" when their statement says $3,140 for a period that started
   * on 19 July makes the product look wrong at the exact moment they most need
   * it to look right.
   *
   * The backend computes this (`statementPeriodForDate`), but it needs a card
   * with a known `closingDay`, and CSV import does not capture one. Until a
   * closing day can be supplied, the endpoint would silently fall back to the
   * calendar month — which is the specific lie this period kind exists to
   * prevent — so the UI keeps it switched off rather than showing a month
   * labelled as a statement.
   */
  | "statement";

export type Period = {
  kind: PeriodKind;
  /** Backend key. For `month` this is `YYYY-MM`. */
  key: string;
  /** Human label, e.g. "August", "Week of 4 Aug", "2026". */
  label: string;
  /** True when the period has not finished, which suppresses comparisons. */
  partial: boolean;
};

export const PERIOD_LABELS: Record<PeriodKind, string> = {
  week: "Week",
  month: "Month",
  year: "Year",
  statement: "Statement",
};

/**
 * Which period kinds the backend can currently serve.
 *
 * The UI renders unsupported kinds as an explicit "not available yet" state
 * rather than hiding them or, worse, computing them locally. Hiding them would
 * lose the product intent; computing them would break `CD-003`.
 */
export const PERIOD_SUPPORTED: Record<PeriodKind, boolean> = {
  week: true,
  month: true,
  year: true,
  statement: false,
};

export function isPeriodSupported(kind: PeriodKind): boolean {
  return PERIOD_SUPPORTED[kind];
}

/** `YYYY-MM` to a display label, without inventing a locale-specific format. */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const [, year, month] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
}

export function monthYear(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  return match ? match[1]! : key;
}
