/**
 * Spending data access for the home screen.
 *
 * Two calls: the series supplies which periods exist (so the period switcher
 * has something to switch between), the summary supplies the selected one.
 * Neither sums, classifies, nor compares — that is all backend-owned
 * (`CD-003`, `CD-011`).
 */
import type { SpendingSummary } from "@ai-fin-os/core";
import { fetchAccounts, fetchSpendingSeries, fetchSpendingSummary } from "./api";
import type { PeriodKind } from "../model/period";

export type StatementAccount = { id: string; displayName: string };

/**
 * Cards that carry a statement cycle.
 *
 * Whether the statement period can be offered is a backend fact, so it is read
 * from the backend rather than declared in a UI constant — `PERIOD_SUPPORTED`
 * has drifted from reality once already (`CD-013`). An account with no cycle
 * would make the endpoint fall back to a calendar month, so an empty list here
 * is the correct reason to keep the period switched off.
 */
export async function loadStatementAccounts(): Promise<StatementAccount[]> {
  const outcome = await fetchAccounts();
  if (outcome.kind !== "ok") return [];
  return outcome.data.institutions.flatMap((institution) =>
    institution.accounts
      .filter((account) => Boolean(account.statementCycle))
      .map((account) => ({ id: account.id, displayName: account.displayName })),
  );
}

export type SeriesPoint = {
  key: string;
  label: string;
  partial: boolean;
  totalOutflowCents: number;
  totalInflowCents: number;
};

export type SpendingOutcome =
  | { kind: "ready"; summary: SpendingSummary; available: SeriesPoint[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

type SeriesResponse = { points: SeriesPoint[] };

export async function loadSpending(
  period: PeriodKind,
  key?: string,
  accountId?: string,
): Promise<SpendingOutcome> {
  // Statement periods are per-card and have no series; the caller supplies the
  // account and we fetch the current cycle only.
  const wantsSeries = period !== "statement";

  const [seriesResult, summaryResult] = await Promise.all([
    wantsSeries ? fetchSpendingSeries({ period, count: 12 }) : Promise.resolve(null),
    fetchSpendingSummary({ period, key, accountId }),
  ]);

  if (summaryResult.kind === "error") {
    return { kind: "error", message: summaryResult.message };
  }
  if (summaryResult.kind === "unauthenticated") {
    return { kind: "error", message: "Authentication required." };
  }
  if (summaryResult.kind === "invalid") {
    return { kind: "error", message: "That period isn't valid." };
  }
  if (summaryResult.kind === "rejected") {
    return { kind: "error", message: "That request was rejected." };
  }

  const summary = summaryResult.data;

  // Zero spending and zero income across every account means there is nothing
  // to show yet — an empty state, not a failure.
  if (summary.totalOutflowCents === 0 && summary.totalInflowCents === 0 && summary.accountTotals.length === 0) {
    return { kind: "empty" };
  }

  // Only periods that hold something are worth offering. The series always
  // returns a full window, so an account with three months of history was
  // showing nine empty periods to click through.
  const current: SeriesPoint = {
    key: summary.period.key,
    label: summary.period.label,
    partial: summary.period.partial,
    totalOutflowCents: summary.totalOutflowCents,
    totalInflowCents: summary.totalInflowCents,
  };

  const available =
    seriesResult && seriesResult.kind === "ok"
      ? dedupeByKey([
          ...(seriesResult.data as SeriesResponse).points.filter(
            (p) => p.totalOutflowCents !== 0 || p.totalInflowCents !== 0,
          ),
          current,
        ])
      : [current];

  return { kind: "ready", summary, available };
}

/** Keeps the selected period in the list even when it is empty, without
 *  duplicating it when the series already contains it. */
function dedupeByKey(points: SeriesPoint[]): SeriesPoint[] {
  const byKey = new Map(points.map((p) => [p.key, p]));
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
