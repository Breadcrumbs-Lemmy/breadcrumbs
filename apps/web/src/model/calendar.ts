/**
 * Calendar bucket helpers for the Coverage Rail.
 *
 * Pure date/bucket utilities — no aggregation, no API calls, no React.
 * All date arithmetic is in UTC to avoid timezone drift.
 *
 * A "bucket" is a labelled time window (a week, month, or year) rendered as a
 * cell in the CoverageRail. The rail shows buckets from Plaid's ~24-month
 * floor up to today; each is marked "covered" (data already synced) or
 * "ghost" (within reach but not yet pulled).
 */

export type Grain = "week" | "month" | "year";

export type Bucket = {
  /** Stable, sortable key used as React key and for selection tracking.
   *  Format: "2026-08" (month), "2026" (year), "w-2026-08-11" (week: Monday). */
  key: string;
  /** Human label for the cell. E.g. "Aug", "Aug 2025", "2025", "Wk of 17 Aug". */
  label: string;
  /** First day of the bucket, YYYY-MM-DD (UTC). */
  startDate: string;
  /** Last day of the bucket, YYYY-MM-DD (UTC). For the current (incomplete)
   *  bucket this is clamped to today. */
  endDate: string;
};

// ---------------------------------------------------------------------------
// Internal date helpers (UTC-only)

function toUTCDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `d` (UTC). */
function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sunday, 1=Monday, …
  const offset = day === 0 ? 6 : day - 1;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() - offset);
  return m;
}

const SHORT_MONTHS: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortMonth(monthIndex: number): string {
  return SHORT_MONTHS[monthIndex] ?? "";
}

// ---------------------------------------------------------------------------

/**
 * Enumerate all time buckets between `floor` and `today` (both inclusive) for
 * the given grain. Ordered oldest-first so the CoverageRail can scroll right
 * to reach the most-recent bucket.
 *
 * Weeks start on Monday (ISO convention). The current week's `endDate` is
 * clamped to `today`.
 */
export function buildBuckets(grain: Grain, floor: string, today: string): Bucket[] {
  const floorDate = toUTCDate(floor);
  const todayDate = toUTCDate(today);
  const todayYear = todayDate.getUTCFullYear();
  const buckets: Bucket[] = [];

  if (grain === "week") {
    let weekStart = mondayOf(floorDate);

    while (weekStart <= todayDate) {
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
      const effectiveEnd = weekEnd > todayDate ? todayDate : weekEnd;

      const day = weekStart.getUTCDate();
      const monthName = shortMonth(weekStart.getUTCMonth());

      buckets.push({
        key: `w-${toDateStr(weekStart)}`,
        label: `Wk of ${day} ${monthName}`,
        startDate: toDateStr(weekStart),
        endDate: toDateStr(effectiveEnd),
      });

      const next = new Date(weekStart);
      next.setUTCDate(weekStart.getUTCDate() + 7);
      weekStart = next;
    }
  } else if (grain === "month") {
    let year = floorDate.getUTCFullYear();
    let month = floorDate.getUTCMonth(); // 0-indexed
    const todayMonth = todayDate.getUTCMonth();

    while (year < todayYear || (year === todayYear && month <= todayMonth)) {
      const mm = String(month + 1).padStart(2, "0");
      const key = `${year}-${mm}`;
      const monthName = shortMonth(month);
      // Include year in label only when it differs from the current year.
      const label = year === todayYear ? monthName : `${monthName} ${year}`;
      // Last day via overflow: new Date(year, month+1, 0) is last day of month
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

      buckets.push({
        key,
        label,
        startDate: `${year}-${mm}-01`,
        endDate: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
      });

      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }
  } else {
    // year
    let year = floorDate.getUTCFullYear();

    while (year <= todayYear) {
      buckets.push({
        key: String(year),
        label: String(year),
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
      });
      year++;
    }
  }

  return buckets;
}

/**
 * True when the bucket's date range overlaps the [earliestSynced, latestSynced]
 * window. A null boundary means no data synced — always returns false.
 *
 * Overlap test: bucket.startDate ≤ latestSynced AND bucket.endDate ≥ earliestSynced.
 */
export function isCovered(
  bucket: Bucket,
  earliestSynced: string | null,
  latestSynced: string | null,
): boolean {
  if (!earliestSynced || !latestSynced) return false;
  return bucket.startDate <= latestSynced && bucket.endDate >= earliestSynced;
}

/**
 * Derive the {from, to} date span for a contiguous [startIndex, endIndex]
 * selection into the buckets array. Automatically orders lo ≤ hi.
 */
export function spanFromSelection(
  buckets: Bucket[],
  startIndex: number,
  endIndex: number,
): { from: string; to: string } {
  const lo = Math.min(startIndex, endIndex);
  const hi = Math.max(startIndex, endIndex);
  return {
    from: buckets[lo]?.startDate ?? "",
    to: buckets[hi]?.endDate ?? "",
  };
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
