/**
 * `buildSavingsGoal` shapes a user's declared savings target into the canonical
 * `Goal` the affordability engine already consumes; `evaluateGoals` reports
 * progress and pace against a goal set. These tests drive both through their real
 * signatures — no hand-built canonical `Goal` except where a test deliberately
 * exercises a non-default cadence — so the contract under test is production's.
 *
 * All dates are 2022, never 2026 (`CD-012`): pace walks a real calendar
 * (`addMonths` across year and month-length boundaries), so the month arithmetic
 * must be exercised on real months, not the app's forgiving 2026 fixtures.
 *
 * The load-bearing rule is `D-G4`: status is a factual statement about the user's
 * *own declared plan* — `reached` when saved ≥ target, else on-pace vs behind
 * against the deadline (or, with no deadline, simply whether it's being funded).
 */
import { describe, expect, it } from "vitest";

import { buildSavingsGoal, buildSavingsGoals, evaluateGoals } from "../src";
import type { Goal, SavingsGoalInput } from "../src";

const ASOF = "2022-07-20";
const OPTS = { asOfDate: ASOF, currency: "usd" as const };

function input(over: Partial<SavingsGoalInput> & Pick<SavingsGoalInput, "label" | "targetAmountCents">): SavingsGoalInput {
  return { ...over };
}

describe("buildSavingsGoal — shaping a declaration into a canonical Goal", () => {
  it("fills the canonical shape deterministically from a minimal input", () => {
    const goal = buildSavingsGoal(input({ label: "Emergency fund", targetAmountCents: 500_000 }), OPTS);
    expect(goal).toMatchObject({
      id: "goal_emergency-fund",
      label: "Emergency fund",
      goalType: "monthly_savings_target",
      targetAmountCents: 500_000,
      currentAmountCents: 0,
      monthlyContributionCents: 0,
      // The 1st of the month strictly after asOf (2022-07-20 → 2022-08-01).
      nextContributionDate: "2022-08-01",
      contributionCadence: { kind: "monthly", dayOfMonth: 1 },
      priority: "medium",
      protection: "flexible",
      active: true,
      source: "manual",
      currency: "USD", // uppercased
    });
    expect(goal.freshness).toMatchObject({ status: "usable", source: "manual", asOf: ASOF });
    expect(goal.uncertainty).toMatchObject({ confidence: 1, isEstimated: false });
    // Absent optionals stay off the object entirely (no invented `undefined` keys).
    expect("targetDate" in goal).toBe(false);
    expect("category" in goal).toBe(false);
  });

  it("honours explicit priority, protection, category, targetDate and id", () => {
    const goal = buildSavingsGoal(
      input({
        id: "goal_custom",
        label: "House down-payment",
        targetAmountCents: 4_000_000,
        currentAmountCents: 1_000_000,
        monthlyContributionCents: 150_000,
        targetDate: "2024-06-01",
        priority: "high",
        protection: "protected",
        category: "housing",
      }),
      OPTS,
    );
    expect(goal).toMatchObject({
      id: "goal_custom",
      priority: "high",
      protection: "protected",
      category: "housing",
      targetDate: "2024-06-01",
      currentAmountCents: 1_000_000,
      monthlyContributionCents: 150_000,
    });
  });

  it("coerces non-integer and negative amounts to non-negative integers", () => {
    const goal = buildSavingsGoal(
      input({
        label: "Rounding",
        targetAmountCents: 100_000.7,
        currentAmountCents: -50, // negative → 0
        monthlyContributionCents: 249.5, // → 250 (round-half-up)
      }),
      OPTS,
    );
    expect(goal.targetAmountCents).toBe(100_001);
    expect(goal.currentAmountCents).toBe(0);
    expect(goal.monthlyContributionCents).toBe(250);
  });

  it("slugs a messy label into a stable id", () => {
    expect(buildSavingsGoal(input({ label: "  New Car! 2024  ", targetAmountCents: 1 }), OPTS).id).toBe("goal_new-car-2024");
    // A label with no slug-able characters falls back rather than producing `goal_`.
    expect(buildSavingsGoal(input({ label: "★★★", targetAmountCents: 1 }), OPTS).id).toBe("goal_goal");
  });

  it("rolls the next contribution into the next year across a December asOf", () => {
    const goal = buildSavingsGoal(input({ label: "Year end", targetAmountCents: 1 }), { asOfDate: "2022-12-15", currency: "USD" });
    expect(goal.nextContributionDate).toBe("2023-01-01");
  });
});

