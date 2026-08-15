/**
 * The cash-flow calendar: the snapshot's income and obligations, laid out on a
 * forward timeline with a running balance drawn through them.
 *
 * This computes nothing new. Income sources and recurring obligations are already
 * derived from the user's history by `buildSnapshotFromHistory`, each already
 * carries a `Cadence`, and `expandCadence` already knows how to roll a cadence
 * forward over a date range. The calendar is those facts on a timeline — a
 * *description* of what is scheduled to happen, not a verdict about it.
 *
 * The load-bearing distinction from the affordability engine (`docs/cashflow.md`):
 *
 *  - The engine answers "can I afford this?" **conservatively** — income planned
 *    around its bad month, a strict solvency gate. That belongs on Check.
 *  - The calendar answers "what's coming up, and how low do I get?" using the
 *    **expected** figures, so the event list and the running balance always agree
 *    and the user can recognise their own schedule. It is descriptive, never a
 *    solvency guarantee (`D-C5`).
 *
 * Everything is integer cents and deterministic: the horizon is anchored to the
 * passed `asOfDate` (the snapshot's latest posted date), never the wall clock
 * (`D-C4`, `CD-011`).
 */
import { addDays, compareDates } from "./dates";
import { expandCadence } from "./recurrence";
import type { Account, ForecastConfig, IncomeSource, RecurringObligation } from "./types";

/** A wider descriptive window than the affordability verdict's 30 days: 45 days
 *  spans a full monthly cycle and usually two biweekly paychecks (`D-C3`). */
const DEFAULT_HORIZON_DAYS = 45;
const MIN_HORIZON_DAYS = 7;
const MAX_HORIZON_DAYS = 60;
/** Fallbacks used only when the caller passes no snapshot config. The server
 *  always passes `snapshot.config`, so these match `DEFAULT_FORECAST_CONFIG`. */
const DEFAULT_MINIMUM_CASH_BUFFER_CENTS = 25_000;
const DEFAULT_RELIABLE_INCOME_CONFIDENCE = 0.8;

export type CashFlowEventKind = "income" | "obligation";

/** Word-first status the UI renders verbatim (`D-C11`, `D-006`). */
export type CashFlowEventStatus = "scheduled" | "expected" | "estimated";

export type CashFlowOutlookStatus = "clear" | "tight" | "shortfall" | "unknown";

export type CashFlowEvent = {
  /** `${sourceEntityId}@${date}` — unique per projected occurrence. */
  id: string;
  sourceEntityId: string;
  kind: CashFlowEventKind;
  date: string;
  label: string;
  /** Signed: positive for inflow (income), negative for outflow (obligation). */
  amountCents: number;
  /** Obligations only: whether it is a required bill vs. optional/flexible. */
  required: boolean;
  /** Income only: how much the observed amount varied. */
  variability?: IncomeSource["variability"];
  status: CashFlowEventStatus;
  /** 0..1, from the source entity's own uncertainty. */
  confidence: number;
  /** Running balance immediately after this event applies, or `null` when no
   *  opening balance is known (`D-C8`). */
  balanceAfterCents: number | null;
};

