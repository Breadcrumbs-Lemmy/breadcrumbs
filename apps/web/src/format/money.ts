/**
 * Money formatting — docs/ui-copy-map.md "Number and Date Formatting".
 *
 * Formatting only. No arithmetic on backend values beyond sign handling for
 * display, which is presentation, not calculation.
 */

const UNAVAILABLE = "—";

export type MoneyOptions = {
  /** Renders the ~ prefix for estimated values. */
  estimated?: boolean;
  /** Force cents even when zero. */
  alwaysCents?: boolean;
};

/**
 * Absent figures render as an em-dash, never as $0.00.
 *
 * This is a correctness rule, not a style choice: $0.00 asserts a known value
 * of zero, which is a different claim from "not known". See the UNKNOWN state
 * in docs/ui-mvp0-screens.md.
 */
export function formatMoney(
  cents: number | null | undefined,
  options: MoneyOptions = {},
): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return UNAVAILABLE;
  }

  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const showCents = options.alwaysCents === true || absolute % 100 !== 0;

  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(absolute / 100);

  const prefix = options.estimated === true ? "~" : "";
  // Negatives use a leading minus, never parentheses.
  return `${prefix}${negative ? "-" : ""}${formatted}`;
}

export function isMoneyAvailable(cents: number | null | undefined): boolean {
  return cents !== null && cents !== undefined && Number.isFinite(cents);
}

export { UNAVAILABLE };
