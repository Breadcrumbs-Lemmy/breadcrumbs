/**
 * Headline composition — docs/ui-copy-map.md "Affordability Levels".
 *
 * The headline states the verdict in plain language. It deliberately carries
 * **no figures beyond the configured buffer**, and the primary reason directly
 * beneath it carries the numbers.
 *
 * This was not the original design. The first version read the minimum balance
 * off `metrics.requiredPath` and put it in the headline. That is wrong whenever
 * the determining reason concerns a different path, and it produced two
 * user-visible falsehoods against the monthly-savings fixture:
 *
 *   - A TIGHT result rendered "drops to $535, below your $250 buffer". $535 is
 *     not below $250. The verdict was driven by the *protected* path at $235;
 *     the headline was reading the *required* path.
 *   - A RISKY result rendered "leaves required bills uncovered" when the actual
 *     reason was HIGH_PRIORITY_GOAL_SHORTFALL and required bills were fine.
 *
 * Both passed type checking and both read as authoritative. The fix is to stop
 * duplicating the reason's job: state the level, let the reason state the
 * figures. A headline that cannot cite a number cannot cite a wrong one.
 */
import type { AffordabilityResponse } from "@ai-fin-os/core";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";
import { UNKNOWN_HEADLINE } from "./index";
import { purchaseView } from "../model/purchase";

export function headlineFor(response: AffordabilityResponse, bufferCents: number): string {
  const purchase = purchaseView(response);
  const subject = purchase.labelKnown ? purchase.label : "This purchase";
  const buffer = formatMoney(bufferCents);

  switch (response.level) {
    case "AFFORDABLE":
      // Safe to state: AFFORDABLE requires every path check to pass.
      return `${subject} fits. Projected cash stays at or above your ${buffer} buffer through ${formatDate(response.horizonEndDate, response.asOfDate)}.`;

    case "TIGHT":
      // True across every TIGHT variant: required obligations stay coverable,
      // but something falls below the buffer.
      return `${subject} fits, but it leaves you below your ${buffer} buffer.`;

    case "RISKY":
      // Neutral across all four RISKY causes — required shortfall, timing
      // shortfall, protected goal shortfall, unreliable income. Naming the
      // specific cause is the primary reason's job.
      return `${subject} doesn't fit on the current schedule.`;

    case "UNKNOWN":
      return UNKNOWN_HEADLINE;
  }
}
