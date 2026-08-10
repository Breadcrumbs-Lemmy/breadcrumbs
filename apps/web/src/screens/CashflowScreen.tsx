/**
 * Cash-flow calendar — what's coming up before the next paycheck, and how low
 * the balance dips in between.
 *
 * Reached from the Spending (Pulse) screen via a button card, never a nav tab
 * (`D-C12`: a new nav slot would break the C·A·P·I·T·A·L acrostic). The whole
 * screen is **read-only** (`D-002`): a schedule and a projected low, nothing
 * prescriptive, and it never moves money.
 *
 * Every figure is computed server-side by core `buildCashFlowCalendar` (`CD-011`
 * — no browser arithmetic): the event amounts, the running balance, the totals,
 * the intraday low and the outlook status all arrive pre-computed. This screen
 * formats cents and dates and lays them out; it sums nothing.
 *
 * Word-first status (`D-C11`, `D-006`): the outlook word (Clear / Tight /
 * Shortfall / Unknown) and each event's status word carry the meaning; colour is
 * decoration on top — `--accent` for inflow, neutral ink for outflow, `--alert`
 * only on a shortfall.
 */
import { useCallback, useEffect, useState } from "react";
import type { CashFlowCalendar, CashFlowEvent, CashFlowOutlookStatus } from "@ai-fin-os/core";
import { loadCashflow, type CashflowOutcome } from "../services/cashflow";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";
import { Card, SectionLabel, Segmented } from "../components/ui";
import { LogoMark } from "../components/Logo";

/** The horizon presets offered in the UI. Server clamps to [7, 60] (`D-C3`); all
 *  three sit inside that range, so a preset can never be rejected. */
const HORIZONS = ["30", "45", "60"] as const;
type HorizonChoice = (typeof HORIZONS)[number];
const DEFAULT_HORIZON: HorizonChoice = "45";

/** Word + restrained tone per outlook status (`D-C11`). The word is always
 *  present; only a shortfall earns the alert hue — everything else stays neutral
 *  or accent so colour is never the sole signal. */
const OUTLOOK_META: Record<
  CashFlowOutlookStatus,
  { label: string; color: string; soft: string; caption: string }
> = {
  clear: {
    label: "Clear",
    color: "var(--accent)",
    soft: "var(--accent-soft)",
    caption: "Your projected low stays above your cash buffer.",
  },
  tight: {
    label: "Tight",
    color: "var(--text-primary)",
    soft: "var(--surface-sunken)",
    caption: "Your projected low dips into your cash buffer before payday.",
  },
  shortfall: {
    label: "Shortfall",
    color: "var(--alert)",
    soft: "var(--alert-soft)",
    caption: "Your projected balance goes negative before the next paycheck lands.",
  },
  unknown: {
    label: "Unknown",
    color: "var(--text-tertiary)",
    soft: "var(--surface-sunken)",
    caption: "No account balance is known, so the low can't be projected — the schedule still shows.",
  },
};

/** Word per event status (`D-C11`). Rendered verbatim next to each event. */
const EVENT_STATUS_LABEL: Record<CashFlowEvent["status"], string> = {
  scheduled: "Scheduled",
  expected: "Expected",
  estimated: "Estimated",
};

