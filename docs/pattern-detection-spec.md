# MVP 0 Pattern Detection Specification

Status: Draft for pattern detection; `S-004` normalization assumptions and `S-005` recurring-subscription / duplicate-service rules implemented in `packages/core`  
Last updated: 2026-08-04

## Purpose

This specification defines deterministic, explainable MVP 0 rules for detecting spending patterns across multiple manually entered or fixture accounts. It supports the product charter requirement to find cross-account patterns before live Plaid integration or AI chat.

The detector must be read-only. It must not move money, initiate account changes, or provide investment, tax, legal, fiduciary, or debt-settlement advice.

## MVP 0 User Assumption

MVP 0 targets one individual salaried user who is paid bi-weekly. Pattern detection still runs across multiple manually entered or fixture accounts, but those accounts should be treated as accounts for the same individual unless a fixture explicitly marks otherwise.

Income support must include a `biweekly` cadence. Spending patterns, savings impact, and goal conflicts are summarized monthly because most bills and budget goals are monthly. These pattern windows do not select the overall affordability forecast horizon.

## Scope

In scope:

- Likely subscriptions.
- Rising categories.
- Possible duplicate services.
- Frequent small purchases.
- Behaviors that conflict with user goals.
- Potential savings or budget impact estimates.
- Confidence, assumptions, uncertainty, and false-positive safeguards for each insight.
- Fixture-ready expected outcomes for deterministic tests.

Out of scope:

- UI design.
- Overall application stack selection.
- Plaid-specific enrichment, token handling, or sync behavior.
- Machine-learning classification.
- Personalized advice that instructs the user to cancel, buy, invest, refinance, or otherwise make a regulated financial decision.

## Input Contract

The detector runs for one individual MVP 0 user at a time. MVP 0 input may come from manual entry or deterministic fixtures.

Required transaction fields:

| Field | Requirement |
| --- | --- |
| `transaction_id` | Optional but preferred. If absent, use deterministic record deduplication. |
| `account_id` | Required. Used for cross-account evidence and same-account duplicate safeguards. |
| `posted_date` | Required ISO date. Use posted date, not entered date, for windows. |
| `merchant_raw` | Required for merchant-based rules unless the transaction is category-only. |
| `amount` | Required decimal. Normalize expenses as positive outflows. |
| `direction` | Required when source amounts can be signed. Values: `outflow`, `inflow`, `refund`, `transfer`. |
| `category_raw` | Optional but strongly preferred. Unknown categories are allowed with confidence caps. |
| `is_pending` | Optional. Pending transactions are excluded by default. |
| `tags` | Optional. Supported tags include `one_time`, `planned_purchase`, `required`, `reimbursable`, `shared_household`, `ignore_for_patterns`, and `optional_service`. |

Required account fields:

| Field | Requirement |
| --- | --- |
| `account_id` | Required. |
| `name` | Required for explanations. |
| `currency` | Required. MVP 0 only aggregates accounts with the same currency. |
| `active` | Required boolean. Inactive accounts are excluded unless a fixture explicitly includes them. |
| `freshness_date` | Optional. Used for stale-data uncertainty. |

Goal fields used by the goal-conflict detector:

| Field | Requirement |
| --- | --- |
| `goal_id` | Required. |
| `name` | Required for explanations. |
| `priority` | Required integer from 1 to 5, where 1 is highest. |
| `goal_type` | Required. First supported MVP 0 value: `monthly_savings_target`. `target_amount_by_date`, `category_spend_limit`, `debt_paydown_target`, and `custom_watch_rule` remain future candidates until explicitly implemented. |
| `target_amount` | Required for amount-based goals. |
| `target_date` | Required for dated goals. |
| `monthly_target_amount` | Required for monthly goals. |
| `monitored_categories` | Required for category limit and custom watch goals. |
| `excluded_categories` | Optional. |
| `current_progress_amount` | Optional. |

Income context used by the detector:

| Field | Requirement |
| --- | --- |
| `income_id` | Optional. Required only when multiple income sources exist in a fixture. |
| `amount` | Optional for pattern detection. Prefer net take-home amount per paycheck when available. |
| `cadence` | Optional for pattern detection, but MVP 0 must support `biweekly`. Other supported values: `weekly`, `semimonthly`, `monthly`, `annual`, `irregular`. |
| `next_expected_date` | Optional. Reserved for forecast and cash-flow rules; pattern detection must not use it to choose a forecast horizon. |
| `reliability` | Optional. Values: `reliable`, `variable`, `unknown`. Use income-derived small-purchase thresholds only when reliable. |

For monthly pattern calculations, convert reliable income to `monthly_income_equivalent`:

- Weekly: `amount * 52 / 12`.
- Bi-weekly: `amount * 26 / 12`.
- Semi-monthly: `amount * 2`.
- Monthly: `amount`.
- Annual: `amount / 12`.
- Irregular or unknown: do not derive a monthly threshold.

