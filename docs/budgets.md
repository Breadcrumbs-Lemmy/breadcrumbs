# Category Budgets — design & decisions

Status: Built, test-hardened & verified 2026-08-09 (autonomous session) — awaiting user re-approval of D-B1..D-B10
Owner: `[UI: Claude]`
Handoff: `H-082`

Budgets let a user set a monthly spending limit for a category (and optionally an
overall monthly cap) and see, deterministically, how the current month is
tracking against it. It turns the passive "where did my money go?" surface into
an active guardrail without violating any product boundary: it is read-only, it
computes nothing in the browser, and every figure comes from the same
deterministic engine that renders the Spending screen.

This is **distinct from the `Goal` type** (`monthly_savings_target`), which is a
savings/affordability concept. A *budget* is a spending cap; a *goal* is a
savings target. They complement each other and share the per-user "targets"
persistence pattern this feature establishes.

## Design decisions (for user review on return)

Each is a deliberate call made autonomously. Change any and I'll rework it.

- **D-B1 — What a budget is.** A budget is `{ category, limitCents }` — a monthly
  spending limit for one normalized category, in integer cents, plus one optional
  overall monthly cap (`overallLimitCents`). Nothing else is scoped in v1
  (no per-account, per-merchant, or weekly budgets).

- **D-B2 — Period basis is the calendar month.** A budget is monthly. Progress is
  computed against a *month* period. On the Spending screen, inline budget bars
  appear only when the selected period kind is `month`; other kinds (week / year /
  statement) don't show budget progress, because showing a monthly cap against a
  week is misleading. The Budgets screen always works on the current (latest-data)
  month.

- **D-B3 — Pacing / projection.** For an in-progress (partial) month, we surface
  a projected end-of-month figure = `round(spent * totalDays / elapsedDays)` using
  the period's own `elapsedDays`/`totalDays`. It is clearly labelled an estimate.
  **Status is computed on money actually spent, not on the projection**, so a
  budget never reads "over" before it truly is — but "on pace to spend $X" warns
  early. `asOfDate` is the latest transaction date, never the wall clock (matches
  every other endpoint; keeps responses deterministic).

- **D-B4 — Status thresholds (deterministic, configurable).** Of the limit:
  `under` < 80%, `near` 80–100% (inclusive of 100), `over` > 100%. Constants live
  in a `DEFAULT_BUDGET_CONFIG` like `DEFAULT_INSIGHTS_CONFIG`. A category with no
  budget set is simply absent from the progress list (not "over").

- **D-B5 — Persistence.** Per-user budget store, one JSON file at
  `<dataDir>/users/<id>/budgets.json`, mirroring the statement store exactly:
  atomic temp-write-then-rename, mode 0600, a serialized write queue, and the same
  optional `FieldCipher` envelope (`{ "$enc": … }`) so budgets — which reveal
  financial intent — are encrypted at rest when a key is configured. In-memory and
  single-store providers exist for tests and single-user mode. Isolation is by
  construction via `forUser(userId)`, same seam as the statement store.

- **D-B6 — Endpoints.**
  - `GET /api/v1/budgets` → the raw configured set `{ currency, overallLimitCents,
    budgets: [{category, limitCents}] }`.
  - `POST /api/v1/budgets` → replace the whole set (simplest correct semantics for a
    small set the UI edits as a whole); validated with Zod; returns the saved set.
    Whole-set replace originally used `PUT`, but browser verification caught that
    the server's CORS allowlist advertises only `GET,POST,PATCH,DELETE,OPTIONS` —
    the exact verb set every existing route uses. Rather than widen shared,
    security-relevant CORS config for a single route, this uses `POST` (as the rest
    of the API's full-state writes do, e.g. `statement-imports/commit`). Semantics
    are unchanged.
  - `GET /api/v1/budgets/progress?period=month&key=&currency=USD` → computes
    progress for that month from the user's transactions via core `evaluateBudgets`
    over `summarizeSpending`. Returns per-category + overall progress.

- **D-B7 — All math in core.** `evaluateBudgets({ summary, budgets, overallLimitCents })`
  is a pure function in `packages/core/src/domain/budgets.ts` reading
  `summary.categoryTotals[].outflowCents` (net of refunds), `summary.totalOutflowCents`,
  and `summary.period`. The server route is thin; the browser does no arithmetic
  (`CD-003`, `CD-011`).

- **D-B8 — UI placement.** Budgets management is a **dedicated screen reached from
  the Spending (Pulse) screen**, not a nav tab — the nav spells `C·A·P·I·T·A·L`
  and a tab would spoil it (same reasoning as Settings/Import). See D-B10 for how
  the entry point is rendered.

- **D-B9 — Status colour (word-first, never colour-alone).** Status is carried by
  a *word* ("On track" / "Nearly there" / "Over") and the bar; colour is only a
  restrained accent on top, mirroring the `Delta` component (which pairs an arrow
  + word with `--rise`/`--fall`). Tokens: `under → --accent` (brand teal),
  `near → --rise` (warm amber), `over → --alert` (muted red). This respects the
  charter's ban on *hue-as-verdict for a category's spending* (`D-006`): the hue
  here judges the user's own cap being crossed — a factual threshold they set —
  never labels a category as morally good/bad, and it is never the sole signal.

- **D-B10 — Spending-screen integration is an entry-point card only (v1).** The
  Spending screen shows a "Budgets" card in its secondary column that opens the
  Budgets screen; it does **not** render inline per-row cap markers on the
  category list. Reasons: (1) the Spending list is multi-period (week / year /
  statement), and a monthly cap marker shown against a week misleads — the exact
  failure D-B2 guards against; (2) it avoids a second fetch on the product's
  hottest surface; (3) the dedicated Budgets screen already shows the same
  category list with caps + backend-computed status, so inline markers would
  duplicate it. Inline month-only markers can be revisited later; this keeps v1
  shippable and unambiguous. (Revises the "inline bars on the month list" intent
  sketched in D-B2/D-B8.)

## Files (claimed for H-082)

- `packages/core/src/domain/budgets.ts` (new), `packages/core/src/index.ts` (export),
  `packages/core/tests/budgets.test.ts` (new), `packages/core/fixtures/mvp0/budget-cases.json` (new).
- `packages/server/src/local/budget-store.ts` (new),
  `packages/server/src/local/budget-store-provider.ts` (new),
  `packages/server/src/http/budget-routes.ts` (new),
  `packages/server/src/http/server.ts` (wire routes + eraseUserData),
  `packages/server/tests/budget-routes.test.ts` (new).
- `apps/web/src/services/api.ts` (budget client fns),
  `apps/web/src/screens/BudgetsScreen.tsx` (new),
  `apps/web/src/screens/SpendingScreen.tsx` (inline progress + entry point),
  `apps/web/src/App.tsx` (route wiring).

## Boundaries kept

- Read-only and decision-supportive: a budget never moves money or changes an
  account. It states amounts and a neutral status; no judgement, no advice
  (`D-002`, `D-006`).
- Deterministic-first: the browser and the AI both consume computed figures; no
  new financial classification is introduced.
</content>
