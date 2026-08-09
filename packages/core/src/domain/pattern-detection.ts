import { addDays, addMonths, compareDates, daysBetween } from "./dates";
import { categoryRequiredByDefault, getCategoryMetadata, merchantKeyFromText } from "./normalization";
import type { Account, FlowType, Transaction, TransactionPatternTag } from "./types";

export const PATTERN_RULES_VERSION = "mvp0-2026-08-04";

export type RecurringSpendingConfig = {
  lookbackDays: number;
  subscriptionMinimumCoverageDays: number;
  subscriptionPreferredCoverageDays: number;
  subscriptionRecentGraceDays: number;
  amountToleranceFloorCents: number;
  amountToleranceRatio: number;
};

export const DEFAULT_RECURRING_SPENDING_CONFIG: RecurringSpendingConfig = {
  lookbackDays: 180,
  subscriptionMinimumCoverageDays: 60,
  subscriptionPreferredCoverageDays: 90,
  subscriptionRecentGraceDays: 15,
  amountToleranceFloorCents: 200,
  amountToleranceRatio: 0.1,
};

export type PatternInsightType = "likely_subscription" | "possible_duplicate_service";

export type PatternConfidenceBand = "suppressed" | "low" | "medium" | "high";

export type DetectedRecurringCadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

export type PatternUncertaintyCode =
  | "insufficient_history"
  | "stale_account_data"
  | "unknown_merchant"
  | "ambiguous_processor"
  | "unknown_category"
  | "currency_mismatch"
  | "active_status_uncertain"
  | "sparse_evidence";

export type PatternAssumptionCode =
  | "same_individual_accounts"
  | "normalized_merchant_grouping"
  | "normalized_category_required_defaults"
  | "transfer_and_refund_exclusion"
  | "same_account_record_deduplication"
  | "service_group_taxonomy";

export type PatternDiagnosticCode =
  | "insufficient_history"
  | "excluded_non_spend_flow"
  | "excluded_required_bill"
  | "excluded_tagged_transaction"
  | "excluded_inactive_pattern"
  | "excluded_missing_subscription_signal"
  | "deduped_same_account_record"
  | "currency_mismatch"
  | "amounts_not_stable"
  | "cadence_not_supported";

export type PatternWindow = {
  startDate: string;
  endDate: string;
  analysisDate: string;
  lookbackDays: number;
};

export type PatternEntity =
  | {
      type: "merchant";
      id: string;
      displayName: string;
      serviceGroup?: string;
      category?: string;
    }
  | {
      type: "account";
      id: string;
      displayName: string;
      institutionName?: string;
    }
  | {
      type: "service_group";
      id: string;
      displayName: string;
    }
  | {
      type: "category";
      id: string;
      displayName: string;
    };

export type PatternConfidenceFactor = {
  code: string;
  direction: "positive" | "negative";
  points?: number;
  message: string;
};

export type PatternConfidenceCap = {
  code: string;
  cap: number;
  previousScore: number;
  resultingScore: number;
  message: string;
};

export type PatternAssumption = {
  code: PatternAssumptionCode;
  message: string;
  relatedEntityIds: string[];
};

export type PatternUncertainty = {
  code: PatternUncertaintyCode;
  message: string;
  relatedEntityIds: string[];
};

export type PatternSavingsImpact = {
  monthlyLowCents: number;
  monthlyHighCents: number;
  annualHighCents?: number;
  reviewableMonthlyTotalCents?: number;
};

export type LikelySubscriptionEvidence = {
  kind: "likely_subscription";
  merchant: {
    normalizedMerchantId: string;
    displayName: string;
    merchantCanonical?: string;
    merchantAmbiguity: boolean;
    serviceGroup?: string;
    serviceGroupSource?: "merchant_taxonomy" | "category";
  };
  category: {
    id: string;
    displayName: string;
    requiredDefault: boolean;
  };
  accountIds: string[];
  institutionNames: string[];
  transactionIds: string[];
  occurrenceCount: number;
  firstChargeDate: string;
  lastChargeDate: string;
  cadence: DetectedRecurringCadence;
  intervalDays: {
    values: number[];
    median: number;
  };
  amountCents: {
    values: number[];
    median: number;
    min: number;
    max: number;
    tolerance: number;
  };
  expectedNextChargeDate: string;
  activeGraceEndDate: string;
  estimatedMonthlyCostCents: number;
  coverageDays: number;
  twoChargeException: boolean;
};

export type PossibleDuplicateServiceEvidence = {
  kind: "possible_duplicate_service";
  duplicateKind: "same_service_group" | "same_merchant_across_accounts";
  serviceGroup?: string;
  serviceGroupDisplayName?: string;
  merchantIds: string[];
  merchantNames: string[];
  accountIds: string[];
  institutionNames: string[];
  subscriptionInsightIds: string[];
  transactionIds: string[];
  cadenceWindowsOverlap: boolean;
  combinedEstimatedMonthlyCostCents: number;
  lowestEstimatedMonthlyCostCents: number;
};

export type PatternEvidence = LikelySubscriptionEvidence | PossibleDuplicateServiceEvidence;

export type PatternInsight = {
  insightId: string;
  insightType: PatternInsightType;
  patternRulesVersion: typeof PATTERN_RULES_VERSION;
  entities: PatternEntity[];
  window: PatternWindow;
  evidence: PatternEvidence;
  confidenceScore: number;
  confidenceBand: PatternConfidenceBand;
  confidenceFactors: PatternConfidenceFactor[];
  confidenceCapsApplied: PatternConfidenceCap[];
  savingsImpact: PatternSavingsImpact;
  assumptions: PatternAssumption[];
  uncertainties: PatternUncertainty[];
  explanation: string;
  debugTrace: string[];
};

export type PatternDiagnostic = {
  code: PatternDiagnosticCode;
  message: string;
  relatedEntityIds: string[];
  debugTrace: string[];
};

export type RecurringSpendingDetectionResult = {
  patternRulesVersion: typeof PATTERN_RULES_VERSION;
  analysisDate: string;
  window: PatternWindow;
  insights: PatternInsight[];
  diagnostics: PatternDiagnostic[];
};

export type RecurringSpendingDetectionInput = {
  transactions: readonly Transaction[];
  accounts?: readonly Account[];
  currency: string;
  analysisDate?: string;
  includeDiagnostics?: boolean;
  config?: Partial<RecurringSpendingConfig>;
};

type SubscriptionCandidate = PatternInsight & {
  evidence: LikelySubscriptionEvidence;
  entityKey: string;
  intervalStartDate: string;
  intervalEndDate: string;
  sharedHousehold: boolean;
};

type CandidateGroup = {
  key: string;
  merchantId: string;
  merchantName: string;
  merchantCanonical?: string;
  merchantAmbiguity: boolean;
  category: string;
  accountId: string;
  transactions: Transaction[];
  serviceGroup?: ServiceGroupMatch;
};

type CadenceMatch = {
  cadence: DetectedRecurringCadence;
  minimumCount: number;
  medianIntervalDays: number;
  intervalDays: number[];
  twoChargeException: boolean;
};

type ServiceGroupMatch = {
  id: string;
  displayName: string;
  source: "merchant_taxonomy" | "category";
};

