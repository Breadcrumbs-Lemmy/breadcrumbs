# MVP 0 Data Quality And Safety

Status: Draft  
Last updated: 2026-08-04

## Purpose

This document defines the MVP 0 backend contract for financial input validation,
freshness, uncertainty, and read-only/non-advice safeguards.

MVP 0 must prefer a transparent `Unknown` affordability result over a precise
answer built from missing, stale, duplicated, or contradictory data.

## Scope

In scope:

- Manual or seeded account, balance, transaction, income, recurring obligation,
  goal, and planned purchase inputs.
- Deterministic validation before forecast, decision, and pattern logic.
- Freshness and uncertainty rules that affect forecasts, affordability results,
  and explanations.
- Read-only and non-advice safeguards that can be enforced by backend behavior.
- Test cases for invalid or incomplete inputs.

Out of scope:

- UI design.
- App stack selection.
- Plaid integration details beyond future read-only data assumptions.
- AI chat behavior beyond requiring AI to consume deterministic results later.
- Any flow that writes to financial accounts, initiates payments, trades assets,
  or changes external financial data.

## Relationship To Backend Design

This document is a validation, freshness, uncertainty, and safety contract. It
does not replace or rewrite a broader backend architecture document. Backend
model, service, storage, and API decisions should satisfy this contract without
requiring this document to select the implementation stack or UI surface.

## Initial User And Time-Grain Assumptions

MVP 0 targets an individual salaried user paid bi-weekly. Validation must treat
bi-weekly income cadence as a first-class supported schedule.

Spending summaries should aggregate normalized transactions by calendar month
because most bills and user budgeting language are monthly. This monthly
aggregation is separate from the deterministic forecast horizon. Forecast logic
still needs day-level event timing so bills, purchases, goal contributions, and
paydays are evaluated in order.

## Validation Outcome Contract

Every MVP 0 affordability run should begin with validation and produce a
deterministic validation outcome. These states can be combined; for example, a
scenario can be both `valid` and `deduped`, or `incomplete` and `stale`.

- `valid`: the scenario can produce an affordability result.
- `invalid`: required data is malformed or contradictory; result is `Unknown`.
- `incomplete`: optional or supporting data is missing; the scenario may proceed
  with reduced confidence if no critical rule is violated.
- `stale`: one or more time-sensitive inputs are older than freshness policy.
- `deduped`: duplicate inputs were detected and normalized before calculation.

Validation issues must be structured, not just logged text. Each issue should
include:

- stable issue code,
- severity: `error`, `warning`, or `info`,
- affected entity type and id,
- human-readable explanation,
- rule id or policy id,
- whether the issue forced `Unknown`.

Only inputs that pass validation and normalization should reach forecast,
decision, and pattern-detection logic.

## Required And Optional Fields

### Accounts

Required:

- `account_id`
- `name`
- `type`
- `currency`
- `current_balance`
- `balance_as_of`
- `is_spendable`

Optional:

- `available_balance`
- `institution`
- `mask`
- `source`
- `freshness_status`
- `confidence`

Rules:

- `account_id` must be unique within a scenario.
- `type` must be one of the MVP 0 supported account types.
- `currency` must be an ISO 4217 currency code.
- Spendable accounts include cash-like accounts such as checking, savings, and
  cash. Credit, loan, investment, and other liability or non-cash accounts must
  not be counted as spendable cash for MVP 0 affordability.
- Negative balances are allowed only when they match the account type semantics.
  A negative spendable balance means overdrawn cash, not available funds.
- If `available_balance` exists for a spendable account, the conservative
  spendable balance is `min(current_balance, available_balance)`.

### Transactions

Required:

- `transaction_id`
- `account_id`
- `posted_date`
- `amount`
- `description`
- `currency`

Optional:

- `merchant`
- `category`
- `pending`
- `source_transaction_id`
- `recurrence_signal`
- `confidence`
- `excluded_from_spending`

Rules:

- `account_id` must reference a valid account.
- Transaction amounts use one sign convention everywhere:
  - positive amounts are inflows,
  - negative amounts are outflows.
- Pending transactions can inform uncertainty, but a pending and posted copy of
  the same transaction must not both count.
- Transfers between the user's own accounts should not count as spending or
  income, though they may affect account-level cash timing.

### Income

Required:

- `income_id`
- `name`
- `amount`
- `currency`
- `cadence`
- `next_expected_date`
- `source`

Optional:

