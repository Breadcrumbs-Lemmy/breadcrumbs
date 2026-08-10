/**
 * Category budgets — the deterministic guardrail on top of the spending summary.
 *
 * The spending summary answers "where did my money go?"; a budget answers the
 * very next question, "…and was that more than I meant to spend?" A budget is a
 * spending *cap* for a normalized category over a **week or a month** (with an
 * optional overall cap per window). This module is the single place that
 * arithmetic lives (`CD-003`): given
 * an already-computed `SpendingSummary` and the user's configured limits, it
 * returns per-category and overall progress. The browser and the AI both consume
 * these figures; neither recomputes them.
 *
 * It is deliberately distinct from `Goal` (`monthly_savings_target`): a goal is
 * a savings target, a budget is a spending cap. They share nothing but the
 * per-user "targets" persistence pattern the server layer builds around both.
 *
 * Everything here is a pure function of its inputs — no clock, no I/O. The pacing
 * projection uses the period's own `elapsedDays`/`totalDays`, and `partial`,
 * which are derived from the summary's `asOfDate` (the latest transaction date),
 * so the same inputs always yield the same output.
 */
import type { Period } from "./periods";
import type { CategoryTotal, SpendingSummary } from "./spending-summary";

/** Which recurring window a cap governs. */
export type BudgetPeriodBasis = "week" | "month";

/** A configured spending cap for one normalized category, over one window. */
export type Budget = {
  /** Normalized category id, matching `CategoryTotal.category`. */
  category: string;
  /** Limit in integer cents for the window. Must be positive; non-positive
   *  limits are ignored (a cap of zero or less is not a meaningful budget). */
  limitCents: number;
  /** The window this cap governs. Omitted means `"month"` — the v1 default — so
   *  budget files written before weekly caps existed stay valid, and a monthly
   *  cap is never re-serialised with a redundant field. A category may carry one
   *  weekly cap and one monthly cap; each is evaluated against its own period. */
  period?: BudgetPeriodBasis;
};

/** Where spending sits against a cap. `near` is the amber warning band that
 *  fires *before* the cap is breached, so a user sees it coming. */
export type BudgetStatus = "under" | "near" | "over";

/** Thresholds, expressed against the limit in basis points (10000 = 100%). Kept
 *  as a named constant like `DEFAULT_INSIGHTS_CONFIG` so the bands are visible
 *  and overridable rather than magic numbers buried in a comparison. */
export type BudgetConfig = {
  /** At or above this share of the limit is `near`. Default 90%. */
  nearRatioBasisPoints: number;
  /** Strictly above this share of the limit is `over`. Default 100%. */
  overRatioBasisPoints: number;
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  nearRatioBasisPoints: 9_000,
  overRatioBasisPoints: 10_000,
};

/** Pace-based estimate for an in-progress (partial) month: "on current pace you
 *  will spend ~X by month end." Clearly an estimate; never used to set the
 *  headline `status`, only to warn early. Absent for a complete period. */
export type BudgetProjection = {
  projectedSpendCents: number;
  projectedStatus: BudgetStatus;
  elapsedDays: number;
  totalDays: number;
};

/** Progress for one configured category budget. */
export type BudgetLine = {
  category: string;
  /** Human label from the summary (falls back to a supplied labeller, then the
   *  raw id). The UI renders this verbatim. */
  displayName: string;
  limitCents: number;
  /** Net outflow for the category this period (refund-netted, from the summary).
   *  Can be negative for a refund-dominated category. */
  spentCents: number;
  /** `limitCents - spentCents`. Positive = headroom, negative = overspent. */
  remainingCents: number;
  /** `max(0, spentCents - limitCents)`. Zero unless over. */
  overBudgetCents: number;
  /** Share of the limit used, in basis points (10000 = 100%), floored at 0 so a
   *  refund-negative category reads 0% rather than a negative bar. The UI shows a
   *  bar from this and never divides. */
  usedBasisPoints: number;
  /** Status from *actual* spend, not the projection (`D-B3`). */
  status: BudgetStatus;
  transactionCount: number;
  projection?: BudgetProjection;
};

