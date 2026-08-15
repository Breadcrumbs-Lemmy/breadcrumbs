# Category Budgets — design & decisions

Status: Built & verified 2026-08-09; reworked & re-verified 2026-08-10 (user re-approved D-B1/B2/B4 + new D-B11)
Owner: `[UI: Claude]`
Handoff: `H-082`

Budgets let a user set a spending limit for a category — for a **week or a
month** — (and optionally an overall cap per window) and see, deterministically,
how the current period is tracking against it. It turns the passive "where did my
money go?" surface into an active guardrail without violating any product
boundary: it is read-only, it computes nothing in the browser, and every figure
comes from the same deterministic engine that renders the Spending screen.

This is **distinct from the `Goal` type** (`monthly_savings_target`), which is a
savings/affordability concept. A *budget* is a spending cap; a *goal* is a
savings target. They complement each other and share the per-user "targets"
persistence pattern this feature establishes.

## Design decisions (for user review on return)

Each is a deliberate call made autonomously. Change any and I'll rework it.

- **D-B1 — What a budget is.** A budget is `{ category, limitCents, period? }` — a
  spending limit for one normalized category, in integer cents, that governs
  **either a calendar week or a calendar month**. `period` is `"week"` for a
  weekly cap and is **omitted for a monthly cap** (the pre-rework on-disk shape,
  so old files stay valid). A category may hold **one weekly and one monthly cap
  at once** — uniqueness is per `(window, category)`. There is one optional
  overall cap *per window*: `overallLimitCents` (monthly) and
  `overallWeeklyLimitCents` (weekly). Nothing else is scoped
  (no per-account or per-merchant budgets).

- **D-B2 — Period basis is a calendar week or a calendar month.** Progress for a
  budget is computed against a period of its own kind — a weekly cap against an
  ISO-8601 week (Monday start, key `YYYY-Www`), a monthly cap against a calendar
  month (`YYYY-MM`). Core filters the configured set to the summary's period kind,
  so a monthly cap is never scored against a week (or vice-versa) — the exact
  mismatch that would mislead. The Budgets screen works on the current
  (latest-data) week or month, selected by the Week/Month toggle (D-B11).

- **D-B3 — Pacing / projection.** For an in-progress (partial) period, we surface
  a projected end-of-period figure = `round(spent * totalDays / elapsedDays)` using
  the period's own `elapsedDays`/`totalDays` (`totalDays` is 7 for a week, so the
  same formula pacts a partial week for free). It is clearly labelled an estimate.
  **Status is computed on money actually spent, not on the projection**, so a
  budget never reads "over" before it truly is — but "on pace to spend $X" warns
  early. `asOfDate` is the latest transaction date, never the wall clock (matches
  every other endpoint; keeps responses deterministic).

- **D-B4 — Status thresholds (deterministic, configurable).** Of the limit:
  `under` < 90%, `near` 90–100% (inclusive of 100), `over` > 100%. The `near`
  floor was raised from 80% to 90% on rework — with weekly caps in play an 80%
  warning fired too eagerly. Constants live in a `DEFAULT_BUDGET_CONFIG` like
  `DEFAULT_INSIGHTS_CONFIG` (`nearRatioBasisPoints: 9_000`). A category with no
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
    overallWeeklyLimitCents, budgets: [{category, limitCents, period?}] }` (both
    windows at once, so a save can round-trip the window the user isn't editing).
  - `POST /api/v1/budgets` → replace the whole set (simplest correct semantics for a
    small set the UI edits as a whole); validated with Zod; returns the saved set.
    Whole-set replace originally used `PUT`, but browser verification caught that
    the server's CORS allowlist advertises only `GET,POST,PATCH,DELETE,OPTIONS` —
    the exact verb set every existing route uses. Rather than widen shared,
    security-relevant CORS config for a single route, this uses `POST` (as the rest
    of the API's full-state writes do, e.g. `statement-imports/commit`). Semantics
    are unchanged.
  - `GET /api/v1/budgets/progress?period=week|month&key=&currency=USD` → computes
    progress for that window from the user's transactions via core `evaluateBudgets`
    over `summarizeSpending`. `key` is validated to match the window (`YYYY-Www`
    for week, `YYYY-MM` for month) and omitted resolves to the latest-data window.
    The route passes the window-appropriate overall cap; returns per-category +
    overall progress.

- **D-B7 — All math in core.** `evaluateBudgets({ summary, budgets, overallLimitCents })`
  is a pure function in `packages/core/src/domain/budgets.ts` reading
  `summary.categoryTotals[].outflowCents` (net of refunds), `summary.totalOutflowCents`,
  and `summary.period`. **Core is the single source of truth for window filtering**:
  it scores only the budgets whose window matches `summary.period.kind` (a weekly
  cap when the summary is a week, monthly otherwise). The route stays thin — it
  only selects which overall cap to pass for the window. The browser does no
  arithmetic (`CD-003`, `CD-011`).

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

- **D-B11 — Week/Month toggle (rework, 2026-08-10).** The Budgets screen has a
  `role="tablist"` Week/Month toggle in its header; it selects which window you're
  viewing and editing, defaulting to **Month**. Switching re-fetches that window's
  progress, category picker, and caps, and re-labels every period-bound string
  ("This week/month", "Overall weekly/monthly cap", "on pace … by week/month
  end"). A save writes only the visible window's budgets and overall cap while
  **preserving the other window untouched** — the screen merges the edited window
  over the other window's stored budgets and keeps the other overall cap — so
  toggling back and forth never drops the caps you set on the other window. The
  full configured set (both windows) always round-trips through the single
  whole-set POST; the toggle is purely a view/edit selector, not a second store.

## Files (claimed for H-082)

- `packages/core/src/domain/budgets.ts` (new), `packages/core/src/index.ts` (export),
  `packages/core/tests/budgets.test.ts` (new), `packages/core/fixtures/mvp0/budget-cases.json` (new).
- `packages/server/src/local/budget-store.ts` (new),
  `packages/server/src/local/budget-store-provider.ts` (new),
  `packages/server/src/http/budget-routes.ts` (new),
  `packages/server/src/http/server.ts` (wire routes + eraseUserData),
  `packages/server/tests/budget-routes.test.ts` (new).
- `apps/web/src/services/api.ts` (budget client fns),
  `apps/web/src/services/budgets.ts` (window-aware data access),
  `apps/web/src/screens/BudgetsScreen.tsx` (new; Week/Month toggle per D-B11),
  `apps/web/src/screens/SpendingScreen.tsx` (entry-point card per D-B10),
  `apps/web/src/App.tsx` (route wiring).

## Boundaries kept

- Read-only and decision-supportive: a budget never moves money or changes an
  account. It states amounts and a neutral status; no judgement, no advice
  (`D-002`, `D-006`).
- Deterministic-first: the browser and the AI both consume computed figures; no
  new financial classification is introduced.
</content>
