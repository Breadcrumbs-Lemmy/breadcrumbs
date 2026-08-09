/**
 * InsightFocus — the context carried from an insight into the Transactions
 * drill-down.
 *
 * It holds which transactions to show (`ids`) plus the insight's own
 * backend-computed `totalCents`, so the focused list can show what those rows
 * add up to *without the browser ever summing money itself* (`CD-011`). The
 * total is the figure the backend already put on the insight card; we carry it
 * across rather than re-deriving it from the rows on screen.
 */
import type { Insight } from "@ai-fin-os/core";

export type InsightFocus = {
  /** The exact transactions behind the insight — the list is scoped to these. */
  ids: string[];
  /** The insight's total, straight from the backend. Never recomputed here. */
  totalCents: number;
  /** Recurring-service insights report a monthly total; the UI marks it "/mo"
   *  to match the insight card the user clicked. */
  perMonth: boolean;
  /** The insight's headline, so the focused view names what this set belongs to. */
  headline: string;
};

export function focusFromInsight(insight: Insight): InsightFocus {
  return {
    ids: insight.transactionIds,
    totalCents: insight.totalCents,
    perMonth: insight.type === "POSSIBLE_DUPLICATE_SERVICE",
    headline: insight.headline,
  };
}