/** Progress for the optional single overall monthly cap. Same shape as a line
 *  but not tied to a category. */
export type OverallBudgetProgress = {
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  overBudgetCents: number;
  usedBasisPoints: number;
  status: BudgetStatus;
  projection?: BudgetProjection;
};

/** The full deterministic budget picture for one period. */
export type BudgetProgress = {
  period: Period;
  currency: string;
  /** One per configured category budget, sorted worst-first (over, then near,
   *  then under; ties broken by share used, then category id) so the screen and
   *  any inline strip lead with what needs attention. */
  lines: BudgetLine[];
  /** Present only when an overall cap is configured. */
  overall?: OverallBudgetProgress;
  /** Sum of the category limits (does not include the overall cap). */
  totalLimitCents: number;
  /** Sum of spend across budgeted categories only. */
  totalSpentCents: number;
  budgetedCount: number;
  underCount: number;
  nearCount: number;
  overCount: number;
};

export type EvaluateBudgetsOptions = {
  summary: SpendingSummary;
  budgets: Budget[];
  /** Optional single overall monthly cap in integer cents. Non-positive or
   *  absent means no overall cap. */
  overallLimitCents?: number | null;
  config?: Partial<BudgetConfig>;
  /** Optional fallback labeller for a budgeted category the summary never
   *  produced a total for (so no `displayName` is available from it). */
  categoryLabel?: (categoryId: string) => string;
};

/**
 * Evaluate configured budgets against a computed spending summary.
 *
 * Reads only `summary.categoryTotals[].outflowCents` (net of refunds),
 * `summary.totalOutflowCents`, `summary.currency`, and `summary.period`. It does
 * not care how the summary was produced — calendar month, and only month, is
 * enforced by the caller (`D-B2`), because a monthly cap against a week would
 * mislead.
 */
export function evaluateBudgets(options: EvaluateBudgetsOptions): BudgetProgress {
  const { summary } = options;
  const config: BudgetConfig = { ...DEFAULT_BUDGET_CONFIG, ...options.config };
  const period = summary.period;
  // Only caps for the window being evaluated apply. A week summary evaluates
  // weekly caps; anything else evaluates monthly caps. This is what lets one
  // category hold both a weekly and a monthly cap without them colliding.
  const basis: BudgetPeriodBasis = period.kind === "week" ? "week" : "month";

  const totalsByCategory = new Map<string, CategoryTotal>();
  for (const total of summary.categoryTotals) {
    totalsByCategory.set(total.category, total);
  }

  const lines: BudgetLine[] = [];
  const seenCategories = new Set<string>();
  for (const budget of options.budgets) {
    // Skip caps that govern a different window than the one being evaluated. A
    // budget with no explicit period is monthly (back-compat), so it matches a
    // month summary only.
    if ((budget.period ?? "month") !== basis) continue;
    // A non-positive cap is not a meaningful budget; the store validates this,
    // but core stays defensive so a bad file never divides by zero. Duplicate
    // categories collapse to the first within a window — deterministic, and the
    // store enforces (period, category) uniqueness upstream.
    if (!Number.isFinite(budget.limitCents) || budget.limitCents <= 0) continue;
    if (seenCategories.has(budget.category)) continue;
    seenCategories.add(budget.category);

    const total = totalsByCategory.get(budget.category);
    const spentCents = total?.outflowCents ?? 0;
    lines.push(
      buildLine({
        category: budget.category,
        displayName: total?.displayName ?? options.categoryLabel?.(budget.category) ?? budget.category,
        transactionCount: total?.transactionCount ?? 0,
        limitCents: budget.limitCents,
        spentCents,
        period,
        config,
      }),
    );
  }

  lines.sort(compareLines);

  let underCount = 0;
  let nearCount = 0;
  let overCount = 0;
  let totalLimitCents = 0;
  let totalSpentCents = 0;
  for (const line of lines) {
    totalLimitCents += line.limitCents;
    totalSpentCents += line.spentCents;
    if (line.status === "over") overCount += 1;
    else if (line.status === "near") nearCount += 1;
    else underCount += 1;
  }

  const overall = buildOverall(options.overallLimitCents, summary, period, config);

  return {
    period,
    currency: summary.currency,
    lines,
    ...(overall ? { overall } : {}),
    totalLimitCents,
    totalSpentCents,
    budgetedCount: lines.length,
    underCount,
    nearCount,
    overCount,
  };
}

