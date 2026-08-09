# UI Backend Contract

Status: Living summary  
Last updated: 2026-08-04

This file summarizes the backend contract for UI integration. The authoritative source is `docs/mvp0-backend-design.md`, especially the `UI-Facing Contract`, `Forecast Engine`, `Affordability Decision Engine`, and `Initial Backend Stack Recommendation` sections.

## Source Documents

- `../docs/mvp0-backend-design.md#ui-facing-contract`
- `../docs/mvp0-backend-design.md#forecast-engine`
- `../docs/mvp0-backend-design.md#affordability-decision-engine`
- `../docs/mvp0-test-fixtures.md`
- `../docs/decisions.md`

## MVP 0 Defaults For UI

- User model: individual salaried user paid bi-weekly.
- Forecast horizon: 30 calendar days.
- Forecast granularity: daily forecast events with conservative same-day ordering.
- Spending summaries: calendar-month summaries generated from normalized transactions.
- Currency: integer minor units, cents for USD.
- Dates: ISO `YYYY-MM-DD` calendar dates in the user's financial timezone.
- Backend stack: TypeScript, Node.js, Zod, Vitest, JSON fixtures, SQLite later if persistence is needed.
- Integration shape: one separately deployed Fastify API in `packages/server`; `packages/core` is internal backend domain code.

## API V1 Operation

Frontend base URL:

- Local default: `http://127.0.0.1:8787`
- Web environment variable: `VITE_BREADCRUMBS_API_BASE_URL`
- API CORS environment variable for deployed web origins: `BREADCRUMBS_CORS_ORIGINS`
- `VITE_*` variables are browser-visible; they must never contain secrets.