## Normalization Assumptions

### Account And Currency Normalization

- Aggregate active accounts for the same individual user when `currency` matches.
- Do not aggregate across currencies in MVP 0. Return a `currency_mismatch` uncertainty flag instead.
- Exclude inactive accounts unless the fixture explicitly marks them as included.
- Exclude transactions from accounts tagged `closed_duplicate_account`.

### Amount Normalization

- Store normalized expenses as positive values in `normalized_amount`.
- Store refunds, credits, income, and transfers separately and exclude them from expense-pattern rules.
- Match stable amounts using this tolerance: `max(2.00, median_amount * 0.10)`.
- If a refund clearly reverses a prior outflow from the same merchant, subtract it from savings-impact estimates and exclude the reversed transaction from frequency counts.

### Date Normalization

- Use `posted_date` in the user's local calendar.
- Default `analysis_date` to the latest posted transaction date in the analyzed data unless the caller provides an explicit `as_of` date.
- Calendar months are based on local dates.
- Pending transactions are excluded unless a fixture sets `include_pending=true`.

### Merchant Normalization

Build `merchant_canonical` with deterministic text normalization:

1. Uppercase.
2. Trim leading and trailing whitespace.
3. Collapse repeated whitespace.
4. Remove punctuation that does not distinguish the merchant.
5. Remove common card descriptors and network prefixes such as `POS`, `DEBIT`, `ACH`, `CARD`, `TST*`, `SQ *`, and `CHECKCARD`.
6. Remove location suffixes, store numbers, dates, terminal IDs, and city-state suffixes when they follow the merchant name.
7. Remove legal suffixes such as `LLC`, `INC`, `CO`, and `LTD`.
8. Apply a maintained alias map for known processors and merchants, such as `NETFLIX.COM` to `NETFLIX`, `SPOTIFY USA` to `SPOTIFY`, and `APPLE.COM/BILL` to `APPLE APP STORE`.

If the source merchant is a payment processor such as PayPal, Apple, Google, Stripe, Square, or an app store and the underlying merchant cannot be parsed, keep the processor as `merchant_canonical` and set `merchant_ambiguity=true`.

Implementation note: `S-004` converts these assumptions into `packages/core/src/domain/normalization.ts`. CSV import and the existing Plaid Sandbox mapper both call the shared normalizer. Known service aliases normalize deterministically, while processor/app-store rows without a parseable underlying merchant carry `merchantAmbiguity` and `normalizationUncertaintyCodes`.

### Category Normalization

- Map `category_raw` into a stable MVP 0 category taxonomy before running rules.
- Minimum categories: `housing`, `utilities`, `insurance`, `transportation`, `groceries`, `dining`, `coffee_snacks`, `entertainment`, `streaming`, `music_audio`, `software`, `cloud_storage`, `fitness`, `shopping`, `travel`, `medical`, `education`, `childcare`, `debt_payment`, `savings_transfer`, `income`, `transfer`, `fees`, `cash`, `unknown`.
- Mark categories as `required_default=true` for `housing`, `utilities`, `insurance`, `medical`, `childcare`, `debt_payment`, and `savings_transfer`.
- User or fixture tags override category defaults. For example, a `required` coffee transaction is not treated as discretionary.

Implementation note: `S-004` implements the minimum taxonomy above and adds `credit_card_payment` as a transfer-like category required by the money-flow contract. Category totals now carry backend-owned `displayName` and `requiredDefault` fields for UI consumption. `S-005` uses these normalized category defaults when excluding required bills from subscription-service detection.

### Record Deduplication

Before pattern detection, remove likely duplicate records caused by import or manual-entry duplication.

Two records are likely duplicate records only when all conditions are true:

- Same `account_id`.
- Same `merchant_canonical`.
- Amount difference is at most `0.01`.
- Posted dates are within 1 day.
- Neither record has a distinct source `transaction_id`.

Do not deduplicate similar transactions across different accounts. Cross-account similarity is evidence for pattern detection.

## Analysis Windows

Pattern analysis windows define historical evidence for monthly spending summaries. They are independent from the overall affordability forecast horizon, which remains a separate forecast-engine decision.

Default windows:

| Window | Definition |
| --- | --- |
| `lookback_window` | 180 days ending on `analysis_date`. |
| `recent_window` | 30 days ending on `analysis_date`. |
| `baseline_window` | 90 days before `recent_window`. |
| `subscription_recent_grace` | Last expected charge date plus 15 days. |

Minimum coverage:

- Subscriptions require at least 60 days of data unless detecting weekly cadence.
- Rising categories require at least 90 days of baseline data and 21 days of recent data.
- Frequent small purchases require at least 30 days of recent data.
- Duplicate services require active likely subscriptions or recurring charges.
- Goal conflicts require at least one active goal.