const TRUSTED_TRANSFER_MATCH_CONFIDENCE = 0.8;
const PATTERN_EXCLUDED_TAGS = new Set<TransactionPatternTag>([
  "one_time",
  "planned_purchase",
  "required",
  "reimbursable",
  "ignore_for_patterns",
]);
const SUBSCRIPTION_SIGNAL_CATEGORIES = new Set(["streaming", "music_audio", "software", "cloud_storage", "fitness"]);
const ALWAYS_EXCLUDED_CATEGORIES = new Set([
  "income",
  "transfer",
  "savings_transfer",
  "credit_card_payment",
  "debt_payment",
  "fees",
  "cash",
]);
const FLOW_EXCLUSIONS = new Set<FlowType>(["INCOME", "TRANSFER_OUT", "TRANSFER_IN", "REFUND", "FEE", "UNCLASSIFIED"]);

const SERVICE_GROUPS: Record<string, { displayName: string; merchantIds: string[]; categoryFallbacks: string[] }> = {
  streaming_video: {
    displayName: "streaming video",
    merchantIds: ["netflix", "hulu", "max", "disney_plus", "peacock", "paramount_plus", "apple_tv_plus"],
    categoryFallbacks: ["streaming"],
  },
  music_audio: {
    displayName: "music and audio",
    merchantIds: ["spotify", "apple_music", "youtube_music", "audible"],
    categoryFallbacks: ["music_audio"],
  },
  cloud_storage: {
    displayName: "cloud storage",
    merchantIds: ["apple_icloud", "google_one", "dropbox", "onedrive"],
    categoryFallbacks: ["cloud_storage"],
  },
  software_productivity: {
    displayName: "software and productivity",
    merchantIds: ["microsoft_365", "google_workspace", "notion", "todoist", "adobe"],
    categoryFallbacks: ["software"],
  },
  fitness: {
    displayName: "fitness",
    merchantIds: ["planet_fitness", "la_fitness", "peloton", "apple_fitness"],
    categoryFallbacks: ["fitness"],
  },
  meal_delivery_membership: {
    displayName: "meal delivery membership",
    merchantIds: ["doordash_dashpass", "uber_one", "instacart_plus", "grubhub_plus"],
    categoryFallbacks: [],
  },
  news_media: {
    displayName: "news and media",
    merchantIds: ["new_york_times", "washington_post", "wall_street_journal", "the_athletic"],
    categoryFallbacks: [],
  },
};

export function detectRecurringSpending(
  input: RecurringSpendingDetectionInput,
): RecurringSpendingDetectionResult {
  const config = { ...DEFAULT_RECURRING_SPENDING_CONFIG, ...input.config };
  const accounts = input.accounts ?? [];
  const accountLookup = new Map(accounts.map((account) => [account.id, account]));
  const currency = input.currency.toUpperCase();
  const scopedTransactions = input.transactions.filter((transaction) => transaction.currency === currency);
  const analysisDate = input.analysisDate ?? latestPostedDate(scopedTransactions) ?? "1970-01-01";
  const window = {
    startDate: addDays(analysisDate, -(config.lookbackDays - 1)),
    endDate: analysisDate,
    analysisDate,
    lookbackDays: config.lookbackDays,
  };
  const diagnostics: PatternDiagnostic[] = [];
  const coverageDays = calculateCoverageDays(scopedTransactions, analysisDate);

  addCurrencyDiagnostics(accounts, currency, diagnostics);
  if (coverageDays < config.subscriptionMinimumCoverageDays) {
    diagnostics.push({
      code: "insufficient_history",
      message: `Only ${coverageDays} days of transaction history are available; monthly subscriptions need at least ${config.subscriptionMinimumCoverageDays} days.`,
      relatedEntityIds: [],
      debugTrace: [
        `coverage_days=${coverageDays}`,
        `subscription_minimum_coverage_days=${config.subscriptionMinimumCoverageDays}`,
      ],
    });
  }

  const inWindow = scopedTransactions
    .filter((transaction) => compareDates(transaction.postedDate, window.startDate) >= 0)
    .filter((transaction) => compareDates(transaction.postedDate, window.endDate) <= 0)
    .filter((transaction) => accountIsAnalyzable(transaction, accountLookup, currency));
  const { transactions: dedupedTransactions, diagnostics: dedupeDiagnostics } = dedupeSameAccountRecords(inWindow);
  diagnostics.push(...dedupeDiagnostics);

  const groups = buildCandidateGroups(dedupedTransactions, accountLookup, currency, input.includeDiagnostics === true, diagnostics);
  const preliminarySubscriptions = buildSubscriptionCandidates(groups, accountLookup, window, coverageDays, config, diagnostics);
  const subscriptions = addCrossAccountSubscriptionEvidence(preliminarySubscriptions);
  const duplicateInsights = buildDuplicateServiceInsights(subscriptions, accountLookup, window);
  const insights = [...duplicateInsights, ...subscriptions]
    .filter((insight) => input.includeDiagnostics === true || insight.confidenceScore >= 60)
    .sort(compareInsights);

  return {
    patternRulesVersion: PATTERN_RULES_VERSION,
    analysisDate,
    window,
    insights,
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

function buildCandidateGroups(
  transactions: Transaction[],
  accountLookup: Map<string, Account>,
  currency: string,
  includeDiagnostics: boolean,
  diagnostics: PatternDiagnostic[],
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();

  for (const transaction of transactions) {
    const exclusion = patternExclusion(transaction, accountLookup, currency);
    if (exclusion) {
      if (includeDiagnostics) diagnostics.push(exclusion);
      continue;
    }

    const merchantId = merchantIdFor(transaction);
    const category = transaction.category || "unknown";
    const key = `${merchantId}|${transaction.accountId}`;
    const group = groups.get(key) ?? {
      key,
      merchantId,
      merchantName: transaction.merchantName,
      merchantCanonical: transaction.merchantCanonical,
      merchantAmbiguity: transaction.merchantAmbiguity === true,
      category,
      accountId: transaction.accountId,
      transactions: [],
      serviceGroup: serviceGroupFor(merchantId, category),
    };
    group.transactions.push(transaction);
    if (transaction.merchantAmbiguity === true) group.merchantAmbiguity = true;
    if (!group.serviceGroup) group.serviceGroup = serviceGroupFor(merchantId, category);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    transactions: stableTransactions(group.transactions),
  }));
}