- `variability`
- `confidence`
- `end_date`
- `account_id`

Rules:

- Income amount must be positive.
- Variable or irregular income should lower confidence unless the user provides
  explicit expected dates and amounts.
- Income should not be inferred from transfers between the user's own accounts.

### Recurring Obligations

Required:

- `obligation_id`
- `name`
- `amount`
- `currency`
- `cadence`
- `next_due_date`
- `required`
- `source`

Optional:

- `category`
- `account_id`
- `end_date`
- `confidence`
- `inferred_from_transaction_ids`

Rules:

- Obligation amount must be positive.
- `required` must be explicit. Missing required/optional status is incomplete
  and should be treated conservatively as required for affordability.
- Required obligations due inside the forecast horizon are critical inputs.
- Optional obligations may affect `Tight` or `Risky`, but missing optional
  details should not by itself force `Unknown`.

### Goals

Required:

- `goal_id`
- `name`
- `goal_type`; first supported MVP 0 value is `monthly_savings_target`
- `priority`

Required for amount-based goals:

- `target_amount`
- `current_progress`

Required for schedule-based goals:

- `target_date`
- `monthly_contribution` or equivalent scheduled contribution

Optional:

- `category`
- `minimum_required_contribution`
- `confidence`

Rules:

- Goal amounts must be non-negative.
- Goal priority must be deterministic and stable.
- If goal data is incomplete, affordability may still be calculated, but goal
  impact must be marked incomplete or unknown.

### Planned Purchases

Required:

- `purchase_id`
- `amount`
- `currency`
- `planned_date`

Optional:

- `name`
- `category`
- `necessity`
- `deferrable`
- `account_id`
- `confidence`

Rules:

- Purchase amount must be positive.
- `planned_date` is required because timing changes affordability.
- If `planned_date` falls outside the supported forecast horizon, the
  affordability result is `Unknown` for MVP 0 unless a future policy explicitly
  supports longer-range forecasts.
- If `account_id` is provided, it must reference a valid spendable account.

## General Validation Rules

### Monetary Values

- Monetary values must be finite decimal values stored or evaluated in minor
  units or exact decimal form, not binary floating-point approximations.
- Currency must be present on every monetary record.
- MVP 0 does not perform currency conversion. Mixed currencies in one scenario
  force `Unknown` unless all relevant values are already normalized to the same
  currency with an auditable conversion source.
- Amount fields that represent expected cash flows must be positive, with the
  direction carried by the field type. Transaction amounts are the exception and
  use the global sign convention.
- Absurd values should fail validation using a documented policy limit, not
  pass silently.

### Dates And Times

- Dates must be valid ISO 8601 calendar dates.
- Timestamps must include a timezone or be normalized to a declared timezone.
- `balance_as_of` must not be after the evaluation timestamp.
- Posted transaction dates must not be after the evaluation date.
- Future dates are allowed for income, obligations, goals, and planned
  purchases.
- Invalid calendar dates, such as nonexistent leap dates, are validation errors.

### Cadence

Supported MVP 0 cadence values:

- `one_time`
- `weekly`
- `biweekly`
- `semi_monthly`
- `monthly`
- `quarterly`
- `annual`
- `custom`

Rules:

- `cadence` is required for recurring income and obligations.
- `custom` cadence requires enough structured detail to compute the next
  occurrence deterministically.
- If the next occurrence cannot be computed, required income or obligations
  should force `Unknown` when they materially affect the forecast horizon.
- End dates before next dates are validation errors.

### Balances

- Spendable balance is computed from valid spendable accounts only.
- Non-spendable balances may be shown in explanations later but must not
  increase affordability.
- Credit limits and available credit must not be treated as cash in MVP 0.
- If all spendable balances are missing, stale beyond the hard limit, or
  invalid, affordability is `Unknown`.
- If one account is stale but other valid spendable accounts remain, the result
  may proceed only when stale-account exclusion is explicit in the explanation
  and confidence is reduced.

### Accounts

- Duplicate account records must be resolved before calculation.
- Potential duplicates should be detected using stable ids first, then a
  deterministic fingerprint such as institution, mask, account type, currency,
  and normalized name.
- Ambiguous duplicate spendable accounts force `Unknown` because they may double
  count cash.

### Planned Purchases

- A purchase cannot be both a planned purchase and an already-counted recurring
  obligation in the same run.
- If a planned purchase appears to duplicate an existing transaction or bill,
  validation should flag it and require deterministic inclusion or exclusion.
