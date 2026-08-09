/**
 * `buildAccountsView` groups accounts by institution and, for credit cards,
 * carries the statement cycle the UI leans on most heavily (`currentPeriodSpendCents`
 * answers "what will this month's bill be?"). It had no direct test.
 *
 * The parts worth pinning: net position is signed by an account's *role*, never
 * by the raw balance sign (fixtures and providers disagree on a card's sign);
 * a cycle is emitted only for a credit card whose closing day is actually known
 * (the module deliberately refuses to infer one); and `dueDateFor` rolls the due
 * month past December into the next January — arithmetic the 2026 fixtures, which
 * never cross a year boundary in a statement cycle, would not exercise.
 */
import { describe, expect, it } from "vitest";
import { buildAccountsView } from "../src";
import type { Account, Transaction } from "../src";

function account(over: Partial<Account> & Pick<Account, "id">): Account {
  return {
    displayName: over.id,
    institutionName: "Test Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 0,
    includeInForecast: true,
    freshness: { status: "fresh", asOf: "2026-08-01", source: "fixture", warnings: [] },
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

const findInstitution = (view: ReturnType<typeof buildAccountsView>, name: string) => {
  const inst = view.institutions.find((i) => i.displayName === name);
  expect(inst).toBeDefined();
  return inst!;
};

describe("buildAccountsView — net position", () => {
  it("signs each account by its role, not the raw balance sign, and excludes what it should", () => {
    const view = buildAccountsView({
      accounts: [
        account({ id: "chk", institutionName: "Chase", currentBalanceCents: 120_000 }),
        account({ id: "sav", institutionName: "Chase", type: "savings", role: "reserve_cash", currentBalanceCents: 50_000 }),
        // Card balance stored as a positive "amount owed"; role, not sign, makes it a debt.
        account({ id: "card", institutionName: "Amex", type: "credit_card", role: "liability", currentBalanceCents: 30_000 }),
        account({ id: "hidden", institutionName: "Chase", role: "excluded", currentBalanceCents: 99_999 }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    // 120000 + 50000 − 30000 + 0(excluded) = 140000.
    expect(view.netPositionCents).toBe(140_000);
    expect(view.netPositionLabel).toBe("Cash, minus what you owe on cards");
  });

  it("still treats a card as a debt when its raw balance is negative", () => {
    const view = buildAccountsView({
      accounts: [
        account({ id: "chk", currentBalanceCents: 100_000 }),
        account({ id: "card", type: "credit_card", role: "liability", currentBalanceCents: -40_000 }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    // magnitude 40000 subtracted regardless of the minus sign: 100000 − 40000.
    expect(view.netPositionCents).toBe(60_000);
  });
});

describe("buildAccountsView — institution grouping and per-account view", () => {
  it("groups accounts under their institution and derives a 4-digit mask from the name", () => {
    const view = buildAccountsView({
      accounts: [
        account({ id: "chk", institutionName: "Chase", displayName: "Chase Checking 1234", currentBalanceCents: 10_000 }),
        account({ id: "sav", institutionName: "Chase", displayName: "Chase Savings", type: "savings", role: "reserve_cash", currentBalanceCents: 20_000 }),
        account({ id: "card", institutionName: "Amex", displayName: "Amex Gold 9999", type: "credit_card", role: "liability", currentBalanceCents: 5_000 }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    const chase = findInstitution(view, "Chase");
    expect(chase.accounts.map((a) => a.id).sort()).toEqual(["chk", "sav"]);
    expect(chase.accounts.find((a) => a.id === "chk")!.mask).toBe("1234");
    expect(chase.accounts.find((a) => a.id === "sav")!.mask).toBeUndefined(); // no trailing digits

    const amex = findInstitution(view, "Amex");
    const card = amex.accounts[0]!;
    expect(card.isDebt).toBe(true);
    expect(card.currentBalanceCents).toBe(5_000); // always the magnitude
    expect(card.netContributionCents).toBe(-5_000); // signed by role
  });
});

describe("buildAccountsView — connection status", () => {
  it("takes the worst connection status across an institution's accounts", () => {
    const view = buildAccountsView({
      accounts: [
        account({ id: "a", institutionName: "Chase", freshness: { status: "fresh", asOf: "2026-08-01", source: "fixture", warnings: [] } }),
        account({ id: "b", institutionName: "Chase", freshness: { status: "stale", asOf: "2026-07-01", source: "fixture", warnings: [] } }),
        account({ id: "c", institutionName: "Chase", freshness: { status: "missing", source: "fixture", warnings: [] } }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    // A single missing account drags the whole institution to "disconnected"
    // rather than being hidden by its healthy sibling.
    expect(findInstitution(view, "Chase").connectionStatus).toBe("disconnected");
  });

  it("maps freshness statuses to connection states, including the syncing fallback", () => {
    const view = buildAccountsView({
      accounts: [
        account({ id: "h", institutionName: "Healthy", freshness: { status: "usable", asOf: "2026-08-01", source: "fixture", warnings: [] } }),
        account({ id: "s", institutionName: "Syncing", freshness: { status: "estimated", asOf: "2026-08-01", source: "fixture", warnings: [] } }),
        account({ id: "n", institutionName: "Attention", freshness: { status: "stale", asOf: "2026-06-01", source: "fixture", warnings: [] } }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    expect(findInstitution(view, "Healthy").connectionStatus).toBe("healthy");
    expect(findInstitution(view, "Syncing").connectionStatus).toBe("syncing");
    expect(findInstitution(view, "Attention").connectionStatus).toBe("needs_attention");
  });
});

describe("buildAccountsView — statement cycle", () => {
  it("nets refunds against spend within the current statement period and derives the due date", () => {
    const view = buildAccountsView({
      accounts: [
        account({
          id: "card",
          institutionName: "Amex",
          type: "credit_card",
          role: "liability",
          currentBalanceCents: 70_000,
          statementCycle: { closingDay: 18, dueDayOfMonth: 5, lastStatementBalanceCents: 200_000, source: "user_provided" },
        }),
      ],
      transactions: [
        // Current period for a 2026-08-10 as-of with an 18th close is 2026-07-19 .. 2026-08-18.
        tx({ id: "s1", accountId: "card", amountCents: -5_000, flowType: "SPEND", postedDate: "2026-08-10" }),
        tx({ id: "s2", accountId: "card", amountCents: -3_000, flowType: "SPEND", postedDate: "2026-08-05" }),
        tx({ id: "r1", accountId: "card", amountCents: 1_000, flowType: "REFUND", postedDate: "2026-08-08" }),
        // Before the period opens (previous cycle) — must not count.
        tx({ id: "old", accountId: "card", amountCents: -99_999, flowType: "SPEND", postedDate: "2026-06-01" }),
      ],
      currency: "USD",
      asOfDate: "2026-08-10",
    });

    const cycle = findInstitution(view, "Amex").accounts[0]!.statementCycle!;
    expect(cycle.closingDay).toBe(18);
    expect(cycle.currentPeriodSpendCents).toBe(7_000); // 5000 + 3000 − 1000 refund
    expect(cycle.currentPeriodEnd).toBe("2026-08-18");
    expect(cycle.dueDate).toBe("2026-09-05"); // month after the close
    expect(cycle.lastStatementBalanceCents).toBe(200_000);
    expect(cycle.source).toBe("user_provided");
  });

  it("rolls the due date into the next year when the period closes in December", () => {
    const view = buildAccountsView({
      accounts: [
        account({
          id: "card",
          institutionName: "Amex",
          type: "credit_card",
          role: "liability",
          statementCycle: { closingDay: 18, dueDayOfMonth: 5, source: "plaid" },
        }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-12-10", // period 2026-11-19 .. 2026-12-18
    });

    const cycle = findInstitution(view, "Amex").accounts[0]!.statementCycle!;
    expect(cycle.currentPeriodEnd).toBe("2026-12-18");
    expect(cycle.dueDate).toBe("2027-01-05"); // December + 1 month crosses the year
  });

  it("omits the cycle when the closing day is unknown or the account is not a card", () => {
    const view = buildAccountsView({
      accounts: [
        // A card with no cycle: the module refuses to infer one.
        account({ id: "card", institutionName: "Amex", type: "credit_card", role: "liability" }),
        // A checking account carrying a stray cycle: not a card, so no cycle view.
        account({ id: "chk", institutionName: "Chase", statementCycle: { closingDay: 18, source: "user_provided" } }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    expect(findInstitution(view, "Amex").accounts[0]!.statementCycle).toBeUndefined();
    expect(findInstitution(view, "Chase").accounts[0]!.statementCycle).toBeUndefined();
  });

  it("leaves the due date undefined when no due day is configured", () => {
    const view = buildAccountsView({
      accounts: [
        account({
          id: "card",
          institutionName: "Amex",
          type: "credit_card",
          role: "liability",
          statementCycle: { closingDay: 18, source: "user_provided" },
        }),
      ],
      transactions: [],
      currency: "USD",
      asOfDate: "2026-08-20",
    });

    expect(findInstitution(view, "Amex").accounts[0]!.statementCycle!.dueDate).toBeUndefined();
  });
});
