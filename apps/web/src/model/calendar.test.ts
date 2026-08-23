import { describe, expect, it } from "vitest";
import {
  formatRange,
  isCovered,
  monthGrid,
  presetRanges,
  rangeHasUnsynced,
  seriesKeyToStartDate,
} from "./calendar";

// ---------------------------------------------------------------------------
// monthGrid
// ---------------------------------------------------------------------------
describe("monthGrid", () => {
  // August 2026: Aug 1 is a Saturday, so the first Sun–Sat row is Jul 26–Aug 1.
  it("lays out a month as Sun–Sat rows, each with seven days", () => {
    const rows = monthGrid(2026, 7, "2025-01-01", "2026-08-31");
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toHaveLength(7);
  });

  it("flags spill-over days from the adjacent months", () => {
    const rows = monthGrid(2026, 7, "2025-01-01", "2026-08-31");
    // Row 0 starts on Sunday Jul 26 (previous month); ends on Aug 1 (in month).
    expect(rows[0]?.[0]).toMatchObject({ day: 26, date: "2026-07-26", inMonth: false });
    expect(rows[0]?.[6]).toMatchObject({ day: 1, date: "2026-08-01", inMonth: true });
    // Last row spills into September.
    const last = rows[rows.length - 1];
    expect(last?.[last.length - 1]).toMatchObject({ inMonth: false });
  });

  it("marks days outside [floor, today] as not selectable", () => {
    const rows = monthGrid(2026, 7, "2026-08-05", "2026-08-23");
    const flat = rows.flat();
    const aug4 = flat.find((d) => d.date === "2026-08-04");
    const aug5 = flat.find((d) => d.date === "2026-08-05");
    const aug23 = flat.find((d) => d.date === "2026-08-23");
    const aug24 = flat.find((d) => d.date === "2026-08-24");
    expect(aug4?.selectable).toBe(false); // before floor
    expect(aug5?.selectable).toBe(true); // at floor
    expect(aug23?.selectable).toBe(true); // at today
    expect(aug24?.selectable).toBe(false); // after today
  });

  it("handles February in a leap year", () => {
    const rows = monthGrid(2024, 1, "2024-01-01", "2024-12-31");
    const flat = rows.flat();
    expect(flat.some((d) => d.date === "2024-02-29" && d.inMonth)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCovered
// ---------------------------------------------------------------------------
describe("isCovered", () => {
  const jun = { startDate: "2026-06-01", endDate: "2026-06-30" };

  it("returns true when the range is fully inside the synced window", () => {
    expect(isCovered(jun, "2026-01-01", "2026-12-31")).toBe(true);
  });

  it("returns true when the range partially overlaps at either edge", () => {
    expect(isCovered(jun, "2026-01-01", "2026-06-15")).toBe(true);
    expect(isCovered(jun, "2026-06-15", "2026-12-31")).toBe(true);
  });

  it("works for a single day (same start and end)", () => {
    const day = { startDate: "2026-06-10", endDate: "2026-06-10" };
    expect(isCovered(day, "2026-06-01", "2026-06-30")).toBe(true);
    expect(isCovered(day, "2026-07-01", "2026-07-31")).toBe(false);
  });

  it("returns false when the range is entirely outside the synced window", () => {
    expect(isCovered(jun, "2024-01-01", "2026-05-31")).toBe(false);
  });

  it("returns false when either bound is null", () => {
    expect(isCovered(jun, null, "2026-12-31")).toBe(false);
    expect(isCovered(jun, "2026-01-01", null)).toBe(false);
    expect(isCovered(jun, null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rangeHasUnsynced
// ---------------------------------------------------------------------------
describe("rangeHasUnsynced", () => {
  it("is false when the range sits inside the synced window", () => {
    expect(rangeHasUnsynced("2026-06-05", "2026-06-20", "2026-06-01", "2026-06-30")).toBe(false);
  });

  it("is true when the range reaches before the earliest synced day", () => {
    expect(rangeHasUnsynced("2026-05-01", "2026-06-20", "2026-06-01", "2026-06-30")).toBe(true);
  });

  it("is true when the range reaches past the latest synced day", () => {
    expect(rangeHasUnsynced("2026-06-05", "2026-07-10", "2026-06-01", "2026-06-30")).toBe(true);
  });

  it("is true when nothing has been synced", () => {
    expect(rangeHasUnsynced("2026-06-05", "2026-06-20", null, null)).toBe(true);
  });

  it("is false for an empty range", () => {
    expect(rangeHasUnsynced("", "", "2026-06-01", "2026-06-30")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatRange
// ---------------------------------------------------------------------------
describe("formatRange", () => {
  it("formats a single day", () => {
    expect(formatRange("2026-08-05", "2026-08-05")).toBe("Aug 5, 2026");
  });

  it("formats a same-year range with one trailing year", () => {
    expect(formatRange("2026-06-01", "2026-08-23")).toBe("Jun 1 – Aug 23, 2026");
  });

  it("formats a cross-year range with both years", () => {
    expect(formatRange("2025-12-15", "2026-01-10")).toBe("Dec 15, 2025 – Jan 10, 2026");
  });

  it("returns empty string when a bound is missing", () => {
    expect(formatRange("", "2026-01-10")).toBe("");
    expect(formatRange("2026-01-10", "")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// presetRanges
// ---------------------------------------------------------------------------
describe("presetRanges", () => {
  it("offers 30-day, 90-day, and this-year ranges ending today", () => {
    const presets = presetRanges("2024-08-23", "2026-08-23");
    expect(presets.map((p) => p.label)).toEqual(["Last 30 days", "Last 90 days", "This year"]);
    for (const p of presets) expect(p.to).toBe("2026-08-23");
  });

  it("counts 'Last 30 days' inclusive of today", () => {
    const [last30] = presetRanges("2024-08-23", "2026-08-23");
    expect(last30?.from).toBe("2026-07-25"); // Aug 23 − 29 days
  });

  it("starts 'This year' on Jan 1", () => {
    const thisYear = presetRanges("2024-08-23", "2026-08-23")[2];
    expect(thisYear?.from).toBe("2026-01-01");
  });

  it("clamps a preset start to the floor", () => {
    // Floor is more recent than 90 days back → clamped.
    const [, last90] = presetRanges("2026-08-01", "2026-08-23");
    expect(last90?.from).toBe("2026-08-01");
  });
});

// ---------------------------------------------------------------------------
// seriesKeyToStartDate
// ---------------------------------------------------------------------------
describe("seriesKeyToStartDate", () => {
  it("converts a month key to the first of the month", () => {
    expect(seriesKeyToStartDate("2026-08")).toBe("2026-08-01");
  });

  it("converts a year key to Jan 1", () => {
    expect(seriesKeyToStartDate("2026")).toBe("2026-01-01");
  });

  it("converts an ISO week key to its Monday", () => {
    // 2026-W34: Jan 4 2026 is a Sunday, so week 1's Monday is Dec 29 2025;
    // week 34's Monday = Dec 29 + 33*7 = 2026-08-17.
    expect(seriesKeyToStartDate("2026-W34")).toBe("2026-08-17");
  });

  it("returns null for an unrecognized format", () => {
    expect(seriesKeyToStartDate("not-a-key")).toBeNull();
    expect(seriesKeyToStartDate("2026-08-01")).toBeNull();
  });
});
