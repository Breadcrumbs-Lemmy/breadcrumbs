export type EntitySource = "manual" | "fixture" | "csv" | "plaid" | "inferred";

export type FreshnessStatus = "fresh" | "usable" | "stale" | "missing" | "estimated";

export type FreshnessWarning = {
  code:
    | "BALANCE_STALE"
    | "TRANSACTIONS_INCOMPLETE"
    | "INCOME_COVERAGE_INCOMPLETE"
    | "OBLIGATION_COVERAGE_INCOMPLETE"
    | "MANUAL_DATA_UNCONFIRMED"
    | "ESTIMATED_VALUE";
  severity: "info" | "warning" | "critical";
  message: string;
};

export type Freshness = {
  status: FreshnessStatus;
  asOf?: string;
  source: EntitySource;
  ageHours?: number;
  warnings: FreshnessWarning[];
};

export type Uncertainty = {
  confidence: number;
  confidenceReason?: string;
  isEstimated: boolean;
  estimateMethod?: "user_entered" | "historical_average" | "merchant_recurrence" | "category_average";
};

export type AssumptionCode =
  | "AVAILABLE_BALANCE_MISSING"
  | "CONSERVATIVE_INCOME_MINIMUM_USED"
  | "FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY"
  | "OPTIONAL_OBLIGATION_EXCLUDED_FROM_REQUIRED_SOLVENCY"
  | "CADENCE_DAY_CLAMPED_TO_MONTH_END"
  | "CONSERVATIVE_SAME_DAY_ORDERING_APPLIED";

export type Assumption = {
  code: AssumptionCode;
  severity: "info" | "warning" | "critical";
  message: string;
  relatedEntityIds: string[];
};

export type Cadence =
  | { kind: "once" }
  | { kind: "weekly"; intervalWeeks: number; anchorDate: string }
  | { kind: "biweekly"; anchorDate: string }
  | { kind: "semimonthly"; daysOfMonth: [number, number] }
  | { kind: "monthly"; dayOfMonth: number }
  | { kind: "quarterly"; dayOfMonth: number; anchorMonth: number }
  | { kind: "annual"; month: number; dayOfMonth: number };

export type ForecastConfig = {
  horizonDays: number;
  minimumCashBufferCents: number;
  staleBalanceHours: number;
  staleManualBalanceDays: number;
  reliableIncomeConfidence: number;
};

export type DataCoverage = {
  balancesDeclaredComplete: boolean;
  incomeDeclaredCompleteThroughDate: string;
  obligationsDeclaredCompleteThroughDate: string;
  transactionsCompleteFromDate?: string;
  userConfirmedNoOtherRequiredObligations: boolean;
};

/**
 * A credit card's billing cycle.
 *
 * Present only on credit cards, and the reason it exists is the product's
 * central user problem: a card closing on the 18th means the bill arriving in
 * August is mostly July spending. A calendar-month total can never reconcile to
 * the statement the user actually pays.
 *
 * `source` matters because a closing day inferred from payment dates is a
 * guess, and the UI must be able to say so rather than presenting it as fact.
 */
export type StatementCycle = {
  closingDay: number;
  dueDayOfMonth?: number;
  lastStatementBalanceCents?: number;
  source: "plaid" | "user_provided" | "inferred";
};

export type Account = {
  id: string;
  displayName: string;
  institutionName?: string;
  type: "checking" | "savings" | "cash" | "credit_card" | "loan" | "investment" | "other";
  role: "spendable_cash" | "reserve_cash" | "liability" | "excluded";
  currency: string;
  currentBalanceCents: number;
  availableBalanceCents?: number;
  creditLimitCents?: number;
  includeInForecast: boolean;
  /** Credit cards only. See `StatementCycle`. */
  statementCycle?: StatementCycle;
  freshness: Freshness;
  source: EntitySource;
};

export type FlowType =
  | "SPEND"
  | "INCOME"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "REFUND"
  | "FEE"
  | "UNCLASSIFIED";

export type NormalizationUncertaintyCode =
  | "unknown_merchant"
  | "ambiguous_processor"
  | "unknown_category"
  | "transfer_like_unpaired";

export type TransactionPatternTag =
  | "one_time"
  | "planned_purchase"
  | "required"
  | "reimbursable"
  | "shared_household"
  | "ignore_for_patterns"
  | "optional_service";

