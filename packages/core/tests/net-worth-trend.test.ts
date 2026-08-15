/**
 * `buildNetWorthTrend` reconstructs a month-by-month cash-net-worth line by
 * back-casting from today's balances, overlaid with any recorded snapshots.
 *
 * What's worth pinning, and why 2022 dates (never the 2026 fixture): the whole
 * feature turns on a sign rule — `cashDirection(flowType) × |amount|` — applied
 * across asset *and* liability accounts and across a year of month boundaries.
 * That is precisely the kind of arithmetic a single present-dated fixture never
 * exercises, so every figure below is hand-computed on 2022 data:
 *   - back-cast at the current month equals today's balance (nothing to unwind);
 *   - unwinding income shows a lower past balance; unwinding a card charge shows
 *     less debt earlier; a card paydown lifts net worth toward today;
 *   - an internal transfer / card payment shifts cash and debt but never the net;
 *   - the line starts only where every account has transaction coverage;
 *   - a recorded snapshot supersedes the back-cast for its month.
 */
import { describe, expect, it } from "vitest";
import { buildAccountsView, buildNetWorthTrend, currentNetWorthObservation } from "../src";
import type { Account, NetWorthSnapshot, Transaction } from "../src";

function account(over: Partial<Account> & Pick<Account, "id">): Account {
  return {
    displayName: over.id,
    institutionName: "Test Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 0,
    includeInForecast: true,
    freshness: { status: "fresh", asOf: "2022-01-01", source: "fixture", warnings: [] },
    source: "fixture",
    ...over,
  };
}

