# UI Copy Map

Status: Living  
Owner: `[UI: Claude]`  
Last updated: 2026-08-03

## Purpose

This document maps stable backend codes to the words the user reads. Per `CD-006`, the UI owns all user-facing copy; backend-emitted strings (`headlineFact`, `reasons[].facts[]`, `Assumption.message`, `FreshnessWarning.message`) are diagnostic output and are never rendered verbatim.

Every string a user sees in MVP 0 originates here.

## Voice

Derived from `D-006` and the charter principle "treat spending behavior without shame or moral judgment."

**The product is a well-prepared analyst briefing a competent adult.** It reports what the numbers show, names its assumptions, and does not editorialize.

Rules:

1. **Describe cash, not character.** The subject of a sentence is money, a date, or an obligation — never the user's habits. Say "This leaves $118 on Aug 14," not "You're overspending."
2. **Second person for the user's money, never for blame.** "Your buffer," "your rent" is fine. "You spent too much," "you should" is not.
3. **No modal verbs of obligation.** No "should," "need to," "must," "ought to." These convert decision support into advice and cross the `D-002` boundary.
4. **State the tradeoff, not the recommendation.** "Funding this goal leaves $84 above your buffer" — then stop. The user decides.
5. **Name the threshold whenever a verdict depends on it.** A `TIGHT` result is meaningless unless the buffer is stated in the same sentence.
6. **Dates are concrete.** "Aug 14," not "soon" or "shortly."
7. **Never assert what the engine did not compute.** No implied deferral dates or shortfall amounts (`CD-007`).
8. **No exclamation points. No congratulation.** `AFFORDABLE` is a finding, not a reward.

### Banned constructions

| Never | Instead |
| --- | --- |
| "You can't afford this" | "This leaves your required bills short by $220 on Aug 14" |
| "You should wait" | "Your next paycheck is Aug 16" |
| "Too much spending on dining" | "Dining: $340 across 22 purchases" |
| "Unfortunately," "Sadly," | (omit) |
| "Great job!" "You're on track!" | "Projected balance stays above your $250 buffer" |
| "Risky purchase" | "This purchase leaves required bills uncovered" |
| "Only $118 left" | "$118 projected on Aug 14" |

Note the last: "only" is an editorial intensifier. The number carries the weight.

## Parameter Notation

Copy templates below use `{braced}` placeholders. Each is a value the UI **reads** from the response — never one it derives, per `CD-003`.

All parameters below are typed fields on `ReasonParameterMap`, delivered by `[Backend: Codex]` under `H-005` and verified against the running engine. `DecisionReason` is a discriminated union keyed on `code`, so `reason.parameters` narrows per code without a cast.

Implemented in `apps/web/src/copy/reasons.ts`.

Formatting is applied by the `Money` and `DateDisplay` components: money as `$1,234` (cents omitted when zero, shown when non-zero), dates as `MMM D` within the horizon.

## Affordability Levels

| Level | Word | Headline template |
| --- | --- | --- |
| `AFFORDABLE` | Affordable | `{purchaseLabel} fits. Projected cash stays at or above your {buffer} buffer through {horizonEnd}.` |
| `TIGHT` | Tight | `{purchaseLabel} fits, but it leaves you below your {buffer} buffer.` |
| `RISKY` | Risky | `{purchaseLabel} doesn't fit on the current schedule.` |
| `UNKNOWN` | Not enough information | `There isn't enough information to answer this yet.` |

`UNKNOWN` deliberately uses a phrase rather than a single word. "Unknown" as a verdict sounds like a system failure; "Not enough information" correctly locates the gap in the data and implies it is resolvable.

### The headline carries no figures

Only `{buffer}` and `{horizonEnd}` appear, and only where they are true by definition of the level. Every other number belongs to the primary reason rendered directly beneath.

This rule was learned rather than designed. The first version read the minimum balance and date from `metrics.requiredPath` and put them in the headline. That is correct only when the determining reason concerns the required path. Against the monthly-savings fixture it produced two user-visible falsehoods:

- A `TIGHT` result read "projected cash drops to $535, below your $250 buffer." $535 is not below $250. The verdict came from `GOAL_BUFFER_CONFLICT` on the *protected* path at $235; the headline was reading the *required* path.
- A `RISKY` result read "leaves required bills uncovered" when the reason was `HIGH_PRIORITY_GOAL_SHORTFALL` and required bills were fully covered.

Both type-checked. Both read as authoritative. The general lesson: the UI must not restate a figure whose provenance it has not established, because `metrics` exposes several paths and only the primary reason knows which one decided the answer.

The `RISKY` wording is deliberately neutral across all four causes — required shortfall, timing shortfall, protected goal shortfall, and unreliable income. Naming the cause is the reason's job.

## Reason Codes

All 14 codes from the contract. Each has a **primary** form (shown when it is the determining reason) and a **secondary** form (shown in the collapsed list).

