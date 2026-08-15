/**
 * Savings goals — the deterministic pace check on a user's stated intent.
 *
 * A goal is a *savings target*: "I mean to put aside $X, I've saved $Y, I add $Z
 * a month." Unlike a spending cap read off observed transactions, a
 * goal is a **declaration** — nothing in a bank statement says "I intend to save
 * $400 a month," so a goal is user-set, persisted, and injected into the
 * snapshot; it is never derived (`D-G2`). This module is the single place goal
 * arithmetic lives (`CD-003`): it shapes a small user input into the canonical
 * `Goal` the affordability engine already consumes, and it evaluates progress and
 * pace against a goal set. The browser and the AI both consume these figures;
 * neither recomputes them.
 *
 * Everything here is a pure function of its inputs — no clock, no I/O. Pace uses
 * the caller-supplied `asOfDate` (the latest transaction date, matching every
 * other endpoint), so the same inputs always yield the same output.
 */
import { addMonths, compareDates, formatDate, parseDateParts } from "./dates";
import type { Cadence, Goal } from "./types";

export type GoalPriority = "high" | "medium" | "low";
export type GoalProtection = "protected" | "flexible";

/** The reduced shape a user declares. `buildSavingsGoal` fills the rest of the
 *  canonical `Goal` deterministically. Amounts are integer cents; non-integer or
 *  negative inputs are clamped so a bad value never divides by zero downstream. */
export type SavingsGoalInput = {
  /** Optional stable id. When absent, a slug of the label is used. */
  id?: string;
  label: string;
  targetAmountCents: number;
  /** How much is set aside already. Default 0. */
  currentAmountCents?: number;
  /** Planned monthly contribution. Default 0 (a target with no funding plan —
   *  valid, but it will read `behind`). */
  monthlyContributionCents?: number;
  /** Optional deadline (ISO date). Drives on-pace vs behind when present. */
  targetDate?: string;
  priority?: GoalPriority;
  protection?: GoalProtection;
  category?: string;
};

export type BuildSavingsGoalOptions = {
  /** The reference "now" — the latest transaction date, never the wall clock. */
  asOfDate: string;
  currency: string;
};

/** Where a goal sits against its target. `on_track` and `reached` are the good
 *  states; `behind` means the declared plan won't reach the target in time (or a
 *  target with no funding). */
export type GoalStatus = "reached" | "on_track" | "behind";

/** Pace estimate, present only for an unmet goal that is actually being funded
 *  (`monthlyContributionCents > 0`). Clearly an estimate. */
export type GoalPace = {
  /** `ceil(remaining / monthlyContribution)` — whole contributions still needed. */
  monthsToClose: number;
  /** When the final contribution lands, walking the monthly cadence forward. */
  projectedCompletionDate: string;
  /** No `targetDate` → always true (funding it, no deadline to miss). With a
   *  `targetDate` → completion lands on or before it. */
  onPace: boolean;
};

/** Progress for one goal. */
export type GoalProgress = {
  id: string;
  label: string;
  targetAmountCents: number;
  /** What is set aside (`currentAmountCents`). */
  savedCents: number;
  /** `max(0, target - saved)`. Zero once reached. */
  remainingCents: number;
  monthlyContributionCents: number;
  /** Share of the target saved, in basis points (10000 = 100%), floored at 0 and
   *  capped at 10000. The UI shows a bar from this and never divides. */
  progressBasisPoints: number;
  status: GoalStatus;
  priority: GoalPriority;
  protection: GoalProtection;
  targetDate?: string;
  currency?: string;
  /** Present only when unmet *and* funded (`D-G3`). */
  projection?: GoalPace;
};

export type EvaluateGoalsOptions = {
  goals: Goal[];
  /** The reference "now" — the latest transaction date, never the wall clock. */
  asOfDate: string;
  currency: string;
};

/** The full deterministic goal picture at one moment. */
export type GoalsEvaluation = {
  asOfDate: string;
  currency: string;
  /** One per goal, sorted worst-first (behind, then on_track, then reached; ties
   *  by least progress, then id) so the screen leads with what needs attention. */
  goals: GoalProgress[];
  totalTargetCents: number;
  totalSavedCents: number;
  totalRemainingCents: number;
  reachedCount: number;
  onTrackCount: number;
  behindCount: number;
};

