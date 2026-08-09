import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

import type { PlaidConfig } from "./config";

/**
 * Build a Plaid API client for the configured environment. `config.env` chooses
 * the base URL — `sandbox` for test institutions, `production` for real banks —
 * and the client credentials ride on every request as headers. The env is a
 * validated enum (see config.ts), so `PlaidEnvironments[config.env]` is always a
 * real base path.
 */
export function createPlaidClient(config: PlaidConfig): PlaidApi {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[config.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": config.clientId,
        "PLAID-SECRET": config.secret,
      },
    },
  });

  return new PlaidApi(configuration);
}
