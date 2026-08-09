import { describe, expect, it } from "vitest";
import recurringFixture from "../fixtures/mvp0/recurring-subscriptions-cases.json";
import { annotateRecurrenceSignals, detectInsights } from "../src";
import type { Account, Transaction } from "../src";

type RecurringFixture = {
  analysisDate: string;
  currency: string;
  accounts: Account[];
  transactions: Transaction[];
};

const fixture = recurringFixture as RecurringFixture;

/**
 * The fixture states `recurrenceSignal` by hand, which is exactly why the gap
 * this module closes went unnoticed: imported transactions never carry it.
 * Stripping it reproduces what a CSV import actually produces.
 */
function withoutRecurrenceSignals(transactions: Transaction[]): Transaction[] {
  return transactions.map(({ recurrenceSignal: _dropped, ...rest }) => rest);
}

describe("annotateRecurrenceSignals", () => {
  it("derives recurrence for transactions that arrived without a signal", () => {
    const bare = withoutRecurrenceSignals(fixture.transactions);
    expect(bare.some((t) => t.recurrenceSignal)).toBe(false);

    const annotated = annotateRecurrenceSignals({
      transactions: bare,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });

    const recurring = annotated.filter((t) => t.recurrenceSignal?.isLikelyRecurring);
    expect(recurring.length).toBeGreaterThan(0);
    expect(new Set(recurring.map((t) => t.normalizedMerchantId))).toContain("netflix");

    for (const transaction of recurring) {
      // The schema bounds confidence to 0–1; the detector reports 0–100.
      expect(transaction.recurrenceSignal!.confidence).toBeGreaterThan(0);
      expect(transaction.recurrenceSignal!.confidence).toBeLessThanOrEqual(1);
      expect(transaction.recurrenceSignal!.cadence).toBeDefined();
    }
  });

  it("leaves an explicitly stated signal alone", () => {
    const stated: Transaction[] = fixture.transactions.map((transaction, index) =>
      index === 0
        ? {
            ...transaction,
            recurrenceSignal: { isLikelyRecurring: false, confidence: 0 },
          }
        : transaction,
    );

    const annotated = annotateRecurrenceSignals({
      transactions: stated,
      accounts: fixture.accounts,
      currency: fixture.currency,
      analysisDate: fixture.analysisDate,
    });

    expect(annotated[0]!.recurrenceSignal).toEqual({ isLikelyRecurring: false, confidence: 0 });
  });

  it("feeds the insights recurring block, which is empty without it", () => {
    const bare = withoutRecurrenceSignals(fixture.transactions);
    const options = {
      accounts: fixture.accounts,
      currency: fixture.currency,
      asOfDate: fixture.analysisDate,
      kind: "month" as const,
    };

    const before = detectInsights({ ...options, transactions: bare });
    expect(before.recurring.count).toBe(0);

    const after = detectInsights({
      ...options,
      transactions: annotateRecurrenceSignals({
        transactions: bare,
        accounts: fixture.accounts,
        currency: fixture.currency,
        analysisDate: fixture.analysisDate,
      }),
    });
    expect(after.recurring.count).toBeGreaterThan(0);
    expect(after.recurring.totalMonthlyCents).toBeGreaterThan(0);
  });
});

describe("detectInsights period keys", () => {
  it("honours a requested week key instead of silently using the current week", () => {
    const result = detectInsights({
      transactions: fixture.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      asOfDate: fixture.analysisDate,
      kind: "week",
      key: "2026-W10",
    });

    expect(result.period.key).toBe("2026-W10");
  });

  it("falls back to the period containing asOfDate when the key is unparseable", () => {
    const result = detectInsights({
      transactions: fixture.transactions,
      accounts: fixture.accounts,
      currency: fixture.currency,
      asOfDate: fixture.analysisDate,
      kind: "month",
      key: "not-a-key",
    });

    expect(result.period.key).toBe(fixture.analysisDate.slice(0, 7));
  });
});