function buildSubscriptionCandidates(
  groups: CandidateGroup[],
  accountLookup: Map<string, Account>,
  window: PatternWindow,
  coverageDays: number,
  config: RecurringSpendingConfig,
  diagnostics: PatternDiagnostic[],
): SubscriptionCandidate[] {
  const candidates: SubscriptionCandidate[] = [];

  for (const group of groups.sort((left, right) => left.key.localeCompare(right.key))) {
    const hasSignal = hasSubscriptionSignal(group);
    if (!hasSignal) {
      diagnostics.push({
        code: "excluded_missing_subscription_signal",
        message: `${group.merchantName} repeated charges did not match a subscription service category or merchant taxonomy.`,
        relatedEntityIds: group.transactions.map((transaction) => transaction.id),
        debugTrace: [
          "rule=likely_subscription",
          `merchant_id=${group.merchantId}`,
          `category=${group.category}`,
          "subscription_signal=false",
        ],
      });
      continue;
    }

    const cadence = detectCadence(group.transactions, hasSignal);
    if (!cadence) {
      diagnostics.push({
        code: "cadence_not_supported",
        message: `${group.merchantName} did not match a supported recurring cadence.`,
        relatedEntityIds: group.transactions.map((transaction) => transaction.id),
        debugTrace: [
          "rule=likely_subscription",
          `merchant_id=${group.merchantId}`,
          `interval_days=${intervalsFor(group.transactions).join(",") || "none"}`,
        ],
      });
      continue;
    }

    if (coverageDays < config.subscriptionMinimumCoverageDays && cadence.cadence !== "weekly") {
      diagnostics.push({
        code: "insufficient_history",
        message: `${group.merchantName} has recurring-looking charges, but the available history is too short for subscription confidence.`,
        relatedEntityIds: group.transactions.map((transaction) => transaction.id),
        debugTrace: [
          "rule=likely_subscription",
          `merchant_id=${group.merchantId}`,
          `coverage_days=${coverageDays}`,
          `subscription_minimum_coverage_days=${config.subscriptionMinimumCoverageDays}`,
        ],
      });
      continue;
    }

    const amounts = group.transactions.map((transaction) => Math.abs(transaction.amountCents)).sort((left, right) => left - right);
    const medianAmount = median(amounts);
    const amountTolerance = Math.max(
      config.amountToleranceFloorCents,
      Math.round(medianAmount * config.amountToleranceRatio),
    );
    const amountsStable = amounts.every((amount) => Math.abs(amount - medianAmount) <= amountTolerance);
    if (!amountsStable) {
      diagnostics.push({
        code: "amounts_not_stable",
        message: `${group.merchantName} matched a cadence, but amounts varied too much for subscription detection.`,
        relatedEntityIds: group.transactions.map((transaction) => transaction.id),
        debugTrace: [
          "rule=likely_subscription",
          `merchant_id=${group.merchantId}`,
          `amount_values=${amounts.join(",")}`,
          `median_amount_cents=${formatNumber(medianAmount)}`,
          `tolerance_cents=${amountTolerance}`,
        ],
      });
      continue;
    }

    const insight = createSubscriptionInsight({
      group,
      accountLookup,
      window,
      coverageDays,
      config,
      cadence,
      amounts,
      medianAmount,
      amountTolerance,
      hasSignal,
    });
    if (insight) candidates.push(insight);
  }

  return candidates;
}

function createSubscriptionInsight(input: {
  group: CandidateGroup;
  accountLookup: Map<string, Account>;
  window: PatternWindow;
  coverageDays: number;
  config: RecurringSpendingConfig;
  cadence: CadenceMatch;
  amounts: number[];
  medianAmount: number;
  amountTolerance: number;
  hasSignal: boolean;
}): SubscriptionCandidate | undefined {
  const group = input.group;
  const transactions = group.transactions;
  const firstTransaction = transactions[0];
  const lastTransaction = transactions[transactions.length - 1];
  if (!firstTransaction || !lastTransaction) return undefined;

  const expectedNextChargeDate = expectedNextCharge(lastTransaction.postedDate, input.cadence.cadence);
  const activeGraceEndDate = addDays(expectedNextChargeDate, input.config.subscriptionRecentGraceDays);
  if (compareDates(input.window.analysisDate, activeGraceEndDate) > 0) {
    return undefined;
  }

  const estimatedMonthlyCostCents = estimateMonthlyCost(input.medianAmount, input.cadence.cadence);
  const account = input.accountLookup.get(group.accountId);
  const institutionNames = uniqueSorted([account?.institutionName ?? "Unassigned institution"]);
  const categoryMetadata = getCategoryMetadata(group.category);
  const entityKey = `merchant:${group.merchantId}:account:${group.accountId}:cadence:${input.cadence.cadence}`;
  const uncertaintyCodes = new Set<PatternUncertaintyCode>();
  const assumptions = baseAssumptions([group.merchantId, group.accountId]);
  const confidenceFactors: PatternConfidenceFactor[] = [];
  const confidenceCapsApplied: PatternConfidenceCap[] = [];
  let confidenceScore = 0;

  addFactor(confidenceFactors, "cadence_supported", 35, `${input.cadence.cadence} cadence matched supported interval thresholds.`);
  confidenceScore += 35;
  if (input.cadence.twoChargeException) {
    addFactor(confidenceFactors, "two_charge_subscription_exception", 5, "Two monthly charges use the explicit subscription-signal exception.");
    confidenceScore += 5;
  } else if (transactions.length > input.cadence.minimumCount) {
    addFactor(confidenceFactors, "occurrence_count_exceeds_minimum", 10, "Occurrence count exceeds the minimum evidence threshold.");
    confidenceScore += 10;
  } else {
    addFactor(confidenceFactors, "occurrence_count_meets_minimum", 5, "Occurrence count meets the minimum evidence threshold.");
    confidenceScore += 5;
  }
  addFactor(confidenceFactors, "amounts_within_tolerance", 20, "Amounts stay within the stable amount tolerance.");
  confidenceScore += 20;
  if (input.hasSignal) {
    addFactor(confidenceFactors, "subscription_signal_present", 15, "Merchant or normalized category has a subscription service signal.");
    confidenceScore += 15;
  }
  addFactor(confidenceFactors, "active_recent_charge", 10, "Last observed charge is inside the active grace window.");
  confidenceScore += 10;
  if (transactions.some((transaction) => transaction.tags?.includes("optional_service"))) {
    addFactor(confidenceFactors, "optional_service_tag", 5, "A transaction tag marks this as an optional service.");
    confidenceScore += 5;
  }

  if (compareDates(input.window.analysisDate, expectedNextChargeDate) > 0) {
    uncertaintyCodes.add("active_status_uncertain");
  }
  if (group.merchantId === "unknown_merchant" || hasNormalizationCode(transactions, "unknown_merchant")) {
    uncertaintyCodes.add("unknown_merchant");
  }
  if (group.category === "unknown" || hasNormalizationCode(transactions, "unknown_category")) {
    uncertaintyCodes.add("unknown_category");
  }
  if (group.merchantAmbiguity || hasNormalizationCode(transactions, "ambiguous_processor")) {
    uncertaintyCodes.add("ambiguous_processor");
  }
  if (input.coverageDays < input.config.subscriptionPreferredCoverageDays) {
    uncertaintyCodes.add("insufficient_history");
  }
  if (transactions.length < 3) {
    uncertaintyCodes.add("sparse_evidence");
  }
  if (accountDataStale(account, input.window.analysisDate)) {
    uncertaintyCodes.add("stale_account_data");
  }

  confidenceScore = applySubscriptionCaps({
    score: confidenceScore,
    caps: confidenceCapsApplied,
    cadence: input.cadence,
    coverageDays: input.coverageDays,
    config: input.config,
    uncertaintyCodes,
  });

  const insightId = stableInsightId("likely_subscription", entityKey, input.window);
  const evidence: LikelySubscriptionEvidence = {
    kind: "likely_subscription",
    merchant: {
      normalizedMerchantId: group.merchantId,
      displayName: group.merchantName,
      merchantCanonical: group.merchantCanonical,
      merchantAmbiguity: group.merchantAmbiguity,
      serviceGroup: group.serviceGroup?.id,
      serviceGroupSource: group.serviceGroup?.source,
    },
    category: {
      id: group.category,
      displayName: categoryMetadata.displayName,
      requiredDefault: categoryMetadata.requiredDefault,
    },
    accountIds: [group.accountId],
    institutionNames,
    transactionIds: transactions.map((transaction) => transaction.id),
    occurrenceCount: transactions.length,
    firstChargeDate: firstTransaction.postedDate,
    lastChargeDate: lastTransaction.postedDate,
    cadence: input.cadence.cadence,
    intervalDays: {
      values: input.cadence.intervalDays,
      median: input.cadence.medianIntervalDays,
    },
    amountCents: {
      values: input.amounts,
      median: input.medianAmount,
      min: input.amounts[0] ?? 0,
      max: input.amounts[input.amounts.length - 1] ?? 0,
      tolerance: input.amountTolerance,
    },
    expectedNextChargeDate,
    activeGraceEndDate,
    estimatedMonthlyCostCents,
    coverageDays: input.coverageDays,
    twoChargeException: input.cadence.twoChargeException,
  };

  return {
    insightId,
    insightType: "likely_subscription",
    patternRulesVersion: PATTERN_RULES_VERSION,
    entities: [
      {
        type: "merchant",
        id: group.merchantId,
        displayName: group.merchantName,
        serviceGroup: group.serviceGroup?.id,
        category: group.category,
      },
      {
        type: "account",
        id: group.accountId,
        displayName: account?.displayName ?? group.accountId,
        institutionName: account?.institutionName,
      },
      {
        type: "category",
        id: group.category,
        displayName: categoryMetadata.displayName,
      },
    ],
    window: input.window,
    evidence,
    confidenceScore,
    confidenceBand: confidenceBand(confidenceScore),
    confidenceFactors,
    confidenceCapsApplied,
    savingsImpact: {
      monthlyLowCents: 0,
      monthlyHighCents: estimatedMonthlyCostCents,
      annualHighCents: estimatedMonthlyCostCents * 12,
      reviewableMonthlyTotalCents: estimatedMonthlyCostCents,
    },
    assumptions,
    uncertainties: buildUncertainties(uncertaintyCodes, transactions.map((transaction) => transaction.id)),
    explanation: subscriptionExplanation(evidence, confidenceScore),
    debugTrace: [
      "rule=likely_subscription",
      `merchant_id=${group.merchantId}`,
      `account_id=${group.accountId}`,
      `occurrence_count=${transactions.length}`,
      `cadence=${input.cadence.cadence}`,
      `interval_days=${input.cadence.intervalDays.join(",")}`,
      `median_interval_days=${formatNumber(input.cadence.medianIntervalDays)}`,
      `amount_values_cents=${input.amounts.join(",")}`,
      `median_amount_cents=${formatNumber(input.medianAmount)}`,
      `amount_tolerance_cents=${input.amountTolerance}`,
      `expected_next_charge_date=${expectedNextChargeDate}`,
      `active_grace_end_date=${activeGraceEndDate}`,
      `confidence_score=${confidenceScore}`,
    ],
    entityKey,
    intervalStartDate: lastTransaction.postedDate,
    intervalEndDate: activeGraceEndDate,
    sharedHousehold: transactions.some((transaction) => transaction.tags?.includes("shared_household")),
  };
}