const MONTHLY_CONTRIBUTION_DAY = 1;

/**
 * Shape one user input into a canonical `Goal`.
 *
 * Deterministic throughout: the contribution cadence is monthly on the 1st, the
 * next contribution is the 1st of the month after `asOfDate`, the source is
 * `manual`, and confidence is 1 (the user stated it). Amounts are coerced to
 * non-negative integers so a malformed value can never reach the arithmetic.
 */
export function buildSavingsGoal(input: SavingsGoalInput, options: BuildSavingsGoalOptions): Goal {
  const currency = options.currency.toUpperCase();
  const targetAmountCents = toNonNegativeInt(input.targetAmountCents);
  const currentAmountCents = toNonNegativeInt(input.currentAmountCents);
  const monthlyContributionCents = toNonNegativeInt(input.monthlyContributionCents);
  const cadence: Cadence = { kind: "monthly", dayOfMonth: MONTHLY_CONTRIBUTION_DAY };

  const goal: Goal = {
    id: input.id?.trim() ? input.id.trim() : `goal_${slugify(input.label)}`,
    label: input.label.trim(),
    goalType: "monthly_savings_target",
    targetAmountCents,
    currentAmountCents,
    monthlyContributionCents,
    nextContributionDate: firstOfNextMonth(options.asOfDate),
    contributionCadence: cadence,
    priority: input.priority ?? "medium",
    protection: input.protection ?? "flexible",
    active: true,
    freshness: {
      status: "usable",
      asOf: options.asOfDate,
      source: "manual",
      warnings: [],
    },
    uncertainty: {
      confidence: 1,
      confidenceReason: "User-declared savings goal.",
      isEstimated: false,
    },
    source: "manual",
    currency,
  };
  // Optional fields kept off the object entirely when absent, so a round-trip
  // through the schema doesn't invent `undefined` keys.
  if (input.targetDate) goal.targetDate = input.targetDate;
  if (input.category?.trim()) goal.category = input.category.trim();
  return goal;
}

/**
 * Shape a whole set of inputs, assigning unique ids deterministically.
 *
 * Whole-set replace is the store's write semantics (`D-G6`), so two goals that
 * slug to the same id (e.g. two "Emergency fund"s) would collide. Later
 * duplicates get a `_2`, `_3`, … suffix in input order — stable across runs.
 */
export function buildSavingsGoals(inputs: SavingsGoalInput[], options: BuildSavingsGoalOptions): Goal[] {
  const seen = new Map<string, number>();
  return inputs.map((input) => {
    const goal = buildSavingsGoal(input, options);
    const count = seen.get(goal.id) ?? 0;
    seen.set(goal.id, count + 1);
    return count === 0 ? goal : { ...goal, id: `${goal.id}_${count + 1}` };
  });
}

/**
 * Evaluate a goal set: per-goal progress and pace, plus a rollup.
 *
 * Reads only each goal's declared amounts, contribution, cadence and optional
 * deadline. No transactions, no clock — pace walks the monthly cadence forward
 * from `nextContributionDate`, so the answer is a pure function of the inputs.
 */
export function evaluateGoals(options: EvaluateGoalsOptions): GoalsEvaluation {
  const lines = options.goals.map((goal) => buildProgress(goal, options.asOfDate));
  lines.sort(compareProgress);

  let totalTargetCents = 0;
  let totalSavedCents = 0;
  let totalRemainingCents = 0;
  let reachedCount = 0;
  let onTrackCount = 0;
  let behindCount = 0;
  for (const line of lines) {
    totalTargetCents += line.targetAmountCents;
    totalSavedCents += line.savedCents;
    totalRemainingCents += line.remainingCents;
    if (line.status === "reached") reachedCount += 1;
    else if (line.status === "on_track") onTrackCount += 1;
    else behindCount += 1;
  }

  return {
    asOfDate: options.asOfDate,
    currency: options.currency.toUpperCase(),
    goals: lines,
    totalTargetCents,
    totalSavedCents,
    totalRemainingCents,
    reachedCount,
    onTrackCount,
    behindCount,
  };
}

