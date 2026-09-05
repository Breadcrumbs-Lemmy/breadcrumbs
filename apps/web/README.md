# apps/web

MVP 0 user interface. React + Vite + TypeScript + Tailwind (`CD-004`, `D-009`).

## Running

From the repository root:

```bash
pnpm install
pnpm run dev:api
pnpm run dev:web
```

Run the API and web commands in separate terminals.

The API defaults to `http://127.0.0.1:8787`. The web app reads the public API
base URL from `VITE_BREADCRUMBZ_API_BASE_URL`; copy `apps/web/.env.example` to
`apps/web/.env.local` only when you need a non-default API URL. Values prefixed
with `VITE_` are browser-visible and must never contain secrets.

The app opens on Spending, per `D-011`. Affordability is a secondary action reached from that screen.

## Local Production OAuth

Plaid Production requires an HTTPS redirect URI. The web app includes an
opt-in HTTPS development server that uses a locally trusted `mkcert` certificate
and proxies `/api` to the HTTP API on port 8787, so the browser remains on one
secure origin.

On macOS, from the repository root:

```bash
brew install mkcert
mkcert -install
cd apps/web
mkcert -key-file localhost-key.pem -cert-file localhost.pem localhost 127.0.0.1 ::1
cd ../..
```

Keep the regular root `.env` as your Sandbox profile. Create the separate
Production profile from the checked-in template, then fill in your Production
Plaid client ID and secret:

```bash
cp docs/plaid-production.local.example .env.production.local
```

The copied file is ignored by Git. Register the same URI under Plaid Dashboard →
Developers → API → Allowed Redirect URIs:

```env
# .env.production.local
PLAID_CLIENT_ID=<Production client ID>
PLAID_SECRET=<Production secret>
BREADCRUMBZ_LOCAL_DATA_DIR=~/.breadcrumbz/production-local
```

Start the API with the production-local helper, then start the HTTPS web server:

```bash
pnpm run dev:api:production-local
pnpm run dev:web:https
```

Open `https://localhost:5173/`. The certificate files are ignored by Git and
are for local testing only. Keep `PLAID_WEBHOOK` blank in this setup because a
Plaid webhook must be reachable from the public internet. The helper overrides
the Plaid environment, redirect URI, local CORS allowlist, Secure-cookie setting,
and Production data directory for this terminal session; it does not change the
Sandbox defaults in `.env`. Stop the regular `dev:api` process before starting
the Production helper on port 8787.

To switch back to Sandbox, stop the Production helper and run `pnpm run dev:api`.

For real bank connections, also set `BREADCRUMBZ_ENCRYPTION_KEY` in `.env`
(generate one with `openssl rand -base64 32`) before linking an account.

Eight destinations: Spending, Transactions, Insights, Accounts, Assistant, Import, "Can I afford it?", and the last check's result. Every data screen reads the API over HTTP; a scenario switcher in the sidebar exercises every affordability level and both `UNKNOWN` causes against fixture inputs.

**Import** is the front door: choose a CSV (or a PDF, with the assistant configured), map columns, check the preview, commit. Everything else reads what you imported.

## Verification

```bash
pnpm --filter @ai-fin-os/web typecheck
pnpm --filter @ai-fin-os/web build
```

`scripts/verify-copy.ts` runs the real engine over every scenario and asserts that each emitted reason and assumption code produces complete copy, and that no unavailable figure renders as `$0.00`. It is a development guard, not a product surface.

## Architecture

- `services/api.ts` — the single HTTP boundary. Every endpoint the app uses lives here: spending summary and series, transactions, insights, accounts, affordability, and the two Plaid calls. It owns transport and nothing else; it does not sum, classify, compare, or reshape a financial figure. Components never call the engine, and the web app imports no backend runtime calculation function.
- `services/spending.ts`, `services/outcome.ts` — thin shaping over `api.ts` for the spending home and the affordability outcome union.
- `model/period.ts` — names the period kinds and records which the backend serves. `PERIOD_SUPPORTED` is a second copy of a backend fact and has drifted before; check it against `packages/core/src/domain/periods.ts` when periods change. Statement availability is *discovered* from `GET /api/v1/accounts` rather than declared here (`CD-013`).
- `services/import.ts`, `screens/ImportScreen.tsx` — the import flow. The browser reads a file as text and posts it; the server's parser returns the headers. It does not parse CSV itself.
- `services/agent.ts`, `screens/AssistantScreen.tsx` — the assistant. Optional; renders an accurate "not configured" state without an API key.
- `copy/` — every user-visible string, composed from backend codes and `ReasonParameterMap` parameters (`CD-006`). Records are exhaustive over the backend unions, so a new code added upstream breaks this build rather than reaching a user untranslated.
- `format/` — money and date formatting. Absent figures render as an em-dash, never `$0.00`.
- `model/` — display-safe views over response objects.
- `components/`, `screens/` — presentation.

## Rules

The UI does not calculate affordability. It has no arithmetic on backend values beyond formatting and absolute value for display; every figure shown is a named field from `AffordabilityResponse`. See the "UI Must Not Own" list in `coordination/UI_BACKEND_CONTRACT.md`.

Design source of truth: `docs/ui-design-system.md`, `docs/ui-copy-map.md`, `docs/ui-spending-home.md` (primary surface), `docs/ui-mvp0-screens.md` (affordability screens), `docs/money-flow-taxonomy.md` (why spending is not the sum of outflows).

## Separate Deployment

Deploy `apps/web` as a static Vite frontend and set
`VITE_BREADCRUMBZ_API_BASE_URL` to the public URL of the separately deployed
Fastify API. Deploy `packages/server` as the single backend API service. On the
API host, set `BREADCRUMBZ_CORS_ORIGINS` to the deployed web origin.
