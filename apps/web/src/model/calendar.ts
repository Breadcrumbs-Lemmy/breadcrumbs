/**
 * Calendar grid helpers for the Spending page's SpendingCalendar.
 *
 * Pure date/grid utilities — no aggregation, no API calls, no React.
 * All date arithmetic is in UTC to avoid timezone drift.
 *
 * The calendar is a single, fixed grid that zooms with the Week/Month/Year
 * toggle rather than a long scrolling list:
 *   • Year  → a grid of years           (yearCells)
 *   • Month → a 12-month grid of a year (monthCells)
 *   • Week  → the day/week grid of one month (weekRows)
 *
 * Each cell carries a clamped [startDate, endDate] window so a contiguous
 * selection maps directly to a summary span, and is marked "covered" (data
 * already synced) or "ghost" (within Plaid's reach but not yet pulled).
 */

export type Grain = "week" | "month" | "year";

/** A selectable calendar cell (a year, a month, or a week-row). */
export type Cell = {
  /** Stable, sortable key used as React key and for selection tracking. */
  key: string;
  /** Short in-grid label. E.g. "2025", "Aug", "3–9". */
  label: string;
  /** First day of the cell's window, YYYY-MM-DD (UTC), clamped to [floor,today]. */
  startDate: string;
  /** Last day of the cell's window, YYYY-MM-DD (UTC), clamped to [floor,today]. */
  endDate: string;
  /** False when the cell falls entirely outside [floor, today] — rendered
   *  disabled (out of Plaid's reach or in the future). */
  selectable: boolean;
};

/** One day inside a week-row, for rendering the month's day grid. */
export type DayCell = {
  /** Day-of-month number (1–31). */
  day: number;
  /** ISO date, YYYY-MM-DD (UTC). */
  date: string;
  /** True when the day belongs to the focused month (vs a spill-over day from
   *  the adjacent month shown to complete the Sun–Sat row). */
  inMonth: boolean;
  /** False when the day is outside [floor, today]. */
  selectable: boolean;
};

/** A week-row cell plus its seven day cells for the calendar grid. */
export type WeekRow = Cell & { days: DayCell[] };

// ---------------------------------------------------------------------------
// Internal date helpers (UTC-only)

function toUTCDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Clamp an ISO date string into the inclusive [lo, hi] window. */
function clampStr(value: string, lo: string, hi: string): string {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

const SHORT_MONTHS: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function shortMonth(monthIndex: number): string {
  return SHORT_MONTHS[monthIndex] ?? "";
}

/** Full "August 2026" style label for a focused month. */
export function monthTitle(year: number, month: number): string {
  return `${shortMonth(month)} ${year}`;
}

// ---------------------------------------------------------------------------
// Grid builders

/**
 * Every year from Plaid's floor to today, oldest-first. The floor year's cell
 * starts at `floor`; the current year's cell ends at `today`.
 */
export function yearCells(floor: string, today: string): Cell[] {
  const floorYear = toUTCDate(floor).getUTCFullYear();
  const todayYear = toUTCDate(today).getUTCFullYear();
  const cells: Cell[] = [];

  for (let year = floorYear; year <= todayYear; year++) {
    const rawStart = `${year}-01-01`;
    const rawEnd = `${year}-12-31`;
    cells.push({
      key: String(year),
      label: String(year),
      startDate: clampStr(rawStart, floor, today),
      endDate: clampStr(rawEnd, floor, today),
      selectable: true,
    });
  }

  return cells;
}

/**
 * The 12 months of `year` (Jan–Dec). Months entirely outside [floor, today]
 * are returned with `selectable: false` so the grid stays a fixed 12 cells but
 * out-of-reach / future months render disabled.
 */
export function monthCells(year: number, floor: string, today: string): Cell[] {
  const cells: Cell[] = [];

  for (let month = 0; month < 12; month++) {
    const mm = String(month + 1).padStart(2, "0");
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const rawStart = `${year}-${mm}-01`;
    const rawEnd = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
    // Selectable when the month's window overlaps [floor, today].
    const selectable = rawStart <= today && rawEnd >= floor;

    cells.push({
      key: `${year}-${mm}`,
      label: shortMonth(month),
      startDate: clampStr(rawStart, floor, today),
      endDate: clampStr(rawEnd, floor, today),
      selectable,
    });
  }

  return cells;
}

/**
 * The week-rows of one month, as a Sun–Sat calendar grid. Each row spans seven
 * day cells (spill-over days from adjacent months included to complete the
 * row), but the row's selectable [startDate, endDate] is clamped to the month
 * AND to [floor, today] so selecting a week never pulls a neighbouring month's
 * spending. Rows fully outside [floor, today] are `selectable: false`.
 */
export function weekRows(
  year: number,
  month: number,
  floor: string,
  today: string,
): WeekRow[] {
  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // First grid cell is the Sunday on or before the 1st.
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const cursor = new Date(Date.UTC(year, month, 1));
  cursor.setUTCDate(cursor.getUTCDate() - firstDow);

  const rows: WeekRow[] = [];

  // Stop once a row begins after the month ends.
  while (toDateStr(cursor) <= monthEnd) {
    const days: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      d.setUTCDate(cursor.getUTCDate() + i);
      const date = toDateStr(d);
      const inMonth = d.getUTCMonth() === month && d.getUTCFullYear() === year;
      days.push({
        day: d.getUTCDate(),
        date,
        inMonth,
        selectable: date >= floor && date <= today,
      });
    }

    // Row window clamped to the month, then to [floor, today].
    const rowStart = days[0]!.date;
    const rowEnd = days[6]!.date;
    const inMonthStart = rowStart < monthStart ? monthStart : rowStart;
    const inMonthEnd = rowEnd > monthEnd ? monthEnd : rowEnd;
    const clampedStart = clampStr(inMonthStart, floor, today);
    const clampedEnd = clampStr(inMonthEnd, floor, today);
    const selectable = inMonthStart <= today && inMonthEnd >= floor;

    // Label from the in-month day numbers, e.g. "1–2" or "3–9".
    const inMonthDays = days.filter((d) => d.inMonth).map((d) => d.day);
    const firstNum = inMonthDays[0]!;
    const lastNum = inMonthDays[inMonthDays.length - 1]!;
    const label = firstNum === lastNum ? `${firstNum}` : `${firstNum}–${lastNum}`;

    rows.push({
      key: `w-${rowStart}`,
      label,
      startDate: clampedStart,
      endDate: clampedEnd,
      selectable,
      days,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return rows;
}

// ---------------------------------------------------------------------------

/**
 * True when the cell's date range overlaps the [earliestSynced, latestSynced]
 * window. A null boundary means no data synced — always returns false.
 *
 * Overlap test: cell.startDate ≤ latestSynced AND cell.endDate ≥ earliestSynced.
 */
export function isCovered(
  cell: { startDate: string; endDate: string },
  earliestSynced: string | null,
  latestSynced: string | null,
): boolean {
  if (!earliestSynced || !latestSynced) return false;
  return cell.startDate <= latestSynced && cell.endDate >= earliestSynced;
}

/**
 * Derive the {from, to} date span for a contiguous [startIndex, endIndex]
 * selection into a cells array. Automatically orders lo ≤ hi.
 */
export function spanFromCells(
  cells: Array<{ startDate: string; endDate: string }>,
  startIndex: number,
  endIndex: number,
): { from: string; to: string } {
  const lo = Math.min(startIndex, endIndex);
  const hi = Math.max(startIndex, endIndex);
  return {
    from: cells[lo]?.startDate ?? "",
    to: cells[hi]?.endDate ?? "",
  };
}

/**
 * Pick a sensible default selection index for a freshly-built grid: the most
 * recent cell that has synced data, or — when nothing is covered — the most
 * recent selectable cell. Returns -1 for an empty grid.
 */
export function defaultCellIndex(
  cells: Cell[],
  earliestSynced: string | null,
  latestSynced: string | null,
): number {
  if (cells.length === 0) return -1;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i]!.selectable && isCovered(cells[i]!, earliestSynced, latestSynced)) {
      return i;
    }
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i]!.selectable) return i;
  }
  return cells.length - 1;
}

/**
 * Convert a backend spending-series key (returned by `fetchSpendingSeries`) to
 * its ISO start date so series points can be filtered to a selection date range.
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
