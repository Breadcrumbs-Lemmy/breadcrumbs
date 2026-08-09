import { describe, expect, it } from "vitest";
import affordableFixture from "../fixtures/mvp0/affordable-steady-paycheck.json";
import baselineAlreadyTightFixture from "../fixtures/mvp0/baseline-already-tight.json";
import coverageIncompleteFixture from "../fixtures/mvp0/coverage-incomplete.json";
import monthlySavingsPurchasesFixture from "../fixtures/mvp0/monthly-savings-discretionary-purchases.json";
import optionalObligationTradeoffFixture from "../fixtures/mvp0/optional-obligation-tradeoff.json";
import variableIncomeNotGuaranteedFixture from "../fixtures/mvp0/variable-income-not-guaranteed.json";
import { AffordabilityRequestValidationError, evaluateAffordability } from "../src";
import type { AffordabilityLevel, AffordabilityRequest, ProductBoundary, ReasonCode } from "../src";

const baseInput = affordableFixture.input as AffordabilityRequest;
const monthlySavingsPurchasesInput = monthlySavingsPurchasesFixture.input as AffordabilityRequest;
const h010Fixtures = [
  optionalObligationTradeoffFixture,
  baselineAlreadyTightFixture,
  variableIncomeNotGuaranteedFixture,
  coverageIncompleteFixture,
] as H010ReasonFixture[];

type H010ReasonFixture = {
  id: string;
  input: AffordabilityRequest;
  expected: {
    level: AffordabilityLevel;
    reasonCodes: ReasonCode[];
    targetReasonCode: ReasonCode;
    targetReasonParameters: Record<string, unknown>;
    targetRelatedEntityIds: string[];
    requiredPathMinimumBalanceCents: number;
    requiredPathMinimumBalanceDate: string;
    protectedPathMinimumBalanceCents: number;
    protectedPathMinimumBalanceDate: string;
    allEventsPathMinimumBalanceCents: number;
    allEventsPathMinimumBalanceDate: string;
    expectedReferencePathMinimumBalanceCents?: number;
    expectedReferencePathMinimumBalanceDate?: string;
    postPurchaseCashCents: number;
    timingReserveCents: number;
    timingReserveMarginCents: number;
    purchaseImpactOnMinimumCents: number;
    boundaries: ProductBoundary[];
  };
};