Stable endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/affordability/evaluate` | Evaluates affordability server-side through `packages/core`. |
| `POST` | `/api/v1/local/statement-imports/preview` | Parses and validates CSV text with explicit mappings without saving rows. |
| `POST` | `/api/v1/local/statement-imports/commit` | Runs the same CSV validation and saves valid, non-duplicate canonical transactions. |
| `GET` | `/api/v1/local/spending-summary?currency=USD` | Returns committed local accounts, transactions, import batches, and backend-owned `MonthlySpendingSummary[]`. |

Existing `/api/local/...` CSV paths remain compatibility aliases for current local handoffs. New UI work should prefer `/api/v1/local/...`.

Backend packages:

- API deployment path: `packages/server`
- API package name: `@ai-fin-os/server`
- Internal domain path: `packages/core`
- Internal package name: `@ai-fin-os/core`
- Internal named export: `evaluateAffordability`
- Re-exported contract types/values: `AffordabilityRequest`, `AffordabilityResponse`, `AffordabilityLevel`, `FinancialSnapshot`, snapshot entity types (`Account`, `PlannedPurchase`, `IncomeSource`, `RecurringObligation`, `Goal`, `Transaction`), support types (`Freshness`, `FreshnessStatus`, `Uncertainty`, `Cadence`, `EntitySource`, `ForecastConfig`, `DataCoverage`, `GoalType`, `FlowType`, `NormalizationUncertaintyCode`), `ForecastEvent`, `ForecastPathMetrics`, `MonthlySpendingSummary`, `MonthlySpendingAttribution`, `MonthlySpendingComparison`, `DecisionExplanation`, `DecisionReason`, `Assumption`, `AssumptionCode`, `FreshnessWarning`, `ProductBoundary`, `ReasonCode`, `ReasonParameterMap`, `AffordabilityRequestValidationIssue`, and `AffordabilityRequestValidationError`.
- Named spending export: `summarizeMonthlySpending(transactions, currency, accounts): MonthlySpendingSummary[]`.
- Named normalization exports: `CATEGORY_TAXONOMY`, `getCategoryMetadata(category)`, `categoryRequiredByDefault(category)`, `normalizeTransactionLabels(input)`, `normalizeStatementTransaction(input)`, and `merchantKeyFromText(merchantName)`.

Browser runtime code must not import or call `evaluateAffordability`, `summarizeMonthlySpending`, or other backend finance calculation functions directly. Type-only imports from `@ai-fin-os/core` are allowed only when they do not bundle runtime logic.

## Request Summary

```ts
type AffordabilityRequest = {
  requestId: string;
  snapshot: FinancialSnapshot;
  plannedPurchaseId: string;
};
```

`FinancialSnapshot` includes:

- `asOfDate`, `timezone`, `currency`
- `config`: horizon, cash buffer, stale-data thresholds, reliable income confidence
- `coverage`: completeness declarations for balances, income, obligations, and transactions
- `accounts`
- `transactions`
- `incomeSources`
- `recurringObligations`
- `goals`; MVP 0 starts with `goalType: "monthly_savings_target"`
- `plannedPurchases`

UI can help users enter or select these inputs, but backend validation determines whether the data is usable.

## Transaction-First Spending Contract

The product center is now "Where is my money going?" across all of one user's accounts and institutions. All accounts in a snapshot belong to the same user. Money moving between those accounts is movement, not income or spending.

Every `Transaction` has backend-owned `flowType`:

- `SPEND`: external consumer outflow.
- `FEE`: external institution fee, counted in money out.
- `INCOME`: external inflow.
- `REFUND`: reverses prior spend; reduces category/merchant totals and is not income.
- `TRANSFER_OUT` / `TRANSFER_IN`: internal movement between the user's accounts.
- `UNCLASSIFIED`: transfer-like movement whose paired account is not known; disclose as uncertainty and do not count as spending.

Matched transfers may include `counterAccountId` and `transferMatchConfidence`. Backend aggregation trusts a transfer as internal only when the counter account is connected and `transferMatchConfidence >= 0.8`; otherwise transfer-like movement is placed in the unclassified buckets. UI can show those facts, but must not perform pairing or classification.

`S-004` adds backend-owned label normalization metadata on transactions:

- `normalizedMerchantId`: stable merchant id used for grouping.
- `merchantCanonical`: deterministic canonical merchant text for diagnostics.
- `merchantAmbiguity`: true when the row names a processor/app store/unknown merchant and the underlying merchant is not safely known.
- `category`: stable taxonomy id.
- `categoryDisplayName`: backend-owned display label for the category id.
- `categoryRequiredDefault`: default required/discretionary taxonomy hint for future pattern rules.
- `normalizationUncertaintyCodes[]`: currently `unknown_merchant`, `ambiguous_processor`, `unknown_category`, and `transfer_like_unpaired`.

Known merchant aliases such as `NETFLIX.COM`, `SPOTIFY USA`, and `APPLE.COM/BILL` normalize deterministically. Apple billing/app-store rows remain `merchantAmbiguity: true` unless the underlying Apple service is explicit, such as iCloud or Apple Music. Transfer-like and credit-card-payment rows remain `UNCLASSIFIED` until backend transfer matching proves an internal pair, even when the text also contains an ordinary merchant alias.

`MonthlySpendingSummary` is promoted to a primary spending-home contract. Each summary includes:

- `totalOutflowCents`: net external money out, equal to `SPEND + FEE - REFUND`.
- `grossOutflowCents`: external outflow before refunds.
- `totalInflowCents`: `INCOME` only, excluding refunds and transfers.
- `refundCents`.
- `categoryTotals[]` and `merchantTotals[]`, net of refunds with `grossOutflowCents`, `refundCents`, and refund counts available separately. A refund-only category may have negative `outflowCents` when the refund posts in a later month than the spend. Category totals include `displayName` and `requiredDefault`. Merchant totals include `merchantAmbiguity`, `ambiguousTransactionCount`, and `unknownTransactionCount`.
- `accountTotals[]` and `institutionTotals[]`, including outflow, inflow, refund, excluded transfer, excluded credit-card payment, and unclassified movement amounts.
- `excludedTransferOutflowCents` / `excludedTransferInflowCents`.
- `excludedCreditCardPaymentOutflowCents` / `excludedCreditCardPaymentInflowCents`.
- `unclassifiedOutflowCents` / `unclassifiedInflowCents`.
- `comparison`, a backend-computed recent-versus-baseline total/category comparison. UI should not subtract monthly summaries itself.

Canonical fixture for the spending home:

- `packages/core/fixtures/mvp0/where-is-my-money-going-multi-account.json`
- Contains Chase checking, Ally savings, Chase Sapphire, and American Express Gold across June-August 2026.
- Exercises salary deposits, side-income deposits to savings, checking and credit-card spending, savings transfers, credit-card payments, recurring subscriptions, duplicate-ish streaming/cloud services, varied categories, a refund, a cash withdrawal, and an unpaired transfer.

## Response Summary

```ts
type AffordabilityLevel = "AFFORDABLE" | "TIGHT" | "RISKY" | "UNKNOWN";
```

The response includes:

- `requestId`, `asOfDate`, `horizonStartDate`, `horizonEndDate`
- `level`: backend-selected affordability result
- `purchase`: selected planned purchase details
- `metrics`: opening cash, path metrics, post-purchase cash, timing reserve, timing margin, purchase impact
- `forecast`: backend-generated events and daily balances
- `monthlySpendingSummaries`: backend-generated calendar-month summaries
- `explanation`: headline fact, reason codes, assumptions, freshness warnings, and product boundaries
- `debug`: optional fixture/local development diagnostics

## UI May Own

- Money, date, and percentage formatting.
- Screen layout, navigation, controls, loading states, empty states, incomplete-data states, and visual hierarchy.
- Mapping backend reason codes to non-judgmental product copy.
- Showing or hiding optional `debug` fields in local development.
- Asking for missing inputs when the backend returns `UNKNOWN`.

## UI Must Not Own

- Affordability level calculation.
- Cash buffer pass/fail logic.
- Timing reserve calculation.
- Same-day event ordering.
- Recurrence expansion for income, obligations, goals, or subscriptions.
- Daily required/protected/all-events/expected forecast path balances.
- Monthly spending summary aggregation.
- Money-flow classification, transfer matching, credit-card payment exclusion, refund netting, account/institution rollups, and period-over-period deltas.
- Freshness or coverage pass/fail decisions.
- Product boundary removal or suppression.

## Important Backend-Owned Rules

- `UNKNOWN` takes precedence when critical data is missing, stale, incomplete, contradictory, or cannot be normalized.
- `RISKY` indicates required solvency failures or dependency on unreliable income.
- `TIGHT` indicates required obligations remain coverable, but buffer, timing, optional obligations, baseline, or goal tradeoffs are present.
- `AFFORDABLE` requires critical data to be usable and required, protected, timing, and all-events checks to pass.
- The first supported goal is monthly savings (`monthly_savings_target`), with discretionary purchases evaluated against the scheduled savings contribution without UI-side goal math.
- Monthly spending summaries are reporting and pattern-detection outputs. They must not replace day-level forecast timing.
- AI may later explain computed facts, but AI must not perform MVP 0 calculations.

## Stable Reason Codes

UI copy can map these backend reason codes to user-facing language:

- `BUFFER_PASSED`
- `TIMING_RESERVE_PASSED`
- `BUFFER_BELOW_MINIMUM`
- `TIMING_RESERVE_LOW`
- `OPTIONAL_OBLIGATION_TRADEOFF`
- `GOAL_BUFFER_CONFLICT`
- `BASELINE_ALREADY_TIGHT`
- `REQUIRED_OBLIGATION_SHORTFALL`
- `TIMING_RESERVE_SHORTFALL`
- `HIGH_PRIORITY_GOAL_SHORTFALL`
- `VARIABLE_INCOME_NOT_GUARANTEED`
- `STALE_BALANCE`
- `MISSING_PURCHASE_FIELD`
- `COVERAGE_INCOMPLETE`

`explanation.reasons[]` order is guaranteed by the backend. The first reason is the primary display reason; later reasons are deterministic supporting reasons. UI should not implement separate precedence logic.

Each `DecisionReason` includes `parameters`, typed by reason code. UI copy should read these named parameters instead of computing differences from metrics.

| Code | Parameters |
| --- | --- |
| `BUFFER_PASSED` | `requiredBufferMarginCents`, `minimumCashBufferCents`, `minimumBalanceDate` |
| `TIMING_RESERVE_PASSED` | `postPurchaseCashCents`, `timingReserveCents`, `timingReserveMarginCents`, `timingReserveWindowEndDate`, optional `nextReliableIncomeDate`, `minimumCashBufferCents` |
| `BUFFER_BELOW_MINIMUM` | `path`, `minimumBalanceCents`, `minimumBalanceDate`, `bufferMarginCents`, `bufferShortfallCents`, `minimumCashBufferCents` |
| `TIMING_RESERVE_LOW` | same timing parameter object as `TIMING_RESERVE_PASSED` |
| `OPTIONAL_OBLIGATION_TRADEOFF` | `allEventsMinimumBalanceCents`, `allEventsMinimumBalanceDate`, `allEventsBufferMarginCents`, `minimumCashBufferCents` |
| `GOAL_BUFFER_CONFLICT` | `protectedMinimumBalanceCents`, `protectedMinimumBalanceDate`, `protectedBufferMarginCents`, `baselineProtectedMinimumBalanceCents`, `minimumCashBufferCents` |
| `BASELINE_ALREADY_TIGHT` | `baselineMinimumBalanceCents`, `baselineMinimumBalanceDate`, `baselineBufferMarginCents`, `purchaseImpactOnMinimumCents`, `minimumCashBufferCents` |
| `REQUIRED_OBLIGATION_SHORTFALL` | `requiredMinimumBalanceCents`, `requiredMinimumBalanceDate` |
| `TIMING_RESERVE_SHORTFALL` | same timing parameter object as `TIMING_RESERVE_PASSED` |
| `HIGH_PRIORITY_GOAL_SHORTFALL` | `protectedMinimumBalanceCents`, `protectedMinimumBalanceDate` |
| `VARIABLE_INCOME_NOT_GUARANTEED` | `requiredMinimumBalanceCents`, `requiredMinimumBalanceDate`, `expectedReferenceMinimumBalanceCents`, `expectedReferenceMinimumBalanceDate` |
| `STALE_BALANCE` | `staleAccountIds`, `criticalFreshnessWarningCount` |
| `MISSING_PURCHASE_FIELD` | `missingFields` |
| `COVERAGE_INCOMPLETE` | `coverageType`, optional `horizonEndDate` |

## Stable Assumption Codes

UI copy can map these backend assumption codes:

- `AVAILABLE_BALANCE_MISSING`
- `CONSERVATIVE_INCOME_MINIMUM_USED`
- `FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY`
- `OPTIONAL_OBLIGATION_EXCLUDED_FROM_REQUIRED_SOLVENCY`
- `CADENCE_DAY_CLAMPED_TO_MONTH_END`
- `CONSERVATIVE_SAME_DAY_ORDERING_APPLIED`

Adding a reason code, reason parameter, or assumption code is a backend/UI contract change that needs a handoff.

## Error Behavior

The HTTP affordability endpoint returns `400` for schema-malformed request payloads:

```ts
type InvalidAffordabilityRequestResponse = {
  error: {
    code: "INVALID_AFFORDABILITY_REQUEST";
    issues: AffordabilityRequestValidationIssue[];
  };
};
```

Schema-valid but financially missing, stale, incomplete, contradictory, or unsupported data returns an `AffordabilityResponse` with `level: "UNKNOWN"` and backend reason codes. UI should render the normal `UNKNOWN` result state for these responses, not an error boundary.

In `AffordabilityResponse["purchase"]`, `amountCents` and `purchaseDate` are optional. If a schema-valid `UNKNOWN` response is caused by a missing amount or date, the backend omits the absent value rather than substituting `0` or `asOfDate`.

## Resolved Integration Boundary

Superseded 2026-08-04 by `D-013` / `CD-011`: **frontend and API deploy separately**. `packages/server` is the single backend deployment boundary. `packages/core` is internal backend domain code, not a separately deployed service.

The UI stack remains React, Vite, TypeScript, and Tailwind in a pnpm workspace (`CD-004`, `D-009`). `apps/web/src/services/api.ts` is the single HTTP boundary and holds every call the app makes, including `POST /api/v1/affordability/evaluate`. It reads `VITE_BREADCRUMBS_API_BASE_URL`, defaulting locally to `http://127.0.0.1:8787`. The earlier `services/affordability.ts` was deleted once `api.ts` covered the same endpoint — two clients for one route can only drift.

