/**
 * Insights — the waste-detection surface.
 *
 * The reason the product exists beyond a spending chart. Subscriptions are the
 * waste people already know about; frequent small purchases are the kind that
 * surprises you on a statement.
 *
 * Every insight links to the transactions that produced it. An insight the user
 * cannot verify is a claim, not a fact.
 */
import { useEffect, useState } from "react";
import type { Insight, InsightsResult } from "@ai-fin-os/core";
import type { Dispatch, SetStateAction } from "react";
import { fetchInsights, type ApiOutcome } from "../services/api";
import { formatMoney } from "../format/money";
import { Card, Chip, Delta, SectionLabel, Segmented, TrailDivider } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { categoryColor } from "../model/category-color";
import { PERIOD_LABELS, type PeriodKind } from "../model/period";
import { useAssistantView } from "../services/assistant-scope";
import { focusFromInsight, type InsightFocus } from "../model/insight-focus";

// Insights are meaningful at week / month / year granularity.
const INSIGHT_PERIODS: PeriodKind[] = ["week", "month", "year"];

export function InsightsScreen({
  onSeeTransactions,
  period,
  setPeriod,
  periodKey,
  setPeriodKey,
}: {
  onSeeTransactions?: (focus: InsightFocus) => void;
  // Filter selection is owned by the shell so it survives navigating out to the
  // Transactions drill-down and back — this screen unmounts on the way, so local
  // state would reset to the default month on return.
  period: PeriodKind;
  setPeriod: Dispatch<SetStateAction<PeriodKind>>;
  // Which specific period key to view (e.g. "2026-05"). null = current.
  periodKey: string | null;
  setPeriodKey: Dispatch<SetStateAction<string | null>>;
}) {
  const [outcome, setOutcome] = useState<ApiOutcome<InsightsResult> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    void fetchInsights({ period, key: periodKey ?? undefined }).then(
      (next) => !cancelled && setOutcome(next),
    );
    return () => {
      cancelled = true;
    };
  }, [period, periodKey]);

  // Publish the viewed period to the assistant. Called before the early returns
  // below so the hook order stays stable. Prefer the backend-resolved period
  // (exact key + label) once loaded; before that, name the selection from state
  // so the scope is right even while insights are still loading.
  useAssistantView({
    period:
      outcome?.kind === "ok"
        ? {
            kind: outcome.data.period.kind,
            key: outcome.data.period.key,
            label: outcome.data.period.label,
          }
        : { kind: period, key: periodKey ?? undefined },
  });

  if (outcome === null) return <Skeleton />;

  if (outcome.kind !== "ok") {
    return (
      <Card className="max-w-[560px]">
        <p className="text-body">Couldn't load insights.</p>
        <p className="mt-1 text-meta text-ink-tertiary">
          {outcome.kind === "error" ? outcome.message : "The request was rejected."}
        </p>
      </Card>
    );
  }

  const { insights, recurring, period: responsePeriod } = outcome.data;

  // The response carries the available periods in the series. Grab them for
  // navigation chips — same pattern as SpendingScreen's period switcher.
  const availablePeriods: Array<{ key: string; label: string }> = [];
  if ("availablePeriods" in outcome.data && Array.isArray(outcome.data.availablePeriods)) {
    (outcome.data.availablePeriods as Array<{ key: string; label: string }>).forEach((p) => {
      availablePeriods.push(p);
    });
  }

  return (
    <>
      {/* Period controls — same two-level pattern as Spending: granularity
          on the left, specific period navigation on the right. */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-[320px]">
          <Segmented
            ariaLabel="Insights period"
            value={period}
            onChange={(next) => {
              setPeriod(next);
              setPeriodKey(null);
            }}
            options={INSIGHT_PERIODS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }))}
          />
        </div>
        {availablePeriods.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {availablePeriods.map((p) => (
              <Chip
                key={p.key}
                active={p.key === responsePeriod.key}
                onClick={() => setPeriodKey(p.key)}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <div className="space-y-3 lg:col-span-7 xl:col-span-8">
        <SectionLabel>Worth a look · {responsePeriod.label}</SectionLabel>

        {insights.length === 0 && (
          <Card className="text-center">
            <div className="mb-4 flex justify-center">
              <LogoMark size={42} beacon spill={false} />
            </div>
            <p className="font-display text-[1.25rem] font-medium text-ink">
              Nothing stands out this {responsePeriod.kind}
            </p>
            <p className="mx-auto mt-1.5 max-w-[42ch] text-body text-ink-secondary">
              No repeated small purchases, overlapping services, or sharp rises — the trail's clean.
            </p>
          </Card>
        )}

        {insights.map((insight, i) => (
          <div key={insight.id} className="fade-in" style={{ animationDelay: `${i * 60}ms` }}>
            <InsightCard insight={insight} onSeeTransactions={onSeeTransactions} />
          </div>
        ))}
      </div>

      <div className="lg:col-span-5 xl:col-span-4">
        <SectionLabel>Recurring</SectionLabel>
        <Card padded={false} className="overflow-hidden">
          <div className="flex items-baseline justify-between border-b border-line-subtle px-5 py-4">
            <span className="text-body">{recurring.count} subscriptions</span>
            <span className="numeral text-figure">
              {formatMoney(recurring.totalMonthlyCents)}
              <span className="text-meta font-normal text-ink-tertiary">/mo</span>
            </span>
          </div>
          {recurring.items.map((item, i) => (
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
          {recurring.items.length === 0 && (
            <p className="px-5 py-4 text-body text-ink-secondary">
              No recurring charges detected yet.
            </p>
          )}
        </Card>
        <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
          Detected from repeating merchant and amount patterns. Anything less than certain is
          marked.
        </p>
      </div>
    </div>
    </>
  );
}

function InsightCard({
  insight,
  onSeeTransactions,
}: {
  insight: Insight;
  onSeeTransactions?: (focus: InsightFocus) => void;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <h3 className="font-display text-heading text-ink">{insight.headline}</h3>
          <p className="mt-1.5 max-w-[54ch] text-body text-ink-secondary">{insight.detail}</p>
        </div>
        <span className="numeral shrink-0 text-figure text-ink">
          {formatMoney(insight.totalCents)}
          {insight.type === "POSSIBLE_DUPLICATE_SERVICE" && (
            <span className="text-meta font-normal text-ink-tertiary">/mo</span>
          )}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {insight.averageCents !== undefined && (
          <Pill>{formatMoney(insight.averageCents)} average</Pill>
        )}
        {insight.occurrenceCount !== undefined && <Pill>{insight.occurrenceCount} times</Pill>}
        {insight.comparison && (
          <Delta direction={insight.comparison.direction}>
            {formatMoney(insight.comparison.changeCents)}
          </Delta>
        )}
        {insight.confidence !== "high" && <Pill dashed>{insight.confidence} confidence</Pill>}
      </div>

      {/* A range with a stated basis, never a single figure. "You could save
          $17.99" is a recommendation; a range with its basis is arithmetic the
          user can check (D-002). */}
      {insight.potentialSavings && (
        <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
          Dropping one would free {formatMoney(insight.potentialSavings.lowCents)}–
          {formatMoney(insight.potentialSavings.highCents)} a month. Your call which, if any.
        </p>
      )}

      {insight.transactionIds.length > 0 && (
        <>
          <TrailDivider className="mt-4" />
          <button
            type="button"
            onClick={() => onSeeTransactions?.(focusFromInsight(insight))}
            className="mt-3 text-label text-accent underline underline-offset-4"
          >
            See the {insight.transactionIds.length} transactions
          </button>
        </>
      )}
    </Card>
  );
}

function Pill({ children, dashed = false }: { children: React.ReactNode; dashed?: boolean }) {
  return (
    <span
      className={`rounded-pill px-2.5 py-1 text-meta text-ink-secondary ${
        dashed ? "border border-dashed border-line-strong" : "bg-surface-sunken"
      }`}
    >
      {children}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12" aria-hidden="true">
      <div className="space-y-3 lg:col-span-7 xl:col-span-8">
        <div className="skeleton h-[150px] rounded-lg" />
        <div className="skeleton h-[150px] rounded-lg" />
      </div>
      <div className="lg:col-span-5 xl:col-span-4">
        <div className="skeleton h-[300px] rounded-lg" />
      </div>
    </div>
  );
}
