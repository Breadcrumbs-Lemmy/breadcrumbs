# Cash-Flow Calendar

Status: Draft (autonomous session 2026-08-10) — **design decisions D-C1..D-C13 below await the
owner's re-approval.** Nothing here is settled; each decision is logged so it can be confirmed or
changed on return.

Feature #3 from `coordination/FEATURE-IDEAS.md`. A forward-looking, **read-only** view of the
recurring charges and income expected over the next 30–45 days. It answers the question a budget
and a spending summary can't: *"what's about to hit before my next paycheck lands, and how low do
I get in between?"*

## What it is, and what it is not

It is a **projection of the snapshot that already exists**. The affordability engine and the Check
screen already derive income sources and recurring obligations from the user's imported history
(`buildSnapshotFromHistory`) and already know how to roll a cadence forward (`expandCadence`). The
calendar is those two facts, laid out on a timeline, with a running balance drawn through them.

It is **not** a new money classifier, a new store, or a new source of truth. It introduces no
persisted state. It never moves money and never tells the user what to do about a low balance — it
shows the schedule and the projected low, and stops there (charter: read-only decision support, not
personalized advice, `D-002`).

## The two questions it answers

1. **"What's coming up?"** — a date-ordered list of expected income (inflows) and recurring bills
   (outflows) between tomorrow and the horizon end, each with its amount, a plain-word status, and
   how certain it is.
2. **"Do I dip before payday?"** — a single projected **lowest balance** over the horizon and the
   date it occurs, plus a word-first status (*Clear / Tight / Shortfall / Unknown*) comparing that
   low against the same minimum cash buffer the affordability engine uses.

## Design decisions (await re-approval)

### D-C1 — Derived, not stored
The calendar has **no store and no new persisted entity.** It is computed on each request from the
imported statement history, exactly like `/api/v1/affordability/snapshot`. Rationale: the inputs
(income, obligations, balances) already live in the snapshot; persisting a second copy would create
a staleness/￼consistency bug the moment a new statement is imported. A projection should never
outlive its inputs.

### D-C2 — Inputs are income + obligations only (goals excluded from the MVP)
Calendar events are **expected income** (positive) and **recurring obligations** (negative). Savings
**goal contributions are deliberately excluded** from this first version. Rationale: a goal
contribution is typically an *internal transfer* between the user's own accounts (checking →
savings), which nets to roughly zero across the forecast-included cash accounts; counting it as an
outflow would understate available cash and double-count against the balance. The affordability
engine handles goals through a dedicated protected-path mechanism, not as a simple outflow, and the
calendar should not invent a cruder model. Documented as a candidate future addition once
contribution-vs-external classification exists.

### D-C3 — Horizon defaults to 45 days, clamped to [7, 60]
The query accepts `horizon` (days); it defaults to **45** and is clamped to `[7, 60]`. Rationale: 45
days reliably spans at least one full monthly cycle and typically catches two biweekly paychecks, so
the "before payday" low is meaningful for the common pay schedules. `DEFAULT_FORECAST_CONFIG` uses 30
for the affordability *verdict* window; the calendar is a wider descriptive view, so it gets its own
default rather than borrowing that one.

### D-C4 — The anchor is the latest posted date, never the wall clock
"Today" for the calendar is the snapshot's `asOfDate` = the latest posted transaction date. The
horizon is `[asOfDate + 1 day, asOfDate + horizonDays]`. Rationale: determinism (`CD-011`) — the same
imported history must always produce the same calendar. Using `Date.now()` would make the output
drift day to day and make tests non-reproducible. Consequence the UI must state honestly: if the
user's newest transaction is two weeks old, the calendar's "today" is two weeks ago.

### D-C5 — The calendar shows the *expected* path, not a worst case
Each event's amount is the **expected** figure (median income, median bill), and the running balance
is drawn through those same amounts, so the event list and the balance can never disagree. Rationale:
the calendar is *descriptive* — a schedule the user can recognise and check. The conservative,
minimum-income *verdict* stays where it belongs, on the Check screen (the affordability engine still
plans income around its bad month). Keeping the two separate avoids a confusing world where the
calendar shows one paycheck number and the verdict assumes another. Variable income is flagged
per-event (`variability`) so a paycheck that isn't fixed is visibly marked.

