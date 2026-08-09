import { describe, expect, it } from "vitest";
import pivotFixture from "../fixtures/mvp0/where-is-my-money-going-multi-account.json";
import { evaluateAffordability, summarizeMonthlySpending } from "../src";
import type { AffordabilityRequest, FinancialSnapshot, MonthlySpendingSummary, Transaction } from "../src";

const fixtureInput = pivotFixture.input as AffordabilityRequest;
const fixtureSnapshot = fixtureInput.snapshot as FinancialSnapshot;

describe("summarizeMonthlySpending", () => {
  it("aggregates a multi-account, multi-institution fixture without double-counting transfers or credit-card payments", () => {
    const summaries = summarizeMonthlySpending(
      fixtureSnapshot.transactions,
      fixtureSnapshot.currency,
      fixtureSnapshot.accounts,
    );

    expect(summaries.map((summary) => summary.month)).toEqual(["2026-06", "2026-07", "2026-08"]);

    for (const expected of pivotFixture.expected.monthlySummaries) {
      const summary = getMonth(summaries, expected.month);
      expect(summary).toMatchObject({
        totalOutflowCents: expected.totalOutflowCents,
        grossOutflowCents: expected.grossOutflowCents,
        totalInflowCents: expected.totalInflowCents,
        refundCents: expected.refundCents,
        excludedTransferOutflowCents: expected.excludedTransferOutflowCents,
        excludedTransferInflowCents: expected.excludedTransferInflowCents,
        excludedCreditCardPaymentOutflowCents: expected.excludedCreditCardPaymentOutflowCents,
        excludedCreditCardPaymentInflowCents: expected.excludedCreditCardPaymentInflowCents,
        unclassifiedOutflowCents: expected.unclassifiedOutflowCents,
      });
    }

    const august = getMonth(summaries, "2026-08");
    expect(august.totalOutflowCents).toBeLessThan(august.grossOutflowCents + august.excludedTransferOutflowCents);
    expect(august.excludedCreditCardPaymentOutflowCents).toBe(224_000);
    expect(august.excludedTransferOutflowCents).toBe(274_000);
  });

  it("returns refund-net category totals and backend-owned recent-versus-baseline category comparisons", () => {
    const summaries = summarizeMonthlySpending(
      fixtureSnapshot.transactions,
      fixtureSnapshot.currency,
      fixtureSnapshot.accounts,
    );
    const august = getMonth(summaries, "2026-08");
    const expected = pivotFixture.expected.augustCategoryTotals;

    expect(getCategory(august, "shopping")).toMatchObject(expected.shopping);
    expect(getCategory(august, "groceries")).toMatchObject({
      outflowCents: expected.groceries.outflowCents,
    });

    expect(august.comparison).toMatchObject({
      recentMonth: "2026-08",
      baselineMonths: ["2026-06", "2026-07"],
      baselineMonthCount: 2,
      baselineAverageOutflowCents: pivotFixture.expected.monthlySummaries[2].comparisonBaselineAverageOutflowCents,
      outflowChangeCents: pivotFixture.expected.monthlySummaries[2].comparisonOutflowChangeCents,
      direction: "up",
    });
    expect(getCategoryComparison(august, "groceries")).toMatchObject({
      recentOutflowCents: expected.groceries.outflowCents,
      baselineAverageOutflowCents: expected.groceries.baselineAverageOutflowCents,
      outflowChangeCents: expected.groceries.outflowChangeCents,
    });
    expect(getCategoryComparison(august, "cloud_storage")).toMatchObject({
      recentOutflowCents: expected.cloud_storage.outflowCents,
      baselineAverageOutflowCents: expected.cloud_storage.baselineAverageOutflowCents,
      outflowChangeCents: expected.cloud_storage.outflowChangeCents,
    });
  });

  it("returns per-account and per-institution attribution without UI-side re-aggregation", () => {
    const summaries = summarizeMonthlySpending(
      fixtureSnapshot.transactions,
      fixtureSnapshot.currency,
      fixtureSnapshot.accounts,
    );
    const august = getMonth(summaries, "2026-08");

    for (const [accountId, expected] of Object.entries(pivotFixture.expected.augustAccountTotals)) {
      expect(getAccount(august, accountId)).toMatchObject(expected);
    }

    for (const [institutionName, expected] of Object.entries(pivotFixture.expected.augustInstitutionTotals)) {
      expect(getInstitution(august, institutionName)).toMatchObject(expected);
    }
  });

  it("keeps unpaired transfers out of spending while allowing deterministic same-user transfer matching", () => {
    const base = baseTransaction({
      id: "tx_pair_out",
      accountId: "account_chase_checking",
      postedDate: "2026-08-05",
      merchantName: "Transfer to Ally Savings",
      amountCents: -40_000,
      category: "transfer",
      flowType: "UNCLASSIFIED",
    });
    const pairedIn = baseTransaction({
      id: "tx_pair_in",
      accountId: "account_ally_savings",
      postedDate: "2026-08-06",
      merchantName: "Transfer from Chase Checking",
      amountCents: 40_000,
      category: "transfer",
      flowType: "UNCLASSIFIED",
    });
    const unpairedOut = baseTransaction({
      id: "tx_unpaired_out",
      accountId: "account_chase_checking",
      postedDate: "2026-08-10",
      merchantName: "Venmo Transfer",
      amountCents: -22_000,
      category: "transfer",
      flowType: "UNCLASSIFIED",
    });

    const [summary] = summarizeMonthlySpending(
      [base, pairedIn, unpairedOut],
      "USD",
      fixtureSnapshot.accounts,
    );

    expect(summary.totalOutflowCents).toBe(0);
    expect(summary.excludedTransferOutflowCents).toBe(40_000);
    expect(summary.excludedTransferInflowCents).toBe(40_000);
    expect(summary.unclassifiedOutflowCents).toBe(22_000);
  });

  it("downgrades untrusted transfer classifications to UNCLASSIFIED instead of silently excluding them", () => {
    const trusted = baseTransaction({
      id: "tx_trusted_transfer_out",
      accountId: "account_chase_checking",
      postedDate: "2026-08-04",
      merchantName: "Transfer to Ally Savings",
      amountCents: -10_000,
      category: "transfer",
      flowType: "TRANSFER_OUT",
      counterAccountId: "account_ally_savings",
      transferMatchConfidence: 0.8,
    });
    const missingCounter = baseTransaction({
      id: "tx_missing_counter",
      accountId: "account_chase_checking",
      postedDate: "2026-08-05",
      merchantName: "Transfer",
      amountCents: -20_000,
      category: "transfer",
      flowType: "TRANSFER_OUT",
    });
    const unlinkedCounter = baseTransaction({
      id: "tx_unlinked_counter",
      accountId: "account_chase_checking",
      postedDate: "2026-08-06",
      merchantName: "Transfer",
      amountCents: -30_000,
      category: "transfer",
      flowType: "TRANSFER_OUT",
      counterAccountId: "account_not_connected",
      transferMatchConfidence: 1,
    });
    const lowConfidence = baseTransaction({
      id: "tx_low_confidence",
      accountId: "account_chase_checking",
      postedDate: "2026-08-07",
      merchantName: "Transfer",
      amountCents: -40_000,
      category: "transfer",
      flowType: "TRANSFER_OUT",
      counterAccountId: "account_ally_savings",
      transferMatchConfidence: 0.2,
    });

    const [summary] = summarizeMonthlySpending(
      [trusted, missingCounter, unlinkedCounter, lowConfidence],
      "USD",
      fixtureSnapshot.accounts,
    );

    expect(summary.totalOutflowCents).toBe(0);
    expect(summary.excludedTransferOutflowCents).toBe(10_000);
    expect(summary.unclassifiedOutflowCents).toBe(90_000);
  });

  it("allows refund-only categories to go negative when the refund posts in a later month", () => {
    const refund = baseTransaction({
      id: "tx_refund_only",
      accountId: "account_amex_gold",
      postedDate: "2026-08-18",
      merchantName: "Amazon Refund",
      amountCents: 5_000,
      category: "shopping",
      flowType: "REFUND",
    });

    const [summary] = summarizeMonthlySpending([refund], "USD", fixtureSnapshot.accounts);

    expect(summary.totalOutflowCents).toBe(-5_000);
    expect(getCategory(summary, "shopping")).toMatchObject({
      outflowCents: -5_000,
      grossOutflowCents: 0,
      refundCents: 5_000,
      transactionCount: 0,
      refundTransactionCount: 1,
    });
  });

  it("keeps the spending summary contract available through the existing affordability response", () => {
    const response = evaluateAffordability(fixtureInput);
    const august = getMonth(response.monthlySpendingSummaries, "2026-08");

    expect(response.level).not.toBe("UNKNOWN");
    expect(august.totalOutflowCents).toBe(270_689);
    expect(august.institutionTotals.map((total) => total.displayName)).toContain("American Express");
  });
});

