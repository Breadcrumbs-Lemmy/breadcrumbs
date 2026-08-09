/**
 * `detectInsights` is the waste-detection surface behind `GET /api/v1/insights`.
 * Its findings carry backend-authored display copy (a flagged `CD-006`
 * exception), so the money strings here are read by the user verbatim — a
 * formatter that drops a trailing zero ("$10.5") is a user-visible defect, not a
 * cosmetic one. These cases pin each detector and the money formatting that a
 * fixture-only test would never exercise.
 */
import { describe, expect, it } from "vitest";
import { detectInsights } from "../src";
import type { Transaction } from "../src";

function tx(
  overrides: Partial<Transaction> & Pick<Transaction, "id" | "amountCents" | "category">,
): Transaction {
  return {
    accountId: "acct_checking",
    postedDate: "2026-05-10",
    merchantName: "Merchant",
    currency: "USD",
    flowType: "SPEND",
    freshness: { status: "usable", asOf: "2026-05-10T00:00:00.000Z", source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...overrides,
  };
}

const recurring = (confidence = 0.9): Transaction["recurrenceSignal"] => ({
  isLikelyRecurring: true,
  cadence: "monthly",
  confidence,
});

describe("detectInsights", () => {
  it("surfaces frequent small purchases once they clear the count and total thresholds", () => {
    const coffees = Array.from({ length: 5 }, (_, i) =>
      tx({
        id: `c${i}`,
        amountCents: -650,
        category: "coffee_snacks",
        merchantName: "Blue Bottle",
        normalizedMerchantId: "blue_bottle",
        postedDate: `2026-05-0${i + 1}`,
      }),
    );

    const result = detectInsights({
      transactions: coffees,
      accounts: [],
      currency: "USD",
      asOfDate: "2026-05-20",
      kind: "month",
    });

    const insight = result.insights.find((x) => x.type === "FREQUENT_SMALL_PURCHASES");
    expect(insight).toMatchObject({
      category: "coffee_snacks",
      occurrenceCount: 5,
      totalCents: 3250,
      averageCents: 650,
    });
    expect(insight?.headline).toContain("5 times");
    expect(insight?.transactionIds).toHaveLength(5);
  });

  it("flags three concurrent substitutable services and offers a savings range, not a figure", () => {
    const services = [
      tx({ id: "n", amountCents: -1599, category: "streaming", merchantName: "Netflix", normalizedMerchantId: "netflix", recurrenceSignal: recurring() }),
      tx({ id: "h", amountCents: -1299, category: "streaming", merchantName: "Hulu", normalizedMerchantId: "hulu", recurrenceSignal: recurring() }),
      tx({ id: "d", amountCents: -1099, category: "streaming", merchantName: "Disney+", normalizedMerchantId: "disney", recurrenceSignal: recurring() }),
    ];

    const result = detectInsights({
      transactions: services,
      accounts: [],
      currency: "USD",
      asOfDate: "2026-05-20",
      kind: "month",
    });

    const dup = result.insights.find((x) => x.type === "POSSIBLE_DUPLICATE_SERVICE");
    expect(dup?.members).toHaveLength(3);
    // A range from cheapest to costliest member — arithmetic the user can check,
    // never a single "you could save X" figure.
    expect(dup?.potentialSavings).toMatchObject({ lowCents: 1099, highCents: 1599, basis: "cheapest_to_costliest_member" });

    // The same recurring services feed the recurring summary.
    expect(result.recurring.count).toBe(3);
    expect(result.recurring.totalMonthlyCents).toBe(1599 + 1299 + 1099);
  });

  it("does not flag a single or paired substitutable service as a duplicate", () => {
    const services = [
      tx({ id: "n", amountCents: -1599, category: "streaming", merchantName: "Netflix", normalizedMerchantId: "netflix", recurrenceSignal: recurring() }),
      tx({ id: "h", amountCents: -1299, category: "streaming", merchantName: "Hulu", normalizedMerchantId: "hulu", recurrenceSignal: recurring() }),
    ];
    const result = detectInsights({ transactions: services, accounts: [], currency: "USD", asOfDate: "2026-05-20", kind: "month" });
    expect(result.insights.some((x) => x.type === "POSSIBLE_DUPLICATE_SERVICE")).toBe(false);
  });

  it("reports a rising category against its prior period and formats money with two decimals", () => {
    const transactions = [
      // Prior month (June): $50.00 of dining.
      tx({ id: "jun", amountCents: -5000, category: "dining", postedDate: "2026-06-10" }),
      // Current month (July): $110.50 of dining across two charges.
      tx({ id: "jul1", amountCents: -6000, category: "dining", postedDate: "2026-07-05" }),
      tx({ id: "jul2", amountCents: -5050, category: "dining", postedDate: "2026-07-18" }),
    ];

    const result = detectInsights({
      transactions,
      accounts: [],
      currency: "USD",
      asOfDate: "2026-08-15", // July is complete, so the comparison is honest
      kind: "month",
      key: "2026-07",
    });

    const rising = result.insights.find((x) => x.type === "RISING_CATEGORY");
    expect(rising).toMatchObject({
      category: "dining",
      totalCents: 11050,
      comparison: { direction: "up", changeCents: 6050 },
    });
    // The regression this suite exists for: $110.50, not "$110.5".
    expect(rising?.detail).toBe("$110.50 this month, against $50 before.");
  });

  it("suppresses rising-category comparisons while the current period is still filling", () => {
    const transactions = [
      tx({ id: "jun", amountCents: -5000, category: "dining", postedDate: "2026-06-10" }),
      tx({ id: "jul1", amountCents: -6000, category: "dining", postedDate: "2026-07-05" }),
      tx({ id: "jul2", amountCents: -5050, category: "dining", postedDate: "2026-07-18" }),
    ];
    // asOf falls inside July, so July is partial and a fall/rise would be a
    // calendar artefact — the detector must stay silent.
    const result = detectInsights({ transactions, accounts: [], currency: "USD", asOfDate: "2026-07-20", kind: "month", key: "2026-07" });
    expect(result.insights.some((x) => x.type === "RISING_CATEGORY")).toBe(false);
  });

  it("scopes to the requested currency", () => {
    const coffees = Array.from({ length: 5 }, (_, i) =>
      tx({ id: `e${i}`, amountCents: -650, category: "coffee_snacks", currency: "EUR", postedDate: `2026-05-0${i + 1}` }),
    );
    const result = detectInsights({ transactions: coffees, accounts: [], currency: "USD", asOfDate: "2026-05-20", kind: "month" });
    expect(result.insights).toHaveLength(0);
    expect(result.recurring.count).toBe(0);
  });
});
