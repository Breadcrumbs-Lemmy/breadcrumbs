# Net-worth trend — design & decisions

Status: Designed 2026-08-10 (forks approved by the user on review) — building.
Owner: `[UI: Claude]`
Feature: #4 in the "extra features" initiative, after Budgets, Goals, Cash-Flow.

A net-worth trend answers a question the app can already price at a single point
but never *over time*: **"is my cash position going up or down, and by how
much?"** The Accounts screen shows today's net position
(`buildAccountsView.netPositionCents` — cash minus what you owe on cards). This
feature plots that same figure month by month so the direction is visible, not
just the level.

It reuses the exact sign convention already in `packages/core/src/domain/
accounts-view.ts` (`netContribution`: cash `+`, liability `−`, excluded `0`), so
a trend point for the current month and the Accounts headline can never
disagree.

## Why this feature

Every other over-time view in the app is about *spending* (`spendingSeries`,
insights). None shows the balance-sheet direction. A user paying down a card or
building a cushion has no single line that says "you are $2,400 better off than
in March." Net worth is the one number that captures that, and the app already
computes it — it just isn't remembered or plotted.

## The hard part, stated up front

**No historical balances are stored.** `Account` carries only
`currentBalanceCents`; there are no balance snapshots over time, and Plaid
returns *current* balances, not history. A trend therefore has to be either
**reconstructed** from the transaction record or **recorded going forward** — and
each has an honesty cost. The decisions below (especially D-N3–D-N6) are mostly
about being truthful about which points are measured and which are inferred.

## Design decisions (forks marked ✅ were approved by the user on 2026-08-10)

- **D-N1 — What it is.** A monthly net-worth trend: one point per calendar
  month-end, `netWorthCents = Σ assets − Σ liabilities owed`, using the
  role-sign convention from `buildAccountsView`. Read-only, **observed history
  only — no forecast.** A projected net worth would be a claim about the future
  the data cannot support and would drift toward advice (`D-002`); the line stops
  at the present.

- **D-N2 — ✅ "Cash net worth": investments excluded.** The included set is every
  account *except* `type: "investment"` and *except* `role: "excluded"`. So the
  trend is **liquid cash minus what's owed on cards and loans.** Investments are
  excluded because a brokerage balance moves with the market, not with recorded
  transactions — back-casting one (D-N3) would draw a flat or plainly wrong line
  through real market swings. The figure is labelled *"cash net worth — what you
  have, minus what you owe"* everywhere so it never implies total wealth. (User
  chose *exclude* over *hold-flat-and-flag* on review.)

- **D-N3 — Reconstruct history by back-casting.** With no stored balances, each
  past month-end is reconstructed from the one balance we do know — today's:

  ```
  balance(monthEnd)  =  currentBalance  −  Σ signedEffect(t)   for every t with t.postedDate > monthEnd
  netWorth(monthEnd) =  Σ over included accounts of the role-signed reconstructed balance
  ```

  `signedEffect(t, role)` is a pure, per-`flowType` map defined and unit-tested in
  core: on an **asset** account `INCOME`/`REFUND`/`TRANSFER_IN` raise the balance
  and `SPEND`/`FEE`/`TRANSFER_OUT` lower it; on a **liability** the same flows
  move the *amount owed* the mirror way. **Invariant (tested):** reconstructing at
  `asOfDate` returns exactly the current net worth, because the set of
  transactions dated after `asOfDate` is empty. A move between the user's own
  included accounts (checking→savings, or a card payment) touches two accounts by
  equal and opposite amounts, so it **nets to zero** and leaves net worth flat —
  which is correct, and falls out automatically from summing per-account.

- **D-N4 — ✅ Snapshot forward for exact future points ("Both").** Because a
  back-cast is only as good as the transaction record, the trend route also
  **records** the current figure as it computes it, into a per-user
  `net-worth-snapshots.json` store. On read, a **recorded** snapshot supersedes
  the **reconstructed** value for any month it covers; back-casting fills the
  gaps. Over time the line becomes measured rather than derived. Every returned
  point carries `basis: "recorded" | "reconstructed"` so the UI stays honest about
  which is which.
  - **Observation date = the latest balance-freshness `asOf` across included
    accounts** (falling back to `asOfDate`). That is a real timestamp already in
    the data, so **no wall clock enters core** and determinism holds. The upsert
    is **idempotent per calendar day** (last write wins), so repeatedly viewing
    the trend never bloats the file or double-counts.
  - **Capture-on-read, deliberately.** The app has no background job — an HTTP
    request is the only time code runs — so the snapshot is taken as a documented
    side effect of the `GET` trend read. It is idempotent and invisible to the
    response body. (A reviewer may reasonably prefer moving this to the accounts
    load path or a dedicated write; flagged as the one arguable call here.)

