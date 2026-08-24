# Running Breadcrumbz

Status: Living  
Last updated: 2026-08-06

## Quick start

Two terminals, no Docker:

```bash
pnpm install && pnpm run dev:api
```

```bash
pnpm run dev:web
```

- Web → <http://localhost:5173>
- API → <http://localhost:8787>
- Health → <http://localhost:8787/health>

This is the path that has actually been run. The Docker path below is written and reviewed but has never been built here.

The app starts empty. Open **Import**, choose a CSV your bank exported, map its columns, check the preview, and commit — every other screen then reads what you imported.

Two things are optional, and the product works without either. **Plaid**: without credentials the API starts normally and Plaid routes are simply not registered. **The assistant**: without `ANTHROPIC_API_KEY` the chat and PDF-statement routes are not registered, and CSV import plus every spending endpoint still work. The assistant is a layer over the spending engine, not a dependency of it.

## With Docker

```bash
docker compose up --build
```

Same ports. Imported statements persist on a named volume; `docker compose down -v` deletes them, without `-v` they survive.

## Upgrading from Breadcrumbs (the rename)

The app was renamed **Breadcrumbs → Breadcrumbz**. This was a hard rename: the config
prefix, the on-disk data directory, and the Docker volumes all changed, with no
backward-compatible fallback. If you ran the old name, migrate once before upgrading —
nothing is read from the old locations anymore.

**Local (the default path).** The data directory moved from `~/.breadcrumbs` to
`~/.breadcrumbz`. Move your existing store so nothing is lost:

```bash
mv ~/.breadcrumbs ~/.breadcrumbz   # or `cp -R` to keep the old copy as a backup
```

**Environment variables.** Every `BREADCRUMBS_*` key is now `BREADCRUMBZ_*`
(e.g. `BREADCRUMBS_ENCRYPTION_KEY` → `BREADCRUMBZ_ENCRYPTION_KEY`,
`VITE_BREADCRUMBS_API_BASE_URL` → `VITE_BREADCRUMBZ_API_BASE_URL`). Rename the keys in
your `.env`; the old names are silently ignored, which means dropped config, not an error.

**Docker.** The named volumes were renamed (`breadcrumbs-data` → `breadcrumbz-data`, and
in the local-agent overlay `breadcrumbs-ollama-models` → `breadcrumbz-ollama-models`). A
plain `docker compose up --build` would start against a fresh empty volume and leave your
data — and the multi-GB Ollama model cache — stranded in the old ones. Copy them across first:

```bash
docker volume create breadcrumbz-data
docker run --rm -v breadcrumbs-data:/from -v breadcrumbz-data:/to alpine \
  ash -c 'cp -a /from/. /to/'
# local-agent overlay only — preserves the downloaded model weights:
docker volume create breadcrumbz-ollama-models
docker run --rm -v breadcrumbs-ollama-models:/from -v breadcrumbz-ollama-models:/to alpine \
  ash -c 'cp -a /from/. /to/'
```

## What I need from you: Plaid credentials

Sign up at **<https://dashboard.plaid.com/signup>**. Free, no card required for Sandbox.

