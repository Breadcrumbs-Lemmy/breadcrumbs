export { evaluateAffordability } from "./domain/evaluate-affordability";
export { expandCadence } from "./domain/recurrence";
export { AffordabilityRequestSchema, FinancialSnapshotSchema, GoalSchema } from "./domain/schemas";
export { annotateTransferPairs, summarizeMonthlySpending } from "./domain/monthly-spending";
export { summarizeSpending, spendingSeries } from "./domain/spending-summary";
export { buildMonthlyReport, toReportCsv } from "./domain/monthly-report";
export type { MonthlyReport, BuildMonthlyReportOptions } from "./domain/monthly-report";
export {
  periodForDate,
  periodFromKey,
  recentPeriods,
  statementPeriodForDate,
  containsDate,
  baselineLabel,
} from "./domain/periods";
export { queryTransactions } from "./domain/transactions-query";
export { detectInsights, DEFAULT_INSIGHTS_CONFIG } from "./domain/insights";
export { evaluateBudgets, DEFAULT_BUDGET_CONFIG } from "./domain/budgets";
export type {
  Budget,
  BudgetPeriodBasis,
  BudgetStatus,
  BudgetConfig,
  BudgetProjection,
  BudgetLine,
  OverallBudgetProgress,
  BudgetProgress,
  EvaluateBudgetsOptions,
} from "./domain/budgets";
export { buildSavingsGoal, buildSavingsGoals, evaluateGoals } from "./domain/goals";
export type {
  SavingsGoalInput,
  BuildSavingsGoalOptions,
  GoalPriority,
  GoalProtection,
  GoalStatus,
  GoalPace,
  GoalProgress,
  EvaluateGoalsOptions,
  GoalsEvaluation,
} from "./domain/goals";
export { suggestSavingsCapacity, ESSENTIAL_CATEGORIES } from "./domain/savings-capacity";
export type {
  SavingsCapacityOptions,
  SavingsCapacitySuggestion,
} from "./domain/savings-capacity";
export { buildCashFlowCalendar } from "./domain/cashflow-calendar";
export type {
  CashFlowCalendar,
  CashFlowEvent,
  CashFlowEventKind,
  CashFlowEventStatus,
  CashFlowOutlookStatus,
  BuildCashFlowCalendarOptions,
} from "./domain/cashflow-calendar";
export { buildAccountsView } from "./domain/accounts-view";
export {
  buildNetWorthTrend,
  currentNetWorthObservation,
  DEFAULT_NET_WORTH_MONTHS,
} from "./domain/net-worth-trend";
export type {
  NetWorthBasis,
  NetWorthPoint,
  NetWorthSnapshot,
  NetWorthTrend,
  NetWorthTrendOptions,
} from "./domain/net-worth-trend";
export {
  DEFAULT_RECURRING_SPENDING_CONFIG,
  PATTERN_RULES_VERSION,
  detectRecurringSpending,
} from "./domain/pattern-detection";
export { annotateRecurrenceSignals } from "./domain/recurrence-annotation";
export type { AnnotateRecurrenceOptions } from "./domain/recurrence-annotation";
export {
  buildSnapshotFromHistory,
  DEFAULT_FORECAST_CONFIG,
} from "./domain/snapshot-from-history";
export type {
  SnapshotDerivation,
  SnapshotFromHistoryOptions,
} from "./domain/snapshot-from-history";
export {
  CATEGORY_TAXONOMY,
  categoryRequiredByDefault,
  getCategoryMetadata,
  merchantKeyFromText,
  normalizeStatementTransaction,
  normalizeTransactionLabels,
} from "./domain/normalization";
export type { Period, PeriodKind } from "./domain/periods";
export type {
  SpendingSummary,
  SpendingComparison,
  CategoryTotal,
  AccountTotal,
  InstitutionTotal,
  SummarizeOptions,
} from "./domain/spending-summary";
export type {
  TransactionView,
  TransactionQuery,
  TransactionPage,
  UnclassifiedReason,
} from "./domain/transactions-query";
export type {
  Insight,
  InsightType,
  InsightConfidence,
  InsightsResult,
  InsightsConfig,
  RecurringItem,
} from "./domain/insights";
export type {
  AccountsResult,
  AccountView,
  InstitutionView,
  StatementCycleView,
  AccountConnectionStatus,
} from "./domain/accounts-view";
export type {
  CategoryMetadata,
  NormalizedCategoryId,
  NormalizedStatementTransaction,
} from "./domain/normalization";
export type {
  Account,
  AffordabilityLevel,
  AffordabilityRequest,
  AffordabilityRequestValidationIssue,
  AffordabilityResponse,
  Assumption,
  AssumptionCode,
  Cadence,
  DataCoverage,
  DecisionExplanation,
  DecisionReason,
  EntitySource,
  FinancialSnapshot,
  ForecastConfig,
  StatementCycle,
  ForecastEvent,
  ForecastPathMetrics,
  Freshness,
  FreshnessStatus,
  FreshnessWarning,
  FlowType,
  Goal,
  GoalType,
  IncomeSource,
  MonthlySpendingAttribution,
  MonthlySpendingComparison,
  MonthlySpendingSummary,
  NormalizationUncertaintyCode,
  PlannedPurchase,
  ProductBoundary,
  ReasonCode,
  ReasonParameterMap,
  RecurringObligation,
  Transaction,
  TransactionPatternTag,
  Uncertainty,
} from "./domain/types";
export { AffordabilityRequestValidationError } from "./domain/types";
export type {
  DetectedRecurringCadence,
  LikelySubscriptionEvidence,
  PatternAssumption,
  PatternAssumptionCode,
  PatternConfidenceBand,
  PatternConfidenceCap,
  PatternConfidenceFactor,
  PatternDiagnostic,
  PatternDiagnosticCode,
  PatternEntity,
  PatternEvidence,
  PatternInsight,
  PatternInsightType,
  PatternSavingsImpact,
  PatternUncertainty,
  PatternUncertaintyCode,
  PatternWindow,
  PossibleDuplicateServiceEvidence,
  RecurringSpendingConfig,
  RecurringSpendingDetectionInput,
  RecurringSpendingDetectionResult,
} from "./domain/pattern-detection";
