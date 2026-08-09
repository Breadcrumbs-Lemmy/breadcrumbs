# MVP 0 Test Fixtures

Status: Living  
Last updated: 2026-08-04

## Purpose

These fixtures define representative backend scenarios and expected deterministic outcomes for MVP 0. They are written as documentation first, but each scenario should become a JSON fixture and a table-driven test.

The fixtures exercise the core product boundaries:

- Read-only decision support.
- Deterministic forecast and decision logic before AI.
- Clear uncertainty and freshness handling.
- Non-advice result levels: `AFFORDABLE`, `TIGHT`, `RISKY`, and `UNKNOWN`.

## Fixture Defaults

Unless a scenario says otherwise:

- `asOfDate`: `2026-08-03`
- `timezone`: `America/Chicago`
- `currency`: `USD`
- `horizonDays`: `30`
- `minimumCashBufferCents`: `25000`
- `reliableIncomeConfidence`: `0.8`
- Initial target user: individual salaried user
- Default paycheck cadence: bi-weekly
- First supported goal type: `monthly_savings_target`
- Cash buffer visibility: show the `$250` buffer as a read-only MVP 0 assumption; do not add editability in fixtures or UI flows yet
- Spending summary period: calendar month
- Balances, income, and obligations are declared complete through `2026-09-02`
- Manual balances are fresh as of `2026-08-03`
- Amounts in the tables are shown in dollars for readability and cents in expected assertions

Fixture balance traces list the events needed to explain the expected minimum balances. Executable JSON fixtures should still expand every bi-weekly paycheck that falls inside the 30-day horizon.

## Recommended Fixture File Shape

Store one scenario per file, for example `fixtures/mvp0/affordable-steady-paycheck.json`.

```json
{
  "id": "affordable_steady_paycheck",
  "description": "Steady paycheck covers near-term rent, utilities, purchase, and goal contribution.",
  "input": {
    "snapshot": {},
    "plannedPurchaseId": "purchase_laptop_stand"
  },
  "expected": {
    "level": "AFFORDABLE",
    "reasonCodes": ["BUFFER_PASSED", "TIMING_RESERVE_PASSED"],
    "requiredPathMinimumBalanceCents": 80000,
    "protectedPathMinimumBalanceCents": 80000,
    "allEventsPathMinimumBalanceCents": 80000,
    "timingReserveMarginCents": 55000
  }
}
```

Assertions should compare stable identifiers and metrics, not prose. Explanation copy can have separate tone tests later.

## Scenario Index

| ID | Primary behavior | Expected level |
| --- | --- | --- |
| `affordable_steady_paycheck` | Steady paycheck with rent, utilities, purchase, and goal contribution | `AFFORDABLE` |
| `tight_low_buffer` | Required obligations are covered, but cash drops below buffer | `TIGHT` |
| `risky_rent_due_soon` | Purchase creates a rent shortfall before next paycheck | `RISKY` |
| `unknown_stale_balance` | Critical balance data is stale | `UNKNOWN` |
| `variable_income_not_guaranteed` | Expected freelance income is not reliable enough to cover required need | `RISKY` |
| `tight_annual_subscription` | Annual subscription is included and purchase leaves less than buffer before payday | `TIGHT` |
| `tight_multiple_goals` | Purchase conflicts with protected goal contribution and buffer | `TIGHT` |
| `optional_obligation_tradeoff` | Required path passes, optional obligation creates tight all-events path | `TIGHT` |
| `baseline_already_tight` | Baseline forecast was already below buffer before the purchase lowered it further | `TIGHT` |
| `coverage_incomplete` | Known income is needed to avoid shortfall, but income coverage is not confirmed through the horizon | `UNKNOWN` |
| `monthly_savings_discretionary_purchases` | $99 video game, representative $499 console, and $125 restaurant meal evaluated against monthly savings | Mixed: `AFFORDABLE`, `TIGHT`, `RISKY` |
| `monthly_summary_biweekly_pay` | Calendar-month spending aggregation over a bi-weekly pay cycle | Monthly summary expected |
| `where_is_my_money_going_multi_account` | Transaction-first pivot fixture across Chase, Ally, and American Express with transfer-safe spending aggregation | Spending summary expected |

