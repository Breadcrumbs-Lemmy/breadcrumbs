# AI Fin OS (Breadcrumbz)

A personal-finance operating system: connect accounts (Plaid) or import
statements (CSV/PDF), and get a clear, honest read on **where your money is
going**, what's recurring, and what you can actually afford — with an AI
assistant scoped to your own data.

> Status: pre-production. See `coordination/STATUS.md` for the current state and
> `docs/` for design, data-safety, and roadmap notes.

## Monorepo layout

| Package | What it is |
| --- | --- |
| `packages/core` | Pure domain logic — money math (integer cents), date/period bucketing, spending summaries, insights, recurrence & pattern detection, affordability. No I/O. |
| `packages/server` | HTTP API (Fastify). Auth (scrypt + sessions), per-user stores, Plaid + CSV/statement ingestion, and the AI agent (Anthropic). |
| `apps/web` | Vite + React single-page app. |

## Prerequisites

- Node.js 22.x
- pnpm 10.x (`corepack enable`)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in the values (see below)
```

## Develop

```bash
pnpm run dev:api   # API on http://127.0.0.1:8787
pnpm run dev:web   # web on http://localhost:5173
```

## Build & test

```bash
pnpm run build     # typecheck core + server, build web
pnpm test          # core + server unit/integration tests
```

## Configuration

All secrets live in `.env` (git-ignored — never commit it). See
`.env.example` for the full list. Key variables:

| Variable | Purpose |
| --- | --- |
| `PLAID_ENV` / `PLAID_CLIENT_ID` / `PLAID_SECRET` | Plaid credentials & environment (`sandbox` \| `production`). |
| `ANTHROPIC_API_KEY` / `BREADCRUMBZ_AGENT_MODEL` | AI assistant provider + model. |
| `BREADCRUMBZ_AUTH_MODE` | `single_user` (default, no login) or `multi_user` (real accounts). **Set explicitly for any shared deployment.** |
| `BREADCRUMBZ_CORS_ORIGINS` | Comma-separated allowed browser origins. |

For local Plaid Production OAuth, keep Sandbox credentials in `.env`, copy
`docs/plaid-production.local.example` to `.env.production.local`, fill in the
Production values, generate a `mkcert` certificate, and run
`pnpm run dev:api:production-local` followed by `pnpm run dev:web:https`. The
exact redirect URI is `https://localhost:5173/`; the complete setup is in
[`apps/web/README.md`](apps/web/README.md#local-production-oauth).

## Deploy

Docker images are provided (`Dockerfile.api`, `Dockerfile.web`,
`docker-compose.yml`). Terminate TLS in front of the API and set
`BREADCRUMBZ_AUTH_MODE=multi_user` before exposing it to the internet.

## License

Proprietary — all rights reserved.