export type CashFlowCalendar = {
  asOfDate: string;
  horizonStartDate: string;
  horizonEndDate: string;
  horizonDays: number;
  currency: string;
  /** Opening spendable cash, or `null` when no forecast-included cash account
   *  carries a known balance (`D-C8`, `D-C9`). */
  openingBalanceCents: number | null;
  /** Date-ordered; outflows precede inflows on the same day (`D-C6`). */
  events: CashFlowEvent[];
  /** End-of-day running balance per horizon day; empty when balance is unknown. */
  dailyBalances: { date: string; balanceCents: number }[];
  totals: {
    inflowCents: number;
    /** Sum of outflow magnitudes (a positive number). */
    outflowCents: number;
    netCents: number;
    incomeEventCount: number;
    obligationEventCount: number;
  };
  /** The lowest point the running balance reaches over the horizon, measured
   *  intraday after each event in conservative order (`D-C7`). `null` when no
   *  opening balance is known. */
  lowestBalance: { balanceCents: number; date: string } | null;
  /** First income at/above the reliability threshold — the "next payday". */
  nextReliableIncomeDate?: string;
  outlook: {
    status: CashFlowOutlookStatus;
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

export type BuildCashFlowCalendarOptions = {
  incomeSources: IncomeSource[];
  recurringObligations: RecurringObligation[];
  accounts: Account[];
  /** The deterministic anchor — the snapshot's latest posted date (`D-C4`). */
  asOfDate: string;
  currency: string;
  /** Days forward from `asOfDate`; defaults to 45, clamped to [7, 60] (`D-C3`). */
  horizonDays?: number;
  config?: Partial<Pick<ForecastConfig, "minimumCashBufferCents" | "reliableIncomeConfidence">>;
};

export function buildCashFlowCalendar(options: BuildCashFlowCalendarOptions): CashFlowCalendar {
  const currency = options.currency.toUpperCase();
  const asOfDate = options.asOfDate;
  const horizonDays = clampHorizon(options.horizonDays ?? DEFAULT_HORIZON_DAYS);
  // The calendar shows the future: from the day after the anchor through the
  // horizon end. Derived `nextExpectedDate`/`nextDueDate` are already strictly
  // after `asOfDate`, so nothing lands on the anchor day itself.
  const horizonStartDate = addDays(asOfDate, 1);
  const horizonEndDate = addDays(asOfDate, horizonDays);
  const minimumCashBufferCents =
    options.config?.minimumCashBufferCents ?? DEFAULT_MINIMUM_CASH_BUFFER_CENTS;
  const reliableIncomeConfidence =
    options.config?.reliableIncomeConfidence ?? DEFAULT_RELIABLE_INCOME_CONFIDENCE;

  const opening = openingSpendableCash(options.accounts, currency);

  const activeIncome = options.incomeSources.filter(
    (source) => source.active && (source.currency ?? currency).toUpperCase() === currency,
  );
  const activeObligations = options.recurringObligations.filter(
    (obligation) =>
      obligation.active && (obligation.currency ?? currency).toUpperCase() === currency,
  );

  const events: CashFlowEvent[] = [];

  for (const income of activeIncome) {
    for (const date of expandCadence(
      income.cadence,
      income.nextExpectedDate,
      horizonStartDate,
      horizonEndDate,
    )) {
      events.push({
        id: `${income.id}@${date}`,
        sourceEntityId: income.id,
        kind: "income",
        date,
        label: income.label,
        amountCents: Math.abs(income.expectedAmountCents),
        required: false,
        variability: income.variability,
        status: incomeStatus(income),
        confidence: income.uncertainty.confidence,
        balanceAfterCents: null,
      });
    }
  }

  for (const obligation of activeObligations) {
    for (const date of expandCadence(
      obligation.cadence,
      obligation.nextDueDate,
      horizonStartDate,
      horizonEndDate,
    )) {
      events.push({
        id: `${obligation.id}@${date}`,
        sourceEntityId: obligation.id,
        kind: "obligation",
        date,
        label: obligation.label,
        amountCents: -Math.abs(obligation.amountCents),
        required: obligation.required,
        status: obligationStatus(obligation),
        confidence: obligation.uncertainty.confidence,
        balanceAfterCents: null,
      });
    }
  }

  // The event `id` (`sourceEntityId@date`) is the calendar's unique key — it is
  // what the running-balance walk, the lowest-point marker and the UI list are
  // all keyed on. A well-formed snapshot never produces a collision (one source
  // yields one event per date), but the calendar enforces its own invariant
  // rather than trusting the input: two events with the same id are the same
  // projected occurrence and must not be counted, drawn or rendered twice. See
  // the id-collapse in `buildSnapshotFromHistory` (`D-C13`) for the upstream
  // cause this guards against.
  const deduped = dedupeEventsById(events);

  deduped.sort(compareEvents);

  let inflowCents = 0;
  let outflowCents = 0;
  let incomeEventCount = 0;
  let obligationEventCount = 0;
  for (const event of deduped) {
    if (event.amountCents >= 0) {
      inflowCents += event.amountCents;
      incomeEventCount += 1;
    } else {
      outflowCents += -event.amountCents;
      obligationEventCount += 1;
    }
  }

  let dailyBalances: { date: string; balanceCents: number }[] = [];
  let lowestBalance: { balanceCents: number; date: string } | null = null;

  if (opening.cents !== null) {
    // Walk the events in conservative order, recording the balance after each and
    // the lowest point reached. The opening balance itself is a candidate low: if
    // every event is an inflow, the horizon start is the lowest you get.
    let running = opening.cents;
    let low = running;
    let lowDate = horizonStartDate;
    for (const event of deduped) {
      running += event.amountCents;
      event.balanceAfterCents = running;
      if (running < low) {
        low = running;
        lowDate = event.date;
      }
    }
    lowestBalance = { balanceCents: low, date: lowDate };
    dailyBalances = buildDailyBalances(opening.cents, deduped, horizonStartDate, horizonEndDate);
  }

  const reliableIncomeIds = new Set(
    activeIncome
      .filter(
        (source) =>
          source.reliability !== "uncertain" &&
          source.uncertainty.confidence >= reliableIncomeConfidence,
      )
      .map((source) => source.id),
  );
  const nextReliableIncomeDate = deduped.find(
    (event) => event.kind === "income" && reliableIncomeIds.has(event.sourceEntityId),
  )?.date;

  const outlookStatus: CashFlowOutlookStatus =
    lowestBalance === null
      ? "unknown"
      : lowestBalance.balanceCents < 0
        ? "shortfall"
        : lowestBalance.balanceCents < minimumCashBufferCents
          ? "tight"
          : "clear";

  return {
    asOfDate,
    horizonStartDate,
    horizonEndDate,
    horizonDays,
    currency,
    openingBalanceCents: opening.cents,
    events: deduped,
    dailyBalances,
    totals: {
      inflowCents,
      outflowCents,
      netCents: inflowCents - outflowCents,
      incomeEventCount,
      obligationEventCount,
    },
    lowestBalance,
    ...(nextReliableIncomeDate ? { nextReliableIncomeDate } : {}),
    outlook: {
      status: outlookStatus,
      lowestBalanceCents: lowestBalance?.balanceCents ?? null,
      minimumCashBufferCents,
    },
    notes: {
      balanceKnown: opening.cents !== null,
      accountsMissingBalance: opening.missing,
      incomeSourceCount: activeIncome.length,
      obligationCount: activeObligations.length,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Opening spendable cash, using the exact convention the affordability engine
 * uses (`calculateOpeningSpendableCash`) so the calendar's starting number
 * reconciles to the Check screen's (`D-C9`).
 *
 * Returns `null` cents when no included cash account carries a *known* balance —
 * a balance that is `estimated` or `missing` is not one the projection can trust,
 * and a projection drawn from a guessed balance would be a guess wearing a
 * number (`D-C8`).
 */
function openingSpendableCash(
  accounts: Account[],
  currency: string,
): { cents: number | null; missing: string[] } {
  const included = accounts.filter(
    (account) =>
      account.currency.toUpperCase() === currency &&
      account.includeInForecast &&
      (account.role === "spendable_cash" || account.role === "reserve_cash"),
  );

  const missing: string[] = [];
  let total = 0;
  let knownCount = 0;
  for (const account of included) {
    if (!hasKnownBalance(account)) {
      missing.push(account.displayName);
      continue;
    }
    total +=
      account.availableBalanceCents !== undefined
        ? Math.min(account.currentBalanceCents, account.availableBalanceCents)
        : account.currentBalanceCents;
    knownCount += 1;
  }

  return { cents: knownCount === 0 ? null : total, missing };
}

function hasKnownBalance(account: Account): boolean {
  return account.freshness.status !== "estimated" && account.freshness.status !== "missing";
}

/**
 * End-of-day running balance for each horizon day. Order within a day does not
 * matter here — the sum is the same — so this reads the (already sorted) events
 * with a single forward pointer.
 */
function buildDailyBalances(
  opening: number,
  events: CashFlowEvent[],
  horizonStartDate: string,
  horizonEndDate: string,
): { date: string; balanceCents: number }[] {
  const result: { date: string; balanceCents: number }[] = [];
  let running = opening;
  let index = 0;
  for (
    let day = horizonStartDate;
    compareDates(day, horizonEndDate) <= 0;
    day = addDays(day, 1)
  ) {
    while (index < events.length && events[index]!.date === day) {
      running += events[index]!.amountCents;
      index += 1;
    }
    result.push({ date: day, balanceCents: running });
  }
  return result;
}

/**
 * Enforces the calendar's unique-key invariant: at most one event per `id`
 * (`sourceEntityId@date`), keeping the first. A well-formed snapshot never
 * collides, but two events with the same id are the same projected occurrence,
 * and letting a duplicate through would count the amount twice in the totals,
 * apply it twice to the running balance, and hand the UI two rows with the same
 * React key (`D-C13`). Deterministic and order-independent — the caller sorts
 * afterward — so the survivor is well-defined for identical duplicates.
 */
function dedupeEventsById(events: CashFlowEvent[]): CashFlowEvent[] {
  const seen = new Set<string>();
  const result: CashFlowEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    result.push(event);
  }
  return result;
}

/** Date ascending; on the same day, outflows before inflows (`D-C6`), then id. */
function compareEvents(left: CashFlowEvent, right: CashFlowEvent): number {
  const byDate = compareDates(left.date, right.date);
  if (byDate !== 0) return byDate;
  const leftOrder = left.amountCents < 0 ? 0 : 1;
  const rightOrder = right.amountCents < 0 ? 0 : 1;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function incomeStatus(income: IncomeSource): CashFlowEventStatus {
  if (income.reliability === "confirmed") return "scheduled";
  if (income.reliability === "expected") return "expected";
  return "estimated";
}

function obligationStatus(obligation: RecurringObligation): CashFlowEventStatus {
  return obligation.source === "inferred" ? "estimated" : "scheduled";
}

function clampHorizon(days: number): number {
  const floored = Math.floor(days);
  if (!Number.isFinite(floored)) return DEFAULT_HORIZON_DAYS;
  return Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, floored));
}
