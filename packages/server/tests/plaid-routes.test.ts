import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerPlaidRoutes } from "../src/http/plaid-routes";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";
import { InMemoryStatementImportStore } from "../src/local/store";
import { SingleStatementImportStoreProvider } from "../src/local/store-provider";

const config: PlaidConfig = {
  env: "sandbox",
  clientId: "sandbox-client",
  secret: "sandbox-secret",
  clientName: "Breadcrumbs Sandbox",
  countryCodes: ["US"],
};

describe("Plaid HTTP routes", () => {
  it("exchanges a public token without returning the Plaid access token", async () => {
    const store = new InMemoryPlaidTokenStore();
    const client = mockClient({
      itemPublicTokenExchange: vi.fn().mockResolvedValue({
        data: {
          access_token: "access-token-secret",
          item_id: "item-123",
          request_id: "req-exchange",
        },
      }),
    });
    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore: store });

    const response = await app.inject({
      method: "POST",
      url: "/api/plaid/exchange-public-token",
      payload: { publicToken: "public-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("access-token-secret");
    expect(JSON.parse(response.body)).toMatchObject({
      connectionId: expect.stringMatching(/^plaid_conn_/),
      itemId: "item-123",
      requestId: "req-exchange",
    });
    await app.close();
  });

  it("uses the stored token for retrieval routes without accepting a browser token", async () => {
    const store = new InMemoryPlaidTokenStore();
    const connection = await store.save({ itemId: "item-123", accessToken: "access-token-secret" });
    const client = mockClient({
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [],
          item: { item_id: "item-123" },
          request_id: "req-accounts",
        },
      }),
    });
    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore: store });

    const response = await app.inject({
      method: "GET",
      url: `/api/plaid/connections/${connection.connectionId}/accounts`,
    });

    expect(response.statusCode).toBe(200);
    expect(client.accountsBalanceGet).toHaveBeenCalledWith({ access_token: "access-token-secret" });
    expect(response.body).not.toContain("access-token-secret");
    await app.close();
  });

  it("redacts Plaid and request token values from error responses", async () => {
    const client = mockClient({
      itemPublicTokenExchange: vi.fn().mockRejectedValue({
        response: {
          status: 400,
          data: {
            error_code: "INVALID_PUBLIC_TOKEN",
            error_message: "public-token-secret should not be echoed",
            request_id: "req-error",
          },
        },
      }),
    });
    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore: new InMemoryPlaidTokenStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/plaid/exchange-public-token",
      payload: { publicToken: "public-token-secret" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("INVALID_PUBLIC_TOKEN");
    expect(response.body).toContain("req-error");
    expect(response.body).not.toContain("public-token-secret");
    await app.close();
  });

  it("syncs the /transactions/sync delta into the store and advances the cursor", async () => {
    const tokenStore = new InMemoryPlaidTokenStore();
    const connection = await tokenStore.save({ itemId: "item-123", accessToken: "access-token-secret" });
    const statementStore = new InMemoryStatementImportStore();
    const stores = new SingleStatementImportStoreProvider(statementStore);

    const client = mockClient({
      accountsBalanceGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [
            {
              account_id: "checking-1",
              name: "Checking",
              official_name: "Checking",
              type: "depository",
              subtype: "checking",
              balances: { current: 1000, available: 1000, limit: null, iso_currency_code: "USD" },
            },
          ],
          item: { item_id: "item-123" },
          request_id: "req-accounts",
        },
      }),
      transactionsSync: vi.fn().mockResolvedValue({
        data: {
          added: [plaidTxn({ transaction_id: "t1", account_id: "checking-1", amount: 5, name: "Coffee", date: "2026-08-01" })],
          modified: [],
          removed: [],
          next_cursor: "cursor-after-1",
          has_more: false,
          request_id: "req-sync",
        },
      }),
    });

    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore, stores });

    const response = await app.inject({
      method: "POST",
      url: `/api/plaid/connections/${connection.connectionId}/sync`,
    });

    expect(response.statusCode).toBe(200);
    // The first sync omits the cursor (full history) and stores the returned one.
    expect((client.transactionsSync as ReturnType<typeof vi.fn>).mock.calls[0][0].cursor).toBeUndefined();
    expect(JSON.parse(response.body)).toMatchObject({
      connectionId: connection.connectionId,
      accountsSynced: 1,
      synced: 1,
      transactionsAdded: 1,
      transactionsModified: 0,
      transactionsRemoved: 0,
    });

    // The delta landed in the caller's statement store...
    const state = await statementStore.load();
    expect(state.transactions.map((t) => t.id)).toEqual(["plaid:transaction:t1"]);
    // ...and the cursor was persisted for the next sync to resume from.
    const after = await tokenStore.get(connection.connectionId);
    expect(after?.transactionsCursor).toBe("cursor-after-1");
    expect(after?.lastSyncedAt).toBeDefined();

    await app.close();
  });
});

function plaidTxn(input: Record<string, unknown>): Record<string, unknown> {
  return {
    account_id: "checking-1",
    amount: 0,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-01",
    name: "Transaction",
    pending: false,
    pending_transaction_id: null,
    transaction_id: "tx-1",
    authorized_date: null,
    payment_channel: "other",
    ...input,
  };
}

function mockClient(overrides: Partial<PlaidClientLike>): PlaidClientLike {
  return {
    linkTokenCreate: vi.fn(),
    itemPublicTokenExchange: vi.fn(),
    accountsBalanceGet: vi.fn(),
    transactionsGet: vi.fn(),
    transactionsSync: vi.fn(),
    ...overrides,
  } as PlaidClientLike;
}
