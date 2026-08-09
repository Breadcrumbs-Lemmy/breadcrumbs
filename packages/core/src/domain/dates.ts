const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts as [number, number, number];
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

export function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function addDays(date: string, days: number): string {
  const parsed = parseDateParts(date);
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function daysBetween(startDate: string, endDate: string): number {
  const start = parseDateToUtc(startDate);
  const end = parseDateToUtc(endDate);
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY);
}

export function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let current = startDate; compareDates(current, endDate) <= 0; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function clampDay(year: number, month: number, dayOfMonth: number): number {
  return Math.min(dayOfMonth, daysInMonth(year, month));
}

export function addMonths(date: string, months: number, preferredDayOfMonth?: number): string {
  const parsed = parseDateParts(date);
  const monthIndex = parsed.month - 1 + months;
  const year = parsed.year + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  const day = clampDay(year, month, preferredDayOfMonth ?? parsed.day);

  return formatDate(year, month, day);
}

export function parseDateParts(date: string): { year: number; month: number; day: number } {
  if (!isIsoDate(date)) {
    throw new Error(`Invalid ISO date: ${date}`);
  }

  const parts = date.split("-").map(Number);
  const [year, month, day] = parts as [number, number, number];
  return { year, month, day };
}

export function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Reduce a looser date-like string to its calendar date (YYYY-MM-DD).
 *
 * The calendar day must NOT depend on the host's timezone. The old
 * implementation parsed with `Date.parse` (which reads a zoneless date-time as
 * *local* time) and then formatted with `toISOString` (which is *UTC*); that
 * mismatch shifted the date by a day on any machine not running in UTC, quietly
 * corrupting the balance-staleness age this feeds. So each recognised shape is
 * read literally, with no instant-in-time conversion in the path.
 */
export function extractIsoDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (isIsoDate(trimmed)) return trimmed;

  // A date-prefixed timestamp ("2021-06-15T08:30:00Z", "2021-06-15 12:00"): the
  // calendar date is written verbatim at the front, so take it as-is. This is
  // the common input — `toISOString()` output from a sync — and reading it
  // literally means no timezone can roll it to an adjacent day.
  const isoPrefix = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(trimmed);
  if (isoPrefix) {
    const candidate = `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;
    return isIsoDate(candidate) ? candidate : undefined;
  }

  // US-style M/D/Y or M-D-Y, the usual CSV/statement shape.
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (us) {
    const candidate = formatDate(Number(us[3]), Number(us[1]), Number(us[2]));
    return isIsoDate(candidate) ? candidate : undefined;
  }

  // Anything else (e.g. "August 8, 2026"): let the engine parse it, but read the
  // components back in the SAME zone it parsed in (local), so the parse and the
  // read cancel and the written day survives on any host — unlike a local-parse
  // then UTC-format round trip.
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  const parsed = new Date(timestamp);
  return formatDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

export function hoursBetweenIsoLike(start: string, endDate: string): number | undefined {
  const startDate = extractIsoDate(start);
  if (!startDate) return undefined;

  return daysBetween(startDate, endDate) * 24;
}

function parseDateToUtc(date: string): Date {
  const { year, month, day } = parseDateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}
