/**
 * Budgets data access for the Budgets screen.
 *
 * Three reads, one write:
 *   - `fetchBudgets`         → the caps the user configured (their intent).
 *   - `fetchBudgetProgress`  → spent-vs-limit for a month, computed *server-side*
 *                              by core `evaluateBudgets` (`CD-003`, `CD-011`).
 *   - `fetchSpendingSummary` → the month's category totals, used only to populate
 *                              the "add a budget" picker so a user budgets against
 *                              categories they actually spend in.
 *   - `saveBudgets`          → replace the whole set (re-exported unchanged).
 *
 * This module never sums, classifies, compares, or thresholds a figure — status,
 * bars, remaining, and projections all arrive already computed. It only fetches,
 * reshapes the picker list, and forwards the user's typed caps back.
 */
import type { BudgetProgress } from "@ai-fin-os/core";
import {
  fetchBudgetProgress,
  fetchBudgets,
  fetchSpendingSummary,
  saveBudgets,
  type BudgetConfig,
} from "./api";

export { saveBudgets };
export type { BudgetConfig } from "./api";

/** A category the user has spent in this month — the menu of things worth
 *  capping. `outflowCents` is shown next to each option so a sensible first cap
 *  is obvious; it is a backend figure, displayed, never used in a calculation. */
export type CategoryOption = {
  category: string;
  displayName: string;
  outflowCents: number;
};

export type BudgetsOutcome =
  | {
      kind: "ready";
      /** The configured caps (what the save round-trips). */
      config: BudgetConfig;
      /** Backend-computed progress for the resolved month. */
      progress: BudgetProgress;
      /** Categories with spend this month, for the add-a-budget picker. */
      categories: CategoryOption[];
      /** The month progress resolved to (e.g. `2026-08`) and its label. */
      monthKey: string;
      monthLabel: string;
    }
  | { kind: "error"; message: string };

/**
 * Load everything the Budgets screen needs for one month.
 *
 * `key` selects the month (`YYYY-MM`); omitted resolves to the latest-data month
 * server-side. The spending summary is fetched *keyed to the month progress
 * resolved to*, so the picker and the progress bars can never describe different
 * months.
 */
export async function loadBudgets(key?: string): Promise<BudgetsOutcome> {
  const [configResult, progressResult] = await Promise.all([
    fetchBudgets(),
    fetchBudgetProgress({ key }),
  ]);

  const configError = errorMessage(configResult.kind);
  if (configResult.kind !== "ok") return { kind: "error", message: configError };
  if (progressResult.kind !== "ok") {
    return { kind: "error", message: errorMessage(progressResult.kind) };
  }

  const config = configResult.data;
  const progress = progressResult.data;

  // The add-a-budget menu is the same month's category totals, so a user only
  // ever caps categories the month actually contains. A summary failure here is
  // non-fatal: the screen still edits existing caps, it just can't offer new
  // categories to add.
  const summaryResult = await fetchSpendingSummary({
    period: "month",
    key: progress.period.key,
  });
  const categories: CategoryOption[] =
    summaryResult.kind === "ok"
      ? summaryResult.data.categoryTotals
          .filter((c) => c.outflowCents > 0)
          .map((c) => ({
            category: c.category,
            displayName: c.displayName,
            outflowCents: c.outflowCents,
          }))
      : [];

  return {
    kind: "ready",
    config,
    progress,
    categories,
    monthKey: progress.period.key,
    monthLabel: progress.period.label,
  };
}

/** Maps a non-ok API outcome kind to a human message. `ok` never reaches here. */
function errorMessage(kind: "ok" | "invalid" | "rejected" | "error" | "unauthenticated"): string {
  switch (kind) {
    case "unauthenticated":
      return "Authentication required.";
    case "invalid":
      return "That request wasn't valid.";
    case "rejected":
      return "That request was rejected.";
    default:
      return "Couldn't load your budgets.";
  }
}
