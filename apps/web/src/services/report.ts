/**
 * Monthly-report data access.
 *
 * One call to one endpoint. The report is a backend composition of the spending
 * summary and the insights engine (see `packages/core/src/domain/monthly-report`),
 * so nothing here sums, classifies, or reshapes a figure (`CD-003`, `CD-011`).
 * This layer only translates the transport outcome into the three states the
 * screen renders: a ready report, an "import first" empty state, or an error.
 */
import type { MonthlyReport } from "@ai-fin-os/core";
import { fetchMonthlyReport, fetchSpendingSeries } from "./api";

export type ReportOutcome =
  | { kind: "ready"; report: MonthlyReport }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/** A month the user can switch the report to. `key`/`label` come straight from
 *  the backend series — the browser never composes a month label or key
 *  (`CD-003`, `CD-011`); it only lets the user pick one that already exists. */
export type ReportMonth = { key: string; label: string; partial: boolean };

/**
 * Load the report for a month, or the latest complete month when `key` is
 * omitted. A `NO_IMPORTED_HISTORY` 404 is the expected "nothing to report yet"
 * signal, not a failure — it maps to the empty state so the screen can invite an
 * import instead of showing an error.
 */
export async function loadReport(key?: string): Promise<ReportOutcome> {
  const outcome = await fetchMonthlyReport(key ? { key } : {});

  if (outcome.kind === "ok") {
    return { kind: "ready", report: outcome.data };
  }
  if (outcome.kind === "error") {
    if (outcome.code === "NO_IMPORTED_HISTORY") return { kind: "empty" };
    return { kind: "error", message: outcome.message };
  }
  if (outcome.kind === "unauthenticated") {
    return { kind: "error", message: "Authentication required." };
  }
  // A well-formed screen never sends a month the server would reject, so an
  // `invalid`/`rejected` here is a transport-shaped surprise, not a fact to show.
  return { kind: "error", message: "Couldn't load your report." };
}

/**
 * The months worth offering in the report's month switcher.
 *
 * Reuses the spending series — the same source the Spending screen switches
 * between — so the two screens agree on which months exist and how they are
 * labelled. Only months that hold movement are offered; an empty month is not
 * worth a chip. Sorted oldest→newest to match the Spending switcher's order.
 * A failure yields an empty list: the report still loads its default month and
 * simply shows no switcher.
 */
export async function loadReportMonths(): Promise<ReportMonth[]> {
  const outcome = await fetchSpendingSeries({ period: "month", count: 12 });
  if (outcome.kind !== "ok") return [];

  const points =
    (
      outcome.data as {
        points?: Array<{
          key: string;
          label: string;
          partial: boolean;
          totalOutflowCents: number;
          totalInflowCents: number;
        }>;
      }
    ).points ?? [];

  return points
    .filter((p) => p.totalOutflowCents !== 0 || p.totalInflowCents !== 0)
    .map((p) => ({ key: p.key, label: p.label, partial: p.partial }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
