# MVP 0 Screen Specifications

Status: Living  
Owner: `[UI: Claude]`  
Last updated: 2026-08-03

## Purpose

Annotated screen specifications for the MVP 0 affordability flow. Every displayed value is traced to a field in `AffordabilityResponse` or the request snapshot. Tokens and components come from `ui-design-system.md`; all wording comes from `ui-copy-map.md`.

> **Resequenced 2026-08-04 for `D-011`.** This document was written when
> affordability was the product. It no longer is. The spending home is the
> primary surface and is specified in `ui-spending-home.md`; the affordability
> screens below remain accurate as *specifications* and as *built code*, but
> they are now a secondary destination rather than the product's front door.
> Screen numbering below is historical and does not imply priority.

## Scope

Screens specified here, all built:

1. Setup — financial snapshot entry
2. Purchase check — the affordability question
3. Result — the verdict, the evidence, the forecast

The spending home, which is now the product's primary screen, is specified separately in `ui-spending-home.md`.

Out of scope for MVP 0: settings, account connection, pattern insight surfaces beyond monthly summaries, and any AI surface.

## Integration Shape

**The HTTP move described below as "later" has happened** (`D-013` / `CD-011`). The single adapter is now `apps/web/src/services/api.ts`, and it holds every call the app makes, not just this one.

```ts
// apps/web/src/services/api.ts
export async function checkAffordability(
  body: AffordabilityRequest,
): Promise<AffordabilityOutcome> {
  const result = await request<AffordabilityResponse>(
    `/api/v1/affordability/evaluate`,
    { method: "POST", body: JSON.stringify(body) },
  );
  // ...maps ok / 400-invalid / transport failure to a discriminated outcome
}
```

Because the async wrapper existed from the start, moving the boundary from an in-process call to `fetch` touched one file and no component. That was the point of `CD-005`.

No component imports `@ai-fin-os/core` at runtime; only types cross the boundary. Malformed input returns `400` with `{ error: { code: "INVALID_AFFORDABILITY_REQUEST", issues } }`, which the adapter converts to a discriminated `AffordabilityOutcome` so callers distinguish a rejected request from a valid `UNKNOWN` result.

One exception remains and is not by design: `apps/web/src/model/snapshot.ts` imports an affordability fixture from `packages/core/fixtures/` by relative path, so this screen still evaluates fixture balances rather than the user's imported accounts.

## Navigation

**Superseded by `D-011`.** The destination model is now defined in `ui-spending-home.md`: **Spending** (default), **Transfers**, **Accounts**, with affordability reachable as a secondary action rather than a top-level destination.

The previous model — Check as the default route, on the reasoning that "the product opens on the question, not on a summary" — was correct under the old charter and is wrong under the current one. The product now opens on where money went.

One rule survives the change unaltered: no destination is named "Dashboard". A dashboard is a screen with no single job.

The persistent `READ_ONLY_DECISION_SUPPORT` boundary notice remains in the shell footer.

---

## Screen 1: Setup

Builds `FinancialSnapshot`. In MVP 0 this is fixture-loaded or manually entered.

### Sections

| Section | Snapshot field | Notes |
| --- | --- | --- |
| Accounts | `accounts[]` | Name, type, role, balance, freshness dot. Credit accounts visually separated and labeled as not spendable cash. |
| Income | `incomeSources[]` | Label, amount, cadence, next date, reliability. Bi-weekly is the default cadence per `D-007`. |
| Recurring bills | `recurringObligations[]` | Label, amount, cadence, next due, importance. Grouped by importance: required, flexible, optional. |
| Goals | `goals[]` | Label, target, contribution, priority, protection. |
| Coverage | `coverage` | Explicit confirmation checkboxes. |

### The coverage section is load-bearing

`DataCoverage` determines whether the engine will answer at all. If it is buried, users produce `UNKNOWN` results they cannot explain. It gets its own titled card with plain-language checkboxes:

- `balancesDeclaredComplete` → "I've added all my spending accounts"
- `obligationsDeclaredCompleteThroughDate` → "I've added all my bills through {date}"
- `incomeDeclaredCompleteThroughDate` → "I've added all income through {date}"
- `userConfirmedNoOtherRequiredObligations` → "Nothing else is due that I haven't listed"

Above the section: `These confirmations let the projection tell you when it doesn't know something, instead of guessing.`

### States

- **Empty**: `Add an account to get started.` Single primary action.
- **Partial**: sections completable in any order. A persistent summary strip shows what remains before a check can run.
- **Credit-only accounts**: inline note that credit limits are not counted as spendable cash, per the canonical model rule.

