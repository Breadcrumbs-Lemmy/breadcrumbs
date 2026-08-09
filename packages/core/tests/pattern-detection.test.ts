import { describe, expect, it } from "vitest";
import recurringFixture from "../fixtures/mvp0/recurring-subscriptions-cases.json";
import pivotFixture from "../fixtures/mvp0/where-is-my-money-going-multi-account.json";
import { detectRecurringSpending } from "../src";
import type {
  Account,
  FinancialSnapshot,
  PatternDiagnostic,
  PatternInsight,
  Transaction,
} from "../src";

type RecurringFixture = {
  analysisDate: string;
  currency: string;
  accounts: Account[];
  transactions: Transaction[];
  ambiguousAppStoreTransactions: Transaction[];
  incompleteHistory: {
    analysisDate: string;
    transactions: Transaction[];
  };
  expected: {
    mainLikelySubscriptionMerchantIds: string[];
    duplicateKinds: string[];
    excludedMerchantIds: string[];
  };
};

const fixture = recurringFixture as RecurringFixture;
const pivotSnapshot = (pivotFixture.input as { snapshot: FinancialSnapshot }).snapshot;

describe("detectRecurringSpending", () => {
  it("detects likely subscriptions and duplicate-ish services from normalized transactions", () => {
    const result = detectRecurringSpending({
      transactions: fixture.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });
    const subscriptions = likelySubscriptions(result.insights);
    const duplicateServices = duplicateServicesFrom(result.insights);

    expect(subscriptions.map((insight) => insight.evidence.merchant.normalizedMerchantId).sort()).toEqual(
      fixture.expected.mainLikelySubscriptionMerchantIds,
    );
    expect(duplicateServices.map((insight) => insight.evidence.duplicateKind).sort()).toEqual(
      fixture.expected.duplicateKinds,
    );

    const netflix = subscriptionFor(result.insights, "netflix", "checking_manual");
    expect(netflix).toMatchObject({
      confidenceBand: "high",
      savingsImpact: {
        monthlyLowCents: 0,
        monthlyHighCents: 1549,
        annualHighCents: 18588,
      },
      evidence: {
        cadence: "monthly",
        occurrenceCount: 5,
        estimatedMonthlyCostCents: 1549,
        amountCents: {
          median: 1549,
          tolerance: 200,
        },
      },
    });
    expect(netflix.assumptions.map((assumption) => assumption.code)).toEqual([
      "normalized_category_required_defaults",
      "normalized_merchant_grouping",
      "same_individual_accounts",
      "transfer_and_refund_exclusion",
    ]);
    expect(netflix.debugTrace).toEqual(expect.arrayContaining(["rule=likely_subscription", "merchant_id=netflix"]));

    const audibleDuplicate = duplicateServices.find(
      (insight) => insight.evidence.duplicateKind === "same_merchant_across_accounts",
    );
    expect(audibleDuplicate).toMatchObject({
      confidenceBand: "high",
      savingsImpact: {
        monthlyLowCents: 0,
        monthlyHighCents: 1495,
        reviewableMonthlyTotalCents: 2990,
      },
      evidence: {
        merchantIds: ["audible"],
        accountIds: ["checking_manual", "credit_card_fixture"],
        cadenceWindowsOverlap: true,
      },
    });

    const streamingDuplicate = duplicateServices.find(
      (insight) => insight.evidence.duplicateKind === "same_service_group",
    );
    expect(streamingDuplicate).toMatchObject({
      confidenceBand: "medium",
      savingsImpact: {
        monthlyHighCents: 1549,
        reviewableMonthlyTotalCents: 5347,
      },
      evidence: {
        serviceGroup: "streaming_video",
        merchantIds: ["hulu", "max", "netflix"],
      },
    });
    expect(streamingDuplicate?.explanation).toContain("may be intentionally different");
  });

  it("excludes required bills, transfers, card payments, refunds, and one-time purchases", () => {
    const result = detectRecurringSpending({
      transactions: fixture.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
      includeDiagnostics: true,
    });
    const detectedMerchantIds = likelySubscriptions(result.insights).map(
      (insight) => insight.evidence.merchant.normalizedMerchantId,
    );

    for (const merchantId of fixture.expected.excludedMerchantIds) {
      expect(detectedMerchantIds).not.toContain(merchantId);
    }
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnosticContaining("excluded_tagged_transaction", "tx_appliance_repair_2026_06_02", "excluded_by_tag=one_time"),
        diagnosticContaining("excluded_tagged_transaction", "tx_comed_2026_06_16", "excluded_by_tag=required"),
        diagnosticContaining("excluded_non_spend_flow", "tx_card_payment_out_2026_06_20", "flow_type=TRANSFER_OUT"),
        diagnosticContaining("excluded_non_spend_flow", "tx_apple_refund_2026_06_23", "flow_type=REFUND"),
      ]),
    );
  });

  it("caps two-charge ambiguous app-store detections at medium confidence", () => {
    const result = detectRecurringSpending({
      transactions: fixture.ambiguousAppStoreTransactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });

    expect(result.insights).toHaveLength(1);
    const [insight] = likelySubscriptions(result.insights);

    expect(insight).toMatchObject({
      confidenceBand: "medium",
      confidenceScore: 65,
      evidence: {
        merchant: {
          normalizedMerchantId: "apple_app_store",
          merchantAmbiguity: true,
        },
        twoChargeException: true,
      },
      savingsImpact: {
        monthlyHighCents: 999,
        annualHighCents: 11988,
      },
    });
    expect(insight.confidenceCapsApplied.map((cap) => cap.code)).toEqual([
      "ambiguous_processor",
      "two_charge_monthly_exception",
    ]);
    expect(insight.uncertainties.map((uncertainty) => uncertainty.code)).toEqual([
      "ambiguous_processor",
      "insufficient_history",
      "sparse_evidence",
    ]);
    expect(insight.explanation).toContain("may be one app store service or multiple app store charges");
  });

  it("emits insufficient-history diagnostics instead of high-confidence insights", () => {
    const result = detectRecurringSpending({
      transactions: fixture.incompleteHistory.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.incompleteHistory.analysisDate,
      includeDiagnostics: true,
    });

    expect(result.insights.filter((insight) => insight.confidenceBand === "high")).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "insufficient_history",
          debugTrace: expect.arrayContaining(["coverage_days=16", "subscription_minimum_coverage_days=60"]),
        }),
      ]),
    );
  });

  it("keeps result order deterministic even when transaction input order changes", () => {
    const ordered = detectRecurringSpending({
      transactions: fixture.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });
    const shuffled = detectRecurringSpending({
      transactions: [...fixture.transactions].reverse(),
      accounts: [...fixture.accounts].reverse(),
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });

    expect(shuffled.insights.map((insight) => insight.insightId)).toEqual(
      ordered.insights.map((insight) => insight.insightId),
    );
    expect(ordered.insights.map((insight) => insight.insightId)).toMatchInlineSnapshot(`
      [
        "pattern:mvp0-2026-08-04:possible_duplicate_service:merchant:audible:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:likely_subscription:merchant:max:account:checking_manual:cadence:monthly:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:likely_subscription:merchant:hulu:account:checking_manual:cadence:monthly:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:likely_subscription:merchant:netflix:account:checking_manual:cadence:monthly:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:likely_subscription:merchant:audible:account:checking_manual:cadence:monthly:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:likely_subscription:merchant:audible:account:credit_card_fixture:cadence:monthly:2026-01-02:2026-06-30",
        "pattern:mvp0-2026-08-04:possible_duplicate_service:service_group:streaming_video:2026-01-02:2026-06-30",
      ]
    `);
  });

  it("runs against the canonical multi-account fixture without treating required bills or card payments as subscriptions", () => {
    const result = detectRecurringSpending({
      transactions: pivotSnapshot.transactions,
      accounts: pivotSnapshot.accounts,
      currency: pivotSnapshot.currency,
      analysisDate: pivotSnapshot.asOfDate,
    });
    const merchantIds = likelySubscriptions(result.insights).map(
      (insight) => insight.evidence.merchant.normalizedMerchantId,
    );

    expect(merchantIds).toEqual(["adobe", "hulu", "netflix", "spotify", "apple_icloud", "google_one"]);
    expect(merchantIds).not.toContain("oak_street_apartments");
    expect(merchantIds).not.toContain("comed");
    expect(merchantIds).not.toContain("credit_card_payment");
    expect(duplicateServicesFrom(result.insights).map((insight) => insight.evidence.serviceGroup)).toEqual([
      "streaming_video",
      "cloud_storage",
    ]);
  });
});

