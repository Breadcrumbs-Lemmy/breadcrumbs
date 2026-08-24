/**
 * Calendar helpers for the Spending page's collapsible date-range picker.
 *
 * Pure date utilities — no aggregation, no API calls, no React. All date
 * arithmetic is in UTC to avoid timezone drift.
 *
 * The Spending calendar is a single, consistent month day-grid (independent of
 * the Week/Month/Year filter). The user opens it from a button, navigates
 * month to month, and picks a contiguous day range; a day carries a "covered"
 * flag (data already synced) so unsynced spans can offer a Plaid backfill.
 */

/** One day cell in the month grid. */
export type DayCell = {
  /** Day-of-month number (1–31). */
  day: number;
  /** ISO date, YYYY-MM-DD (UTC). */
  date: string;
  /** True when the day belongs to the rendered month (vs a spill-over day from
   *  the adjacent month shown to complete the Sun–Sat row). */
  inMonth: boolean;
  /** False when the day is outside [floor, today] — not selectable. */
  selectable: boolean;
};

/** A named quick-range preset. */
export type PresetRange = { label: string; from: string; to: string };

/** A coarse selectable cell (a whole month or year) in the zoomed-out grids. */
export type Cell = {
  key: string;
  label: string;
  /** Inclusive range bounds, clamped to [floor, today]. */
  startDate: string;
  endDate: string;
  selectable: boolean;
};

// ---------------------------------------------------------------------------
// Internal date helpers (UTC-only)

function toUTCDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const SHORT_MONTHS: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function shortMonth(monthIndex: number): string {
  return SHORT_MONTHS[monthIndex] ?? "";
}

/** Full "August 2026" style title for a focused month. */
export function monthTitle(year: number, month: number): string {
  return `${shortMonth(month)} ${year}`;
}

// ---------------------------------------------------------------------------
// Month grid

/**
 * Lay out one month as Sun–Sat rows of day cells. Spill-over days from the
 * adjacent months are included (flagged `inMonth: false`) to complete the first
 * and last rows. Days outside [floor, today] are `selectable: false`.
 */
export function monthGrid(
  year: number,
  month: number,
  floor: string,
  today: string,
): DayCell[][] {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // First grid cell is the Sunday on or before the 1st.
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const cursor = new Date(Date.UTC(year, month, 1));
  cursor.setUTCDate(cursor.getUTCDate() - firstDow);

  const rows: DayCell[][] = [];
  while (toDateStr(cursor) <= monthEnd) {
    const row: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      d.setUTCDate(cursor.getUTCDate() + i);
      const date = toDateStr(d);
      row.push({
        day: d.getUTCDate(),
        date,
        inMonth: d.getUTCMonth() === month && d.getUTCFullYear() === year,
        selectable: date >= floor && date <= today,
      });
    }
    rows.push(row);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return rows;
}

/**
 * One cell per year from floor's year through today's year. Bounds are clamped
 * to [floor, today] (the floor year starts at the floor date; the current year
 * ends today). Every year in range is selectable.
 */
export function yearCells(floor: string, today: string): Cell[] {
  const floorYear = Number(floor.slice(0, 4));
  const todayYear = Number(today.slice(0, 4));
  const cells: Cell[] = [];
  for (let y = floorYear; y <= todayYear; y++) {
    const start = `${y}-01-01`;
    const end = `${y}-12-31`;
    cells.push({
      key: String(y),
      label: String(y),
      startDate: start < floor ? floor : start,
      endDate: end > today ? today : end,
      selectable: true,
    });
  }
  return cells;
}

/**
 * Twelve month cells for a year. Bounds are clamped to [floor, today]; a month
 * entirely before the floor or after today is not selectable.
 */