## Fixture 1: Affordable Steady Paycheck

Intent: validates a clean `AFFORDABLE` result when the purchase, near-term obligations, and protected goal all stay above buffer.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$2,500.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$350.00` | Discretionary, deferrable |
| Rent | 2026-08-06 | `-$1,200.00` | Required obligation |
| Utilities | 2026-08-15 | `-$150.00` | Required obligation |
| Paycheck | 2026-08-17 | `+$2,000.00` | Fixed, confirmed, bi-weekly |
| Emergency fund contribution | 2026-08-24 | `-$300.00` | Protected high-priority goal |

Expected assertion:

```json
{
  "level": "AFFORDABLE",
  "reasonCodes": ["BUFFER_PASSED", "TIMING_RESERVE_PASSED"],
  "requiredPathMinimumBalanceCents": 80000,
  "protectedPathMinimumBalanceCents": 80000,
  "allEventsPathMinimumBalanceCents": 80000,
  "minimumBalanceDate": "2026-08-15",
  "postPurchaseCashCents": 215000,
  "timingReserveCents": 135000,
  "timingReserveMarginCents": 55000
}
```

Balance trace:

| Date | Event | Required/protected/all-events balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$2,150.00` |
| 2026-08-06 | Rent | `$950.00` |
| 2026-08-15 | Utilities | `$800.00` |
| 2026-08-17 | Paycheck | `$2,800.00` |
| 2026-08-24 | Goal contribution | `$2,500.00` |

## Fixture 2: Tight Low Buffer

Intent: validates `TIGHT` when required obligations are covered but the purchase leaves less than the configured buffer before the next paycheck.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$950.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$300.00` | Useful, deferrable |
| Rent | 2026-08-05 | `-$500.00` | Required obligation |
| Groceries reserve | 2026-08-07 | `-$100.00` | Required obligation |
| Paycheck | 2026-08-10 | `+$900.00` | Fixed, confirmed, bi-weekly |

Expected assertion:

```json
{
  "level": "TIGHT",
  "reasonCodes": ["BUFFER_BELOW_MINIMUM", "TIMING_RESERVE_LOW"],
  "requiredPathMinimumBalanceCents": 5000,
  "protectedPathMinimumBalanceCents": 5000,
  "allEventsPathMinimumBalanceCents": 5000,
  "minimumBalanceDate": "2026-08-07",
  "postPurchaseCashCents": 65000,
  "timingReserveCents": 60000,
  "timingReserveMarginCents": -20000
}
```

Balance trace:

| Date | Event | Required/protected/all-events balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$650.00` |
| 2026-08-05 | Rent | `$150.00` |
| 2026-08-07 | Groceries reserve | `$50.00` |
| 2026-08-10 | Paycheck | `$950.00` |

## Fixture 3: Risky Rent Due Soon

Intent: validates `RISKY` when the purchase causes a required obligation shortfall before reliable income arrives.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$1,000.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$700.00` | Discretionary, deferrable |
| Rent | 2026-08-04 | `-$600.00` | Required obligation |
| Paycheck | 2026-08-09 | `+$1,500.00` | Fixed, confirmed, bi-weekly |

Expected assertion:

```json
{
  "level": "RISKY",
  "reasonCodes": ["REQUIRED_OBLIGATION_SHORTFALL", "TIMING_RESERVE_SHORTFALL"],
  "requiredPathMinimumBalanceCents": -30000,
  "protectedPathMinimumBalanceCents": -30000,
  "allEventsPathMinimumBalanceCents": -30000,
  "minimumBalanceDate": "2026-08-04",
  "postPurchaseCashCents": 30000,
  "timingReserveCents": 60000,
  "timingReserveMarginCents": -55000
}
```

Balance trace:

| Date | Event | Required/protected/all-events balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$300.00` |
| 2026-08-04 | Rent | `-$300.00` |
| 2026-08-09 | Paycheck | `$1,200.00` |