- Necessity and deferrability affect explanation and scenario analysis, not the
  arithmetic of whether cash is available.

## Freshness Policy

MVP 0 should define freshness as policy data, not hidden constants.

Default policy:

- Synced or future Plaid-derived spendable account balances are fresh for 72
  hours.
- Manual or fixture spendable account balances are usable for 7 calendar days
  when `balance_as_of` is explicit; unconfirmed manual balances lower
  confidence.
- Transaction history used for pattern detection is fresh if it covers at least
  the forecast horizon plus a short detection buffer, such as 35 days for a
  30-day horizon.
- Manual recurring income and obligation schedules are fresh until edited,
  unless they have a past due `next_expected_date` or `next_due_date`.
- Planned purchases are fresh for the current run only.

Behavior:

- Stale critical inputs can force `Unknown`.
- Stale supporting inputs can produce a result with reduced confidence and an
  explicit explanation.
- Missing transaction history should not block forecast-only affordability when
  explicit balances, income, and obligation schedules are present.
- Missing transaction history should disable or lower confidence for pattern
  insights that depend on history.
- Missing optional categories should not block affordability, but category-based
  pattern detection should mark the affected insight incomplete.

## Confidence And Uncertainty

Confidence must be deterministic and explainable. It should not be model
confidence or a vague percentage.

Recommended levels:

- `high`: required fields are complete, fresh, internally consistent, and
  deduped.
- `medium`: required fields are valid, but optional supporting data is missing
  or some inputs are approaching staleness.
- `low`: the run depends on stale supporting data, variable income, inferred
  schedules, or incomplete categories.
- `unknown`: critical inputs are missing, stale beyond the hard limit,
  contradictory, duplicated, or unsupported.

Propagation rules:

- Scenario confidence cannot be higher than the lowest confidence among
  critical inputs.
- Forecast confidence cannot be higher than balance confidence.
- Decision confidence cannot be higher than forecast confidence.
- Pattern insight confidence cannot be higher than transaction-history
  confidence or category confidence for category-dependent insights.
- Any unresolved duplicate cash account caps scenario confidence at `unknown`.
- Any inferred recurring obligation should carry the inference confidence into
  the forecast and explanation.

Every affordability answer should expose uncertainty drivers, such as stale
balances, variable income, missing transaction categories, inferred subscriptions,
or excluded accounts.

## Conditions That Force Affordability To Unknown

The affordability result must be `Unknown` when any of these conditions apply:

- Planned purchase amount, currency, or date is missing or invalid.
- Planned purchase currency differs from the scenario currency without an
  auditable normalized value.
- Planned purchase date is outside the supported MVP 0 forecast horizon.
- No valid spendable account balance is available.
- All spendable account balances are stale beyond the hard freshness limit.
- A required obligation inside the forecast horizon has missing amount, currency,
  cadence, or next due date.
- Required obligation coverage is not declared complete through the forecast
  horizon, unless the run is explicitly marked as a partial what-if.
- A required income item needed to keep the forecast non-negative has missing
  amount, currency, cadence, or next expected date.
- Cadence cannot be evaluated deterministically.
- Duplicate spendable accounts are unresolved.
- Duplicate transactions or a pending/posted pair would materially affect the
  cash forecast and cannot be resolved.
- Required records use mixed currencies without normalized values.
- Validation finds contradictory data, such as an end date before a next due
  date.
- Evaluation date or timezone is invalid.
- The scenario uses unsupported account types as spendable cash.
- The combined validation issue severity crosses a documented policy threshold.

`Unknown` must include the specific blocking reasons and the minimum data needed
to produce a deterministic answer.

## Double Counting And Duplicate Protection

Duplicate protection must run before forecasting and pattern detection.

Accounts:

- Prefer stable `account_id` matches.
- Use deterministic account fingerprints when stable ids are absent.
- Never add balances from ambiguous duplicate spendable accounts.

Transactions:

- Prefer `source_transaction_id` when present.
- Otherwise use a deterministic fingerprint: account id, posted date, amount,
  normalized merchant or description, currency, and pending status.
- Pending transactions should be replaced by matching posted transactions.
- Exact duplicates should be collapsed once and reported as `deduped`.
- Ambiguous duplicates that change forecast cash materially should force
  `Unknown`.

Transfers:

- Detect likely transfers using opposite signs, similar dates, equal or nearly
  equal amounts, and account ownership.