function addCrossAccountSubscriptionEvidence(candidates: SubscriptionCandidate[]): SubscriptionCandidate[] {
  const byMerchant = groupBy(candidates, (candidate) => candidate.evidence.merchant.normalizedMerchantId);

  return candidates.map((candidate) => {
    const merchantPeers =
      byMerchant
        .get(candidate.evidence.merchant.normalizedMerchantId)
        ?.filter((peer) => peer.evidence.cadence === candidate.evidence.cadence) ?? [];
    const distinctAccountIds = uniqueSorted(merchantPeers.flatMap((peer) => peer.evidence.accountIds));
    if (distinctAccountIds.length < 2) return candidate;

    const confidenceFactors = [...candidate.confidenceFactors];
    const confidenceCapsApplied = [...candidate.confidenceCapsApplied];
    let confidenceScore = candidate.confidenceScore;
    addFactor(confidenceFactors, "same_merchant_seen_across_accounts", 5, "Same merchant and cadence appears across multiple accounts.");
    confidenceScore += 5;
    confidenceScore = replayCaps(confidenceScore, candidate.confidenceCapsApplied, confidenceCapsApplied);

    const accountIds = distinctAccountIds;
    const institutionNames = uniqueSorted(merchantPeers.flatMap((peer) => peer.evidence.institutionNames));
    const transactionIds = uniqueSorted(merchantPeers.flatMap((peer) => peer.evidence.transactionIds));
    const evidence: LikelySubscriptionEvidence = {
      ...candidate.evidence,
      accountIds,
      institutionNames,
      transactionIds,
    };

    return {
      ...candidate,
      evidence,
      confidenceScore,
      confidenceBand: confidenceBand(confidenceScore),
      confidenceFactors,
      confidenceCapsApplied,
      entities: mergeEntities(candidate.entities, accountIds, merchantPeers),
      assumptions: mergeAssumptions(candidate.assumptions, [
        {
          code: "same_account_record_deduplication",
          message: "Same-account duplicate records were removed before pattern detection; cross-account charges remain evidence.",
          relatedEntityIds: transactionIds,
        },
      ]),
      explanation: subscriptionExplanation(evidence, confidenceScore),
      debugTrace: [
        ...candidate.debugTrace,
        `cross_account_same_merchant_account_ids=${accountIds.join(",")}`,
        `confidence_score=${confidenceScore}`,
      ],
    };
  });
}

function buildDuplicateServiceInsights(
  subscriptions: SubscriptionCandidate[],
  accountLookup: Map<string, Account>,
  window: PatternWindow,
): PatternInsight[] {
  const activeSubscriptions = subscriptions.filter((subscription) => subscription.confidenceScore >= 60);
  const exactMerchantInsights = [...groupBy(activeSubscriptions, (subscription) => subscription.evidence.merchant.normalizedMerchantId).values()]
    .filter((group) => uniqueSorted(group.flatMap((subscription) => subscription.evidence.accountIds)).length >= 2)
    .map((group) => createDuplicateInsight(group, accountLookup, window, "same_merchant_across_accounts"))
    .filter((insight): insight is PatternInsight => Boolean(insight));
  const serviceGroupInsights = [...groupBy(activeSubscriptions.filter((subscription) => subscription.evidence.merchant.serviceGroup), (subscription) => subscription.evidence.merchant.serviceGroup ?? "").values()]
    .filter((group) => uniqueSorted(group.map((subscription) => subscription.evidence.merchant.normalizedMerchantId)).length >= 2)
    .map((group) => createDuplicateInsight(group, accountLookup, window, "same_service_group"))
    .filter((insight): insight is PatternInsight => Boolean(insight));

  return [...exactMerchantInsights, ...serviceGroupInsights];
}

