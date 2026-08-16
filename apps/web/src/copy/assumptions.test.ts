import { describe, expect, it } from "vitest";
import type { Assumption } from "@ai-fin-os/core";
import { dedupeAssumptionsByCode } from "./index";

function assumption(code: Assumption["code"], entityId: string): Assumption {
  return {
    code,
    severity: "info",
    message: `${code} for ${entityId}`,
    relatedEntityIds: [entityId],
  };
}

describe("dedupeAssumptionsByCode (B1)", () => {
  it("collapses repeated codes to a single entry", () => {
    // The real bug: one AVAILABLE_BALANCE_MISSING per account with no available
    // balance. The seed produced three; the panel rendered three identical rows
    // with the same React key.
    const input: Assumption[] = [
      assumption("AVAILABLE_BALANCE_MISSING", "acct_1"),
      assumption("AVAILABLE_BALANCE_MISSING", "acct_2"),
      assumption("AVAILABLE_BALANCE_MISSING", "acct_3"),
    ];

    const deduped = dedupeAssumptionsByCode(input);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.code).toBe("AVAILABLE_BALANCE_MISSING");
  });

  it("keeps distinct codes and preserves first-seen order", () => {
    const input: Assumption[] = [
      assumption("CONSERVATIVE_SAME_DAY_ORDERING_APPLIED", "x"),
      assumption("AVAILABLE_BALANCE_MISSING", "acct_1"),
      assumption("AVAILABLE_BALANCE_MISSING", "acct_2"),
      assumption("CONSERVATIVE_INCOME_MINIMUM_USED", "y"),
    ];

    const deduped = dedupeAssumptionsByCode(input);

    expect(deduped.map((a) => a.code)).toEqual([
      "CONSERVATIVE_SAME_DAY_ORDERING_APPLIED",
      "AVAILABLE_BALANCE_MISSING",
      "CONSERVATIVE_INCOME_MINIMUM_USED",
    ]);
  });

  it("keeps the first occurrence of a duplicated code", () => {
    const first = assumption("AVAILABLE_BALANCE_MISSING", "acct_1");
    const second = assumption("AVAILABLE_BALANCE_MISSING", "acct_2");

    const deduped = dedupeAssumptionsByCode([first, second]);

    expect(deduped[0]).toBe(first);
  });

  it("yields React-unique keys (no repeated code)", () => {
    const input: Assumption[] = [
      assumption("AVAILABLE_BALANCE_MISSING", "acct_1"),
      assumption("AVAILABLE_BALANCE_MISSING", "acct_2"),
      assumption("CONSERVATIVE_SAME_DAY_ORDERING_APPLIED", "x"),
    ];

    const codes = dedupeAssumptionsByCode(input).map((a) => a.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeAssumptionsByCode([])).toEqual([]);
  });
});