---

## Screen 2: Purchase Check

The product's central question. Deliberately sparse.

```
┌────────────────────────────────────────────┐
│                                            │
│         Can I afford this?                 │
│                                            │
│   How much?    [ $            ]            │
│   When?        [ Aug 14, 2026 ]            │
│   What for?    [ Category   ▾ ]            │
│                                            │
│   ○ Essential  ○ Useful  ○ Discretionary   │
│   ☐ This could wait                        │
│                                            │
│        [   Check affordability   ]         │
│                                            │
└────────────────────────────────────────────┘
```

Maps to `PlannedPurchase`: `amountCents`, `purchaseDate`, `category`, `necessity`, `deferrable`.

Rules:

- Amount and date are the only required fields, matching the contract's critical-field rule. Everything else is optional and unlabeled as optional, to avoid implying incompleteness.
- Date defaults to today.
- No client-side affordability preview. Not even a "you have $X" hint — that would be the UI answering the question the backend owns.
- Necessity and deferrable are captured because they belong to the model, but MVP 0 shows them back only in the result summary. They do not alter the verdict.

### States

- **Snapshot incomplete**: the action is disabled with an inline explanation naming the missing section and a link to it. Never a bare disabled button.
- **Submitting**: `Calculating…`, action locked, form values remain visible.

---

## Screen 3: Result

The core screen. Vertical order is fixed and matches focus order.

```
┌──────────────────────────────────────────────────────┐
│  ⚠ Rent isn't confirmed through Sep 2      [banner]  │  <- freshness, if any
├──────────────────────────────────────────────────────┤
│                                                      │
│  ●  Tight                                            │  <- VerdictPanel
│                                                      │
│  New laptop fits, but projected cash drops to        │
│  $118 on Aug 14, below your $250 buffer.             │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ Lowest projected cash      $118    Aug 14    │    │
│  │ Your buffer                $250              │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Projected cash drops to $118 on Aug 14. That's      │  <- primary reason
│  $132 below your $250 buffer, but stays above zero.   │     always expanded
│                                                      │
│  ▸ 2 more reasons                                    │
│  ▸ 3 assumptions                                     │
│                                                      │
│  This is a projection from the numbers you've        │  <- boundary
│  provided, not financial advice.                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Next 30 days                                        │  <- ForecastChart
│  [ multi-path daily balance chart ]                  │
│                                                      │
├──────────────────────────────────────────────────────┤
│  What's coming up                                    │  <- EventTimeline
│  Aug 5   Paycheck              +$2,140               │
│  Aug 14  New laptop            -$1,299               │
│  Aug 14  Rent                  -$1,450               │
└──────────────────────────────────────────────────────┘
```

### Field mapping

| Element | Source |
| --- | --- |
| Verdict word + glyph | `level` |
| Headline | UI-composed from `level` + `metrics` per copy map |
| Lowest projected cash | `metrics.requiredPath.minimumIntradayBalanceCents` / `...Date` |
| Buffer | `snapshot.config.minimumCashBufferCents` |
| Primary reason | `explanation.reasons[0]` — ordering guaranteed by backend |
| Additional reasons | `explanation.reasons[1..]` |
| Assumptions | `explanation.assumptions[]` — `AssumptionCode` union |
| Freshness banners | `explanation.freshnessWarnings[]` |
| Boundary | `explanation.boundaries[]` |
| Chart | `forecast.dailyBalances[]` |
| Timeline | `forecast.events[]` |

### Reserved slot

Per `CD-007`, no deferral or shortfall guidance in MVP 0. A slot is reserved directly below the reason list so it can be added later without moving anything above it. The slot renders nothing today.

### Level-specific treatment

**`AFFORDABLE`** — Same layout. `BUFFER_PASSED` and `TIMING_RESERVE_PASSED` still render as reasons; a positive verdict without evidence is less trustworthy than one with it. No celebration.

**`TIGHT`** — As drawn. Where `BASELINE_ALREADY_TIGHT` is present, it is promoted above other secondary reasons, because the distinction between "this purchase caused it" and "this was already true" changes what the user takes away.

**`RISKY`** — Triangle glyph, 2px border. The chart auto-annotates the shortfall point. The zero line always renders. No language implying the purchase is forbidden; the interface reports an outcome.

**`UNKNOWN`** — Structurally different. The verdict panel takes the dashed border. The forecast chart is **not rendered at all**, because a chart built on data the engine rejected would assert precision the engine refused. In its place, a resolution list built from the `UNKNOWN` reason codes, each with an affordance routing to the relevant setup section:

```
┌──────────────────────────────────────────────┐
│  ?  Not enough information          [dashed] │
│                                              │
│  There isn't enough information to answer    │
│  this yet.                                   │
│                                              │
│  Your Checking balance was last updated      │
│  9 days ago. Balances this old can't         │
│  produce a reliable projection.              │
│      → Update this balance                   │
│                                              │
│  Not all bills through Sep 2 have been       │
│  confirmed.                                  │
│      → Confirm your recurring bills          │
└──────────────────────────────────────────────┘
```

The affordances re-open input forms. Nothing writes to any account.

### Assumptions panel

Opens as a sheet, not a new route, so the result stays in view. Grouped: assumptions affecting the answer first, then informational. Closes with the `DETERMINISTIC_CALCULATION` boundary statement.

### Other states

- **Loading**: skeleton preserving final layout height, so the verdict does not jump into place.
- **Error**: full-screen boundary, `Something went wrong on our side. Your data wasn't changed.` Retry preserves inputs. Distinct from `UNKNOWN`, which is a valid result.

---

## Screen 4: Spending

Renders `monthlySpendingSummaries[]`. Reporting only — it does not participate in the affordability answer, and the screen says so.

| Element | Source |
| --- | --- |
| Month selector | `monthlySpendingSummaries[].month` |
| Total out / in | `totalOutflowCents` / `totalInflowCents` |
| Categories | `categoryTotals[]`, sorted by `outflowCents` |
| Merchants | `merchantTotals[]`, sorted by `outflowCents` |
| Transfers excluded | `excludedTransferOutflowCents` |
| Freshness | `freshness` |

Rules:

- Neutral color only. No red for high categories, no green for low ones. Per `D-006`, a category total is a fact, not a verdict.
- No budget bars or targets. MVP 0 has no category budgets, and implying one would invent a threshold the engine never computed.
- Excluded transfers shown explicitly, so totals reconcile.
- Header note: `Monthly summaries are for understanding your spending. Affordability is projected day by day.` This prevents the user from assuming a monthly average drives the verdict, which the backend design explicitly forbids.

### States

- **No transactions**: `No transactions yet. Monthly summaries appear once transactions are added.` MVP 0 can answer affordability with zero transactions, so this must not read as an error.
- **Partial history**: `TRANSACTIONS_INCOMPLETE` banner naming the start date.

---

## Responsive

Mobile-first; the affordability question is a phone-in-a-store moment.

- **Under 640px**: single column. Verdict panel full-bleed. Chart scrolls horizontally at fixed day width rather than compressing 30 days into a phone width.
- **640–1024px**: single column, constrained to 680px.
- **Above 1024px**: result screen splits — verdict, reasons, and assumptions left at 420px; chart and timeline right. Verdict stays sticky on scroll.

## Verification Checklist

Before any screen is called done:

- [ ] Every figure traces to a named response field
- [ ] No arithmetic on backend values beyond reading a single provided field
- [ ] All four levels have a designed state
- [ ] `UNKNOWN` never renders a chart or a `$0.00` placeholder
- [ ] Every string sourced from `ui-copy-map.md`
- [ ] No control implies money movement, including disabled ones
- [ ] Level is distinguishable without color
- [ ] Buffer amount appears wherever a verdict depends on it
- [ ] Freshness state visible on every account-derived figure

## Implementation Status

| Screen | State |
| --- | --- |
| Setup | Built. Editable snapshot with the coverage section. |
| Purchase check | Built. Wired to real evaluation. |
| Result | Built. All four levels verified against real engine output. |

The spending home is tracked in `ui-spending-home.md`, not here. Its status: design approved, implementation is `S-003`.

All contract dependencies for these screens are resolved: `H-002` (package and exports), `H-004` (assumption codes), `H-005` (reason parameters, ordering, error shape), `H-006` (purchase fallback values), `H-008` (snapshot entity type exports — `src/types/core.ts` is deleted and every consumer imports from `@ai-fin-os/core` directly).

Remaining, not blocking:

| Item | Handoff | Affects |
| --- | --- | --- |
| UI runtime coverage for 4 reason codes | `H-010` | Backend fixtures now exist for `OPTIONAL_OBLIGATION_TRADEOFF`, `BASELINE_ALREADY_TIGHT`, `VARIABLE_INCOME_NOT_GUARANTEED`, and `COVERAGE_INCOMPLETE`; UI verification still needs to consume them |
| Route default | `S-003` | `App.tsx` still opens on the affordability check, stale against `D-011`. Changes when the spending home lands. |
