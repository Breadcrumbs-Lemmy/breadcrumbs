import type { AccountBase, Transaction as PlaidTransaction } from "plaid";
import { AccountSubtype, AccountType, CountryCode, Products } from "plaid";
import { describe, expect, it, vi } from "vitest";

import {
  createLinkToken,
  exchangePublicToken,
  getAccountsAndBalances,
  getCanonicalSnapshot,
  getTransactions,
} from "../src/plaid/adapter";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";

const config: PlaidConfig = {
  env: "sandbox",
  clientId: "sandbox-client",
  secret: "sandbox-secret",
  clientName: "Breadcrumbz Sandbox",
  countryCodes: ["US"],
};

describe("Plaid Sandbox adapter", () => {
  it("creates a Link token with the minimal read-only product set", async () => {
    const client = mockClient({
      linkTokenCreate: vi.fn().mockResolvedValue({
        data: {
          link_token: "link-sandbox",
          expiration: "2026-08-04T12:00:00Z",
          request_id: "req-link",
        },
      }),
    });

    const result = await createLinkToken(client, config, { clientUserId: "local-user" });

    expect(result).toEqual({
      linkToken: "link-sandbox",
      expiration: "2026-08-04T12:00:00Z",
      requestId: "req-link",
    });
    expect(client.linkTokenCreate).toHaveBeenCalledWith({
      client_name: "Breadcrumbz Sandbox",
      language: "en",
      country_codes: [CountryCode.Us],
      products: [Products.Transactions],
      user: { client_user_id: "local-user" },
      redirect_uri: undefined,
      webhook: undefined,
    });
  });

  it("keeps exchanged access tokens server-side", async () => {
    const client = mockClient({
      itemPublicTokenExchange: vi.fn().mockResolvedValue({
        data: {
          access_token: "access-token-secret",
          item_id: "item-123",
          request_id: "req-exchange",
        },
      }),
    });
    const store = new InMemoryPlaidTokenStore();

    const result = await exchangePublicToken(client, store, "public-sandbox-token");
    const stored = await store.get(result.connectionId);

    expect(result).toEqual({
      connectionId: expect.stringMatching(/^plaid_conn_/),
      itemId: "item-123",
      requestId: "req-exchange",
    });
    expect(JSON.stringify(result)).not.toContain("access-token-secret");
    expect(stored?.accessToken).toBe("access-token-secret");
  });

  it("retrieves balances and maps Plaid accounts into canonical accounts", async () => {
    const client = mockClient({
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [
            plaidAccount({
              account_id: "checking-1",
              name: "Plaid Checking",
              official_name: "Plaid Gold Checking",
              type: AccountType.Depository,
              subtype: AccountSubtype.Checking,
              balances: { current: 1234.56, available: 1200.12, limit: null, iso_currency_code: "USD" },
            }),
            plaidAccount({
              account_id: "credit-1",
              name: "Plaid Credit",
              type: AccountType.Credit,
              subtype: AccountSubtype.CreditCard,
              balances: { current: 800.33, available: 4199.67, limit: 5000, iso_currency_code: "USD" },
            }),
          ],
          item: { item_id: "item-123" },
          request_id: "req-accounts",
        },
      }),
    });

    const result = await getAccountsAndBalances(client, "access-token-secret", new Date("2026-08-04T12:00:00Z"));

    expect(result.accounts).toMatchObject([
      {
        id: "plaid:account:checking-1",
        displayName: "Plaid Gold Checking",
        type: "checking",
        role: "spendable_cash",
        currentBalanceCents: 123456,
        availableBalanceCents: 120012,
        includeInForecast: true,
        source: "plaid",
      },
      {
        id: "plaid:account:credit-1",
        type: "credit_card",
        role: "liability",
        currentBalanceCents: 80033,
        availableBalanceCents: undefined,
        creditLimitCents: 500000,
        includeInForecast: false,
        source: "plaid",
      },
    ]);
    expect(result.requestId).toBe("req-accounts");
  });

  it("resolves the real institution name from institution_id and stamps it on every account (H-034)", async () => {
    const institutionsGetById = vi.fn().mockResolvedValue({
      data: { institution: { institution_id: "ins_56", name: "Chase" }, request_id: "req-inst" },
    });
    const client = mockClient({
      institutionsGetById,
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [
            plaidAccount({ account_id: "checking-1", name: "Plaid Checking" }),
            plaidAccount({ account_id: "savings-1", name: "Plaid Saving", subtype: AccountSubtype.Savings }),
          ],
          item: { item_id: "item-123", institution_id: "ins_56" },
          request_id: "req-accounts",
        },
      }),
    });

    const result = await getAccountsAndBalances(client, "access-token-secret");

    expect(institutionsGetById).toHaveBeenCalledWith({ institution_id: "ins_56", country_codes: [CountryCode.Us] });
    expect(result.institutionName).toBe("Chase");
    expect(result.accounts.map((account) => account.institutionName)).toEqual(["Chase", "Chase"]);
  });

  it("falls back to a documented brand placeholder — never the literal 'Unknown' — when no name resolves (H-034)", async () => {
    const client = mockClient({
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [plaidAccount({ account_id: "checking-1", official_name: "Plaid Gold Standard Checking" })],
          item: { item_id: "item-123" },
          request_id: "req-accounts",
        },
      }),
    });

    const result = await getAccountsAndBalances(client, "access-token-secret");

    expect(result.institutionName).toBeUndefined();
    expect(result.accounts[0]?.institutionName).toBe("Plaid");
    expect(result.accounts[0]?.institutionName).not.toBe("Unknown");
  });

  it("retrieves transactions, maps signs, and excludes pending transactions", async () => {
    const client = mockClient({
      transactionsGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [],
          transactions: [
            plaidTransaction({
              transaction_id: "tx-outflow",
              account_id: "checking-1",
              amount: 12.34,
              name: "COFFEE SHOP",
              merchant_name: "Coffee Shop",
              date: "2026-08-01",
              pending: false,
              personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
            }),
            plaidTransaction({
              transaction_id: "tx-pending",
              account_id: "checking-1",
              amount: 8,
              name: "Pending Lunch",
              date: "2026-08-02",
              pending: true,
            }),
            plaidTransaction({
              transaction_id: "tx-inflow",
              account_id: "checking-1",
              amount: -1000,
              name: "PAYROLL",
              date: "2026-08-03",
              pending: false,
            }),
          ],
          total_transactions: 3,
          item: { item_id: "item-123" },
          request_id: "req-transactions",
        },
      }),
    });

    const result = await getTransactions(client, "access-token-secret", {
      startDate: "2026-08-01",
      endDate: "2026-08-04",
      syncedAt: new Date("2026-08-04T12:00:00Z"),
    });

    expect(client.transactionsGet).toHaveBeenCalledWith({
      access_token: "access-token-secret",
      start_date: "2026-08-01",
      end_date: "2026-08-04",
      options: {
        count: 500,
        offset: 0,
        include_original_description: true,
      },
    });
    expect(result.rawCount).toBe(3);
    expect(result.pendingExcludedCount).toBe(1);
    expect(result.transactions).toMatchObject([
      {
        id: "plaid:transaction:tx-outflow",
        accountId: "plaid:account:checking-1",
        amountCents: -1234,
        merchantName: "Coffee Shop",
        category: "coffee_snacks",
        categoryDisplayName: "Coffee and snacks",
      },
      {
        id: "plaid:transaction:tx-inflow",
        amountCents: 100000,
        merchantName: "PAYROLL",
        category: "income",
      },
    ]);
  });

  it("paginates across pages until the reported total is reached", async () => {
    const transactionsGet = vi.fn();
    transactionsGet
      .mockResolvedValueOnce({
        data: {
          accounts: [],
          transactions: [plaidTransaction({ transaction_id: "tx-1", account_id: "checking-1", amount: 1, date: "2026-08-01" })],
          total_transactions: 2,
          item: { item_id: "item-123" },
          request_id: "req-1",
        },
      })
      .mockResolvedValueOnce({
        data: {
          accounts: [],
          transactions: [plaidTransaction({ transaction_id: "tx-2", account_id: "checking-1", amount: 2, date: "2026-08-02" })],
          total_transactions: 2,
          item: { item_id: "item-123" },
          request_id: "req-2",
        },
      });
    const client = mockClient({ transactionsGet });

    const result = await getTransactions(client, "access-token-secret", { startDate: "2026-08-01", endDate: "2026-08-31" });

    expect(transactionsGet).toHaveBeenCalledTimes(2);
    // The second request advances the offset by the first page's length.
    expect((transactionsGet.mock.calls[1][0] as { options: { offset: number } }).options.offset).toBe(1);
    expect(result.rawCount).toBe(2);
    expect(result.requestIds).toEqual(["req-1", "req-2"]);
  });

  it("stops when a page returns empty even if total_transactions is over-reported (no infinite loop)", async () => {
    // Plaid's total_transactions is an estimate and can exceed what actually
    // paginates (pending or just-removed rows). The loop must terminate on the
    // empty page instead of re-requesting the same offset forever — if it
    // regressed, this test would hang until the runner timed out.
    const transactionsGet = vi.fn();
    transactionsGet
      .mockResolvedValueOnce({
        data: {
          accounts: [],
          transactions: [plaidTransaction({ transaction_id: "tx-1", account_id: "checking-1", date: "2026-08-01" })],
          total_transactions: 5,
          item: { item_id: "item-123" },
          request_id: "req-1",
        },
      })
      .mockResolvedValue({
        data: {
          accounts: [],
          transactions: [],
          total_transactions: 5,
          item: { item_id: "item-123" },
          request_id: "req-empty",
        },
      });
    const client = mockClient({ transactionsGet });

    const result = await getTransactions(client, "access-token-secret", { startDate: "2026-08-01", endDate: "2026-08-31" });

    expect(transactionsGet).toHaveBeenCalledTimes(2);
    expect(result.rawCount).toBe(1);
  });

  it("maps a conservative canonical snapshot without declaring total coverage by default", async () => {
    const client = mockClient({
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [
            plaidAccount({
              account_id: "checking-1",
              type: AccountType.Depository,
              subtype: AccountSubtype.Checking,
              balances: { current: 2500, available: 2500, limit: null, iso_currency_code: "USD" },
            }),
          ],
          item: { item_id: "item-123" },
          request_id: "req-accounts",
        },
      }),
      transactionsGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [],
          transactions: [],
          total_transactions: 0,
          item: { item_id: "item-123" },
          request_id: "req-transactions",
        },
      }),
    });

    const result = await getCanonicalSnapshot(client, "access-token-secret", {
      startDate: "2026-08-01",
      endDate: "2026-08-04",
      asOfDate: "2026-08-04",
      timezone: "America/Chicago",
    });

    expect(result.snapshot).toMatchObject({
      asOfDate: "2026-08-04",
      timezone: "America/Chicago",
      currency: "USD",
      coverage: {
        balancesDeclaredComplete: false,
        transactionsCompleteFromDate: "2026-08-01",
        userConfirmedNoOtherRequiredObligations: false,
      },
      accounts: [{ id: "plaid:account:checking-1", source: "plaid" }],
      incomeSources: [],
      recurringObligations: [],
      goals: [],
      plannedPurchases: [],
    });
  });
});