When coverage is below the minimum, return no high-confidence insight. The detector may return an `insufficient_data` uncertainty record for diagnostics.

## Confidence Model

Confidence is an integer from 0 to 100.

Bands:

| Band | Meaning |
| --- | --- |
| 0-39 | Do not show as a user-facing insight in MVP 0. Keep for diagnostics. |
| 40-59 | Low confidence. Show only in developer/test output or behind an "uncertain" state. |
| 60-79 | Medium confidence. Can be shown with explicit uncertainty language. |
| 80-100 | High confidence. Can be shown as a likely pattern while still avoiding certainty. |

Every rule produces:

- `confidence_score`.
- `confidence_band`.
- `confidence_factors`, listing positive and negative factors.
- `confidence_caps_applied`, if any.

Global caps:

- Cap at 55 when merchant is unknown.
- Cap at 60 when category is unknown and the rule depends on category.
- Cap at 65 when data coverage is below the preferred window but above the minimum.
- Cap at 70 when all evidence comes from an ambiguous processor.
- Cap at 75 when accounts have freshness dates older than 14 days.
- Cap at 80 when the result depends on fewer than 3 transactions, except exact duplicate-service matches.

## Insight Output Contract

Each detected insight must use the same shape:

| Field | Requirement |
| --- | --- |
| `insight_id` | Deterministic stable ID from type, entity key, window, and analysis date. |
| `insight_type` | One of `likely_subscription`, `rising_category`, `possible_duplicate_service`, `frequent_small_purchases`, `goal_conflict`. |
| `entities` | Merchants, categories, accounts, or goals involved. |
| `window` | Date range used for evidence. |
| `evidence` | Counts, amounts, cadence, categories, and account IDs needed to explain the result. |
| `confidence_score` | Integer 0-100. |
| `confidence_band` | Derived band. |
| `savings_impact` | Conservative low/high monthly estimate, plus annualized estimate when appropriate. |
| `assumptions` | Normalization, exclusions, and data coverage assumptions. |
| `uncertainties` | Missing, stale, ambiguous, or sparse-data notes. |
| `explanation` | Neutral user-facing explanation. |
| `debug_trace` | Deterministic rule names and threshold comparisons for tests. |

## Rule 1: Likely Subscriptions

### Candidate Definition

A likely subscription candidate is a recurring outflow from the same `merchant_canonical` with stable amount and cadence.

Supported cadences:

| Cadence | Evidence Required |
| --- | --- |
| Weekly | At least 4 charges with median interval 6-8 days. |
| Bi-weekly | At least 4 charges with median interval 13-16 days. |
| Monthly | At least 3 charges with median interval 25-35 days. |
| Quarterly | At least 3 charges with median interval 80-100 days. |
| Annual | At least 2 charges with interval 330-400 days. Requires data beyond the default 180-day window or explicit fixture history. |

Two-charge monthly detection is allowed only when both conditions are true:

- Interval is 25-35 days.
- Merchant or category has a subscription signal, such as streaming, music, software, cloud storage, fitness membership, news, app store, or known subscription alias.

Two-charge monthly detections are capped at 65 confidence.

### Exclusions

Do not classify these as likely subscriptions:

- Income, transfers, refunds, and credits.
- Rent, mortgage, utilities, insurance, taxes, loan payments, and debt payments.
- Transactions tagged `one_time`, `planned_purchase`, `reimbursable`, or `ignore_for_patterns`.
- Installment plans when merchant or category indicates buy-now-pay-later, loan, financing, or debt service.
- Inactive recurring charges where the last charge is older than `expected_next_charge_date + 15 days`.

Required bills may be detected by a separate recurring-obligation engine, but not as subscriptions in MVP 0.

### Scoring

Start at 0 and add:

| Factor | Points |
| --- | --- |
| Cadence matches a supported interval | 35 |
| Occurrence count exceeds the minimum by 1 or more | 10 |
| Occurrence count meets the minimum exactly | 5 |
| Amounts stay within tolerance | 20 |
| Merchant or category has a subscription signal | 15 |
| Last charge is within the active grace window | 10 |
| Seen across multiple accounts with the same merchant and cadence | 5 |
| User or fixture tag says optional service | 5 |

Apply global caps after scoring.

### Savings Impact

Calculate estimated monthly cost:

- Weekly: `median_amount * 52 / 12`.
- Bi-weekly: `median_amount * 26 / 12`.
- Monthly: `median_amount`.
- Quarterly: `median_amount / 3`.
- Annual: `median_amount / 12`.

For active subscriptions:

- `monthly_low = 0`.
- `monthly_high = estimated_monthly_cost`.
- `annual_high = estimated_monthly_cost * 12`.

If active status is uncertain, cap `monthly_high` at the last observed charge amount divided by the cadence period and add `active_status_uncertain`.

### Explanation Requirements

Use neutral phrasing:

- "Looks like a recurring service from Netflix at about $15.49 per month."
- "Reviewing it could affect recurring spending by up to about $15.49 per month."

Avoid:

- "You are wasting money."
- "Cancel this."
- "Bad spending habit."

## Rule 2: Rising Categories

### Candidate Definition

Compare recent spend to the baseline monthly average for each normalized category.

Definitions:

- `recent_spend = sum(category outflows in recent_window)`.
- `baseline_monthly_average = sum(category outflows in baseline_window) / 3`.
- `absolute_increase = recent_spend - baseline_monthly_average`.
- `relative_increase = recent_spend / baseline_monthly_average` when baseline is greater than 0.

A category is rising when all conditions are true:

- `recent_spend >= 50`.
- `absolute_increase >= 25`.
- `relative_increase >= 1.25`, or baseline is 0 and recent spend is at least 75.
- At least 3 recent transactions, unless a fixture explicitly tests a large non-recurring category.

High-magnitude rising category:

- `absolute_increase >= 100`, or
- `relative_increase >= 1.50` and `absolute_increase >= 50`.

### Exclusions And Caps

- Exclude income, transfers, refunds, cash movement, savings transfers, and debt payments.
- Exclude transactions tagged `one_time`, `planned_purchase`, `reimbursable`, or `ignore_for_patterns`.
- Cap at 60 when baseline spend is less than 20 and recent spend is less than 100.
- Cap at 65 when fewer than 3 recent transactions drive the increase.
- Cap at 70 for seasonally variable categories such as travel, education, medical, and gifts unless the fixture or user tags them as discretionary watch categories.
- Do not generate a rising-category insight from a single large transaction tagged `one_time` or `planned_purchase`.

### Scoring

Start at 0 and add:

| Factor | Points |
| --- | --- |
| Baseline coverage is at least 90 days | 20 |
| Recent coverage is at least 21 days | 10 |
| Absolute increase threshold met | 15 |
| Relative increase threshold met | 15 |
| High-magnitude threshold met | 15 |
| At least 3 recent transactions | 15 |
| Category has stable mapping and is not unknown | 10 |

Apply exclusions and global caps after scoring.

### Savings Impact

Rising categories estimate monthly budget impact, not assumed savings.

- `monthly_low = 0`.
- `monthly_high = max(0, recent_spend - baseline_monthly_average)` for discretionary categories.
- For required-default categories, set `monthly_high = 0` and report `budget_impact = absolute_increase`.

Annualized estimates are not shown by default because one month of increase may not persist. Keep `annualized_if_persistent = monthly_high * 12` in debug output only.

### Explanation Requirements

Use neutral phrasing:

- "Dining is up about $130 compared with your recent baseline."
- "If this is temporary, no action may be needed. If it continues, it could affect monthly cash flow by about $130."

Avoid claiming the increase is a problem without a linked goal, low buffer, or explicit user concern.

## Rule 3: Possible Duplicate Services

### Candidate Definition

Possible duplicate services are active recurring services that appear to cover a similar use case.

Inputs:

- Active likely subscriptions from Rule 1.
- A deterministic `service_group` map from merchant and category.

Minimum service groups for MVP 0:

| Service Group | Example Merchants |
| --- | --- |
| `streaming_video` | Netflix, Hulu, Max, Disney Plus, Peacock, Paramount Plus, Apple TV Plus. |
| `music_audio` | Spotify, Apple Music, YouTube Music, Audible. |
| `cloud_storage` | iCloud, Google One, Dropbox, OneDrive. |
| `software_productivity` | Microsoft 365, Google Workspace, Notion, Todoist, Adobe. |
| `fitness` | Planet Fitness, LA Fitness, Peloton, Apple Fitness. |
| `meal_delivery_membership` | DoorDash DashPass, Uber One, Instacart Plus, Grubhub Plus. |
| `news_media` | New York Times, Washington Post, Wall Street Journal, The Athletic. |

Detect a possible duplicate service when either condition is true:

- Two or more active likely subscriptions have the same `service_group`.
- The same `merchant_canonical` is charged as an active likely subscription on two or more accounts with overlapping cadence windows.

### Exclusions And Caps

- Do not compare services across unrelated `service_group` values.
- Do not flag required utilities, insurance, housing, debt, or taxes.
- Do not flag a known bundle and its included sub-service when the alias map identifies the bundle relationship.
- Cap at 65 when both services are from ambiguous processors.
- Cap at 70 when a `shared_household` tag is present, because multiple subscriptions may be intentional.
- Cap at 75 when service groups are category-derived without merchant taxonomy support.

### Scoring

Start at 0 and add:

| Factor | Points |
| --- | --- |
| At least 2 active likely subscriptions | 25 |
| Same exact merchant across multiple accounts | 25 |
| Same service group with distinct merchants | 20 |
| Cadence windows overlap | 15 |
| Combined monthly cost is at least 25 | 10 |
| Same individual account owner fixture | 5 |

