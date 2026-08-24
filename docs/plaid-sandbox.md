# Plaid Sandbox Scaffold

Status: Living  
Last updated: 2026-08-23

## Purpose

This document describes the server-only Plaid Sandbox scaffold in `packages/server`.
It supports read-only account, balance, and transaction access for local
development. After `D-011`, this scaffold is a precursor to the spending home
and multi-institution aggregation work, but it is not itself the aggregation
layer or a production Plaid rollout.

## Safety Boundaries

- `PLAID_ENV` selects the environment: `sandbox` (test institutions, fake credentials) or `production` (real banks). The SDK client uses the matching Plaid base URL. Production requires separate dashboard credentials and, for most large banks, `PLAID_REDIRECT_URI`.
- The Link token requests only the `transactions` product. Plaid Balance access is available without adding `balance` as a Link product.
- `auth` and `identity` are not requested because the current product docs only require accounts, balances, and transactions.
- The adapter exposes no payment, transfer, investment, liability, processor, or account-write endpoints.
- Plaid `access_token` values stay server-side. The public-token exchange route returns a local `connectionId` and `itemId`, not the access token.
- Tokens persist durably: `FilePlaidTokenStore` writes them to a `0600` file under `BREADCRUMBS_LOCAL_DATA_DIR/plaid`, encrypted at rest (AES-256-GCM, bound to the connection id) when `BREADCRUMBS_ENCRYPTION_KEY` is set. Every retrieval route is scoped to the authenticated caller, so one user can never read another's connection.
- Fastify logging is disabled in the scaffold, and error responses are redacted to avoid echoing tokens or secrets.
- Tests mock Plaid and do not call the live Sandbox service.

## Environment

Copy the committed template and fill it locally:

```sh
cp .env.example .env
```

Plaid variables are required only when testing Plaid routes. The server can run
local CSV import routes with Plaid disabled; in that mode `/health` returns
`plaidEnv: "disabled"`.

Expected Plaid variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `PLAID_ENV` | Yes for Plaid | `sandbox` or `production`. Any other value is rejected. This guide uses `sandbox`. |
| `PLAID_CLIENT_ID` | Yes for Plaid | Plaid client id for the chosen env. Never paste it into chat or commit it. |
| `PLAID_SECRET` | Yes for Plaid | Plaid secret for the chosen env (production differs from sandbox). Never paste it into chat or commit it. |
| `PLAID_CLIENT_NAME` | No | Defaults to `Breadcrumbz`; Plaid displays it in Link. |
| `PLAID_COUNTRY_CODES` | No | Defaults to `US`; only `US` is accepted in this scaffold. |
| `PLAID_REDIRECT_URI` | No | OAuth redirect URI. Required for the OAuth banks most large institutions use in production; optional for non-OAuth sandbox banks. |
| `PLAID_WEBHOOK` | No | Public HTTPS URL Plaid delivers webhooks to (`…/api/plaid/webhook`). Enables real-time updates and re-auth flagging; the endpoint verifies Plaid's signature on every delivery. |
| `BREADCRUMBS_ENCRYPTION_KEY` | No (recommended in prod) | 32-byte key (hex or base64) that encrypts stored access tokens at rest. Absent, tokens are protected by file permissions only and the API warns on boot. |
| `HOST` | No | Defaults to `127.0.0.1`. |
| `PORT` | No | Defaults to `8787`. |
| `BREADCRUMBZ_LOCAL_DATA_DIR` | No | Local CSV import storage directory. Defaults to `~/.breadcrumbz/local-data`, outside the project tree. |

## Local Run

Install dependencies and start the server:

```sh
pnpm install
pnpm --filter @ai-fin-os/server dev
```

Health check:

```sh
curl http://127.0.0.1:8787/health
```

With no Plaid credentials loaded, the health response should be:

```json
{"status":"ok","plaidEnv":"disabled","localImports":"enabled"}
```

With valid Plaid Sandbox credentials loaded, `plaidEnv` is `sandbox` and the
Plaid routes below are available.

Create a Link token:

```sh
curl -X POST http://127.0.0.1:8787/api/plaid/link-token \
  -H "content-type: application/json" \
  -d '{"clientUserId":"local-dev-user"}'
```

The browser should receive only `linkToken`, `expiration`, and `requestId`.

After Plaid Link returns a `public_token`, send it to the server:

```sh
curl -X POST http://127.0.0.1:8787/api/plaid/exchange-public-token \
  -H "content-type: application/json" \
  -d '{"publicToken":"public-sandbox-token-from-link"}'
```

The response contains `connectionId`, `itemId`, and `requestId`. It must not
contain a Plaid `access_token`.

## Endpoints

All routes are under `/api/plaid`. Every `/connections/:connectionId/*` route is
scoped to the authenticated caller; `/webhook` is public and authenticates each
delivery by verifying Plaid's signature.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/link-token` | Create a Link token for `transactions`. |
| `POST` | `/exchange-public-token` | Exchange a browser `public_token` server-side and persist the access token (encrypted at rest when a key is set). |
| `GET` | `/connections` | List the caller's connections (no access tokens). Includes `reauthRequired` when the bank login needs repair. |
| `GET` | `/connections/:connectionId/accounts` | Retrieve balances and return canonical `Account[]`. |
| `GET` | `/connections/:connectionId/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | Retrieve transactions and return canonical `Transaction[]`. Pending transactions are excluded until the core model supports pending state. |
| `GET` | `/connections/:connectionId/snapshot?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&asOfDate=YYYY-MM-DD` | Retrieve accounts and transactions and map them into a conservative `FinancialSnapshot`. |
| `POST` | `/connections/:connectionId/sync` | Pull the latest accounts + transaction delta via `/transactions/sync` (cursor-based) into the caller's statement store. Idempotent. |
| `DELETE` | `/connections/:connectionId` | Remove the connection and its stored access token. |
| `POST` | `/webhook` | Receive Plaid webhooks. Verifies the signature, then syncs on a `TRANSACTIONS` delta or flags re-auth on an `ITEM_LOGIN_REQUIRED`-class event. |

The snapshot mapper sets `balancesDeclaredComplete` and
`userConfirmedNoOtherRequiredObligations` to `false` by default. A connected
Plaid item is not proof that the user has connected every account or declared
every obligation.

For the spending home, callers can retrieve multiple Sandbox connections and
aggregate their canonical `Account[]` and `Transaction[]` in a future backend
aggregation layer. That layer is intentionally not included in this scaffold.
It still needs institution metadata, duplicate-account handling, category and
merchant normalization, recurring detection, period comparisons, and
cross-institution rollups.

## Verification

No real Plaid credentials are required for automated checks:

```sh
pnpm --filter @ai-fin-os/server build
pnpm --filter @ai-fin-os/server test
pnpm build
pnpm test
```

Manual Link testing does require real Plaid Sandbox credentials in a local
`.env` file. Do not paste credentials into chat, docs, source, or tests.

## UI Handoff

The UI should not read Plaid credentials or access tokens. A future Plaid Link
UI should:

- call `POST /api/plaid/link-token` to get a Link token,
- initialize Plaid Link in the browser with that Link token only,
- send the returned `public_token` to `POST /api/plaid/exchange-public-token`,
- keep the returned `connectionId` as the browser-facing handle,
- call the read-only account, transaction, or snapshot endpoints using that `connectionId`,
- avoid adding any `VITE_PLAID_SECRET`, access-token, or Sandbox secret variable.

Before beta use, the server also needs authentication, encrypted token storage,
connection deletion, sync-health states, and a data-retention policy.
