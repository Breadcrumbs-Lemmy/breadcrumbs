/**
 * Per-user isolation for connected banks.
 *
 * A Plaid connection is the keys to a real bank account, so the boundary here is
 * the strictest in the product: a connection one user creates must be
 * completely unreachable to another, even with its exact `connectionId`. The
 * route answers a not-owned connection with the same 404 it gives a missing one,
 * so a guess can't even confirm that someone else's connection exists.
 *
 * Driven through the real `createServer` in multi_user mode with a mock Plaid
 * client — no sandbox credentials, no network — over the same `app.inject` path
 * a browser takes.
 */
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../src";
import type { AuthConfig } from "../src/auth/config";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";

const DAY_MS = 24 * 60 * 60 * 1000;

const plaidConfig: PlaidConfig = {
  env: "sandbox",
  clientId: "sandbox-client",
  secret: "sandbox-secret",
  clientName: "Breadcrumbs Sandbox",
  countryCodes: ["US"],
};

function multiUserConfig(): AuthConfig {
  return { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 };
}

function mockClient(): PlaidClientLike {
  return {
    linkTokenCreate: vi.fn(),
    itemPublicTokenExchange: vi.fn().mockResolvedValue({
      data: { access_token: "access-token-secret", item_id: "item-abc", request_id: "req-1" },
    }),
    accountsBalanceGet: vi.fn().mockResolvedValue({
      data: { accounts: [], item: { item_id: "item-abc" }, request_id: "req-accounts" },
    }),
    transactionsGet: vi.fn(),
  } as unknown as PlaidClientLike;
}

async function server() {
  return createServer({
    authConfig: multiUserConfig(),
    authPersistence: "memory",
    stores: new InMemoryStatementImportStoreProvider(),
    plaidConfig,
    plaidClient: mockClient(),
    plaidTokenStore: new InMemoryPlaidTokenStore(),
  });
}

async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "password123" },
  });
  return (JSON.parse(response.body) as { token: string }).token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Plaid connection isolation (multi_user)", () => {
  it("keeps one user's bank connection unreachable to another, by the same 404", async () => {
    const app = await server();
    const aliceToken = await register(app, "alice@example.com");
    const bobToken = await register(app, "bob@example.com");

    const exchange = await app.inject({
      method: "POST",
      url: "/api/plaid/exchange-public-token",
      headers: auth(aliceToken),
      payload: { publicToken: "public-token" },
    });
    expect(exchange.statusCode).toBe(200);
    const connectionId = JSON.parse(exchange.body).connectionId as string;

    // Alice sees her connection listed; Bob's list is empty.
    const aliceList = await app.inject({ method: "GET", url: "/api/plaid/connections", headers: auth(aliceToken) });
    expect(JSON.parse(aliceList.body).connections).toHaveLength(1);
    const bobList = await app.inject({ method: "GET", url: "/api/plaid/connections", headers: auth(bobToken) });
    expect(JSON.parse(bobList.body).connections).toHaveLength(0);

    // Bob cannot read Alice's accounts even with her exact connectionId.
    const bobReach = await app.inject({
      method: "GET",
      url: `/api/plaid/connections/${connectionId}/accounts`,
      headers: auth(bobToken),
    });
    expect(bobReach.statusCode).toBe(404);
    expect(JSON.parse(bobReach.body).error.code).toBe("PLAID_CONNECTION_NOT_FOUND");

    // A missing connection returns that identical 404 — no existence leak.
    const bobMissing = await app.inject({
      method: "GET",
      url: "/api/plaid/connections/plaid_conn_does_not_exist/accounts",
      headers: auth(bobToken),
    });
    expect(bobMissing.statusCode).toBe(404);
    expect(JSON.parse(bobMissing.body).error.code).toBe("PLAID_CONNECTION_NOT_FOUND");

    // Alice, the owner, gets her accounts.
    const aliceReach = await app.inject({
      method: "GET",
      url: `/api/plaid/connections/${connectionId}/accounts`,
      headers: auth(aliceToken),
    });
    expect(aliceReach.statusCode).toBe(200);

    // And Bob cannot delete what he cannot see.
    const bobDelete = await app.inject({
      method: "DELETE",
      url: `/api/plaid/connections/${connectionId}`,
      headers: auth(bobToken),
    });
    expect(bobDelete.statusCode).toBe(404);

    await app.close();
  });

  it("requires a session for Plaid routes at all", async () => {
    const app = await server();
    const response = await app.inject({ method: "GET", url: "/api/plaid/connections" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