## Fixture 4: Unknown Stale Balance

Intent: validates `UNKNOWN` when critical balance data is too stale for a deterministic answer.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-07-24 | `$1,500.00` | Manual balance is 10 calendar days old |
| Planned purchase | 2026-08-03 | `-$100.00` | Useful, deferrable |
| Paycheck | 2026-08-10 | `+$900.00` | Fixed, confirmed, bi-weekly |

Expected assertion:

```json
{
  "level": "UNKNOWN",
  "reasonCodes": ["STALE_BALANCE"],
  "freshnessStatus": "stale",
  "criticalFreshnessWarningCount": 1,
  "forecastEvaluated": false
}
```

The engine may return partial diagnostic metrics, but it must not present an affordability result as if the stale balance were precise.

## Fixture 5: Risky Variable Income Not Guaranteed

Intent: validates conservative handling of irregular income. Expected freelance income can appear in an explanatory path, but it cannot rescue the decision when the minimum expected amount is zero.

Executable fixture:

- `packages/core/fixtures/mvp0/variable-income-not-guaranteed.json`

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$700.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$300.00` | Useful, deferrable |
| Freelance invoice | 2026-08-05 | `+$1,000.00` | Variable, confidence `0.45`, minimum expected `$0.00` |
| Utilities | 2026-08-06 | `-$600.00` | Required obligation |

Expected assertion:

```json
{
  "level": "RISKY",
  "reasonCodes": [
    "VARIABLE_INCOME_NOT_GUARANTEED",
    "REQUIRED_OBLIGATION_SHORTFALL",
    "TIMING_RESERVE_SHORTFALL"
  ],
  "requiredPathMinimumBalanceCents": -20000,
  "protectedPathMinimumBalanceCents": -20000,
  "allEventsPathMinimumBalanceCents": -20000,
  "expectedReferencePathMinimumBalanceCents": 40000,
  "minimumBalanceDate": "2026-08-06",
  "postPurchaseCashCents": 40000,
  "timingReserveCents": 60000,
  "timingReserveMarginCents": -45000,
  "targetRelatedEntityIds": ["income_freelance_invoice"]
}
```

Conservative balance trace:

| Date | Event | Required/protected/all-events balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$400.00` |
| 2026-08-05 | Freelance minimum | `$400.00` |
| 2026-08-06 | Utilities | `-$200.00` |

Expected reference path:

| Date | Event | Expected balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$400.00` |
| 2026-08-05 | Freelance expected amount | `$1,400.00` |
| 2026-08-06 | Utilities | `$800.00` |

The expected-reference path minimum is `$400.00` on `2026-08-03`, before the uncertain invoice is counted. That path is explanatory only; it does not rescue the required decision.

## Fixture 6: Tight Annual Subscription

Intent: validates annual obligations inside the 30-day horizon and the low-buffer result after an immediate purchase.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$800.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$600.00` | Discretionary, deferrable |
| Paycheck | 2026-08-18 | `+$1,000.00` | Fixed, confirmed, bi-weekly |
| Annual software subscription | 2026-08-23 | `-$300.00` | Required annual obligation |

Expected assertion:

```json
{
  "level": "TIGHT",
  "reasonCodes": ["BUFFER_BELOW_MINIMUM"],
  "requiredPathMinimumBalanceCents": 20000,
  "protectedPathMinimumBalanceCents": 20000,
  "allEventsPathMinimumBalanceCents": 20000,
  "minimumBalanceDate": "2026-08-03",
  "postPurchaseCashCents": 20000,
  "timingReserveCents": 0,
  "timingReserveMarginCents": -5000
}
```

Balance trace:

