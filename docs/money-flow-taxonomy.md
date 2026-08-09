# Money Flow Taxonomy

Status: Living; backend foundation implemented in `packages/core`  
Owner: `[UI: Claude]`, `[Backend: Codex]`  
Last updated: 2026-08-04

## Purpose

Once the product aggregates several accounts across several institutions (`D-011`), "how much did I spend" stops being a sum of outflows. This document defines how money movement is classified so the product can answer it correctly.

This is a **data model requirement, not a display preference**. The UI cannot classify these correctly — it has no view of matching, timing, or confidence — so classification is backend-owned.

## The problem, concretely

Measured against the canonical fixture `where-is-my-money-going-multi-account.json` — Chase checking, Ally savings, Chase Sapphire, American Express Gold, three months — by running the real `summarizeMonthlySpending`:

| Month | Naive sum of every outflow | Actual spending | Difference | Overstatement |
| --- | --- | --- | --- | --- |
| June 2026 | `$4,461` | `$2,111` | `$2,350` | **111%** |
| July 2026 | `$5,141` | `$2,551` | `$2,590` | **102%** |
| August 2026 | `$5,735` | `$2,707` | `$3,028` | **112%** |
| **Total** | **`$15,337`** | **`$7,369`** | **`$7,968`** | **108%** |

A naive total does not overstate spending by a little. **It more than doubles it.** Nothing is wrong with the data, and no transaction is duplicated in the source — every one of those dollars really did leave an account.

Where August's `$3,028` difference comes from:

| Component | Amount |
| --- | --- |
| Credit card payments | `$2,240` |
| Savings transfer | `$500` |
| Unresolvable movement | `$220` |
| Refunds netted off | `$68` |

The card payments are the bulk of it, and they are the clearest case: that spending was already counted when the card was charged. Counting the payment as well counts it twice.

The scale matters for a reason beyond arithmetic. An error of a few percent might survive contact with a user; an error of 108% cannot. The user opens their banking app, sees a number less than half of ours, and correctly concludes the product cannot count. Every multi-account aggregator has to solve this, and getting it wrong is worse than not aggregating at all.

> These figures come from executing the shipped engine against the shipped
> fixture, not from an estimate. Earlier drafts of this document used invented
> mock data showing a 51% overstatement; the real fixture is worse, and the
> mock numbers have been removed to avoid citing fiction as evidence.

## The model

Classification needs **two independent axes**, not one category tree.

**Axis 1 — direction:** does money enter or leave the account.

**Axis 2 — boundary:** does the money cross the boundary of what the user owns, or move within it.

|  | Money out | Money in |
| --- | --- | --- |
| **Crosses the boundary** (external) | `SPEND` | `INCOME` |
| **Stays inside** (internal) | `TRANSFER_OUT` | `TRANSFER_IN` |

Two refinements sit on top:

- `REFUND` — an inflow that reverses a prior `SPEND`. It is not income. It reduces the category it came from.
- `FEE` — an outflow to the institution itself. External, and worth separating from discretionary spending because the user did not choose it at a merchant.

Proposed enum:

```ts
type FlowType =
  | "SPEND"
  | "INCOME"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "REFUND"
  | "FEE"
  | "UNCLASSIFIED";
```

## Rules

1. **Spending is external outflow only.** `SPEND` plus `FEE`, minus `REFUND`. Transfers never appear in a spending total.
2. **Spending is measured at the charge, not the payment.** A card charged on 20 July and paid on 5 August is July spending. The August payment is a `TRANSFER_OUT`.
3. **Transfers must pair.** A `TRANSFER_OUT` from account A should match a `TRANSFER_IN` to account B — same amount, within a few days. The pair nets to zero. A transfer is trusted only when the counter account is connected and `transferMatchConfidence >= 0.8`.
4. **An unpaired transfer is uncertainty, not spending.** If only one side is connected — money moved to an account the user has not linked — the product does not know whether it was spent. It must be marked `UNCLASSIFIED` rather than silently counted either way. This is the `UNKNOWN`-over-false-precision principle from the charter, applied to aggregation.
5. **Refunds reduce their original category.** A $68 Amazon refund reduces Shopping. It must not inflate income, which would make both numbers wrong at once. If the refund posts in a month without matching same-month spend, the category can be negative for that month; this is intentional accounting, not a calculation failure.
6. **Cash withdrawal is spending, and should say so.** Money left the account with no merchant. Treating it as a transfer would hide it; treating it as a normal purchase would invent a category. It belongs in its own `Cash` category.
7. **Savings and investment transfers are internal.** Moving $500 to savings is not spending. It is also not nothing, and the user may want to see it — but in a separate view, never inside the spending total.

## Contract implications

`MonthlySpendingSummary` already carries `excludedTransferOutflowCents`, which shows the intent was anticipated. The spending home needs more than that single figure.

Implemented additions, tracked in `H-014`:

- `flowType` on every transaction, from the enum above.
- `counterAccountId` on matched transfers, so pairs can be shown and verified.
- `transferMatchConfidence`, because pairing is heuristic and the UI should be able to distinguish a certain pair from a guess. Backend aggregation trusts transfer exclusion only at `0.8` or higher.
- Per-account and per-institution rollups, so filtering does not require UI-side re-aggregation.
- Category totals net of refunds, with the refund amount available separately so the UI can show "after $68 refund".
- Period-over-period category deltas, so the UI is not subtracting two summaries itself.

Backend foundation:

- Types live in `packages/core/src/domain/types.ts`.
- Aggregation lives in `packages/core/src/domain/monthly-spending.ts`.
- Canonical fixture lives in `packages/core/fixtures/mvp0/where-is-my-money-going-multi-account.json`.
- Focused tests live in `packages/core/tests/monthly-spending.test.ts`.

## UI rules that follow

- The headline number is external outflow. It is labelled "money out", not "total".
- Excluded transfers are **always disclosed**, never silently dropped. A user reconciling against a bank statement must be able to find the difference. The disclosure states the amount and, on expansion, what the total would have been if double-counted.
- Filtering to one account **re-labels the number**. Filtered to a credit card, the figure is that card's spending, not the user's spending. The label changes with the filter so the number cannot be misread.
- Savings transfers are never described as spending, and never described as saving *failures*. Per `D-006` they are movements, stated neutrally.
- `UNCLASSIFIED` flows are surfaced for the user to resolve, in the same spirit as an `UNKNOWN` affordability result.