One violation of this boundary survives and is tracked in `docs/status.md`: `apps/web/src/model/snapshot.ts` imports `packages/core/fixtures/mvp0/affordable-steady-paycheck.json` by relative path, a build-time reach into backend-internal files.

## Local CSV Import API Boundary

Added 2026-08-04 for `L-001` after the local-first MVP plan. Updated after
`D-013` / `CD-011` so local imported spending data lives under the same versioned
Fastify API as affordability. It feeds the same canonical `Account`,
`Transaction`, and `MonthlySpendingSummary` types for the spending home.

Server package:

- Path: `packages/server`
- Package name: `@ai-fin-os/server`
- Local server command: `pnpm --filter @ai-fin-os/server dev`
- Default URL: `http://127.0.0.1:8787`
- Plaid credentials are not required for local CSV import endpoints.
- Local imported data defaults to `~/.breadcrumbs/local-data/statement-imports.json`.
  Override with `BREADCRUMBS_LOCAL_DATA_DIR` if needed. Raw CSV text is not
  stored; only canonical account, transaction, and import-batch records are
  stored.

Preferred local endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Confirms server status. Returns `plaidEnv: "disabled"` when no Plaid credentials are loaded. |
| `POST` | `/api/v1/local/statement-imports/preview` | Parses and validates CSV text with explicit mappings, returns canonical transactions and monthly summaries without saving. |
| `POST` | `/api/v1/local/statement-imports/commit` | Runs the same validation and saves only valid, non-duplicate canonical transactions. Returns `422` with the preview contract when errors exist. |
| `GET` | `/api/v1/local/spending-summary?currency=USD` | Returns committed local accounts, transactions, import batches, and backend-owned `MonthlySpendingSummary[]`. |

