/**
 * Account deletion — the "right to delete", end to end.
 *
 * Two paths reach the same core: a user deleting their own account (re-auth with
 * their password) and an admin removing another user. Both must (a) erase the
 * user's *identity* — record + sessions — and (b) erase everything the user's id
 * owns in the data stores (bank tokens, imports, assistant memory), while never
 * (c) leaving a deployment with no admin, and never (d) deleting the single-user
 * owner. Driven through the real `createServer` over `app.inject`, with in-memory
 * stores held by reference so erasure is asserted, not assumed.
 */
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../src";
import type { AuthConfig } from "../src/auth/config";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";
import { InMemoryBudgetStoreProvider } from "../src/local/budget-store-provider";
import { InMemoryGoalStoreProvider } from "../src/local/goal-store-provider";
import { InMemoryAgentMemoryProvider } from "../src/agent/memory/provider";
import { totpCode } from "../src/auth/totp";

const DAY_MS = 24 * 60 * 60 * 1000;

const plaidConfig: PlaidConfig = {
  env: "sandbox",
  clientId: "sandbox-client",
  secret: "sandbox-secret",
  clientName: "Breadcrumbz Sandbox",
  countryCodes: ["US"],
};

function multiUserConfig(): AuthConfig {
  return { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 };
}

function singleUserConfig(): AuthConfig {
  return { mode: "single_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: false, passwordMinLength: 8 };
}

function mockClient(): PlaidClientLike {
  return {
    linkTokenCreate: vi.fn().mockResolvedValue({ data: { link_token: "link-token-abc", expiration: "", request_id: "r" } }),
    itemPublicTokenExchange: vi.fn().mockResolvedValue({
      data: { access_token: "access-token-secret", item_id: "item-abc", request_id: "req-1" },
    }),
    accountsBalanceGet: vi.fn().mockResolvedValue({
      data: { accounts: [], item: { item_id: "item-abc" }, request_id: "req-accounts" },
    }),
    transactionsGet: vi.fn(),
  } as unknown as PlaidClientLike;
}

/** A multi_user server with in-memory stores kept by reference so a test can
 *  inspect them after a deletion. */
async function harness() {
  const plaidTokenStore = new InMemoryPlaidTokenStore();
  const stores = new InMemoryStatementImportStoreProvider();
  const agentMemory = new InMemoryAgentMemoryProvider();
  const budgetStores = new InMemoryBudgetStoreProvider();
  const goalStores = new InMemoryGoalStoreProvider();
  const app = await createServer({
    authConfig: multiUserConfig(),
    authPersistence: "memory",
    stores,
    agentMemory,
    budgetStores,
    goalStores,
    plaidConfig,
    plaidClient: mockClient(),
    plaidTokenStore,
  });
  return { app, plaidTokenStore, stores, agentMemory, budgetStores, goalStores };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "password123", acceptedPolicies: true },
  });
  const body = JSON.parse(response.body) as { token: string; user: { id: string; role: string } };
  return { token: body.token, id: body.user.id, role: body.user.role };
}

/** Enroll + clear a TOTP factor so the session can pass the Plaid Link gate. */
async function enrollMfa(app: Awaited<ReturnType<typeof createServer>>, token: string) {
  const enroll = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", headers: auth(token) });
  const { secret } = JSON.parse(enroll.body) as { secret: string };
  const verify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enroll/verify",
    headers: auth(token),
    payload: { code: totpCode(secret) },
  });
  expect(verify.statusCode).toBe(200);
}

/** Link a (mock) bank so the user has a stored Plaid access token to erase. */
async function connectBank(app: Awaited<ReturnType<typeof createServer>>, token: string) {
  await enrollMfa(app, token);
  const exchange = await app.inject({
    method: "POST",
    url: "/api/plaid/exchange-public-token",
    headers: auth(token),
    payload: { publicToken: "public-token" },
  });
  expect(exchange.statusCode).toBe(200);
}

