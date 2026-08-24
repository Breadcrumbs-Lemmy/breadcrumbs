import { describe, expect, it } from "vitest";

import { loadPlaidConfig, PlaidConfigError } from "../src/plaid/config";

describe("loadPlaidConfig", () => {
  it("loads Sandbox configuration", () => {
    expect(
      loadPlaidConfig({
        PLAID_ENV: "sandbox",
        PLAID_CLIENT_ID: "sandbox-client",
        PLAID_SECRET: "sandbox-secret",
      }),
    ).toMatchObject({
      env: "sandbox",
      clientId: "sandbox-client",
      secret: "sandbox-secret",
      clientName: "Breadcrumbz",
      countryCodes: ["US"],
    });
  });

  it("loads Production configuration", () => {
    expect(
      loadPlaidConfig({
        PLAID_ENV: "production",
        PLAID_CLIENT_ID: "prod-client",
        PLAID_SECRET: "prod-secret",
        PLAID_CLIENT_NAME: "Breadcrumbz",
        PLAID_WEBHOOK: "https://app.example.com/api/plaid/webhook",
      }),
    ).toMatchObject({
      env: "production",
      clientId: "prod-client",
      clientName: "Breadcrumbz",
      webhook: "https://app.example.com/api/plaid/webhook",
    });
  });

  it("rejects an unknown environment without echoing secret values", () => {
    expect.assertions(3);

    try {
      loadPlaidConfig({
        PLAID_ENV: "development", // retired by Plaid; only sandbox|production remain
        PLAID_CLIENT_ID: "some-client",
        PLAID_SECRET: "do-not-print-this-secret",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PlaidConfigError);
      expect(String(error)).toContain("env");
      expect(String(error)).not.toContain("do-not-print-this-secret");
    }
  });

  it("rejects a missing client id without echoing the secret", () => {
    expect.assertions(2);

    try {
      loadPlaidConfig({
        PLAID_ENV: "production",
        PLAID_SECRET: "do-not-print-this-secret",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PlaidConfigError);
      expect(String(error)).not.toContain("do-not-print-this-secret");
    }
  });
});