### D-C6 — Conservative same-day ordering (outflows before inflows)
When a bill and a paycheck fall on the same calendar day, the running balance counts the **outflow
first**. Rationale: this mirrors the affordability engine's `CONSERVATIVE_SAME_DAY_ORDERING` — bank
posting order within a day is unknowable, so the projected intraday low assumes the least favourable
order. This only affects the *lowest-balance* figure, never the totals.

### D-C7 — The lowest balance is the intraday running low over the whole horizon
`lowestBalance` is the minimum of the running balance taken **after each event in order** (not the
end-of-day balance), so a day whose bill clears before its paycheck is captured at its true low.
This equals the affordability engine's `minimumIntradayBalance`. Its date is the event date at which
the low occurs.

### D-C8 — Balance is optional; the schedule is not
If no forecast-included spendable/reserve-cash account carries a **known** balance (freshness not
`missing`/`estimated`), the running balance, `dailyBalances`, `lowestBalance`, and the outlook status
are all `null`/`unknown` — but the **event list is still returned**. Rationale: a user who imported
transactions but never set a balance can still benefit from seeing *when* things hit; withholding the
schedule because the balance is unknown would help no one. Accounts missing a balance are named in
`notes.accountsMissingBalance` so the UI can say why the low is unknown.

### D-C9 — Opening balance uses the affordability engine's spendable-cash convention
Opening balance = sum over accounts that are `includeInForecast` and role `spendable_cash` or
`reserve_cash`, in the snapshot currency, using `min(current, available)` when an available balance
is present, else current. Rationale: the calendar's balance must reconcile to the same starting
number the Check screen reasons from; reusing the exact convention (rather than re-inventing one)
guarantees they agree.

### D-C10 — A dedicated `CashFlowEvent` type, not `ForecastEvent`
The calendar returns its own `CashFlowEvent` (kind, date, label, signed amount, required, status,
confidence, balance-after), not the engine's internal `ForecastEvent`. Rationale: `ForecastEvent`
carries path-analysis fields (`path`, `requiredCashNeed`, `reliableIncome`) that are meaningful only
inside the affordability solver; exposing them here would leak solver vocabulary into a descriptive
view. The calendar type is display-shaped and self-explanatory.

### D-C11 — Word-first status, colour is decoration (`D-006`)
Every status the calendar emits is a **word** the UI renders verbatim: event status
(`scheduled` / `expected` / `estimated`), and outlook status (`clear` / `tight` / `shortfall` /
`unknown`). Colour (`--accent` for inflow, `--ink` for outflow, `--alert` only on `shortfall`) is
never the sole signal. Rationale: the charter's no-hue-as-verdict rule — a colour-blind user, or one
skimming, must read the meaning in the text.

### D-C12 — Read-only `GET`, on the CORS-safe verb set
The endpoint is `GET /api/v1/cashflow/upcoming` — read-only, no body, no mutation. Rationale: the
calendar computes nothing to persist. `GET` is already on the shared CORS allowlist
(`GET,POST,PATCH,DELETE,OPTIONS`), so no security-relevant allowlist change is needed (see the
`cors-verb-allowlist-blindspot` note that bit Budgets and Goals). The screen is reached from the
Spending (Pulse) screen via a button card, **not** the top nav — a new nav slot would break the
`C·A·P·I·T·A·L` acrostic (same rule Budgets follows).

### D-C13 — Collapse duplicate obligation ids (one bill seen from N accounts is one bill)
**Surfaced by this feature; fixed in shared inference code — flagged for the owner's call.**

Verifying the calendar exposed a pre-existing bug in the *shared* snapshot inference, not in the
calendar itself. The subscription detector (`detectRecurringSpending`) groups candidate charges by
`(merchantId, accountId)`, so a single subscription billed from **N** imported accounts surfaces as
**N** per-account insights — each reducing to the **same** merchant-derived obligation id
(`obligation_inferred_${normalizedMerchantId}`). The snapshot then carried N obligations sharing one
id, which:
- violated the id-uniqueness invariant every downstream consumer assumes,
- **tripled the projected outflow** in the calendar (the live fixture showed 6 bills / $471 where the
  truth is 2 bills / $157), and also inflates the affordability engine's obligation load, and