export type Transaction = {
  id: string;
  accountId: string;
  postedDate: string;
  authorizedDate?: string;
  merchantName: string;
  originalDescription?: string;
  amountCents: number;
  currency: string;
  category: string;
  categoryDisplayName?: string;
  categoryRequiredDefault?: boolean;
  normalizedMerchantId?: string;
  merchantCanonical?: string;
  merchantAmbiguity?: boolean;
  flowType: FlowType;
  counterAccountId?: string;
  transferMatchConfidence?: number;
  normalizationUncertaintyCodes?: NormalizationUncertaintyCode[];
  tags?: TransactionPatternTag[];
  recurrenceSignal?: {
    isLikelyRecurring: boolean;
    cadence?: Cadence["kind"];
    confidence: number;
  };
  freshness: Freshness;
  uncertainty: Uncertainty;
  source: EntitySource;
};

export type SpendingComparisonDirection = "up" | "down" | "flat" | "new";

export type MonthlySpendingComparison = {
  recentMonth: string;
  baselineMonths: string[];
  baselineMonthCount: number;
  recentOutflowCents: number;
  baselineAverageOutflowCents: number;
  outflowChangeCents: number;
  outflowChangePercentBasisPoints?: number;
  direction: SpendingComparisonDirection;
  categoryComparisons: {
    category: string;
    displayName: string;
    requiredDefault: boolean;
    recentOutflowCents: number;
    baselineAverageOutflowCents: number;
    outflowChangeCents: number;
    outflowChangePercentBasisPoints?: number;
    direction: SpendingComparisonDirection;
    recentTransactionCount: number;
  }[];
};

export type MonthlySpendingAttribution = {
  id: string;
  displayName: string;
  institutionName: string;
  accountIds?: string[];
  accountType?: Account["type"];
  accountRole?: Account["role"];
  totalOutflowCents: number;
  grossOutflowCents: number;
  totalInflowCents: number;
  transactionCount: number;
  incomeTransactionCount: number;
  refundCents: number;
  refundTransactionCount: number;
  excludedTransferOutflowCents: number;
  excludedTransferInflowCents: number;
  excludedCreditCardPaymentOutflowCents: number;
  excludedCreditCardPaymentInflowCents: number;
  unclassifiedOutflowCents: number;
  unclassifiedInflowCents: number;
};

export type MonthlySpendingSummary = {
  month: string;
  currency: string;
  totalOutflowCents: number;
  grossOutflowCents: number;
  totalInflowCents: number;
  refundCents: number;
  categoryTotals: {
    category: string;
    displayName: string;
    requiredDefault: boolean;
    outflowCents: number;
    grossOutflowCents: number;
    refundCents: number;
    transactionCount: number;
    refundTransactionCount: number;
  }[];
  merchantTotals: {
    normalizedMerchantId: string;
    displayName: string;
    merchantAmbiguity: boolean;
    ambiguousTransactionCount: number;
    unknownTransactionCount: number;
    outflowCents: number;
    grossOutflowCents: number;
    refundCents: number;
    transactionCount: number;
    refundTransactionCount: number;
  }[];
  accountTotals: MonthlySpendingAttribution[];
  institutionTotals: MonthlySpendingAttribution[];
  excludedTransferOutflowCents: number;
  excludedTransferInflowCents: number;
  excludedCreditCardPaymentOutflowCents: number;
  excludedCreditCardPaymentInflowCents: number;
  unclassifiedOutflowCents: number;
  unclassifiedInflowCents: number;
  comparison: MonthlySpendingComparison;
  freshness: Freshness;
  uncertainty: Uncertainty;
};

export type GoalType = "monthly_savings_target";

export type IncomeSource = {
  id: string;
  label: string;
  expectedAmountCents: number;
  minimumExpectedAmountCents: number;
  cadence: Cadence;
  nextExpectedDate: string;
  variability: "fixed" | "variable" | "irregular";
  reliability: "confirmed" | "expected" | "uncertain";
  category: "paycheck" | "freelance" | "benefit" | "transfer" | "other";
  active: boolean;
  freshness: Freshness;
  uncertainty: Uncertainty;
  source: EntitySource;
  currency?: string;
};

export type RecurringObligation = {
  id: string;
  label: string;
  amountCents: number;
  cadence: Cadence;
  nextDueDate: string;
  category: string;
  required: boolean;
  importance: "required" | "flexible" | "optional";
  autopay: boolean;
  accountId?: string;
  active: boolean;
  sourceTransactionIds?: string[];
  freshness: Freshness;
  uncertainty: Uncertainty;
  source: EntitySource;
  currency?: string;
};