describe("evaluateAffordability", () => {
  it("matches the seeded affordable steady-paycheck fixture", () => {
    const response = evaluateAffordability(baseInput);

    expect(response.level).toBe(affordableFixture.expected.level);
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(
      affordableFixture.expected.reasonCodes,
    );
    expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(
      affordableFixture.expected.requiredPathMinimumBalanceCents,
    );
    expect(response.metrics.protectedPath.minimumIntradayBalanceCents).toBe(
      affordableFixture.expected.protectedPathMinimumBalanceCents,
    );
    expect(response.metrics.allEventsPath.minimumIntradayBalanceCents).toBe(
      affordableFixture.expected.allEventsPathMinimumBalanceCents,
    );
    expect(response.metrics.requiredPath.minimumIntradayBalanceDate).toBe(
      affordableFixture.expected.minimumBalanceDate,
    );
    expect(response.metrics.postPurchaseCashCents).toBe(affordableFixture.expected.postPurchaseCashCents);
    expect(response.metrics.timingReserveCents).toBe(affordableFixture.expected.timingReserveCents);
    expect(response.metrics.timingReserveMarginCents).toBe(
      affordableFixture.expected.timingReserveMarginCents,
    );
    expect(response.explanation.reasons[0]).toMatchObject({
      code: "BUFFER_PASSED",
      parameters: {
        requiredBufferMarginCents: 55_000,
        minimumCashBufferCents: 25_000,
        minimumBalanceDate: "2026-08-15",
      },
    });
    expect(response.explanation.reasons[1]).toMatchObject({
      code: "TIMING_RESERVE_PASSED",
      parameters: {
        postPurchaseCashCents: 215_000,
        timingReserveCents: 135_000,
        timingReserveMarginCents: 55_000,
        timingReserveWindowEndDate: "2026-08-17",
        nextReliableIncomeDate: "2026-08-17",
        minimumCashBufferCents: 25_000,
      },
    });
    expect(response.explanation.boundaries).toEqual([
      "READ_ONLY_DECISION_SUPPORT",
      "NOT_PERSONALIZED_FINANCIAL_ADVICE",
      "NO_ACCOUNT_WRITES",
      "DETERMINISTIC_CALCULATION",
    ]);
  });

  it("returns TIGHT when obligations are covered but the cash buffer is breached", () => {
    const input = withScenario({
      currentBalanceCents: 95_000,
      purchaseAmountCents: 30_000,
      purchaseDate: "2026-08-03",
      incomeAmountCents: 90_000,
      incomeNextDate: "2026-08-10",
      obligations: [
        { id: "obligation_rent", label: "Rent", amountCents: 50_000, date: "2026-08-05" },
        { id: "obligation_groceries", label: "Groceries reserve", amountCents: 10_000, date: "2026-08-07" },
      ],
      goals: [],
    });

    const response = evaluateAffordability(input);

    expect(response.level).toBe("TIGHT");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual([
      "BUFFER_BELOW_MINIMUM",
      "TIMING_RESERVE_LOW",
    ]);
    expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(5_000);
    expect(response.metrics.timingReserveMarginCents).toBe(-20_000);
  });

  it("returns RISKY when the purchase creates a required obligation shortfall", () => {
    const input = withScenario({
      currentBalanceCents: 100_000,
      purchaseAmountCents: 70_000,
      purchaseDate: "2026-08-03",
      incomeAmountCents: 150_000,
      incomeNextDate: "2026-08-09",
      obligations: [{ id: "obligation_rent", label: "Rent", amountCents: 60_000, date: "2026-08-04" }],
      goals: [],
    });

    const response = evaluateAffordability(input);

    expect(response.level).toBe("RISKY");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual([
      "REQUIRED_OBLIGATION_SHORTFALL",
      "TIMING_RESERVE_SHORTFALL",
    ]);
    expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(-30_000);
  });

  it("returns UNKNOWN when a critical spendable balance is stale", () => {
    const input = structuredClone(baseInput);
    input.snapshot.accounts[0].freshness = {
      status: "fresh",
      asOf: "2026-07-24",
      source: "fixture",
      warnings: [],
    };

    const response = evaluateAffordability(input);

    expect(response.level).toBe("UNKNOWN");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(["STALE_BALANCE"]);
    expect(response.forecast.events).toEqual([]);
  });

  it("returns UNKNOWN when the selected purchase is missing a critical field", () => {
    const input = structuredClone(baseInput);
    delete input.snapshot.plannedPurchases[0].amountCents;

    const response = evaluateAffordability(input);

    expect(response.level).toBe("UNKNOWN");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(["MISSING_PURCHASE_FIELD"]);
    expect(response.explanation.reasons[0].parameters).toEqual({ missingFields: ["amountCents"] });
    expect(response.purchase.amountCents).toBeUndefined();
    expect(response.purchase.purchaseDate).toBe("2026-08-03");
  });

  it("evaluates the monthly-savings discretionary purchase fixture scenarios", () => {
    for (const scenario of monthlySavingsPurchasesFixture.scenarios) {
      const input = structuredClone(monthlySavingsPurchasesInput);
      input.requestId = `fixture_monthly_savings_${scenario.id}`;
      input.plannedPurchaseId = scenario.plannedPurchaseId;

      const response = evaluateAffordability(input);
      const expected = scenario.expected as {
        level: string;
        reasonCodes: string[];
        requiredPathMinimumBalanceCents: number;
        requiredPathMinimumBalanceDate: string;
        protectedPathMinimumBalanceCents: number;
        protectedPathMinimumBalanceDate: string;
        allEventsPathMinimumBalanceCents: number;
        allEventsPathMinimumBalanceDate: string;
        postPurchaseCashCents: number;
        timingReserveCents: number;
        timingReserveMarginCents: number;
        relatedGoalIds?: string[];
      };

      expect(response.purchase.id).toBe(scenario.plannedPurchaseId);
      expect(response.level).toBe(expected.level);
      expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(expected.reasonCodes);
      expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(
        expected.requiredPathMinimumBalanceCents,
      );
      expect(response.metrics.requiredPath.minimumIntradayBalanceDate).toBe(
        expected.requiredPathMinimumBalanceDate,
      );
      expect(response.metrics.protectedPath.minimumIntradayBalanceCents).toBe(
        expected.protectedPathMinimumBalanceCents,
      );
      expect(response.metrics.protectedPath.minimumIntradayBalanceDate).toBe(
        expected.protectedPathMinimumBalanceDate,
      );
      expect(response.metrics.allEventsPath.minimumIntradayBalanceCents).toBe(
        expected.allEventsPathMinimumBalanceCents,
      );
      expect(response.metrics.allEventsPath.minimumIntradayBalanceDate).toBe(
        expected.allEventsPathMinimumBalanceDate,
      );
      expect(response.metrics.postPurchaseCashCents).toBe(expected.postPurchaseCashCents);
      expect(response.metrics.timingReserveCents).toBe(expected.timingReserveCents);
      expect(response.metrics.timingReserveMarginCents).toBe(expected.timingReserveMarginCents);

      if (expected.relatedGoalIds) {
        expect(response.explanation.reasons[0].relatedEntityIds).toEqual(expected.relatedGoalIds);
      }
    }
  });

  it("evaluates the H-010 reason-code fixtures with deterministic ordering and parameters", () => {
    const targetCodes = new Set<ReasonCode>();

    for (const fixture of h010Fixtures) {
      const response = evaluateAffordability(fixture.input);
      const repeat = evaluateAffordability(structuredClone(fixture.input));
      const expected = fixture.expected;
      const reasonSummary = response.explanation.reasons.map((reason) => ({
        code: reason.code,
        parameters: reason.parameters,
        relatedEntityIds: reason.relatedEntityIds,
      }));

      expect(response.level).toBe(expected.level);
      expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(expected.reasonCodes);
      expect(
        repeat.explanation.reasons.map((reason) => ({
          code: reason.code,
          parameters: reason.parameters,
          relatedEntityIds: reason.relatedEntityIds,
        })),
      ).toEqual(reasonSummary);

      const targetReason = response.explanation.reasons.find(
        (reason) => reason.code === expected.targetReasonCode,
      );
      expect(targetReason?.parameters).toEqual(expected.targetReasonParameters);
      expect(targetReason?.relatedEntityIds).toEqual(expected.targetRelatedEntityIds);

      expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(
        expected.requiredPathMinimumBalanceCents,
      );
      expect(response.metrics.requiredPath.minimumIntradayBalanceDate).toBe(
        expected.requiredPathMinimumBalanceDate,
      );
      expect(response.metrics.protectedPath.minimumIntradayBalanceCents).toBe(
        expected.protectedPathMinimumBalanceCents,
      );
      expect(response.metrics.protectedPath.minimumIntradayBalanceDate).toBe(
        expected.protectedPathMinimumBalanceDate,
      );
      expect(response.metrics.allEventsPath.minimumIntradayBalanceCents).toBe(
        expected.allEventsPathMinimumBalanceCents,
      );
      expect(response.metrics.allEventsPath.minimumIntradayBalanceDate).toBe(
        expected.allEventsPathMinimumBalanceDate,
      );
      expect(response.metrics.expectedReferencePath?.minimumIntradayBalanceCents).toBe(
        expected.expectedReferencePathMinimumBalanceCents,
      );
      expect(response.metrics.expectedReferencePath?.minimumIntradayBalanceDate).toBe(
        expected.expectedReferencePathMinimumBalanceDate,
      );
      expect(response.metrics.postPurchaseCashCents).toBe(expected.postPurchaseCashCents);
      expect(response.metrics.timingReserveCents).toBe(expected.timingReserveCents);
      expect(response.metrics.timingReserveMarginCents).toBe(expected.timingReserveMarginCents);
      expect(response.metrics.purchaseImpactOnMinimumCents).toBe(expected.purchaseImpactOnMinimumCents);
      expect(response.explanation.boundaries).toEqual(expected.boundaries);
      expect(fixture.input.snapshot.transactions).toEqual([]);
      expect(response.monthlySpendingSummaries).toEqual([]);

      targetCodes.add(expected.targetReasonCode);
    }

    expect([...targetCodes].sort()).toEqual(
      [
        "BASELINE_ALREADY_TIGHT",
        "COVERAGE_INCOMPLETE",
        "OPTIONAL_OBLIGATION_TRADEOFF",
        "VARIABLE_INCOME_NOT_GUARANTEED",
      ].sort(),
    );
  });

  it("throws a typed validation error for malformed request payloads", () => {
    expect(() => evaluateAffordability({})).toThrow(AffordabilityRequestValidationError);
  });

  it("returns UNKNOWN when scenario currencies are mixed", () => {
    const input = structuredClone(baseInput);
    input.snapshot.accounts[0].currency = "EUR";

    const response = evaluateAffordability(input);

    expect(response.level).toBe("UNKNOWN");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual(["COVERAGE_INCOMPLETE"]);
  });

  it("uses expected reference income only as explanatory upside for unreliable income", () => {
    const input = withScenario({
      currentBalanceCents: 70_000,
      purchaseAmountCents: 30_000,
      purchaseDate: "2026-08-03",
      incomeAmountCents: 0,
      incomeExpectedAmountCents: 100_000,
      incomeNextDate: "2026-08-05",
      incomeVariability: "variable",
      incomeReliability: "uncertain",
      incomeConfidence: 0.45,
      obligations: [{ id: "obligation_utilities", label: "Utilities", amountCents: 60_000, date: "2026-08-06" }],
      goals: [],
    });
    input.snapshot.incomeSources[0].cadence = { kind: "once" };

    const response = evaluateAffordability(input);

    expect(response.level).toBe("RISKY");
    expect(response.explanation.reasons.map((reason) => reason.code)).toEqual([
      "VARIABLE_INCOME_NOT_GUARANTEED",
      "REQUIRED_OBLIGATION_SHORTFALL",
      "TIMING_RESERVE_SHORTFALL",
    ]);
    expect(response.metrics.requiredPath.minimumIntradayBalanceCents).toBe(-20_000);
    expect(response.metrics.expectedReferencePath?.minimumIntradayBalanceCents).toBe(40_000);
    expect(response.metrics.expectedReferencePath?.endingBalanceCents).toBe(80_000);
  });

  it("generates calendar-month spending summaries without counting transfers as spending", () => {
    const input = structuredClone(baseInput);
    input.snapshot.transactions.push({
      id: "tx_savings_transfer",
      accountId: "account_checking",
      postedDate: "2026-08-24",
      merchantName: "Savings transfer",
      amountCents: -50_000,
      currency: "USD",
      category: "transfer",
      normalizedMerchantId: "savings_transfer",
      flowType: "TRANSFER_OUT",
      freshness: {
        status: "fresh",
        asOf: "2026-08-24",
        source: "fixture",
        warnings: [],
      },
      uncertainty: {
        confidence: 1,
        isEstimated: false,
      },
      source: "fixture",
    });

    const response = evaluateAffordability(input);
    const august = response.monthlySpendingSummaries.find((summary) => summary.month === "2026-08");

    expect(august?.totalOutflowCents).toBe(128_000);
    expect(august?.totalInflowCents).toBe(200_000);
    expect(august?.excludedTransferOutflowCents).toBe(0);
    expect(august?.unclassifiedOutflowCents).toBe(50_000);
  });
});

