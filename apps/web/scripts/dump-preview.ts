/**
 * Dumps affordability output plus real UI copy for every scenario, as JSON.
 *
 * Used to build a static preview of the interface without a bundler. Every
 * string and figure here comes from the same pipeline the React app uses:
 * the real engine, the real copy layer, the real formatters.
 * Only the rendering is reproduced separately.
 */
import { SCENARIOS, type ScenarioKey } from "../src/fixtures/scenarios";
import { evaluateAffordability, AffordabilityRequestValidationError } from "@ai-fin-os/core";
import type { AffordabilityRequest } from "@ai-fin-os/core";
import type { AffordabilityOutcome } from "../src/services/outcome";

/**
 * Node development script, not browser runtime. See the note in verify-copy.ts:
 * `D-013` governs what the browser bundle may call, and this never ships in it.
 */
function evaluateDirect(request: AffordabilityRequest): AffordabilityOutcome {
  try {
    return { kind: "result", response: evaluateAffordability(request) };
  } catch (error) {
    if (error instanceof AffordabilityRequestValidationError) {
      return { kind: "invalid", issues: error.issues };
    }
    return { kind: "error", message: error instanceof Error ? error.message : "Unknown failure" };
  }
}
import { reasonCopy, type ReasonContext } from "../src/copy/reasons";
import { headlineFor } from "../src/copy/headline";
import { ASSUMPTION_COPY, BOUNDARY_COPY, FRESHNESS_COPY, LEVEL_WORD } from "../src/copy";
import { purchaseView } from "../src/model/purchase";
import { formatMoney } from "../src/format/money";
import { formatDate } from "../src/format/dates";

async function main() {
  const out: unknown[] = [];

  for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
    const request = SCENARIOS[key].build();
    const outcome = evaluateDirect(request);
    if (outcome.kind !== "result") continue;

    const response = outcome.response;
    const snapshot = request.snapshot;
    const buffer = snapshot.config.minimumCashBufferCents;

    const labels = new Map<string, string>();
    for (const a of snapshot.accounts) labels.set(a.id, a.displayName);
    for (const i of snapshot.incomeSources) labels.set(i.id, i.label);
    for (const o of snapshot.recurringObligations) labels.set(o.id, o.label);
    for (const g of snapshot.goals) labels.set(g.id, g.label);
    for (const p of snapshot.plannedPurchases) labels.set(p.id, p.label);

    const context: ReasonContext = {
      labelFor: (id) => labels.get(id) ?? "an item",
      relatedEntityIds: [],
      referenceDate: response.asOfDate,
      horizonEndDate: response.horizonEndDate,
    };

    const view = purchaseView(response);

    out.push({
      key,
      tab: SCENARIOS[key].label,
      level: response.level,
      levelWord: LEVEL_WORD[response.level],
      headline: headlineFor(response, buffer),
      bufferLabel: formatMoney(buffer),
      bufferCents: buffer,
      purchase: {
        label: view.label,
        amount: formatMoney(view.amountCents),
        date: view.purchaseDate ? formatDate(view.purchaseDate, response.asOfDate) : "—",
      },
      minBalance: formatMoney(response.metrics.requiredPath.minimumIntradayBalanceCents),
      minDate: formatDate(response.metrics.requiredPath.minimumIntradayBalanceDate, response.asOfDate),
      metrics: [
        ["Opening cash", formatMoney(response.metrics.openingSpendableCashCents)],
        ["After this purchase", formatMoney(response.metrics.postPurchaseCashCents)],
        ["Bills before next paycheck", formatMoney(response.metrics.timingReserveCents)],
        ["Left after those bills", formatMoney(response.metrics.timingReserveMarginCents)],
      ],
      reasons: response.explanation.reasons.map((reason) => {
        const copy = reasonCopy(reason, context);
        return {
          code: reason.code,
          severity: reason.severity,
          primary: copy.primary,
          resolution: copy.resolution?.label ?? null,
        };
      }),
      assumptions: response.explanation.assumptions.map((a) => ASSUMPTION_COPY[a.code]),
      freshness: response.explanation.freshnessWarnings
        .filter((w) => w.severity !== "info")
        .map((w) => FRESHNESS_COPY[w.code]),
      boundary: BOUNDARY_COPY.NOT_PERSONALIZED_FINANCIAL_ADVICE,
      dailyBalances: response.forecast.dailyBalances.map((d) => ({
        date: d.date,
        label: formatDate(d.date, response.asOfDate),
        required: d.requiredPathBalanceCents,
        protected: d.protectedPathBalanceCents,
        all: d.allEventsPathBalanceCents,
        expected: d.expectedReferencePathBalanceCents ?? null,
      })),
      events: response.forecast.events
        .filter((e) => e.path !== "expected_reference")
        .map((e) => ({
          date: formatDate(e.date, response.asOfDate),
          label: e.label,
          amount: formatMoney(e.amountCents),
          inflow: e.amountCents > 0,
          isPurchase: e.sourceType === "planned_purchase",
        })),
    });
  }

  console.log(JSON.stringify(out));
}

void main();
