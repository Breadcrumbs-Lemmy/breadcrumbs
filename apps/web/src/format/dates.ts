/**
 * Date formatting — docs/ui-copy-map.md "Number and Date Formatting".
 *
 * Backend dates are ISO YYYY-MM-DD calendar dates in the user's financial
 * timezone. They are parsed as calendar dates, never as instants, so a
 * viewer in another timezone never sees a date shift by a day.
 */

const UNAVAILABLE = "—";

function parseCalendarDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  // UTC construction keeps the calendar date stable regardless of viewer locale.
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/** "Aug 14", or "Aug 14, 2027" when the year differs from the reference. */
export function formatDate(iso: string | null | undefined, referenceIso?: string): string {
  if (!iso) return UNAVAILABLE;
  const date = parseCalendarDate(iso);
  if (!date) return UNAVAILABLE;

  const referenceYear = referenceIso ? parseCalendarDate(referenceIso)?.getUTCFullYear() : undefined;
  const showYear = referenceYear !== undefined && date.getUTCFullYear() !== referenceYear;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

/** "3 hours ago", "4 days ago", or an absolute date beyond 30 days. */
export function formatRelativeAge(
  asOf: string | null | undefined,
  ageHours?: number,
): string {
  if (ageHours !== undefined && Number.isFinite(ageHours)) {
    if (ageHours < 1) return "less than an hour ago";
    if (ageHours < 24) {
      const hours = Math.floor(ageHours);
      return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    const days = Math.floor(ageHours / 24);
    if (days <= 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (!asOf) return UNAVAILABLE;
  return formatDate(asOf.slice(0, 10));
}

export { UNAVAILABLE };
