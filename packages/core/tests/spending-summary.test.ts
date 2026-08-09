/**
 * `summarizeSpending` is the engine behind "Where is my money going?" (`D-011`)
 * for every period kind — week, month, year, statement. It had no direct core
 * test; the only cover was the server route integration and the *separate*
 * month-only `summarizeMonthlySpending` (see `monthly-spending.test.ts`).
 *
 * Its own header states it "generalises `summarizeMonthlySpending` from calendar
 * months to any period kind." That contract is a live invariant: for `kind:
 * "month"` the two implementations must agree on the shared money figures, or the
 * app has two disagreeing sources of truth for the headline number. The first
 * test pins that parity against the fixture the month engine is already trusted
 * on. The rest exercise what only `summarizeSpending` can do — non-month periods
 * (on 2021 dates, so the ISO-week arithmetic is real, not the forgiving 2026
 * calendar) and the trust/refund/share rules directly.
 */
import { describe, expect, it } from "vitest";
import pivotFixture from "../fixtures/mvp0/where-is-my-money-going-multi-account.json";
import { summarizeMonthlySpending, summarizeSpending, spendingSeries } from "../src";
import type { Account, AffordabilityRequest, FinancialSnapshot, Transaction } from "../src";

const snapshot = (pivotFixture.input as AffordabilityRequest).snapshot as FinancialSnapshot;

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

describe("summarizeSpending — parity with the month engine", () => {
  it("agrees with summarizeMonthlySpending on every shared figure for a calendar month", () => {
    const monthly = summarizeMonthlySpending(
      snapshot.transactions,
      snapshot.currency,
      snapshot.accounts,
    );
    const august = monthly.find((m) => m.month === "2026-08")!;

    const summary = summarizeSpending({
      transactions: snapshot.transactions,
      accounts: snapshot.accounts,
      currency: snapshot.currency,
      // After August, so the month is complete and the comparison is honest.
      asOfDate: "2026-09-15",
      kind: "month",
      key: "2026-08",
    });

    // The headline money figures must be identical between the two engines.
    expect(summary.totalOutflowCents).toBe(august.totalOutflowCents);
    expect(summary.grossOutflowCents).toBe(august.grossOutflowCents);
    expect(summary.totalInflowCents).toBe(august.totalInflowCents);
    expect(summary.refundCents).toBe(august.refundCents);
    expect(summary.excludedTransferOutflowCents).toBe(august.excludedTransferOutflowCents);
    expect(summary.excludedCreditCardPaymentOutflowCents).toBe(
      august.excludedCreditCardPaymentOutflowCents,
    );
    expect(summary.unclassifiedOutflowCents).toBe(august.unclassifiedOutflowCents);

    // And the concrete fixture expectations, so a change to either engine trips.
    expect(summary.totalOutflowCents).toBe(270_689);
    expect(summary.grossOutflowCents).toBe(277_489);
    expect(summary.excludedCreditCardPaymentOutflowCents).toBe(224_000);

    // Per-category net outflow must match category-for-category.
    const monthlyByCategory = new Map(august.categoryTotals.map((c) => [c.category, c.outflowCents]));
    for (const c of summary.categoryTotals) {
      expect(c.outflowCents).toBe(monthlyByCategory.get(c.category));
    }
    expect(summary.categoryTotals.length).toBe(august.categoryTotals.length);

    // Per-account and per-institution outflow attribution must match too.
    const monthlyByAccount = new Map(august.accountTotals.map((a) => [a.id, a.totalOutflowCents]));
    for (const a of summary.accountTotals) {
      expect(a.totalOutflowCents).toBe(monthlyByAccount.get(a.id));
    }
    const monthlyByInstitution = new Map(
      august.institutionTotals.map((i) => [i.displayName, i.totalOutflowCents]),
    );
    for (const i of summary.institutionTotals) {
      expect(i.totalOutflowCents).toBe(monthlyByInstitution.get(i.displayName));
    }

    // The baseline-vs-recent comparison lands on the same numbers, reached via a
    // default 3-period window that naturally narrows to the two months with data.
    expect(summary.comparison).toMatchObject({
      direction: "up",
      comparable: true,
      baselinePeriodCount: 2,
      baselineAverageOutflowCents: 233_097,
      outflowChangeCents: 37_592,
    });
  });
});