Then open **Developers → Keys** (<https://dashboard.plaid.com/developers/keys>) and copy three values into a `.env` file at the repository root:

```bash
PLAID_ENV=sandbox
PLAID_CLIENT_ID=<your client_id>
PLAID_SECRET=<your Sandbox secret>
```

| Value | Where | Notes |
| --- | --- | --- |
| `client_id` | Dashboard → Developers → Keys | One per team, same across environments |
| Sandbox `secret` | Same page | **One secret per environment.** Copy the Sandbox one. |
| `PLAID_ENV` | You set it | `sandbox` for now |

**Start in Sandbox, not Production.** Sandbox gives lifelike data with test credentials, so the whole flow can be exercised without touching a real bank. Log in with `user_good` / `pass_good`, and `1234` if a 2FA code is requested.

### Connecting your real accounts later

Production access is a separate application in the Plaid dashboard, and Plaid reviews it. When you get there you will need a Production secret, and the app will need `PLAID_ENV=production`.

**One blocker to know about now:** `packages/server/src/plaid/config.ts` currently pins `env` to the literal `"sandbox"` and will reject anything else. That was a deliberate safety choice while the scaffold was young. Widening it is a small change, but it should come with real token encryption first — see the security note below.

### What is safe to put where

| Variable | Lives | Why |
| --- | --- | --- |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | Server only, `.env` | Server-side secrets |
| `VITE_BREADCRUMBZ_API_BASE_URL` | Build arg, public | Just a URL |
| Anything secret with a `VITE_` prefix | **Never** | Vite inlines `VITE_*` into the browser bundle in plain text. A secret placed there is published to every visitor. This is a build guarantee, not a discipline problem. |

The browser never sees a Plaid secret or an `access_token`. It requests a `link_token`, opens Link with it, and hands the resulting `public_token` straight back to the server, which exchanges it. The browser keeps only a `connectionId`.

## Loading data

### In the app (the normal way)

**Import** → choose a file → map columns → check → commit.

The mapping step asks one question with no default: **does a purchase appear as a positive or a negative number on your statement?** Banks disagree, and getting it backwards turns your pay into spending — so the screen makes you look at a sample row and say. Everything else it can suggest from your headers, and you confirm.

If you're importing a credit card, it also asks for the **statement closing day**. That one number turns on the statement period, where the total matches the bill you actually pay instead of the calendar month. A CSV export never contains it.

Preview-then-commit exists so a wrong mapping costs a second attempt rather than polluting totals that are awkward to un-pollute.

### PDF statements

Plenty of banks — credit cards especially — only give you a PDF. With the assistant configured, choose the PDF in the same Import flow and it gets transcribed into rows.

**The model transcribes; it does not import.** Its output becomes a CSV and goes through exactly the same mapping, row-level validation, category normalisation, duplicate protection, and preview as a hand-mapped file. A misread row fails validation and shows up in the preview; it does not become a wrong number in a total. Anything the transcription wasn't sure about is listed above the mapping form, and nothing is committed until you say so.

### Through the API

1. `POST /api/v1/local/statement-imports/columns` — headers, sample rows, suggested mapping.
2. `POST /api/v1/local/statement-imports/preview` with the CSV text and a column mapping.
3. Check the row-level errors and warnings.
4. `POST /api/v1/local/statement-imports/commit` once the preview looks right.

A minimal commit body. `account` is required on the first import for an account and optional afterwards:

```json
{
  "csv": "date,description,amount\n2026-06-05,NETFLIX.COM,15.99",
  "accountId": "acct_checking_1",
  "account": {
    "id": "acct_checking_1",
    "displayName": "Everyday Checking",
    "institutionName": "First National",
    "type": "checking",
    "currency": "USD",
    "currentBalanceCents": 412300
  },
  "currency": "USD",
  "dateFormat": "iso",
  "mapping": {
    "postedDate": "date",
    "description": "description",
    "amount": "amount",
    "amountSignConvention": "outflow_positive"
  }
}
```

`amountSignConvention` is required whenever you map a single `amount` column, because banks disagree on the sign of a purchase. Use `outflow_positive` when a purchase is a positive number, `signed` when a purchase is negative. Alternatively map `debitAmount` and `creditAmount` instead of `amount`. Getting this backwards turns your income into spending, which is why the field has no default.

Imported data is written under `~/.breadcrumbz/local-data/`, outside the project tree. In `single_user` mode (the default) it is a single `statement-imports.json`; in `multi_user` mode each user gets their own `users/<userId>/statement-imports.json` so accounts never mix. Set `BREADCRUMBZ_LOCAL_DATA_DIR` to move the root. Deleting the file(s) resets the app to empty.

## Periods

| Period | State |
| --- | --- |
| Week | Live. ISO weeks, Monday start. |
| Month | Live. Calendar months. |
| Year | Live. |
| Statement | Live **once a card carries a closing day**. Supply it when you import the card. The UI discovers this from `GET /api/v1/accounts` rather than a local flag, so it cannot drift; with no cycle anywhere the period stays off, because the endpoint would otherwise fall back to a calendar month wearing a "Statement" label. |

Every period is bucketed in `packages/core/src/domain/periods.ts`. The browser never buckets anything (`CD-003`).

## The assistant

Optional. Set `ANTHROPIC_API_KEY` in `.env` and restart the API; `GET /health` reports `agent: enabled`.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/v1/agent/status` | Whether it's configured. **Always registered**, so the UI can explain the gap instead of 404ing. |
| `POST` | `/api/v1/agent/chat` | A reply plus the list of tools it read |
| `POST` | `/api/v1/agent/statement-extract` | A PDF or pasted text → CSV rows |

**Every figure the assistant states comes back from `@ai-fin-os/core`** — the same functions that render the Spending screen. It picks which question to ask and how to phrase the answer; it never adds, divides, compares periods, or classifies a transfer. There is deliberately no `calculate` tool. If it needs a figure the tools don't expose, the fix is a new deterministic function in core, not a better prompt.

That constraint is visible in the product: each reply names what it read ("Read from your spending totals, your transactions"). An assistant that states a number without showing where it came from is asking to be trusted, and `D-002` is the position that it shouldn't have to be.

Model and effort are set in `packages/server/src/agent/config.ts`. Override the model with `BREADCRUMBZ_AGENT_MODEL`.

## The API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus Plaid and assistant status |
| `GET` | `/api/v1/spending/summary?period=week\|month\|year\|statement&key=&accountId=` | Period totals, categories, comparison |
| `GET` | `/api/v1/spending/series?period=&count=` | N periods of totals, for trends |
| `GET` | `/api/v1/transactions?from=&to=&accountId=&category=&flowType=&search=&cursor=&limit=` | Paginated transactions |
| `GET` | `/api/v1/insights?period=&key=` | Waste detection plus recurring charges |
| `GET` | `/api/v1/accounts` | Institutions, balances, statement cycles |
| `POST` | `/api/v1/affordability/evaluate` | Affordability verdict |
| `GET` | `/api/v1/affordability/snapshot` | Snapshot derived from your imported history |
| `POST` | `/api/v1/local/statement-imports/columns` | CSV headers, samples, suggested mapping |
| `POST` | `/api/v1/local/statement-imports/preview` | Dry-run CSV import |
| `POST` | `/api/v1/local/statement-imports/commit` | Commit an import |
| `POST` | `/api/plaid/link-token` | Link token (Plaid configured only) |
| `POST` | `/api/plaid/exchange-public-token` | Returns `connectionId` only |
| `GET` | `/api/v1/agent/status` | Assistant availability (always registered) |
| `POST` | `/api/v1/agent/chat` | Assistant reply plus the tools it read (key required) |
| `POST` | `/api/v1/agent/statement-extract` | PDF or text statement → CSV rows (key required) |

Full payload shapes: `docs/ui-api-contract.md`.

## Statement cycles

The feature the product exists for. A card closing on the 18th means the bill arriving in August is mostly July spending, so a calendar-month total can never reconcile to the bill you actually pay.

Set a closing day on a credit card and `GET /api/v1/accounts` returns `statementCycle` with `currentPeriodSpendCents` — what this bill will actually cover.

`source` distinguishes `user_provided` from `inferred`, and the UI labels an inferred cycle as an estimate. A guessed closing day presented as fact would be worse than no cycle at all.

## Checks

```bash
pnpm test && pnpm build
```

`pnpm test` runs 65 tests across `packages/core` and `packages/server`. `pnpm build` type-checks the API and builds the web bundle — and note that **the web build is the only one that type-checks `packages/core` under `noUnusedParameters`**, because the web app pulls core's sources in through its type imports. Core and server can both pass alone while `pnpm build:web` fails. Run the full `pnpm build` before believing the tree is clean.

## Notes that will bite otherwise

**The API base URL is baked in at build time.** Vite inlines it. Changing where the API lives means rebuilding the web image, not restarting it.

**Use `localhost`, not `api`.** The browser resolves `VITE_BREADCRUMBZ_API_BASE_URL`, and the browser is on your machine, not inside the compose network. `http://api:8787` resolves only between containers.

**The container binds `0.0.0.0`.** The server defaults to `127.0.0.1`, which inside a container means the container's own loopback and is unreachable from the host. Compose overrides `HOST`.

**Imported data is on a volume.** `docker compose down -v` deletes it. Without `-v` it survives.

## Not yet built

- Plaid Link in the browser. The server side exists; the button does not.
- Docker images have never been built or run in this workspace. Expect to shake out image issues on the first `up`.
- The category taxonomy is thin against real statements. Descriptors it doesn't recognise land in `unknown` and keep their raw text — honest, but a band labelled "Unknown" is not useful. Tracked as `L-008`.
- Goal tracking. Nothing in a statement declares an intention, so goals stay empty until there's a way to set one.
- Spending predictions.
- No authentication. This is single-user and local. **Do not expose this to the internet as it stands.**

## What "Can I afford it?" needs from you

It builds its projection from your imported accounts and history — derived income, derived bills, real balances (`GET /api/v1/affordability/snapshot`). Two things it cannot derive:

- **A balance.** Supply one when you import, or the answer comes back as *not enough information* rather than guessing.
- **Confirmation that the bill list is complete.** The screen shows the recurring bills it found and asks you to confirm there are no others. Rent paid from an account you didn't import leaves no trace in the one you did, so only you can answer — and the engine blocks with `COVERAGE_INCOMPLETE` until you do. That gate is deliberate: a projection over an unknown share of your obligations would look precise and be wrong.

## Security posture, stated plainly

Local, single-user, read-only. Plaid access tokens are held in memory only and are lost on restart — deliberately, because persisting them properly needs encryption at rest that does not exist yet. Nothing in this stack writes to a financial account, and no route can move money.

Before this is exposed anywhere beyond your machine it needs authentication, encrypted token storage, and consent and deletion flows. That is a real body of work, not a configuration change.
