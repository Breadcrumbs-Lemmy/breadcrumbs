import { describe, expect, it } from "vitest";
import type { DecisionReason, ReasonParameterMap } from "@ai-fin-os/core";
import { reasonCopy, type ReasonContext } from "./reasons";

/**
 * B2 — COVERAGE_INCOMPLETE plural verb agreement.
 *
 * The subject varies with coverageType: "income" / "currency information" are
 * singular, but "bills" and "account balances" are plural. The copy hard-coded
 * the singular verbs, so a real UNKNOWN check rendered "Not all bills through
 * Sep 6 has been confirmed" and "Bills isn't confirmed through Sep 6". The verb
 * must agree with the subject's number.
 */
const ctx: ReasonContext = {
  labelFor: (id) => id,
  relatedEntityIds: [],
  referenceDate: "2026-09-01",
  horizonEndDate: "2026-09-06",
};

function coverageReason(
  coverageType: ReasonParameterMap["COVERAGE_INCOMPLETE"]["coverageType"],
): DecisionReason {
  return {
    code: "COVERAGE_INCOMPLETE",
    severity: "warning",
    level: "UNKNOWN",
    parameters: { coverageType, horizonEndDate: "2026-09-06" },
    relatedEntityIds: [],
    facts: [],
  };
}

describe("COVERAGE_INCOMPLETE verb agreement (B2)", () => {
  it("uses plural verbs for 'bills'", () => {
    const copy = reasonCopy(coverageReason("obligations"), ctx);
    expect(copy.primary).toBe(
      "Not all bills through Sep 6 have been confirmed. Answering now would overstate how much is known.",
    );
    expect(copy.secondary).toBe("Bills aren't confirmed through Sep 6");
  });

  it("uses plural verbs for 'account balances'", () => {
    const copy = reasonCopy(coverageReason("balances"), ctx);
    expect(copy.primary).toBe(
      "Not all account balances through Sep 6 have been confirmed. Answering now would overstate how much is known.",
    );
    expect(copy.secondary).toBe("Account balances aren't confirmed through Sep 6");
  });

  it("keeps singular verbs for 'income'", () => {
    const copy = reasonCopy(coverageReason("income"), ctx);
    expect(copy.primary).toContain("Not all income through Sep 6 has been confirmed.");
    expect(copy.secondary).toBe("Income isn't confirmed through Sep 6");
  });

  it("keeps singular verbs for uncountable 'currency information'", () => {
    const copy = reasonCopy(coverageReason("currency"), ctx);
    expect(copy.primary).toContain("Not all currency information through Sep 6 has been confirmed.");
    expect(copy.secondary).toBe("Currency information isn't confirmed through Sep 6");
  });

  it("keeps singular verbs for the 'some information' fallback (date/unknown)", () => {
    for (const kind of ["date", "unknown"] as const) {
      const copy = reasonCopy(coverageReason(kind), ctx);
      expect(copy.primary).toContain("Not all some information through Sep 6 has been confirmed.");
      expect(copy.secondary).toBe("Some information isn't confirmed through Sep 6");
    }
  });

  it("never pairs a plural subject with a singular verb", () => {
    // The exact B2 regression: guard every coverageType at once.
    const plural = new Set(["obligations", "balances"]);
    for (const kind of ["income", "obligations", "balances", "currency", "date", "unknown"] as const) {
      const copy = reasonCopy(coverageReason(kind), ctx);
      if (plural.has(kind)) {
        expect(copy.primary).toContain("have been confirmed");
        expect(copy.secondary).toContain("aren't confirmed");
      } else {
        expect(copy.primary).toContain("has been confirmed");
        expect(copy.secondary).toContain("isn't confirmed");
      }
    }
  });
});
