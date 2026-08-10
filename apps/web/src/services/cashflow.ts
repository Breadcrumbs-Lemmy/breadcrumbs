/**
 * Cash-flow calendar data access for the Cash-flow screen.
 *
 * One read: `fetchCashflow` → the whole `CashFlowCalendar`, already computed by
 * core `buildCashFlowCalendar` server-side (`CD-011`). This module never sums,
 * classifies, compares, or thresholds a figure — events, totals, running
 * balance, the projected low and the outlook status all arrive pre-computed. It
 * only fetches and maps transport outcomes into a screen-shaped result.
 *
 * The endpoint 404s with `NO_IMPORTED_HISTORY` when nothing has been imported
 * (`D-C8`: an empty calendar dressed as data would be worse than an honest
 * "import first"). That 404 arrives here as an `error` carrying the machine
 * `code`, which is mapped to a distinct `empty` outcome so the screen shows the
 * import prompt rather than a red error card.
 */
import type { CashFlowCalendar } from "@ai-fin-os/core";
import { fetchCashflow } from "./api";

export type CashflowOutcome =
  | { kind: "ready"; calendar: CashFlowCalendar }
  /** Nothing imported yet — show the import-first prompt, not an error. */
  | { kind: "empty" }
  | { kind: "error"; message: string };

/**
 * Load the cash-flow calendar for the default (or a caller-supplied) horizon.
 *
 * `horizon` is the forward window in days, clamped server-side to `[7, 60]`
 * (`D-C3`); omitted lets the server default it to 45. An out-of-range value is a
 * validation error, surfaced as `error` rather than silently clamped.
 */
export async function loadCashflow(horizon?: number): Promise<CashflowOutcome> {
  const result = await fetchCashflow({ horizon });

  if (result.kind === "ok") return { kind: "ready", calendar: result.data };

  // A 404 for "nothing imported" is an ordinary state, not a failure: the route
  // sends `NO_IMPORTED_HISTORY`, which the transport layer surfaces as an error
  // with that machine code. Treat it as the empty state.
  if (result.kind === "error" && result.code === "NO_IMPORTED_HISTORY") {
    return { kind: "empty" };
  }

  return { kind: "error", message: errorMessage(result) };
}

/** Maps a non-ok API outcome to a human message. `ok` never reaches here. */
function errorMessage(
  result: Exclude<Awaited<ReturnType<typeof fetchCashflow>>, { kind: "ok" }>,
): string {
  switch (result.kind) {
    case "unauthenticated":
      return "Authentication required.";
    case "invalid":
      return "That request wasn't valid.";
    case "rejected":
      return "That request was rejected.";
    default:
      return result.message;
  }
}