- **D-N5 — Honest coverage start.** The reconstructed line begins at the earliest
  month-end where **every included account has transaction coverage back that
  far.** Earlier months are omitted rather than drawn with a fabricated slope: an
  account whose imported history starts mid-window would otherwise make net worth
  appear to lurch when the data is simply missing. The response reports
  `coverageStartMonth` and `monthsCovered` so the UI can say where the line
  honestly begins.

- **D-N6 — Reconstruction limits, surfaced not hidden.** Any balance change *not*
  represented by a transaction — loan-interest accrual, an uncaptured fee, a
  manual balance edit — is invisible to back-casting, so a reconstructed point can
  drift from the true balance. This is exactly why recorded snapshots supersede it
  (D-N4) and why investments are excluded (D-N2). The UI shows a plain
  *"reconstructed from your transactions"* note on the historical portion and
  reserves the solid treatment for `recorded` points.

- **D-N7 — Endpoint.** `GET /api/v1/net-worth/trend?currency=USD` →
  ```
  {
    currency,
    points: [{ month, netWorthCents, cashCents, debtCents, basis }],
    currentNetWorthCents,
    changeCents,               // current − first covered point
    coverageStartMonth,
    monthsCovered
  }
  ```
  A `GET` is CORS-safe; the idempotent snapshot upsert (D-N4) happens server-side
  as a side effect of the read, so there is **no new write verb and no CORS
  allowlist change** (cf. the budgets/goals `POST`-not-`PUT` note). Single
  currency (D-N9).

- **D-N8 — All math in core.** `net-worth-trend.ts` owns the back-cast, the
  snapshot merge, and `signedEffect`; the route parses the query, loads
  transactions + stored snapshots, calls the domain, and serialises; the browser
  formats cents and thresholds nothing (`CD-011`). Deterministic given its inputs
  (`asOfDate` = latest transaction; snapshot timestamps are recorded *inputs*, not
  wall-clock reads inside core).

- **D-N9 — UI placement, colour, currency.** Reached from the **Accounts screen**
  via an entry card (net worth is the sum of the accounts, so it belongs with
  them), **never a nav tab** — the nav spells `C·A·P·I·T·A·L` and a tab would
  spoil it (same rule as Budgets/Goals/Settings). **Word-first (`D-006`):** the
  headline is the current cash net worth and its change over the covered window
  ("up $2,400 since March"); colour is a restrained accent only and never the sole
  signal — up → `--accent`, down → `--alert`. The chart's **zero baseline is a
  neutral structural line** (`--border-strong`), deliberately *not* the alert red
  the shared `--data-zero` token resolves to: crossing zero is a fact to mark
  quietly, not an alarm to raise, and the alert colour is reserved for the
  direction signal. Single-currency like the rest of MVP 0; a point carries the
  request currency and mixed currencies are not normalised (matches the
  affordability engine's own guard).

## Files (planned)

- `packages/core/src/domain/net-worth-trend.ts` (new — back-cast + snapshot merge
  + `signedEffect`), `packages/core/src/index.ts` (exports),
  `packages/core/tests/net-worth-trend.test.ts` (new; non-2026 fixtures per the
  reconstruction-sign blind-spot class).
- `packages/server/src/local/net-worth-store.ts` (new — per-user snapshot JSON,
  atomic write, 0600, `FieldCipher` envelope; net worth reveals financial
  position, so it is encrypted at rest when a key is configured),
  `packages/server/src/local/net-worth-store-provider.ts` (new),
  `packages/server/src/http/net-worth-routes.ts` (new; `GET /net-worth/trend` +
  the capture-on-read upsert), `packages/server/src/http/server.ts` (wire the
  route + `eraseUserData`), `packages/server/tests/net-worth-routes.test.ts`
  (new), `packages/server/tests/account-deletion.test.ts` (snapshot erasure).
- `apps/web/src/services/net-worth.ts` (new; client + load),
  `apps/web/src/services/api.ts` (`fetchNetWorthTrend`),
  `apps/web/src/screens/NetWorthScreen.tsx` (new; word-first trend + honesty
  notes), the Accounts screen (entry-point card),
  `apps/web/src/App.tsx` (route wiring).

## Boundaries kept

- Read-only and decision-supportive: the trend never moves money and makes no
  recommendation. It reports a level and a direction as facts about the user's
  own recorded and reconstructed balances (`D-002`, `D-006`).
- Deterministic-first (`D-003`): the browser and the AI consume computed figures;
  no new financial classification is introduced. History is reconstructed from
  the transaction record and clearly flagged where it is inferred vs measured.