export type Goal = {
  id: string;
  label: string;
  goalType: GoalType;
  targetAmountCents: number;
  currentAmountCents: number;
  targetDate?: string;
  monthlyContributionCents: number;
  nextContributionDate: string;
  contributionCadence: Cadence;
  priority: "high" | "medium" | "low";
  protection: "protected" | "flexible";
  category?: string;
  active: boolean;
  freshness: Freshness;
  uncertainty: Uncertainty;
  source: EntitySource;
  currency?: string;
};

export type PlannedPurchase = {
  id: string;
  label: string;
  amountCents?: number;
  purchaseDate?: string;
  category: string;
  necessity: "essential" | "useful" | "discretionary";
  deferrable: boolean;
  fundingAccountId?: string;
  active: boolean;
  freshness: Freshness;
  uncertainty: Uncertainty;
  source: EntitySource;
  currency?: string;
};

export type FinancialSnapshot = {
  asOfDate: string;
  timezone: string;
  currency: string;
  config: ForecastConfig;
  coverage: DataCoverage;
  accounts: Account[];
  transactions: Transaction[];
  incomeSources: IncomeSource[];
  recurringObligations: RecurringObligation[];
  goals: Goal[];
  plannedPurchases: PlannedPurchase[];
};

export type ForecastEvent = {
  id: string;
  sourceEntityId: string;
  sourceType: "income" | "obligation" | "goal" | "planned_purchase" | "transaction";
  date: string;
  label: string;
  amountCents: number;
  path: "required" | "protected" | "all" | "expected_reference";
  requiredCashNeed: boolean;
  reliableIncome: boolean;
  confidence: number;
};

export type ForecastPathMetrics = {
  openingBalanceCents: number;
  endingBalanceCents: number;
  minimumBalanceCents: number;
  minimumBalanceDate: string;
  minimumIntradayBalanceCents: number;
  minimumIntradayBalanceDate: string;
  bufferMarginCents: number;
};

export type AffordabilityLevel = "AFFORDABLE" | "TIGHT" | "RISKY" | "UNKNOWN";

export type ReasonCode =
  | "BUFFER_PASSED"
  | "TIMING_RESERVE_PASSED"
  | "BUFFER_BELOW_MINIMUM"
  | "TIMING_RESERVE_LOW"
  | "OPTIONAL_OBLIGATION_TRADEOFF"
  | "GOAL_BUFFER_CONFLICT"
  | "BASELINE_ALREADY_TIGHT"
  | "REQUIRED_OBLIGATION_SHORTFALL"
  | "TIMING_RESERVE_SHORTFALL"
  | "HIGH_PRIORITY_GOAL_SHORTFALL"
  | "VARIABLE_INCOME_NOT_GUARANTEED"
  | "STALE_BALANCE"
  | "MISSING_PURCHASE_FIELD"
  | "COVERAGE_INCOMPLETE";

