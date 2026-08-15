/**
 * Authentication gate, admin bootstrap, and per-user data isolation.
 *
 * These are the guarantees the multi-user rewiring exists to provide, and none
 * of them were exercised before: the rest of the suite runs in the default
 * single-user mode where every request is the owner. A gate that is never
 * tested unauthenticated is a gate that quietly stops gating — so every case
 * here drives the real `createServer` in `multi_user` mode over `app.inject`,
 * the same path a browser takes.
 *
 * Isolation is the load-bearing one: one user's imported financial data must be
 * invisible to another. It is asserted end to end — a real commit by user A, a
 * real spending summary read by user B that comes back empty.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import type { AuthConfig } from "../src/auth/config";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";

const DAY_MS = 24 * 60 * 60 * 1000;

function multiUserConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8, ...overrides };
}

async function multiUserServer() {
  return createServer({
    authConfig: multiUserConfig(),
    authPersistence: "memory",
    stores: new InMemoryStatementImportStoreProvider(),
  });
}

async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "password123", acceptedPolicies: true },
  });
  const body = JSON.parse(response.body) as { user: { id: string; role: string }; token: string };
  return { status: response.statusCode, ...body };
}

function importFor(accountId: string) {
  return {
    csv: ["date,description,amount", "2026-07-20,WHOLE FOODS MKT,88.40"].join("\n"),
    accountId,
    account: {
      id: accountId,
      displayName: "Everyday Card",
      institutionName: "First National",
      type: "credit_card",
      currency: "USD",
      currentBalanceCents: -120_000,
    },
    currency: "USD",
    dateFormat: "iso",
    mapping: {
      postedDate: "date",
      description: "description",
      amount: "amount",
      amountSignConvention: "outflow_positive",
    },
  };
}

describe("auth gate (multi_user)", () => {
  it("rejects unauthenticated access to data routes with 401", async () => {
    const app = await multiUserServer();

    for (const url of ["/api/v1/accounts", "/api/v1/spending/summary", "/api/v1/transactions", "/api/v1/admin/users"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(JSON.parse(response.body).error.code).toBe("UNAUTHENTICATED");
    }
    await app.close();
  });

  it("keeps the sign-in context endpoint public", async () => {
    const app = await multiUserServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/context" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).mode).toBe("multi_user");
    await app.close();
  });

  it("admits a request carrying a valid session and rejects a forged token", async () => {
    const app = await multiUserServer();
    const a = await register(app, "a@example.com");

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/accounts",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(ok.statusCode).toBe(200);

    const forged = await app.inject({
      method: "GET",
      url: "/api/v1/accounts",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(forged.statusCode).toBe(401);
    await app.close();
  });
});

describe("consent at registration (multi_user)", () => {
  it("refuses to create an account without agreement to the policies", async () => {
    const app = await multiUserServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "noconsent@example.com", password: "password123" },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("CONSENT_REQUIRED");

    // And nothing was created: the same email can still register cleanly after.
    const retry = await register(app, "noconsent@example.com");
    expect(retry.status).toBe(200);
    await app.close();
  });

  it("records the consent version and timestamp on the new account", async () => {
    const app = await multiUserServer();
    const before = Date.now();
    const a = await register(app, "a@example.com");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${a.token}` },
    });
    const consent = JSON.parse(me.body).user.consent as { policyVersion: string; agreedAt: string } | null;
    expect(consent).not.toBeNull();
    expect(consent!.policyVersion).toBe("2026-08-09");
    expect(Date.parse(consent!.agreedAt)).toBeGreaterThanOrEqual(before - 1000);
    await app.close();
  });
});

describe("admin bootstrap (multi_user)", () => {
  it("makes the first registrant an admin and everyone after a plain user", async () => {
    // Regression guard: seeding an implicit owner at boot would make `count()`
    // non-zero here, denying the first human the admin role and leaving a fresh
    // deployment with no user who can administer. The owner is seeded only in
    // single-user mode for exactly this reason.
    const app = await multiUserServer();

    const a = await register(app, "a@example.com");
    const b = await register(app, "b@example.com");
    expect(a.user.role).toBe("admin");
    expect(b.user.role).toBe("user");

    const adminFromA = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(adminFromA.statusCode).toBe(200);

    const adminFromB = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(adminFromB.statusCode).toBe(403);
    await app.close();
  });
});

describe("per-user data isolation (multi_user)", () => {
  it("hides one user's imported spending from another", async () => {
    const app = await multiUserServer();
    const a = await register(app, "a@example.com");
    const b = await register(app, "b@example.com");

    const commit = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      headers: { authorization: `Bearer ${a.token}` },
      payload: importFor("acct_a_card"),
    });
    expect(commit.statusCode).toBe(200);

    const summaryUrl = "/api/v1/spending/summary?currency=USD&period=month&key=2026-07";

    const seenByA = await app.inject({
      method: "GET",
      url: summaryUrl,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(seenByA.statusCode).toBe(200);
    expect(JSON.parse(seenByA.body).totalOutflowCents).toBeGreaterThan(0);

    const seenByB = await app.inject({
      method: "GET",
      url: summaryUrl,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(seenByB.statusCode).toBe(200);
    // B imported nothing. If B could see A's card, this would be A's spend.
    expect(JSON.parse(seenByB.body).totalOutflowCents).toBe(0);
    await app.close();
  });
});

describe("single_user mode", () => {
  it("serves data with no token because every request is the owner", async () => {
    const app = await createServer({ authConfig: { ...multiUserConfig(), mode: "single_user" }, authPersistence: "memory" });
    const response = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