describe("summarizeSpending — non-month periods and classification rules", () => {
  it("buckets an ISO week on its real Mon–Sun boundary (2021, not the forgiving 2026 calendar)", () => {
    // ISO week 2021-W24 is Mon 2021-06-14 .. Sun 2021-06-20.
    const acct = account({ id: "chk" });
    const transactions = [
      tx({ id: "before", accountId: "chk", amountCents: -9_999, category: "x", flowType: "SPEND", postedDate: "2021-06-13" }), // W23 (Sun)
      tx({ id: "mon", accountId: "chk", amountCents: -1_000, category: "dining", flowType: "SPEND", postedDate: "2021-06-14" }),
      tx({ id: "wed", accountId: "chk", amountCents: -2_000, category: "dining", flowType: "SPEND", postedDate: "2021-06-16" }),
      tx({ id: "sun", accountId: "chk", amountCents: -500, category: "coffee", flowType: "SPEND", postedDate: "2021-06-20" }),
      tx({ id: "after", accountId: "chk", amountCents: -8_888, category: "x", flowType: "SPEND", postedDate: "2021-06-21" }), // W25 (Mon)
    ];

    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-06-28", // week complete
      kind: "week",
      key: "2021-W24",
    });

    expect(summary.period.key).toBe("2021-W24");
    expect(summary.totalOutflowCents).toBe(3_500); // 1000 + 2000 + 500, the neighbours excluded
  });

  it("nets refunds within a category and computes share in basis points so the UI never divides", () => {
    const acct = account({ id: "chk" });
    const transactions = [
      tx({ id: "d1", accountId: "chk", amountCents: -6_000, category: "dining", flowType: "SPEND", postedDate: "2021-05-05" }),
      tx({ id: "d2", accountId: "chk", amountCents: 1_000, category: "dining", flowType: "REFUND", postedDate: "2021-05-12" }),
      tx({ id: "g1", accountId: "chk", amountCents: -4_000, category: "groceries", flowType: "SPEND", postedDate: "2021-05-09" }),
    ];

    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-06-01",
      kind: "month",
      key: "2021-05",
    });

    expect(summary.totalOutflowCents).toBe(9_000); // (6000+4000) gross − 1000 refund
    expect(summary.grossOutflowCents).toBe(10_000);
    expect(summary.refundCents).toBe(1_000);

    const dining = summary.categoryTotals.find((c) => c.category === "dining")!;
    expect(dining).toMatchObject({
      outflowCents: 5_000, // 6000 − 1000
      grossOutflowCents: 6_000,
      refundCents: 1_000,
      transactionCount: 1, // the refund does not count as a spend transaction
    });
    // Shares are net-outflow / total-outflow in basis points and here sum to 10000.
    expect(dining.shareBasisPoints).toBe(5_556); // round(5000/9000 * 10000)
    const groceries = summary.categoryTotals.find((c) => c.category === "groceries")!;
    expect(groceries.shareBasisPoints).toBe(4_444); // round(4000/9000 * 10000)
  });

  it("trusts only a linked, high-confidence transfer and surfaces the rest as unclassified outflow", () => {
    const chk = account({ id: "chk" });
    const sav = account({ id: "sav", type: "savings", role: "reserve_cash" });
    const transactions = [
      tx({ id: "spend", accountId: "chk", amountCents: -3_000, category: "dining", flowType: "SPEND", postedDate: "2021-08-03" }),
      // Trusted: counter is a connected account and confidence clears the 0.8 floor.
      tx({ id: "trusted", accountId: "chk", amountCents: -10_000, category: "transfer", flowType: "TRANSFER_OUT", postedDate: "2021-08-04", counterAccountId: "sav", transferMatchConfidence: 0.8 }),
      // Untrusted — low confidence.
      tx({ id: "lowconf", accountId: "chk", amountCents: -40_000, category: "transfer", flowType: "TRANSFER_OUT", postedDate: "2021-08-05", counterAccountId: "sav", transferMatchConfidence: 0.2 }),
      // Untrusted — no counter account at all.
      tx({ id: "nocounter", accountId: "chk", amountCents: -20_000, category: "transfer", flowType: "TRANSFER_OUT", postedDate: "2021-08-06" }),
    ];

    const summary = summarizeSpending({
      transactions,
      accounts: [chk, sav],
      currency: "USD",
      asOfDate: "2021-09-01",
      kind: "month",
      key: "2021-08",
    });

    expect(summary.totalOutflowCents).toBe(3_000); // only the real spend
    expect(summary.excludedTransferOutflowCents).toBe(10_000); // only the trusted transfer
    expect(summary.unclassifiedOutflowCents).toBe(60_000); // 40000 + 20000, never silently dropped
    expect(summary.unclassifiedCount).toBe(2);
  });

  it("counts a trusted transfer to a card as an excluded credit-card payment", () => {
    const chk = account({ id: "chk" });
    const card = account({ id: "card", type: "credit_card", role: "liability" });
    const transactions = [
      tx({ id: "pay", accountId: "chk", amountCents: -50_000, category: "credit_card_payment", flowType: "TRANSFER_OUT", postedDate: "2021-08-15", counterAccountId: "card", transferMatchConfidence: 1 }),
    ];

    const summary = summarizeSpending({
      transactions,
      accounts: [chk, card],
      currency: "USD",
      asOfDate: "2021-09-01",
      kind: "month",
      key: "2021-08",
    });

    expect(summary.totalOutflowCents).toBe(0); // a card payment is not spending
    expect(summary.excludedTransferOutflowCents).toBe(50_000);
    expect(summary.excludedCreditCardPaymentOutflowCents).toBe(50_000);
  });

  it("refuses to compare a still-filling period against complete ones", () => {
    const acct = account({ id: "chk" });
    const transactions = [
      tx({ id: "jun", accountId: "chk", amountCents: -5_000, category: "dining", flowType: "SPEND", postedDate: "2021-06-10" }),
      tx({ id: "jul", accountId: "chk", amountCents: -9_000, category: "dining", flowType: "SPEND", postedDate: "2021-07-05" }),
    ];

    const summary = summarizeSpending({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-07-10", // ten days into July: the month is partial
      kind: "month",
      key: "2021-07",
    });

    // A baseline exists (June), but a fall/rise this early would be a calendar
    // artefact, so the comparison is neutered rather than misleading.
    expect(summary.period.partial).toBe(true);
    expect(summary.comparison.comparable).toBe(false);
    expect(summary.comparison.direction).toBe("flat");
    expect(summary.comparison.outflowChangeCents).toBe(0);
  });
});

