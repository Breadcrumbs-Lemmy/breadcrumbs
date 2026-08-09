/**
 * Period bucketing owns all the calendar arithmetic behind the weekly, monthly,
 * yearly, and statement views. The ISO-week cases are the sharp edge: a year
 * whose 1 January is a Friday, Saturday, or Sunday starts its ISO week 1 on the
 * *following* Monday, and an off-by-one there silently mis-buckets a whole year
 * of a user's history. The 2026 fixtures elsewhere never expose it because
 * 2026-01-01 is a Thursday — exactly the kind of fixture-shaped blind spot this
 * suite exists to remove. Expected week numbers were cross-checked against an
 * independent ISO-8601 implementation.
 */
import { describe, expect, it } from "vitest";
import {
  periodForDate,
  periodFromKey,
  statementPeriodForDate,
  recentPeriods,
  containsDate,
  baselineLabel,
} from "../src";

// Far enough ahead that every historical period reads as finished, so partial /
// elapsed are stable and the assertions are about the calendar, not "today".
const SETTLED = "2035-01-01";

describe("periodForDate — weeks (ISO-8601)", () => {
  const weekKey = (date: string) => periodForDate("week", date, SETTLED).key;

  it("numbers weeks correctly when the ISO year starts on a Thursday (2026)", () => {
    expect(weekKey("2026-01-01")).toBe("2026-W01");
    expect(weekKey("2026-12-31")).toBe("2026-W53"); // 2026 is a 53-week ISO year
  });

  it("assigns an early-January date to the previous ISO year's final week", () => {
    // 2027-01-01 is a Friday; ISO puts it in 2026-W53, not 2027-W01.
    expect(weekKey("2027-01-01")).toBe("2026-W53");
  });

  it("numbers weeks correctly when 1 January is a Friday / Saturday / Sunday", () => {
    expect(weekKey("2021-01-04")).toBe("2021-W01"); // Fri-start year, W01 Monday
    expect(weekKey("2021-01-11")).toBe("2021-W02");
    expect(weekKey("2021-06-14")).toBe("2021-W24"); // the offset persists mid-year
    expect(weekKey("2022-01-10")).toBe("2022-W02"); // Sat-start year
    expect(weekKey("2023-01-09")).toBe("2023-W02"); // Sun-start year
  });

  it("spans Monday through Sunday with a human label", () => {
    const week = periodForDate("week", "2026-01-01", SETTLED);
    expect(week).toMatchObject({
      startDate: "2025-12-29",
      endDate: "2026-01-04",
      label: "Week of Dec 29",
      totalDays: 7,
    });
  });
});

describe("periodForDate — months and years", () => {
  it("bounds a 30/31-day month and names it", () => {
    expect(periodForDate("month", "2026-02-15", SETTLED)).toMatchObject({
      key: "2026-02",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      label: "February",
      totalDays: 28,
    });
  });

  it("extends February to the 29th in a leap year", () => {
    expect(periodForDate("month", "2024-02-10", SETTLED).endDate).toBe("2024-02-29");
  });

  it("bounds a full calendar year", () => {
    expect(periodForDate("year", "2026-07-01", SETTLED)).toMatchObject({
      key: "2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      label: "2026",
      totalDays: 365,
    });
  });

  it("treats a period still in progress as partial but its final day as complete", () => {
    const midMonth = periodForDate("month", "2026-08-08", "2026-08-08");
    expect(midMonth).toMatchObject({ partial: true, elapsedDays: 8, totalDays: 31 });

    const lastDay = periodForDate("month", "2026-08-31", "2026-08-31");
    expect(lastDay).toMatchObject({ partial: false, elapsedDays: 31, totalDays: 31 });
  });
});

describe("statementPeriodForDate", () => {
  it("runs from the day after one close to the next close", () => {
    const before = statementPeriodForDate("2026-08-05", 18, SETTLED, "card", "Visa");
    expect(before).toMatchObject({
      key: "card:2026-08-18",
      startDate: "2026-07-19",
      endDate: "2026-08-18",
      label: "Visa · closes Aug 18",
      accountId: "card",
    });

    // A purchase after this month's close belongs to next month's statement.
    const after = statementPeriodForDate("2026-08-25", 18, SETTLED, "card", "Visa");
    expect(after).toMatchObject({ startDate: "2026-08-19", endDate: "2026-09-18" });
  });

  it("clamps a closing day past the month length instead of rolling into the next month", () => {
    const feb = statementPeriodForDate("2026-02-10", 31, SETTLED, "card", "Visa");
    expect(feb).toMatchObject({ startDate: "2026-02-01", endDate: "2026-02-28" });
  });
});

describe("periodFromKey", () => {
  it("round-trips week, month, and year keys", () => {
    for (const key of ["2021-W02", "2022-W02", "2026-W53"]) {
      expect(periodFromKey("week", key, SETTLED)?.key).toBe(key);
    }
    expect(periodFromKey("month", "2026-02", SETTLED)?.key).toBe("2026-02");
    expect(periodFromKey("year", "2026", SETTLED)?.key).toBe("2026");
  });

  it("rejects a malformed key", () => {
    expect(periodFromKey("month", "2026-13-oops", SETTLED)).toBeUndefined();
    expect(periodFromKey("week", "2026-08", SETTLED)).toBeUndefined();
  });
});

describe("recentPeriods / containsDate / baselineLabel", () => {
  it("returns the N most recent periods oldest-first", () => {
    const months = recentPeriods("month", "2026-03-15", 3);
    expect(months.map((p) => p.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("tests date membership inclusively", () => {
    const august = periodForDate("month", "2026-08-01", SETTLED);
    expect(containsDate(august, "2026-08-31")).toBe(true);
    expect(containsDate(august, "2026-09-01")).toBe(false);
  });

  it("phrases a comparison baseline without the UI pluralising", () => {
    expect(baselineLabel("week", 0)).toBe("no earlier data");
    expect(baselineLabel("month", 1)).toBe("the month before");
    expect(baselineLabel("week", 3)).toBe("the last 3 weeks");
    expect(baselineLabel("statement", 2)).toBe("the last 2 statements");
  });
});