function createDuplicateInsight(
  subscriptions: SubscriptionCandidate[],
  accountLookup: Map<string, Account>,
  window: PatternWindow,
  duplicateKind: PossibleDuplicateServiceEvidence["duplicateKind"],
): PatternInsight | undefined {
  if (subscriptions.length < 2) return undefined;

  const sortedSubscriptions = [...subscriptions].sort((left, right) => left.entityKey.localeCompare(right.entityKey));
  const accountIds = uniqueSorted(sortedSubscriptions.flatMap((subscription) => subscription.evidence.accountIds));
  const merchantIds = uniqueSorted(sortedSubscriptions.map((subscription) => subscription.evidence.merchant.normalizedMerchantId));
  const merchantNames = uniqueSorted(sortedSubscriptions.map((subscription) => subscription.evidence.merchant.displayName));
  const institutionNames = uniqueSorted(
    accountIds.map((accountId) => accountLookup.get(accountId)?.institutionName ?? "Unassigned institution"),
  );
  const transactionIds = uniqueSorted(sortedSubscriptions.flatMap((subscription) => subscription.evidence.transactionIds));
  const serviceGroup = duplicateKind === "same_service_group" ? sortedSubscriptions[0]?.evidence.merchant.serviceGroup : undefined;
  const serviceGroupDisplayName = serviceGroup ? serviceGroupDisplayNameFor(serviceGroup) : undefined;
  const cadenceWindowsOverlap = hasOverlappingActiveWindows(sortedSubscriptions);
  if (!cadenceWindowsOverlap) return undefined;

  const monthlyCosts = sortedSubscriptions.map((subscription) => subscription.evidence.estimatedMonthlyCostCents);
  const combinedEstimatedMonthlyCostCents = monthlyCosts.reduce((sum, amount) => sum + amount, 0);
  const lowestEstimatedMonthlyCostCents = Math.min(...monthlyCosts);
  const entityKey =
    duplicateKind === "same_merchant_across_accounts"
      ? `merchant:${merchantIds.join("+")}`
      : `service_group:${serviceGroup}`;
  const insightId = stableInsightId("possible_duplicate_service", entityKey, window);
  const confidenceFactors: PatternConfidenceFactor[] = [];
  const confidenceCapsApplied: PatternConfidenceCap[] = [];
  let confidenceScore = 0;

  addFactor(confidenceFactors, "active_subscription_count", 25, "At least two active likely subscriptions are present.");
  confidenceScore += 25;
  if (duplicateKind === "same_merchant_across_accounts") {
    addFactor(confidenceFactors, "same_exact_merchant_across_accounts", 25, "The same merchant appears as a recurring service on multiple accounts.");
    confidenceScore += 25;
  } else {
    addFactor(confidenceFactors, "same_service_group_distinct_merchants", 20, "Distinct merchants map to the same deterministic service group.");
    confidenceScore += 20;
  }
  addFactor(confidenceFactors, "cadence_windows_overlap", 15, "Active cadence windows overlap.");
  confidenceScore += 15;
  if (combinedEstimatedMonthlyCostCents >= 2_500) {
    addFactor(confidenceFactors, "combined_monthly_cost_threshold", 10, "Combined estimated monthly cost is at least $25.");
    confidenceScore += 10;
  }
  addFactor(confidenceFactors, "same_individual_mvp0_fixture", 5, "MVP 0 analyzes accounts as one individual unless a fixture says otherwise.");
  confidenceScore += 5;

  const uncertaintyCodes = new Set<PatternUncertaintyCode>();
  const allAmbiguous = sortedSubscriptions.every((subscription) => subscription.evidence.merchant.merchantAmbiguity);
  const sharedHousehold = sortedSubscriptions.some((subscription) => subscription.sharedHousehold);
  const categoryDerived = duplicateKind === "same_service_group" && sortedSubscriptions.every((subscription) => subscription.evidence.merchant.serviceGroupSource === "category");
  const minimumSubscriptionConfidence = Math.min(...sortedSubscriptions.map((subscription) => subscription.confidenceScore));
  if (allAmbiguous) uncertaintyCodes.add("ambiguous_processor");
  if (categoryDerived) uncertaintyCodes.add("unknown_category");
  if (minimumSubscriptionConfidence < 80) uncertaintyCodes.add("sparse_evidence");

  if (duplicateKind === "same_merchant_across_accounts" && confidenceScore > 95) {
    confidenceScore = capConfidence(confidenceScore, 95, "exact_merchant_max", "Exact same-merchant duplicates max at 95 before global caps.", confidenceCapsApplied);
  }
  if (duplicateKind === "same_service_group" && confidenceScore > 85) {
    confidenceScore = capConfidence(confidenceScore, 85, "service_group_max", "Same service-group duplicate insights max at 85 before global caps.", confidenceCapsApplied);
  }
  if (allAmbiguous) {
    confidenceScore = capConfidence(confidenceScore, 65, "ambiguous_processors", "Both services are from ambiguous processors.", confidenceCapsApplied);
  }
  if (sharedHousehold) {
    confidenceScore = capConfidence(confidenceScore, 70, "shared_household", "Shared-household tags make multiple services more likely intentional.", confidenceCapsApplied);
  }
  if (categoryDerived) {
    confidenceScore = capConfidence(confidenceScore, 75, "category_derived_service_group", "Service group came only from normalized categories.", confidenceCapsApplied);
  }
  if (minimumSubscriptionConfidence < 80) {
    confidenceScore = capConfidence(
      confidenceScore,
      minimumSubscriptionConfidence + 10,
      "subscription_confidence_dependency",
      "Duplicate-service confidence depends on the weakest linked subscription.",
      confidenceCapsApplied,
    );
  }

  const evidence: PossibleDuplicateServiceEvidence = {
    kind: "possible_duplicate_service",
    duplicateKind,
    serviceGroup,
    serviceGroupDisplayName,
    merchantIds,
    merchantNames,
    accountIds,
    institutionNames,
    subscriptionInsightIds: sortedSubscriptions.map((subscription) => subscription.insightId),
    transactionIds,
    cadenceWindowsOverlap,
    combinedEstimatedMonthlyCostCents,
    lowestEstimatedMonthlyCostCents,
  };

  return {
    insightId,
    insightType: "possible_duplicate_service",
    patternRulesVersion: PATTERN_RULES_VERSION,
    entities: [
      ...(serviceGroup
        ? [
            {
              type: "service_group" as const,
              id: serviceGroup,
              displayName: serviceGroupDisplayName ?? serviceGroup,
            },
          ]
        : []),
      ...merchantIds.map((merchantId) => ({
        type: "merchant" as const,
        id: merchantId,
        displayName:
          sortedSubscriptions.find((subscription) => subscription.evidence.merchant.normalizedMerchantId === merchantId)?.evidence
            .merchant.displayName ?? merchantId,
        serviceGroup,
      })),
      ...accountIds.map((accountId) => ({
        type: "account" as const,
        id: accountId,
        displayName: accountLookup.get(accountId)?.displayName ?? accountId,
        institutionName: accountLookup.get(accountId)?.institutionName,
      })),
    ],
    window,
    evidence,
    confidenceScore,
    confidenceBand: confidenceBand(confidenceScore),
    confidenceFactors,
    confidenceCapsApplied,
    savingsImpact: {
      monthlyLowCents: 0,
      monthlyHighCents: lowestEstimatedMonthlyCostCents,
      reviewableMonthlyTotalCents: combinedEstimatedMonthlyCostCents,
    },
    assumptions: [
      {
        code: "service_group_taxonomy",
        message: "Duplicate-ish service grouping uses a deterministic MVP 0 service-group taxonomy.",
        relatedEntityIds: merchantIds,
      },
      {
        code: "same_individual_accounts",
        message: "MVP 0 treats included accounts as one individual's accounts unless a fixture says otherwise.",
        relatedEntityIds: accountIds,
      },
      {
        code: "transfer_and_refund_exclusion",
        message: "Transfers, card payments, refunds, required bills, and ignored transactions were excluded before duplicate-service grouping.",
        relatedEntityIds: transactionIds,
      },
    ],
    uncertainties: buildUncertainties(uncertaintyCodes, transactionIds),
    explanation: duplicateServiceExplanation(evidence, confidenceScore),
    debugTrace: [
      "rule=possible_duplicate_service",
      `duplicate_kind=${duplicateKind}`,
      `service_group=${serviceGroup ?? "none"}`,
      `merchant_ids=${merchantIds.join(",")}`,
      `account_ids=${accountIds.join(",")}`,
      `cadence_windows_overlap=${cadenceWindowsOverlap}`,
      `combined_estimated_monthly_cost_cents=${combinedEstimatedMonthlyCostCents}`,
      `lowest_estimated_monthly_cost_cents=${lowestEstimatedMonthlyCostCents}`,
      `confidence_score=${confidenceScore}`,
    ],
  };
}

