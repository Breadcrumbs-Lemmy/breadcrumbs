import { z } from "zod";

const EntitySourceSchema = z.enum(["manual", "fixture", "csv", "plaid", "inferred"]);
const SeveritySchema = z.enum(["info", "warning", "critical"]);
const FlowTypeSchema = z.enum([
  "SPEND",
  "INCOME",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "REFUND",
  "FEE",
  "UNCLASSIFIED",
]);
const NormalizationUncertaintyCodeSchema = z.enum([
  "unknown_merchant",
  "ambiguous_processor",
  "unknown_category",
  "transfer_like_unpaired",
]);
const TransactionPatternTagSchema = z.enum([
  "one_time",
  "planned_purchase",
  "required",
  "reimbursable",
  "shared_household",
  "ignore_for_patterns",
  "optional_service",
]);

const FreshnessWarningSchema = z.object({
  code: z.enum([
    "BALANCE_STALE",
    "TRANSACTIONS_INCOMPLETE",
    "INCOME_COVERAGE_INCOMPLETE",
    "OBLIGATION_COVERAGE_INCOMPLETE",
    "MANUAL_DATA_UNCONFIRMED",
    "ESTIMATED_VALUE",
  ]),
  severity: SeveritySchema,
  message: z.string(),
});

const FreshnessSchema = z.object({
  status: z.enum(["fresh", "usable", "stale", "missing", "estimated"]),
  asOf: z.string().optional(),
  source: EntitySourceSchema,
  ageHours: z.number().finite().nonnegative().optional(),
  warnings: z.array(FreshnessWarningSchema).default([]),
});

const UncertaintySchema = z.object({
  confidence: z.number().finite().min(0).max(1),
  confidenceReason: z.string().optional(),
  isEstimated: z.boolean(),
  estimateMethod: z
    .enum(["user_entered", "historical_average", "merchant_recurrence", "category_average"])
    .optional(),
});

const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }),
  z.object({
    kind: z.literal("weekly"),
    intervalWeeks: z.number().int().positive().default(1),
    anchorDate: z.string(),
  }),
  z.object({ kind: z.literal("biweekly"), anchorDate: z.string() }),
  z.object({
    kind: z.literal("semimonthly"),
    daysOfMonth: z.tuple([z.number().int().min(1).max(31), z.number().int().min(1).max(31)]),
  }),
  z.object({ kind: z.literal("monthly"), dayOfMonth: z.number().int().min(1).max(31) }),
  z.object({
    kind: z.literal("quarterly"),
    dayOfMonth: z.number().int().min(1).max(31),
    anchorMonth: z.number().int().min(1).max(12),
  }),
  z.object({
    kind: z.literal("annual"),
    month: z.number().int().min(1).max(12),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);

const ForecastConfigSchema = z
  .object({
    horizonDays: z.number().int().positive().default(30),
    minimumCashBufferCents: z.number().int().nonnegative().default(25_000),
    staleBalanceHours: z.number().int().positive().default(72),
    staleManualBalanceDays: z.number().int().positive().default(7),
    reliableIncomeConfidence: z.number().finite().min(0).max(1).default(0.8),
  })
  .default({});

const DataCoverageSchema = z.object({
  balancesDeclaredComplete: z.boolean(),
  incomeDeclaredCompleteThroughDate: z.string(),
  obligationsDeclaredCompleteThroughDate: z.string(),
  transactionsCompleteFromDate: z.string().optional(),
  userConfirmedNoOtherRequiredObligations: z.boolean(),
});

const AccountSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  institutionName: z.string().optional(),
  type: z.enum(["checking", "savings", "cash", "credit_card", "loan", "investment", "other"]),
  role: z.enum(["spendable_cash", "reserve_cash", "liability", "excluded"]),
  currency: z.string().length(3),
  currentBalanceCents: z.number().int(),
  availableBalanceCents: z.number().int().optional(),
  creditLimitCents: z.number().int().optional(),
  includeInForecast: z.boolean(),
  freshness: FreshnessSchema,
  source: EntitySourceSchema,
});

const TransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  postedDate: z.string(),
  authorizedDate: z.string().optional(),
  merchantName: z.string().min(1),
  originalDescription: z.string().optional(),
  amountCents: z.number().int(),
  currency: z.string().length(3),
  category: z.string().min(1),
  categoryDisplayName: z.string().min(1).optional(),
  categoryRequiredDefault: z.boolean().optional(),
  normalizedMerchantId: z.string().optional(),
  merchantCanonical: z.string().optional(),
  merchantAmbiguity: z.boolean().optional(),
  flowType: FlowTypeSchema,
  counterAccountId: z.string().optional(),
  transferMatchConfidence: z.number().finite().min(0).max(1).optional(),
  normalizationUncertaintyCodes: z.array(NormalizationUncertaintyCodeSchema).optional(),
  tags: z.array(TransactionPatternTagSchema).optional(),
  recurrenceSignal: z
    .object({
      isLikelyRecurring: z.boolean(),
      cadence: z
        .enum(["once", "weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual"])
        .optional(),
      confidence: z.number().finite().min(0).max(1),
    })
    .optional(),
  freshness: FreshnessSchema,
  uncertainty: UncertaintySchema,
  source: EntitySourceSchema,
});

const IncomeSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  expectedAmountCents: z.number().int().nonnegative(),
  minimumExpectedAmountCents: z.number().int().nonnegative(),
  cadence: CadenceSchema,
  nextExpectedDate: z.string(),
  variability: z.enum(["fixed", "variable", "irregular"]),
  reliability: z.enum(["confirmed", "expected", "uncertain"]),
  category: z.enum(["paycheck", "freelance", "benefit", "transfer", "other"]),
  active: z.boolean(),
  freshness: FreshnessSchema,
  uncertainty: UncertaintySchema,
  source: EntitySourceSchema,
  currency: z.string().length(3).optional(),
});

const RecurringObligationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
  cadence: CadenceSchema,
  nextDueDate: z.string(),
  category: z.string().min(1),
  required: z.boolean(),
  importance: z.enum(["required", "flexible", "optional"]),
  autopay: z.boolean(),
  accountId: z.string().optional(),
  active: z.boolean(),
  sourceTransactionIds: z.array(z.string()).optional(),
  freshness: FreshnessSchema,
  uncertainty: UncertaintySchema,
  source: EntitySourceSchema,
  currency: z.string().length(3).optional(),
});

export const GoalSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  goalType: z.enum(["monthly_savings_target"]),
  targetAmountCents: z.number().int().nonnegative(),
  currentAmountCents: z.number().int().nonnegative(),
  targetDate: z.string().optional(),
  monthlyContributionCents: z.number().int().nonnegative(),
  nextContributionDate: z.string(),
  contributionCadence: CadenceSchema,
  priority: z.enum(["high", "medium", "low"]),
  protection: z.enum(["protected", "flexible"]),
  category: z.string().optional(),
  active: z.boolean(),
  freshness: FreshnessSchema,
  uncertainty: UncertaintySchema,
  source: EntitySourceSchema,
  currency: z.string().length(3).optional(),
});

const PlannedPurchaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  amountCents: z.number().int().optional(),
  purchaseDate: z.string().optional(),
  category: z.string().min(1),
  necessity: z.enum(["essential", "useful", "discretionary"]),
  deferrable: z.boolean(),
  fundingAccountId: z.string().optional(),
  active: z.boolean(),
  freshness: FreshnessSchema,
  uncertainty: UncertaintySchema,
  source: EntitySourceSchema,
  currency: z.string().length(3).optional(),
});

export const FinancialSnapshotSchema = z.object({
  asOfDate: z.string(),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  config: ForecastConfigSchema,
  coverage: DataCoverageSchema,
  accounts: z.array(AccountSchema),
  transactions: z.array(TransactionSchema),
  incomeSources: z.array(IncomeSourceSchema),
  recurringObligations: z.array(RecurringObligationSchema),
  goals: z.array(GoalSchema),
  plannedPurchases: z.array(PlannedPurchaseSchema),
});

export const AffordabilityRequestSchema = z.object({
  requestId: z.string().min(1),
  snapshot: FinancialSnapshotSchema,
  plannedPurchaseId: z.string().min(1),
});