| Date | Event | Required/protected/all-events balance |
| --- | --- | ---: |
| 2026-08-03 | Purchase | `$200.00` |
| 2026-08-18 | Paycheck | `$1,200.00` |
| 2026-08-23 | Annual subscription | `$900.00` |

## Fixture 7: Tight Multiple Goals

Intent: validates goal conflict behavior. Required obligations are covered, but the purchase causes a protected high-priority goal contribution to push cash below buffer.

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$1,300.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$500.00` | Useful, deferrable |
| Emergency fund contribution | 2026-08-08 | `-$400.00` | Protected high-priority goal |
| Rent | 2026-08-09 | `-$300.00` | Required obligation |
| Paycheck | 2026-08-15 | `+$700.00` | Fixed, confirmed, bi-weekly |

Expected assertion:

```json
{
  "level": "TIGHT",
  "reasonCodes": ["GOAL_BUFFER_CONFLICT", "BUFFER_BELOW_MINIMUM"],
  "requiredPathMinimumBalanceCents": 50000,
  "protectedPathMinimumBalanceCents": 10000,
  "allEventsPathMinimumBalanceCents": 10000,
  "baselineProtectedPathMinimumBalanceCents": 60000,
  "minimumBalanceDate": "2026-08-09",
  "postPurchaseCashCents": 80000,
  "timingReserveCents": 30000,
  "timingReserveMarginCents": 25000
}
```

Scenario balance trace:

| Date | Event | Required path | Protected/all-events path |
| --- | --- | ---: | ---: |
| 2026-08-03 | Purchase | `$800.00` | `$800.00` |
| 2026-08-08 | Goal contribution | `$800.00` | `$400.00` |
| 2026-08-09 | Rent | `$500.00` | `$100.00` |
| 2026-08-15 | Paycheck | `$1,200.00` | `$800.00` |

## Fixture 8: Tight Optional Tradeoff

Intent: validates that optional obligations do not create required solvency failure, but they can make the all-events path tight.

Executable fixture:

- `packages/core/fixtures/mvp0/optional-obligation-tradeoff.json`

Inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$950.00` | Spendable cash |
| Planned purchase | 2026-08-03 | `-$400.00` | Useful, deferrable |
| Utilities | 2026-08-05 | `-$300.00` | Required obligation |
| Streaming bundle | 2026-08-06 | `-$100.00` | Optional obligation |
| Paycheck | 2026-08-12 | `+$800.00` | Fixed, confirmed, bi-weekly |

Expected assertion:

```json
{
  "level": "TIGHT",
  "reasonCodes": ["OPTIONAL_OBLIGATION_TRADEOFF", "BUFFER_BELOW_MINIMUM"],
  "requiredPathMinimumBalanceCents": 25000,
  "protectedPathMinimumBalanceCents": 25000,
  "allEventsPathMinimumBalanceCents": 15000,
  "minimumBalanceDate": "2026-08-06",
  "postPurchaseCashCents": 55000,
  "timingReserveCents": 30000,
  "timingReserveMarginCents": 0,
  "targetRelatedEntityIds": ["obligation_streaming_bundle"]
}
```

Balance trace:

| Date | Event | Required/protected path | All-events path |
| --- | --- | ---: | ---: |
| 2026-08-03 | Purchase | `$550.00` | `$550.00` |
| 2026-08-05 | Utilities | `$250.00` | `$250.00` |
| 2026-08-06 | Optional streaming bundle | `$250.00` | `$150.00` |
| 2026-08-12 | Paycheck | `$1,050.00` | `$950.00` |

## Fixture 9: Monthly Summary Bi-Weekly Pay

Intent: validates that spending is summarized by calendar month while income can arrive on a bi-weekly cadence. This fixture tests reporting aggregation, not affordability level selection.

Transactions:

| Date | Description | Amount | Category | Notes |
| --- | --- | ---: | --- | --- |
| 2026-08-07 | Paycheck | `+$2,000.00` | income | Bi-weekly salaried income |
| 2026-08-21 | Paycheck | `+$2,000.00` | income | Bi-weekly salaried income |
| 2026-08-01 | Rent | `-$1,200.00` | housing | Monthly bill |
| 2026-08-04 | Grocery Mart | `-$80.00` | groceries | Spending |
| 2026-08-18 | Grocery Mart | `-$65.00` | groceries | Spending |
| 2026-08-23 | Coffee Shop | `-$4.75` | dining | Spending |
| 2026-08-24 | Savings transfer | `-$500.00` | transfer | Excluded transfer |

Expected monthly summary assertion:

```json
{
  "month": "2026-08",
  "currency": "USD",
  "totalOutflowCents": 134975,
  "totalInflowCents": 400000,
  "excludedTransferOutflowCents": 50000,
  "categoryTotals": [
    { "category": "housing", "outflowCents": 120000, "transactionCount": 1 },
    { "category": "groceries", "outflowCents": 14500, "transactionCount": 2 },
    { "category": "dining", "outflowCents": 475, "transactionCount": 1 }
  ]
}
```

The two paychecks are tracked as August inflows, but they do not turn the spending summary into a monthly forecast. Forecast timing remains event-based and day-level.

## Fixture 10: Monthly Savings Discretionary Purchases

Intent: validates the first supported goal decision: monthly savings, with the practical user intent of reducing discretionary spending to save more. The executable fixture is `packages/core/fixtures/mvp0/monthly-savings-discretionary-purchases.json`; it keeps one shared snapshot and switches `plannedPurchaseId` for each scenario.

Shared inputs:

| Type | Date | Amount | Notes |
| --- | --- | ---: | --- |
| Opening checking balance | 2026-08-03 | `$1,510.00` | Spendable cash |
| Rent | 2026-08-06 | `-$700.00` | Required obligation |
| Utilities | 2026-08-15 | `-$150.00` | Required obligation |
| Monthly savings contribution | 2026-08-16 | `-$300.00` | `monthly_savings_target`, protected high-priority goal |
| Paycheck | 2026-08-17 | `+$2,000.00` | Fixed, confirmed, bi-weekly |
| Cash buffer | n/a | `$250.00` | Visible but read-only in MVP 0 |

Planned purchase scenarios:

| Scenario | Planned purchase | Expected level | Expected reason codes |
| --- | --- | --- | --- |
| `video_game_99` | `$99.00` video game | `AFFORDABLE` | `BUFFER_PASSED`, `TIMING_RESERVE_PASSED` |
| `video_game_console_499` | `$499.00` representative video game console | `RISKY` | `HIGH_PRIORITY_GOAL_SHORTFALL` |
| `restaurant_meal_125` | `$125.00` expensive restaurant meal | `TIGHT` | `GOAL_BUFFER_CONFLICT`, `BUFFER_BELOW_MINIMUM` |

The restaurant and console scenarios must attach `goal_monthly_savings` in `relatedEntityIds` so UI copy can name the monthly savings goal without inference.

## H-010 Additional Reason-Code Fixtures

The H-010 backend fixture gap is covered by four executable fixtures under `packages/core/fixtures/mvp0/`. Each fixture follows the established single-scenario JSON shape: `id`, `description`, `input`, and `expected`.

| Fixture | Target reason | Ordered reason codes | Related entities |
| --- | --- | --- | --- |
| `optional-obligation-tradeoff.json` | `OPTIONAL_OBLIGATION_TRADEOFF` | `OPTIONAL_OBLIGATION_TRADEOFF`, `BUFFER_BELOW_MINIMUM` | `obligation_streaming_bundle` |
| `baseline-already-tight.json` | `BASELINE_ALREADY_TIGHT` | `BUFFER_BELOW_MINIMUM`, `BASELINE_ALREADY_TIGHT` | none |
| `variable-income-not-guaranteed.json` | `VARIABLE_INCOME_NOT_GUARANTEED` | `VARIABLE_INCOME_NOT_GUARANTEED`, `REQUIRED_OBLIGATION_SHORTFALL`, `TIMING_RESERVE_SHORTFALL` | `income_freelance_invoice` |
| `coverage-incomplete.json` | `COVERAGE_INCOMPLETE` | `COVERAGE_INCOMPLETE` | `income_salary` |

