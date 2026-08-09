/**
 * Assumption, freshness, boundary, and interface copy.
 * Implements docs/ui-copy-map.md. Per CD-006 no backend prose is rendered.
 *
 * Each record is exhaustive over its backend union, so a new code added by
 * [Backend: Codex] breaks this build instead of silently reaching a user.
 */
import type {
  AffordabilityLevel,
  AssumptionCode,
  FreshnessWarning,
  GoalType,
  ProductBoundary,
  Uncertainty,
} from "@ai-fin-os/core";

// ---- Levels ---------------------------------------------------------------

export const LEVEL_WORD: Record<AffordabilityLevel, string> = {
  AFFORDABLE: "Affordable",
  TIGHT: "Tight",
  // "Unknown" as a verdict reads like a system failure. This phrasing locates
  // the gap in the data and implies it is resolvable.
  RISKY: "Risky",
  UNKNOWN: "Not enough information",
};

// ---- Assumptions (H-004) --------------------------------------------------

export const ASSUMPTION_COPY: Record<AssumptionCode, string> = {
  AVAILABLE_BALANCE_MISSING:
    "One account doesn't report an available balance, so its current balance was used. Pending charges may not be reflected.",
  CONSERVATIVE_INCOME_MINIMUM_USED:
    "Income is counted at its guaranteed minimum, not its expected amount.",
  FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY:
    "Flexible goal contributions are treated as delayable, so they aren't counted as required bills.",
  OPTIONAL_OBLIGATION_EXCLUDED_FROM_REQUIRED_SOLVENCY:
    "Optional items are shown in the forecast but aren't counted as required bills.",
  CADENCE_DAY_CLAMPED_TO_MONTH_END:
    "A bill falls on a day this month doesn't have, so it's counted on the last day of the month.",
  // Worth surfacing prominently: it is a real assumption that changes answers,
  // and a user who doesn't know it may find a TIGHT verdict inexplicable.
  CONSERVATIVE_SAME_DAY_ORDERING_APPLIED:
    "When bills and income land on the same day, bills are counted first.",
};

// ---- Goals (D-010) --------------------------------------------------------

/**
 * `monthly_savings_target` is the only goal type in MVP 0. Its stated user
 * intent is reducing discretionary spending to save more, which makes the copy
 * unusually easy to get wrong: it would be natural to write "this sets back
 * your savings" or to editorialise about the purchase being discretionary.
 *
 * Per D-010 and D-006 the framing is a tradeoff between two things the user
 * wants, stated neutrally. The purchase is never characterised, and the goal is
 * never described as more correct than the purchase.
 */
export const GOAL_TYPE_LABEL: Record<GoalType, string> = {
  monthly_savings_target: "Monthly savings",
};

export const GOAL_TYPE_DESCRIPTION: Record<GoalType, string> = {
  monthly_savings_target: "A set amount moved to savings each month.",
};

// ---- Freshness ------------------------------------------------------------

export const FRESHNESS_COPY: Record<FreshnessWarning["code"], string> = {
  BALANCE_STALE: "An account balance hasn't been updated recently.",
  TRANSACTIONS_INCOMPLETE:
    "Transaction history is partial. Spending summaries may not reflect everything.",
  INCOME_COVERAGE_INCOMPLETE: "Income hasn't been confirmed through the full forecast period.",
  OBLIGATION_COVERAGE_INCOMPLETE:
    "Recurring bills haven't been confirmed through the full forecast period.",
  MANUAL_DATA_UNCONFIRMED:
    "Some figures were entered manually and haven't been confirmed against an account.",
  ESTIMATED_VALUE: "Some figures are estimates.",
};

export const ESTIMATE_METHOD_COPY: Record<NonNullable<Uncertainty["estimateMethod"]>, string> = {
  user_entered: "a value you entered",
  historical_average: "your past averages",
  merchant_recurrence: "a repeating charge pattern",
  category_average: "category averages",
};

// ---- Boundaries -----------------------------------------------------------

export const BOUNDARY_COPY: Record<ProductBoundary, string> = {
  READ_ONLY_DECISION_SUPPORT: "Read-only. This app can't move money or change your accounts.",
  NOT_PERSONALIZED_FINANCIAL_ADVICE:
    "This is a projection from the numbers you've provided, not financial advice.",
  NO_ACCOUNT_WRITES: "Balances are shown as reported. Nothing here changes them.",
  DETERMINISTIC_CALCULATION: "Same inputs, same answer. This projection is calculated, not generated.",
};

// ---- Interface labels -----------------------------------------------------

export const UI_COPY = {
  primaryAction: "Check affordability",
  amountLabel: "How much?",
  dateLabel: "When?",
  categoryLabel: "What for?",
  deferrableLabel: "This could wait",
  loading: "Calculating…",
  errorBoundary: "Something went wrong on our side. Your data wasn't changed.",
  emptyNoAccounts: "Add an account to get started.",
  emptyNoPurchase: "Enter a purchase to check.",
  emptyNoTransactions: "No transactions yet. Monthly summaries appear once transactions are added.",
  moreReasons: (n: number) => `${n} more reason${n === 1 ? "" : "s"}`,
  assumptionsCount: (n: number) => `${n} assumption${n === 1 ? "" : "s"}`,
  chartTitle: "Next 30 days",
  timelineTitle: "What's coming up",
  spendingNote:
    "Monthly summaries are for understanding your spending. Affordability is projected day by day.",
  // Chart legend avoids engine vocabulary: "required path" is internal,
  // "Required bills" is what it means.
  legend: {
    required: "Required bills",
    protected: "Protected goals",
    allEvents: "All planned items",
    expected: "If expected income arrives",
  },
} as const;

export const UNKNOWN_HEADLINE = "There isn't enough information to answer this yet.";
