# Goal tracking (savings targets) — design & decisions

Status: Building 2026-08-10 (autonomous session) — awaiting user review of D-G1..D-G10
Owner: `[UI: Claude]`
Roadmap: `L-010` (the named blocker for `S-006` goal-conflict insights)

A goal lets a user declare a **savings target** — "I mean to put aside $X, I've
saved $Y, I add $Z a month" — and see, deterministically, whether that plan is on
pace. It reuses the app's per-user "targets" persistence + endpoint pattern.

This is **distinct from a spending cap.** A spending cap asks "was that more than
I meant to spend?" over a category this month; a goal is a *savings target* over
time, answering "am I still on track for what I'm saving toward?".

## Why this feature, and what it unblocks

The `Goal` / `GoalType = "monthly_savings_target"` type already exists, and the
affordability engine already consumes `snapshot.goals` fully — it turns each
monthly contribution into a forecast event on the protected/all path, raises a
`FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY` assumption for flexible goals,
and lets a high-priority *protected* goal gate required solvency. **All of that
is inert today** because both snapshot builders (`buildSnapshotFromHistory` and
the Plaid mapper) hardcode `goals: []`. This feature is the missing *declaration*
layer: persist the user's goals and inject them, so the already-written code runs
on real input. Goal-conflict *insights* (`S-006`) remain future work on top.

## Design decisions (for user review on return)

Each is a deliberate call made autonomously. Change any and I'll rework it.

- **D-G1 — What a goal is (v1).** A savings target, reusing the canonical `Goal`
  (`goalType: "monthly_savings_target"`). The user declares only a small input —
  `{ label, targetAmountCents, currentAmountCents, monthlyContributionCents,
  targetDate?, priority?, protection? }` — and core `buildSavingsGoal` fills the
  rest of the canonical shape deterministically (monthly cadence on the 1st, next
  contribution = the 1st of the month after `asOfDate`, `source: "manual"`,
  confidence 1, `active: true`). No new goal types; no other `Goal` fields are
  exposed in v1.

- **D-G2 — A goal is declared, never inferred.** `buildSnapshotFromHistory`
  deliberately leaves `goals: []` — a bank statement cannot observe intent, and
  inventing "you meant to save $400" would put a goal the user never set into
  their forecast. v1 is exactly that declaration layer: goals are user-set,
  persisted, and *injected*. Nothing is derived from transactions.

- **D-G3 — Progress & pace (deterministic).** `evaluateGoals({ goals, asOfDate })`
  returns, per goal: `savedCents`, `remainingCents = max(0, target − saved)`,
  `progressBasisPoints` (of the target, floored at 0 and capped at 10000), a
  `status`, and — when a monthly contribution > 0 — a pace `projection`:
  `monthsToClose = ceil(remaining / monthlyContribution)`,
  `projectedCompletionDate = asOfDate + monthsToClose months`, and `onPace`.
  `asOfDate` is the latest transaction date (today only as a last-resort
  fallback), never the wall clock — deterministic like every other endpoint.

- **D-G4 — Status thresholds.** `reached` when `saved ≥ target` (or a non-positive
  target — nothing to save). Otherwise: **with** a `targetDate`, `on_track` if the
  projected completion lands on or before it, else `behind`; **without** a
  `targetDate`, `on_track` if the user is contributing (> 0), else `behind` (a
  target you never fund is not on track). Status is a factual statement about the
  user's own declared plan — never advice (`D-002`).

- **D-G5 — Persistence.** Per-user goal store, one JSON file at
  `<dataDir>/users/<id>/goals.json`, identical to the budget/statement stores:
  atomic temp-write-then-rename, mode 0600, a serialized write queue, and the
  same optional `FieldCipher` envelope (`{ "$enc": … }`) — goals reveal financial
  intent, so they are encrypted at rest when a key is configured. Isolation is by
  construction via `forUser(userId)`.

- **D-G6 — Endpoints.**
  - `GET /api/v1/goals` → the stored canonical set `{ currency, goals: Goal[] }`.
  - `POST /api/v1/goals` → replace the whole set (whole-set replace, as budgets do,
    and on POST not PUT for the same CORS reason — see `docs/budgets.md` D-B6).
    The body is validated as the small *input* shape and shaped to canonical goals
    server-side via core `buildSavingsGoal`; returns the saved set.
  - `GET /api/v1/goals/progress?currency=USD` → `evaluateGoals` over the stored
    goals at the data-derived `asOfDate`; returns per-goal progress + a rollup.

- **D-G7 — Lights up affordability.** Stored goals are injected into the
  affordability snapshot route so the engine's existing goal handling runs on real
  input. `buildSnapshotFromHistory` gains an optional `goals` param (default `[]`),
  so "nothing invented" still holds — the goals are *passed in*, not derived.

- **D-G8 — All math in core.** `buildSavingsGoal` and `evaluateGoals` are pure
  functions in `packages/core/src/domain/goals.ts`; the route parses, calls the
  domain, and serialises; the browser does no arithmetic (`CD-003`, `CD-011`).

- **D-G9 — UI placement & colour.** Goals are a dedicated screen reached from the
  affordability/planning surface (goals answer "can I still afford my future?"),
  not a nav tab — the nav spells `C·A·P·I·T·A·L` and a tab would spoil it (same
  rule as Budgets/Settings). Status is word-first (Reached / On track / Behind);
  colour is a restrained accent only and never the sole signal (mirrors budgets
  `D-B9`): positive states (`reached`, `on_track`) → `--accent`, `behind` →
  `--alert`.

- **D-G10 — Single currency.** Like the rest of MVP 0, v1 is single-currency. A
  goal carries the request currency; mixed currencies are not normalized (matches
  the affordability engine's own guard).

## Files

- `packages/core/src/domain/goals.ts` (new), `packages/core/src/index.ts` (export),
  `packages/core/src/domain/snapshot-from-history.ts` (optional `goals` param),
  `packages/core/tests/goals.test.ts` (new).
- `packages/server/src/local/goal-store.ts` (new),
  `packages/server/src/local/goal-store-provider.ts` (new),
  `packages/server/src/http/goal-routes.ts` (new),
  `packages/server/src/http/affordability-routes.ts` (inject stored goals),
  `packages/server/src/http/server.ts` (wire routes + eraseUserData),
  `packages/server/tests/goal-routes.test.ts` (new),
  `packages/server/tests/account-deletion.test.ts` (goal erasure).
- `apps/web/src/services/goals.ts` (new),
  `apps/web/src/screens/GoalsScreen.tsx` (new),
  the affordability/planning screen (entry-point card),
  `apps/web/src/App.tsx` (route wiring).

## Boundaries kept

- Read-only and decision-supportive: a goal never moves money or opens a savings
  account. It records the user's stated plan and states a factual pace; no
  judgement, no advice (`D-002`, `D-006`).
- Deterministic-first: the browser and the AI both consume computed figures; no
  new financial classification is introduced, and goals are declared, not derived.