export function monthCells(year: number, floor: string, today: string): Cell[] {
  const cells: Cell[] = [];
  for (let m = 0; m < 12; m++) {
    const mm = String(m + 1).padStart(2, "0");
    const lastDay = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const start = `${year}-${mm}-01`;
    const end = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
    cells.push({
      key: `${year}-${mm}`,
      label: shortMonth(m),
      startDate: start < floor ? floor : start,
      endDate: end > today ? today : end,
      selectable: end >= floor && start <= today,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Coverage

/**
 * True when a date range overlaps the [earliestSynced, latestSynced] window.
 * A null boundary means no data synced — always returns false. For a single
 * day, pass the same date as both bounds.
 *
 * Overlap test: startDate ≤ latestSynced AND endDate ≥ earliestSynced.
 */
export function isCovered(
  range: { startDate: string; endDate: string },
  earliestSynced: string | null,
  latestSynced: string | null,
): boolean {
  if (!earliestSynced || !latestSynced) return false;
  return range.startDate <= latestSynced && range.endDate >= earliestSynced;
}

/** True when any day in the inclusive [from, to] range is NOT yet synced. */
export function rangeHasUnsynced(
  from: string,
  to: string,
  earliestSynced: string | null,
  latestSynced: string | null,
): boolean {
  if (!from || !to) return false;
  // Nothing synced at all → the whole range is unsynced.
  if (!earliestSynced || !latestSynced) return true;
  // A day is uncovered when it falls before the synced window or after it.
  return from < earliestSynced || to > latestSynced;
}

// ---------------------------------------------------------------------------
// Range formatting + presets

/** Human label for a selected range, e.g. "Aug 5, 2026" or "Jun 1 – Aug 23, 2026". */
export function formatRange(from: string, to: string): string {
  if (!from || !to) return "";
  const fMonth = shortMonth(Number(from.slice(5, 7)) - 1);
  const fDay = Number(from.slice(8, 10));
  const fYear = from.slice(0, 4);
  const tMonth = shortMonth(Number(to.slice(5, 7)) - 1);
  const tDay = Number(to.slice(8, 10));
  const tYear = to.slice(0, 4);

  if (from === to) return `${fMonth} ${fDay}, ${fYear}`;
  if (fYear === tYear) return `${fMonth} ${fDay} – ${tMonth} ${tDay}, ${tYear}`;
  return `${fMonth} ${fDay}, ${fYear} – ${tMonth} ${tDay}, ${tYear}`;
}

/**
 * Quick-range presets for looking back, each clamped to Plaid's floor. All end
 * at today. "Last N days" is inclusive of today (N days total).
 */
export function presetRanges(floor: string, today: string): PresetRange[] {
  const back = (days: number): string => {
    const d = toUTCDate(today);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return toDateStr(d);
  };
  const clampFloor = (s: string): string => (s < floor ? floor : s);
  const yearStart = `${today.slice(0, 4)}-01-01`;

  return [
    { label: "Last 30 days", from: clampFloor(back(30)), to: today },
    { label: "Last 90 days", from: clampFloor(back(90)), to: today },
    { label: "This year", from: clampFloor(yearStart), to: today },
  ];
}

// ---------------------------------------------------------------------------

/**
 * Convert a backend spending-series key (returned by `fetchSpendingSeries`) to
 * its ISO start date so series points can be filtered to a selected range.
 *
 * Handles:
 *   "2026-08"  → "2026-08-01"   (month)
 *   "2026"     → "2026-01-01"   (year)
 *   "2026-W34" → "2026-08-17"   (ISO week — returns the Monday)
 *
 * Returns null for unrecognized formats.
 */
export function seriesKeyToStartDate(key: string): string | null {
  // Month: "YYYY-MM"
  if (/^\d{4}-\d{2}$/.test(key)) return key + "-01";
  // Year: "YYYY"
  if (/^\d{4}$/.test(key)) return key + "-01-01";
  // ISO week: "YYYY-WNN"
  const weekMatch = /^(\d{4})-W(\d{2})$/.exec(key);
  if (weekMatch) {
    const year = parseInt(weekMatch[1]!, 10);
    const week = parseInt(weekMatch[2]!, 10);
    // ISO week 1 is the week containing Jan 4. Find its Monday.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay();
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day === 0 ? 6 : jan4Day - 1));
    const weekMon = new Date(week1Mon);
    weekMon.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
    return toDateStr(weekMon);
  }
  return null;
}