function buildLine(input: {
  category: string;
  displayName: string;
  transactionCount: number;
  limitCents: number;
  spentCents: number;
  period: Period;
  config: BudgetConfig;
}): BudgetLine {
  const { limitCents, spentCents } = input;
  return {
    category: input.category,
    displayName: input.displayName,
    limitCents,
    spentCents,
    remainingCents: limitCents - spentCents,
    overBudgetCents: Math.max(0, spentCents - limitCents),
    usedBasisPoints: usedBasisPoints(spentCents, limitCents),
    status: statusForSpend(spentCents, limitCents, input.config),
    transactionCount: input.transactionCount,
    ...projectionFor(spentCents, limitCents, input.period, input.config),
  };
}

function buildOverall(
  overallLimitCents: number | null | undefined,
  summary: SpendingSummary,
  period: Period,
  config: BudgetConfig,
): OverallBudgetProgress | undefined {
  if (overallLimitCents == null || !Number.isFinite(overallLimitCents) || overallLimitCents <= 0) {
    return undefined;
  }
  const spentCents = summary.totalOutflowCents;
  return {
    limitCents: overallLimitCents,
    spentCents,
    remainingCents: overallLimitCents - spentCents,
    overBudgetCents: Math.max(0, spentCents - overallLimitCents),
    usedBasisPoints: usedBasisPoints(spentCents, overallLimitCents),
    status: statusForSpend(spentCents, overallLimitCents, config),
    ...projectionFor(spentCents, overallLimitCents, period, config),
  };
}

/** The pace projection, as a spreadable partial so an omitted projection adds no
 *  `projection` key at all. Present only for a partial period with real elapsed
 *  days that has not already run to its full length. */
function projectionFor(
  spentCents: number,
  limitCents: number,
  period: Period,
  config: BudgetConfig,
): { projection?: BudgetProjection } {
  if (!period.partial || period.elapsedDays <= 0 || period.elapsedDays >= period.totalDays) {
    return {};
  }
  const projectedSpendCents = Math.round((spentCents * period.totalDays) / period.elapsedDays);
  return {
    projection: {
      projectedSpendCents,
      projectedStatus: statusForSpend(projectedSpendCents, limitCents, config),
      elapsedDays: period.elapsedDays,
      totalDays: period.totalDays,
    },
  };
}

/** Share of the limit used, in basis points, floored at 0. Negative spend (a
 *  refund-dominated category) reads 0%, never a negative bar. */
function usedBasisPoints(spentCents: number, limitCents: number): number {
  if (limitCents <= 0) return 0;
  return Math.max(0, Math.round((spentCents / limitCents) * 10_000));
}

/** `under` below the near band, `near` from the near band up to and including
 *  the limit, `over` strictly above it (`D-B4`). Computed off the same floored
 *  basis-point share the UI shows, so status and bar never disagree. */
function statusForSpend(spentCents: number, limitCents: number, config: BudgetConfig): BudgetStatus {
  const used = usedBasisPoints(spentCents, limitCents);
  if (used > config.overRatioBasisPoints) return "over";
  if (used >= config.nearRatioBasisPoints) return "near";
  return "under";
}

const STATUS_ORDER: Record<BudgetStatus, number> = { over: 0, near: 1, under: 2 };

/** Worst-first, deterministic. Status severity, then more-used first, then
 *  category id so ties never reorder run-to-run. */
function compareLines(left: BudgetLine, right: BudgetLine): number {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (byStatus !== 0) return byStatus;
  const byUsed = right.usedBasisPoints - left.usedBasisPoints;
  if (byUsed !== 0) return byUsed;
  return left.category.localeCompare(right.category);
}