function getMonth(summaries: MonthlySpendingSummary[], month: string): MonthlySpendingSummary {
  const summary = summaries.find((candidate) => candidate.month === month);
  expect(summary).toBeDefined();
  return summary as MonthlySpendingSummary;
}

function getCategory(summary: MonthlySpendingSummary, category: string) {
  const total = summary.categoryTotals.find((candidate) => candidate.category === category);
  expect(total).toBeDefined();
  return total;
}

function getCategoryComparison(summary: MonthlySpendingSummary, category: string) {
  const comparison = summary.comparison.categoryComparisons.find((candidate) => candidate.category === category);
  expect(comparison).toBeDefined();
  return comparison;
}

function getAccount(summary: MonthlySpendingSummary, accountId: string) {
  const total = summary.accountTotals.find((candidate) => candidate.id === accountId);
  expect(total).toBeDefined();
  return total;
}

function getInstitution(summary: MonthlySpendingSummary, institutionName: string) {
  const total = summary.institutionTotals.find((candidate) => candidate.displayName === institutionName);
  expect(total).toBeDefined();
  return total;
}

function baseTransaction(input: {
  id: string;
  accountId: string;
  postedDate: string;
  merchantName: string;
  amountCents: number;
  category: string;
  flowType: Transaction["flowType"];
  counterAccountId?: string;
  transferMatchConfidence?: number;
}): Transaction {
  return {
    ...input,
    currency: "USD",
    normalizedMerchantId: input.merchantName.toLowerCase().replaceAll(" ", "_"),
    freshness: { status: "fresh", asOf: input.postedDate, source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
  };
}
