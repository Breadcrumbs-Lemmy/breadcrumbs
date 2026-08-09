# UI-Driven API Contract

Status: Implemented — awaiting `[Backend: Codex]` review  
Owner: `[UI: Claude]`  
Last updated: 2026-08-06

> All five endpoints below exist in `packages/server/src/http/spending-routes.ts`
> and are consumed by `apps/web`. `packages/server/tests/spending-routes.test.ts`
> exercises them from a real CSV import. Two notes where the built behaviour is
> worth reading alongside the payloads:
>
> - **`period=statement` requires `accountId`** and returns a 400
>   (`ACCOUNT_ID_REQUIRED_FOR_STATEMENT`) without one. If the account carries no
>   `closingDay` it falls back to a calendar month rather than inventing a cycle,
>   so the UI keeps the statement period switched off until a closing day can be
>   captured.
> - **`asOfDate` is derived from the latest transaction, not the wall clock**, so
>   responses are deterministic and a dataset older than today still shows its
>   own most recent period rather than an empty one.

## Purpose

The user's direction: **build backend services from what the frontend needs.** This document works backwards from designed and approved screens to the payloads that render them.

Every field below exists because something on a screen displays it. Where a screen needs a figure, the field is here. Where no screen needs a figure, it is not — this is deliberately not a superset of what the domain could produce.

**Nothing here asks the UI to calculate.** If a screen shows a difference, a rate, a share, or a rollup, that value is in the payload. That is `CD-003` and `CD-011` applied concretely rather than restated.

## Reading order for backend

Priority reflects what unblocks the most product, not what is easiest.

| # | Endpoint | Unblocks | Status |
| --- | --- | --- | --- |
| 1 | `GET /api/v1/spending/summary` | Spending home for week/month/year | Extends existing |
| 2 | `GET /api/v1/transactions` | Transactions screen — currently impossible | **New** |
| 3 | `GET /api/v1/insights` | Insights screen, the waste feature | **New** |
| 4 | `GET /api/v1/accounts` | Accounts screen, statement cycles | **New** |
| 5 | `GET /api/v1/spending/series` | Trends over time | **New** |

The affordability endpoint is unchanged and already works.

---

## 1. Spending summary

`GET /api/v1/spending/summary?period=month&key=2026-08&currency=USD`

Generalises `MonthlySpendingSummary` to a period. This was `H-018`; week, month, and year are implemented and live, statement is implemented but needs a closing day.

**Query**

| Param | Values | Notes |
| --- | --- | --- |
| `period` | `week` \| `month` \| `year` \| `statement` | `statement` requires `accountId` |
| `key` | period key | `2026-W32`, `2026-08`, `2026`, or a statement id |
| `accountId` | optional | Filters. Also required for `statement` |
| `currency` | ISO 4217 | |

**Response**

```jsonc
{
  "period": {
    "kind": "month",
    "key": "2026-08",
    "label": "August",              // UI renders this, never derives it
    "startDate": "2026-08-01",
    "endDate": "2026-08-31",
    "partial": true,                // suppresses comparison in the UI
    "elapsedDays": 3,
    "totalDays": 31
  },
  "currency": "USD",

  "totalOutflowCents": 270689,      // hero figure: SPEND + FEE − REFUND
  "grossOutflowCents": 277489,
  "totalInflowCents": 458000,       // INCOME only
  "netCents": 187311,               // "Left over". Backend-owned, see note
  "refundCents": 6800,

  "excludedTransferOutflowCents": 274000,
  "excludedCreditCardPaymentOutflowCents": 224000,
  "unclassifiedOutflowCents": 22000,
  "unclassifiedCount": 1,

  "comparison": {
    "direction": "up",              // up | down | flat | new
    "outflowChangeCents": 37592,
    "baselineAverageOutflowCents": 233114,
    "baselinePeriodCount": 2,
    "baselineLabel": "the last 2 months",   // UI renders verbatim
    "comparable": true              // false on partial periods
  },

  "categoryTotals": [
    {
      "category": "groceries",
      "displayName": "Groceries",
      "outflowCents": 41970,
      "grossOutflowCents": 41970,
      "refundCents": 0,
      "transactionCount": 3,
      "shareBasisPoints": 1550,     // share of period. UI must not divide
      "comparison": {
        "direction": "up",
        "outflowChangeCents": 23230,
        "changeBasisPoints": 12400
      }
    }
  ],

  "accountTotals": [
    {
      "id": "account_chase_checking",
      "displayName": "Chase Total Checking",
      "institutionName": "Chase",
      "accountType": "checking",
      "totalOutflowCents": 204595,
      "totalInflowCents": 420000
    }
  ],

  "institutionTotals": [
    { "id": "chase", "displayName": "Chase", "accountIds": ["..."],
      "totalOutflowCents": 215161, "totalInflowCents": 420000 }
  ],

  "freshness": { "status": "fresh", "asOf": "2026-08-04T09:12:00Z", "warnings": [] }
}
```

