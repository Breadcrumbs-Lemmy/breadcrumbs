/**
 * Goals data access for the Goals screen.
 *
 * One read pair, one write:
 *   - `loadGoals`  → the declared goals (their intent) *and* the server-computed
 *                    progress/pace for each, fetched together so the editor and
 *                    the progress panel can never describe different goal sets.
 *   - `saveGoals`  → replace the whole set with the user's typed input (re-exported
 *                    unchanged from the API layer).
 *
 * This module never sums, compares, or thresholds a figure — every status, bar,
 * remaining amount and projection arrives already computed by core `evaluateGoals`
 * (`CD-011`). It only fetches, pairs the two responses, and forwards typed input.
 */
import type { GoalsEvaluation, SavingsCapacitySuggestion } from "@ai-fin-os/core";
import {
  fetchGoalProgress,
  fetchGoals,
  fetchSavingsSuggestion,
  saveGoals,
  type GoalConfig,
} from "./api";

export { saveGoals };
export type { GoalConfig, GoalInput } from "./api";
export type { SavingsCapacitySuggestion } from "@ai-fin-os/core";

export type GoalsOutcome =
  | {
      kind: "ready";
      /** The declared goals (canonical shape) the save round-trips. */
      config: GoalConfig;
      /** Backend-computed progress, status and pace for the same set. */
      progress: GoalsEvaluation;
      /** A factual read of the user's own recent cash flow, for pre-filling a
       *  monthly target (`D-G11`). `null` when it couldn't be fetched — a
       *  non-fatal miss: the screen still edits goals, just without a prompt. */
      suggestion: SavingsCapacitySuggestion | null;
    }
  | { kind: "error"; message: string };

/** Load everything the Goals screen needs: the configured goals and their
 *  computed progress, together. A failure in either read fails the load. The
 *  savings suggestion is best-effort and never fails the load. */
export async function loadGoals(): Promise<GoalsOutcome> {
  const [configResult, progressResult, suggestionResult] = await Promise.all([
    fetchGoals(),
    fetchGoalProgress(),
    fetchSavingsSuggestion(),
  ]);

  if (configResult.kind !== "ok") return { kind: "error", message: errorMessage(configResult.kind) };
  if (progressResult.kind !== "ok") return { kind: "error", message: errorMessage(progressResult.kind) };

  return {
    kind: "ready",
    config: configResult.data,
    progress: progressResult.data,
    suggestion: suggestionResult.kind === "ok" ? suggestionResult.data : null,
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
      return "Couldn't load your goals.";
  }
}