describe("buildSavingsGoals — a whole set with unique ids", () => {
  it("suffixes later id collisions deterministically, in input order", () => {
    const goals = buildSavingsGoals(
      [
        input({ label: "Emergency fund", targetAmountCents: 500_000 }),
        input({ label: "Emergency Fund", targetAmountCents: 300_000 }), // same slug
        input({ label: "Emergency fund", targetAmountCents: 100_000 }), // same slug again
        input({ label: "Vacation", targetAmountCents: 200_000 }),
      ],
      OPTS,
    );
    expect(goals.map((g) => g.id)).toEqual([
      "goal_emergency-fund",
      "goal_emergency-fund_2",
      "goal_emergency-fund_3",
      "goal_vacation",
    ]);
  });
});

describe("evaluateGoals — progress, status and pace (D-G4)", () => {
  it("marks a goal reached when saved meets or exceeds the target, capping the bar", () => {
    const goal = buildSavingsGoal(
      input({ label: "Done", targetAmountCents: 100_000, currentAmountCents: 150_000, monthlyContributionCents: 20_000 }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({
      status: "reached",
      savedCents: 150_000,
      remainingCents: 0,
      progressBasisPoints: 10_000, // capped, never past a full bar
    });
    expect(line!.projection).toBeUndefined(); // a met goal projects nothing
  });

  it("treats a non-positive target as already reached (nothing to save)", () => {
    const goal = buildSavingsGoal(input({ label: "Zero", targetAmountCents: 0 }), OPTS);
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({ status: "reached", progressBasisPoints: 10_000, remainingCents: 0 });
  });

  it("projects completion for a funded, unmet goal with no deadline → on_track", () => {
    // $600 remaining at $200/mo = 3 contributions. First lands 2022-08-01, the
    // third (completion) two months later.
    const goal = buildSavingsGoal(
      input({ label: "Cushion", targetAmountCents: 100_000, currentAmountCents: 40_000, monthlyContributionCents: 20_000 }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({
      status: "on_track",
      remainingCents: 60_000,
      progressBasisPoints: 4_000, // 40000/100000
    });
    expect(line!.projection).toEqual({
      monthsToClose: 3,
      projectedCompletionDate: "2022-10-01",
      onPace: true, // no deadline to miss
    });
  });

  it("rounds a fractional final month up (ceil), never down", () => {
    // $1000 remaining at $300/mo → 3.33 → 4 contributions; completion 3 months
    // past the first (2022-08-01 + 3 = 2022-11-01).
    const goal = buildSavingsGoal(
      input({ label: "Ceil", targetAmountCents: 100_000, currentAmountCents: 0, monthlyContributionCents: 30_000 }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line!.projection).toMatchObject({ monthsToClose: 4, projectedCompletionDate: "2022-11-01" });
  });

  it("is on_track when the projected completion lands on or before the deadline", () => {
    // 3 contributions → completion 2022-10-01; deadline exactly there → on_track
    // (the boundary is inclusive).
    const goal = buildSavingsGoal(
      input({
        label: "Deadline met",
        targetAmountCents: 100_000,
        currentAmountCents: 40_000,
        monthlyContributionCents: 20_000,
        targetDate: "2022-10-01",
      }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({ status: "on_track" });
    expect(line!.projection).toMatchObject({ projectedCompletionDate: "2022-10-01", onPace: true });
  });

  it("is behind when the pace overshoots the deadline", () => {
    // $1200 at $100/mo = 12 contributions → completion 2023-07-01, past a
    // 2023-01-01 deadline.
    const goal = buildSavingsGoal(
      input({
        label: "Too slow",
        targetAmountCents: 120_000,
        currentAmountCents: 0,
        monthlyContributionCents: 10_000,
        targetDate: "2023-01-01",
      }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({ status: "behind" });
    expect(line!.projection).toMatchObject({ monthsToClose: 12, projectedCompletionDate: "2023-07-01", onPace: false });
  });

  it("is behind — and projects nothing — for an unmet goal with no funding", () => {
    // A target you never fund is not on track (D-G4), and no pace can be drawn.
    const goal = buildSavingsGoal(
      input({ label: "Unfunded", targetAmountCents: 100_000, currentAmountCents: 10_000, monthlyContributionCents: 0 }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line).toMatchObject({ status: "behind", progressBasisPoints: 1_000 });
    expect(line!.projection).toBeUndefined();
  });

  it("floors progress at 0 for a goal with nothing saved", () => {
    const goal = buildSavingsGoal(
      input({ label: "Fresh", targetAmountCents: 100_000, currentAmountCents: 0, monthlyContributionCents: 5_000 }),
      OPTS,
    );
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line!.progressBasisPoints).toBe(0);
  });
});

describe("evaluateGoals — rollup and ordering", () => {
  it("returns an empty, zeroed rollup for no goals", () => {
    const result = evaluateGoals({ goals: [], asOfDate: ASOF, currency: "usd" });
    expect(result).toMatchObject({
      asOfDate: ASOF,
      currency: "USD", // uppercased
      goals: [],
      totalTargetCents: 0,
      totalSavedCents: 0,
      totalRemainingCents: 0,
      reachedCount: 0,
      onTrackCount: 0,
      behindCount: 0,
    });
  });

  it("sorts worst-first and rolls up totals and counts", () => {
    const behind = buildSavingsGoal(
      input({ label: "Behind", targetAmountCents: 100_000, currentAmountCents: 10_000, monthlyContributionCents: 0 }),
      OPTS,
    );
    const onTrack = buildSavingsGoal(
      input({ label: "On track", targetAmountCents: 100_000, currentAmountCents: 40_000, monthlyContributionCents: 20_000 }),
      OPTS,
    );
    const reached = buildSavingsGoal(
      input({ label: "Reached", targetAmountCents: 50_000, currentAmountCents: 60_000, monthlyContributionCents: 0 }),
      OPTS,
    );

    // Deliberately pass them out of final order; the sort must impose it.
    const result = evaluateGoals({ goals: [reached, onTrack, behind], asOfDate: ASOF, currency: "USD" });
    expect(result.goals.map((g) => g.status)).toEqual(["behind", "on_track", "reached"]);
    expect(result).toMatchObject({
      totalTargetCents: 250_000, // 100000 + 100000 + 50000
      totalSavedCents: 110_000, // 10000 + 40000 + 60000
      totalRemainingCents: 150_000, // 90000 + 60000 + 0
      behindCount: 1,
      onTrackCount: 1,
      reachedCount: 1,
    });
  });

  it("breaks a status+progress tie by id, ascending", () => {
    // Two unfunded goals, both 0% → both behind at equal progress; the tie must
    // resolve by id (alphabetical), not by input order.
    const bravo = buildSavingsGoal(input({ label: "Bravo", targetAmountCents: 100_000 }), OPTS);
    const alpha = buildSavingsGoal(input({ label: "Alpha", targetAmountCents: 100_000 }), OPTS);
    const result = evaluateGoals({ goals: [bravo, alpha], asOfDate: ASOF, currency: "USD" });
    expect(result.goals.map((g) => g.id)).toEqual(["goal_alpha", "goal_bravo"]);
  });
});

describe("evaluateGoals — pace anchor for a non-first-of-month cadence", () => {
  it("falls back to the first of next month after asOf when the cadence isn't monthly-on-the-1st", () => {
    // A hand-built goal whose cadence is monthly on the 15th (not the canonical
    // 1st). Pace can't trust `nextContributionDate` as a 1st-of-month anchor, so
    // it re-anchors on the first of the month after asOf (2022-07-20 → 2022-08-01)
    // and walks monthsToClose − 1 forward. $600 at $200/mo = 3 → 2022-10-01.
    const goal: Goal = {
      id: "goal_biweekly_like",
      label: "Odd cadence",
      goalType: "monthly_savings_target",
      targetAmountCents: 100_000,
      currentAmountCents: 40_000,
      monthlyContributionCents: 20_000,
      nextContributionDate: "2022-08-15",
      contributionCadence: { kind: "monthly", dayOfMonth: 15 },
      priority: "medium",
      protection: "flexible",
      active: true,
      freshness: { status: "usable", source: "manual", warnings: [] },
      uncertainty: { confidence: 1, isEstimated: false },
      source: "manual",
      currency: "USD",
    };
    const [line] = evaluateGoals({ goals: [goal], asOfDate: ASOF, currency: "USD" }).goals;
    expect(line!.projection).toMatchObject({ monthsToClose: 3, projectedCompletionDate: "2022-10-01" });
  });
});
