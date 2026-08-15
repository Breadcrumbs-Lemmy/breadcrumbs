/**
 * Monthly report — a print-ready "where did my money go" sheet for one month.
 * Specified in `docs/report.md` (D-R1..D-R10).
 *
 * The report is a **composition, not a computation**: the backend builds it from
 * the same two engines the Spending and Insights screens use (`summarizeSpending`
 * + `detectInsights`) for a single month, so every figure here is a figure those
 * screens would show for that month. This component renders it and offers two
 * exports — a browser Print (→ Save as PDF) against the print stylesheet, and a
 * CSV download served by the API. It sums, classifies, and compares nothing
 * (`CD-003`, `CD-011`); the one non-figure it composes is the month title, from
 * the backend period key.
 *
 * The report sheet is wrapped in `.report-print`; the print rules in
 * `styles/index.css` hide the app chrome and everything marked `.no-print`, so a
 * print or PDF is the sheet alone on white paper.
 */
import { useEffect, useState } from "react";
import type { MonthlyReport, SpendingSummary } from "@ai-fin-os/core";
import {
  loadReport,
  loadReportMonths,
  type ReportMonth,
  type ReportOutcome,
} from "../services/report";
import { downloadMonthlyReportCsv } from "../services/api";
import { monthLabel, monthYear } from "../model/period";
import { formatMoney } from "../format/money";
import { categoryColor } from "../model/category-color";
import { Bar, Card, Chip, SectionLabel, TrailDivider } from "../components/ui";
import { LogoMark } from "../components/Logo";