describe("account deletion (multi_user)", () => {
  it("erases a user's identity and all their data, and clears the session", async () => {
    const { app, plaidTokenStore, stores, agentMemory, budgetStores, goalStores } = await harness();
    const erasedStores = vi.spyOn(stores, "eraseForUser");
    const erasedMemory = vi.spyOn(agentMemory, "eraseForUser");
    const erasedBudgets = vi.spyOn(budgetStores, "eraseForUser");
    const erasedGoals = vi.spyOn(goalStores, "eraseForUser");

    // First registrant is the bootstrap admin; the account under test is a
    // normal user so the last-admin guard doesn't apply.
    await register(app, "admin@example.com");
    const alice = await register(app, "alice@example.com");
    await connectBank(app, alice.token);

    // Alice configures a budget, so there is a budgets file to erase.
    const savedBudget = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: auth(alice.token),
      payload: { currency: "USD", overallLimitCents: null, budgets: [{ category: "groceries", limitCents: 40_000 }] },
    });
    expect(savedBudget.statusCode).toBe(200);

    // Alice declares a savings goal, so there is a goals file to erase.
    const savedGoal = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      headers: auth(alice.token),
      payload: { goals: [{ label: "Emergency fund", targetAmountCents: 100_000, monthlyContributionCents: 20_000 }] },
    });
    expect(savedGoal.statusCode).toBe(200);

    // Precondition: Alice owns exactly one bank connection.
    expect(await plaidTokenStore.listForUser(alice.id)).toHaveLength(1);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/me",
      headers: auth(alice.token),
      payload: { currentPassword: "password123" },
    });
    expect(del.statusCode).toBe(200);
    // Cookie is cleared (Max-Age=0) so the browser drops the session too.
    expect(String(del.headers["set-cookie"])).toContain("Max-Age=0");

    // Identity gone: the token no longer authenticates, and login fails.
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(alice.token) });
    expect(me.statusCode).toBe(401);
    const relogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: "password123" },
    });
    expect(relogin.statusCode).toBe(401);
    expect(JSON.parse(relogin.body).error.code).toBe("INVALID_CREDENTIALS");

    // Data gone: bank tokens removed, and every owning store was told to erase.
    expect(await plaidTokenStore.listForUser(alice.id)).toHaveLength(0);
    expect(erasedStores).toHaveBeenCalledWith(alice.id);
    expect(erasedMemory).toHaveBeenCalledWith(alice.id);
    expect(erasedBudgets).toHaveBeenCalledWith(alice.id);
    expect(erasedGoals).toHaveBeenCalledWith(alice.id);

    await app.close();
  });

  it("refuses a wrong password and deletes nothing", async () => {
    const { app, plaidTokenStore, stores, agentMemory } = await harness();
    const erasedStores = vi.spyOn(stores, "eraseForUser");
    const erasedMemory = vi.spyOn(agentMemory, "eraseForUser");

    await register(app, "admin@example.com");
    const alice = await register(app, "alice@example.com");
    await connectBank(app, alice.token);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/me",
      headers: auth(alice.token),
      payload: { currentPassword: "wrong-password" },
    });
    expect(del.statusCode).toBe(401);
    expect(JSON.parse(del.body).error.code).toBe("INVALID_CREDENTIALS");

    // Nothing was touched: session still works, connection still there, no erase.
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(alice.token) });
    expect(me.statusCode).toBe(200);
    expect(await plaidTokenStore.listForUser(alice.id)).toHaveLength(1);
    expect(erasedStores).not.toHaveBeenCalled();
    expect(erasedMemory).not.toHaveBeenCalled();

    await app.close();
  });

  it("will not let the last admin delete themselves", async () => {
    const { app } = await harness();
    const admin = await register(app, "admin@example.com");
    expect(admin.role).toBe("admin");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/me",
      headers: auth(admin.token),
      payload: { currentPassword: "password123" },
    });
    expect(del.statusCode).toBe(400);
    expect(JSON.parse(del.body).error.code).toBe("LAST_ADMIN");

    // Still present and usable.
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(admin.token) });
    expect(me.statusCode).toBe(200);

    await app.close();
  });

  it("lets an admin delete another user, but a non-admin cannot", async () => {
    const { app, plaidTokenStore } = await harness();
    const admin = await register(app, "admin@example.com");
    const alice = await register(app, "alice@example.com");
    const bob = await register(app, "bob@example.com");
    await connectBank(app, alice.token);

    // A normal user cannot reach the admin delete route.
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${alice.id}`,
      headers: auth(bob.token),
    });
    expect(forbidden.statusCode).toBe(403);

    // The admin can, and it erases Alice's data too.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${alice.id}`,
      headers: auth(admin.token),
    });
    expect(del.statusCode).toBe(200);
    expect(await plaidTokenStore.listForUser(alice.id)).toHaveLength(0);

    const aliceGone = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(alice.token) });
    expect(aliceGone.statusCode).toBe(401);

    await app.close();
  });
});

describe("account deletion (single_user)", () => {
  it("refuses to delete the owner account", async () => {
    const app = await createServer({
      authConfig: singleUserConfig(),
      authPersistence: "memory",
      stores: new InMemoryStatementImportStoreProvider(),
    });
    const del = await app.inject({ method: "DELETE", url: "/api/v1/auth/me" });
    expect(del.statusCode).toBe(400);
    expect(JSON.parse(del.body).error.code).toBe("CANNOT_DELETE_OWNER");
    await app.close();
  });
});