function mockClient(overrides: Partial<PlaidClientLike>): PlaidClientLike {
  return {
    linkTokenCreate: vi.fn(),
    itemPublicTokenExchange: vi.fn(),
    accountsBalanceGet: vi.fn(),
    transactionsGet: vi.fn(),
    ...overrides,
  } as PlaidClientLike;
}

type PlaidAccountFixture = Omit<Partial<AccountBase>, "balances"> & {
  balances?: Partial<AccountBase["balances"]>;
};

function plaidAccount(input: PlaidAccountFixture): AccountBase {
  const { balances, ...account } = input;

  return {
    account_id: "account-1",
    name: "Plaid Account",
    official_name: null,
    mask: "0000",
    type: AccountType.Depository,
    subtype: AccountSubtype.Checking,
    ...account,
    balances: {
      available: balances?.available ?? 0,
      current: balances?.current ?? 0,
      limit: balances?.limit ?? null,
      iso_currency_code: balances?.iso_currency_code ?? "USD",
      unofficial_currency_code: balances?.unofficial_currency_code ?? null,
    },
  } as AccountBase;
}

function plaidTransaction(input: Partial<PlaidTransaction>): PlaidTransaction {
  return {
    account_id: "checking-1",
    amount: 0,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-01",
    location: {},
    name: "Transaction",
    payment_meta: {},
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    transaction_id: "tx-1",
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    payment_channel: "other",
    transaction_code: null,
    ...input,
  } as PlaidTransaction;
}
