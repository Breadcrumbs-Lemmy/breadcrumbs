import { describe, expect, it } from "vitest";
import type { Budget } from "@ai-fin-os/core";
import { nothingToBudget, type CategoryOption } from "./budgets";
import type { BudgetConfig } from "./api";

/** A budget config with the given caps; overall caps default to none. */
function config(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    currency: "USD",
    overallLimitCents: null,
    overallWeeklyLimitCents: null,
    budgets: [],
    ...overrides,
  };
}

function cap(category: string, period?: "week"): Budget {
  return period ? { category, limitCents: 20000, period } : { category, limitCents: 20000 };
}

function category(id: string): CategoryOption {
  return { category: id, displayName: id, outflowCents: 5000 };
}

describe("nothingToBudget (B3)", () => {
  it("is a blank slate only when no caps exist anywhere and this window has no spend", () => {
    expect(nothingToBudget({ config: config(), categories: [] })).toBe(true);
  });

  it("is NOT a blank slate for a spend-free week when monthly caps exist (the B3 repro)", () => {
    // Week view: no weekly caps, no weekly spend — but the user clearly has data.
    expect(
      nothingToBudget({ config: config({ budgets: [cap("groceries")] }), categories: [] }),
    ).toBe(false);
  });

  it("is NOT a blank slate when weekly caps exist but this window has no spend", () => {
    expect(
      nothingToBudget({ config: config({ budgets: [cap("dining", "week")] }), categories: [] }),
    ).toBe(false);
  });

  it("is NOT a blank slate when only an overall monthly cap is set", () => {
    expect(nothingToBudget({ config: config({ overallLimitCents: 300000 }), categories: [] })).toBe(
      false,
    );
  });

  it("is NOT a blank slate when only an overall weekly cap is set", () => {
    expect(
      nothingToBudget({ config: config({ overallWeeklyLimitCents: 75000 }), categories: [] }),
    ).toBe(false);
  });

  it("is NOT a blank slate when this window has spend categories, even with no caps", () => {
    expect(nothingToBudget({ config: config(), categories: [category("groceries")] })).toBe(false);
  });

  it("is NOT a blank slate when both caps and spend are present", () => {
    expect(
      nothingToBudget({
        config: config({ budgets: [cap("groceries")] }),
        categories: [category("groceries")],
      }),
    ).toBe(false);
  });
});
