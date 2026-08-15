import { describe, expect, it } from "vitest";
import { buildSnapshotFromHistory } from "../src";
import type { Account, Transaction } from "../src";

const ACCOUNT: Account = {
  id: "acct_checking",
  displayName: "Everyday Checking",
  institutionName: "First National",
  type: "checking",
  role: "spendable_cash",
  currency: "USD",
  currentBalanceCents: 412_300,
  includeInForecast: true,
  freshness: { status: "usable", asOf: "2026-07-27", source: "csv", warnings: [] },
  source: "csv",
};

function tx(overrides: Partial<Transaction> & Pick<Transaction, "id" | "postedDate">): Transaction {
  return {
    accountId: ACCOUNT.id,
    merchantName: "Merchant",
    originalDescription: "Merchant",
    amountCents: -1000,
    currency: "USD",
    category: "shopping",
    flowType: "SPEND",
    freshness: { status: "usable", asOf: overrides.postedDate, source: "csv", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "csv",
    ...overrides,
  };
}

/** Three months of a biweekly paycheck and one monthly subscription. */
function history(): Transaction[] {
  const transactions: Transaction[] = [];
  const paydays = ["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12", "2026-06-26", "2026-07-10"];
  paydays.forEach((date, index) => {
    transactions.push(
      tx({
        id: `pay_${index}`,
        postedDate: date,
        merchantName: "ACME Payroll",
        normalizedMerchantId: "acme_payroll",
        amountCents: 320_000,
        category: "income",
        flowType: "INCOME",
      }),
    );
  });
  for (const [index, date] of ["2026-05-05", "2026-06-05", "2026-07-05"].entries()) {
    transactions.push(
      tx({
        id: `netflix_${index}`,
        postedDate: date,
        merchantName: "Netflix",
        normalizedMerchantId: "netflix",
        amountCents: -1599,
        category: "streaming",
      }),
    );
  }
  return transactions;
}

describe("buildSnapshotFromHistory", () => {
  it("derives income and recurring obligations from repeating transactions", () => {
    const { snapshot, notes } = buildSnapshotFromHistory({
      accounts: [ACCOUNT],
      transactions: history(),
      currency: "USD",
    });

    expect(snapshot.asOfDate).toBe("2026-07-10");
    expect(snapshot.incomeSources).toHaveLength(1);

    const income = snapshot.incomeSources[0]!;
    expect(income.cadence.kind).toBe("biweekly");
    expect(income.minimumExpectedAmountCents).toBe(320_000);
    // Every derived entity says it is derived — the engine's freshness and
    // coverage rules depend on being able to tell.
    expect(income.source).toBe("inferred");
    expect(income.uncertainty.isEstimated).toBe(true);
    // Never in the past: the forecast must not open on an event that already
    // happened.
    expect(income.nextExpectedDate > snapshot.asOfDate).toBe(true);

    expect(snapshot.recurringObligations.length).toBeGreaterThan(0);
    expect(snapshot.recurringObligations.every((o) => o.source === "inferred")).toBe(true);
    expect(notes.incomeSourceCount).toBe(1);
  });

  it("invents no goals or planned purchases", () => {
    const { snapshot } = buildSnapshotFromHistory({
      accounts: [ACCOUNT],
      transactions: history(),
      currency: "USD",
    });

    // Nothing in a bank statement declares an intention. A derived goal would
    // put a target the user never set into their forecast.
    expect(snapshot.goals).toEqual([]);
    expect(snapshot.plannedPurchases).toEqual([]);
  });

  it("reports coverage pessimistically", () => {
    const { snapshot } = buildSnapshotFromHistory({
      accounts: [ACCOUNT],
      transactions: history(),
      currency: "USD",
    });

    // An import knows about the accounts that were imported and nothing else.
    expect(snapshot.coverage.userConfirmedNoOtherRequiredObligations).toBe(false);
    expect(snapshot.coverage.transactionsCompleteFromDate).toBe("2026-05-01");
  });

  it("declares balances incomplete when an included account has none", () => {
    const estimated: Account = {
      ...ACCOUNT,
      freshness: { status: "estimated", asOf: "2026-07-27", source: "csv", warnings: [] },
    };

    const { snapshot, notes } = buildSnapshotFromHistory({
      accounts: [estimated],
      transactions: history(),
      currency: "USD",
    });

    expect(snapshot.coverage.balancesDeclaredComplete).toBe(false);
    expect(notes.accountsMissingBalance).toEqual(["Everyday Checking"]);
  });

  it("does not treat a one-off deposit as income", () => {
    const oneOff = [
      ...history(),
      tx({
        id: "gift",
        postedDate: "2026-06-02",
        merchantName: "Birthday Transfer",
        normalizedMerchantId: "birthday_transfer",
        amountCents: 20_000,
        category: "income",
        flowType: "INCOME",
      }),
    ];

    const { snapshot, notes } = buildSnapshotFromHistory({
      accounts: [ACCOUNT],
      transactions: oneOff,
      currency: "USD",
    });

    expect(snapshot.incomeSources.map((source) => source.label)).toEqual(["ACME Payroll"]);
    expect(notes.skippedForInsufficientHistory).toContain("Birthday Transfer");
  });

  it("collapses one subscription billed across several accounts into a single obligation (D-C13)", () => {
    // The subscription detector groups per (merchant, account), so a single
    // merchant charged from three imported accounts surfaces as three per-account
    // insights — all reducing to the same merchant-derived obligation id. That is
    // one recurring bill seen from three accounts, not three bills; leaving all
    // three in the snapshot would carry a duplicate key and make every downstream
    // consumer (the affordability gate, the cash-flow calendar) count it thrice.
    const accounts: Account[] = ["acct_a", "acct_b", "acct_c"].map((id) => ({
      ...ACCOUNT,
      id,
      displayName: id,
    }));
    const charges: Transaction[] = [];
    for (const account of accounts) {
      for (const [index, date] of ["2026-05-06", "2026-06-06", "2026-07-06"].entries()) {
        charges.push(
          tx({
            id: `gym_${account.id}_${index}`,
            accountId: account.id,
            postedDate: date,
            merchantName: "GymCo",
            normalizedMerchantId: "gymco",
            amountCents: -2_500,
            category: "streaming",
          }),
        );
      }
    }

    const { snapshot, notes } = buildSnapshotFromHistory({
      accounts,
      transactions: charges,
      currency: "USD",
    });

    const gymObligations = snapshot.recurringObligations.filter(
      (obligation) => obligation.id === "obligation_inferred_gymco",
    );
    expect(gymObligations).toHaveLength(1);
    expect(gymObligations[0]!.amountCents).toBe(2_500); // the single bill, not 3×
    // The id is a unique key across the whole obligation set.
    const ids = snapshot.recurringObligations.map((obligation) => obligation.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(notes.recurringObligationCount).toBe(snapshot.recurringObligations.length);
  });

  it("skips deposits that repeat at no recognisable interval", () => {
    const irregular = [
      tx({ id: "f1", postedDate: "2026-05-02", merchantName: "Freelance", normalizedMerchantId: "freelance", amountCents: 50_000, category: "income", flowType: "INCOME" }),
      tx({ id: "f2", postedDate: "2026-05-19", merchantName: "Freelance", normalizedMerchantId: "freelance", amountCents: 90_000, category: "income", flowType: "INCOME" }),
      tx({ id: "f3", postedDate: "2026-07-01", merchantName: "Freelance", normalizedMerchantId: "freelance", amountCents: 20_000, category: "income", flowType: "INCOME" }),
    ];

    const { snapshot } = buildSnapshotFromHistory({
      accounts: [ACCOUNT],
      transactions: irregular,
      currency: "USD",
    });

    // 17 days, then 43. Calling that "monthly" would put a paycheck in the
    // forecast that isn't coming.
    expect(snapshot.incomeSources).toEqual([]);
  });
});