function likelySubscriptions(insights: PatternInsight[]) {
  return insights.filter((insight): insight is PatternInsight & { evidence: { kind: "likely_subscription" } } => {
    return insight.insightType === "likely_subscription" && insight.evidence.kind === "likely_subscription";
  });
}

function duplicateServicesFrom(insights: PatternInsight[]) {
  return insights.filter((insight): insight is PatternInsight & { evidence: { kind: "possible_duplicate_service" } } => {
    return insight.insightType === "possible_duplicate_service" && insight.evidence.kind === "possible_duplicate_service";
  });
}

function subscriptionFor(insights: PatternInsight[], merchantId: string, accountId: string) {
  const subscription = likelySubscriptions(insights).find((insight) => {
    return (
      insight.evidence.merchant.normalizedMerchantId === merchantId &&
      insight.evidence.accountIds.includes(accountId)
    );
  });
  expect(subscription).toBeDefined();
  return subscription as NonNullable<typeof subscription>;
}

function diagnosticContaining(
  code: PatternDiagnostic["code"],
  relatedEntityId: string,
  debugTrace: string,
) {
  return expect.objectContaining({
    code,
    relatedEntityIds: expect.arrayContaining([relatedEntityId]),
    debugTrace: expect.arrayContaining([debugTrace]),
  });
}
