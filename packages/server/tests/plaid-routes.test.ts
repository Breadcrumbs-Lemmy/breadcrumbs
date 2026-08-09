import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerPlaidRoutes } from "../src/http/plaid-routes";
import type { PlaidClientLike } from "../src/plaid/adapter";
import type { PlaidConfig } from "../src/plaid/config";
import { InMemoryPlaidTokenStore } from "../src/plaid/token-store";

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
