# Product Backlog

Status: Living  
Last updated: 2026-08-06

This backlog is now ordered by the transaction-first Breadcrumbs pivot from `D-011`.
Do not pick from it as an unstructured task list. Work should move top to bottom
unless a handoff or user decision explicitly changes the sequence.

## Status, 2026-08-06

Track A is complete. A person can open the app, import a statement, and use every
screen — verified end to end in a browser. `L-003a` (import UI), `L-006`
(statement closing day), and `L-007` (affordability on real accounts) all landed,
along with a first AI layer (`S-011`) that answers questions over the
deterministic engine and transcribes PDF statements.

`L-GATE-001` can now be run as a user, which is the gate's actual intent.

## Now / Next / Later

**Now: A. Immediately Buildable Local Single-User MVP**

1. `L-001` Local API foundation, local-only persistence abstraction, and safe CSV import. **Done — backend implemented under the single Fastify API boundary.**
2. `L-002` Local imported-data spending summary endpoint over canonical transactions. **Done — `/api/v1/local`, plus the five screen endpoints under `/api/v1`.**
3. `L-003` Spending home UI consumes local API/import state without UI-owned financial calculations. **Split:**
   - `L-003b` Spending home reads the API and performs no financial arithmetic. **Done.**
   - `L-003a` CSV upload, column mapping, preview, and commit UI. **Done 2026-08-06**, including PDF statements via the assistant.

**Next: B. Required Integration Test / Demo Gate**

4. `L-GATE-001` Run the full local app against a real user CSV export or sanctioned sample CSV, verify import validation, category normalization, and spending-home totals end to end. **Runnable as a user now.** The developer path passed 2026-08-06; the UI path was driven end to end the same day against a generated statement. Still to do: one pass with a **real** bank export, which is the only thing that tests the taxonomy and column shapes we haven't seen.

**After Gate: C. Plaid Connection Work**

5. `L-004` Plaid Link UI and server-side Plaid aggregation wired to the same canonical account, transaction, category, and spending-summary contracts.

**After Plaid Shape Is Stable: D. Multi-User/Auth/Persistence Hardening**

6. `L-005` User accounts, authenticated API boundary, authorization checks, database schema, encrypted token/data persistence, retention, deletion, and audit controls.
7. `S-010` AI explanation over computed facts. **First slice done as `S-011`** — see below.

## Small Items Worth Doing Alongside

Each is small, each came out of the 2026-08-06 integration pass (`H-028`), and
none of them needs to wait its turn in the sequence above.

