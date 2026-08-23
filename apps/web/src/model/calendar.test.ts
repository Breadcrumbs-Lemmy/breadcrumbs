import { describe, expect, it } from "vitest";
import {
  defaultCellIndex,
  isCovered,
  monthCells,
  seriesKeyToStartDate,
  spanFromCells,
  weekRows,
  yearCells,
  type Cell,
} from "./calendar";

// ---------------------------------------------------------------------------
// yearCells
// ---------------------------------------------------------------------------
describe("yearCells", () => {
  it("produces one cell per year from floor to today inclusive", () => {
    const cells = yearCells("2024-06-01", "2026-08-23");
    expect(cells.map((c) => c.key)).toEqual(["2024", "2025", "2026"]);
  });

  it("uses the year as both key and label and is always selectable", () => {
    const cells = yearCells("2025-01-01", "2025-12-31");
    expect(cells[0]?.key).toBe("2025");
    expect(cells[0]?.label).toBe("2025");
    expect(cells[0]?.selectable).toBe(true);
  });

  it("clamps the floor year's start and the current year's end", () => {
    const cells = yearCells("2024-06-15", "2026-08-23");
    expect(cells[0]?.startDate).toBe("2024-06-15"); // clamped to floor
    expect(cells[0]?.endDate).toBe("2024-12-31");
    expect(cells[2]?.startDate).toBe("2026-01-01");
    expect(cells[2]?.endDate).toBe("2026-08-23"); // clamped to today
  });
});

// ---------------------------------------------------------------------------
// monthCells
// ---------------------------------------------------------------------------
describe("monthCells", () => {
  it("always returns 12 cells for the year", () => {
    const cells = monthCells(2026, "2025-01-01", "2026-08-23");
    expect(cells).toHaveLength(12);
    expect(cells.map((c) => c.label)).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
  });

  it("marks months outside [floor, today] as not selectable", () => {
    const cells = monthCells(2026, "2026-06-15", "2026-08-23");
    // Jan–May are before the floor month; Sep–Dec are in the future.
    expect(cells[0]?.selectable).toBe(false); // Jan
    expect(cells[4]?.selectable).toBe(false); // May
    expect(cells[5]?.selectable).toBe(true); // Jun
    expect(cells[7]?.selectable).toBe(true); // Aug
    expect(cells[8]?.selectable).toBe(false); // Sep (future)
  });

  it("clamps the floor month's start and today's month end", () => {
    const cells = monthCells(2026, "2026-06-15", "2026-08-23");
    expect(cells[5]?.startDate).toBe("2026-06-15"); // Jun clamped to floor
    expect(cells[5]?.endDate).toBe("2026-06-30");
    expect(cells[7]?.startDate).toBe("2026-08-01");
    expect(cells[7]?.endDate).toBe("2026-08-23"); // Aug clamped to today
  });

  it("computes February end dates correctly (leap and non-leap)", () => {
    expect(monthCells(2026, "2026-01-01", "2026-12-31")[1]?.endDate).toBe("2026-02-28");
    expect(monthCells(2024, "2024-01-01", "2024-12-31")[1]?.endDate).toBe("2024-02-29");
  });
});