- handed the timeline UI duplicate React keys (`obligation_inferred_…@date` rendered N times).

**Decision (conservative):** treat same-id occurrences as **one** recurring bill, not N. The fix is
two-layer:
1. **Root** — `buildSnapshotFromHistory` de-duplicates derived obligations by id before returning the
   snapshot, so every consumer (Check, Budgets, and this calendar) sees the corrected set. This is
   the correct home for the fix: the id *is* the identity, and a snapshot must not emit two entities
   claiming to be the same one.
2. **Defense-in-depth** — `buildCashFlowCalendar` also enforces its own event-id uniqueness
   (`sourceEntityId@date`), so the calendar is correct even if some other producer ever emits a
   colliding entity. A well-formed snapshot never trips this second guard.

**The judgement call, for re-approval.** The merchant-only id scheme (`…_${normalizedMerchantId}`)
cannot distinguish *"one membership the user pays from whichever account has funds"* (→ collapse to
one, which we did) from *"two genuinely separate memberships at the same merchant"* (→ these should
sum). The conservative choice avoids the far worse failure — triple-counting a single bill and
scaring the user with a phantom shortfall — but it means two distinct charges at one merchant would
currently under-count. Correcting that properly needs a richer obligation identity (e.g. keyed on
merchant **and** the distinct amount/cadence signature, or on account) rather than merchant alone;
logged as the follow-up if the owner wants genuine multi-membership support. **Awaiting the owner's
call on which behaviour is intended.**

## Shape of the response

```
GET /api/v1/cashflow/upcoming?currency=USD&horizon=45  →  CashFlowCalendar
```

```ts
type CashFlowCalendar = {
  asOfDate: string;               // the deterministic anchor (latest posted date)
  horizonStartDate: string;       // asOfDate + 1
  horizonEndDate: string;         // asOfDate + horizonDays
  horizonDays: number;
  currency: string;
  openingBalanceCents: number | null;   // null when no known balance (D-C8)
  events: CashFlowEvent[];        // date-ordered, conservative same-day order (D-C6)
  dailyBalances: { date: string; balanceCents: number }[];  // [] when balance unknown
  totals: {
    inflowCents: number;          // sum of inflows (positive)
    outflowCents: number;         // sum of outflow magnitudes (positive)
    netCents: number;             // inflow - outflow
    incomeEventCount: number;
    obligationEventCount: number;
  };
  lowestBalance: { balanceCents: number; date: string } | null;  // intraday low (D-C7)
  nextReliableIncomeDate?: string;    // first income at/above the reliability threshold
  outlook: {
    status: "clear" | "tight" | "shortfall" | "unknown";
    lowestBalanceCents: number | null;
    minimumCashBufferCents: number;
  };
  notes: {
    balanceKnown: boolean;
    accountsMissingBalance: string[];
    incomeSourceCount: number;
    obligationCount: number;
  };
};

type CashFlowEvent = {
  id: string;                     // `${sourceEntityId}@${date}` — unique per occurrence
  sourceEntityId: string;
  kind: "income" | "obligation";
  date: string;
  label: string;
  amountCents: number;            // signed: + inflow, - outflow
  required: boolean;              // obligations: required bill vs optional/flexible
  variability?: "fixed" | "variable" | "irregular";  // income only
  status: "scheduled" | "expected" | "estimated";
  confidence: number;            // 0..1, from the source entity's uncertainty
  balanceAfterCents: number | null;   // running balance after this event, or null
};
```

## Charter invariants honoured

- **All arithmetic in core** (`CD-003`, `CD-011`): the browser calls `formatMoney`/`formatDate` on
  values the server already computed. It sums nothing.
- **Deterministic** (`CD-011`): anchored to the latest posted date, not the clock (D-C4).
- **Read-only** (`D-002`): no writes, no advice — a schedule and a projected low, nothing prescriptive.
- **Non-2026 test fixtures** (`CD-012`): calendar tests use 2022/2023 dates and exercise real
  month-length and year boundaries.
- **Encrypted at rest**: no new stored data, so nothing new to encrypt — the projection lives only
  in the response.
