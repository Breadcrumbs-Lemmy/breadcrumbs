import { describe, expect, it } from "vitest";
import { formatDate, formatRelativeAge, UNAVAILABLE } from "./dates";

describe("formatDate", () => {
  it("shows month and day without a year when the year matches the reference", () => {
    expect(formatDate("2023-03-14", "2023-11-02")).toBe("Mar 14");
  });

  it("shows the year when the date's year differs from the reference (B14)", () => {
    // A date-group header dated against the newest posted date must surface the
    // year for older years, so a multi-year list isn't a wall of bare "Mar 14".
    expect(formatDate("2022-03-14", "2023-11-02")).toBe("Mar 14, 2022");
    expect(formatDate("2021-12-31", "2023-01-01")).toBe("Dec 31, 2021");
  });

  it("never shows a year when a date is dated against ITSELF (the old B14 bug)", () => {
    // This is precisely why the header dropped the year: reference === date, so
    // the years always matched. Kept as a characterization of the trap.
    expect(formatDate("2022-03-14", "2022-03-14")).toBe("Mar 14");
  });

  it("omits the year when no reference is given", () => {
    expect(formatDate("2022-03-14")).toBe("Mar 14");
  });

  it("keeps the calendar date stable regardless of viewer timezone", () => {
    // Parsed as a UTC calendar date, so it never slips a day.
    expect(formatDate("2023-01-01", "2023-06-01")).toBe("Jan 1");
  });

  it("returns the unavailable dash for missing or malformed input", () => {
    expect(formatDate(null)).toBe(UNAVAILABLE);
    expect(formatDate(undefined)).toBe(UNAVAILABLE);
    expect(formatDate("not-a-date")).toBe(UNAVAILABLE);
  });
});

describe("formatRelativeAge", () => {
  it("renders sub-day and multi-day ages", () => {
    expect(formatRelativeAge("2023-03-14", 0.5)).toBe("less than an hour ago");
    expect(formatRelativeAge("2023-03-14", 1)).toBe("1 hour ago");
    expect(formatRelativeAge("2023-03-14", 5)).toBe("5 hours ago");
    expect(formatRelativeAge("2023-03-14", 48)).toBe("2 days ago");
  });

  it("falls back to an absolute date beyond 30 days", () => {
    expect(formatRelativeAge("2023-03-14T00:00:00Z", 24 * 40)).toBe("Mar 14");
  });
});