**Why these fields**

- `netCents` — the UI currently subtracts inflow from outflow for "Left over". That is the only arithmetic in the whole app and I would rather not have it. If backend supplies it, the UI stops calculating entirely.
- `shareBasisPoints` — category bars are proportional. Without this the UI divides, which is aggregation.
- `baselineLabel` — the comparison line reads "on the last 2 months". Composing that string from a count means the UI decides pluralisation and phrasing of a financial comparison; cleaner as backend copy input.
- `partial` / `elapsedDays` — the UI suppresses comparisons on incomplete periods. It must not infer this from dates.
- `comparable` — separate from `partial` because a complete period with no baseline is also not comparable.

---

## 2. Transactions

`GET /api/v1/transactions?from=2026-08-01&to=2026-08-31&limit=50`

**New.** The Transactions screen cannot exist without it. This is how a user answers "what actually made up that £420 of groceries" — the drill-down that makes the category screen trustworthy.

**Query**: `from`, `to`, `accountId`, `category`, `flowType`, `search`, `cursor`, `limit`.

**Response**

```jsonc
{
  "transactions": [
    {
      "id": "txn_0f21",
      "postedDate": "2026-08-03",
      "merchantName": "Whole Foods Market",     // display name, normalised
      "originalDescription": "WHOLEFDS MKT 10241",  // shown on expand
      "amountCents": -8241,                     // signed
      "currency": "USD",

      "category": "groceries",
      "categoryDisplayName": "Groceries",

      "accountId": "account_amex_gold",
      "accountDisplayName": "Amex Gold",
      "institutionName": "American Express",

      "flowType": "SPEND",
      "counterAccountId": null,
      "isRecurring": false,
      "pending": false,

      "normalizationUncertaintyCodes": []
    },
    {
      "id": "txn_0f24",
      "postedDate": "2026-08-01",
      "merchantName": "Venmo Transfer",
      "amountCents": -22000,
      "category": "transfer",
      "categoryDisplayName": "Transfer",
      "accountId": "account_chase_checking",
      "accountDisplayName": "Chase Total Checking",
      "flowType": "UNCLASSIFIED",
      "counterAccountId": null,
      "unclassifiedReason": "COUNTER_ACCOUNT_NOT_CONNECTED",
      "isRecurring": false,
      "pending": false
    }
  ],
  "nextCursor": "eyJvIjoxMDB9",
  "totalCount": 88
}
```

**Why these fields**

- `merchantName` normalised **and** `originalDescription` raw. The list shows the clean name; the row expands to show what the bank actually sent, so a miscategorised row is diagnosable rather than mysterious.
- `flowType` per row — the screen badges transfers, refunds, and unresolved movement so a user scanning the list understands why the total doesn't equal the sum of visible rows.
- `unclassifiedReason` — the dashed "not sure" badge should say *why*. "We couldn't match this to another account of yours" is useful; an unexplained badge is not.
- `pending` — pending card charges move. A figure that changes overnight with no explanation reads as a bug.
- Cursor pagination rather than offset. Transaction lists grow.

---

## 3. Insights

`GET /api/v1/insights?period=month&key=2026-08`

**New.** This is the waste-detection feature and the product's differentiator. `pattern-detection.ts` already produces subscriptions and duplicates; this exposes them and adds the two that matter most.

