import { describe, expect, it } from "vitest";
import { expandCadence } from "../src/domain/recurrence";

describe("expandCadence", () => {
  it("expands weekly cadences at day-level granularity", () => {
    expect(
      expandCadence(
        { kind: "weekly", intervalWeeks: 1, anchorDate: "2026-08-03" },
        "2026-08-03",
        "2026-08-03",
        "2026-08-24",
      ),
    ).toEqual(["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]);
  });

  it("expands bi-weekly salaried income as a first-class cadence", () => {
    expect(
      expandCadence(
        { kind: "biweekly", anchorDate: "2026-08-07" },
        "2026-08-07",
        "2026-08-03",
        "2026-09-02",
      ),
    ).toEqual(["2026-08-07", "2026-08-21"]);
  });

  it("clamps monthly dates to the last valid day of shorter months", () => {
    expect(
      expandCadence(
        { kind: "monthly", dayOfMonth: 31 },
        "2026-01-31",
        "2026-01-01",
        "2026-03-31",
      ),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("expands semi-monthly obligations", () => {
    expect(
      expandCadence(
        { kind: "semimonthly", daysOfMonth: [1, 15] },
        "2026-08-01",
        "2026-08-03",
        "2026-09-02",
      ),
    ).toEqual(["2026-08-15", "2026-09-01"]);
  });

  it("expands annual events inside the forecast horizon", () => {
    expect(
      expandCadence(
        { kind: "annual", month: 8, dayOfMonth: 23 },
        "2026-08-23",
        "2026-08-03",
        "2026-09-02",
      ),
    ).toEqual(["2026-08-23"]);
  });
});
