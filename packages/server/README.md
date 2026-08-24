# packages/server

Single Fastify backend API for Breadcrumbz. It is the one deployable backend
service; `packages/core` is an internal domain library it depends on, not a
separate microservice.

Every figure the API returns comes from `@ai-fin-os/core`. Routes are thin, the
assistant's tools are read-only over that same engine, and nothing computes a
financial number outside it — so the chat, the screens, and the importer can
never disagree.

## Running

From the repository root:

```bash
pnpm install
pnpm run dev:api
```

Default local URL: `http://127.0.0.1:8787`. It boots with no configuration at
all: single-user mode, CSV import, and every spending endpoint work immediately;
the assistant and Plaid report an accurate "not configured" state until you set
their keys.

## Capabilities and how they degrade

| Capability            | Enable with                                         | Off by default does |
|-----------------------|-----------------------------------------------------|---------------------|
| Spending + CSV import | nothing                                             | fully works         |
| Accounts / affordability | nothing                                          | fully works         |
| Multi-user + admin    | `BREADCRUMBZ_AUTH_MODE=multi_user`                  | single-user, no login |
| Hosted assistant      | `ANTHROPIC_API_KEY`                                 | chat routes unregistered |
| Local (offline) assistant | `BREADCRUMBZ_AGENT_PROVIDER=local` + base URL   | chat routes unregistered |
| Assistant memory      | nothing (always on when the store is wired)         | uploads / facts / history available |
| Plaid                 | `PLAID_CLIENT_ID` / `PLAID_SECRET`                  | Plaid routes unregistered |

## Authentication & isolation

Two modes, switched by `BREADCRUMBZ_AUTH_MODE`:

- **single_user** (default) — no login. Every request acts as the implicit
  owner, reading the owner's own isolated data. Keeps the app frictionless when
  you run it just for yourself.
- **multi_user** — real accounts. A single `onRequest` hook resolves the caller
  for every `/api` route and 401s anything not on the public allowlist. The
  first registrant (or `BREADCRUMBZ_OWNER_EMAIL`) becomes the bootstrap admin.

Per-user isolation is by construction, not by remembering a `WHERE user_id = ?`:
handlers resolve a store, memory, or Plaid connection scoped to
`request.principal.userId` and can reach no other user's. A guessed id for
another user's statement, uploaded file, or bank connection returns the same
404 a missing one does — no existence leak. This is covered end to end in
`tests/auth-routes.test.ts`, `tests/agent-memory-routes.test.ts`, and
`tests/plaid-isolation.test.ts`.

## The assistant

Optional, and layered on top — the product is decision support, never advice
(`D-002`), and the deterministic engine comes first (`D-003`). Two providers,
one interface (`src/agent/provider.ts`):

- **anthropic** (default) — the hosted Claude model. Also transcribes PDF/text
  statements into the same deterministic import path.
- **local** — an OpenAI-compatible model running on this machine (Ollama, LM
  Studio, llama.cpp). Its base URL **must be a loopback address**; the server
  refuses to construct a "local" agent pointed anywhere the internet can reach,
  so the "runs locally, cannot access the internet" guarantee is enforced in
  code (`assertLoopbackUrl`), not just documented. It handles chat **and**
  transcribes digital PDFs fully offline — the server extracts the text layer and
  the local model reads it; only scanned/image-only PDFs (no text layer) still
  need the hosted model, and that case is reported, not silent.

**Chat and extraction can run on different providers.** Statement extraction is a
narrow, well-defined job, so `BREADCRUMBZ_EXTRACTION_PROVIDER` can point it at a
small, cheap specialist independently of chat — e.g. a local, offline chat model
paired with a small hosted extractor. That independence has a privacy edge: with
a **local chat model and a hosted extractor**, a statement's text leaves the
machine on import even though chat never does. So the offline guarantee is
resolved and reported **per job** — `/status` returns `offline` (chat) and
`extractionOffline` separately, the UI qualifies its on-device pill accordingly,
and the server logs a warning at startup — never one flag that would then be a
lie. Unset ⇒ extraction runs wherever chat does (backward compatible).

### Memory

Per user, on disk, and readable without a model (`src/agent/memory/`). Four
layers: durable **facts** (preferences, standing context, a summary of each
uploaded file), a rolling **short-term working note**, full **conversation**
history, and **uploaded files** the assistant learns from. Retrieval is offline
keyword scoring — no embeddings, no network — so the memory honours the same
offline guarantee the local model runs under. A user can read or delete any of
it by opening a file under their data directory.

## Endpoints (selected)

- `GET /health`
- `POST /api/v1/auth/register` · `POST /api/v1/auth/login` · `POST /api/v1/auth/logout` · `GET /api/v1/auth/context`
- `GET /api/v1/admin/users` (admin) and account-management routes
- `POST /api/v1/local/statement-imports/{columns,preview,commit}`
- `GET /api/v1/spending/summary` · `/series` · `/transactions` · `/insights` · `/accounts`
- `POST /api/v1/affordability/evaluate` · `GET /api/v1/affordability/snapshot`
- `GET /api/v1/agent/status` (always) · `POST /api/v1/agent/chat` · `POST /api/v1/agent/statement-extract` (both providers; the local one reads a digital PDF's text layer offline)
- `GET/POST /api/v1/agent/memory/files` · `GET/POST/DELETE /api/v1/agent/memory/facts` · `GET /api/v1/agent/memory/conversations`
- `POST /api/plaid/link-token` · `/exchange-public-token` · `GET /api/plaid/connections` · `.../{accounts,transactions,snapshot}` · `POST .../sync` · `DELETE .../:connectionId`

## Environment

Copy `.env.example` at the repository root. The keys, grouped:

- **Server** — `HOST`, `PORT`, `BREADCRUMBZ_CORS_ORIGINS`, `BREADCRUMBZ_LOCAL_DATA_DIR`.
- **Auth** — `BREADCRUMBZ_AUTH_MODE`, `BREADCRUMBZ_OWNER_EMAIL`, `BREADCRUMBZ_REGISTRATION_OPEN`.
- **Assistant** — `BREADCRUMBZ_AGENT_PROVIDER`, then either `ANTHROPIC_API_KEY`
  (+ optional `BREADCRUMBZ_AGENT_MODEL`, `BREADCRUMBZ_EXTRACTION_MODEL`) or
  `BREADCRUMBZ_LOCAL_AGENT_BASE_URL` (+ `BREADCRUMBZ_LOCAL_AGENT_MODEL`,
  `BREADCRUMBZ_LOCAL_EXTRACTION_MODEL`, `BREADCRUMBZ_LOCAL_AGENT_ALLOW_NONLOOPBACK`).
  The `*_EXTRACTION_MODEL` knobs give PDF statement transcription its own model
  (defaults to the chat model), so a fast chat model can pair with a stronger extractor.
  To run extraction on a *different provider* than chat, set
  `BREADCRUMBZ_EXTRACTION_PROVIDER` (`anthropic` or `local`, defaults to the chat
  provider); a local extractor takes its own `BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL`
  (+ `_ALLOW_NONLOOPBACK`), and a hosted extractor reuses `ANTHROPIC_API_KEY` and
  defaults its model to a small, cheap one (not the big chat default) in the mixed
  local-chat config — override with `BREADCRUMBZ_EXTRACTION_MODEL`.
- **Plaid** — `PLAID_ENV`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_CLIENT_NAME`, `PLAID_COUNTRY_CODES`.

## Tests

```bash
pnpm --filter @ai-fin-os/server test
pnpm --filter @ai-fin-os/server exec tsc --noEmit
```
