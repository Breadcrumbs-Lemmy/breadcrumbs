/**
 * `queryTransactions` is the drill-down behind every aggregate and is called from
 * two places — the `/api/v1/transactions` route and the AI agent's transaction
 * tool. The server route has end-to-end cover, but the edge cases that make the
 * list *trustworthy* live in this pure function: it resolves each movement's
 * effective flow (so an untrusted transfer reads as UNCLASSIFIED, not a confident
 * TRANSFER_OUT), it sorts and paginates deterministically, and it survives a
 * malformed cursor. Those are exercised directly here so a regression surfaces at
 * the unit boundary rather than as a mystery in a screenshot.
 */
import { describe, expect, it } from "vitest";
import { queryTransactions } from "../src";
import type { Account, Transaction } from "../src";

function tx(
  overrides: Partial<Transaction> & Pick<Transaction, "id" | "accountId" | "amountCents">,
): Transaction {
  return {
    postedDate: "2026-06-15",
    merchantName: "Merchant",
    currency: "USD",
    category: "shopping",
    flowType: "SPEND",
    freshness: { status: "usable", asOf: "2026-06-15T00:00:00.000Z", source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...overrides,
  };
}

function account(id: string, displayName: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    displayName,
    institutionName: "Local Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 100_000,
    includeInForecast: true,
    freshness: { status: "usable", asOf: "2026-06-15T00:00:00.000Z", source: "fixture", warnings: [] },
    source: "fixture",
    ...overrides,
  };
}

const accounts: Account[] = [
  account("acct_checking", "Local Checking"),
  account("acct_savings", "Local Savings", { type: "savings", role: "reserve_cash" }),
];

const ids = (page: { transactions: { id: string }[] }) => page.transactions.map((t) => t.id);

