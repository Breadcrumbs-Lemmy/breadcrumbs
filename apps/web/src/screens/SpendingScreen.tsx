/**
 * Spending home — the product's primary surface (`D-011`).
 * Specified in `docs/ui-spending-home.md`.
 *
 * Web first. At desktop the screen is a two-column grid: the figures and the
 * category breakdown on the left, secondary panels on the right. Below `lg` it
 * collapses to one column in the same reading order, so nothing is lost and the
 * layout an iOS build would start from is already correct.
 *
 * Every figure is a named field from `MonthlySpendingSummary`. The one
 * arithmetic operation is `totalInflowCents - totalOutflowCents` for "left
 * over", which composes two adjacent backend figures for display rather than
 * deriving anything financial.
 *
 * Coverage Calendar:
 *   For week/month/year grains the old period-Chip row is replaced by a
 *   SpendingCalendar — one fixed calendar grid that zooms with the toggle
 *   (years → a year's months → a month's weeks) rather than a long list. Cells
 *   with synced data render solid; cells within Plaid's ~24-month reach but not
 *   yet pulled render as "ghost". The user selects a contiguous range at the
 *   current zoom; if it includes ghost cells (and a bank is connected) a
 *   backfill CTA appears. The calendar owns its own view and selection and
 *   reports the resolved {from, to} span up here. Statement periods keep their
 *   original Chip-based navigation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpendingSummary } from "@ai-fin-os/core";
import {
  loadSpending,
  loadStatementAccounts,
  type SpendingOutcome,
  type StatementAccount,
} from "../services/spending";
import {
  fetchSpendingCoverage,
  fetchSpendingSummary,
  fetchSpendingSeries,
  syncConnection,
  type PlaidCoverage,
} from "../services/api";
import { PERIOD_LABELS, isPeriodSupported, type PeriodKind } from "../model/period";
import { seriesKeyToStartDate } from "../model/calendar";
import type { Grain } from "../model/calendar";
import { useAssistantView } from "../services/assistant-scope";
import { categoryColor } from "../model/category-color";
import { formatMoney } from "../format/money";
import { banksAndAccounts } from "../format/counts";
import { Bar, Card, Chip, CountUpMoney, Delta, Segmented, SectionLabel } from "../components/ui";
import { SpendingCalendar } from "../components/SpendingCalendar";
import type { CalendarSpan, FocusSeed } from "../components/SpendingCalendar";
import { LogoMark } from "../components/Logo";
import { issuerLabel } from "../components/BankCard";

const PERIODS: PeriodKind[] = ["week", "month", "year", "statement"];

/** Series-point shape (matches what `fetchSpendingSeries` returns inside `points[]`). */
type SeriesPoint = {
  key: string;
  label: string;
  partial: boolean;
  totalOutflowCents: number;
  totalInflowCents: number;
};