Compatibility aliases remain available at `/api/local/statement-imports/preview`,
`/api/local/statement-imports/commit`, and `/api/local/spending-summary?currency=USD`.

CSV import request shape:

```ts
type CsvStatementImportRequest = {
  requestId?: string;
  csv: string; // browser reads the selected CSV file and sends text
  accountId: string;
  account?: {
    id: string;
    displayName: string;
    institutionName?: string;
    type?: "checking" | "savings" | "cash" | "credit_card" | "loan" | "investment" | "other";
    role?: "spendable_cash" | "reserve_cash" | "liability" | "excluded";
    currency?: "USD";
    currentBalanceCents?: number;
    availableBalanceCents?: number;
    includeInForecast?: boolean;
  };
  currency?: "USD";
  timezone?: string;
  dateFormat?: "iso" | "mm/dd/yyyy";
  mapping: {
    postedDate: string;
    amount?: string;
    debitAmount?: string;
    creditAmount?: string;
    amountSignConvention?: "signed" | "outflow_positive";
    merchantName?: string;
    description?: string;
    originalDescription?: string;
    category?: string;
    currency?: string;
    transactionId?: string;
  };
};
```

Mapping rules:

- The UI must send exact CSV header names in `mapping`.
- A single `amount` column requires `amountSignConvention`.
  - `signed`: positive means inflow and negative means outflow.
  - `outflow_positive`: positive means outflow, useful for some credit-card exports.
