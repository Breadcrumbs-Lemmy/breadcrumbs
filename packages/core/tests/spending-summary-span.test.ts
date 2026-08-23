/**
 * Tests for the `span` option added to `summarizeSpending`.
 *
 * The calendar UI allows users to select an arbitrary contiguous date range
 * (e.g. Feb 1 – Apr 30). This test suite pins:
 *   - Correct date-boundary filtering: only transactions whose postedDate falls
 *     within [span.startDate, span.endDate] are aggregated.
 *   - `comparison.comparable === false` and `comparison.direction === "new"`:
 *     a custom span has no natural baseline, so comparison is deliberately
 *     disabled rather than misleading.
 *   - `period.key` starts with "span:" and encodes the date bounds.
 *   - Non-span calls are completely unaffected (regression guard).
 */
import { describe, expect, it } from "vitest";
import { summarizeSpending } from "../src";
import type { Account, Transaction } from "../src";

function account(over: Partial<Account> & Pick<Account, "id">): Account {
  return {
    displayName: over.id,
    institutionName: "Test Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 100_000,
    includeInForecast: true,
    freshness: { status: "fresh", asOf: "2021-01-01", source: "fixture", warnings: [] },
    source: "fixture",
    ...over,
  };
}

function tx(
  over: Partial<Transaction> &
    Pick<Transaction, "id" | "accountId" | "amountCents" | "category" | "flowType" | "postedDate">,
): Transaction {
  return {
    merchantName: "Merchant",
    normalizedMerchantId: "merchant",
    currency: "USD",
    freshness: { status: "fresh", asOf: over.postedDate, source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...over,
  };
}

const acct = account({ id: "chk" });

// Three months of transactions: Jan, Feb, Mar 2021.
const transactions = [
  // January — outside the span
  tx({ id: "jan1", accountId: "chk", amountCents: -5_000, category: "dining", flowType: "SPEND", postedDate: "2021-01-10" }),
  tx({ id: "jan2", accountId: "chk", amountCents: -3_000, category: "groceries", flowType: "SPEND", postedDate: "2021-01-20" }),
  // February — inside the span
  tx({ id: "feb1", accountId: "chk", amountCents: -4_000, category: "dining", flowType: "SPEND", postedDate: "2021-02-05" }),
  tx({ id: "feb2", accountId: "chk", amountCents: -6_000, category: "groceries", flowType: "SPEND", postedDate: "2021-02-15" }),
  // March — inside the span
  tx({ id: "mar1", accountId: "chk", amountCents: -2_000, category: "dining", flowType: "SPEND", postedDate: "2021-03-01" }),
  tx({ id: "mar2", accountId: "chk", amountCents: -7_000, category: "groceries", flowType: "SPEND", postedDate: "2021-03-25" }),
  // April — outside the span (boundary: span ends 2021-03-31)
  tx({ id: "apr1", accountId: "chk", amountCents: -9_999, category: "dining", flowType: "SPEND", postedDate: "2021-04-01" }),
];

describe("summarizeSpending — span option", () => {
  it("aggregates only transactions within the span (Feb 1 – Mar 31) and excludes Jan and Apr", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    // Feb: 4000 + 6000 = 10000; Mar: 2000 + 7000 = 9000; total = 19000
    expect(summary.totalOutflowCents).toBe(19_000);
  });

  it("sets period.key to 'span:<startDate>:<endDate>'", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    expect(summary.period.key).toBe("span:2021-02-01:2021-03-31");
    expect(summary.period.key.startsWith("span:")).toBe(true);
  });

  it("disables comparison (comparable: false, direction: 'new') for a custom span", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    expect(summary.comparison.comparable).toBe(false);
    expect(summary.comparison.direction).toBe("new");
    expect(summary.comparison.baselinePeriodCount).toBe(0);
  });

  it("leaves category comparison undefined for a span (no per-category baseline)", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    for (const cat of summary.categoryTotals) {
      expect(cat.comparison).toBeUndefined();
    }
  });

  it("uses span.label as the period label when provided", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31", label: "Feb – Mar 2021" },
    });

    expect(summary.period.label).toBe("Feb – Mar 2021");
  });

  it("falls back to '<startDate> – <endDate>' when no label is provided", () => {
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    expect(summary.period.label).toBe("2021-02-01 – 2021-03-31");
  });

  it("sets partial: false regardless of asOfDate", () => {
    // Even if asOfDate is mid-span, a custom span is never reported as partial
    // since its bounds are explicitly chosen — there's no "still filling up" concept.
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-02-10", // inside the span
      kind: "month",
      span: { startDate: "2021-02-01", endDate: "2021-03-31" },
    });

    expect(summary.period.partial).toBe(false);
  });

  it("non-span call is completely unaffected — existing monthly logic unchanged", () => {
    // Sanity check: the classic key-based monthly path must still work identically
    // to before the span feature was added.
    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-05-01",
      kind: "month",
      key: "2021-01",
    });

    // January only: 5000 + 3000 = 8000
    expect(summary.totalOutflowCents).toBe(8_000);
    expect(summary.period.key).toBe("2021-01");
    // Non-span: comparison runs normally (no baseline data before Jan → "new", but comparable path)
    expect(summary.period.partial).toBe(false);
  });
});
