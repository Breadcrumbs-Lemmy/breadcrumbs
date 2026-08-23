import { describe, expect, it } from "vitest";
import {
  buildBuckets,
  isCovered,
  seriesKeyToStartDate,
  spanFromSelection,
} from "./calendar";

// ---------------------------------------------------------------------------
// buildBuckets — month grain
// ---------------------------------------------------------------------------
describe("buildBuckets — month", () => {
  it("produces one bucket per calendar month from floor to today inclusive", () => {
    const buckets = buildBuckets("month", "2026-06-15", "2026-08-23");
    expect(buckets.map((b) => b.key)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("labels the current-year month with just the short name", () => {
    const buckets = buildBuckets("month", "2026-06-01", "2026-06-30");
    expect(buckets[0]?.label).toBe("Jun");
  });

  it("labels a past-year month with short name + year", () => {
    const buckets = buildBuckets("month", "2025-11-01", "2026-01-31");
    const nov = buckets.find((b) => b.key === "2025-11");
    expect(nov?.label).toBe("Nov 2025");
  });

  it("sets correct start and end dates for a 31-day month", () => {
    const buckets = buildBuckets("month", "2026-01-01", "2026-01-31");
    expect(buckets[0]?.startDate).toBe("2026-01-01");
    expect(buckets[0]?.endDate).toBe("2026-01-31");
  });

  it("computes the correct end date for February in a non-leap year", () => {
    const buckets = buildBuckets("month", "2026-02-01", "2026-02-28");
    expect(buckets[0]?.endDate).toBe("2026-02-28");
  });

  it("computes the correct end date for February in a leap year", () => {
    const buckets = buildBuckets("month", "2024-02-01", "2024-02-29");
    expect(buckets[0]?.endDate).toBe("2024-02-29");
  });

  it("handles floor mid-month (starts at the given floor month, not floor day)", () => {
    // Floor is mid-June; we still get a June bucket
    const buckets = buildBuckets("month", "2026-06-15", "2026-07-31");
    expect(buckets[0]?.key).toBe("2026-06");
    expect(buckets[0]?.startDate).toBe("2026-06-01");
  });

  it("spans across year boundaries", () => {
    const buckets = buildBuckets("month", "2025-11-01", "2026-02-28");
    expect(buckets.map((b) => b.key)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildBuckets — year grain
// ---------------------------------------------------------------------------
describe("buildBuckets — year", () => {
  it("produces one bucket per calendar year", () => {
    const buckets = buildBuckets("year", "2024-06-01", "2026-08-23");
    expect(buckets.map((b) => b.key)).toEqual(["2024", "2025", "2026"]);
  });

  it("uses year as both key and label", () => {
    const buckets = buildBuckets("year", "2025-01-01", "2025-12-31");
    expect(buckets[0]?.key).toBe("2025");
    expect(buckets[0]?.label).toBe("2025");
  });

  it("sets Jan 1 as startDate and Dec 31 as endDate", () => {
    const buckets = buildBuckets("year", "2025-01-01", "2025-12-31");
    expect(buckets[0]?.startDate).toBe("2025-01-01");
    expect(buckets[0]?.endDate).toBe("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// buildBuckets — week grain
// ---------------------------------------------------------------------------
describe("buildBuckets — week", () => {
  it("starts on the Monday at or before floor (floor is a Wednesday)", () => {
    // 2026-08-19 is a Wednesday; Monday of that week is 2026-08-17
    const buckets = buildBuckets("week", "2026-08-19", "2026-08-23");
    expect(buckets[0]?.startDate).toBe("2026-08-17");
  });

  it("labels weeks as 'Wk of D Mon'", () => {
    const buckets = buildBuckets("week", "2026-08-17", "2026-08-23");
    expect(buckets[0]?.label).toBe("Wk of 17 Aug");
  });

  it("week key includes the Monday date prefixed with w-", () => {
    const buckets = buildBuckets("week", "2026-08-17", "2026-08-23");
    expect(buckets[0]?.key).toBe("w-2026-08-17");
  });

  it("clamps the current week endDate to today", () => {
    // 2026-08-17 is a Monday; today is 2026-08-19 (Wednesday) so the week
    // hasn't finished — endDate should be 2026-08-19, not 2026-08-23.
    const buckets = buildBuckets("week", "2026-08-17", "2026-08-19");
    expect(buckets[0]?.endDate).toBe("2026-08-19");
  });

  it("full week's endDate is Sunday", () => {
    // Floor on Monday 2026-08-17, today is Sunday 2026-08-30 (two weeks later)
    const buckets = buildBuckets("week", "2026-08-17", "2026-08-30");
    expect(buckets[0]?.endDate).toBe("2026-08-23"); // full first week
  });
});

// ---------------------------------------------------------------------------
// isCovered
// ---------------------------------------------------------------------------
describe("isCovered", () => {
  const jun: import("./calendar").Bucket = {
    key: "2026-06",
    label: "Jun",
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  };

  it("returns true when bucket is fully inside the synced range", () => {
    expect(isCovered(jun, "2026-01-01", "2026-12-31")).toBe(true);
  });

  it("returns true when bucket partially overlaps at the end", () => {
    // latestSynced falls inside June
    expect(isCovered(jun, "2026-01-01", "2026-06-15")).toBe(true);
  });

  it("returns true when bucket partially overlaps at the start", () => {
    // earliestSynced falls inside June
    expect(isCovered(jun, "2026-06-15", "2026-12-31")).toBe(true);
  });

  it("returns false when bucket is entirely before earliestSynced", () => {
    const jan2024 = { key: "2024-01", label: "Jan 2024", startDate: "2024-01-01", endDate: "2024-01-31" };
    expect(isCovered(jan2024, "2025-01-01", "2026-12-31")).toBe(false);
  });

  it("returns false when bucket is entirely after latestSynced", () => {
    expect(isCovered(jun, "2024-01-01", "2026-05-31")).toBe(false);
  });

  it("returns false when earliestSynced is null", () => {
    expect(isCovered(jun, null, "2026-12-31")).toBe(false);
  });

  it("returns false when latestSynced is null", () => {
    expect(isCovered(jun, "2026-01-01", null)).toBe(false);
  });

  it("returns false when both bounds are null", () => {
    expect(isCovered(jun, null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spanFromSelection
// ---------------------------------------------------------------------------
describe("spanFromSelection", () => {
  const buckets = buildBuckets("month", "2026-06-01", "2026-08-31");
  // buckets: [2026-06, 2026-07, 2026-08]

  it("returns start of first and end of last bucket for a forward range", () => {
    const { from, to } = spanFromSelection(buckets, 0, 2);
    expect(from).toBe("2026-06-01");
    expect(to).toBe("2026-08-31");
  });

  it("auto-orders when indices are reversed", () => {
    const { from, to } = spanFromSelection(buckets, 2, 0);
    expect(from).toBe("2026-06-01");
    expect(to).toBe("2026-08-31");
  });

  it("returns single bucket bounds for same-index selection", () => {
    const { from, to } = spanFromSelection(buckets, 1, 1);
    expect(from).toBe("2026-07-01");
    expect(to).toBe("2026-07-31");
  });
});

// ---------------------------------------------------------------------------
// seriesKeyToStartDate
// ---------------------------------------------------------------------------
describe("seriesKeyToStartDate", () => {
  it("converts month key to first of month", () => {
    expect(seriesKeyToStartDate("2026-08")).toBe("2026-08-01");
  });

  it("converts year key to Jan 1", () => {
    expect(seriesKeyToStartDate("2026")).toBe("2026-01-01");
  });

  it("converts ISO week key to its Monday", () => {
    // 2026-W34: week 34 of 2026.
    // Jan 4 2026 is a Sunday (day=0). week1Mon = Jan 4 - 6 = Dec 29 2025.
    // Week 34 Monday = Dec 29 + 33*7 = Dec 29 + 231 days = 2026-08-17.
    expect(seriesKeyToStartDate("2026-W34")).toBe("2026-08-17");
  });

  it("returns null for an unrecognized format", () => {
    expect(seriesKeyToStartDate("not-a-key")).toBeNull();
    expect(seriesKeyToStartDate("2026-08-01")).toBeNull();
  });
});
