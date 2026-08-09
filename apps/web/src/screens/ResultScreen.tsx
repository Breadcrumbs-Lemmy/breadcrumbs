/**
 * Result screen — docs/ui-mvp0-screens.md Screen 3.
 * Vertical order is fixed and matches focus order.
 */
import type { AffordabilityResponse, FinancialSnapshot } from "@ai-fin-os/core";
import { VerdictPanel } from "../components/VerdictPanel";
import { ForecastChart } from "../components/ForecastChart";
import { EventTimeline } from "../components/EventTimeline";
import { FreshnessBanner } from "../components/FreshnessBanner";
import { Card, Money, DateDisplay, MoneyOrPlaceholder } from "../components/primitives";
import { purchaseView } from "../model/purchase";

export function ResultScreen({
  response,
  snapshot,
  onResolve,
}: {
  response: AffordabilityResponse;
  snapshot: FinancialSnapshot;
  onResolve?: (target: "accounts" | "purchase" | "obligations") => void;
}) {
  const bufferCents = snapshot.config.minimumCashBufferCents;
  const purchase = purchaseView(response);

  // Entity id to display label. A lookup over request inputs, not a calculation.
  const labels = new Map<string, string>();
  for (const account of snapshot.accounts) labels.set(account.id, account.displayName);
  for (const income of snapshot.incomeSources) labels.set(income.id, income.label);
  for (const obligation of snapshot.recurringObligations) labels.set(obligation.id, obligation.label);
  for (const goal of snapshot.goals) labels.set(goal.id, goal.label);
  for (const p of snapshot.plannedPurchases) labels.set(p.id, p.label);
  const labelFor = (id: string) => labels.get(id) ?? "an item";

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(360px,440px)_1fr] lg:items-start">
      <div className="space-y-4 lg:sticky lg:top-8">
        <FreshnessBanner warnings={response.explanation.freshnessWarnings} />

        <VerdictPanel
          response={response}
          bufferCents={bufferCents}
          labelFor={labelFor}
          onResolve={onResolve}
        />

        <Card>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-label text-ink-secondary">{purchase.label}</span>
            <span className="flex items-baseline gap-3">
              <MoneyOrPlaceholder cents={purchase.amountCents} label="Purchase amount" />
              <span className="text-meta text-ink-tertiary">
                {purchase.purchaseDate ? (
                  <DateDisplay iso={purchase.purchaseDate} reference={response.asOfDate} />
                ) : (
                  "—"
                )}
              </span>
            </span>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        {/* No chart for UNKNOWN: the engine refused to project, so the UI
            does not draw a projection. */}
        {response.level !== "UNKNOWN" && (
          <Card>
            <ForecastChart response={response} bufferCents={bufferCents} />
          </Card>
        )}

        {response.level !== "UNKNOWN" && <EventTimeline response={response} />}

        {response.level !== "UNKNOWN" && (
          <Card title="Cash position">
            <div className="grid grid-cols-2 gap-x-6">
              <Row label="Opening cash" cents={response.metrics.openingSpendableCashCents} />
              <Row label="After this purchase" cents={response.metrics.postPurchaseCashCents} />
              <Row label="Bills before next paycheck" cents={response.metrics.timingReserveCents} />
              <Row label="Left after those bills" cents={response.metrics.timingReserveMarginCents} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="border-t border-line-subtle py-2 first:border-t-0">
      <div className="text-label text-ink-secondary">{label}</div>
      <div className="text-amount">
        <Money cents={cents} />
      </div>
    </div>
  );
}
