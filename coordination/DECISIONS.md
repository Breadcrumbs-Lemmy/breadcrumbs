# Coordination Decisions

Status: Living  
Last updated: 2026-08-06

Use this file for cross-team implementation decisions. Do not duplicate the main product decision log except as a pointer. Product, architecture, data, and compliance decisions remain in `docs/decisions.md`.

Add new coordination decisions at the top.

## CD-015: A Model May Extract, But Only Deterministic Code May Import

Date: 2026-08-06  
Status: Accepted  
Owners: `[Shared]`

Decision: An LLM may transcribe a statement the product cannot parse — a PDF, pasted text, any format a bank invented. Its output is converted to CSV and passes through the same `previewCsvStatementImport` path as a hand-mapped file: explicit mapping, row-level validation, category normalisation, duplicate protection, and a preview the user confirms. No extraction path writes to the store directly, and none skips validation.

Rationale: there is no standard bank statement format, and a visual layout is exactly the shape of problem a model handles well and a parser does not. But a transcription error and a parse error have very different consequences if they reach a total. Routing extraction back through the deterministic path means the worst case of a misread row is a row that fails validation and appears in the preview — not a wrong number in someone's spending.

Consequences:

- `extractStatement` returns CSV plus detected metadata. It has no access to the store.
- The sign convention the model reads off the page preselects the control; the user still confirms it. The one field that turns income into spending when wrong is never decided without a human.
- Anything the model was unsure about is surfaced above the mapping form rather than silently dropped.
- The same rule governs any future ingest: a model may propose rows; only the deterministic path may accept them.

## CD-014: Every Figure The Assistant States Comes From The Deterministic Engine

Date: 2026-08-06  
Status: Accepted  
Owners: `[Shared]`

Decision: The assistant's tool surface is `@ai-fin-os/core` and nothing else. It selects which question to ask and how to phrase the answer; it performs no arithmetic, classification, or comparison of its own. There is no `calculate` tool and none should be added.

Rationale: `D-002` (decision support, not advice), `D-003` (deterministic engine before any AI surface), and `S-010` (AI explains computed facts, never calculates) have one architectural consequence, and this is it. The tools are the same functions that render the Spending screen, so the chat and the screens cannot disagree — a chat that could disagree with the app's own totals would undermine both.

Consequences:

- A figure the assistant needs and cannot get is a **missing deterministic function in core**, not a prompting problem. Do not close the gap with a smarter system prompt.
- Replies name the tools they read, and the UI shows it. Auditability is a product feature here, not logging.
- The agent is optional and degrades to absent, never to a version that answers from its own arithmetic.

## CD-013: A UI Flag That Mirrors A Backend Capability Must Name Its Source

Date: 2026-08-06  
Status: Accepted  
Owners: `[Shared]`

Decision: When the UI holds a flag describing what the backend can do — `PERIOD_SUPPORTED` is the current example — the flag must name the backend module it mirrors, and the backend module must be checked when that capability changes. Where a capability can be discovered from a response instead, discover it rather than declaring it.

Rationale: `apps/web/src/model/period.ts` declared that the backend produced calendar months only. That was true when written. `H-018` shipped week, month, year, and statement bucketing, and the flag was not updated, so the product rendered "Weekly view is coming" over a working weekly endpoint for two days. Nothing failed — no type error, no test, no runtime warning — because a stale boolean is indistinguishable from a correct one.

Consequences:

- A capability flag is a second copy of a fact that lives in backend code. Treat any second copy as drift waiting to happen.
- `PERIOD_SUPPORTED` now points at `packages/core/src/domain/periods.ts` in its comment, and `apps/web/README.md` flags it as drift-prone.
- Deliberately switching a working capability off is fine and sometimes right — statement periods are off because the backend would silently fall back to a calendar month without a closing day — but the reason must be written down where the flag is, not inferred later.

## CD-012: Derived Transaction Fields Are Computed On Read, Not Stamped At Import