function withScenario(input: {
  currentBalanceCents: number;
  purchaseAmountCents: number;
  purchaseDate: string;
  incomeAmountCents: number;
  incomeExpectedAmountCents?: number;
  incomeNextDate: string;
  incomeVariability?: "fixed" | "variable" | "irregular";
  incomeReliability?: "confirmed" | "expected" | "uncertain";
  incomeConfidence?: number;
  obligations: { id: string; label: string; amountCents: number; date: string; importance?: "required" | "flexible" | "optional" }[];
  goals: { id: string; label: string; amountCents: number; date: string; protection: "protected" | "flexible" }[];
}): AffordabilityRequest {
  const request = structuredClone(baseInput);
  request.snapshot.accounts[0].currentBalanceCents = input.currentBalanceCents;
  request.snapshot.accounts[0].availableBalanceCents = input.currentBalanceCents;
  request.snapshot.plannedPurchases[0].amountCents = input.purchaseAmountCents;
  request.snapshot.plannedPurchases[0].purchaseDate = input.purchaseDate;
  request.snapshot.incomeSources[0].minimumExpectedAmountCents = input.incomeAmountCents;
  request.snapshot.incomeSources[0].expectedAmountCents =
    input.incomeExpectedAmountCents ?? input.incomeAmountCents;
  request.snapshot.incomeSources[0].nextExpectedDate = input.incomeNextDate;
  request.snapshot.incomeSources[0].cadence = { kind: "biweekly", anchorDate: input.incomeNextDate };
  request.snapshot.incomeSources[0].variability = input.incomeVariability ?? "fixed";
  request.snapshot.incomeSources[0].reliability = input.incomeReliability ?? "confirmed";
  request.snapshot.incomeSources[0].uncertainty.confidence = input.incomeConfidence ?? 1;
  request.snapshot.recurringObligations = input.obligations.map((obligation) => ({
    id: obligation.id,
    label: obligation.label,
    amountCents: obligation.amountCents,
    cadence: { kind: "monthly", dayOfMonth: Number(obligation.date.slice(-2)) },
    nextDueDate: obligation.date,
    category: "required",
    required: obligation.importance !== "optional" && obligation.importance !== "flexible",
    importance: obligation.importance ?? "required",
    autopay: true,
    active: true,
    freshness: { status: "fresh", asOf: "2026-08-03", source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    currency: "USD",
  }));
  request.snapshot.goals = input.goals.map((goal) => ({
    id: goal.id,
    label: goal.label,
    goalType: "monthly_savings_target",
    targetAmountCents: 100_000,
    currentAmountCents: 0,
    monthlyContributionCents: goal.amountCents,
    nextContributionDate: goal.date,
    contributionCadence: { kind: "monthly", dayOfMonth: Number(goal.date.slice(-2)) },
    priority: "high",
    protection: goal.protection,
    active: true,
    freshness: { status: "fresh", asOf: "2026-08-03", source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    currency: "USD",
  }));

  return request;
}