For exact same merchant across accounts, allow a maximum of 95 before global caps. For same service group but distinct merchants, allow a maximum of 85 before global caps.

### Savings Impact

Estimate potential reviewable monthly spend:

- Exact same merchant across accounts: `monthly_high = lowest estimated monthly cost among duplicates`.
- Same service group, distinct merchants: `monthly_high = lowest estimated monthly cost in the group`.
- `monthly_low = 0`.

Do not say the user should remove one. The explanation should say these services may be intentionally different.

Implementation note: `S-005` implements Rule 1 and Rule 3 in `packages/core/src/domain/pattern-detection.ts`, exported as `detectRecurringSpending`. The first implementation is backend/domain only: it does not add a Fastify endpoint, does not change `apps/web`, and does not implement `S-006` rising categories, frequent small purchases, goal conflicts, AI explanation, Plaid, or UI integration.

### Explanation Requirements

Use neutral phrasing:

- "You have multiple active streaming services: Netflix, Hulu, and Max."
- "The lowest monthly cost in this group is about $15.49, which is the reviewable impact if one service is no longer useful."

Avoid:

- "Duplicate waste."
- "You do not need both."

## Rule 4: Frequent Small Purchases

### Candidate Definition

Small purchases are outflows with `normalized_amount` between 1 and the active small-purchase threshold.

Default threshold:

- `small_purchase_threshold = 15`.

If reliable income is available, convert it to `monthly_income_equivalent` first and use:

- `small_purchase_threshold = min(20, max(8, monthly_income_equivalent * 0.003))`.

The default threshold is used when income is missing or variable.

Merchant-level insight:

- Same `merchant_canonical`.
- At least 5 small purchases in `recent_window`.
- Total recent small-purchase spend at that merchant is at least 25.

Category-level insight:

- Same normalized category.
- At least 8 small purchases in `recent_window`.
- At least 3 merchants.
- Total recent small-purchase spend in that category is at least 50.

Micro-purchase insight:

- At least 10 purchases below 5 in `recent_window`.
- Total recent micro-purchase spend is at least 20.

When merchant-level and category-level insights overlap, return the more specific merchant-level insight first and include the overlap in `debug_trace`.

### Exclusions And Caps

- Exclude transfers, fees, cash withdrawals, debt payments, savings transfers, refunds, and income.
- Exclude transactions tagged `required`, `reimbursable`, `one_time`, `planned_purchase`, or `ignore_for_patterns`.
- Cap at 60 when category is unknown.
- Cap at 65 when the category is transportation and tags indicate commuting or required travel.
- Do not show an insight when the relevant small-purchase spend is below 25.
- Do not imply that small purchases are harmful. Only describe frequency and cash-flow impact.

### Scoring

Start at 0 and add:

| Factor | Points |
| --- | --- |
| Count threshold met | 25 |
| Spend threshold met | 20 |
| Count exceeds threshold by at least 50 percent | 15 |
| Total spend exceeds threshold by at least 50 percent | 15 |
| Merchant/category is discretionary by taxonomy or tag | 15 |
| Pattern appears on multiple weeks within the window | 10 |

Apply exclusions and global caps after scoring.

### Savings Impact

Estimate the amount associated with reducing frequency to the alert threshold, without assuming elimination.

Merchant-level:

- `monthly_high = max(0, count - 4) * median_amount`.

Category-level:

- `monthly_high = max(0, count - 7) * median_amount`.

Micro-purchase:

- `monthly_high = max(0, count - 9) * median_amount`.

For all:

- `monthly_low = 0`.
- `reviewable_monthly_total = total_recent_spend`.

### Explanation Requirements

Use neutral phrasing:

- "Coffee purchases appeared 12 times in the last 30 days, totaling about $72."
- "Reducing the frequency to four times per month would change spending by about $48 based on the median purchase."

Avoid:

- "Too many coffees."
- "Stop buying snacks."

## Rule 5: Goal Conflicts

### Candidate Definition

Goal conflicts connect observed spending behavior to explicit user goals. The detector must not infer personal values or judge spending without a goal.

Goal conflict support starts with `monthly_savings_target`, where the practical intent is reducing discretionary spending to save more. Other rows are retained as future deterministic rule candidates, not implemented MVP 0 commitments.

| Goal Type | Conflict Rule |
| --- | --- |
| `category_spend_limit` | Recent or projected month spend in monitored categories exceeds the goal limit. |
| `monthly_savings_target` | Current month savings contributions are behind the pro-rated monthly target and discretionary reviewable spend could cover at least part of the gap. |
| `target_amount_by_date` | Required monthly contribution to reach the target exceeds observed or planned contributions, and discretionary reviewable spend could cover at least part of the gap. |
| `debt_paydown_target` | Planned debt-paydown contribution is behind target and discretionary reviewable spend could cover at least part of the gap. |
| `custom_watch_rule` | Spending appears in merchant or category watch lists defined by the user or fixture. |