function tx(
  over: Partial<Transaction> &
    Pick<Transaction, "id" | "accountId" | "amountCents" | "flowType" | "postedDate">,
): Transaction {
  return {
    merchantName: "Merchant",
    normalizedMerchantId: "merchant",
    category: "shopping",
    currency: "USD",
    freshness: { status: "fresh", asOf: over.postedDate, source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...over,
  };
}

const netByMonth = (t: ReturnType<typeof buildNetWorthTrend>) =>
  Object.fromEntries(t.points.map((p) => [p.month, p.netWorthCents]));

describe("buildNetWorthTrend — back-casting", () => {
  it("unwinds income to show a lower past balance and marks the current month recorded", () => {
    // Checking ends at $1,000 after three $400 paychecks. Before each, it held less.
    const trend = buildNetWorthTrend({
      accounts: [account({ id: "chk", currentBalanceCents: 100_000 })],
      transactions: [
        tx({ id: "a", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-04-10" }),
        tx({ id: "b", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-05-10" }),
        tx({ id: "c", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-06-10" }),
      ],
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-06-10",
    });

    expect(trend.points.map((p) => [p.month, p.netWorthCents, p.basis])).toEqual([
      ["2022-04", 20_000, "reconstructed"], // after Apr income; May+Jun unwound
      ["2022-05", 60_000, "reconstructed"], // after May income; Jun unwound
      ["2022-06", 100_000, "recorded"], // current month = live balance
    ]);
    expect(trend.currentNetWorthCents).toBe(100_000);
    expect(trend.changeCents).toBe(80_000);
    expect(trend.coverageStartMonth).toBe("2022-04");
    expect(trend.monthsCovered).toBe(3);
  });

  it("back-casts a credit card: more owed before a paydown, less debt today", () => {
    const trend = buildNetWorthTrend({
      accounts: [
        account({ id: "chk", currentBalanceCents: 100_000 }), // flat: no transactions
        account({ id: "card", type: "credit_card", role: "liability", currentBalanceCents: 30_000 }),
      ],
      transactions: [
        tx({ id: "charge", accountId: "card", flowType: "SPEND", amountCents: 20_000, postedDate: "2022-05-15" }),
        // A $250 payment into the card in June reduced what's owed.
        tx({ id: "pay", accountId: "card", flowType: "TRANSFER_IN", amountCents: 25_000, postedDate: "2022-06-10" }),
      ],
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-06-10",
    });

    // Coverage starts May (the card's first transaction); checking is flat at 1000.
    expect(trend.points).toEqual([
      { month: "2022-05", monthEndDate: "2022-05-31", netWorthCents: 45_000, cashCents: 100_000, debtCents: 55_000, basis: "reconstructed" },
      { month: "2022-06", monthEndDate: "2022-06-30", netWorthCents: 70_000, cashCents: 100_000, debtCents: 30_000, basis: "recorded" },
    ]);
    expect(trend.currentNetWorthCents).toBe(70_000);
    expect(trend.changeCents).toBe(25_000); // paying the card down lifted net worth
  });

  it("an internal transfer shifts cash and debt but leaves net worth untouched", () => {
    const base = {
      accounts: [
        account({ id: "chk", currentBalanceCents: 100_000 }),
        account({ id: "card", type: "credit_card", role: "liability", currentBalanceCents: 5_000 }),
      ],
      transactions: [
        tx({ id: "inc", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-03-02" }),
        tx({ id: "buy", accountId: "card", flowType: "SPEND", amountCents: 8_000, postedDate: "2022-03-10" }),
      ],
      snapshots: [] as NetWorthSnapshot[],
      currency: "USD",
      asOfDate: "2022-05-31",
    };
    const before = buildNetWorthTrend(base);

    // A $30 card payment in April: cash out of checking, same amount off the card.
    const after = buildNetWorthTrend({
      ...base,
      transactions: [
        ...base.transactions,
        tx({ id: "pay-out", accountId: "chk", flowType: "TRANSFER_OUT", amountCents: 3_000, postedDate: "2022-04-15" }),
        tx({ id: "pay-in", accountId: "card", flowType: "TRANSFER_IN", amountCents: 3_000, postedDate: "2022-04-15" }),
      ],
    });

    // Every month's net worth is identical...
    expect(netByMonth(after)).toEqual(netByMonth(before));
    // ...even though March now reconstructs more cash AND more debt (the payment
    // hadn't happened yet), which cancel exactly.
    const marchBefore = before.points.find((p) => p.month === "2022-03")!;
    const marchAfter = after.points.find((p) => p.month === "2022-03")!;
    expect(marchAfter.cashCents).toBe(marchBefore.cashCents + 3_000);
    expect(marchAfter.debtCents).toBe(marchBefore.debtCents + 3_000);
    expect(marchAfter.netWorthCents).toBe(marchBefore.netWorthCents);
  });

  it("starts the line only where every account has transaction coverage", () => {
    const trend = buildNetWorthTrend({
      accounts: [
        account({ id: "old", currentBalanceCents: 80_000 }),
        account({ id: "new", type: "savings", role: "reserve_cash", currentBalanceCents: 20_000 }),
      ],
      transactions: [
        tx({ id: "o1", accountId: "old", flowType: "INCOME", amountCents: 10_000, postedDate: "2022-02-05" }),
        tx({ id: "o2", accountId: "old", flowType: "SPEND", amountCents: 5_000, postedDate: "2022-05-20" }),
        // The savings account's history only begins in May.
        tx({ id: "n1", accountId: "new", flowType: "TRANSFER_IN", amountCents: 20_000, postedDate: "2022-05-08" }),
      ],
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-05-20",
    });

    // Not February — the newer account has no coverage before May, so the honest
    // line begins there rather than pretending the savings account held nothing.
    expect(trend.coverageStartMonth).toBe("2022-05");
    expect(trend.points.map((p) => p.month)).toEqual(["2022-05"]);
  });

  it("caps the window to maxMonths, dropping the oldest months", () => {
    const trend = buildNetWorthTrend({
      accounts: [account({ id: "chk", currentBalanceCents: 100_000 })],
      transactions: ["2022-01", "2022-02", "2022-03", "2022-04", "2022-05", "2022-06"].map((m, i) =>
        tx({ id: `t${i}`, accountId: "chk", flowType: "INCOME", amountCents: 10_000, postedDate: `${m}-10` }),
      ),
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-06-15",
      maxMonths: 3,
    });

    expect(trend.monthsCovered).toBe(3);
    expect(trend.coverageStartMonth).toBe("2022-04"); // Jun, back three months
    expect(trend.points.map((p) => p.month)).toEqual(["2022-04", "2022-05", "2022-06"]);
  });
});

describe("buildNetWorthTrend — recorded snapshots", () => {
  const dataset = {
    accounts: [account({ id: "chk", currentBalanceCents: 100_000 })],
    transactions: [
      tx({ id: "a", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-04-10" }),
      tx({ id: "b", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-05-10" }),
      tx({ id: "c", accountId: "chk", flowType: "INCOME", amountCents: 40_000, postedDate: "2022-06-10" }),
    ],
    currency: "USD",
    asOfDate: "2022-06-10",
  };

  it("supersedes the back-cast for a month it covers, and flags it recorded", () => {
    const trend = buildNetWorthTrend({
      ...dataset,
      snapshots: [
        { observedDate: "2022-05-20", currency: "USD", netWorthCents: 61_234, cashCents: 61_234, debtCents: 0 },
      ],
    });
    const may = trend.points.find((p) => p.month === "2022-05")!;
    expect(may).toMatchObject({ netWorthCents: 61_234, basis: "recorded" });
    // Neighbouring months stay reconstructed.
    expect(trend.points.find((p) => p.month === "2022-04")!.basis).toBe("reconstructed");
  });

  it("takes the newest snapshot when a month has more than one", () => {
    const trend = buildNetWorthTrend({
      ...dataset,
      snapshots: [
        { observedDate: "2022-05-05", currency: "USD", netWorthCents: 50_000, cashCents: 50_000, debtCents: 0 },
        { observedDate: "2022-05-25", currency: "USD", netWorthCents: 61_234, cashCents: 61_234, debtCents: 0 },
      ],
    });
    expect(trend.points.find((p) => p.month === "2022-05")!.netWorthCents).toBe(61_234);
  });

  it("ignores snapshots in another currency", () => {
    const trend = buildNetWorthTrend({
      ...dataset,
      snapshots: [
        { observedDate: "2022-05-20", currency: "EUR", netWorthCents: 999_999, cashCents: 999_999, debtCents: 0 },
      ],
    });
    expect(trend.points.find((p) => p.month === "2022-05")!.netWorthCents).toBe(60_000);
  });
});

describe("buildNetWorthTrend — scope & edges", () => {
  it("excludes investment and excluded accounts from cash net worth", () => {
    const trend = buildNetWorthTrend({
      accounts: [
        account({ id: "chk", currentBalanceCents: 100_000 }),
        account({ id: "brokerage", type: "investment", role: "reserve_cash", currentBalanceCents: 500_000 }),
        account({ id: "ignored", role: "excluded", currentBalanceCents: 999_999 }),
      ],
      transactions: [],
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-06-10",
    });
    // Only the checking balance counts — not the half-million in the brokerage.
    expect(trend.currentNetWorthCents).toBe(100_000);
  });

  it("reports no data when there is no cash or debt account to trend", () => {
    const trend = buildNetWorthTrend({
      accounts: [account({ id: "brokerage", type: "investment", currentBalanceCents: 500_000 })],
      transactions: [],
      snapshots: [],
      currency: "USD",
      asOfDate: "2022-06-10",
    });
    expect(trend).toMatchObject({
      hasData: false,
      points: [],
      currentNetWorthCents: 0,
      coverageStartMonth: null,
      monthsCovered: 0,
    });
  });

  it("matches the Accounts headline for a cash + card set (same sign convention)", () => {
    const accounts = [
      account({ id: "chk", currentBalanceCents: 120_000 }),
      account({ id: "sav", type: "savings", role: "reserve_cash", currentBalanceCents: 50_000 }),
      // Card owed stored as a positive number; role, not sign, makes it a debt.
      account({ id: "card", type: "credit_card", role: "liability", currentBalanceCents: 30_000 }),
    ];
    const headline = buildAccountsView({ accounts, transactions: [], currency: "USD", asOfDate: "2022-06-10" });
    const trend = buildNetWorthTrend({ accounts, transactions: [], snapshots: [], currency: "USD", asOfDate: "2022-06-10" });
    expect(trend.currentNetWorthCents).toBe(headline.netPositionCents);
    expect(trend.currentNetWorthCents).toBe(140_000);
  });
});

describe("currentNetWorthObservation", () => {
  it("computes cash, debt and the latest observation date", () => {
    const snapshot = currentNetWorthObservation({
      accounts: [
        account({
          id: "chk",
          currentBalanceCents: 100_000,
          freshness: { status: "fresh", asOf: "2022-06-15T08:30:00Z", source: "plaid", warnings: [] },
        }),
        account({
          id: "card",
          type: "credit_card",
          role: "liability",
          currentBalanceCents: 20_000,
          freshness: { status: "fresh", asOf: "2022-06-10", source: "plaid", warnings: [] },
        }),
      ],
      currency: "USD",
      asOfDate: "2022-06-01",
    });
    expect(snapshot).toEqual({
      observedDate: "2022-06-15", // latest asOf, reduced from the timestamp
      currency: "USD",
      netWorthCents: 80_000,
      cashCents: 100_000,
      debtCents: 20_000,
    });
  });

  it("falls back to asOfDate when no balance carries a freshness date", () => {
    const snapshot = currentNetWorthObservation({
      accounts: [
        account({
          id: "chk",
          currentBalanceCents: 100_000,
          freshness: { status: "fresh", source: "manual", warnings: [] },
        }),
      ],
      currency: "USD",
      asOfDate: "2022-06-01",
    });
    expect(snapshot?.observedDate).toBe("2022-06-01");
  });

  it("returns null when there is nothing to trend", () => {
    expect(
      currentNetWorthObservation({
        accounts: [account({ id: "brokerage", type: "investment", currentBalanceCents: 500_000 })],
        currency: "USD",
        asOfDate: "2022-06-01",
      }),
    ).toBeNull();
  });
});