### Informational — `AFFORDABLE`

**`BUFFER_PASSED`** · info

- Primary: `Projected cash stays at or above your {buffer} buffer. The lowest point is {minBalance} on {minDate}.`
- Secondary: `Stays above your {buffer} buffer`

**`TIMING_RESERVE_PASSED`** · info

- Primary: `Bills due before your next paycheck on {nextIncomeDate} are covered, with {timingMargin} above your buffer.`
- Secondary: `Bills before {nextIncomeDate} are covered`
- Parameters: `timingReserveMarginCents`, and `nextReliableIncomeDate` which is optional. When the date is absent the copy degrades to "your next paycheck" with no date, which is why the template never hard-codes one.

### Warnings — `TIGHT`

**`BUFFER_BELOW_MINIMUM`** · warning

- Primary: `Projected cash drops to {minBalance} on {minDate}. That's {shortfall} below your {buffer} buffer, but stays above zero.`
- Secondary: `{shortfall} below your buffer on {minDate}`
- `shortfall` is `bufferShortfallCents`, supplied pre-computed by the backend. The UI does not negate or subtract anything; it reads a named field.

**`TIMING_RESERVE_LOW`** · warning

- Primary: `After this purchase, {postPurchaseCash} needs to cover {timingReserve} of bills before your next paycheck. That leaves {timingMargin} — less than your {buffer} buffer.`
- Secondary: `Leaves {timingMargin} before your next paycheck`
- Sources: `metrics.postPurchaseCashCents`, `metrics.timingReserveCents`, `metrics.timingReserveMarginCents`. All three are named fields; the UI reads, it does not compute the difference.

**`OPTIONAL_OBLIGATION_TRADEOFF`** · warning

- Primary: `Required bills are covered. The tight point comes from optional and flexible items: {entityLabels}.`
- Secondary: `Optional items create the tight point`
- `entityLabels` resolved from `relatedEntityIds` against the request snapshot. This is a lookup, not a calculation.

**`GOAL_BUFFER_CONFLICT`** · warning

- Primary: `{goalLabel} can still be funded. Doing so brings projected cash to {minBalance} on {minDate}, below your {buffer} buffer.`
- Secondary: `{goalLabel} contribution drops cash below your buffer`
- Uses the protected path minimum. Note the framing: the goal *can* be funded. The user is not told to skip it.

**`BASELINE_ALREADY_TIGHT`** · warning

- Primary: `Your forecast was already below your {buffer} buffer before this purchase. This purchase lowers the projected low point by {purchaseImpact}.`
- Secondary: `Forecast was already tight before this purchase`
- `purchaseImpact` = `metrics.purchaseImpactOnMinimumCents`. This reason matters because it separates a pre-existing condition from the purchase — showing it prevents the user from attributing all the tightness to the thing they are considering.

### Critical — `RISKY`

**`REQUIRED_OBLIGATION_SHORTFALL`** · critical

- Primary: `Projected cash goes to {minBalance} on {minDate}, before {entityLabel} is due. Required bills aren't covered on the current schedule.`
- Secondary: `Required bills uncovered on {minDate}`

**`TIMING_RESERVE_SHORTFALL`** · critical

- Primary: `After this purchase, {postPurchaseCash} doesn't cover {timingReserve} of bills due before your next paycheck.`
- Secondary: `Bills before your next paycheck aren't covered`

**`HIGH_PRIORITY_GOAL_SHORTFALL`** · critical

- Primary: `{goalLabel} is set as protected. Funding it on {goalDate} would require more cash than is projected to be available.`
- Secondary: `{goalLabel} can't be funded as scheduled`

**`VARIABLE_INCOME_NOT_GUARANTEED`** · critical

- Primary: `This works only if {incomeLabel} arrives in full. Counting only guaranteed income, required bills reach {minBalance} on {minDate}.`
- Secondary: `Depends on {incomeLabel}, which isn't guaranteed`
- The most important reason to word carefully. It must convey that the optimistic path exists without implying the answer is really fine.

### Critical — `UNKNOWN`

**`STALE_BALANCE`** · critical

- Primary: `Your {accountLabel} balance was last updated {relativeAge}. Balances this old can't produce a reliable projection.`
- Secondary: `{accountLabel} balance is out of date`
- Resolution: `Update this balance` (the affordance re-opens the input; it does not write to any account)

**`MISSING_PURCHASE_FIELD`** · critical

- Primary: `This purchase is missing {missingFields}. Both an amount and a date are needed to project its effect.`
- Secondary: `Purchase is missing {missingFields}`
- Resolution: `Add the missing details`

**`COVERAGE_INCOMPLETE`** · critical

- Primary: `Not all bills or income through {horizonEnd} have been confirmed. Answering now would overstate how much is known.`
- Secondary: `Bills or income aren't confirmed through {horizonEnd}`
- Resolution: `Confirm your recurring bills`
- The phrase "would overstate how much is known" does real work: it explains that the refusal to answer is a deliberate accuracy choice, not a malfunction.