Date: 2026-08-06  
Status: Accepted  
Owners: `[Shared]`

Decision: A field on `Transaction` whose value depends on other transactions is derived when the data is read, in one place, by the domain. It is not written by the CSV mapper, the Plaid mapper, or any other ingest path. Fixtures may state such a field explicitly, and an explicitly stated value is never overwritten.

Rationale: `recurrenceSignal` was read by `detectInsights`, by the duplicate-service detector, and by `TransactionView.isRecurring`. It was written by nothing. Every fixture carried it by hand, so every test passed; every imported statement lacked it, so the product reported "0 subscriptions, $0/mo" over data containing four monthly subscriptions, while `detectRecurringSpending` — already built, already tested, in the same package — found all four. The field is optional and absent means false, so there was no error to notice.

Recurrence also cannot honestly be stamped at import: it is a property of a series, and when the first charge is read the later ones have not happened.

Consequences:

- `annotateRecurrenceSignals` in `packages/core/src/domain/recurrence-annotation.ts` derives the signal from full history; `registerSpendingRoutes` applies it in its `load()` so every screen endpoint sees the same annotated data.
- **Any field read off a `Transaction` that neither the CSV nor the Plaid mapper writes has this failure mode.** Before relying on one, check who writes it.
- Tests for read-path behaviour start from an actual import. `packages/server/tests/spending-routes.test.ts` commits CSV and then queries, precisely so a fixture cannot supply what an importer would not.
- A fixture that hand-writes a derived field is stating an expected outcome, not exercising the derivation. Both have value; do not mistake one for the other.

## CD-011: Fastify API Is The Single Backend Deployment Boundary

Date: 2026-08-04  
Status: Accepted  
Owners: `[User decision]`, `[Shared]`

Decision: The frontend and API deploy separately. `packages/server` is the single backend deployment boundary. `packages/core` is internal backend domain code and must not be split into its own deployed service. This supersedes `CD-005` for UI/runtime integration.

Rationale: The user made an explicit architecture decision to separate frontend and API deployment without introducing backend microservices.

Consequences:

- `[Backend: Codex]` owns the Fastify API contract in `packages/server`, including affordability, local CSV import, spending summary, and future server-side Plaid endpoints.
- `[Backend: Codex]` keeps deterministic calculation, normalization, and aggregation in `packages/core` as a package dependency of `packages/server`.
- `[UI: Claude]` calls the HTTP API through client adapters and configures `VITE_BREADCRUMBS_API_BASE_URL` for each frontend deployment.
- Browser runtime code must not call `evaluateAffordability`, `summarizeMonthlySpending`, or backend financial calculation functions directly.
- **The line is browser-runtime versus not, added by `[UI: Claude]` 2026-08-04 after the migration.** Node development scripts under `apps/web/scripts/` still call the engine directly and should continue to. They never enter the browser bundle, and routing them through the HTTP client broke them outright: the service adapter reads `import.meta.env`, which is Vite-only, so the scripts stopped compiling under Node and would have needed a running server merely to check that a sentence renders. `apps/web/scripts/verify-copy.ts` is the guard that has caught two copy defects the type system could not; making it depend on a live server would be a net loss in safety. Type-only imports from `@ai-fin-os/core` remain fine everywhere, since they erase at build time and bundle nothing.
- Consequence for reviewers: `pnpm --filter @ai-fin-os/web build` passing is **not** sufficient evidence that UI code is healthy. Vite resolves `import.meta` happily, so a build stays green while the Node verification scripts are broken. Run `apps/web/scripts/verify-copy.ts` when changing files under `apps/web/`.
- No new API microservices, production auth, production Plaid, or browser-side secrets are introduced by this boundary update.
- Stable MVP 0 affordability HTTP operation: `POST /api/v1/affordability/evaluate`.
- Preferred local import HTTP paths: `/api/v1/local/statement-imports/preview`, `/api/v1/local/statement-imports/commit`, and `/api/v1/local/spending-summary?currency=USD`; `/api/local/...` remains a compatibility alias.