- Debit/credit imports require both `debitAmount` and `creditAmount`; debit
  maps to outflow, credit maps to inflow.
- First import for an account must include an `account` descriptor. Later imports
  may use the existing `accountId`.
- CSV is supported first. Bank statement PDF import is deferred because bank PDF
  formats are not standardized.

Preview/commit response includes:

- `rawCsvStored: false`
- `account`
- `rowCount`, `validRowCount`, `invalidRowCount`
- `duplicateInFileCount`, `duplicateAlreadyImportedCount`
- `transactions: Transaction[]`
- `monthlySpendingSummaries: MonthlySpendingSummary[]`
- `categoryMappings[]` with normalized category ids and backend display labels for local MVP use
- `errors[]` and `warnings[]` with deterministic codes, row numbers, and columns
- commit-only `importBatch`, `importedTransactionCount`, `duplicateTransactionCount`, `accounts`, and `storedTransactionCount`

Backend-owned local normalization in `L-001`:

- Common shopping, travel, groceries, dining, coffee/snacks, income, refunds,
  fees, cash, streaming, music, software, cloud storage, utilities, medical,
  education, transportation, and transfer-like rows map deterministically.
- Local CSV import uses the shared `@ai-fin-os/core` `S-004` taxonomy and
  merchant alias map; it no longer maintains a separate category/merchant
  mapping table.
