/**
 * Budgets data access for the Budgets screen.
 *
 * Three reads, one write:
 *   - `fetchBudgets`         → the caps the user configured (their intent — both
 *                              windows at once).
 *   - `fetchBudgetProgress`  → spent-vs-limit for the chosen window (week or
 *                              month), computed *server-side* by core
 *                              `evaluateBudgets` (`CD-003`, `CD-011`).
 *   - `fetchSpendingSummary` → that window's category totals, used only to
 *                              populate the "add a budget" picker so a user
 *                              budgets against categories they actually spend in.
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

/** Which window the screen is editing/showing. */
export type BudgetBasis = "week" | "month";

/** A category the user has spent in this window — the menu of things worth
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
      /** The window this view is for. */
      basis: BudgetBasis;
      /** The configured caps for *both* windows (what the save round-trips). */
      config: BudgetConfig;
      /** Backend-computed progress for the resolved window. */
      progress: BudgetProgress;
      /** Categories with spend this window, for the add-a-budget picker. */
      categories: CategoryOption[];
      /** The window progress resolved to (`2026-08` or `2026-W32`) and its label. */
      periodKey: string;
      periodLabel: string;
    }
  | { kind: "error"; message: string };

/**
 * Load everything the Budgets screen needs for one window.
 *
 * `basis` selects the window (`month` default, or `week`). `key` selects which
 * one — a month key (`YYYY-MM`) or an ISO-week key (`YYYY-Www`); omitted resolves
 * to the latest-data window server-side. The spending summary is fetched *keyed
 * to the progress window resolved to*, so the picker and the progress bars can
 * never describe different periods. `config` always carries both windows' caps so
 * a save can preserve the window the user isn't editing.
 */
export async function loadBudgets(basis: BudgetBasis = "month", key?: string): Promise<BudgetsOutcome> {
  const [configResult, progressResult] = await Promise.all([
    fetchBudgets(),
    fetchBudgetProgress({ period: basis, key }),
  ]);

  const configError = errorMessage(configResult.kind);
  if (configResult.kind !== "ok") return { kind: "error", message: configError };
  if (progressResult.kind !== "ok") {
    return { kind: "error", message: errorMessage(progressResult.kind) };
  }

  const config = configResult.data;
  const progress = progressResult.data;

  // The add-a-budget menu is the same window's category totals, so a user only
  // ever caps categories the window actually contains. A summary failure here is
  // non-fatal: the screen still edits existing caps, it just can't offer new
  // categories to add.
  const summaryResult = await fetchSpendingSummary({
    period: basis,
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
    basis,
    config,
    progress,
    categories,
    periodKey: progress.period.key,
    periodLabel: progress.period.label,
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