function patternExclusion(
  transaction: Transaction,
  accountLookup: Map<string, Account>,
  currency: string,
): PatternDiagnostic | undefined {
  const account = accountLookup.get(transaction.accountId);
  if (account && account.currency !== currency) {
    return {
      code: "currency_mismatch",
      message: `Transaction ${transaction.id} is on an account with ${account.currency}, not ${currency}.`,
      relatedEntityIds: [transaction.id, transaction.accountId],
      debugTrace: [`transaction_currency=${transaction.currency}`, `account_currency=${account.currency}`, `analysis_currency=${currency}`],
    };
  }

  const excludedTag = transaction.tags?.find((tag) => PATTERN_EXCLUDED_TAGS.has(tag));
  if (excludedTag) {
    return {
      code: "excluded_tagged_transaction",
      message: `Transaction ${transaction.id} is tagged ${excludedTag} and is excluded from subscription patterns.`,
      relatedEntityIds: [transaction.id],
      debugTrace: ["rule=likely_subscription", `excluded_by_tag=${excludedTag}`],
    };
  }

  const flowType = resolveFlowType(transaction, accountLookup);
  if (transaction.amountCents >= 0 || FLOW_EXCLUSIONS.has(flowType)) {
    return {
      code: "excluded_non_spend_flow",
      message: `Transaction ${transaction.id} is ${flowType} and is not a subscription outflow candidate.`,
      relatedEntityIds: [transaction.id],
      debugTrace: ["rule=likely_subscription", `flow_type=${flowType}`, `amount_cents=${transaction.amountCents}`],
    };
  }

  if (isRequiredBillCategory(transaction) || ALWAYS_EXCLUDED_CATEGORIES.has(transaction.category)) {
    return {
      code: "excluded_required_bill",
      message: `Transaction ${transaction.id} is in ${transaction.category}, which is excluded from subscription-service detection.`,
      relatedEntityIds: [transaction.id],
      debugTrace: ["rule=likely_subscription", `category=${transaction.category}`, "required_or_transfer_like=true"],
    };
  }

  return undefined;
}

function detectCadence(transactions: Transaction[], hasSubscriptionSignal: boolean): CadenceMatch | undefined {
  if (transactions.length < 2) return undefined;

  const intervalDays = intervalsFor(transactions);
  const medianIntervalDays = median(intervalDays);
  const cadenceDefinitions: { cadence: DetectedRecurringCadence; minimumCount: number; minDays: number; maxDays: number }[] = [
    { cadence: "weekly", minimumCount: 4, minDays: 6, maxDays: 8 },
    { cadence: "biweekly", minimumCount: 4, minDays: 13, maxDays: 16 },
    { cadence: "monthly", minimumCount: 3, minDays: 25, maxDays: 35 },
    { cadence: "quarterly", minimumCount: 3, minDays: 80, maxDays: 100 },
    { cadence: "annual", minimumCount: 2, minDays: 330, maxDays: 400 },
  ];

  for (const definition of cadenceDefinitions) {
    if (medianIntervalDays < definition.minDays || medianIntervalDays > definition.maxDays) continue;
    if (transactions.length >= definition.minimumCount) {
      return {
        cadence: definition.cadence,
        minimumCount: definition.minimumCount,
        medianIntervalDays,
        intervalDays,
        twoChargeException: false,
      };
    }
    if (
      definition.cadence === "monthly" &&
      transactions.length === 2 &&
      hasSubscriptionSignal &&
      medianIntervalDays >= definition.minDays &&
      medianIntervalDays <= definition.maxDays
    ) {
      return {
        cadence: "monthly",
        minimumCount: definition.minimumCount,
        medianIntervalDays,
        intervalDays,
        twoChargeException: true,
      };
    }
  }

  return undefined;
}

function applySubscriptionCaps(input: {
  score: number;
  caps: PatternConfidenceCap[];
  cadence: CadenceMatch;
  coverageDays: number;
  config: RecurringSpendingConfig;
  uncertaintyCodes: Set<PatternUncertaintyCode>;
}): number {
  let score = input.score;
  if (input.uncertaintyCodes.has("unknown_merchant")) {
    score = capConfidence(score, 55, "unknown_merchant", "Unknown merchants cannot produce high-confidence subscription insights.", input.caps);
  }
  if (input.uncertaintyCodes.has("unknown_category")) {
    score = capConfidence(score, 60, "unknown_category", "Unknown categories cap category-dependent subscription confidence.", input.caps);
  }
  if (input.uncertaintyCodes.has("ambiguous_processor")) {
    score = capConfidence(score, 70, "ambiguous_processor", "Ambiguous processor or app-store billing caps confidence.", input.caps);
  }
  if (input.uncertaintyCodes.has("stale_account_data")) {
    score = capConfidence(score, 75, "stale_account_data", "One or more accounts have freshness dates older than 14 days.", input.caps);
  }
  if (input.cadence.twoChargeException) {
    score = capConfidence(score, 65, "two_charge_monthly_exception", "Two-charge monthly detections are capped at 65.", input.caps);
  }
  if (input.uncertaintyCodes.has("sparse_evidence")) {
    score = capConfidence(score, 80, "fewer_than_three_transactions", "Patterns with fewer than three transactions are capped at 80.", input.caps);
  }
  if (input.coverageDays < input.config.subscriptionPreferredCoverageDays && input.coverageDays >= input.config.subscriptionMinimumCoverageDays) {
    score = capConfidence(score, 65, "below_preferred_history", "History is above the subscription minimum but below preferred coverage.", input.caps);
  }
  return score;
}