- Transfer-like rows from a CSV import are `UNCLASSIFIED` unless a later backend
  matching pass proves an internal pair. UI must surface them as uncertainty and
  must not reclassify them.
- Unknown categories stay `unknown` with a warning rather than being forced into
  false precision.
- Duplicate imports use deterministic transaction ids and do not double-count
  committed transactions.

## Future Plaid Sandbox Boundary

The Plaid Sandbox scaffold lives in `packages/server` as `@ai-fin-os/server`. It does not change the MVP 0 affordability operation above. After `D-011` / `CD-010`, its main purpose is to support the future spending home and multi-institution aggregation work with read-only account and transaction data.

Server-only Plaid behavior:

- Environment is restricted to `PLAID_ENV=sandbox`.
- Link token creation requests only `transactions`; Balance is retrieved through `/accounts/balance/get` without adding a Link `balance` product.
- `auth` and `identity` are not requested by the current scaffold.
- Public-token exchange happens server-side and returns a local `connectionId`, never a Plaid `access_token`.
- Account and transaction routes return canonical `Account[]`, `Transaction[]`, or a conservative `FinancialSnapshot`.
- The mapped snapshot does not declare total balance or obligation coverage by default.
- The existing mapper now uses the shared `S-004` core normalizer so Plaid rows land on the same category ids and merchant aliases as CSV rows.
- Cross-connection aggregation, institution rollups, transfer matching across Plaid connections, and recurring detection are follow-up backend work, not part of this scaffold.

UI handoff: a future Plaid Link UI should request a Link token from the server, initialize Link with only that token, send the returned `public_token` back to the server, and use the returned `connectionId` for read-only data calls. No Plaid secret or access token should be added to browser-visible environment variables.

## Copy Ownership

Per `CD-006`, `[UI: Claude]` owns every string the user reads. Backend-emitted prose — `headlineFact`, `reasons[].facts[]`, `Assumption.message`, `FreshnessWarning.message` — is diagnostic output for logs, fixtures, and `debug`. No UI surface renders it verbatim.

This means every user-visible backend output must be reachable by a stable enumerated code plus structured parameters. `H-004` and `H-005` are answered by the stable assumption-code union, reason `parameters`, guaranteed reason ordering, and malformed-input throw behavior above.

## Out Of MVP 0 Scope

Per `CD-007`, the response does not need, and the UI will not infer, any "what would make this affordable" guidance such as a suggested deferral date or required additional amount. Solving for those means re-running the forecast, which is backend scope deferred past MVP 0.

Per `CD-008`, the cash buffer is displayed as a visible assumption but is not user-editable in MVP 0. The UI reads `snapshot.config.minimumCashBufferCents`.