## CD-010: Product Pivot — Spending Visibility Is The Product

Date: 2026-08-04  
Status: Accepted  
Owners: `[User decision]`, `[Shared]`

Decision: By explicit user direction, the product's centre changes from "Can I afford this?" to "Where is my money going?", aggregated across all of the user's accounts and institutions. Recorded in full as `D-011`; `docs/product-charter.md` is amended and `docs/roadmap.md` is resequenced.

Rationale: See `D-011`. Summarised for coordination: a user checks spending continuously and asks about a specific purchase occasionally. The product was organised around the occasional question.

Consequences for `[Backend: Codex]`:

- **Nothing already built is invalidated.** `packages/core` remains correct. `evaluateAffordability`, the forecast paths, the reason codes, the assumption codes, and every test still stand. Only the product position of that output changes.
- **Transactions become the primary data object.** Until now MVP 0 could produce its answer with an empty `transactions[]`. The product's main screen cannot exist without them.
- **Categorisation, merchant normalisation, and recurring detection move onto the critical path.** They were downstream of affordability; they are now upstream of the home screen.
- **`MonthlySpendingSummary` is promoted** from a reporting side-output to a primary contract surface, and likely needs to grow: cross-account and cross-institution rollups, period comparison, and per-account attribution.
- **`docs/pattern-detection-spec.md` is promoted** from later scope to core scope.
- **Multi-institution aggregation moves from MVP 2 to the product definition.** Plaid work now gates the main screen.

Consequences for `[UI: Claude]`:

- The affordability result screen is demoted from home to a secondary destination.
- The spending home screen is new work and is the product's primary surface.
- The existing result screen was also rejected on design quality, independently of the pivot. It is being redesigned rather than merely relocated.

Tracked in `H-012`.

## CD-009: Handoff Ids Are Allocated By Owner Prefix

Date: 2026-08-03  
Status: Accepted  
Owners: `[Shared]`

Decision: Handoff ids are allocated from an owner-specific block rather than from a single shared counter. `[Backend: Codex]` opens odd-numbered ids, `[UI: Claude]` opens even-numbered ids. `[Shared]` and `[User decision]` handoffs use the next free id of either parity and note the owner explicitly.

Rationale: On 2026-08-03 both assistants independently opened a handoff numbered `H-007` within the same working window. Each had read the file, seen `H-006` as the highest id, and taken the next one. Neither did anything wrong; a single shared counter is simply not safe when two writers work in parallel against a file they cannot lock. The UI entry was renumbered to `H-008`, but the collision could have silently overwritten a request.

Consequences:

- A collision is now structurally impossible for the common case of two assistants working concurrently.
- When renumbering is still required, leave a numbering note in place of a silent edit so the other owner can follow the change.
- The same hazard applies to `CD-` ids in this file and `D-` ids in `docs/decisions.md`. Both are lower traffic, but an owner adding several at once should re-read the file immediately before writing.
- Re-read `HANDOFFS.md` immediately before adding an entry, not at the start of the session.

## CD-008: Cash Buffer Is Visible But Read-Only In MVP 0

Date: 2026-08-03  
Status: Accepted  
Owners: `[UI: Claude]`, `[User decision]`

Decision: The configured cash buffer (default `$250.00`) is displayed everywhere it affects an affordability result, but it is not user-editable in MVP 0. It remains fixture and config driven.

Rationale: The charter requires that assumptions be visible, and the buffer silently drives most `TIGHT` verdicts. Making it editable would require a settings surface, persistence, and a re-evaluate flow that MVP 0 does not otherwise need.

Consequences:

- UI reads the buffer from `snapshot.config.minimumCashBufferCents` and labels it as an assumption, not a user setting.
- No settings screen is in MVP 0 scope.
- Closes the third open coordination question in `STATUS.md`.
- Making the buffer editable is an MVP 1 candidate and should be recorded as a new decision if adopted.

## CD-007: Deferral And Shortfall Guidance Is Out Of MVP 0 Scope

Date: 2026-08-03  
Status: Accepted  
Owners: `[Shared]`, `[User decision]`

Decision: MVP 0 does not compute or display "what would make this affordable" guidance, such as a suggested deferral date or a required additional amount. The UI explains why the current answer was produced and stops there.

Rationale: Solving for a date or amount means re-running the forecast under varied inputs. That is backend scope and would expand MVP 0 beyond its exit criteria. The existing reasons, assumptions, and forecast path already show the user why an answer was produced.

Consequences:

- `[Backend: Codex]` does not need a solver or any new response field for MVP 0.
- `[UI: Claude]` designs the affordability result screen with a reserved slot so this can be added later without a redesign.
- UI must not infer or imply a deferral date or shortfall amount from existing fields, because that would be an unowned calculation.
- Revisit as an MVP 1 candidate.

## CD-006: UI Owns All User-Facing Copy; Backend Strings Are Diagnostic

Date: 2026-08-03  
Status: Accepted  
Owners: `[Shared]`, `[User decision]`

Decision: `[UI: Claude]` owns every string the user reads. Backend-emitted text — `DecisionExplanation.headlineFact`, `DecisionReason.facts[]`, `Assumption.message`, and `FreshnessWarning.message` — is treated as developer-facing diagnostic output, not display copy. The UI renders user-facing language from stable codes plus structured parameters.

Rationale: `CD-003` already assigns product wording to UI, while the contract also has the backend emitting English prose. This resolves the contradiction in favor of a single tone owner. `D-006` requires non-judgmental language, which is easier to enforce and review in one layer. It also lets copy change without touching deterministic backend tests.

Consequences:

- Every user-visible backend output must be identified by a stable enumerated code, not by prose. This includes assumption codes, which are currently typed as an open `string`.
- Reason codes require structured parameters sufficient to compose copy. A single `amountCents` and `date` is not always enough.
- `[Backend: Codex]` may keep emitting message strings for logs, fixtures, and `debug`, but no UI surface renders them verbatim.
- Backend wording changes are non-breaking for UI; code or parameter changes are breaking and require a handoff.
- Tracked in `H-004` and `H-005`.

## CD-005: MVP 0 Integration Boundary Is In-Process TypeScript Import

Date: 2026-08-03  
Status: Superseded by `CD-011`  
Owners: `[Shared]`

Supersession note: This section is a historical record only. Follow `CD-011` for current UI/runtime integration.

Decision: The MVP 0 UI imports the backend domain package directly as an in-process TypeScript function. No HTTP adapter is built for MVP 0.

Rationale: The backend design already prefers in-process import when the UI can import the package. A pnpm workspace makes this possible, and it gives the UI compile-time type sharing with the contract at zero cost. Fastify can be added later without changing the request or response payload shape.

Consequences:

- Resolves `H-002`.
- `[Backend: Codex]` should publish the domain package with a stable name and a named `evaluateAffordability` export, and should export the contract types for UI consumption.
- The UI must not assume async transport semantics that would break under a later HTTP boundary; the call is wrapped in a UI-side async adapter so an HTTP move stays isolated.
- No CORS, serialization, or local server concerns in MVP 0.

## CD-004: MVP 0 UI Stack Is React, Vite, TypeScript, And Tailwind

Date: 2026-08-03  
Status: Accepted  
Owners: `[UI: Claude]`, `[User decision]`

Decision: The MVP 0 frontend is React with Vite, TypeScript, and Tailwind CSS, organized as a pnpm workspace monorepo alongside the backend domain package.