function dedupeSameAccountRecords(transactions: Transaction[]): {
  transactions: Transaction[];
  diagnostics: PatternDiagnostic[];
} {
  const kept: Transaction[] = [];
  const diagnostics: PatternDiagnostic[] = [];

  for (const transaction of stableTransactions(transactions)) {
    const duplicateOf = kept.find((candidate) => isSameAccountDuplicate(candidate, transaction));
    if (duplicateOf) {
      diagnostics.push({
        code: "deduped_same_account_record",
        message: `Transaction ${transaction.id} was treated as a same-account duplicate of ${duplicateOf.id} for pattern detection.`,
        relatedEntityIds: [duplicateOf.id, transaction.id],
        debugTrace: [
          "record_deduplication=true",
          `account_id=${transaction.accountId}`,
          `merchant_id=${merchantIdFor(transaction)}`,
          `date_delta_days=${Math.abs(daysBetween(duplicateOf.postedDate, transaction.postedDate))}`,
          `amount_delta_cents=${Math.abs(Math.abs(duplicateOf.amountCents) - Math.abs(transaction.amountCents))}`,
        ],
      });
      continue;
    }
    kept.push(transaction);
  }

  return { transactions: kept, diagnostics };
}

function isSameAccountDuplicate(left: Transaction, right: Transaction): boolean {
  return (
    left.accountId === right.accountId &&
    merchantIdFor(left) === merchantIdFor(right) &&
    Math.abs(Math.abs(left.amountCents) - Math.abs(right.amountCents)) <= 1 &&
    Math.abs(daysBetween(left.postedDate, right.postedDate)) <= 1
  );
}

function resolveFlowType(transaction: Transaction, accountLookup: Map<string, Account>): FlowType {
  if (transaction.flowType !== "TRANSFER_OUT" && transaction.flowType !== "TRANSFER_IN") return transaction.flowType;
  if (!transaction.counterAccountId) return "UNCLASSIFIED";
  if (!accountLookup.has(transaction.counterAccountId)) return "UNCLASSIFIED";
  if ((transaction.transferMatchConfidence ?? 0) < TRUSTED_TRANSFER_MATCH_CONFIDENCE) return "UNCLASSIFIED";
  return transaction.flowType;
}

function isRequiredBillCategory(transaction: Transaction): boolean {
  return transaction.tags?.includes("required") === true || transaction.categoryRequiredDefault === true || categoryRequiredByDefault(transaction.category);
}

function hasSubscriptionSignal(group: CandidateGroup): boolean {
  return (
    Boolean(group.serviceGroup) ||
    SUBSCRIPTION_SIGNAL_CATEGORIES.has(group.category) ||
    group.transactions.some((transaction) => transaction.recurrenceSignal?.isLikelyRecurring === true)
  );
}

function serviceGroupFor(merchantId: string, category: string): ServiceGroupMatch | undefined {
  for (const [id, group] of Object.entries(SERVICE_GROUPS)) {
    if (group.merchantIds.includes(merchantId)) {
      return { id, displayName: group.displayName, source: "merchant_taxonomy" };
    }
  }

  for (const [id, group] of Object.entries(SERVICE_GROUPS)) {
    if (group.categoryFallbacks.includes(category)) {
      return { id, displayName: group.displayName, source: "category" };
    }
  }

  return undefined;
}

function serviceGroupDisplayNameFor(serviceGroup: string): string | undefined {
  return SERVICE_GROUPS[serviceGroup]?.displayName;
}

function merchantIdFor(transaction: Transaction): string {
  return transaction.normalizedMerchantId ?? merchantKeyFromText(transaction.merchantName);
}

function expectedNextCharge(lastChargeDate: string, cadence: DetectedRecurringCadence): string {
  switch (cadence) {
    case "weekly":
      return addDays(lastChargeDate, 7);
    case "biweekly":
      return addDays(lastChargeDate, 14);
    case "monthly":
      return addMonths(lastChargeDate, 1);
    case "quarterly":
      return addMonths(lastChargeDate, 3);
    case "annual":
      return addMonths(lastChargeDate, 12);
  }
}

function estimateMonthlyCost(medianAmountCents: number, cadence: DetectedRecurringCadence): number {
  switch (cadence) {
    case "weekly":
      return Math.round((medianAmountCents * 52) / 12);
    case "biweekly":
      return Math.round((medianAmountCents * 26) / 12);
    case "monthly":
      return Math.round(medianAmountCents);
    case "quarterly":
      return Math.round(medianAmountCents / 3);
    case "annual":
      return Math.round(medianAmountCents / 12);
  }
}

function intervalsFor(transactions: Transaction[]): number[] {
  const sorted = stableTransactions(transactions);
  const intervals: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    intervals.push(daysBetween(previous.postedDate, current.postedDate));
  }
  return intervals;
}

function calculateCoverageDays(transactions: Transaction[], analysisDate: string): number {
  const dates = transactions.map((transaction) => transaction.postedDate).sort();
  const earliest = dates[0];
  if (!earliest) return 0;
  return Math.max(0, daysBetween(earliest, analysisDate) + 1);
}

function latestPostedDate(transactions: Transaction[]): string | undefined {
  return transactions.map((transaction) => transaction.postedDate).sort().at(-1);
}

function accountIsAnalyzable(
  transaction: Transaction,
  accountLookup: Map<string, Account>,
  currency: string,
): boolean {
  const account = accountLookup.get(transaction.accountId);
  if (!account) return true;
  if (account.currency !== currency) return false;
  return account.role !== "excluded";
}

function addCurrencyDiagnostics(
  accounts: readonly Account[],
  currency: string,
  diagnostics: PatternDiagnostic[],
): void {
  for (const account of accounts) {
    if (account.role === "excluded" || account.currency === currency) continue;
    diagnostics.push({
      code: "currency_mismatch",
      message: `Account ${account.id} uses ${account.currency}; ${currency} recurring-spending analysis excludes it.`,
      relatedEntityIds: [account.id],
      debugTrace: [`analysis_currency=${currency}`, `account_currency=${account.currency}`],
    });
  }
}

function accountDataStale(account: Account | undefined, analysisDate: string): boolean {
  if (!account?.freshness.asOf) return false;
  const freshnessDate = account.freshness.asOf.slice(0, 10);
  return daysBetween(freshnessDate, analysisDate) > 14;
}

function hasNormalizationCode(
  transactions: Transaction[],
  code: "unknown_merchant" | "ambiguous_processor" | "unknown_category",
): boolean {
  return transactions.some((transaction) => transaction.normalizationUncertaintyCodes?.includes(code));
}

function hasOverlappingActiveWindows(subscriptions: SubscriptionCandidate[]): boolean {
  for (let leftIndex = 0; leftIndex < subscriptions.length; leftIndex += 1) {
    const left = subscriptions[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < subscriptions.length; rightIndex += 1) {
      const right = subscriptions[rightIndex];
      if (!right) continue;
      if (
        compareDates(left.intervalStartDate, right.intervalEndDate) <= 0 &&
        compareDates(right.intervalStartDate, left.intervalEndDate) <= 0
      ) {
        return true;
      }
    }
  }
  return false;
}

function baseAssumptions(relatedEntityIds: string[]): PatternAssumption[] {
  const assumptions: PatternAssumption[] = [
    {
      code: "same_individual_accounts",
      message: "MVP 0 treats included accounts as one individual's accounts unless a fixture says otherwise.",
      relatedEntityIds,
    },
    {
      code: "normalized_merchant_grouping",
      message: "Recurring charges are grouped by backend-owned normalized merchant ids.",
      relatedEntityIds,
    },
    {
      code: "normalized_category_required_defaults",
      message: "Required-default categories are excluded from subscription-service detection.",
      relatedEntityIds,
    },
    {
      code: "transfer_and_refund_exclusion",
      message: "Only external SPEND outflows are eligible; income, transfers, card payments, refunds, fees, and unclassified movement are excluded.",
      relatedEntityIds,
    },
  ];
  return assumptions.sort((left, right) => left.code.localeCompare(right.code));
}

