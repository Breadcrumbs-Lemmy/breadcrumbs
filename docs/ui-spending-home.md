# Spending Home Specification

Status: Living — implemented (`S-003`). Week, month, and year are live; statement is off pending a closing-day source.  
Owner: `[UI: Claude]`  
Last updated: 2026-08-06

## Purpose

The product's primary surface. Answers "where is my money going?" across every connected account and institution (`D-011`).

Every figure comes from `SpendingSummary`. The UI performs no aggregation, classification, netting, or period arithmetic (`CD-003`, `H-015`, `H-022`).

## Status

Design validated with the user across four iterations, then built. `apps/web/src/screens/SpendingScreen.tsx` is the implementation; the app opens on it.

Data comes from `GET /api/v1/spending/summary` for the selected period and `GET /api/v1/spending/series` for period navigation, both via `services/spending.ts`.

**Week, month, and year are live.** All three are bucketed by `packages/core/src/domain/periods.ts`; the browser buckets nothing (`CD-003`). The period chips offer only periods that actually contain activity, so a three-month history does not present nine empty months to click through.

**Statement is switched off** in `PERIOD_SUPPORTED` and renders an explicit "not available yet" state. The backend computes statement periods, but it needs `account.statementCycle.closingDay` and CSV import captures none — without one, `summarizeSpending` falls back to a calendar month, which is precisely the mismatch this period kind exists to expose. Showing a calendar month under a "Statement" label would be worse than showing nothing. Open half of `H-018`.

An unsupported period issues no request at all. It previously fired one, took a 400, and rendered "Couldn't load your spending — start the API" over a healthy API.

## Known compromise: the hero figure

`text-hero` (2.75rem) needs roughly 23px per character, and a third of this card is 160px of content at a 1280px viewport — six characters. Real totals are longer, and `$6,704.48` ran under the divider into "Came in". The screen now steps the figure down one size past six characters, which fixes the collision but loses the intended dominance for most real months. A wider hero cell, or a rounded headline figure with exact amounts kept in the rows below, would both keep the emphasis. Worth a design decision rather than leaving the current threshold as the answer.

## Destinations

Three, replacing the previous affordability-first model:

| Destination | Job |
| --- | --- |
| **Spending** (default) | Where money went this month |
| **Transfers** | Money moved between the user's own accounts, and anything unresolvable |
| **Accounts** | Per-institution and per-account attribution |

Affordability is reachable from Spending as a secondary action. It is no longer a top-level destination.

## Screen 1: Spending

### Hero

Money in and money out at **equal visual weight**, with "left over" beneath.

```
Came in                Went out
$4,580                 $2,707
────────────────────────────────
Left over              +$1,873
```

This was a user decision after seeing both options. Spending-as-hero was the first proposal; the user chose equal billing so the difference is visible. August is the case that justifies it — `$2,707` out reads as a heavy month in isolation, but `+$1,873` left over is the fact that actually matters.

| Element | Source |
| --- | --- |
| Came in | `totalInflowCents` |
| Went out | `totalOutflowCents` |
| Left over | `totalInflowCents - totalOutflowCents` |
| Proportion bar | ratio of the two above |

The "left over" subtraction is the one arithmetic operation the UI performs. It is a display composition of two adjacent backend figures, not a financial derivation — but if a backend `netCents` appears it should be used instead.

### Comparison

One line, only on complete months: `Spending up $376 on the month before`, from `comparison.direction` and `comparison.outflowChangeCents`.

**Suppressed entirely on partial months.** August at three days compared against a full July is a false comparison, and pacing logic is not specified. The screen says "part-way through the month" and offers no number. Inventing a comparison here would be exactly the false precision the charter forbids.

### Categories

From `categoryTotals`, backend-ordered. Top six, remainder behind a count.

Each row: name, amount, proportional bar, and a delta where `direction` is `up` or `down` and the change clears a noticing threshold. Categories that did not move stay silent, so the ones that did read as signal. `direction: "new"` renders as "new" rather than a percentage against zero.

Refunds render in place: `Shopping $147, after $68 back`, using `outflowCents` with `refundCents` alongside.

**Negative categories.** A refund posting in a month with no matching spend yields a negative `outflowCents`. Confirmed intended in `H-016`. Renders as a negative figure with **no proportional bar** — a share-of-month bar has no meaningful width below zero.

**Cash withdrawals** arrive as a `cash` category. Correct per taxonomy rule 6, but it is not a merchant purchase and should not look like one. Distinct treatment pending.

**Category labels.** Read `categoryTotals[].displayName`, delivered by `S-004` under `H-021`. The UI holds no label map. A UI-side map would have drifted silently the first time a category was renamed; backend-owned labels make that a contract change instead.