```jsonc
{
  "period": { "kind": "month", "key": "2026-08", "label": "August" },

  "insights": [
    {
      "id": "insight_freq_coffee",
      "type": "FREQUENT_SMALL_PURCHASES",
      "headline": "Coffee, 11 times this month",
      "detail": "Small, frequent, and easy to miss on a statement.",
      "totalCents": 6742,
      "occurrenceCount": 11,
      "averageCents": 613,
      "category": "coffee_snacks",
      "categoryDisplayName": "Coffee & snacks",
      "merchants": [
        { "normalizedMerchantId": "blue_bottle", "displayName": "Blue Bottle", "count": 9, "totalCents": 5398 },
        { "normalizedMerchantId": "starbucks",   "displayName": "Starbucks",   "count": 2, "totalCents": 1344 }
      ],
      "comparison": { "direction": "up", "changeCents": 1890 },
      "confidence": "high",
      "transactionIds": ["txn_...", "txn_..."]
    },
    {
      "id": "insight_dup_streaming",
      "type": "POSSIBLE_DUPLICATE_SERVICE",
      "headline": "Three streaming services",
      "detail": "Netflix, Hulu, and Disney+ all bill monthly. They may overlap.",
      "totalCents": 4747,
      "cadence": "monthly",
      "members": [
        { "normalizedMerchantId": "netflix",  "displayName": "Netflix",  "amountCents": 1549 },
        { "normalizedMerchantId": "hulu",     "displayName": "Hulu",     "amountCents": 1799 },
        { "normalizedMerchantId": "disney",   "displayName": "Disney+",  "amountCents": 1399 }
      ],
      "potentialSavings": { "lowCents": 1399, "highCents": 1799, "basis": "cheapest_to_costliest_member" },
      "confidence": "medium"
    },
    {
      "id": "insight_rising_groceries",
      "type": "RISING_CATEGORY",
      "headline": "Groceries up sharply",
      "detail": "Three shops so far versus one by this point last month.",
      "totalCents": 41970,
      "category": "groceries",
      "categoryDisplayName": "Groceries",
      "comparison": { "direction": "up", "changeCents": 23230, "changeBasisPoints": 12400 },
      "confidence": "high"
    }
  ],

  "recurring": {
    "totalMonthlyCents": 8544,
    "count": 6,
    "items": [
      { "normalizedMerchantId": "netflix", "displayName": "Netflix",
        "amountCents": 1549, "cadence": "monthly", "cadenceLabel": "Monthly",
        "nextExpectedDate": "2026-09-01", "confidence": "high",
        "lastChargedDate": "2026-08-01", "category": "streaming" }
    ]
  }
}
```

**Where `recurring` and `isRecurring` come from**

Both read `Transaction.recurrenceSignal`. That field is optional, and absent means "not recurring", so anything that fails to write it silently produces an empty subscriptions panel rather than an error.

Nothing wrote it. Only hand-written fixtures carried it, so the panel reported `0 subscriptions, $0/mo` over imported statements that plainly contained subscriptions. Recurrence is a property of a *series*, not of a row — it cannot be known when a row is first read, because the later charges have not happened yet — so it is now derived at read time in `registerSpendingRoutes` by `annotateRecurrenceSignals`, which runs the existing `detectRecurringSpending` over the full history and stamps its findings onto the transactions it identified. An explicitly stated signal is never overwritten.

Consequence for anyone extending this contract: a field on `Transaction` that fixtures state by hand and neither the CSV nor the Plaid mapper writes will pass every test and be empty in production. Test it from an import, not a fixture.

**Why these fields**

- `headline` and `detail` are **the exception to `CD-006`**, and I want to flag that rather than slip it past. Elsewhere the UI owns all copy and composes it from codes. Insights are open-ended — the set will grow, and each has a different sentence shape. Two workable options: backend supplies the strings as above, or backend supplies `type` plus typed parameters and the UI composes, matching the reason-code pattern. **I mildly prefer the second** for consistency, but the first is faster and I will not block on it. Your call — just not a mix.
- `potentialSavings` as a **range with a stated basis**, never a single number. "You could save $17.99" is a recommendation; "dropping one would free $13.99–$17.99" is a fact with the arithmetic shown. `D-002` bars advice, and a bare figure edges toward it.
- `confidence` — subscription detection is heuristic. A medium-confidence duplicate should look different from a certain one.
- `transactionIds` — every insight must be clickable through to the transactions that produced it. An insight the user can't verify is a claim, not a fact.
- `occurrenceCount` and `averageCents` — "11 times, $6.13 average" is the sentence that lands. Eleven separate $6 charges are invisible on a statement and obvious here.