| Id | Item | Why |
| --- | --- | --- |
| `L-006` | Capture a statement closing day during CSV import and switch the statement period on | **Done 2026-08-06.** The import screen asks for it on credit cards; the UI discovers statement support from `GET /api/v1/accounts` rather than a local flag (`CD-013`). |
| `L-007` | Point "Can I afford it?" at the user's imported accounts | **Done 2026-08-06.** `GET /api/v1/affordability/snapshot` derives income, bills, and coverage from history. `apps/web/src/model/snapshot.ts` no longer imports a backend fixture. |
| `L-008` | Extend the category taxonomy from real import data | **Substantial progress 2026-08-08 (overnight backend session).** Landed (a) Plaid PFC detailed-code coverage in `normalizeRawCategory` and (b) 49 hand-curated high-frequency US merchant aliases (`MERCHANT_ALIAS_RULES`, e.g. McDonald's, Chick-fil-A, AT&T, T-Mobile, Xfinity, Exxon, YouTube). Deliberately ambiguous names (SUBWAY, bare BP/MAX) left to `unknown`. Proven by `pnpm --filter @ai-fin-os/core test` (`normalization.test.ts` L-008 blocks, 49-case `it.each` + unknown guards). Still open: long-tail merchants and non-US formats — reopen when a real export exposes a gap. |
| `L-009` | Revisit the spending hero figure | **Open.** It steps down a type size past six characters to avoid overflowing its cell, which costs the intended emphasis on most real months. A design call, not a code fix. |
| `L-010` | Goal tracking | **Open — and now a hard blocker for `S-006`.** `buildSnapshotFromHistory` (`snapshot-from-history.ts:110`) and the Plaid mapper (`mapper.ts:74`) both hard-code `goals: []`; there is no goal persistence and no goal-set endpoint, so no real read flow ever carries a goal. `D-010` picked `monthly_savings_target` as the first type. Backend shape (from the 2026-08-08 `S-006`/`L-010` feasibility trace, see `HANDOFFS.md` H-056 item 4): (a) per-user goal persistence in the statement-import store; (b) a goal set/read endpoint (new `UI_BACKEND_CONTRACT` slice — coordinate with the `apps/web` sessions before fixing the contract, the goal-setting UI is theirs); (c) plumb `goals` into `detectInsights` (`InsightsOptions.goals`) **and** into `buildSnapshotFromHistory`/the affordability snapshot, which lights up the already-written goal-aware affordability reasons on real data too. |

The previous `S-001` through `S-008` story sequence remains authoritative for
the product foundation already built or queued. `L-001` deliberately pulls the
local parts of former `S-009` forward because the user now needs a first usable
end-to-end MVP on imported transaction data before Plaid. Plaid production access,
real authentication/JWT, browser-side secrets, and multi-user persistence are
not part of `L-001`.

## Local-First MVP Delivery Plan

### L-001 Local API Foundation, Persistence Abstraction, And Safe CSV Import

- Track: **A. Immediately buildable local single-user MVP work.**
- Status: Backend implemented and verified by `[Backend: Codex]` on 2026-08-04. UI consumption remains `L-003`.
- Story statement: As a local prototype user, I need to import historical CSV bank statements through a backend API so the product can answer "Where is my money going?" from real transaction history rather than only fixtures.
- Product center: Transaction-first spending visibility across accounts and institutions. Affordability remains secondary and must not drive this import flow.
- Ordered dependencies: `D-011`; `D-012`; `CD-010`; `docs/money-flow-taxonomy.md`; `docs/pattern-detection-spec.md` normalization assumptions; existing Fastify server in `packages/server`; existing `Account`, `Transaction`, `FlowType`, and `summarizeMonthlySpending` contract in `packages/core`.
- Backend ownership:
  - Add local Fastify routes that can run without Plaid credentials.
  - Accept CSV text first with explicit caller-provided column mapping. Do not attempt statement PDF parsing in this story because bank PDF formats are not standardized.
  - Validate required columns, dates, amounts, currency, account metadata, duplicate rows, and flow/category ambiguity with deterministic row-level errors.
  - Map valid rows into canonical `Transaction[]` with `source: "csv"`, backend-owned `flowType`, normalized category, and normalized merchant id.
  - Provide a persistence interface with a local-only implementation that stores imported prototype data outside source files and never stores secrets.
  - Return summaries from backend-owned `summarizeMonthlySpending`; do not ask UI to aggregate.
- UI ownership:
  - Later story `L-003`: read a local CSV file in-browser, let the user map columns explicitly, call the backend import endpoint, show row-level validation errors, and render the backend spending summary.
  - No browser-side Plaid secrets, access tokens, auth secrets, or financial aggregation.
- Acceptance criteria:
  - Server starts locally and `/health` works without requiring Plaid credentials.
  - API exposes CSV import preview and commit paths with the same validation contract under `/api/v1/local`, with `/api/local` retained only as a compatibility alias.
  - CSV import requires explicit mappings for posted date, amount or debit/credit amount, and merchant/description.
  - Import rejects missing required columns, malformed dates, invalid money, invalid currency, unknown account ids, and empty files with row-level diagnostics.
  - Import supports a supplied account descriptor so statement rows keep account/institution ownership.
  - Import categorizes common shopping, travel, food/dining/grocery, income, refunds, fees, transfers, and unknowns deterministically.
  - Untrusted transfer-like rows map to `UNCLASSIFIED` unless a later matching pass can prove an internal transfer.
  - Duplicate imports do not double-count committed rows.
  - No user CSV data, local database, Plaid credential, token, or secret is written under the project source tree by default.
  - Focused tests cover preview validation, commit persistence, category/merchant normalization, duplicate protection, and spending summary output.

### L-002 Local Imported-Data Spending Summary Endpoint

- Track: **A. Immediately buildable local single-user MVP work.**
- Status: Backend endpoint implemented with `L-001`; UI consumption remains `L-003`.
- Story statement: As a local prototype user, I need the backend to return account, transaction, and monthly spending summary data from committed CSV imports so the spending home can render real local data.
- Ordered dependencies: `L-001`; `summarizeMonthlySpending`.
- Acceptance criteria:
  - `GET /api/v1/local/spending-summary?currency=USD` returns imported accounts, transactions, import batch metadata, and `MonthlySpendingSummary[]`.
  - Response uses backend-owned transfer exclusion, refund netting, category totals, merchant totals, account totals, institution totals, and comparisons.
  - Empty state is explicit when no CSV has been committed.

### L-003 Spending Home UI Uses Local API Import State

- Track: **A. Immediately buildable local single-user MVP work.**
- Status: **Split on 2026-08-06.** The read half is done; the import half was never started and is the product's blocking gap.
- Story statement: As a local prototype user, I need to upload a bank CSV, map its columns, see validation feedback, and then see the spending home populated by backend-owned totals.
- Ordered dependencies: `S-003`; `L-001`; `L-002`; `H-019`.

#### L-003b Spending Home Reads The API — Done

- Verified 2026-08-06 against a committed CSV import.
- `services/api.ts` is the single HTTP boundary; `SpendingScreen`, `TransactionsScreen`, `InsightsScreen`, and `AccountsScreen` all render from it.
- The UI performs no financial arithmetic: `netCents` and `shareBasisPoints` are backend-owned, and the remaining numeric operations are formatting and pixel scaling.
- Week, month, and year period views are live. Statement is deliberately off — see `L-006`.

#### L-003a CSV Upload, Mapping, And Preview UI — Done 2026-08-06

`apps/web/src/screens/ImportScreen.tsx`. Four steps: file → columns → check → commit. Driven end to end in a browser against a 63-row generated statement with quoted descriptions and `mm/dd/yyyy` dates.

Two backend additions supported it:

- `POST /api/v1/local/statement-imports/columns` returns headers, sample rows, and suggested mappings — so the **browser never parses a financial file**. A `split(",")` in the UI would disagree with the real parser the first time a description contained a comma, which the test file deliberately does.
- The account descriptor accepts a `statementCycle` (see `L-006`).

`amountSignConvention` is offered with **no default and no suggestion**, deliberately: a header name cannot tell you whether a positive number means money in or out, and guessing wrong turns income into spending. The screen shows sample rows and makes the user say.

- Acceptance criteria, all met:
  - User selects a `.csv` file; the browser reads it as text and sends it to `POST /api/v1/local/statement-imports/preview`. The file itself is never uploaded to anywhere else.
  - User maps columns **explicitly**. No silent header guessing. Assisted guesses are fine if the user confirms them.
  - `amountSignConvention` is an explicit, required choice whenever a single amount column is mapped, and the screen states what it means in plain language. Getting it backwards turns income into spending, which is why the API has no default.
  - Preview renders row-level errors and warnings from the response — `INVALID_DATE`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `MISSING_REQUIRED_VALUE`, `UNKNOWN_CATEGORY`, and both duplicate codes — and shows counts for valid, invalid, and duplicate rows. Invalid rows are never silently dropped.
  - Commit is a separate deliberate action, reachable only after a preview. Commit returns 422 with the same shape when rows are invalid; the screen must handle that, not assume 200.
  - First import for an account collects the account descriptor (display name, institution, type, currency, optional balance); later imports for the same `accountId` do not ask again.
  - A user who has never imported anything is offered this flow from the empty state on the spending home, not left to find it.
  - Historical statement PDF upload is shown as deferred or unsupported, not parsed client-side.
  - UI does not calculate spending totals, category rollups, account rollups, transfer exclusions, refund netting, or period comparison.

### L-GATE-001 Full Local Integration Test / Demo Gate

- Track: **B. Required integration test/demo gate.**
- Status: **Partially met.** Run 2026-08-06 by a developer using an HTTP client for the import step. Cannot be met as written until `L-003a` exists, because "start web locally and import a CSV" is not something the web app can do.

**Exit criteria, scored 2026-08-06:**

| Criterion | State |
| --- | --- |
| End-to-end manual demo passes locally | **Partial.** Import was driven through the API, not the UI. Every screen then rendered correctly from that data. |
| At least one automated integration-style test exercises the import-to-summary backend path | **Met.** `packages/server/tests/spending-routes.test.ts` starts each case from a real CSV commit and covers summary, week/year periods, insights, transactions, and accounts. |
| UI and backend contract docs match the endpoint payload actually used in the demo | **Met.** `docs/ui-api-contract.md` was corrected against the running endpoints. |
| User knows exactly where to place local CSV data and how to keep it out of committed files | **Met.** `docs/running-breadcrumbs.md` documents `~/.breadcrumbs/local-data/`, `BREADCRUMBS_LOCAL_DATA_DIR`, and a working import body. |

**Four defects the gate surfaced**, all fixed and detailed in `H-028`: the web
build was broken by an unused parameter in core; insights silently ignored a
requested week key; subscription detection never ran on imported data because
`recurrenceSignal` was written by nothing; and the UI's `PERIOD_SUPPORTED` flag
hid two working period views. The gate paid for itself before it finished.
- Story statement: Before connecting Plaid, the product must prove the full local path works with imported transaction history.
- Ordered dependencies: `L-001`; `L-002`; `L-003`.
- Gate procedure:
  - Start backend locally.
  - Start web locally.
  - Import a sanctioned sample CSV or a real user-exported CSV kept outside source control.
  - Confirm explicit column mapping, row validation, duplicate handling, normalized categories, unclassified transfers, and monthly spending totals.
  - Confirm the spending home answers "Where is my money going?" across every imported account/institution in the data set.
- Exit criteria:
  - End-to-end manual demo passes locally.
  - At least one automated integration-style test exercises the import-to-summary backend path.
  - UI and backend contract docs match the endpoint payload actually used in the demo.
  - User knows exactly where to place local CSV data and how to keep it out of committed files.

### L-006 Capture A Statement Closing Day And Turn The Statement Period On

- Track: **A**, alongside `L-003a`. Small, and it unlocks the view the product was described around.
- Status: **Done 2026-08-06.** The import screen asks for a closing day on credit cards; `source` is pinned server-side to `user_provided` so a stated cycle can never be mistaken for an inferred one; a cycle supplied for a checking account is ignored, because an account that never closes should not wear a "closes on the 18th" badge. The UI reads statement availability from `GET /api/v1/accounts` rather than a local constant (`CD-013`).
- Story statement: As someone who spends heavily on a credit card, I need the total to match the bill I actually pay, not the calendar month.
- Why it is dark today: `statementPeriodForDate` is implemented and correct. It needs `account.statementCycle.closingDay`, and CSV import captures none, so `summarizeSpending` falls back to a calendar month. The UI keeps the period switched off rather than label a calendar month "Statement" — a guessed cycle presented as fact is worse than no cycle.
- Acceptance criteria:
  - The account descriptor in CSV import accepts an optional closing day, and the import UI asks for it on credit-card accounts.
  - `PERIOD_SUPPORTED.statement` flips to true only when at least one account carries a cycle; the period selector explains the requirement otherwise.
  - `statementCycle.source` distinguishes `user_provided` from `inferred`, and an inferred cycle is labelled as an estimate wherever it appears.
  - Selecting the statement period requires an account, matching the API's existing `ACCOUNT_ID_REQUIRED_FOR_STATEMENT` behaviour.

### L-007 Affordability Evaluates The User's Real Accounts

- Track: **A**, after `L-003a`.
- Status: **Done 2026-08-06.** `packages/core/src/domain/snapshot-from-history.ts` + `GET /api/v1/affordability/snapshot`. Verified in a browser: the forecast timeline showed the user's own biweekly payroll, their rent, and their subscriptions.

**Three things this surfaced, each worth remembering:**

1. **The subscription detector was the wrong source for bills.** `detectRecurringSpending` deliberately excludes required categories — it answers "what could you cancel", and rent is not a subscription. Reusing it alone produced a snapshot listing Netflix and Spotify while omitting a $1,450 rent payment, which would have made every verdict optimistic. Required bills are now detected separately, from their own repetition.
2. **Imported accounts weren't in the forecast.** `includeInForecast` defaulted to `false`, so an imported checking account with a balance produced `balancesDeclaredComplete: false` and a permanent `UNKNOWN`. Cash accounts now default to included; liabilities still don't, because a card balance is not money available to spend.
3. **`userConfirmedNoOtherRequiredObligations` cannot be derived, and shouldn't be.** Rent paid from an account you never imported leaves no trace in the one you did. The engine blocks on it, correctly. The Check screen now lists the bills it found and asks the user to confirm — their statement about their own finances, not a checkbox to get past.
- Problem: `apps/web/src/model/snapshot.ts` builds the `FinancialSnapshot` from `packages/core/fixtures/mvp0/affordable-steady-paycheck.json`, imported by relative path. So "Can I afford it?" answers about fixture balances and a fixture paycheck, and the browser bundle reaches into backend-internal files at build time — a `D-013` / `CD-011` violation that the type system cannot see.
- Acceptance criteria:
  - The snapshot is built from the user's imported accounts and detected recurring obligations, served by the API rather than assembled in the browser.
  - No `apps/web` source file imports anything under `packages/core/fixtures/`. Scenario fixtures for the demo switcher, if kept, come through an explicit dev-only path.
  - Coverage gaps produce `UNKNOWN` with `COVERAGE_INCOMPLETE` rather than a confident answer from partial data.

### L-008 Extend The Category Taxonomy Against Real Statements

- Track: **A**, opportunistic — and now the **first thing a real bank export will test**.
- Status: Open. Opened 2026-08-06.
- Observation: real descriptors that the taxonomy misses fall through to `unknown` and keep their raw text, so the spending home showed a `$222` "Unknown" band and a row reading `CHIPOTLE 1290`. Falling through is the correct behaviour — `S-004` deliberately prefers uncertainty to false precision — but the taxonomy is thin against actual bank exports.
- Acceptance criteria:
  - Common restaurant, fast-food, rideshare, pharmacy, and utility descriptors normalize.
  - Additions arrive as fixture cases in `merchant-normalization-cases.json` first, so coverage is measured rather than asserted.
  - Unknown remains a first-class outcome. Do not widen a rule until it guesses.

### L-009 Revisit The Spending Hero Figure

- Track: **A**, design decision.
- Status: Open question for the user. Opened 2026-08-06.
- Problem: `text-hero` (2.75rem) needs ~23px per character and the cell holds 160px at a 1280px viewport — six characters. `$6,704.48` overflowed into "Came in". The screen now steps the figure down one size past six characters, which fixes the collision but loses the intended dominance on most real months.
- Options, none yet chosen: give the hero cell more width than the other two; round the headline figure and keep exact amounts in the rows below; or lower the hero token. All three are design calls.

### L-004 Plaid Link And Live Multi-Institution Aggregation

- Track: **C. Plaid connection work after local import works.**
- Status: Deferred until `L-GATE-001` passes.
- Story statement: As a user, I need to connect read-only bank accounts through Plaid so imported CSV can be replaced by live transaction sync.
- Ordered dependencies: `D-012`; `H-013`; `L-GATE-001`.
- Acceptance criteria:
  - Browser receives only a Plaid Link token and later a local `connectionId`.
  - Plaid access tokens stay server-side.
  - Plaid transactions flow through the same canonical category, merchant, flow, and spending-summary contracts as CSV imports.
  - Production Plaid access remains blocked until auth, consent, encrypted storage, deletion, retention, and sync-health controls exist.

### L-005 Multi-User/Auth/Persistence Hardening

- Track: **D. Multi-user/auth/persistence hardening afterward.**
- Status: Deferred until local import and Plaid shape are stable.
- Story statement: Before beta or shared use, every persisted account, transaction, Plaid token, and import batch must be scoped to an authenticated user with authorization checks and secure storage.
- Ordered dependencies: `L-004`; database decision update; security acceptance criteria.
- Acceptance criteria:
  - Real authentication is implemented; placeholder JWT parsing is not enough.
  - Every route reads user identity from trusted server-side auth context and enforces resource ownership.
  - Database schema scopes accounts, transactions, imports, Plaid connections, goals, and summaries to a user.
  - Plaid tokens and sensitive data are encrypted at rest.
  - Deletion, disconnect, retention, audit logging, and least-privilege access controls are tested.
  - No browser-side secrets or access tokens exist.

## MVP 0 Story Plan

### S-001 Multi-Account Transaction Fixture And Transfer-Safe Normalization

- Status: Backend implemented, verified, and accepted through `H-012`, `H-014`, and `H-016`.
- Story statement: As a user with money entering and leaving several accounts, credit cards, and banks, I need the product to treat all of my accounts as one financial picture so transfers are not mistaken for spending.
- Desired outcome: The first product demo starts from realistic transactions, not invented UI-only data, and spending totals do not double-count credit-card payments or savings transfers.
- Ordered dependencies: `D-011`; `CD-010`; `H-012`; `H-014`; `docs/money-flow-taxonomy.md`; existing `FinancialSnapshot`, `Account`, and `Transaction` model.
- Backend ownership: Define money-flow classification, canonical fixture data, transfer matching/exclusion rules, tests, and contract docs.
- UI ownership: Consume backend-provided flow fields and disclosures; do not classify transfers, card payments, refunds, or unclassified movement in UI code.
- Acceptance criteria:
  - Fixture exists with two or three institutions, checking, savings, and credit-card accounts, two to three months of history, salary deposits, income deposits to more than one account, spending across cash and credit accounts, recurring services, duplicate-ish services, varied categories, refunds, savings transfers, and credit-card payments.
  - Every canonical transaction has backend-owned `flowType`.
  - Matched internal transfers include `counterAccountId` and `transferMatchConfidence`.
  - Credit-card payments and savings transfers are excluded from spending totals and disclosed separately.
  - Unpaired transfer-like movement remains `UNCLASSIFIED`, not spending and not silently ignored.
  - Focused tests cover fixture output, transfer exclusion, credit-card treatment, unclassified transfer behavior, refund handling, and multi-account/multi-institution attribution.
- Preserved technical tasks:
  - Define transaction fields: date, merchant, amount, account, category, recurrence signal, confidence, and flow classification.
  - Convert invalid and incomplete input cases into deterministic validation fixtures.
  - Keep duplicate-protection and false-precision safeguards from `data-quality-and-safety.md`.

### S-002 Spending Aggregation Contract

- Status: Backend implemented, verified, and accepted by UI through `H-015`.
- Story statement: As a user asking "Where is my money going?", I need monthly spending totals, account attribution, institution attribution, categories, merchants, refunds, excluded transfers, and recent comparison from one backend contract.
- Desired outcome: The spending home can render without re-summing financial data in the UI.
- Ordered dependencies: `S-001`; `MonthlySpendingSummary`; `summarizeMonthlySpending`; `evaluateAffordability` response compatibility.
- Backend ownership: Own all aggregation, sorting, period comparison, refund netting, and attribution fields.
- UI ownership: Format and lay out the fields; no UI-side financial aggregation, transfer classification, refund netting, or period subtraction.
- Acceptance criteria:
  - `MonthlySpendingSummary` includes net external spending, gross external outflow, income, refunds, category totals, merchant totals, account totals, institution totals, excluded transfer totals, excluded credit-card payment totals, unclassified movement totals, and backend-computed comparison.
  - Category and merchant totals are net of refunds and expose refund amounts separately.
  - Per-account and per-institution totals are available directly.
  - Recent-versus-baseline comparison includes total and category deltas.
  - Contract remains consumable through the single Fastify API boundary without UI-side aggregation.
- Preserved technical tasks:
  - Define backend-derived monthly spending summary fields.
  - Add deterministic tests for spending aggregation behavior.
  - Add tests for deterministic repeatability.

### S-003 Spending Home UI Handoff And Implementation Dependency

- Status: **Done.** `apps/web/src/screens/SpendingScreen.tsx` is the implementation and the app opens on it. Verified 2026-08-06 rendering week, month, and year totals from a real CSV import. Specified in `docs/ui-spending-home.md`.
- Story statement: As a user opening Breadcrumbs, I need the first screen to show where my money went across all accounts, with transfers disclosed but not counted as spending.
- Desired outcome: UI replaces mock transaction data with the backend fixture and contract, then builds the spending home from backend-owned numbers.
- Ordered dependencies: `S-001`; `S-002`; updated `coordination/UI_BACKEND_CONTRACT.md`; UI-facing handoff from `[Backend: Codex]` to `[UI: Claude]`.
- Backend ownership: Provide fixture, contract, examples, and verification status.
- UI ownership: Build the spending home, account/institution filters, transfer disclosure, refund disclosure, empty/partial-history states, and navigation into affordability.
- Acceptance criteria:
  - UI imports backend fixture/contract rather than keeping invented mock transaction data as the source of truth.
  - UI displays total money out, excluded transfers, unclassified movement, categories, merchants, account attribution, institution attribution, and comparison from backend fields.
  - UI does not calculate spending totals, transfer exclusions, refund netting, account rollups, institution rollups, or period deltas.
  - UI files any missing presentation fields through a handoff before implementing workarounds.
- Preserved technical tasks:
  - Build the spending summary/home screen once a transaction fixture exists.
  - Define empty, incomplete-data, and uncertainty states for no transactions, partial history, and unclassified movement.

### S-004 Categorization And Merchant Normalization

- Status: Backend implemented and verified by `[Backend: Codex]` on 2026-08-04 while `S-003` / `L-003` UI work proceeds in parallel. UI consumption is handed off through `H-021`. Recurring-subscription and Plaid work remain queued.
- Story statement: As a user scanning spending, I need merchant names and categories to be stable enough that the same service does not appear under noisy variants.
- Desired outcome: Transaction history can support categories, merchants, filters, and future insights without UI-owned cleanup rules.
- Ordered dependencies: `S-001`; `S-002`; `docs/pattern-detection-spec.md` normalization assumptions; spending home contract feedback from `S-003`.
- Backend ownership: Deterministic merchant canonicalization, alias map, category taxonomy, category mapping, ambiguity flags, tests.
- UI ownership: Render backend category and merchant labels; surface ambiguity states without inventing category logic.
- Acceptance criteria:
  - Known aliases such as `NETFLIX.COM`, `SPOTIFY USA`, and `APPLE.COM/BILL` normalize deterministically.
  - Minimum category taxonomy from `pattern-detection-spec.md` is implemented or explicitly tracked for any missing category.
  - Unknown or ambiguous merchants carry uncertainty rather than being forced into false precision.
  - Tests cover aliasing, category mapping, ambiguous processors, unknown categories, and cross-account non-deduplication.
- Backend closeout:
  - `packages/core/src/domain/normalization.ts` now owns the MVP 0 category taxonomy, category display labels, required-default flags, merchant canonicalization, alias rules, processor ambiguity handling, and transfer-like/payment safeguards.
  - CSV import and the existing Plaid Sandbox mapper both call the shared core normalizer, so checking, savings, credit-card, CSV, and future Plaid rows share the same labeling rules.
  - `MonthlySpendingSummary.categoryTotals[]` now includes backend-owned `displayName` and `requiredDefault`; `merchantTotals[]` now includes `merchantAmbiguity`, `ambiguousTransactionCount`, and `unknownTransactionCount`.
  - `packages/core/fixtures/mvp0/merchant-normalization-cases.json` and `packages/core/tests/normalization.test.ts` cover Netflix variants, Spotify variants, Apple billing variants, travel/food/shopping descriptors, ambiguous processors, unknown merchants, payment-like false positives, and cross-account non-deduplication.
- Preserved technical tasks:
  - Define category and merchant normalization outputs needed by the spending home.
  - Convert pattern-detection normalization rules into deterministic code and tests.

### S-005 Recurring Subscriptions

- Status: **Backend implemented 2026-08-04; connected to real data 2026-08-06.** Between those dates the capability existed and did nothing for users: `detectInsights` and `TransactionView.isRecurring` read `Transaction.recurrenceSignal`, which only hand-written fixtures carried, so imported statements always reported zero subscriptions while `detectRecurringSpending` — right there in the same package — found them. `annotateRecurrenceSignals` now derives the signal from history and the server applies it on read. See `CD-012`.
- Story statement: As a user, I need recurring services to be recognized across accounts so subscriptions and duplicate-ish services are visible.
- Desired outcome: The product identifies likely recurring services without confusing required bills, credit-card payments, transfers, or one-time purchases for subscriptions.
- Ordered dependencies: `S-004`; `docs/pattern-detection-spec.md` Rule 1 and Rule 3; fixture history from `S-001`.
- Backend ownership: Recurrence detection, recurring service grouping, confidence scoring, duplicate-service evidence, tests.
- UI ownership: Display likely subscription facts and confidence language from backend outputs.
- Acceptance criteria:
  - Likely subscriptions detect monthly services from repeated merchant/category evidence.
  - Duplicate-ish services can be grouped, including same service group and same merchant across accounts.
  - Required bills, card payments, savings transfers, and ignored transactions are excluded.
  - Confidence and assumptions are exposed with deterministic debug traces for tests.
- Preserved technical tasks:
  - Detect likely subscriptions from recurring merchant and amount patterns.
  - Detect possible duplicate services.
  - Attach assumptions and confidence to each insight.
- Backend closeout:
  - `packages/core/src/domain/pattern-detection.ts` adds `detectRecurringSpending`, deterministic Rule 1 likely-subscription detection, Rule 3 possible duplicate-service grouping, MVP 0 service-group taxonomy, confidence factors/caps, assumptions, uncertainties, savings-impact estimates, neutral explanations, and stable insight ordering.
  - Detection uses backend-owned `normalizedMerchantId`, `merchantCanonical`, `merchantAmbiguity`, normalized category metadata, `flowType`, transfer trust rules, account/institution evidence, and optional pattern tags.
  - Same-account duplicate records are removed before pattern detection, while same-merchant charges across different accounts remain evidence for duplicate-service grouping.
  - Required-default categories, required/one-time/planned/reimbursable/ignored tags, income, transfers, credit-card payments, refunds, fees, cash, unclassified movement, unstable amounts, inactive cadence windows, and insufficient history are excluded or downgraded with diagnostics.
  - `packages/core/fixtures/mvp0/recurring-subscriptions-cases.json` and `packages/core/tests/pattern-detection.test.ts` cover monthly subscriptions, cross-account same-merchant duplicates, same-service-group duplicates, required bills, transfer/card-payment/refund exclusions, one-time safeguards, ambiguous two-charge app-store billing, incomplete history, canonical spending fixture behavior, and deterministic output order.
  - `Transaction.tags[]` is optional and supports the pattern-spec safeguards without requiring existing fixture, CSV, Plaid, server, or UI migrations.
  - Verification: `pnpm --filter @ai-fin-os/core test`, `pnpm test`, and `pnpm run build:api` pass.

### S-006 Comparison And Insights

- Status: **Mostly done, one rule outstanding.** `packages/core/src/domain/insights.ts` implements `FREQUENT_SMALL_PURCHASES`, `RISING_CATEGORY`, and `POSSIBLE_DUPLICATE_SERVICE`, served by `GET /api/v1/insights` and rendered by `InsightsScreen`. **Goal-conflict detection is not implemented.** `LIKELY_SUBSCRIPTION` is declared in the `InsightType` union but never emitted — the `recurring` block carries that information instead, so either emit it or drop it from the union.
- **Blocked on `L-010` (2026-08-08 feasibility trace).** The remaining goal-conflict rule cannot be a self-contained backend slice today: `detectInsights` has no `goals` parameter, and every real read flow supplies `goals: []` (`snapshot-from-history.ts:110`, `mapper.ts:74`) with no persistence or goal-set endpoint behind it. Writing the rule now would repeat `CD-012` — green on fixtures, structurally empty in production. Do `L-010` (goal persistence + set/read endpoint + plumb `goals` into `detectInsights` and the snapshot builders) first; the deterministic rule itself (spec fixtures `F-009` Category Goal Conflict, `F-010` Savings Pace Conflict) is small once the input exists. Full trace in `HANDOFFS.md` H-056 item 4.
- Two notes from the 2026-08-06 pass: `POSSIBLE_DUPLICATE_SERVICE` needs three concurrent services in one substitutable category (`duplicateMinimumMembers + 1`), which is quieter than `detectRecurringSpending`'s own duplicate rule that fires at two — worth reconciling. And `RISING_CATEGORY` is suppressed for partial periods by design, so it never fires on the current month.
- Story statement: As a user, I need to understand what changed recently and which patterns may affect my goals without judgmental language.
- Desired outcome: Spending home can progress from totals to explainable insights.
- Ordered dependencies: `S-002`; `S-004`; `S-005`; `docs/pattern-detection-spec.md` Rules 2, 4, and 5; `D-006`.
- Backend ownership: Rising category detection, frequent small-purchase detection, goal-conflict detection, savings-impact estimates, confidence, assumptions, deterministic ordering.
- UI ownership: Render neutral insight copy and controls; do not compute thresholds, savings impacts, or goal gaps.
- Acceptance criteria:
  - Rising categories compare recent spend to a backend baseline.
  - Frequent small purchases are detected by merchant/category with safeguards.
  - Goal conflicts use explicit goals only.
  - Potential impact estimates are backend-computed and non-advice.
  - Insight order is deterministic and documented.
- Preserved technical tasks:
  - Detect rising categories over a baseline period.
  - Detect frequent small purchases by merchant and category.
  - Detect behaviors that conflict with stated goals.
  - Estimate potential savings impact for each insight.

### S-007 Affordability As A Supporting Action

- Status: **Placement done, inputs wrong.** The endpoint, the HTTP client, and the round trip all work, and the flow is reached from the spending home as a secondary action rather than being the home screen. But it evaluates a fixture snapshot rather than the user's accounts — tracked as `L-007`, and the single most misleading thing in the running app, because the verdict looks authoritative and is about someone else's money.
- Story statement: As a user reviewing spending, I need to ask "Can I afford this?" from the spending context without making affordability the home screen.
- Desired outcome: The existing deterministic affordability engine remains intact and is reachable from spending surfaces.
- Ordered dependencies: `POST /api/v1/affordability/evaluate`; `S-003` spending home navigation; future UI decision on placement.
- Backend ownership: Preserve forecast, decision levels, reasons, assumptions, freshness, validation, fixtures, and reason-code coverage.
- UI ownership: Relocate or invoke the existing affordability flow from the spending home; keep result screen simpler than the rejected inspector layout.
- Acceptance criteria:
  - Existing affordability tests remain green.
  - Affordability uses the same account model and transaction history but keeps day-level forecast timing separate from monthly summaries.
  - UI continues to consume backend reasons and metrics over HTTP without recalculating them.
  - The backend reason-code fixture gap is resolved through `H-010`; UI runtime copy verification can consume the canonical fixtures when UI work resumes.
- Preserved technical tasks:
  - Set up and maintain tests for forecast and decision logic.
  - Maintain fixture-backed runtime coverage for the four H-010 reason codes.
  - Keep cash buffer visible and read-only for MVP 0.

### S-008 Plaid Link And Live Multi-Institution Aggregation

- Status: Later; server scaffold exists, UI wiring remains open under `H-013`.
- Story statement: As a user, I need to connect real institutions read-only so Breadcrumbs can replace fixture data with live account and transaction history.
- Desired outcome: Plaid feeds the same canonical transaction and spending contracts without exposing secrets or access tokens in browser code.
- Ordered dependencies: `S-001` through `S-006`; server-only Plaid scaffold; `H-013`; secure persistence decision before beta.
- Backend ownership: Server-side Link token creation, public-token exchange, account/transaction retrieval, canonical mapping, token storage, consent, deletion, sync health.
- UI ownership: Plaid Link browser flow, connection status UI, disconnected/stale states, and no browser secrets.
- Acceptance criteria:
  - Browser stores only `connectionId` plus display data.
  - Access tokens remain server-side.
  - Multiple Plaid connections aggregate through the same flow-safe transaction contract.
  - Beta work includes encrypted persistence, authentication, deletion, disconnect, data retention, and sync-health flows.
- Preserved technical tasks:
  - Add Plaid read-only account connection.
  - Replace the in-memory token store before beta use.
  - Add Plaid consent, connection deletion, sync-health, and data-retention flows.

### S-009 Local Persistence And Import Hardening

- Status: **Largely absorbed by `L-001`**, which pulled the local parts forward deliberately. CSV import, canonical mapping, duplicate protection, deterministic row-level validation, and file-backed persistence outside the source tree are all done. What remains under this story: the SQLite schema and migration strategy (the store is a JSON file today), and editable local data in the UI.
- Story statement: As a local prototype user, I need transaction history, accounts, and goals to persist and import repeatably.
- Desired outcome: The local product can move beyond fixtures without requiring live Plaid.
- Ordered dependencies: `S-001`; `S-002`; `S-004`; storage decision from `D-008`.
- Backend ownership: SQLite schema/repository, CSV import adapter, validation fixtures, migration strategy.
- UI ownership: Import flow, progress/errors, editable local data where appropriate.
- Acceptance criteria:
  - CSV import maps into canonical transactions with `flowType` or explicit uncertainty.
  - Local persistence preserves account/institution ownership and freshness metadata.
  - Duplicate imports do not double-count transactions.
  - Validation errors are deterministic and actionable.
- Preserved technical tasks:
  - Add CSV transaction import.
  - Add local persistence.
  - Convert backend design docs into a pure TypeScript domain package where still incomplete.
  - Convert documented scenarios into JSON fixtures and Vitest table tests.

### S-011 Assistant Over The Deterministic Engine

- Status: **First slice done 2026-08-06.** `packages/server/src/agent/`, surfaced as `apps/web/src/screens/AssistantScreen.tsx`.
- Story statement: As a user, I want to ask questions about my money in plain language and get answers I can check.
- **The architectural constraint, and the whole design:** every figure the assistant can state comes back from `@ai-fin-os/core`. Its six tools are the same functions that render the Spending screen. It chooses which question to ask and how to phrase the answer; it never adds, divides, compares periods, or classifies a transfer. There is deliberately no `calculate` tool, and there should never be one — a figure the tools don't expose is a missing deterministic function, not a prompting problem.
- Each reply names the tools it read, shown in the UI. An assistant that states a number without showing where it came from is asking to be trusted, and `D-002` is the position that it shouldn't have to be.
- Optional, in the same way Plaid is: no `ANTHROPIC_API_KEY`, no agent routes, everything else works. `/api/v1/agent/status` is always registered so the UI can explain the gap rather than 404.
- **PDF statement transcription.** The model reads a statement the bank won't export as CSV and returns rows; those rows become a CSV and go through the identical deterministic import path — mapping, row validation, normalisation, duplicate protection, preview. A misread row fails validation and appears in the preview. It does not become a wrong number in a total. The model extracts; it never imports.
- Not done, and deliberately out of this slice: streaming replies, conversation persistence, goal-aware advice, anything that writes.

### S-010 AI Explanation Over Computed Facts

- Status: Later.
- Story statement: As a user, I may want conversational explanation after deterministic facts are stable, but AI must not perform financial calculations.
- Desired outcome: AI explains spending patterns, comparisons, assumptions, and affordability outputs grounded in backend facts.
- Ordered dependencies: `S-001` through `S-008`; stable insight contract; advice-boundary evaluation set.
- Backend ownership: Computed facts, guardrails, citations/trace fields for AI context.
- UI ownership: Chat/exploration interface, source display, error states.
- Acceptance criteria:
  - AI responses cite computed backend facts.
  - AI does not replace aggregation, forecast, decision, or pattern calculations.
  - Advice-boundary handling is covered by an evaluation set.
- Preserved technical tasks:
  - Add AI chat over deterministic computed facts.
  - Add an evaluation set for AI explanation quality and advice-boundary handling.
