/**
 * The date primitives in `domain/dates.ts` are the arithmetic floor the whole
 * domain stands on — `periods.ts`, `spending-summary.ts`, statement cycles and
 * recurrence all build on `addMonths`/`clampDay`/`daysInMonth`. They had no
 * direct test, and every fixture in the repo is dated 2026, whose calendar is
 * uniquely forgiving (see the `fixture-2026-blind-spot` note): 2026-01-01 is a
 * Thursday and 2026 is not a leap year, so month-end clamping, leap February,
 * century-leap rules and negative/year-boundary offsets are never exercised.
 *
 * Every expected value below was cross-checked against an independent oracle
 * that rolls a UTC `Date` with `setUTCMonth` — a different code path than the
 * modular arithmetic in `addMonths` — so these assertions pin behaviour, not
 * merely restate the implementation.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  clampDay,
  compareDates,
  dateRange,
  daysBetween,
  daysInMonth,
  extractIsoDate,
  formatDate,
  isIsoDate,
  monthKey,
  parseDateParts,
} from "../src/domain/dates";

describe("isIsoDate", () => {
  it("accepts well-formed real dates including a leap day", () => {
    expect(isIsoDate("2026-01-01")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2021-12-31")).toBe(true);
  });

  it("rejects impossible calendar dates that pass the shape check", () => {
    // The regex alone would admit all of these; the round-trip through Date.UTC
    // is what rejects them.
    expect(isIsoDate("2021-02-29")).toBe(false); // 2021 is not a leap year
    expect(isIsoDate("2021-13-01")).toBe(false); // no month 13
    expect(isIsoDate("2021-00-10")).toBe(false); // no month 0
    expect(isIsoDate("2021-04-31")).toBe(false); // April has 30 days
  });

  it("rejects malformed strings", () => {
    expect(isIsoDate("2021-1-1")).toBe(false);
    expect(isIsoDate("2021/01/01")).toBe(false);
    expect(isIsoDate("not-a-date")).toBe(false);
    expect(isIsoDate("2021-06-15T00:00:00Z")).toBe(false);
  });
});

describe("addDays", () => {
  it("moves forward across a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("moves backward across a year boundary", () => {
    expect(addDays("2021-01-01", -1)).toBe("2020-12-31");
  });

  it("crosses a leap-year February correctly", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    // 2023 has no 29th, so the same step lands on March.
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
  });

  it("is the inverse of itself", () => {
    expect(addDays(addDays("2021-06-15", 40), -40)).toBe("2021-06-15");
  });
});

describe("daysBetween", () => {
  it("is zero for the same day and signed by direction", () => {
    expect(daysBetween("2021-06-15", "2021-06-15")).toBe(0);
    expect(daysBetween("2021-06-15", "2021-06-16")).toBe(1);
    expect(daysBetween("2021-06-16", "2021-06-15")).toBe(-1);
  });

  it("counts the extra day across a leap February", () => {
    expect(daysBetween("2024-02-01", "2024-03-01")).toBe(29);
    expect(daysBetween("2023-02-01", "2023-03-01")).toBe(28);
  });
});

describe("daysInMonth / clampDay", () => {
  it("applies the full Gregorian leap rule, not just divisible-by-four", () => {
    expect(daysInMonth(2021, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29); // divisible by 4
    expect(daysInMonth(1900, 2)).toBe(28); // divisible by 100, not 400
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
  });

  it("knows the 30- and 31-day months", () => {
    expect(daysInMonth(2021, 4)).toBe(30);
    expect(daysInMonth(2021, 12)).toBe(31);
  });

  it("clamps an out-of-range day to the month's last day and leaves valid days", () => {
    expect(clampDay(2021, 2, 31)).toBe(28);
    expect(clampDay(2024, 2, 31)).toBe(29);
    expect(clampDay(2021, 4, 31)).toBe(30);
    expect(clampDay(2021, 1, 15)).toBe(15);
  });
});

describe("addMonths", () => {
  it("clamps to the shorter target month rather than overflowing", () => {
    expect(addMonths("2021-01-31", 1)).toBe("2021-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year keeps the 29th
    expect(addMonths("2023-01-31", 1)).toBe("2023-02-28");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonths("2021-12-31", 1)).toBe("2022-01-31");
    expect(addMonths("2021-01-15", -1)).toBe("2020-12-15");
    expect(addMonths("2021-01-31", 13)).toBe("2022-02-28");
  });

  it("handles large negative offsets with correct modular arithmetic", () => {
    expect(addMonths("2021-06-30", -18)).toBe("2019-12-30");
    expect(addMonths("2021-07-15", -30)).toBe("2019-01-15");
  });

  it("clamps a leap day when the target year is not a leap year", () => {
    expect(addMonths("2020-02-29", 12)).toBe("2021-02-28");
  });

  it("honours a preferred day of month, itself clamped to the target", () => {
    expect(addMonths("2021-05-15", 0, 31)).toBe("2021-05-31");
    expect(addMonths("2021-04-10", 0, 31)).toBe("2021-04-30"); // April has no 31st
  });
});

describe("formatDate / parseDateParts", () => {
  it("zero-pads every component", () => {
    expect(formatDate(2021, 1, 5)).toBe("2021-01-05");
    expect(formatDate(999, 12, 31)).toBe("0999-12-31");
  });

  it("round-trips through parseDateParts", () => {
    const { year, month, day } = parseDateParts("2021-07-09");
    expect([year, month, day]).toEqual([2021, 7, 9]);
    expect(formatDate(year, month, day)).toBe("2021-07-09");
  });

  it("throws on a non-ISO input rather than returning garbage", () => {
    expect(() => parseDateParts("2021/07/09")).toThrow(/Invalid ISO date/);
  });
});

describe("compareDates / monthKey / dateRange", () => {
  it("orders lexicographically, which matches chronological order for ISO dates", () => {
    expect(compareDates("2021-01-01", "2021-01-02")).toBeLessThan(0);
    expect(compareDates("2021-02-01", "2021-01-31")).toBeGreaterThan(0);
    expect(compareDates("2021-05-05", "2021-05-05")).toBe(0);
  });

  it("takes the year-month prefix for monthKey", () => {
    expect(monthKey("2021-07-09")).toBe("2021-07");
  });

  it("enumerates an inclusive range spanning a month boundary", () => {
    const range = dateRange("2021-01-30", "2021-02-02");
    expect(range).toEqual(["2021-01-30", "2021-01-31", "2021-02-01", "2021-02-02"]);
  });
});

describe("extractIsoDate", () => {
  it("passes an already-ISO date through untouched", () => {
    expect(extractIsoDate("2021-06-15")).toBe("2021-06-15");
  });

  it("reduces a UTC timestamp to its calendar date", () => {
    expect(extractIsoDate("2021-06-15T08:30:00Z")).toBe("2021-06-15");
  });

  it("takes the literal calendar date from a zoneless timestamp", () => {
    // The old local-parse → UTC-format round trip shifted the day whenever the
    // local wall-clock and UTC fell on different calendar dates: a late-night
    // value rolled forward on hosts west of UTC (23:30 → next day), an early one
    // rolled back on hosts east of UTC (06:00 → previous day). The date is written
    // plainly at the front, so it must survive regardless of host TZ. Run under
    // TZ=America/Los_Angeles and TZ=Asia/Tokyo to exercise both directions.
    expect(extractIsoDate("2021-06-15T23:30:00")).toBe("2021-06-15");
    expect(extractIsoDate("2021-06-15 23:30:00")).toBe("2021-06-15");
    expect(extractIsoDate("2021-06-15T06:00:00")).toBe("2021-06-15");
  });

  it("parses US-style M/D/Y and M-D-Y dates", () => {
    expect(extractIsoDate("06/15/2021")).toBe("2021-06-15");
    expect(extractIsoDate("6/5/2021")).toBe("2021-06-05");
    expect(extractIsoDate("6-15-2021")).toBe("2021-06-15");
  });

  it("parses a long-form human date to its written day", () => {
    expect(extractIsoDate("June 15, 2021")).toBe("2021-06-15");
  });

  it("returns undefined for something unparseable", () => {
    expect(extractIsoDate("definitely not a date")).toBeUndefined();
  });
});