describe("queryTransactions", () => {
  it("sorts newest-first and breaks ties by id so pagination is deterministic", () => {
    const page = queryTransactions({
      accounts,
      transactions: [
        tx({ id: "b", accountId: "acct_checking", amountCents: -100, postedDate: "2026-06-10" }),
        tx({ id: "a", accountId: "acct_checking", amountCents: -200, postedDate: "2026-06-10" }),
        tx({ id: "z", accountId: "acct_checking", amountCents: -300, postedDate: "2026-06-12" }),
      ],
    });
    // Newest date leads; the two same-day rows fall back to ascending id.
    expect(ids(page)).toEqual(["z", "a", "b"]);
  });

  it("walks pages via an opaque cursor without overlap or drift in totalCount", () => {
    const transactions = Array.from({ length: 5 }, (_, i) =>
      tx({ id: `t${i}`, accountId: "acct_checking", amountCents: -100, postedDate: `2026-06-0${i + 1}` }),
    );

    const first = queryTransactions({ accounts, transactions, limit: 2 });
    expect(ids(first)).toEqual(["t4", "t3"]);
    expect(first.totalCount).toBe(5);
    expect(first.nextCursor).toBeDefined();

    const second = queryTransactions({ accounts, transactions, limit: 2, cursor: first.nextCursor });
    expect(ids(second)).toEqual(["t2", "t1"]);
    expect(second.totalCount).toBe(5);

    const third = queryTransactions({ accounts, transactions, limit: 2, cursor: second.nextCursor });
    expect(ids(third)).toEqual(["t0"]);
    expect(third.nextCursor).toBeUndefined();

    // No id appears on two pages.
    expect(new Set([...ids(first), ...ids(second), ...ids(third)]).size).toBe(5);
  });

  it("treats a malformed cursor as the first page rather than throwing", () => {
    const transactions = [
      tx({ id: "t1", accountId: "acct_checking", amountCents: -100, postedDate: "2026-06-01" }),
      tx({ id: "t2", accountId: "acct_checking", amountCents: -100, postedDate: "2026-06-02" }),
    ];
    const page = queryTransactions({ accounts, transactions, limit: 1, cursor: "not a real cursor!!" });
    expect(ids(page)).toEqual(["t2"]);
  });

  it("filters on the effective flow, so a low-confidence transfer is found as UNCLASSIFIED, not TRANSFER_OUT", () => {
    const transactions = [
      tx({
        id: "shaky",
        accountId: "acct_checking",
        amountCents: -50_000,
        flowType: "TRANSFER_OUT",
        counterAccountId: "acct_savings",
        transferMatchConfidence: 0.5, // below the 0.8 trust floor
      }),
    ];

    const asTransfer = queryTransactions({ accounts, transactions, flowType: "TRANSFER_OUT" });
    expect(asTransfer.totalCount).toBe(0);

    const asUnclassified = queryTransactions({ accounts, transactions, flowType: "UNCLASSIFIED" });
    expect(ids(asUnclassified)).toEqual(["shaky"]);
    expect(asUnclassified.transactions[0]).toMatchObject({
      flowType: "UNCLASSIFIED",
      unclassifiedReason: "LOW_MATCH_CONFIDENCE",
    });
  });

  it("explains each way a transfer fails to resolve, and lets a trusted one through", () => {
    const view = (t: Transaction) => queryTransactions({ accounts, transactions: [t] }).transactions[0];

    expect(view(tx({ id: "no_counter", accountId: "acct_checking", amountCents: -100, flowType: "TRANSFER_OUT" }))).toMatchObject({
      flowType: "UNCLASSIFIED",
      unclassifiedReason: "COUNTER_ACCOUNT_UNKNOWN",
    });

    expect(
      view(
        tx({
          id: "external",
          accountId: "acct_checking",
          amountCents: -100,
          flowType: "TRANSFER_OUT",
          counterAccountId: "acct_not_connected",
          transferMatchConfidence: 0.9,
        }),
      ),
    ).toMatchObject({ flowType: "UNCLASSIFIED", unclassifiedReason: "COUNTER_ACCOUNT_NOT_CONNECTED" });

    const trusted = view(
      tx({
        id: "trusted",
        accountId: "acct_checking",
        amountCents: -100,
        flowType: "TRANSFER_OUT",
        counterAccountId: "acct_savings",
        transferMatchConfidence: 0.9,
      }),
    );
    expect(trusted.flowType).toBe("TRANSFER_OUT");
    expect(trusted.unclassifiedReason).toBeUndefined();
    expect(trusted.counterAccountDisplayName).toBe("Local Savings");
  });

  it("bounds a date range inclusively at both ends", () => {
    const transactions = ["2026-06-09", "2026-06-10", "2026-06-15", "2026-06-16"].map((d) =>
      tx({ id: d, accountId: "acct_checking", amountCents: -100, postedDate: d }),
    );
    const page = queryTransactions({ accounts, transactions, from: "2026-06-10", to: "2026-06-15" });
    expect(ids(page).sort()).toEqual(["2026-06-10", "2026-06-15"]);
  });

  it("filters by currency, account, and category independently", () => {
    const transactions = [
      tx({ id: "usd_checking_food", accountId: "acct_checking", amountCents: -100, category: "groceries" }),
      tx({ id: "eur_checking_food", accountId: "acct_checking", amountCents: -100, category: "groceries", currency: "EUR" }),
      tx({ id: "usd_savings_food", accountId: "acct_savings", amountCents: -100, category: "groceries" }),
      tx({ id: "usd_checking_gas", accountId: "acct_checking", amountCents: -100, category: "transportation" }),
    ];
    expect(ids(queryTransactions({ accounts, transactions, currency: "USD" })).sort()).toEqual([
      "usd_checking_food",
      "usd_checking_gas",
      "usd_savings_food",
    ]);
    expect(ids(queryTransactions({ accounts, transactions, accountId: "acct_savings" }))).toEqual(["usd_savings_food"]);
    expect(ids(queryTransactions({ accounts, transactions, category: "transportation" }))).toEqual(["usd_checking_gas"]);
  });

  it("searches the original description as well as the merchant name, case-insensitively", () => {
    const transactions = [
      tx({ id: "coffee", accountId: "acct_checking", amountCents: -650, merchantName: "Coffee", originalDescription: "SQ *BLUE BOTTLE" }),
      tx({ id: "rent", accountId: "acct_checking", amountCents: -150_000, merchantName: "Rent" }),
    ];
    // The needle only appears in the raw description, and in a different case.
    expect(ids(queryTransactions({ accounts, transactions, search: "blue bottle" }))).toEqual(["coffee"]);
    expect(ids(queryTransactions({ accounts, transactions, search: "RENT" }))).toEqual(["rent"]);
  });

  it("maps the category display name through the supplied labeller", () => {
    const [view] = queryTransactions({
      accounts,
      transactions: [tx({ id: "t", accountId: "acct_checking", amountCents: -100, category: "groceries" })],
      categoryLabel: (id) => id.toUpperCase(),
    }).transactions;
    expect(view).toMatchObject({ category: "groceries", categoryDisplayName: "GROCERIES" });
  });

  it("reports recurrence straight from the transaction's recurrence signal", () => {
    const transactions = [
      tx({ id: "sub", accountId: "acct_checking", amountCents: -1599, recurrenceSignal: { isLikelyRecurring: true, confidence: 0.9 } }),
      tx({ id: "oneoff", accountId: "acct_checking", amountCents: -4200 }),
    ];
    const page = queryTransactions({ accounts, transactions });
    expect(page.transactions.find((t) => t.id === "sub")?.isRecurring).toBe(true);
    expect(page.transactions.find((t) => t.id === "oneoff")?.isRecurring).toBe(false);
  });
});
