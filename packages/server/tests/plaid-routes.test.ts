import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerPlaidRoutes } from "../src/http/plaid-routes";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import type { PlaidJwk } from "../src/plaid/webhook";
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

  it("syncs the item on a verified TRANSACTIONS webhook and rejects a forged one", async () => {
    const kp = webhookKeypair("kid-1");
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
          added: [plaidTxn({ transaction_id: "t1", account_id: "checking-1", amount: 5, name: "Coffee" })],
          modified: [],
          removed: [],
          next_cursor: "cursor-after-1",
          has_more: false,
          request_id: "req-sync",
        },
      }),
      webhookVerificationKeyGet: vi.fn().mockResolvedValue({ data: { key: kp.jwk } }),
    });

    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore, stores });

    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-123" });

    // A forged body (no valid signature) is refused with an opaque 400 and never
    // touches the sync path.
    const forged = await app.inject({
      method: "POST",
      url: "/api/plaid/webhook",
      headers: { "content-type": "application/json", "plaid-verification": "not-a-jwt" },
      payload: body,
    });
    expect(forged.statusCode).toBe(400);
    expect(client.transactionsSync).not.toHaveBeenCalled();

    // The genuine, signed delivery drives a real sync into the store.
    const signed = await app.inject({
      method: "POST",
      url: "/api/plaid/webhook",
      headers: { "content-type": "application/json", "plaid-verification": signWebhook(kp, body) },
      payload: body,
    });
    expect(signed.statusCode).toBe(200);
    expect(JSON.parse(signed.body)).toMatchObject({ received: true });

    const state = await statementStore.load();
    expect(state.transactions.map((t) => t.id)).toEqual(["plaid:transaction:t1"]);
    const after = await tokenStore.get(connection.connectionId);
    expect(after?.transactionsCursor).toBe("cursor-after-1");

    await app.close();
  });

  it("flags the connection for re-auth on an ITEM_LOGIN_REQUIRED webhook", async () => {
    const kp = webhookKeypair("kid-1");
    const tokenStore = new InMemoryPlaidTokenStore();
    const connection = await tokenStore.save({ itemId: "item-123", accessToken: "access-token-secret" });

    const client = mockClient({
      webhookVerificationKeyGet: vi.fn().mockResolvedValue({ data: { key: kp.jwk } }),
    });
    const app = fastify({ logger: false });
    await registerPlaidRoutes(app, { client, config, tokenStore });

    const body = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "item-123",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/plaid/webhook",
      headers: { "content-type": "application/json", "plaid-verification": signWebhook(kp, body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const after = await tokenStore.get(connection.connectionId);
    expect(after?.reauthRequired).toBe(true);

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
    webhookVerificationKeyGet: vi.fn(),
    ...overrides,
  } as PlaidClientLike;
}

type WebhookKeypair = { kid: string; privateKey: KeyObject; jwk: PlaidJwk };

function webhookKeypair(kid: string): WebhookKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  return {
    kid,
    privateKey,
    jwk: { kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "", kid, alg: "ES256", use: "sig" },
  };
}

/** A real ES256 JWS over `body`, matching what Plaid puts in `Plaid-Verification`. */
function signWebhook(kp: WebhookKeypair, body: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: kp.kid, typ: "JWT" }), "utf8").toString("base64url");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const payload = Buffer.from(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: bodyHash }),
    "utf8",
  ).toString("base64url");
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign({ key: kp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