// ---------------------------------------------------------------------------
// weekRows
// ---------------------------------------------------------------------------
describe("weekRows", () => {
  // August 2026: Aug 1 is a Saturday, so the first Sun–Sat row is Jul 26–Aug 1.
  it("lays out a month as Sun–Sat rows, each with seven days", () => {
    const rows = weekRows(2026, 7, "2025-01-01", "2026-08-31");
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.days).toHaveLength(7);
  });

  it("labels rows by their in-month day numbers", () => {
    const rows = weekRows(2026, 7, "2025-01-01", "2026-08-31");
    expect(rows.map((r) => r.label)).toEqual(["1", "2–8", "9–15", "16–22", "23–29", "30–31"]);
  });

  it("clamps each row's window to the focused month", () => {
    const rows = weekRows(2026, 7, "2025-01-01", "2026-08-31");
    // First row spills into July but its window is clamped to Aug 1 only.
    expect(rows[0]?.startDate).toBe("2026-08-01");
    expect(rows[0]?.endDate).toBe("2026-08-01");
    expect(rows[1]?.startDate).toBe("2026-08-02");
    expect(rows[1]?.endDate).toBe("2026-08-08");
  });

  it("flags spill-over days from the adjacent month", () => {
    const rows = weekRows(2026, 7, "2025-01-01", "2026-08-31");
    // Row 0 starts on Sunday Jul 26 (previous month).
    expect(rows[0]?.days[0]).toMatchObject({ day: 26, date: "2026-07-26", inMonth: false });
    expect(rows[0]?.days[6]).toMatchObject({ day: 1, date: "2026-08-01", inMonth: true });
  });

  it("clamps and disables rows relative to today", () => {
    // Today is Aug 23 (a Sunday). The Aug 23–29 row is clamped to Aug 23 and
    // still selectable; the Aug 30–31 row is entirely in the future.
    const rows = weekRows(2026, 7, "2025-01-01", "2026-08-23");
    expect(rows[4]?.endDate).toBe("2026-08-23");
    expect(rows[4]?.selectable).toBe(true);
    expect(rows[5]?.selectable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCovered
// ---------------------------------------------------------------------------
describe("isCovered", () => {
  const jun = { startDate: "2026-06-01", endDate: "2026-06-30" };

  it("returns true when the cell is fully inside the synced range", () => {
    expect(isCovered(jun, "2026-01-01", "2026-12-31")).toBe(true);
  });

  it("returns true when the cell partially overlaps at either edge", () => {
    expect(isCovered(jun, "2026-01-01", "2026-06-15")).toBe(true);
    expect(isCovered(jun, "2026-06-15", "2026-12-31")).toBe(true);
  });

  it("returns false when the cell is entirely outside the synced range", () => {
    expect(isCovered(jun, "2024-01-01", "2026-05-31")).toBe(false);
    expect(isCovered({ startDate: "2024-01-01", endDate: "2024-01-31" }, "2025-01-01", "2026-12-31")).toBe(false);
  });

  it("returns false when either bound is null", () => {
    expect(isCovered(jun, null, "2026-12-31")).toBe(false);
    expect(isCovered(jun, "2026-01-01", null)).toBe(false);
    expect(isCovered(jun, null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spanFromCells
// ---------------------------------------------------------------------------
describe("spanFromCells", () => {
  // Jun–Aug 2026, all selectable.
  const cells = monthCells(2026, "2026-01-01", "2026-08-31").slice(5, 8);

  it("returns start of first and end of last cell for a forward range", () => {
    const { from, to } = spanFromCells(cells, 0, 2);
    expect(from).toBe("2026-06-01");
    expect(to).toBe("2026-08-31");
  });

  it("auto-orders when indices are reversed", () => {
    const { from, to } = spanFromCells(cells, 2, 0);
    expect(from).toBe("2026-06-01");
    expect(to).toBe("2026-08-31");
  });

  it("returns single-cell bounds for a same-index selection", () => {
    const { from, to } = spanFromCells(cells, 1, 1);
    expect(from).toBe("2026-07-01");
    expect(to).toBe("2026-07-31");
  });
});

// ---------------------------------------------------------------------------
// defaultCellIndex
// ---------------------------------------------------------------------------
describe("defaultCellIndex", () => {
  const cells = monthCells(2026, "2025-01-01", "2026-08-23"); // Jan–Aug selectable

  it("picks the most recent covered, selectable cell", () => {
    // Synced Jun–Jul → the last covered month is Jul (index 6).
    expect(defaultCellIndex(cells, "2026-06-01", "2026-07-31")).toBe(6);
  });

  it("falls back to the most recent selectable cell when nothing is covered", () => {
    // No sync → most recent selectable month is Aug (index 7).
    expect(defaultCellIndex(cells, null, null)).toBe(7);
  });

  it("returns -1 for an empty grid", () => {
    expect(defaultCellIndex([] as Cell[], null, null)).toBe(-1);
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
