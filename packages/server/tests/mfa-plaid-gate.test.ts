/**
 * MFA gate in front of Plaid Link.
 *
 * The rule Plaid asks for (questionnaire item 4): a consumer must pass a second
 * factor before bank-linking is surfaced. Here that is enforced server-side —
 * `link-token` and `exchange-public-token` refuse a multi-user session that has
 * not cleared TOTP, so the gate holds even if the web UI is bypassed. The tests
 * exercise the whole path through the real `createServer`: enroll → verify →
 * link, plus a fresh login needing step-up, plus the single-user bypass.
 */
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../src";
import type { AuthConfig } from "../src/auth/config";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";
import { totpCode } from "../src/auth/totp";

const DAY_MS = 24 * 60 * 60 * 1000;

const plaidConfig: PlaidConfig = {
  env: "sandbox",
  clientId: "sandbox-client",
  secret: "sandbox-secret",
  clientName: "Breadcrumbs Sandbox",
  countryCodes: ["US"],
};

function mockClient(): PlaidClientLike {
  return {
    linkTokenCreate: vi.fn().mockResolvedValue({
      data: { link_token: "link-token-abc", expiration: "2099-01-01T00:00:00Z", request_id: "req-link" },
    }),
    itemPublicTokenExchange: vi.fn().mockResolvedValue({
      data: { access_token: "access-token-secret", item_id: "item-abc", request_id: "req-1" },
    }),
    accountsBalanceGet: vi.fn(),
    transactionsGet: vi.fn(),
  } as unknown as PlaidClientLike;
}

function server(mode: AuthConfig["mode"]) {
  const authConfig: AuthConfig = { mode, sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 };
  return createServer({
    authConfig,
    authPersistence: "memory",
    stores: new InMemoryStatementImportStoreProvider(),
    plaidConfig,
    plaidClient: mockClient(),
    plaidTokenStore: new InMemoryPlaidTokenStore(),
  });
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(app: Awaited<ReturnType<typeof createServer>>, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "password123", acceptedPolicies: true } });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function login(app: Awaited<ReturnType<typeof createServer>>, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "password123" } });
  return (JSON.parse(res.body) as { token: string }).token;
}

/** Enroll TOTP and return the base32 secret so later steps can mint codes. */
async function enroll(app: Awaited<ReturnType<typeof createServer>>, token: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", headers: auth(token) });
  return (JSON.parse(res.body) as { secret: string }).secret;
}

function linkToken(app: Awaited<ReturnType<typeof createServer>>, token: string) {
  return app.inject({ method: "POST", url: "/api/plaid/link-token", headers: auth(token), payload: {} });
}

describe("MFA gate before Plaid Link (multi_user)", () => {
  it("blocks link-token with MFA_ENROLLMENT_REQUIRED when no factor is set", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");

    const res = await linkToken(app, token);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("MFA_ENROLLMENT_REQUIRED");

    await app.close();
  });

  it("allows link-token immediately after enrollment is verified", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");

    const secret = await enroll(app, token);
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll/verify",
      headers: auth(token),
      payload: { code: totpCode(secret) },
    });
    expect(verify.statusCode).toBe(200);
    expect(JSON.parse(verify.body).user.mfa).toMatchObject({ enabled: true, method: "totp" });

    const res = await linkToken(app, token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).linkToken).toBe("link-token-abc");

    await app.close();
  });

  it("rejects enrollment verification with a wrong code", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");
    await enroll(app, token);

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll/verify",
      headers: auth(token),
      payload: { code: "000000" },
    });
    expect(verify.statusCode).toBe(400);
    expect(JSON.parse(verify.body).error.code).toBe("MFA_INVALID_CODE");

    // Still gated — the factor never turned on.
    const res = await linkToken(app, token);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("MFA_ENROLLMENT_REQUIRED");

    await app.close();
  });

  it("demands step-up (MFA_REQUIRED) on a fresh login, then passes after a challenge", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");
    const secret = await enroll(app, token);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll/verify",
      headers: auth(token),
      payload: { code: totpCode(secret) },
    });

    // A brand-new session has the enabled factor but has not cleared it yet.
    const freshToken = await login(app, "alice@example.com");
    const blocked = await linkToken(app, freshToken);
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.body).error.code).toBe("MFA_REQUIRED");

    // Clearing the challenge stamps this session; Link then opens.
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      headers: auth(freshToken),
      payload: { code: totpCode(secret) },
    });
    expect(challenge.statusCode).toBe(200);

    const allowed = await linkToken(app, freshToken);
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });

  it("gates exchange-public-token too, not just the token mint", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/plaid/exchange-public-token",
      headers: auth(token),
      payload: { publicToken: "public-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("MFA_ENROLLMENT_REQUIRED");

    await app.close();
  });

  it("requires a current code to disable MFA", async () => {
    const app = await server("multi_user");
    const token = await register(app, "alice@example.com");
    const secret = await enroll(app, token);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll/verify",
      headers: auth(token),
      payload: { code: totpCode(secret) },
    });

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: auth(token),
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: auth(token),
      payload: { code: totpCode(secret) },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).user.mfa).toMatchObject({ enabled: false, method: null });

    // Back to enrollment-required after disabling.
    const res = await linkToken(app, token);
    expect(JSON.parse(res.body).error.code).toBe("MFA_ENROLLMENT_REQUIRED");

    await app.close();
  });
});

describe("MFA gate in single_user mode", () => {
  it("never blocks the owner — there is no login to add a factor to", async () => {
    const app = await server("single_user");
    const res = await app.inject({ method: "POST", url: "/api/plaid/link-token", payload: {} });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