## Freshness Warnings

Six codes from `FreshnessWarning`. Severity drives placement per the design system.

| Code | Copy | Severity handling |
| --- | --- | --- |
| `BALANCE_STALE` | `{accountLabel} was last updated {relativeAge}.` | `critical` blocks the figure; `warning` shows a card banner |
| `TRANSACTIONS_INCOMPLETE` | `Transaction history is partial from {fromDate}. Spending summaries may not reflect everything.` | Card banner on spending views |
| `INCOME_COVERAGE_INCOMPLETE` | `Income isn't confirmed through {throughDate}.` | Banner on the verdict panel |
| `OBLIGATION_COVERAGE_INCOMPLETE` | `Recurring bills aren't confirmed through {throughDate}.` | Banner on the verdict panel |
| `MANUAL_DATA_UNCONFIRMED` | `Some figures were entered manually and haven't been confirmed against an account.` | Inline metadata |
| `ESTIMATED_VALUE` | `{fieldLabel} is an estimate based on {estimateMethod}.` | Inline, with the `~` prefix treatment |

`estimateMethod` display strings: `user_entered` → "a value you entered", `historical_average` → "your past averages", `merchant_recurrence` → "a repeating charge pattern", `category_average` → "category averages".

## Assumptions

`AssumptionCode` is a stable six-member union, delivered under `H-004`. Implemented as an exhaustive `Record<AssumptionCode, string>` in `apps/web/src/copy/index.ts`, so a new backend assumption code breaks the UI build rather than reaching a user untranslated.

| Code | Copy |
| --- | --- |
| `AVAILABLE_BALANCE_MISSING` | `One account doesn't report an available balance, so its current balance was used. Pending charges may not be reflected.` |
| `CONSERVATIVE_INCOME_MINIMUM_USED` | `Income is counted at its guaranteed minimum, not its expected amount.` |
| `FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY` | `Flexible goal contributions are treated as delayable, so they aren't counted as required bills.` |
| `OPTIONAL_OBLIGATION_EXCLUDED_FROM_REQUIRED_SOLVENCY` | `Optional items are shown in the forecast but aren't counted as required bills.` |
| `CADENCE_DAY_CLAMPED_TO_MONTH_END` | `A bill falls on a day this month doesn't have, so it's counted on the last day of the month.` |
| `CONSERVATIVE_SAME_DAY_ORDERING_APPLIED` | `When bills and income land on the same day, bills are counted first.` |

The last is worth surfacing prominently. It is a real assumption that changes answers, and a user who does not know it may find a `TIGHT` verdict inexplicable. It appears on every run of the current fixture.

Assumption copy is deliberately not parameterised by entity label. `Assumption.relatedEntityIds` is populated, but naming the specific account or bill in an assumption tends to read as an accusation about that item rather than a statement about how the calculation works.

## Product Boundaries

| Boundary | Copy |
| --- | --- |
| `READ_ONLY_DECISION_SUPPORT` | `Read-only. This app can't move money or change your accounts.` |
| `NOT_PERSONALIZED_FINANCIAL_ADVICE` | `This is a projection from the numbers you've provided, not financial advice.` |
| `NO_ACCOUNT_WRITES` | `Balances are shown as reported. Nothing here changes them.` |
| `DETERMINISTIC_CALCULATION` | `Same inputs, same answer. This projection is calculated, not generated.` |

The last is a deliberate trust signal and will matter more once the MVP 3 AI layer exists.

## Interface Labels

| Context | Copy |
| --- | --- |
| Primary action | `Check affordability` |
| Purchase amount field | `How much?` |
| Purchase date field | `When?` |
| Necessity field | `Essential` / `Useful` / `Discretionary` |
| Deferrable checkbox | `This could wait` |
| Reasons expander | `{n} more reasons` |
| Assumptions expander | `{n} assumptions` |
| Chart legend | `Required bills` / `Protected goals` / `All planned items` / `If expected income arrives` |
| Buffer line label | `Your {buffer} buffer` |
| Empty state, no accounts | `Add an account to get started.` |
| Empty state, no purchase | `Enter a purchase to check.` |
| Loading | `Calculating…` |
| Error boundary | `Something went wrong on our side. Your data wasn't changed.` |

Chart legend labels avoid the internal path names. "Required path" is engine vocabulary; "Required bills" is what it means.

## Number and Date Formatting

- Money: `$1,234` when cents are zero, `$1,234.56` otherwise. Negative as `-$1,234`, never parenthesized.
- Never render an unavailable figure as `$0.00`. Use the em-dash placeholder.
- Dates within the horizon: `Aug 14`. Across a year boundary: `Aug 14, 2027`.
- Relative time under 24h: `3 hours ago`. Beyond: `4 days ago`. Beyond 30 days: absolute date.
- `~` prefix marks estimated figures: `~$1,240`.