export type ReasonParameterMap = {
  BUFFER_PASSED: {
    requiredBufferMarginCents: number;
    minimumCashBufferCents: number;
    minimumBalanceDate: string;
  };
  TIMING_RESERVE_PASSED: {
    postPurchaseCashCents: number;
    timingReserveCents: number;
    timingReserveMarginCents: number;
    timingReserveWindowEndDate: string;
    nextReliableIncomeDate?: string;
    minimumCashBufferCents: number;
  };
  BUFFER_BELOW_MINIMUM: {
    path: "required" | "protected" | "all";
    minimumBalanceCents: number;
    minimumBalanceDate: string;
    bufferMarginCents: number;
    bufferShortfallCents: number;
    minimumCashBufferCents: number;
  };
  TIMING_RESERVE_LOW: {
    postPurchaseCashCents: number;
    timingReserveCents: number;
    timingReserveMarginCents: number;
    timingReserveWindowEndDate: string;
    nextReliableIncomeDate?: string;
    minimumCashBufferCents: number;
  };
  OPTIONAL_OBLIGATION_TRADEOFF: {
    allEventsMinimumBalanceCents: number;
    allEventsMinimumBalanceDate: string;
    allEventsBufferMarginCents: number;
    minimumCashBufferCents: number;
  };
  GOAL_BUFFER_CONFLICT: {
    protectedMinimumBalanceCents: number;
    protectedMinimumBalanceDate: string;
    protectedBufferMarginCents: number;
    baselineProtectedMinimumBalanceCents: number;
    minimumCashBufferCents: number;
  };
  BASELINE_ALREADY_TIGHT: {
    baselineMinimumBalanceCents: number;
    baselineMinimumBalanceDate: string;
    baselineBufferMarginCents: number;
    purchaseImpactOnMinimumCents: number;
    minimumCashBufferCents: number;
  };
  REQUIRED_OBLIGATION_SHORTFALL: {
    requiredMinimumBalanceCents: number;
    requiredMinimumBalanceDate: string;
  };
  TIMING_RESERVE_SHORTFALL: {
    postPurchaseCashCents: number;
    timingReserveCents: number;
    timingReserveMarginCents: number;
    timingReserveWindowEndDate: string;
    nextReliableIncomeDate?: string;
    minimumCashBufferCents: number;
  };
  HIGH_PRIORITY_GOAL_SHORTFALL: {
    protectedMinimumBalanceCents: number;
    protectedMinimumBalanceDate: string;
  };
  VARIABLE_INCOME_NOT_GUARANTEED: {
    requiredMinimumBalanceCents: number;
    requiredMinimumBalanceDate: string;
    expectedReferenceMinimumBalanceCents: number;
    expectedReferenceMinimumBalanceDate: string;
  };
  STALE_BALANCE: {
    staleAccountIds: string[];
    criticalFreshnessWarningCount: number;
  };
  MISSING_PURCHASE_FIELD: {
    missingFields: ("purchase" | "amountCents" | "purchaseDate")[];
  };
  COVERAGE_INCOMPLETE: {
    coverageType: "balances" | "income" | "obligations" | "currency" | "date" | "unknown";
    horizonEndDate?: string;
  };
};

export type DecisionReason = {
  [Code in ReasonCode]: {
    code: Code;
    severity: "info" | "warning" | "critical";
    level: AffordabilityLevel;
    parameters: ReasonParameterMap[Code];
    amountCents?: number;
    date?: string;
    relatedEntityIds: string[];
    facts: string[];
  };
}[ReasonCode];

export type AffordabilityRequestValidationIssue = {
  path: (string | number)[];
  code: string;
  message: string;
};

export class AffordabilityRequestValidationError extends Error {
  readonly issues: AffordabilityRequestValidationIssue[];

  constructor(issues: AffordabilityRequestValidationIssue[]) {
    super(`Invalid affordability request: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "AffordabilityRequestValidationError";
    this.issues = issues;
  }
}

export type ProductBoundary =
  | "READ_ONLY_DECISION_SUPPORT"
  | "NOT_PERSONALIZED_FINANCIAL_ADVICE"
  | "NO_ACCOUNT_WRITES"
  | "DETERMINISTIC_CALCULATION";

export type DecisionExplanation = {
  headlineFact: string;
  reasons: DecisionReason[];
  assumptions: Assumption[];
  freshnessWarnings: FreshnessWarning[];
  boundaries: ProductBoundary[];
};

export type AffordabilityRequest = {
  requestId: string;
  snapshot: FinancialSnapshot;
  plannedPurchaseId: string;
};

export type AffordabilityResponse = {
  requestId: string;
  asOfDate: string;
  horizonStartDate: string;
  horizonEndDate: string;
  level: AffordabilityLevel;
  purchase: {
    id: string;
    label: string;
    amountCents?: number;
    purchaseDate?: string;
  };
  metrics: {
    openingSpendableCashCents: number;
    requiredPath: ForecastPathMetrics;
    protectedPath: ForecastPathMetrics;
    allEventsPath: ForecastPathMetrics;
    expectedReferencePath?: ForecastPathMetrics;
    postPurchaseCashCents: number;
    timingReserveCents: number;
    timingReserveMarginCents: number;
    purchaseImpactOnMinimumCents: number;
  };
  forecast: {
    events: ForecastEvent[];
    dailyBalances: {
      date: string;
      requiredPathBalanceCents: number;
      protectedPathBalanceCents: number;
      allEventsPathBalanceCents: number;
      expectedReferencePathBalanceCents?: number;
    }[];
  };
  monthlySpendingSummaries: MonthlySpendingSummary[];
  explanation: DecisionExplanation;
  debug?: {
    baselineMinimumCents: number;
    scenarioMinimumCents: number;
    deterministicVersion: string;
  };
};
