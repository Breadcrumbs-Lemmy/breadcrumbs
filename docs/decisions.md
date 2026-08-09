# Decision Log

Status: Living  
Last updated: 2026-08-09

Use this log for material product, architecture, data, and compliance decisions. Add new entries at the top unless a project convention later says otherwise.

## D-018: Owner Sign-Off Of The Security Docs, With Solo-Operator Honesty Adjustments

Date: 2026-08-09
Status: Accepted
Relates to: `D-015` (InfoSec policy), `D-017` (remaining security docs)

Decision: The accountable owner (Lemuel Mutah — sole developer, no incorporated
entity) reviewed and **signed off** the security document set. The InfoSec policy
moves to **v1.0 / Approved** (from 0.1 draft), closing the D-015 gate that these
docs were "drafts until an accountable owner signs off." As part of the sign-off:

1. **Owner, organization, and incident contacts filled in.** All seven security
   docs now name the owner; the organization is stated honestly as "Lemuel Mutah
   (sole operator — no incorporated entity)"; incident-response contacts are
   `lemuelmutah@gmail.com` (email-only by choice; phone/Signal dropped).
2. **Questionnaire re-validated against code** (four-agent sweep). Corrected three
   real discrepancies: connection-delete route param (`:id` → `:connectionId`),
   the item-id "encrypted" overclaim (only the access token is encrypted), and the
   staged-restore source attribution (`persistence/backup.ts`, not `atomic-file.ts`).
3. **Solo-operator honesty adjustments.** "Code-reviewed before merge" reworded to
   PR self-review + automated checks with no second human reviewer; §7 review
   cadences relaxed from quarterly/6-monthly to annually (dependency scan stays
   continuous via CI; IR tabletop best-effort), matching what a solo maintainer
   will realistically sustain rather than attesting to a cadence that wouldn't hold.

Rationale: A sign-off is only meaningful if the owner stands behind every claim.
Writing the docs in "company" voice had introduced two would-be overclaims for a
one-person project (peer review; quarterly formal reviews); the sign-off pass
resolved them in the honest direction rather than leaving them to look better on
paper. Remaining committed gaps are unchanged: secrets-manager/KMS for the at-rest
key, native per-request audit logging, and a third-party penetration test.

This does not change application behavior; it is a governance/compliance decision.

## D-017: Self-Serve Account Deletion, CI Dependency Scanning, And The Remaining Security Docs

Date: 2026-08-09
Status: Accepted
Relates to: `D-014` (auth, isolation), `D-015` (InfoSec policy), `D-016` (MFA)

Decision: Close three named gaps from the security questionnaire so its answers
are truthfully "Implemented" rather than "Planned":

1. **Self-serve + admin account deletion.** `DELETE /api/v1/auth/me`
   (re-authenticated with the current password) and `DELETE /api/v1/admin/users/:id`
   remove the user's identity (record + all sessions) **and** erase everything the
   user id owns — Plaid tokens, the per-user transaction store, and assistant
   memory. The auth service owns identity removal; the route layer orchestrates
   data erasure via an `eraseUserData` composer built in `http/server.ts` from
   whatever stores exist. Guards: the **last active admin** and the **single-user
   owner** cannot be deleted.
2. **Dependency scanning in CI.** `pnpm audit` (failing on high/critical) runs on
   every push and pull request and on a weekly schedule
   (`.github/workflows/dependency-audit.yml`, root `audit` script).
3. **The remaining "Planned" security docs** — a formal
   [data-retention schedule](data-retention-schedule.md), a
   [subprocessor list](subprocessors.md), and a
   [log-review + alerting procedure](logging-and-monitoring.md).