export function SpendingScreen({
  onCheckPurchase,
  onImport,
  onOpenBudgets,
  onOpenCashflow,
  onOpenReport,
}: {
  onCheckPurchase?: () => void;
  onImport?: () => void;
  onOpenBudgets?: () => void;
  onOpenCashflow?: () => void;
  onOpenReport?: () => void;
}) {
  const [period, setPeriod] = useState<PeriodKind>("month");
  const [outcome, setOutcome] = useState<SpendingOutcome | null>(null);
  // monthKey is only used for the statement period's Chip navigation.
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  /** Cards that actually carry a closing day — discovered from the API
   *  per `CD-013`. Without a cycle, the endpoint silently falls back to a
   *  calendar month, which is the confusion this view exists to prevent. */
  const [statementAccounts, setStatementAccounts] = useState<StatementAccount[] | null>(null);
  /** True while a scoped re-fetch is in flight but the previous view is still
   *  on screen — dims in place rather than blinking to a skeleton. */
  const [refreshing, setRefreshing] = useState(false);
  /** Snapshotted from the most recent unscoped load so the account picker
   *  always lists every account even while a filter is applied. */
  const [roster, setRoster] = useState<{
    accounts: SpendingSummary["accountTotals"];
    totalOutflowCents: number;
    bankCount: number;
  } | null>(null);

  // --- Coverage Calendar state -------------------------------------------
  const [coverage, setCoverage] = useState<PlaidCoverage | null>(null);
  /** The resolved {from,to} span the calendar last reported. */
  const [span, setSpan] = useState<CalendarSpan | null>(null);
  /** Seeds the calendar's focused year/month when zooming or drilling. */
  const [focusSeed, setFocusSeed] = useState<FocusSeed | null>(null);
  /** True while a Plaid backfill POST is in flight. */
  const [backfilling, setBackfilling] = useState(false);
  /** Series points for the multi-bucket trend strip. */
  const [trendPoints, setTrendPoints] = useState<SeriesPoint[] | null>(null);

  // ---- Helpers ----------------------------------------------------------------

  const isRailPeriod = period !== "statement";

  const statementReady = (statementAccounts?.length ?? 0) > 0;
  const supported = useCallback(
    (kind: PeriodKind) => (kind === "statement" ? statementReady : isPeriodSupported(kind)),
    [statementReady],
  );

  // Statement periods require an accountId; use the first statement-capable card.
  const statementAccountId = accountId ?? statementAccounts?.[0]?.id;

  const datasetRef = useRef<string | null>(null);

  // ---- Effects ---------------------------------------------------------------

  // 1. Load statement accounts (unchanged).
  useEffect(() => {
    let cancelled = false;
    void loadStatementAccounts().then((next) => !cancelled && setStatementAccounts(next));
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Load Plaid coverage once on mount.
  useEffect(() => {
    let cancelled = false;
    void fetchSpendingCoverage().then((result) => {
      if (cancelled) return;
      if (result.kind === "ok") setCoverage(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 3. Load summary for rail periods (week / month / year) using the calendar's
  //    reported {from, to} span.
  useEffect(() => {
    if (!isRailPeriod) return;
    if (!supported(period)) {
      setOutcome(null);
      datasetRef.current = null;
      return;
    }
    if (span === null) return;

    const { from, to } = span;
    if (!from || !to) return;

    const datasetKey = `${period}|${from}|${to}`;
    const sameDataset = datasetRef.current === datasetKey;
    datasetRef.current = datasetKey;

    if (sameDataset) setRefreshing(true);
    else setOutcome(null);

    const scopedAccount = accountId ?? undefined;
    let cancelled = false;

    void fetchSpendingSummary({ period, from, to, accountId: scopedAccount }).then((result) => {
      if (cancelled) return;
      setRefreshing(false);

      if (result.kind === "error") {
        setOutcome({ kind: "error", message: result.message });
        return;
      }
      if (result.kind === "unauthenticated") {
        setOutcome({ kind: "error", message: "Authentication required." });
        return;
      }
      if (result.kind === "invalid" || result.kind === "rejected") {
        setOutcome({ kind: "error", message: "That request was rejected." });
        return;
      }

      const summary = result.data;
      if (
        summary.totalOutflowCents === 0 &&
        summary.totalInflowCents === 0 &&
        summary.accountTotals.length === 0
      ) {
        setOutcome({ kind: "empty" });
        return;
      }
      setOutcome({ kind: "ready", summary, available: [] });
    });

    return () => {
      cancelled = true;
    };
  }, [isRailPeriod, period, span, accountId, supported]);

  // 4. Load summary for statement periods (original logic preserved).
  useEffect(() => {
    if (isRailPeriod) return;
    if (!supported(period)) {
      setOutcome(null);
      datasetRef.current = null;
      return;
    }
    const datasetKey = `${period}|${monthKey ?? ""}`;
    const sameDataset = datasetRef.current === datasetKey;
    datasetRef.current = datasetKey;
    if (sameDataset) setRefreshing(true);
    else setOutcome(null);
    const scopedAccount = period === "statement" ? statementAccountId : accountId ?? undefined;
    let cancelled = false;
    void loadSpending(period, monthKey ?? undefined, scopedAccount).then((next) => {
      if (cancelled) return;
      setOutcome(next);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isRailPeriod, period, monthKey, accountId, supported, statementAccountId]);

  // 5. Snapshot the all-accounts roster from unscoped loads so the picker
  //    never collapses when a filter is applied.
  useEffect(() => {
    if (outcome?.kind === "ready" && accountId === null && period !== "statement") {
      setRoster({
        accounts: outcome.summary.accountTotals,
        totalOutflowCents: outcome.summary.totalOutflowCents,
        bankCount: outcome.summary.institutionTotals.length,
      });
    }
  }, [outcome, accountId, period]);

  // 6. Load per-sub-period trend data when the span covers more than one unit.
  useEffect(() => {
    if (!span || !span.multi) {
      setTrendPoints(null);
      return;
    }
    if (!isRailPeriod) return;

    const { from, to } = span;
    if (!from || !to) return;

    let cancelled = false;
    void fetchSpendingSeries({ period, count: 100 }).then((result) => {
      if (cancelled || result.kind !== "ok") return;
      const pts = (result.data as { points: SeriesPoint[] }).points;
      // Filter to series points whose start date falls within [from, to].
      const filtered = pts.filter((p) => {
        const start = seriesKeyToStartDate(p.key);
        return start !== null && start >= from && start <= to;
      });
      setTrendPoints(filtered.length > 0 ? filtered : null);
    });

    return () => {
      cancelled = true;
    };
  }, [isRailPeriod, period, span]);

  // ---- Backfill handler -------------------------------------------------------

  const handleBackfill = useCallback(
    async (targetStartDate: string) => {
      if (!coverage || coverage.connections.length === 0) return;
      setBackfilling(true);
      try {
        await Promise.all(
          coverage.connections.map((c) =>
            syncConnection(c.connectionId, { startDate: targetStartDate }),
          ),
        );
        // Re-fetch coverage so the rail reflects newly synced buckets.
        const updated = await fetchSpendingCoverage();
        if (updated.kind === "ok") {
          setCoverage(updated.data);
          // Force summary re-fetch by invalidating the dataset key.
          datasetRef.current = null;
        }
      } finally {
        setBackfilling(false);
      }
    },
    [coverage],
  );

  // ---- Derived values --------------------------------------------------------

  const summary = outcome?.kind === "ready" ? outcome.summary : undefined;
  const statementAvailable = useMemo(
    () => (outcome?.kind === "ready" ? outcome.available : []),
    [outcome],
  );

  const rosterData =
    roster ??
    (summary
      ? {
          accounts: summary.accountTotals,
          totalOutflowCents: summary.totalOutflowCents,
          bankCount: summary.institutionTotals.length,
        }
      : null);
  const selectedAccount =
    accountId && rosterData ? rosterData.accounts.find((a) => a.id === accountId) : undefined;

  const scopedAccount = selectedAccount
    ? { id: selectedAccount.id, label: selectedAccount.displayName }
    : period === "statement" && statementAccountId
      ? {
          id: statementAccountId,
          label: statementAccounts?.find((a) => a.id === statementAccountId)?.displayName,
        }
      : undefined;

  useAssistantView(
    summary
      ? {
          period: {
            kind: summary.period.kind,
            key: summary.period.key,
            label: summary.period.label,
          },
          account: scopedAccount,
        }
      : null,
  );

  // Whether the span covers more than one unit (shows the trend strip).
  const isMultiBucket = span?.multi ?? false;

  return (
    <>
      {/* Controls sit above the grid so they govern the whole page. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-[360px]">
            <Segmented
              ariaLabel="Time period"
              value={period}
              onChange={(next) => {
                setPeriod(next);
                setMonthKey(null);
                setExpanded(false);
                setAccountId(null);
                // Manual toggle → let the calendar pick its own default focus.
                setFocusSeed(null);
                setSpan(null);
              }}
              options={PERIODS.map((p) => ({
                value: p,
                label: PERIOD_LABELS[p],
                muted: !supported(p),
              }))}
            />
          </div>

          {/* Statement period: keep the original Chip navigation. */}
          {period === "statement" && summary && statementAvailable.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              {statementAvailable.map((p) => (
                <Chip
                  key={p.key}
                  active={p.key === summary.period.key}
                  onClick={() => {
                    setMonthKey(p.key);
                    setExpanded(false);
                    setAccountId(null);
                  }}
                >
                  {p.label}
                </Chip>
              ))}
            </div>
          )}
        </div>

        {/* Coverage Calendar — a zooming grid, replaces the Chip row for
            week/month/year. Statement keeps its own Chip navigation above. */}
        {isRailPeriod && (
          <SpendingCalendar
            unit={period as Grain}
            coverage={coverage}
            focusSeed={focusSeed}
            onSelect={(next) => {
              setSpan(next);
              setAccountId(null);
              setExpanded(false);
            }}
            onDrillToWeeks={(year, month) => {
              setFocusSeed({ year, month });
              setPeriod("week");
              setExpanded(false);
              setAccountId(null);
            }}
            onZoomToMonths={(year) => {
              setFocusSeed({ year });
              setPeriod("month");
              setExpanded(false);
              setAccountId(null);
            }}
            onZoomToYears={() => {
              setFocusSeed(null);
              setPeriod("year");
              setExpanded(false);
              setAccountId(null);
            }}
            onBackfill={handleBackfill}
            backfilling={backfilling}
          />
        )}
      </div>

      {!supported(period) && <NotYet period={period} />}
      {supported(period) && outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="mt-6 max-w-[560px]">
          <p className="text-body">Couldn't load your spending.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {outcome?.kind === "empty" && (
        <Card className="mt-6 max-w-[560px] text-center">
          <div className="mb-4 flex justify-center">
            <LogoMark size={46} beacon />
          </div>
          <p className="font-display text-[1.35rem] font-medium text-ink">Nothing here yet</p>
          <p className="mx-auto mt-2 max-w-[38ch] text-body text-ink-secondary">
            Import a statement and your spending will show up here, grouped and compared — follow
            the trail your money left.
          </p>
          <button
            type="button"
            onClick={onImport}
            className="mt-5 min-h-[40px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover"
          >
            Import a statement
          </button>
        </Card>
      )}

      {summary && (
        <div
          key={summary.period.key}
          className={`fade-in mt-6 grid grid-cols-1 gap-5 transition-opacity duration-200 lg:grid-cols-12 ${
            refreshing ? "opacity-60" : "opacity-100"
          }`}
          aria-busy={refreshing}
        >
          {/* ---- Primary column ---------------------------------------- */}
          <div className="space-y-5 lg:col-span-7 xl:col-span-8">
            <Figures summary={summary} accountId={accountId} />

            {/* Trend strip: mini per-sub-period bars across a multi-unit span. */}
            {isMultiBucket && trendPoints && trendPoints.length > 0 && (
              <TrendStrip points={trendPoints} />
            )}

            <div>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <SectionLabel>Where it went</SectionLabel>
                {selectedAccount && (
                  <span className="shrink-0 truncate text-meta text-ink-tertiary">
                    {selectedAccount.displayName} only
                  </span>
                )}
              </div>
              <Categories
                summary={summary}
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
              />
            </div>
          </div>

          {/* ---- Secondary column -------------------------------------- */}
          <div className="space-y-5 lg:col-span-5 xl:col-span-4">
            {rosterData && rosterData.accounts.length > 0 && (
              <AccountsPanel
                accounts={rosterData.accounts}
                bankCount={rosterData.bankCount}
                totalOutflowCents={rosterData.totalOutflowCents}
                selected={accountId}
                onSelect={setAccountId}
              />
            )}
            <Excluded summary={summary} />

            <button
              type="button"
              onClick={onCheckPurchase}
              className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
              style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
            >
              <span>
                <span className="block text-body text-ink">Thinking about a purchase?</span>
                <span className="mt-0.5 block text-meta text-ink-tertiary">
                  See if it fits before you buy
                </span>
              </span>
              <span aria-hidden="true" className="text-ink-tertiary">
                ›
              </span>
            </button>

            {onOpenBudgets && (
              <button
                type="button"
                onClick={onOpenBudgets}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">Budgets</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    Set weekly or monthly caps and track them
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}

            {onOpenCashflow && (
              <button
                type="button"
                onClick={onOpenCashflow}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">What's coming up</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    Upcoming income and bills before payday
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}

            {onOpenReport && (
              <button
                type="button"
                onClick={onOpenReport}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">Where did my money go?</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    A monthly report to read, print, or export
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// TrendStrip — per-bucket spending bars for a multi-bucket selection
// ---------------------------------------------------------------------------

function TrendStrip({ points }: { points: SeriesPoint[] }) {
  const maxOut = Math.max(...points.map((p) => p.totalOutflowCents), 1);

  return (
    <Card padded={false} className="overflow-hidden px-4 py-3">
      <p className="mb-3 text-label uppercase tracking-[0.06em] text-ink-tertiary">
        Trend across selection
      </p>
      <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
        {points.map((p) => {
          const pct = (p.totalOutflowCents / maxOut) * 100;
          return (
            <div
              key={p.key}
              title={`${p.label}: ${formatMoney(p.totalOutflowCents)}`}
              className="flex flex-shrink-0 flex-col items-center gap-1.5"
            >
              <div className="flex h-[40px] w-[36px] items-end">
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: `${Math.max(pct, 4)}%`,
                    background: "var(--accent)",
                    opacity: 0.75,
                  }}
                />
              </div>
              <span className="truncate text-meta text-ink-tertiary" style={{ maxWidth: 36 }}>
                {p.label}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function Figures({
  summary,
  accountId,
}: {
  summary: SpendingSummary;
  accountId: string | null;
}) {
  const account = accountId ? summary.accountTotals.find((a) => a.id === accountId) : undefined;
  const out = account ? account.totalOutflowCents : summary.totalOutflowCents;
  const inflow = account ? account.totalInflowCents : summary.totalInflowCents;
  const net = account ? account.totalInflowCents - account.totalOutflowCents : summary.netCents;
  const share = inflow + out > 0 ? (inflow / (inflow + out)) * 100 : 50;
  const c = summary.comparison;
  const showDelta =
    !account && c && c.comparable && (c.direction === "up" || c.direction === "down");

  const outText = formatMoney(out);
  const outSize = outText.length > 6 ? "text-figure" : "text-hero";

  return (
    <Card className="overflow-hidden" padded={false}>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className="border-b border-line-subtle p-5 sm:col-span-1 sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Went out</p>
          <p className={`numeral mt-1.5 whitespace-nowrap ${outSize} text-ink`}>
            <CountUpMoney cents={out} />
          </p>
          {showDelta && (
            <div className="mt-2.5">
              <Delta direction={c!.direction === "up" ? "up" : "down"}>
                {formatMoney(Math.abs(c!.outflowChangeCents))} on {c!.baselineLabel}
              </Delta>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-line-subtle p-5 sm:flex-col sm:items-start sm:justify-center sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Came in</p>
          <p className="numeral whitespace-nowrap text-figure text-ink sm:mt-1.5">
            {formatMoney(inflow)}
          </p>
        </div>

        <div className="flex items-center justify-between p-5 sm:flex-col sm:items-start sm:justify-center sm:p-6">
          <p className="text-label text-ink-tertiary">Left over</p>
          <p
            className="numeral whitespace-nowrap text-figure sm:mt-1.5"
            style={{ color: net >= 0 ? "var(--accent)" : "var(--text-primary)" }}
          >
            {net >= 0 ? "+" : "−"}
            {formatMoney(Math.abs(net))}
          </p>
        </div>
      </div>

      <div className="border-t border-line-subtle px-5 py-4 sm:px-6">
        <div className="flex h-[6px] overflow-hidden rounded-pill bg-surface-inset">
          <div
            className="bar-fill h-full"
            style={{ width: `${share}%`, background: "var(--accent)" }}
          />
        </div>
        <p className="mt-2.5 text-meta text-ink-tertiary">
          {account
            ? `${account.displayName} only`
            : banksAndAccounts(summary.institutionTotals.length, summary.accountTotals.length)}
        </p>
      </div>
    </Card>
  );
}

function Categories({
  summary,
  expanded,
  onToggle,
}: {
  summary: SpendingSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const all = summary.categoryTotals;
  const shown = expanded ? all : all.slice(0, 8);

  const periodNoun = summary.period.kind === "statement" ? "statement period" : summary.period.kind;

  return (
    <Card padded={false} className="overflow-hidden">
      {all.length === 0 && (
        <p className="px-5 py-6 text-center text-body text-ink-secondary sm:px-6">
          No spending recorded this {periodNoun}.
        </p>
      )}
      {shown.map((c, i) => {
        const delta = c.comparison;
        const negative = c.outflowCents < 0;
        const pct = negative ? 0 : c.shareBasisPoints / 100;
        const notable = delta && Math.abs(delta.outflowChangeCents) >= 3000;

        return (
          <div key={c.category} className={`px-5 py-3.5 sm:px-6 ${i ? "border-t border-line-subtle" : ""}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-pill"
                  style={{ background: categoryColor(c.category) }}
                />
                <span className="truncate text-body text-ink">{c.displayName}</span>
                {c.category === "unknown" && (
                  <span className="group relative inline-flex shrink-0">
                    <button
                      type="button"
                      aria-label="Why is this labelled Unknown?"
                      aria-describedby="unknown-category-help"
                      className="flex h-4 w-4 items-center justify-center rounded-pill border border-line-strong text-[10px] font-semibold leading-none text-ink-tertiary transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none"
                    >
                      ?
                    </button>
                    <span
                      id="unknown-category-help"
                      role="tooltip"
                      className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-52 rounded-md border border-line-subtle bg-surface-raised px-3 py-2 text-meta leading-snug text-ink-secondary opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      Your bank feed didn&rsquo;t tag these with a category the
                      app recognizes yet, so they&rsquo;re grouped here &mdash;
                      not a real place your money went.
                    </span>
                  </span>
                )}
                {notable && (delta!.direction === "up" || delta!.direction === "down") && (
                  <Delta direction={delta!.direction === "up" ? "up" : "down"}>
                    {formatMoney(Math.abs(delta!.outflowChangeCents))}
                  </Delta>
                )}
                {delta?.direction === "new" && (
                  <span className="shrink-0 rounded-pill bg-surface-sunken px-1.5 py-0.5 text-meta text-ink-tertiary">
                    new
                  </span>
                )}
              </span>
              <span className="tabular shrink-0 text-amount text-ink">
                {negative && "−"}
                {formatMoney(Math.abs(c.outflowCents))}
              </span>
            </div>

            {!negative && <Bar pct={pct} color={categoryColor(c.category)} delay={i * 35} />}

            {c.refundCents > 0 && (
              <p className="mt-2 text-meta text-ink-tertiary">
                after {formatMoney(c.refundCents)} back
              </p>
            )}
          </div>
        );
      })}

      {all.length > 8 && (
        <button
          type="button"
          onClick={onToggle}
          className="w-full border-t border-line-subtle py-3 text-label text-ink-secondary hover:bg-surface-sunken"
        >
          {expanded ? "Show less" : `Show ${all.length - 8} more`}
        </button>
      )}
    </Card>
  );
}

function AccountsPanel({
  accounts,
  bankCount,
  totalOutflowCents,
  selected,
  onSelect,
}: {
  accounts: SpendingSummary["accountTotals"];
  bankCount: number;
  totalOutflowCents: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [showIdle, setShowIdle] = useState(false);
  const idleCount = accounts.filter(
    (a) => a.totalOutflowCents === 0 && a.id !== selected,
  ).length;
  const shown = showIdle
    ? accounts
    : accounts.filter((a) => a.totalOutflowCents !== 0 || a.id === selected);

  return (
    <div>
      <SectionLabel>Accounts</SectionLabel>
      <Card padded={false} className="overflow-hidden">
        <AccountRow
          first
          label="All accounts"
          sub={banksAndAccounts(bankCount, accounts.length)}
          amount={totalOutflowCents}
          active={selected === null}
          onClick={() => onSelect(null)}
        />
        {shown.map((a) => (
          <AccountRow
            key={a.id}
            label={a.displayName}
            sub={issuerLabel(a.institutionName, a.displayName)}
            amount={a.totalOutflowCents}
            active={selected === a.id}
            onClick={() => onSelect(a.id)}
          />
        ))}
        {idleCount > 0 && (
          <button
            type="button"
            onClick={() => setShowIdle((v) => !v)}
            className="w-full border-t border-line-subtle py-3 text-label text-ink-secondary hover:bg-surface-sunken"
          >
            {showIdle ? "Hide dormant accounts" : `Show ${idleCount} with no activity`}
          </button>
        )}
      </Card>
      <p className="mt-2 text-meta text-ink-tertiary">
        Tap an account to see just its spending and where it went.
      </p>
    </div>
  );
}

function AccountRow({
  label,
  sub,
  amount,
  active,
  first = false,
  onClick,
}: {
  label: string;
  sub: string;
  amount: number;
  active: boolean;
  first?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors ${
        first ? "" : "border-t border-line-subtle"
      } ${active ? "bg-surface-sunken" : "hover:bg-surface-sunken/60"}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-pill ${active ? "bg-accent" : "bg-transparent"}`}
        />
        <span className="min-w-0">
          <span className="block truncate text-body text-ink">{label}</span>
          <span className="block truncate text-meta text-ink-tertiary">{sub}</span>
        </span>
      </span>
      <span
        className={`tabular shrink-0 text-amount ${amount ? "text-ink" : "text-ink-tertiary"}`}
      >
        {formatMoney(amount)}
      </span>
    </button>
  );
}

function Excluded({ summary }: { summary: SpendingSummary }) {
  const transfers = summary.excludedTransferOutflowCents;
  const unclassified = summary.unclassifiedOutflowCents;
  if (transfers === 0 && unclassified === 0) return null;

  return (
    <div>
      <SectionLabel>Not counted as spending</SectionLabel>
      <div className="space-y-2.5">
        {transfers > 0 && (
          <Card>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink">Moved between your accounts</span>
              <span className="tabular text-amount text-ink">{formatMoney(transfers)}</span>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-ink-tertiary">
              Paying a card moves money already counted when the card was charged. Counting it twice
              would show {formatMoney(summary.totalOutflowCents + transfers)} instead of{" "}
              {formatMoney(summary.totalOutflowCents)}.
            </p>
          </Card>
        )}

        {unclassified > 0 && (
          <div
            className="rounded-lg border border-dashed px-5 py-4"
            style={{ borderColor: "var(--border-strong)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink">Not sure about this</span>
              <span className="tabular text-amount text-ink">{formatMoney(unclassified)}</span>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-ink-secondary">
              Money moved somewhere you haven't connected. We can't tell whether it was spent, so it
              isn't counted either way.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function NotYet({ period }: { period: PeriodKind }) {
  const copy: Record<string, { title: string; body: string }> = {
    statement: {
      title: "Statement periods need a closing day",
      body: "This follows a card's billing cycle instead of the calendar month, so the total matches the bill you actually pay. Add the day your card closes when you import it — a CSV export never contains one, and without it this view would silently show a calendar month instead.",
    },
  };
  const text = copy[period] ?? { title: "Not available yet", body: "" };
  return (
    <div
      className="mt-6 max-w-[560px] rounded-lg border border-dashed px-6 py-7"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <p className="text-heading text-ink">{text.title}</p>
      <p className="mt-2 text-body text-ink-secondary">{text.body}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12" aria-hidden="true">
      <div className="space-y-5 lg:col-span-7 xl:col-span-8">
        <div className="skeleton h-[190px] rounded-lg" />
        <div className="skeleton h-[380px] rounded-lg" />
      </div>
      <div className="space-y-5 lg:col-span-5 xl:col-span-4">
        <div className="skeleton h-[150px] rounded-lg" />
        <div className="skeleton h-[180px] rounded-lg" />
      </div>
    </div>
  );
}