- Exclude confirmed transfers from spending and income pattern calculations.
- Keep transfer effects in account-level balance reconciliation when needed.

Recurring obligations:

- If an explicit obligation and an inferred recurring transaction represent the
  same future payment, count one future obligation.
- Explicit user-provided schedules are authoritative over inferred schedules
  unless validation marks them stale or contradictory.
- Historical transactions can support inference but must not be counted again as
  future obligations.

Planned purchases:

- If a planned purchase matches an already-scheduled obligation or posted
  transaction, validation must mark whether it is included or excluded.
- A purchase must never reduce projected cash twice.

## Read-Only And Non-Advice Safeguards

MVP 0 backend behavior must enforce these boundaries:

- No write operations to financial institutions or accounts.
- No payment initiation.
- No asset trades or asset allocation recommendations.
- No tax, legal, fiduciary, or personalized investment advice.
- No language in generated explanations that says the product authorizes,
  instructs, or guarantees a spending decision.

Affordability results should be decision-supportive labels, not commands. For
example, the backend can produce:

- `Affordable`: projected cash remains above required obligations and buffer
  under current assumptions.
- `Tight`: projected cash remains non-negative but approaches the buffer or
  delays goals.
- `Risky`: projected cash may fall below buffer, required obligations, or goal
  minimums.
- `Unknown`: critical data is missing, stale, contradictory, or unsupported.

Explanations should use neutral language about tradeoffs, timing, assumptions,
and potential savings impact.

## Deterministic Auditability And Explanation Requirements

Every run should be reproducible from its inputs, policy, and engine version.

Required audit fields:

- run id,
- evaluation timestamp and timezone,
- engine version,
- validation policy version,
- freshness policy version,
- forecast horizon,
- scenario currency,
- input entity ids and content hashes,
- normalized input snapshot,
- validation issues,
- dedupe decisions,
- included and excluded accounts,
- included and excluded obligations,
- confidence levels and uncertainty drivers,
- calculation trace for projected balances,
- final affordability result,
- ordered reason codes.

Explanation requirements:

- Reasons must be generated from deterministic reason codes.
- Reason ordering must be stable.
- Explanations must identify assumptions, stale inputs, missing inputs, and
  excluded data.
- `Unknown` explanations must identify blocking data issues and not imply a
  hidden answer.
- Forecast and decision outputs must be testable without AI.
- Any later AI layer must explain deterministic facts rather than recalculate or
  override affordability.

## Test Cases For Invalid Or Incomplete Inputs

Validation tests:

- Reject a planned purchase with zero, negative, non-finite, or missing amount.
- Reject records with missing currency.
- Return `Unknown` for mixed currencies without normalized values.
- Reject invalid calendar dates and future posted transaction dates.
- Reject unsupported cadence values.
- Return `Unknown` when a required obligation has no amount or next due date.
- Return `Unknown` when required-obligation coverage is incomplete through the
  forecast horizon.
- Return `Unknown` when no valid spendable account exists.
- Return `Unknown` when all spendable balances are stale beyond policy.
- Lower confidence when one non-critical account is stale and excluded.
- Treat missing optional categories as incomplete, not invalid.
- Treat missing transaction history as pattern-insight incomplete, not forecast
  invalid, when explicit schedules exist.

Duplicate and double-counting tests:

- Collapse exact duplicate transactions.
- Replace a pending transaction with the matching posted transaction.
- Detect ambiguous duplicate spendable accounts and return `Unknown`.
- Exclude confirmed transfers from spending and income totals.
- Avoid counting both an explicit monthly subscription obligation and the same
  inferred recurring transaction.
- Avoid counting a planned purchase twice when it matches a scheduled
  obligation.

Uncertainty and decision tests:

- Cap decision confidence at balance confidence.
- Cap pattern confidence at transaction-history confidence.
- Return `Unknown` when required income needed for affordability has invalid
  cadence.
- Return `Unknown` for planned purchases outside the MVP 0 horizon.
- Produce stable reason-code ordering for the same input.
- Produce identical output for repeated runs with identical input and policy.
- Include stale and missing data reasons in the audit trace.

Safeguard tests:

- Verify affordability output never initiates or suggests account writes.
- Verify output never treats credit capacity as spendable cash.
- Verify explanations do not provide investment, tax, legal, or fiduciary
  advice.
- Verify `Unknown` responses explain the data gap instead of fabricating an
  affordability answer.