Rationale: No UI stack had been decided in `docs/` or `coordination/` before this session, and the repository contained documentation only. A Vite and React application is the fastest path to a working MVP 0 prototype, and a shared TypeScript workspace lets the UI consume the backend contract types directly instead of restating them.

Proposed layout:

```
ai-fin-os/
  packages/core/    [Backend: Codex]  domain package, schemas, forecast, decision, explanation
  apps/web/         [UI: Claude]      React + Vite + Tailwind application
```

Consequences:

- `[Backend: Codex]` owns everything under `packages/core`. `[UI: Claude]` owns everything under `apps/web`.
- The backend package must export its contract types so the UI never redeclares them.
- Directory layout is a proposal from the UI side; `[Backend: Codex]` may relocate `packages/core` and should note the final path in `STATUS.md`.
- Next.js was considered and set aside because MVP 0 has no server-side requirement. It remains reconsiderable at MVP 2 when Plaid and auth introduce a real server boundary.
- Tailwind is an implementation detail of the design system; design tokens are defined independently so the system survives a styling change.

## CD-003: UI Consumes Backend-Owned Financial Results

Date: 2026-08-04  
Status: Accepted  
Owners: `[Shared]`

Decision: UI work should consume backend-owned affordability results, metrics, forecast data, monthly spending summaries, explanations, assumptions, and product boundaries through a single service contract.

Rationale: MVP 0 affordability depends on deterministic daily forecast paths, timing reserve, cash buffer rules, freshness checks, and reason-code precedence. Duplicating those calculations in UI code would create conflicting answers.

Consequences:

- `[Backend: Codex]` owns schemas, validation, recurrence expansion, forecast paths, affordability level selection, reason codes, monthly spending aggregation, and deterministic tests.
- `[UI: Claude]` owns layout, interaction states, visual hierarchy, formatted money/dates, and user-facing wording mapped from backend facts.
- Contract changes must update `coordination/UI_BACKEND_CONTRACT.md` and any active handoff in `coordination/HANDOFFS.md`.

## CD-002: Backend And UI Ownership Markers Are Required

Date: 2026-08-04  
Status: Accepted  
Owners: `[Shared]`

Decision: Coordination entries should use explicit ownership markers: `[Backend: Codex]`, `[UI: Claude]`, `[Shared]`, `[User decision]`, and `[Blocked]`.

Rationale: Two assistants and the user may update files asynchronously. Visible ownership prevents accidental duplicate work and makes unresolved dependencies easier to find.

Consequences:

- Work items without an owner should be treated as shared until assigned.
- Claude's UI work should not be marked complete in this workspace unless Claude or the user records that progress.
- Backend work should not make UI design claims unless UI artifacts exist in the project.

## CD-001: Coordination Folder Is The Shared File-Based Channel

Date: 2026-08-04  
Status: Accepted  
Owners: `[Shared]`

Decision: Use `coordination/` for active backend/UI collaboration, status, handoffs, and cross-team implementation decisions.

Rationale: The project needs a durable communication surface that both assistants and the user can read and update while backend and UI work proceed in parallel.

Consequences:

- `docs/product-charter.md` remains stable and untouched for coordination-only updates.
- `docs/README.md` links to this folder for discoverability.
- Coordination notes should stay concise and operational, not become a second product charter.

## Product Decisions Referenced By Coordination

The following accepted product or architecture decisions inform coordination, but their source of truth remains `docs/decisions.md`.

- `D-008`: MVP 0 backend uses a day-level 30-day deterministic TypeScript core with JSON fixtures, a default `$250.00` buffer, result levels `AFFORDABLE`, `TIGHT`, `RISKY`, and `UNKNOWN`, and SQLite later if persistence is needed.
- `D-007`: MVP 0 targets an individual salaried user paid bi-weekly, while spending summaries remain monthly.
- `D-003`: Deterministic forecast and decision engine must precede AI chat.
- `D-002`: The product is read-only and decision-supportive, not personalized investment, tax, legal, or fiduciary advice.