### Calculations

For category limits:

- `elapsed_days = day_of_month(analysis_date)`.
- `days_in_month = calendar days in analysis_date month`.
- `month_to_date_spend = spend in monitored categories from first day of month through analysis_date`.
- If `elapsed_days >= 7`, `projected_month_spend = month_to_date_spend / elapsed_days * days_in_month`.
- If `elapsed_days < 7`, use actual spend only and cap confidence at 60.

A category-limit conflict is detected when:

- `month_to_date_spend > monthly_target_amount`, or
- `projected_month_spend > monthly_target_amount + max(25, monthly_target_amount * 0.10)`.

For monthly savings and dated targets:

- `expected_contribution_to_date = monthly_target_amount * elapsed_days / days_in_month`.
- `observed_contributions` includes outflows tagged `savings_transfer` or matching configured goal account/category.
- `contribution_gap = max(0, expected_contribution_to_date - observed_contributions)`.

A contribution conflict is detected when:

- `contribution_gap >= max(25, monthly_target_amount * 0.10)`, and
- active discretionary insights from Rules 2, 3, or 4 have combined `monthly_high >= contribution_gap * 0.50`.

For custom watch rules:

- Detect when monitored merchant or category spend exceeds the rule threshold in the configured window.
- If no threshold is configured, require at least 3 transactions and 50 total spend in the recent window.

### Exclusions And Caps

- Do not generate goal conflicts without an explicit goal.
- Do not compare spending to goals marked inactive.
- Do not treat required-default categories as conflicting unless the goal explicitly monitors them.
- Cap at 60 when the goal lacks a target date or target amount needed for the calculation.
- Cap at 65 when spending is projected from fewer than 7 elapsed days.
- Cap at 70 when the conflict depends on discretionary insights with medium or lower confidence.
- Do not use investment, tax, legal, or debt-settlement language.

### Scoring

Start at 0 and add:

| Factor | Points |
| --- | --- |
| Explicit active goal exists | 20 |
| Required goal fields are complete | 15 |
| Threshold exceeded by at least 10 percent | 15 |
| Threshold exceeded by at least 25 percent | 10 |
| Linked transactions have stable category or merchant mapping | 10 |
| Conflict is based on actual spend, not only projected spend | 10 |
| Reviewable discretionary impact covers at least 50 percent of contribution gap | 10 |
| Goal priority is 1 or 2 | 10 |

Apply exclusions and global caps after scoring.

### Savings Impact

Goal conflicts report gap coverage, not advice:

- `goal_gap = amount over category limit or contribution gap`.
- `monthly_low = 0`.
- `monthly_high = min(goal_gap, linked_reviewable_monthly_high)` when linked discretionary insights exist.
- For category limits, `monthly_high = max(0, projected_or_actual_spend - monthly_target_amount)`.

### Explanation Requirements

Use neutral phrasing:

- "Dining is projected about $80 above the monthly limit you set for the travel fund."
- "The linked reviewable spending could cover about $48 of the current savings pace gap if you choose to adjust it."

Avoid:

- "You failed your goal."
- "You cannot afford this."
- "You should pay debt instead."

## False-Positive Safeguards

Apply these safeguards across all rules:

- Prefer no insight over a high-confidence false positive.
- Always exclude transfers, income, refunds, cash movement, and ignored transactions from expense-pattern rules.
- Respect `one_time`, `planned_purchase`, `required`, `reimbursable`, and `ignore_for_patterns` tags.
- Require repeated evidence for recurring or frequency-based insights.
- Cap confidence when merchant, category, account freshness, or data coverage is weak.
- Do not classify required bills as subscriptions.
- Do not classify one large transaction as a rising behavior unless the rule explicitly allows a large non-recurring category diagnostic.
- Do not detect goal conflicts without explicit user goals.
- Keep exact threshold comparisons in `debug_trace` so tests can verify why an insight did or did not appear.

## Uncertainty Behavior

The detector should return structured uncertainty instead of false precision.

Uncertainty codes:

| Code | Meaning | Behavior |
| --- | --- | --- |
| `insufficient_history` | Not enough transactions for the rule window. | Suppress user-facing insight; emit diagnostic uncertainty. |
| `stale_account_data` | Account freshness date is older than 14 days. | Cap confidence at 75 and mention data age. |
| `unknown_merchant` | Merchant cannot be normalized. | Cap confidence at 55. |
| `ambiguous_processor` | Processor is known but underlying merchant is unknown. | Cap confidence at 70 and explain ambiguity. |
| `unknown_category` | Category is missing or unmapped. | Cap category-dependent rules at 60. |
| `currency_mismatch` | Active accounts use different currencies. | Do not aggregate across currencies. |
| `active_status_uncertain` | Recurring pattern may have ended. | Keep insight medium or lower and state last observed date. |
| `goal_definition_incomplete` | Goal lacks fields needed for deterministic comparison. | Suppress high-confidence goal conflict. |