export function CashflowScreen({ onBack, onImport }: { onBack: () => void; onImport?: () => void }) {
  const [outcome, setOutcome] = useState<CashflowOutcome | null>(null);
  const [horizon, setHorizon] = useState<HorizonChoice>(DEFAULT_HORIZON);

  const load = useCallback(async (days: HorizonChoice) => {
    setOutcome(null);
    setOutcome(await loadCashflow(Number(days)));
  }, []);

  useEffect(() => {
    void load(horizon);
  }, [load, horizon]);

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-1 text-label text-ink-secondary transition-colors hover:text-ink"
        >
          ‹ Pulse
        </button>
        <h1 className="font-display text-[1.6rem] font-medium text-ink">What's coming up</h1>
        <p className="mt-1 max-w-[56ch] text-body text-ink-secondary">
          The income and recurring bills expected over the next few weeks, with a running balance
          drawn through them — so you can see what hits before your next paycheck, and how low you
          get in between. This never moves money.
        </p>
      </div>

      {/* Horizon window. All three presets sit inside the server's [7, 60] clamp,
          so switching only ever narrows or widens the same projection. */}
      <div className="mb-6 w-full sm:max-w-[320px]">
        <Segmented
          ariaLabel="Forecast window"
          value={horizon}
          onChange={setHorizon}
          options={HORIZONS.map((h) => ({ value: h, label: `${h} days` }))}
        />
      </div>

      {outcome === null && <Skeleton />}

      {outcome?.kind === "empty" && (
        <Card className="max-w-[560px] text-center">
          <div className="mb-4 flex justify-center">
            <LogoMark size={46} beacon />
          </div>
          <p className="font-display text-[1.35rem] font-medium text-ink">Nothing to project yet</p>
          <p className="mx-auto mt-2 max-w-[44ch] text-body text-ink-secondary">
            Import a statement and this becomes a calendar of your expected paychecks and recurring
            bills, with the projected low before your next payday.
          </p>
          {onImport && (
            <button
              type="button"
              onClick={onImport}
              className="mt-5 min-h-[40px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover"
            >
              Import a statement
            </button>
          )}
        </Card>
      )}

      {outcome?.kind === "error" && (
        <Card className="max-w-[560px]">
          <p className="text-body">Couldn't load your cash-flow calendar.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {outcome?.kind === "ready" && <CalendarBody calendar={outcome.calendar} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CalendarBody({ calendar }: { calendar: CashFlowCalendar }) {
  const hasEvents = calendar.events.length > 0;

  return (
    <div className="space-y-8">
      <Outlook calendar={calendar} />

      <Totals calendar={calendar} />

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <SectionLabel>The next {calendar.horizonDays} days</SectionLabel>
          <span className="text-meta text-ink-tertiary">
            {formatDate(calendar.horizonStartDate, calendar.asOfDate)} –{" "}
            {formatDate(calendar.horizonEndDate, calendar.asOfDate)}
          </span>
        </div>

        {hasEvents ? (
          <Timeline calendar={calendar} />
        ) : (
          <Card className="text-center">
            <p className="text-body text-ink">Nothing scheduled in this window.</p>
            <p className="mx-auto mt-1 max-w-[44ch] text-meta text-ink-tertiary">
              No recurring income or bills were detected between{" "}
              {formatDate(calendar.horizonStartDate, calendar.asOfDate)} and{" "}
              {formatDate(calendar.horizonEndDate, calendar.asOfDate)}. Widen the window, or import
              more history so a cadence can be recognised.
            </p>
          </Card>
        )}
      </section>

      <p className="text-meta text-ink-tertiary">
        Projected from your latest activity on {formatDate(calendar.asOfDate)}, not today's date — the
        same “now” the rest of the app uses. Amounts are the expected figures; a bill or paycheck can
        land a little higher or lower.
        {calendar.notes.accountsMissingBalance.length > 0 && (
          <> No balance is set for {joinNames(calendar.notes.accountsMissingBalance)}, so the running
          line below leaves it out.</>
        )}
      </p>
    </div>
  );
}

/**
 * The headline: the projected low over the horizon and a word-first outlook.
 * When no balance is known the low can't be drawn (`D-C8`) — the word is
 * "Unknown" and the caption says why, rather than inventing a number.
 */
function Outlook({ calendar }: { calendar: CashFlowCalendar }) {
  const meta = OUTLOOK_META[calendar.outlook.status];
  const known = calendar.lowestBalance !== null;

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-label text-ink-tertiary">Outlook before payday</p>
          <div className="mt-1.5 flex items-center gap-2.5">
            <span
              className="rounded-pill px-2.5 py-0.5 text-body font-medium"
              style={{ color: meta.color, background: meta.soft }}
            >
              {meta.label}
            </span>
          </div>
          <p className="mt-2 max-w-[42ch] text-meta text-ink-secondary">{meta.caption}</p>
        </div>

        <div className="sm:text-right">
          <p className="text-label text-ink-tertiary">Projected low</p>
          {known ? (
            <>
              <p
                className="numeral mt-1 whitespace-nowrap text-figure"
                style={{ color: calendar.lowestBalance!.balanceCents < 0 ? "var(--alert)" : "var(--text-primary)" }}
              >
                {formatMoney(calendar.lowestBalance!.balanceCents)}
              </p>
              <p className="mt-1 text-meta text-ink-tertiary">
                on {formatDate(calendar.lowestBalance!.date, calendar.asOfDate)}
              </p>
            </>
          ) : (
            <p className="numeral mt-1 text-figure text-ink-tertiary">—</p>
          )}
        </div>
      </div>

      {known && (
        <p className="mt-4 border-t border-line-subtle pt-3 text-meta text-ink-tertiary">
          Measured against a {formatMoney(calendar.outlook.minimumCashBufferCents)} cash buffer, from
          an opening balance of {formatMoney(calendar.openingBalanceCents)}.
        </p>
      )}
    </Card>
  );
}

/** Expected in / out / net over the horizon, plus the next expected paycheck. */
function Totals({ calendar }: { calendar: CashFlowCalendar }) {
  const { totals } = calendar;
  return (
    <div>
      <SectionLabel>Over this window</SectionLabel>
      <Card padded={false} className="overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-3">
          <div className="border-b border-line-subtle p-5 sm:border-b-0 sm:border-r">
            <p className="text-label text-ink-tertiary">Expected in</p>
            <p className="numeral mt-1.5 whitespace-nowrap text-figure" style={{ color: "var(--accent)" }}>
              {formatMoney(totals.inflowCents)}
            </p>
            <p className="mt-1 text-meta text-ink-tertiary">
              {countLabel(totals.incomeEventCount, "paycheck", "paychecks")}
            </p>
          </div>
          <div className="border-b border-line-subtle p-5 sm:border-b-0 sm:border-r">
            <p className="text-label text-ink-tertiary">Expected out</p>
            <p className="numeral mt-1.5 whitespace-nowrap text-figure text-ink">
              {formatMoney(totals.outflowCents)}
            </p>
            <p className="mt-1 text-meta text-ink-tertiary">
              {countLabel(totals.obligationEventCount, "bill", "bills")}
            </p>
          </div>
          <div className="p-5">
            <p className="text-label text-ink-tertiary">Net</p>
            <p
              className="numeral mt-1.5 whitespace-nowrap text-figure"
              style={{ color: totals.netCents >= 0 ? "var(--accent)" : "var(--text-primary)" }}
            >
              {totals.netCents >= 0 ? "+" : "−"}
              {formatMoney(Math.abs(totals.netCents))}
            </p>
            {calendar.nextReliableIncomeDate && (
              <p className="mt-1 text-meta text-ink-tertiary">
                next paycheck {formatDate(calendar.nextReliableIncomeDate, calendar.asOfDate)}
              </p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * The event ledger. Date-ordered, outflows before inflows on the same day
 * (`D-C6`, backend-sorted). The date is shown once per day; each row carries the
 * signed amount and the running balance after it, and the row at the projected
 * intraday low is marked.
 */
function Timeline({ calendar }: { calendar: CashFlowCalendar }) {
  const lowId = lowestBalanceEventId(calendar);
  let lastDate = "";

  return (
    <Card padded={false} className="overflow-hidden">
      {calendar.events.map((event, i) => {
        const showDate = event.date !== lastDate;
        lastDate = event.date;
        const isLow = event.id === lowId;
        const inflow = event.kind === "income";

        return (
          <div
            key={event.id}
            className={`px-5 py-3.5 sm:px-6 ${i ? "border-t border-line-subtle" : ""} ${
              isLow ? "bg-alert-soft" : ""
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-3">
                <span
                  className={`w-[52px] shrink-0 text-meta tabular ${
                    showDate ? "text-ink-secondary" : "text-transparent"
                  }`}
                  aria-hidden={!showDate}
                >
                  {formatDate(event.date, calendar.asOfDate)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink">{event.label}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-meta text-ink-tertiary">
                    <span>{EVENT_STATUS_LABEL[event.status]}</span>
                    {inflow && event.variability && event.variability !== "fixed" && (
                      <span className="rounded-pill bg-surface-sunken px-1.5 py-0.5">
                        {event.variability}
                      </span>
                    )}
                    {!inflow && !event.required && (
                      <span className="rounded-pill bg-surface-sunken px-1.5 py-0.5">flexible</span>
                    )}
                    {isLow && (
                      <span style={{ color: "var(--alert)" }}>lowest point</span>
                    )}
                  </span>
                </span>
              </span>

              <span className="shrink-0 text-right">
                <span
                  className="tabular block whitespace-nowrap text-amount"
                  style={{ color: inflow ? "var(--accent)" : "var(--text-primary)" }}
                >
                  {inflow ? "+" : "−"}
                  {formatMoney(Math.abs(event.amountCents))}
                </span>
                {event.balanceAfterCents !== null && (
                  <span className="tabular mt-0.5 block whitespace-nowrap text-meta text-ink-tertiary">
                    {formatMoney(event.balanceAfterCents)}
                  </span>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ---------------------------------------------------------------------------

/** The id of the event at which the projected intraday low is reached, so the
 *  ledger can mark that exact row. Finds the *first* event on the low's date
 *  whose running balance equals the low — the backend walks events in the same
 *  conservative order, so the first match is the moment the low is hit. */
function lowestBalanceEventId(calendar: CashFlowCalendar): string | null {
  const low = calendar.lowestBalance;
  if (!low) return null;
  const hit = calendar.events.find(
    (e) => e.date === low.date && e.balanceAfterCents === low.balanceCents,
  );
  return hit?.id ?? null;
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Checking", or "Checking and Savings", or "Checking, Savings and Brokerage". */
function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="skeleton h-[140px] rounded-lg" />
      <div className="skeleton h-[120px] rounded-lg" />
      <div className="skeleton h-[320px] rounded-lg" />
    </div>
  );
}