Rationale: An honesty audit of the Plaid questionnaire found that the retention
answer implied a delete-my-account capability that did not exist, and that three
attestations pointed at documents that had not been written. Rather than soften
the answers, we built the missing capability and wrote the missing docs. Writing
the logging procedure surfaced a second overclaim — the app runs Fastify with
`logger: false` and emits no per-request audit log — which is now stated honestly
in policy §5, the questionnaire §G, and the new logging doc (the brute-force
signal lives in HTTP `401`/`429` codes captured by the operator's proxy).

Consequences:

- New store capability: `deleteAllForUser` / `eraseForUser` on the Plaid token
  store, statement-store provider, and agent-memory provider (best-effort,
  idempotent). Memory is erased before the statement store because the latter
  removes the shared `users/<id>/` directory. Covered by
  `tests/account-deletion.test.ts`.
- Policy §4.4/§5/§9/§10/§12, the risk register (R-04, R-05), and the questionnaire
  are updated to match; remaining honest gaps: native request logging with
  redaction, secrets-manager/KMS for the at-rest key, and a third-party pen test.

## D-016: TOTP Multi-Factor, Enforced As Step-Up Before Plaid Link

Date: 2026-08-09
Status: Accepted
Relates to: `D-012` (Plaid), `D-014` (auth, isolation), `D-015` (InfoSec policy)

Decision: Multi-factor authentication is **TOTP** (RFC 6238, authenticator app),
not SMS. It is enforced as a **step-up in front of Plaid Link**: the server
refuses to mint a Link token or exchange a public token for a multi-user session
that has not verified a current TOTP code within a 15-minute window. Enrollment is
two-step — a secret is issued, and the factor is only activated once a first code
verifies — and TOTP secrets are encrypted at rest with the existing AES-256-GCM
field cipher, bound per-user by AAD. Single-user (no-login) mode is exempt: there
is no second identity to challenge.

Rationale: Plaid's production questionnaire (item 4) expects MFA before Link is
surfaced. TOTP fits the product's privacy-first, self-hostable ethos better than
SMS — it needs no third-party sender (no new subprocessor), works offline, and is
immune to SIM-swap. Gating at Link time rather than at login keeps everyday
sign-in frictionless while putting the second factor exactly where the sensitive
action is. It is implementable with `node:crypto` alone, adding no dependency.
Two-step enrollment guarantees a half-finished setup can never lock the owner out.

Consequences:

- The `mfa` model generalizes from the SMS scaffold to `{ enabled, method:
  "totp", totpSecret, enrolledAt }`; the per-session step-up is stamped on the
  session (`mfaVerifiedAt`) and surfaced on the principal.
- New endpoints: enroll, enroll/verify, challenge, disable. Web UI: a Settings
  setup card and a connect-a-bank gate dialog that walks enrollment or a
  challenge and then retries the connect.
- Follow-ups: recovery/backup codes, and optionally extending the step-up to
  other sensitive actions. Tracked in policy §12 item 2 and risk R-03.

## D-015: Documented Information Security Policy And Supporting Procedures

Date: 2026-08-09
Status: Accepted
Relates to: `D-012` (Plaid), `D-014` (auth, isolation, offline assistant)

Decision: The project adopts a documented Information Security Policy
([`information-security-policy.md`](information-security-policy.md)) plus two
supporting procedures — a living [Risk Register](risk-register.md) and an
[Incident Response Runbook](incident-response.md). Together they operationalize
identify → mitigate → monitor for the information security risks relevant to the
business, so the organization can truthfully answer vendor/partner security
questionnaires (Plaid production access being the immediate driver).

Rationale: Moving toward Plaid production means attesting, in writing, to a real
security program. The technical controls already exist in code (scrypt hashing,
deny-by-default authorization, per-user isolation, brute-force lockout,
secret-scrubbing config, atomic persistence); what was missing was the governance
wrapper that names them, identifies the risks, and states how they are monitored.
The policy maps every control to its source file and marks each as Implemented,
Operator, or Planned so the attestation is honest rather than aspirational.

Consequences:

- Each control is explicitly typed. **Operator** controls (TLS, disk encryption,
  backups, network exposure) are the deployer's responsibility for self-hosted
  installs, documented in the policy §11 — security is a shared responsibility.
- Five gaps are tracked openly (policy §12): app-level encryption of stored Plaid
  tokens, MFA enforcement, dependency scanning in CI, the log-review/alerting
  procedure, and formal data-retention. Closing any of them updates the policy
  and, where material, gets its own decision entry.
- Review cadence is committed (policy §7): policy every 6 months, risk register
  and access review quarterly, dependency scan per release, IR drill annually.
- The documents are drafts until an accountable owner signs off; they must not be
  submitted as a formal attestation before that review. Placeholders (`{ORG}`,
  `{SECURITY OWNER}`, contacts) must be filled first.
- This does not change application behavior; it is a governance/compliance
  decision. It complements `D-012`/`D-014` rather than superseding them.

## D-014: Production Backbone — Auth Modes, Isolation By Construction, An Offline Local Assistant, And Per-User Memory

Date: 2026-08-06  
Status: Accepted  
Extends: `D-002`, `D-003`, `D-004`, `D-012`, `D-013`

Decision: The backend gains the load-bearing pieces of a real product — identity, per-user isolation, an assistant that can run fully offline, and a durable per-user assistant memory — while keeping the zero-config single-user path that made it frictionless. All external dependencies (identity persistence, a bank via Plaid, a model) are optional and degrade gracefully; the product works with none of them.

The four pieces:

1. **Two auth modes, one gate.** `BREADCRUMBS_AUTH_MODE` selects `single_user` (default; no login, every request is the implicit owner) or `multi_user` (real accounts, admin, per-user isolation). A single `onRequest` hook resolves the caller for every `/api` route and 401s anything not on a small public allowlist — one gate to audit, and new routes are protected by default. The first registrant (or `BREADCRUMBS_OWNER_EMAIL`) bootstraps as admin; the owner is seeded at boot only in single-user mode, so multi-user bootstrap is never robbed of its first admin. Passwords use `node:crypto` scrypt; session tokens are stored sha256-hashed so a store leak is not a session leak.

2. **Isolation by construction.** A user's statements, assistant memory, and bank connections are reached through a provider seam resolved from `request.principal.userId` (`stores.forUser`, `memory.forUser`, `connection.userId`), not by threading a `WHERE user_id = ?` through domain calls. Cross-user reads are impossible by construction. A guessed id for another user's data returns the same 404 a missing one does — no existence leak. Asserted end to end in `auth-routes`, `agent-memory-routes`, and `plaid-isolation` tests.

3. **An assistant that can be offline.** `BREADCRUMBS_AGENT_PROVIDER` selects the hosted Claude model or a local OpenAI-compatible one behind one `ChatProvider` interface. The local provider's base URL **must be a loopback address**, checked in code (`assertLoopbackUrl`) at construction — a "local" agent pointed anywhere the internet can reach refuses to start. This makes the "runs locally, cannot access the internet" requirement a code guarantee, not a comment. A documented, off-by-default escape hatch allows a trusted LAN host. PDF statement transcription stays with the hosted model; chat works on either. This is the concrete extension of `D-003`.

4. **Per-user assistant memory, offline by the same standard.** Four layers on disk per user (`src/agent/memory/`): durable facts (preferences, standing context, a summary of each uploaded file), a rolling short-term working note, full conversation history, and uploaded files the assistant learns from. Retrieval is offline keyword scoring — no embeddings, no network — so memory honours the same no-internet guarantee the local model runs under. Every layer is plain files the user can read or delete.

Rationale: Explicit user direction to turn the scaffold into a production-ready backbone they can attach real keys to later, with an assistant that is private by construction and cannot exfiltrate their financial data. Doing identity and isolation through provider seams keeps the deterministic core and the thin-route architecture (`D-013`) intact; doing the offline guarantee in code keeps it honest.

Consequences:

- `single_user` remains the default and keeps the whole app login-free, so existing tests and a solo user are unaffected.
- Statement import (CSV and Plaid) writes into the same per-user store; a Plaid transaction and a hand-imported one are the same shape by the time they reach the store, so the spending screens light up after a sync with no extra wiring. Plaid `sourceFormat` is `"plaid"`; dedupe is by transaction id, shared with CSV.
- The assistant's tools stay read-only over `@ai-fin-os/core`; the new memory tools (`remember_fact`, `update_working_note`, `search_memory`) touch memory only, never a financial figure — `S-010` holds.
- SMS/MFA is explicitly deferred; the auth surface is shaped so it can be added without a rewrite.
- New env keys are documented in `.env.example` and `packages/server/README.md`. Identity, Plaid, and model keys are all still optional.

## D-013: Frontend And API Deploy Separately With One Fastify Backend Boundary

Date: 2026-08-04  
Status: Accepted  
Supersedes: the in-process integration part of `D-009` and `CD-005`

Decision: Breadcrumbs deploys the browser frontend and backend API separately. `packages/server` is the single backend deployment boundary and exposes the stable HTTP API. `packages/core` remains an internal backend domain library used by the server for deterministic affordability, normalization, and spending aggregation. The API does not split further into microservices.

Rationale: Explicit user architecture direction. Separate frontend/API deployment gives the browser a stable network contract without turning backend domain modules into deployable services. Keeping one Fastify API avoids premature microservice boundaries while preserving deterministic core logic as testable internal code.

Consequences:

- `apps/web` must call `packages/server` over HTTP for affordability evaluation and future local spending/import work.
- Browser code must not import or call `evaluateAffordability`, `summarizeMonthlySpending`, or backend finance calculation functions at runtime. Type-only shared contract imports are allowed when they do not bundle backend runtime logic.
- `POST /api/v1/affordability/evaluate` is the stable affordability HTTP operation for MVP 0. The payload shape remains the existing `AffordabilityRequest`; success returns `AffordabilityResponse`.
- Local CSV import and spending-summary endpoints are part of the same Fastify API. The preferred versioned paths are under `/api/v1/local/...`; existing `/api/local/...` paths remain compatibility aliases for current handoffs.
- Frontend deployments configure the public API URL with `VITE_BREADCRUMBS_API_BASE_URL`. API deployments configure allowed deployed web origins with `BREADCRUMBS_CORS_ORIGINS`.
- Plaid remains server-side only, and no production auth, production Plaid, browser secrets, or additional service split is introduced by this decision.

## D-012: Plaid Sandbox Scaffold Is Server-Only And Sandbox-Only

Date: 2026-08-04  
Status: Accepted

Decision: The initial Plaid implementation is a server-only Sandbox scaffold in `packages/server`. It creates Link tokens for the minimal `transactions` product, exchanges public tokens server-side, retrieves read-only accounts, balances, and transactions, and maps Plaid data into canonical core snapshot entities where feasible.

Rationale: Plaid credentials and access tokens must never enter browser code, source files, documentation, or chat. The same `packages/server` API boundary hosts Plaid routes without changing the deterministic core affordability engine.

Consequences:

- `PLAID_ENV` must be `sandbox`; production and development Plaid environments are rejected by configuration.
- `auth` and `identity` are not requested until a documented product requirement needs them.
- The scaffold does not add UI or production persistence. Access tokens are held only in a local in-memory store for manual Sandbox testing.
- Real Sandbox credentials are needed only for manual Link checks. Build and unit tests mock Plaid and require no credentials.
- This scaffold supports the `D-011` resequencing toward aggregated spending by creating a safe path to multi-account transaction data, but it does not yet provide beta-grade token storage, consent, deletion, or sync-health flows.

## D-011: Cross-Account Spending Visibility Is The Product; Affordability Is A Supporting Tool

Date: 2026-08-04  
Status: Accepted  
Supersedes: `D-001`

Decision: The central product is aggregated spending across all of the user's accounts and institutions. The organising question changes from "Can I afford this?" to "Where is my money going?". Affordability remains a first-class capability, reachable from anywhere, but it is no longer the product's home surface.

Rationale: Explicit user direction. A user checks spending continuously and asks about a specific purchase occasionally. Building the product around the occasional question made the daily one a secondary view. Aggregated spending is also what gives an affordability answer its credibility — the deterministic verdict is more trustworthy when the user already recognises the picture it was computed from.

Consequences:

- `product-charter.md` is amended. This is the first change to the stable charter.
- Multi-institution aggregation moves from an MVP 2 concern to the core product requirement. See the amended `roadmap.md`.
- Transactions become the primary data object. Until now MVP 0 could produce an affordability answer with zero transactions; the product can no longer produce its main screen without them.
- Categorisation, merchant normalisation, and recurring detection move onto the critical path. They were previously downstream of affordability.
- `pattern-detection-spec.md` is promoted from a later concern to core scope.
- The deterministic affordability engine already built in `packages/core` is unaffected in behaviour and remains correct. Only its position in the product changes. No backend calculation work is invalidated.
- `D-002` (read-only, not advice), `D-003` (deterministic before AI), `D-004` (Plaid read-only), `D-005` (cross-account patterns), and `D-006` (non-judgmental language) all stand unchanged. `D-005` is reinforced.
- Tracked for backend impact in `H-012`.

## D-010: MVP 0 Goal Support Starts With Monthly Savings

Date: 2026-08-04  
Status: Accepted

Decision: The first supported MVP 0 goal type is a monthly savings target, represented in the backend contract as `monthly_savings_target`. Its practical user intent is reducing discretionary spending so more cash can go toward savings. Other goal types remain future candidates until their model fields, deterministic rules, fixtures, and UI copy are explicitly added.

Rationale: Monthly savings is the clearest first goal for the central "Can I afford this?" workflow because discretionary purchases can be evaluated against a scheduled savings contribution without adding budget bars, advice copy, or a solver.

Consequences:

- MVP 0 fixtures and backend tests should use `goalType: "monthly_savings_target"` for active savings goals.
- Planned purchases such as games, consoles, and restaurant meals can remain ordinary discretionary purchases; the backend evaluates their impact on cash buffer, required obligations, and protected monthly savings contributions.
- UI copy should frame this as a tradeoff with monthly savings, not as judgment about discretionary spending.
- Additional goal types need a new decision or handoff before implementation.

## D-009: MVP 0 Frontend Is React, Vite, TypeScript, And Tailwind In A Shared Workspace

Date: 2026-08-03  
Status: Accepted, with the in-process backend import superseded by `D-013`

Decision: The MVP 0 user interface is a React application built with Vite, TypeScript, and Tailwind CSS, living in a pnpm workspace monorepo alongside the backend domain package. The original in-process backend import part is superseded by `D-013`; the UI now calls the Fastify API over HTTP.

Rationale: `D-008` settled the backend stack but no frontend stack had been chosen. A shared TypeScript workspace lets the UI consume the backend contract types directly, which keeps the affordability contract enforced by the compiler instead of by convention. Vite is sufficient because MVP 0 has no server-side requirement.

Consequences:

- The UI never redeclares contract types; it may import type-only contracts from the backend package when doing so does not bundle runtime logic.
- The HTTP boundary is now active through `D-013` and `POST /api/v1/affordability/evaluate`.
- Next.js remains reconsiderable at MVP 2, when Plaid and authentication introduce a real server boundary.
- Implementation details and the agreed directory layout are recorded in `coordination/DECISIONS.md` as `CD-004`; the current API boundary is recorded as `CD-011`.

## D-008: MVP 0 Backend Uses Day-Level 30-Day Deterministic TypeScript Core

Date: 2026-08-04  
Status: Accepted

Decision: MVP 0 backend design uses a day-level 30-calendar-day deterministic forecast, four affordability result levels (`AFFORDABLE`, `TIGHT`, `RISKY`, and `UNKNOWN`), a configurable default `$250` cash buffer, TypeScript domain logic, JSON fixtures for tests, and SQLite as the first local persistence option when persistence is needed.

Rationale: MVP 0 needs repeatable affordability decisions before AI chat or live bank integration. A day-level forecast handles bill and payday timing for a bi-weekly salaried user, while monthly spending summaries remain a separate reporting aggregation.

Consequences:

- Forecast, decision, and explanation behavior can be implemented and tested without Plaid or AI.
- UI work can consume a stable JSON/service contract without owning financial calculations.
- The default buffer and 30-day horizon are MVP 0 backend assumptions and should remain configurable in implementation.
- Monthly spending tracking must not replace day-level forecast event timing.
- Later Plaid and AI work must adapt to the deterministic engine instead of replacing it.

## D-007: MVP 0 Targets An Individual Salaried Bi-Weekly User

Date: 2026-08-04  
Status: Accepted

Decision: MVP 0 targets an individual salaried user who is paid bi-weekly. Income handling must support a bi-weekly cadence, while spending summaries and pattern tracking should remain monthly because most bills and budget goals are monthly.

Rationale: A focused first user segment keeps MVP 0 deterministic and testable while preserving compatibility with the central affordability question.

Consequences:

- Product model work should support bi-weekly income cadence.
- Pattern detection should convert reliable income to monthly equivalents for monthly spending summaries.
- This decision does not select the overall forecast horizon.

## D-006: Spending Insights Must Use Non-Judgmental Language

Date: 2026-08-03  
Status: Accepted

Decision: Pattern insights should explain potential savings impact and tradeoffs without shaming the user.

Rationale: The product must build trust and help users understand choices. Judgmental language can reduce engagement and obscure the practical value of an insight.

Consequences:

- Insight copy should focus on dollars, timing, goals, and options.
- Product reviews should check tone as part of quality.

## D-005: Cross-Account Pattern Detection Is Core Scope

Date: 2026-08-03  
Status: Accepted

Decision: The product must detect cross-account spending patterns, including subscriptions, rising categories, duplicate services, frequent small purchases, and behaviors that conflict with goals.

Rationale: A single-account view misses important financial behavior. Cross-account pattern detection is central to financial understanding, not a later nice-to-have.

Consequences:

- Data models must support multiple accounts and institutions.
- Pattern detection should be designed before Plaid integration so account aggregation has clear requirements.

## D-004: Plaid Is Planned As Read-Only Integration

Date: 2026-08-03  
Status: Accepted

Decision: Plaid is planned for read-only account, balance, and transaction access. The initial product must not write to financial accounts.

Rationale: Read-only access supports decision-making while reducing product, security, and compliance complexity.

Consequences:

- MVP 0 and MVP 1 should validate behavior without live Plaid dependency.
- MVP 2 should include consent, connection health, token security, and data deletion requirements.

## D-003: Deterministic Forecast And Decision Engine Must Precede AI Chat

Date: 2026-08-03  
Status: Accepted

Decision: The forecast and decision engine must be deterministic before AI chat is added.

Rationale: Affordability answers require repeatable calculations, explainable assumptions, and testable behavior. AI can help explain and explore results after the financial reasoning layer exists.

Consequences:

- MVP 0 and MVP 1 prioritize calculation, rules, data models, and tests.
- MVP 3 introduces AI chat over computed facts and guarded explanations.

## D-002: Initial Product Is Decision-Supportive, Not Financial Advice

Date: 2026-08-03  
Status: Accepted

Decision: The product is read-only and decision-supportive. It must not provide personalized investment, tax, legal, or fiduciary advice.

Rationale: The product's value is practical affordability and budgeting support, not regulated advice or account control.

Consequences:

- Product copy and AI responses must maintain clear boundaries.
- Features that move money, trade assets, or provide regulated advice are out of initial scope.

## D-001: Central Product Question Is "Can I Afford This?"

Date: 2026-08-03  
Status: Accepted

Decision: The core product experience is organized around helping a user answer "Can I afford this?"

Rationale: A concrete affordability question creates a clear wedge for budgeting and financial understanding. It focuses the product on decisions rather than passive dashboards.

Consequences:

- MVP 0 should center on planned purchase scenarios and affordability outcomes.
- Forecast, goals, spending insights, and explanations should support that central question.