### Account filter

Filters by account or institution, reading `accountTotals` and `institutionTotals`. No UI re-aggregation.

**Filtering re-labels the figure.** Filtered to a credit card, the number is that card's spending, not the user's. The label changes with the filter so it cannot be misread. Category breakdown stays combined and says so.

### Secondary action

One line to affordability: `Thinking about a purchase?`. This is the demotion required by `D-011`.

## Screen 2: Transfers

Exists because once money in and money out are both on screen, the difference between them invites the question of where the rest went. A footnote cannot carry that.

### Matched movement

Total from `excludedTransferOutflowCents`, then each movement with origin and destination.

The disclosure is explicit and states the counterfactual:

> Not spending. Paying a card moves money already counted when the card was charged. Counting it twice would show `$5,447` instead of `$2,707`.

That sentence exists because a user reconciling against a bank statement must be able to find the difference. Silently excluding `$2,740` and hoping nobody notices is how a correct number becomes an untrusted one.

### Unresolvable movement

`unclassifiedOutflowCents` renders **separately, in a dashed container**, never mixed with confirmed transfers.

> Not sure about 1 movement
> Venmo Transfer — $220
> Chase Total Checking → an account you haven't connected
> We can't tell whether this was spent or just moved, so it isn't counted either way.
> [Tell us what this was]

The dashed border is the same token used for `UNKNOWN` affordability results. Both mean the same thing: the engine declined to assert something, and the interface will not assert it either.

## Screen 3: Accounts

Grouped by institution, from `institutionTotals` and `accountTotals`. Each account shows outflow and, where non-zero, inflow. Type is labelled — credit cards and savings behave differently and should not read as interchangeable.

Carries the `NO_ACCOUNT_WRITES` boundary.

## States

| State | Treatment |
| --- | --- |
| No transactions | `No transactions yet.` Not an error — the affordability engine works without them. |
| Partial month | Figures shown, comparison suppressed, labelled "part-way through the month" |
| Partial history | Comparison labelled with its actual baseline count rather than implying a full year |
| No transfers in period | Plain statement, not an empty card |
| Filtered to a zero-activity account | `$0` is a real answer here and renders as `$0`, not an em-dash |

Note the last row is a deliberate exception to the em-dash rule in `ui-design-system.md`. `$0` spending on a connected account with complete data is a known fact. The em-dash is reserved for *unknown*, not *zero*.

## Visual direction

Established in `ui-design-system.md` tokens. Specific to this surface:

- **Warm paper background**, not white. Financial interfaces trend clinical; this product handles anxious subject matter.
- **One accent** carrying all emphasis, at decreasing opacity down the category list. Proportion is communicated by bar length, not by hue.
- **No category colour coding.** A rainbow palette would imply that categories carry different moral weight. Per `D-006`, a grocery total is a fact, not a verdict.
- **Deltas in low-chroma clay and slate**, never red and green. Spending more on groceries is information. Red would make it an accusation.
- **Red is reserved** for genuine warnings and the zero line on a forecast. It never appears on the spending home.

## Contract dependencies

| Need | Field | Status |
| --- | --- | --- |
| Money out, net | `totalOutflowCents` | Available |
| Money out, gross | `grossOutflowCents` | Available |
| Money in | `totalInflowCents` | Available |
| Refunds | `refundCents` | Available |
| Categories net of refunds | `categoryTotals[]` | Available |
| Account attribution | `accountTotals[]` | Available |
| Institution attribution | `institutionTotals[]` | Available |
| Excluded transfers | `excludedTransferOutflowCents` | Available |
| Card payments specifically | `excludedCreditCardPaymentOutflowCents` | Available |
| Unresolvable movement | `unclassifiedOutflowCents` | Available |
| Period comparison | `comparison` | Available |
| Category display labels | `categoryTotals[].displayName` | Available since `S-004` / `H-021`. The UI stopgap map was never committed and is not needed. |
| Merchant surface | `merchantTotals[]` | Available, not yet designed in |

## Verification checklist

Before this screen is called done:

- [ ] Every figure traces to a named `MonthlySpendingSummary` field
- [ ] No transfer classification, matching, refund netting, rollup, or period subtraction in UI code
- [ ] Transfers always disclosed, never silently dropped
- [ ] Unresolvable movement rendered as uncertainty, never as spending or as a confirmed transfer
- [ ] Negative categories render without a bar
- [ ] Filtering re-labels the headline
- [ ] Partial months carry no comparison
- [ ] No control implies money movement
- [ ] Level and status distinguishable without colour
