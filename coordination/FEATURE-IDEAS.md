# Feature Ideas — autonomous session 2026-08-09

Status: Living
Owner: `[UI: Claude]` (autonomous session while the user is away ~2h)

The user asked a fresh session to (1) figure out extra features worth adding,
(2) write a concise plan, (3) start implementing the **first** one, making and
recording any design decisions for later review. This file is the ranked list.
The first item is being built now; the rest are queued.

## How these were chosen

Read the whole product surface first: charter, roadmap, backlog, coordination,
and the actual code (`packages/core`, `packages/server`, `apps/web`). The
product is **Breadcrumbs** — "Where is my money going?" across all accounts,
with "Can I afford this?" secondary, deterministic-first, AI only over computed
facts. The gaps below are ranked by leverage against that mission and by how
self-contained a first slice is.

## Ranked shortlist

### 1. Category Budgets  ← BUILDING NOW

Set a monthly spending limit per category (and an optional overall cap), and see
progress — spent vs. limit, remaining, and a pace-projected end-of-month figure —
right where spending already lives.

Why first:
- **On-mission.** The product answers "where did my money go?"; a budget answers
  the very next question, "…and was that more than I meant to spend?" It's the
  user's own stated problem: heavy card spending, a month-end scramble to find
  waste, wanting to cut discretionary spend.
- **Self-contained + deterministic.** Consumes the already-computed,
  refund-netted `SpendingSummary.categoryTotals` — no new money classification.
  All arithmetic stays in `packages/core` (`CD-003`). Fully testable headless.
- **Establishes the "per-user targets" pattern** (persistence + endpoint) that
  the roadmap's blocked `L-010` goal tracking will reuse, and sets up `S-006`
  goal-conflict insights later.
- **High visual payoff** — progress bars slot straight into the existing
  category list on the Spending (Pulse) screen.

Design + decisions: `docs/budgets.md`.

### 2. Goal tracking (`L-010`) — savings target, distinct from budgets

The roadmap's named blocker for `S-006` goal-conflict insights. There is already
a `Goal`/`GoalType = "monthly_savings_target"` type, goal-conflict insight code
that is **written but dead** (every read flow passes `goals: []`), and goal-aware
affordability reasons waiting for input. Wiring goal persistence + a set/read
endpoint + `goals` into `detectInsights` and `buildSnapshotFromHistory` lights
all of that up. Budgets (#1) build the persistence/endpoint pattern this reuses.

### 3. Recurring-bills / cash-flow calendar

A forward-looking view of upcoming recurring charges and income for the next
30–45 days, built on the existing recurrence detection (`detectRecurringSpending`
/ `annotateRecurrenceSignals`) and income/obligation inference
(`snapshot-from-history`). Answers "what's about to hit before payday?" — the
other half of the user's month-end scramble.

### 4. Net-worth trend over time

`buildAccountsView` computes a point-in-time net position. Snapshot it per period
and chart the trend so a user sees assets vs. liabilities moving, not just today.

### 5. Monthly "where did my money go" report export (PDF/CSV)

A deterministic, shareable monthly report generated from the spending summary +
insights. Read-only, no new math, leans on the skills available for PDF.

### 6. Anomaly / first-seen large-charge flags

Flag unusually large charges and first-time-seen merchants deterministically —
"you don't usually spend this here" — as a quiet, checkable insight type.

## Notes

- Nav is a `C·A·P·I·T·A·L` acrostic; new destinations are reached from existing
  screens (like Import and Settings), not added as nav tabs, to preserve it.
- Coordination: Codex is off; backend is editable but concurrent Claude sessions
  may touch `apps/web`. Files claimed for feature #1 are listed in `docs/budgets.md`.
</content>
</invoke>