describe("spendingSeries", () => {
  it("returns one point per recent period with correct partial flags and a per-category series", () => {
    const acct = account({ id: "chk" });
    const transactions = [
      tx({ id: "apr", accountId: "chk", amountCents: -3_000, category: "dining", flowType: "SPEND", postedDate: "2021-04-15" }),
      tx({ id: "may", accountId: "chk", amountCents: -4_000, category: "dining", flowType: "SPEND", postedDate: "2021-05-15" }),
      tx({ id: "jun", accountId: "chk", amountCents: -5_000, category: "groceries", flowType: "SPEND", postedDate: "2021-06-10" }),
    ];

    const series = spendingSeries({
      transactions,
      accounts: [acct],
      currency: "USD",
      asOfDate: "2021-06-20", // mid-June: the current period is partial
      kind: "month",
      count: 3,
    });

    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.key).sort()).toEqual(["2021-04", "2021-05", "2021-06"]);

    const byKey = new Map(series.points.map((p) => [p.key, p]));
    expect(byKey.get("2021-04")!.totalOutflowCents).toBe(3_000);
    expect(byKey.get("2021-05")!.totalOutflowCents).toBe(4_000);
    expect(byKey.get("2021-06")!.totalOutflowCents).toBe(5_000);

    // Only the current, still-filling month is partial.
    expect(byKey.get("2021-06")!.partial).toBe(true);
    expect(byKey.get("2021-05")!.partial).toBe(false);

    const categories = series.categorySeries.map((c) => c.category).sort();
    expect(categories).toEqual(["dining", "groceries"]);
    for (const c of series.categorySeries) {
      expect(c.points).toHaveLength(3); // every category carries a value for every period
    }
  });
});