function buildUncertainties(codes: Set<PatternUncertaintyCode>, relatedEntityIds: string[]): PatternUncertainty[] {
  return [...codes].sort().map((code) => ({
    code,
    relatedEntityIds,
    message: uncertaintyMessage(code),
  }));
}

function uncertaintyMessage(code: PatternUncertaintyCode): string {
  switch (code) {
    case "insufficient_history":
      return "Available transaction history is shorter than preferred for this rule.";
    case "stale_account_data":
      return "One or more account freshness dates are older than the freshness threshold.";
    case "unknown_merchant":
      return "Merchant normalization did not identify a specific merchant.";
    case "ambiguous_processor":
      return "The statement names a processor or app store without proving the underlying service.";
    case "unknown_category":
      return "Category normalization is unknown or category-derived.";
    case "currency_mismatch":
      return "Some accounts or transactions were excluded because their currency differs from the analysis currency.";
    case "active_status_uncertain":
      return "The next expected charge date has passed but remains inside the active grace window.";
    case "sparse_evidence":
      return "The pattern depends on sparse recurring evidence.";
  }
}

function mergeEntities(
  entities: PatternEntity[],
  accountIds: string[],
  peers: SubscriptionCandidate[],
): PatternEntity[] {
  const nonAccounts = entities.filter((entity) => entity.type !== "account");
  const accounts = accountIds.map((accountId) => {
    const peerAccount = peers.flatMap((peer) => peer.entities).find((entity) => entity.type === "account" && entity.id === accountId);
    return (
      peerAccount ?? {
        type: "account" as const,
        id: accountId,
        displayName: accountId,
      }
    );
  });
  return [...nonAccounts, ...accounts].sort(compareEntities);
}

function mergeAssumptions(existing: PatternAssumption[], additions: PatternAssumption[]): PatternAssumption[] {
  const map = new Map<string, PatternAssumption>();
  for (const assumption of [...existing, ...additions]) {
    const current = map.get(assumption.code);
    if (!current) {
      map.set(assumption.code, assumption);
      continue;
    }
    map.set(assumption.code, {
      ...current,
      relatedEntityIds: uniqueSorted([...current.relatedEntityIds, ...assumption.relatedEntityIds]),
    });
  }
  return [...map.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function replayCaps(
  score: number,
  originalCaps: PatternConfidenceCap[],
  outputCaps: PatternConfidenceCap[],
): number {
  let cappedScore = score;
  for (const cap of originalCaps) {
    cappedScore = capConfidence(cappedScore, cap.cap, cap.code, cap.message, outputCaps);
  }
  return cappedScore;
}

function addFactor(
  factors: PatternConfidenceFactor[],
  code: string,
  points: number,
  message: string,
): void {
  factors.push({
    code,
    direction: "positive",
    points,
    message,
  });
}

function capConfidence(
  score: number,
  cap: number,
  code: string,
  message: string,
  caps: PatternConfidenceCap[],
): number {
  if (score <= cap) return score;
  caps.push({
    code,
    cap,
    previousScore: score,
    resultingScore: cap,
    message,
  });
  return cap;
}

function confidenceBand(score: number): PatternConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  if (score >= 40) return "low";
  return "suppressed";
}

function subscriptionExplanation(evidence: LikelySubscriptionEvidence, confidenceScore: number): string {
  const confidenceClause =
    confidenceScore < 80 ? " based on the transactions available" : "";
  const ambiguityClause = evidence.merchant.merchantAmbiguity
    ? " This may be one app store service or multiple app store charges."
    : "";
  return `Looks like a recurring service from ${evidence.merchant.displayName} at about ${formatMoney(
    evidence.estimatedMonthlyCostCents,
  )} per month${confidenceClause}, using ${evidence.occurrenceCount} ${evidence.cadence} charges from ${evidence.firstChargeDate} to ${evidence.lastChargeDate}.${ambiguityClause}`;
}

function duplicateServiceExplanation(evidence: PossibleDuplicateServiceEvidence, confidenceScore: number): string {
  const confidenceClause = confidenceScore < 80 ? " based on the transactions available" : "";
  if (evidence.duplicateKind === "same_merchant_across_accounts") {
    return `${evidence.merchantNames.join(", ")} appears as active recurring billing on multiple accounts${confidenceClause}. This may be intentional; the reviewable monthly amount is about ${formatMoney(
      evidence.lowestEstimatedMonthlyCostCents,
    )}.`;
  }
  return `You have multiple active ${evidence.serviceGroupDisplayName ?? "similar"} services: ${evidence.merchantNames.join(
    ", ",
  )}${confidenceClause}. They may be intentionally different; the lowest monthly cost in this group is about ${formatMoney(
    evidence.lowestEstimatedMonthlyCostCents,
  )}.`;
}

function stableInsightId(type: PatternInsightType, entityKey: string, window: PatternWindow): string {
  return `pattern:${PATTERN_RULES_VERSION}:${type}:${entityKey}:${window.startDate}:${window.endDate}`;
}

function compareInsights(left: PatternInsight, right: PatternInsight): number {
  return (
    bandPriority(left.confidenceBand) - bandPriority(right.confidenceBand) ||
    typePriority(left.insightType) - typePriority(right.insightType) ||
    right.savingsImpact.monthlyHighCents - left.savingsImpact.monthlyHighCents ||
    right.confidenceScore - left.confidenceScore ||
    entityKeyForInsight(left).localeCompare(entityKeyForInsight(right))
  );
}

function compareDiagnostics(left: PatternDiagnostic, right: PatternDiagnostic): number {
  return (
    left.code.localeCompare(right.code) ||
    left.relatedEntityIds.join("|").localeCompare(right.relatedEntityIds.join("|")) ||
    left.message.localeCompare(right.message)
  );
}

function compareEntities(left: PatternEntity, right: PatternEntity): number {
  return left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
}

function bandPriority(band: PatternConfidenceBand): number {
  switch (band) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    case "suppressed":
      return 3;
  }
}

function typePriority(type: PatternInsightType): number {
  switch (type) {
    case "possible_duplicate_service":
      return 2;
    case "likely_subscription":
      return 3;
  }
}

function entityKeyForInsight(insight: PatternInsight): string {
  if (insight.evidence.kind === "likely_subscription") {
    return `${insight.evidence.merchant.normalizedMerchantId}:${insight.evidence.accountIds.join("+")}:${insight.evidence.cadence}`;
  }
  return `${insight.evidence.duplicateKind}:${insight.evidence.serviceGroup ?? insight.evidence.merchantIds.join("+")}`;
}

function stableTransactions(transactions: readonly Transaction[]): Transaction[] {
  return [...transactions].sort(
    (left, right) =>
      left.postedDate.localeCompare(right.postedDate) ||
      left.accountId.localeCompare(right.accountId) ||
      merchantIdFor(left).localeCompare(merchantIdFor(right)) ||
      Math.abs(left.amountCents) - Math.abs(right.amountCents) ||
      left.id.localeCompare(right.id),
  );
}

function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}