---

## 4. Accounts

`GET /api/v1/accounts`

**New.** Includes the statement cycle, which is the highest-value item in `H-018`.

```jsonc
{
  "netPositionCents": 1388959,
  "netPositionLabel": "Cash, minus what you owe on cards",

  "institutions": [
    {
      "id": "chase",
      "displayName": "Chase",
      "connectionStatus": "healthy",     // healthy | syncing | needs_attention | disconnected
      "lastSyncedAt": "2026-08-04T07:30:00Z",
      "accounts": [
        {
          "id": "account_chase_sapphire",
          "displayName": "Sapphire Preferred",
          "mask": "9930",
          "type": "credit_card",
          "role": "liability",
          "currentBalanceCents": -114686,
          "availableBalanceCents": null,
          "creditLimitCents": 1200000,
          "freshness": { "status": "fresh", "asOf": "2026-08-04T07:30:00Z" },

          "statementCycle": {
            "closingDay": 18,
            "currentPeriodStart": "2026-07-19",
            "currentPeriodEnd": "2026-08-18",
            "currentPeriodSpendCents": 83420,
            "elapsedDays": 15,
            "totalDays": 31,
            "dueDate": "2026-09-12",
            "lastStatementBalanceCents": 142000,
            "source": "user_provided"      // plaid | user_provided | inferred
          }
        }
      ]
    }
  ]
}
```

**Why `statementCycle` matters more than anything else here**

The user's problem, in their words: *"I spend a lot on my credit card and then towards the end of the month I am racing behind trying to figure out how, and I still have to pay it off."*

A card closing on the 18th means the bill arriving in August is mostly **July** spending. Show them "August: $2,707" next to a statement covering 19 July – 18 August and the two will never agree. The product looks broken at the exact moment it most needs to look right.

`currentPeriodSpendCents` is the number that answers their question. `source` matters because inferring a closing day from payment dates is a guess, and a guessed cycle should be labelled as one.

---

## 5. Spending series

`GET /api/v1/spending/series?period=month&count=12`

**New.** "See and compare how money is moving" needs a series, not a single delta.

```jsonc
{
  "period": { "kind": "month", "count": 12 },
  "points": [
    { "key": "2026-06", "label": "Jun", "totalOutflowCents": 211114,
      "totalInflowCents": 452000, "partial": false }
  ],
  "categorySeries": [
    { "category": "groceries", "displayName": "Groceries",
      "points": [ { "key": "2026-06", "outflowCents": 12430 } ] }
  ]
}
```

Raw per-period totals only. **No smoothing, forecasting, or trend fitting** — the UI plots what it is given. A fitted line is a prediction, and predictions belong to the deterministic engine, not a chart.

---

## Cross-cutting

**Errors.** Same envelope everywhere:

```jsonc
{ "error": { "code": "INVALID_PERIOD", "message": "...", "issues": [] } }
```

The UI distinguishes three outcomes and always will: a **result** (including "not enough data", which is a real answer), an **invalid request**, and a **failure**. Collapsing any into another lets a transport problem masquerade as a financial fact.

**Empty is not an error.** No transactions in a period returns `200` with zeros and `partial`/`comparable` flags set. The screen says "nothing here yet"; it does not say something went wrong.

**Money** stays integer minor units. **Dates** stay ISO `YYYY-MM-DD` in the user's financial timezone.

**Unknown stays unknown.** Any figure the backend cannot determine should be absent or `null`, never `0`. The UI renders an em-dash for absent and `$0` for a real zero, and those mean different things.

---

## What the UI still computes, and would rather not

Full disclosure of every calculation currently in the browser:

| Calculation | Where | Fix |
| --- | --- | --- |
| `totalInflowCents − totalOutflowCents` for "Left over" | `SpendingScreen` | `netCents` above |
| Category bar width as share of largest | `SpendingScreen` | `shareBasisPoints` above |
| `Math.abs()` on a negative delta for display | copy layer | Acceptable — sign flip, not arithmetic |
| Pixel scaling in the forecast chart | `ForecastChart` | Acceptable — cents to pixels is presentation |

The first two disappear once the fields land. Then the UI does no financial arithmetic at all, and that claim becomes checkable rather than aspirational.