`baseline-already-tight.json` intentionally preserves current backend precedence: the generic buffer breach remains first, then `BASELINE_ALREADY_TIGHT` explains that the buffer issue already existed before the planned purchase. The coverage fixture uses income coverage, not mixed currency or stale balances, so the target reason carries a meaningful implicated income source while remaining an `UNKNOWN` decision.

## Golden Test Expectations

Each executable fixture test should assert at least:

- Decision level.
- Ordered reason codes.
- Required path minimum balance and date.
- Protected path minimum balance and date.
- All-events path minimum balance and date.
- Expected-reference path minimum balance and date when a fixture includes variable or irregular income.
- Post-purchase cash.
- Timing reserve and timing reserve margin.
- Freshness status and critical warning count.
- Monthly spending summary totals for fixtures that include transactions.
- Product boundary flags in the response.

The test should not assert final user-facing prose unless testing explanation tone separately.

## Pivot Fixture: Where Is My Money Going Multi-Account

Intent: validates the transaction-first spending home foundation after `D-011`.

Executable fixture:

- `packages/core/fixtures/mvp0/where-is-my-money-going-multi-account.json`

Coverage:

- One user with Chase checking, Ally savings, Chase Sapphire, and American Express Gold.
- Three months of transaction history: June, July, and August 2026.
- Income deposits to checking and savings.
- Spending across checking and credit-card accounts.
- Savings transfers and credit-card payments marked as internal movement, not spending.
- Recurring subscriptions and duplicate-ish service groups.
- Varied categories, a refund, a cash withdrawal, and an unpaired transfer-like outflow.

Expected assertions:

- `flowType` exists on every transaction.
- Spending totals exclude `TRANSFER_OUT`, `TRANSFER_IN`, and credit-card payments.
- Refunds reduce category and merchant totals instead of inflating income.
- Unpaired transfer-like movement is `UNCLASSIFIED` and not counted as spending.
- `MonthlySpendingSummary` exposes per-account and per-institution rollups.
- Recent-versus-baseline comparison is backend-computed.

## Normalization Fixture: Merchant Aliases And Category Taxonomy

Intent: validates `S-004` deterministic merchant canonicalization and category mapping without changing the financial totals in the pivot fixture.

Executable fixture:

- `packages/core/fixtures/mvp0/merchant-normalization-cases.json`

Coverage:

- Netflix variants, including `CHECKCARD NETFLIX.COM`.
- Spotify variants, including `SPOTIFY USA`.
- Apple billing variants, with `APPLE.COM/BILL` / iTunes billing marked as an ambiguous app-store processor while explicit iCloud normalizes to cloud storage.
- Common travel, food, and shopping statement descriptors.
- Ambiguous processors such as PayPal when the underlying merchant is not parseable.
- Unknown card purchases that preserve uncertainty instead of inventing a merchant or category.
- Payment-like rows whose merchant text looks ordinary but whose flow remains `UNCLASSIFIED`.
- Cross-account same-merchant purchases that share labels but are not deduplicated or merged away.

Expected assertions:

- `normalizeTransactionLabels` returns stable `normalizedMerchantId`, display merchant, category id, category display label, `flowType`, and normalization uncertainty codes.
- Unknown merchants map to `unknown_merchant` / `unknown` with capped confidence.
- Ambiguous processors set `merchantAmbiguity=true` and are reflected in `merchantTotals`.
- `MonthlySpendingSummary` category totals include backend-owned `displayName` and `requiredDefault`.
- Matching normalized merchant ids across different accounts aggregate in merchant totals but remain separate in account totals.