Absence of an insight does not mean the behavior is absent. It means the deterministic rule did not have enough evidence to emit that insight.

## Savings-Impact Estimation Rules

Savings-impact estimates must be conservative and clearly labeled as potential impact.

Rules:

- Always provide `monthly_low = 0`.
- Use `monthly_high` as the maximum observed or formula-derived reviewable amount.
- Include `reviewable_monthly_total` when the insight describes spend that may be partially adjustable.
- Annualize only recurring subscription costs by default.
- Do not annualize rising-category increases in user-facing copy unless there is at least 3 months of sustained increase.
- For goal conflicts, cap potential impact at the goal gap.
- For required-default categories, report `budget_impact` instead of `savings_impact.monthly_high`.
- Round user-facing dollars to the nearest whole dollar unless cents are meaningful for a subscription price.

## Neutral Explanation Requirements

Every user-facing explanation must:

- Name the pattern.
- State the evidence window.
- Include the relevant amount, count, cadence, or comparison.
- State uncertainty when confidence is medium or lower.
- Refer to potential impact as optional and reviewable.
- Avoid shame, blame, or commands.
- Avoid financial-advice language.

Approved language:

- "looks like"
- "may be"
- "reviewable"
- "could affect"
- "compared with your recent baseline"
- "if this is temporary, no action may be needed"
- "based on the transactions available"

Disallowed language:

- "waste"
- "bad"
- "irresponsible"
- "must"
- "should cancel"
- "guaranteed savings"
- "financially wrong"

## Deterministic Ordering

When multiple insights are detected, sort by:

1. Goal conflicts with high confidence.
2. Duplicate services with high confidence.
3. Likely subscriptions with high confidence.
4. Rising categories with high confidence.
5. Frequent small purchases with high confidence.
6. Medium-confidence insights in the same type order.
7. Low-confidence diagnostics, if requested.

Within each type, sort by `savings_impact.monthly_high` descending, then `confidence_score` descending, then deterministic entity key ascending.

## Test Fixtures And Expected Outcomes

Fixtures should use the same normalized input contract and set `analysis_date` explicitly. Unless a fixture says otherwise, assume one individual salaried user with bi-weekly income support and monthly spending summaries.

### F-001: Monthly Subscription Across Manual Account

Setup:

- Account: `checking_manual`, USD, active.
- Transactions: Netflix outflows of 15.49 on 2026-02-05, 2026-03-05, 2026-04-05, 2026-05-05, and 2026-06-05.
- Category: `streaming`.
- Analysis date: 2026-06-30.

Expected:

- Emit `likely_subscription` for Netflix.
- Cadence: monthly.
- Confidence band: high.
- Estimated monthly cost: 15.49.
- `monthly_high`: 15.49.
- No duplicate-service insight unless another active streaming subscription is present.

### F-002: Two-Charge Ambiguous App Store Subscription

Setup:

- Account: `credit_card_manual`, USD, active.
- Transactions: Apple.com/bill outflows of 9.99 on 2026-05-01 and 2026-06-01.
- Category: `software`.
- Analysis date: 2026-06-30.

Expected:

- Emit `likely_subscription` only as medium confidence or lower.
- Apply two-charge cap at 65.
- Include `ambiguous_processor` if the underlying merchant is unknown.
- Explanation must say this may be one app store service or multiple app store charges.

### F-003: Rising Dining Category

Setup:

- Account: `checking_manual`, USD, active.
- Baseline window: dining spend totals 170 in March, 190 in April, and 180 in May.
- Recent window ending 2026-06-30: dining spend totals 310 across 9 transactions.
- Analysis date: 2026-06-30.

Expected:

- Emit `rising_category` for dining.
- Baseline monthly average: 180.
- Recent spend: 310.
- Absolute increase: 130.
- Confidence band: high.
- `monthly_high`: 130.
- Explanation references comparison with recent baseline, not judgment.

### F-004: One-Time Large Purchase Safeguard

Setup:

- Account: `checking_manual`, USD, active.
- Baseline home-maintenance spend: 0.
- Recent transaction: appliance repair outflow of 650 tagged `one_time`.
- Analysis date: 2026-06-30.

Expected:

- Do not emit `rising_category`.
- Do not emit `frequent_small_purchases`.
- Diagnostic trace should show exclusion by `one_time` tag.

### F-005: Multiple Streaming Services

Setup:

- Account: `checking_manual`, USD, active.
- Active monthly subscriptions detected for Netflix at 15.49, Hulu at 17.99, and Max at 19.99.
- All map to `streaming_video`.
- Analysis date: 2026-06-30.

Expected:

- Emit `possible_duplicate_service` for `streaming_video`.
- Confidence band: medium or high depending on subscription confidence inputs.
- `monthly_high`: 15.49, the lowest estimated monthly cost in the group.
- Explanation must state the services may be intentionally different.

### F-006: Same Merchant Charged On Two Accounts

Setup:

- Accounts: `checking_manual` and `credit_card_fixture`, USD, active.
- Audible outflows of 14.95 on both accounts on 2026-04-15, 2026-05-15, and 2026-06-15.
- Category: `music_audio`.
- Analysis date: 2026-06-30.

Expected:

- Emit `likely_subscription` for Audible on each account or one grouped cross-account subscription with account evidence.
- Emit `possible_duplicate_service` for exact same merchant across accounts.
- Confidence band: high.
- `monthly_high`: 14.95.
- Debug trace should show cross-account evidence was not deduplicated.

### F-007: Frequent Coffee Purchases

Setup:

- Account: `checking_manual`, USD, active.
- Twelve coffee shop outflows between 4 and 8 within the recent 30-day window.
- Total: 72.
- Median amount: 6.
- Category: `coffee_snacks`.
- Analysis date: 2026-06-30.

Expected:

- Emit `frequent_small_purchases`.
- Confidence band: high.
- `reviewable_monthly_total`: 72.
- `monthly_high`: `(12 - 4) * 6 = 48`.
- Explanation references frequency and total, not criticism.

### F-008: Required Commute Safeguard

Setup:

- Account: `checking_manual`, USD, active.
- Twenty-two transit outflows of 2.75 in the recent 30-day window.
- Category: `transportation`.
- Tags: `required`.
- Analysis date: 2026-06-30.

Expected:

- Do not emit `frequent_small_purchases`.
- Diagnostic trace should show exclusion by `required` tag.

### F-009: Category Goal Conflict

Setup:

- Goal: "Travel fund dining limit", `category_spend_limit`, monitored category `dining`, monthly target 200, priority 2.
- Account: `checking_manual`, USD, active.
- Month-to-date dining spend on 2026-06-20: 260.
- Analysis date: 2026-06-20.

Expected:

- Emit `goal_conflict`.
- Goal gap: 60 actual over target.
- Confidence band: high if category mapping is stable.
- `monthly_high`: 60.
- Explanation says dining is above the limit the user set.

### F-010: Savings Pace Conflict With Reviewable Spend

Setup:

- Goal: "Emergency fund", `monthly_savings_target`, monthly target 500, priority 1.
- Analysis date: 2026-06-20.
- Expected contribution to date: 333.33.
- Observed savings transfers: 150.
- Linked discretionary insights: coffee `monthly_high` 48, duplicate streaming `monthly_high` 15.49, rising dining `monthly_high` 130.

Expected:

- Contribution gap: 183.33.
- Combined linked reviewable impact: 193.49.
- Emit `goal_conflict`.
- `monthly_high`: 183.33, capped at the goal gap.
- Explanation says reviewable spending could cover part or all of the current savings pace gap if the user chooses to adjust it.

### F-011: Insufficient Data

Setup:

- Account: `checking_manual`, USD, active.
- Only 20 days of transaction history.
- No active goals.
- Analysis date: 2026-06-30.

Expected:

- Do not emit high-confidence subscription, rising-category, duplicate-service, or goal-conflict insights.
- Frequent small purchases may run only if the fixture has a full 30-day recent window; otherwise return `insufficient_history`.
- Diagnostic output includes `insufficient_history`.

### F-012: Bi-Weekly Income Monthly Threshold

Setup:

- User: individual salaried MVP 0 user.
- Income: reliable bi-weekly take-home pay of 2500.
- Account: `checking_manual`, USD, active.
- Recent window ending 2026-06-30 includes six Snack Bar purchases of 17 each and six Snack Bar purchases of 12 each.
- Category: `coffee_snacks`.
- Analysis date: 2026-06-30.

Expected:

- `monthly_income_equivalent`: `2500 * 26 / 12 = 5416.67`.
- `small_purchase_threshold`: `min(20, max(8, 5416.67 * 0.003)) = 16.25`.
- The six 17 purchases do not count as small purchases.
- The six 12 purchases count as small purchases.
- Emit `frequent_small_purchases` for Snack Bar from the six 12 purchases.
- `reviewable_monthly_total`: 72.
- `monthly_high`: `(6 - 4) * 12 = 24`.
- Do not select or imply an affordability forecast horizon from the income cadence.

## Implementation Notes

- Keep rule thresholds in configuration so tests can assert defaults and future versions can tune them by decision.
- Keep merchant aliases, category mappings, service groups, and required-default categories as deterministic data tables.
- Store rule version with each insight, for example `pattern_rules_version = "mvp0-2026-08-04"`.
- Use decimal arithmetic for money.
- Tests should snapshot both insight outputs and `debug_trace` threshold comparisons.
- The first implementation should be a backend/domain module callable without UI dependencies.