function buildProgress(goal: Goal, asOfDate: string): GoalProgress {
  const targetAmountCents = Math.max(0, Math.round(goal.targetAmountCents));
  const savedCents = Math.max(0, Math.round(goal.currentAmountCents));
  const monthlyContributionCents = Math.max(0, Math.round(goal.monthlyContributionCents));
  const remainingCents = Math.max(0, targetAmountCents - savedCents);
  const reached = targetAmountCents <= 0 || savedCents >= targetAmountCents;

  const base: GoalProgress = {
    id: goal.id,
    label: goal.label,
    targetAmountCents,
    savedCents,
    remainingCents,
    monthlyContributionCents,
    progressBasisPoints: progressBasisPoints(savedCents, targetAmountCents),
    status: "reached",
    priority: goal.priority,
    protection: goal.protection,
    ...(goal.targetDate ? { targetDate: goal.targetDate } : {}),
    ...(goal.currency ? { currency: goal.currency } : {}),
  };

  if (reached) return base;

  // Unmet but unfunded: no pace can be projected, and a target you never fund is
  // not on track (`D-G4`).
  if (monthlyContributionCents <= 0) {
    return { ...base, status: "behind" };
  }

  const projection = paceFor(remainingCents, monthlyContributionCents, goal, asOfDate);
  return { ...base, status: projection.onPace ? "on_track" : "behind", projection };
}

/** Walk the monthly cadence forward from the next contribution: the k-th
 *  contribution lands on `nextContributionDate + (k - 1)` months, so the final
 *  one (the completion) is `monthsToClose - 1` months past it. */
function paceFor(
  remainingCents: number,
  monthlyContributionCents: number,
  goal: Goal,
  asOfDate: string,
): GoalPace {
  const monthsToClose = Math.ceil(remainingCents / monthlyContributionCents);
  const anchor = isFirstOfMonthContribution(goal) ? goal.nextContributionDate : firstOfNextMonth(asOfDate);
  const projectedCompletionDate = addMonths(anchor, monthsToClose - 1, MONTHLY_CONTRIBUTION_DAY);
  const onPace = !goal.targetDate || compareDates(projectedCompletionDate, goal.targetDate) <= 0;
  return { monthsToClose, projectedCompletionDate, onPace };
}

function isFirstOfMonthContribution(goal: Goal): boolean {
  return goal.contributionCadence.kind === "monthly" && goal.contributionCadence.dayOfMonth === MONTHLY_CONTRIBUTION_DAY;
}

/** Share of the target saved, in basis points, floored at 0 and capped at 10000
 *  (over-saving reads a full bar, never past it). A non-positive target is a
 *  reached goal, shown full. */
function progressBasisPoints(savedCents: number, targetAmountCents: number): number {
  if (targetAmountCents <= 0) return 10_000;
  return Math.max(0, Math.min(10_000, Math.round((savedCents / targetAmountCents) * 10_000)));
}

const STATUS_ORDER: Record<GoalStatus, number> = { behind: 0, on_track: 1, reached: 2 };

/** Worst-first, deterministic. Status severity, then least progress first (the
 *  goal needing the most attention), then id so ties never reorder run-to-run. */
function compareProgress(left: GoalProgress, right: GoalProgress): number {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (byStatus !== 0) return byStatus;
  const byProgress = left.progressBasisPoints - right.progressBasisPoints;
  if (byProgress !== 0) return byProgress;
  return left.id.localeCompare(right.id);
}

/** The 1st of the month strictly after `asOfDate` — the first contribution date
 *  for a monthly-on-the-1st cadence. */
function firstOfNextMonth(asOfDate: string): string {
  const { year, month } = parseDateParts(asOfDate);
  return addMonths(formatDate(year, month, 1), 1, MONTHLY_CONTRIBUTION_DAY);
}

function toNonNegativeInt(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/** A url-safe slug of the label for a stable default id. Empty labels (already
 *  rejected upstream) fall back to `goal`. */
function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "goal";
}