export function MonthlyReportScreen({
  onBack,
  onImport,
}: {
  onBack?: () => void;
  onImport?: () => void;
}) {
  // null = the default month (the backend's latest COMPLETE month). Selecting a
  // chip pins an explicit key; the backend still owns which month that resolves
  // to and echoes it back as `summary.period.key`.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null);
  const [months, setMonths] = useState<ReportMonth[]>([]);
  const [csv, setCsv] = useState<{ state: "idle" | "working" | "error"; message?: string }>({
    state: "idle",
  });

  // The month switcher is loaded once; it does not change as the user browses
  // between months.
  useEffect(() => {
    let cancelled = false;
    void loadReportMonths().then((next) => !cancelled && setMonths(next));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    setCsv({ state: "idle" });
    void loadReport(selectedKey ?? undefined).then((next) => !cancelled && setOutcome(next));
    return () => {
      cancelled = true;
    };
  }, [selectedKey]);

  const report = outcome?.kind === "ready" ? outcome.report : undefined;
  // The month actually on screen, as resolved by the backend — the anchor for
  // the active chip and for the CSV download, so the file matches what is shown.
  const activeKey = report?.summary.period.key ?? selectedKey ?? undefined;

  async function downloadCsv() {
    setCsv({ state: "working" });
    const result = await downloadMonthlyReportCsv(activeKey ? { key: activeKey } : {});
    setCsv(result.ok ? { state: "idle" } : { state: "error", message: result.message });
  }

  return (
    <>
      {/* ---- Controls (never printed) ------------------------------------ */}
      <div className="no-print mb-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="text-label text-ink-secondary underline underline-offset-4 hover:text-ink"
              >
                ‹ Back to spending
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void downloadCsv()}
              disabled={!report || csv.state === "working"}
              className="min-h-[38px] rounded-md border border-line-strong px-4 text-body text-ink transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              {csv.state === "working" ? "Preparing…" : "Download CSV"}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!report}
              className="min-h-[38px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              Print / Save as PDF
            </button>
          </div>
        </div>

        {csv.state === "error" && (
          <p className="text-meta text-alert">{csv.message ?? "Couldn't download the CSV."}</p>
        )}

        {months.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {months.map((m) => (
              <Chip key={m.key} active={m.key === activeKey} onClick={() => setSelectedKey(m.key)}>
                {m.label}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="max-w-[560px]">
          <p className="text-body">Couldn't load your report.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {outcome?.kind === "empty" && (
        <Card className="max-w-[560px] text-center">
          <div className="mb-4 flex justify-center">
            <LogoMark size={46} beacon />
          </div>
          <p className="font-display text-[1.35rem] font-medium text-ink">Nothing to report yet</p>
          <p className="mx-auto mt-2 max-w-[40ch] text-body text-ink-secondary">
            Import a statement and a monthly report — where your money went, grouped and totalled —
            will be ready to read, print, or export.
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

      {report && <ReportSheet report={report} />}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The printable document. Single column, so screen and paper read the same and
 * a print never reflows into columns. Everything inside is `.report-print`, the
 * only subtree the print stylesheet keeps visible.
 */
function ReportSheet({ report }: { report: MonthlyReport }) {
  const { summary, insights } = report;
  const period = summary.period;
  const title = `${monthLabel(period.key)} ${monthYear(period.key)}`;

  return (
    <div className="report-print fade-in mx-auto max-w-[720px]">
      {/* ---- Masthead ---------------------------------------------------- */}
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-label text-ink-tertiary">Monthly report</p>
          <h1 className="font-display text-[1.9rem] font-medium leading-tight text-ink">{title}</h1>
          <p className="mt-1 text-meta text-ink-tertiary">
            {report.fromLatestComplete ? "Latest complete month · " : ""}
            as of {formatAsOf(report.asOfDate)}
            {period.partial && " · still in progress"}
          </p>
        </div>
        <LogoMark size={40} />
      </header>

      <Figures summary={summary} />

      {/* ---- Where it went ---------------------------------------------- */}
      <section className="mt-7">
        <SectionLabel>Where it went</SectionLabel>
        {summary.categoryTotals.length === 0 ? (
          <Card className="mt-1">
            <p className="text-body text-ink-secondary">
              No spending recorded this month — nothing left the accounts.
            </p>
          </Card>
        ) : (
          <Card padded={false} className="mt-1 overflow-hidden">
            {summary.categoryTotals.map((c, i) => {
              // A negative net is a refund with no matching spend this month
              // (H-016). A share width below zero is meaningless, so no bar.
              const negative = c.outflowCents < 0;
              const pct = negative ? 0 : c.shareBasisPoints / 100;
              return (
                <div
                  key={c.category}
                  className={`px-5 py-3.5 ${i ? "border-t border-line-subtle" : ""}`}
                >
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-pill"
                        style={{ background: categoryColor(c.category) }}
                      />
                      <span className="truncate text-body text-ink">{c.displayName}</span>
                      <span className="shrink-0 text-meta text-ink-tertiary">
                        {c.transactionCount} {c.transactionCount === 1 ? "charge" : "charges"}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-amount text-ink">
                      {negative && "−"}
                      {formatMoney(Math.abs(c.outflowCents))}
                    </span>
                  </div>
                  {!negative && <Bar pct={pct} color={categoryColor(c.category)} delay={i * 30} />}
                  {c.refundCents > 0 && (
                    <p className="mt-2 text-meta text-ink-tertiary">
                      after {formatMoney(c.refundCents)} back
                    </p>
                  )}
                </div>
              );
            })}
          </Card>
        )}
      </section>

      {/* ---- Worth a look (insights, copy verbatim) --------------------- */}
      <section className="mt-7">
        <SectionLabel>Worth a look</SectionLabel>
        {insights.insights.length === 0 ? (
          <Card className="mt-1">
            <p className="text-body text-ink-secondary">
              Nothing stood out this month — no repeated small purchases, overlapping services, or
              sharp rises.
            </p>
          </Card>
        ) : (
          <div className="mt-1 space-y-3">
            {insights.insights.map((insight) => (
              <Card key={insight.id}>
                <div className="flex items-start justify-between gap-5">
                  <div className="min-w-0">
                    <h3 className="font-display text-heading text-ink">{insight.headline}</h3>
                    <p className="mt-1.5 max-w-[54ch] text-body text-ink-secondary">
                      {insight.detail}
                    </p>
                  </div>
                  <span className="numeral shrink-0 text-figure text-ink">
                    {formatMoney(insight.totalCents)}
                    {insight.type === "POSSIBLE_DUPLICATE_SERVICE" && (
                      <span className="text-meta font-normal text-ink-tertiary">/mo</span>
                    )}
                  </span>
                </div>
                {/* A range with a stated basis, never a single prescriptive figure
                    (D-002 / D-R4). */}
                {insight.potentialSavings && (
                  <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
                    Dropping one would free {formatMoney(insight.potentialSavings.lowCents)}–
                    {formatMoney(insight.potentialSavings.highCents)} a month. Your call which, if
                    any.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ---- Recurring commitments -------------------------------------- */}
      <section className="mt-7">
        <SectionLabel>Recurring</SectionLabel>
        <Card padded={false} className="mt-1 overflow-hidden">
          <div className="flex items-baseline justify-between border-b border-line-subtle px-5 py-4">
            <span className="text-body">
              {insights.recurring.count}{" "}
              {insights.recurring.count === 1 ? "subscription" : "subscriptions"}
            </span>
            <span className="numeral text-figure">
              {formatMoney(insights.recurring.totalMonthlyCents)}
              <span className="text-meta font-normal text-ink-tertiary">/mo</span>
            </span>
          </div>
          {insights.recurring.items.map((item, i) => (
            <div
              key={item.normalizedMerchantId}
              className={`flex items-center justify-between gap-3 px-5 py-3 ${
                i ? "border-t border-line-subtle" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-pill"
                  style={{ background: categoryColor(item.category) }}
                />
                <span className="truncate text-body">{item.displayName}</span>
                {item.confidence !== "high" && (
                  <span className="shrink-0 rounded-pill border border-dashed border-line-strong px-1.5 text-meta text-ink-tertiary">
                    unsure
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular block text-amount">{formatMoney(item.amountCents)}</span>
                <span className="text-meta text-ink-tertiary">{item.cadenceLabel}</span>
              </span>
            </div>
          ))}
          {insights.recurring.items.length === 0 && (
            <p className="px-5 py-4 text-body text-ink-secondary">
              No recurring charges detected this month.
            </p>
          )}
        </Card>
      </section>

      <TrailDivider className="mt-8" />
      <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
        Every figure above is a factual total from your own imported history for {title} — not
        advice, and nothing here moves money. Refunds are netted out of each category, and money
        moved between your own accounts is not counted as spending.
      </p>
    </div>
  );
}

/**
 * The three headline figures. Same three the Spending screen leads with, laid
 * out for a document: a single card, three cells across, "Left over" carrying
 * the backend-owned net (the UI never subtracts — H-022).
 */
function Figures({ summary }: { summary: SpendingSummary }) {
  const net = summary.netCents;
  return (
    <Card className="overflow-hidden" padded={false}>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className="border-b border-line-subtle p-5 sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Went out</p>
          <p className="numeral mt-1.5 whitespace-nowrap text-figure text-ink">
            {formatMoney(summary.totalOutflowCents)}
          </p>
        </div>
        <div className="border-b border-line-subtle p-5 sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Came in</p>
          <p className="numeral mt-1.5 whitespace-nowrap text-figure text-ink">
            {formatMoney(summary.totalInflowCents)}
          </p>
        </div>
        <div className="p-5 sm:p-6">
          <p className="text-label text-ink-tertiary">Left over</p>
          <p
            className="numeral mt-1.5 whitespace-nowrap text-figure"
            style={{ color: net >= 0 ? "var(--accent)" : "var(--text-primary)" }}
          >
            {net >= 0 ? "+" : "−"}
            {formatMoney(Math.abs(net))}
          </p>
        </div>
      </div>
    </Card>
  );
}

/** ISO `YYYY-MM-DD` → "11 Aug 2022". Display-only, in UTC to avoid a timezone
 *  shifting the day; composes no financial figure. */
function formatAsOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function Skeleton() {
  return (
    <div className="mx-auto max-w-[720px] space-y-5" aria-hidden="true">
      <div className="skeleton h-[64px] rounded-lg" />
      <div className="skeleton h-[120px] rounded-lg" />
      <div className="skeleton h-[300px] rounded-lg" />
    </div>
  );
}
