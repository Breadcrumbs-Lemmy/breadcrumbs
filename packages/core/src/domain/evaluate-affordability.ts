import { addDays, compareDates, dateRange, daysBetween, extractIsoDate, hoursBetweenIsoLike, isIsoDate } from "./dates";
import { expandCadence } from "./recurrence";
import { AffordabilityRequestSchema } from "./schemas";
import { summarizeMonthlySpending } from "./monthly-spending";
import { AffordabilityRequestValidationError } from "./types";
import type {
  Account,
  AffordabilityLevel,
  AffordabilityRequest,
  AffordabilityResponse,
  Assumption,
  DecisionExplanation,
  DecisionReason,
  FinancialSnapshot,
  ForecastConfig,
  ForecastEvent,
  ForecastPathMetrics,
  FreshnessWarning,
  PlannedPurchase,
  ProductBoundary,
  ReasonCode,
  ReasonParameterMap,
} from "./types";

const ENGINE_VERSION = "mvp0-2026-08-04";

const PRODUCT_BOUNDARIES: ProductBoundary[] = [
  "READ_ONLY_DECISION_SUPPORT",
  "NOT_PERSONALIZED_FINANCIAL_ADVICE",
  "NO_ACCOUNT_WRITES",
  "DETERMINISTIC_CALCULATION",
];

type ForecastPath = "required" | "protected" | "all" | "expected_reference";

type InternalForecastEvent = ForecastEvent & {
  order: number;
  highPriorityProtectedGoal: boolean;
};

type ValidationResult = {
  blockingReasons: DecisionReason[];
  assumptions: Assumption[];
  freshnessWarnings: FreshnessWarning[];
};

type ForecastBundle = {
  events: InternalForecastEvent[];
  dailyBalances: AffordabilityResponse["forecast"]["dailyBalances"];
  requiredPath: ForecastPathMetrics;
  protectedPath: ForecastPathMetrics;
  allEventsPath: ForecastPathMetrics;
  expectedReferencePath?: ForecastPathMetrics;
};

type TimingReserve = {
  timingReserveCents: number;
  timingReserveWindowEndDate: string;
  nextReliableIncomeDate?: string;
};

export function evaluateAffordability(rawRequest: unknown): AffordabilityResponse {
  const parsed = AffordabilityRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new AffordabilityRequestValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const request = parsed.data as AffordabilityRequest;
  const snapshot = request.snapshot;
  const horizonStartDate = snapshot.asOfDate;
  const horizonEndDate = addDays(horizonStartDate, snapshot.config.horizonDays);
  const purchase = snapshot.plannedPurchases.find((candidate) => candidate.id === request.plannedPurchaseId);
  const monthlySpendingSummaries = summarizeMonthlySpending(
    snapshot.transactions,
    snapshot.currency,
    snapshot.accounts,
  );
  const validation = validateRequest(snapshot, purchase, horizonStartDate, horizonEndDate);
  const opening = calculateOpeningSpendableCash(snapshot.accounts, snapshot.currency, validation.assumptions);

  if (validation.blockingReasons.length > 0 || !purchase?.amountCents || !purchase.purchaseDate) {
    return buildUnknownResponse({
      request,
      purchase,
      horizonStartDate,
      horizonEndDate,
      opening,
      reasons:
        validation.blockingReasons.length > 0
          ? validation.blockingReasons
          : [
              makeReason({
                code: "MISSING_PURCHASE_FIELD",
                severity: "critical",
                level: "UNKNOWN",
                parameters: missingPurchaseParameters(purchase),
                facts: ["selected planned purchase is incomplete"],
              }),
            ],
      assumptions: validation.assumptions,
      freshnessWarnings: validation.freshnessWarnings,
      monthlySpendingSummaries,
    });
  }

  const scenarioEvents = generateForecastEvents(snapshot, purchase, horizonStartDate, horizonEndDate, true);
  const baselineEvents = generateForecastEvents(snapshot, purchase, horizonStartDate, horizonEndDate, false);
  const scenario = buildForecastBundle(opening, scenarioEvents, horizonStartDate, horizonEndDate, snapshot.config);
  const baseline = buildForecastBundle(opening, baselineEvents, horizonStartDate, horizonEndDate, snapshot.config);
  const postPurchaseCashCents = calculatePostPurchaseCash(opening, scenarioEvents, purchase.purchaseDate);
  const timingReserve = calculateTimingReserve(scenarioEvents, purchase.purchaseDate, horizonEndDate);
  const { timingReserveCents } = timingReserve;
  const timingReserveMarginCents =
    postPurchaseCashCents - timingReserveCents - snapshot.config.minimumCashBufferCents;
  const purchaseImpactOnMinimumCents =
    baseline.requiredPath.minimumIntradayBalanceCents - scenario.requiredPath.minimumIntradayBalanceCents;

  const incomeCoverageReason = maybeBuildIncomeCoverageReason(
    snapshot,
    baselineEvents,
    scenarioEvents,
    opening,
    horizonEndDate,
  );

  if (incomeCoverageReason) {
    const reasons = [incomeCoverageReason];
    return {
      requestId: request.requestId,
      asOfDate: snapshot.asOfDate,
      horizonStartDate,
      horizonEndDate,
      level: "UNKNOWN",
      purchase: publicPurchase(purchase),
      metrics: {
        openingSpendableCashCents: opening,
        requiredPath: scenario.requiredPath,
        protectedPath: scenario.protectedPath,
        allEventsPath: scenario.allEventsPath,
        expectedReferencePath: scenario.expectedReferencePath,
        postPurchaseCashCents,
        timingReserveCents,
        timingReserveMarginCents,
        purchaseImpactOnMinimumCents,
      },
      forecast: {
        events: scenario.events.map(stripInternalEvent),
        dailyBalances: scenario.dailyBalances,
      },
      monthlySpendingSummaries,
      explanation: buildExplanation("UNKNOWN", reasons, validation.assumptions, validation.freshnessWarnings, {
        scenario,
        timingReserveMarginCents,
      }),
      debug: {
        baselineMinimumCents: baseline.requiredPath.minimumIntradayBalanceCents,
        scenarioMinimumCents: scenario.requiredPath.minimumIntradayBalanceCents,
        deterministicVersion: ENGINE_VERSION,
      },
    };
  }

  const decision = decideAffordability({
    scenario,
    baseline,
    scenarioEvents,
    timingReserveCents,
    timingReserveMarginCents,
    timingReserve,
    postPurchaseCashCents,
    purchaseImpactOnMinimumCents,
    minimumCashBufferCents: snapshot.config.minimumCashBufferCents,
  });

  return {
    requestId: request.requestId,
    asOfDate: snapshot.asOfDate,
    horizonStartDate,
    horizonEndDate,
    level: decision.level,
    purchase: publicPurchase(purchase),
    metrics: {
      openingSpendableCashCents: opening,
      requiredPath: scenario.requiredPath,
      protectedPath: scenario.protectedPath,
      allEventsPath: scenario.allEventsPath,
      expectedReferencePath: scenario.expectedReferencePath,
      postPurchaseCashCents,
      timingReserveCents,
      timingReserveMarginCents,
      purchaseImpactOnMinimumCents,
    },
    forecast: {
      events: scenario.events.map(stripInternalEvent),
      dailyBalances: scenario.dailyBalances,
    },
    monthlySpendingSummaries,
    explanation: buildExplanation(decision.level, decision.reasons, validation.assumptions, validation.freshnessWarnings, {
      scenario,
      timingReserveMarginCents,
    }),
    debug: {
      baselineMinimumCents: baseline.requiredPath.minimumIntradayBalanceCents,
      scenarioMinimumCents: scenario.requiredPath.minimumIntradayBalanceCents,
      deterministicVersion: ENGINE_VERSION,
    },
  };
}

function validateRequest(
  snapshot: FinancialSnapshot,
  purchase: PlannedPurchase | undefined,
  horizonStartDate: string,
  horizonEndDate: string,
): ValidationResult {
  const blockingReasons: DecisionReason[] = [];
  const assumptions: Assumption[] = [];
  const freshnessWarnings: FreshnessWarning[] = [];

  if (!isIsoDate(snapshot.asOfDate)) {
    blockingReasons.push(coverageIncompleteReason("date", horizonEndDate, ["snapshot asOfDate is invalid"]));
  }

  if (!purchase || !purchase.amountCents || purchase.amountCents <= 0 || !purchase.purchaseDate || !isIsoDate(purchase.purchaseDate)) {
    blockingReasons.push(missingPurchaseReason(purchase, ["selected planned purchase requires a positive amount and ISO purchaseDate"]));
  } else if (
    compareDates(purchase.purchaseDate, horizonStartDate) < 0 ||
    compareDates(purchase.purchaseDate, horizonEndDate) > 0
  ) {
    blockingReasons.push(missingPurchaseReason(purchase, ["selected planned purchase date falls outside the MVP 0 forecast horizon"]));
  }

  const relevantCurrencies = new Set<string>([snapshot.currency]);
  for (const account of snapshot.accounts) relevantCurrencies.add(account.currency);
  for (const transaction of snapshot.transactions) relevantCurrencies.add(transaction.currency);
  for (const income of snapshot.incomeSources) if (income.currency) relevantCurrencies.add(income.currency);
  for (const obligation of snapshot.recurringObligations) if (obligation.currency) relevantCurrencies.add(obligation.currency);
  for (const goal of snapshot.goals) if (goal.currency) relevantCurrencies.add(goal.currency);
  if (purchase?.currency) relevantCurrencies.add(purchase.currency);

  if (relevantCurrencies.size > 1) {
    blockingReasons.push(coverageIncompleteReason("currency", horizonEndDate, ["MVP 0 does not normalize mixed currencies"]));
  }

  const spendableAccounts = includedSpendableAccounts(snapshot.accounts);
  if (!snapshot.coverage.balancesDeclaredComplete || spendableAccounts.length === 0) {
    blockingReasons.push(coverageIncompleteReason("balances", horizonEndDate, ["no complete spendable cash balance is available"]));
  }

  for (const account of spendableAccounts) {
    if (account.availableBalanceCents === undefined) {
      assumptions.push({
        code: "AVAILABLE_BALANCE_MISSING",
        severity: "info",
        message: `${account.displayName} has no available balance, so current balance is used.`,
        relatedEntityIds: [account.id],
      });
    }

    const staleWarning = staleBalanceWarning(account, snapshot.config, snapshot.asOfDate);
    if (staleWarning) {
      freshnessWarnings.push(staleWarning);
      blockingReasons.push(staleBalanceReason(account.id, freshnessWarnings, [staleWarning.message]));
    }

    freshnessWarnings.push(...account.freshness.warnings);
  }

  addAssumption(assumptions, {
    code: "CONSERVATIVE_SAME_DAY_ORDERING_APPLIED",
    severity: "info",
    message: "Same-day events are applied in conservative decision order.",
    relatedEntityIds: [],
  });

  for (const income of snapshot.incomeSources) {
    if (!income.active) continue;
    if (income.minimumExpectedAmountCents < income.expectedAmountCents || income.variability !== "fixed") {
      addAssumption(assumptions, {
        code: "CONSERVATIVE_INCOME_MINIMUM_USED",
        severity: "info",
        message: `${income.label} uses the conservative minimum amount for decision paths.`,
        relatedEntityIds: [income.id],
      });
    }
  }

  for (const goal of snapshot.goals) {
    if (!goal.active || goal.protection !== "flexible") continue;
    addAssumption(assumptions, {
      code: "FLEXIBLE_GOAL_EXCLUDED_FROM_REQUIRED_SOLVENCY",
      severity: "info",
      message: `${goal.label} is excluded from required solvency and included in the all-events path.`,
      relatedEntityIds: [goal.id],
    });
  }

  for (const obligation of snapshot.recurringObligations) {
    if (!obligation.active || obligation.importance !== "optional") continue;
    addAssumption(assumptions, {
      code: "OPTIONAL_OBLIGATION_EXCLUDED_FROM_REQUIRED_SOLVENCY",
      severity: "info",
      message: `${obligation.label} is excluded from required solvency and included in the all-events path.`,
      relatedEntityIds: [obligation.id],
    });
  }

  if (
    compareDates(snapshot.coverage.obligationsDeclaredCompleteThroughDate, horizonEndDate) < 0 ||
    !snapshot.coverage.userConfirmedNoOtherRequiredObligations
  ) {
    freshnessWarnings.push({
      code: "OBLIGATION_COVERAGE_INCOMPLETE",
      severity: "critical",
      message: "Required obligation coverage is incomplete for the 30-day forecast horizon.",
    });
    blockingReasons.push(
      coverageIncompleteReason("obligations", horizonEndDate, [
        "required obligation coverage must be declared complete through the forecast horizon",
      ]),
    );
  }

  return {
    blockingReasons: dedupeReasons(blockingReasons),
    assumptions,
    freshnessWarnings,
  };
}

function calculateOpeningSpendableCash(accounts: Account[], currency: string, assumptions: Assumption[]): number {
  let total = 0;

  for (const account of includedSpendableAccounts(accounts)) {
    if (account.currency !== currency) continue;

    if (account.availableBalanceCents !== undefined) {
      total += Math.min(account.currentBalanceCents, account.availableBalanceCents);
    } else {
      total += account.currentBalanceCents;
      if (!assumptions.some((assumption) => assumption.code === "AVAILABLE_BALANCE_MISSING" && assumption.relatedEntityIds.includes(account.id))) {
        assumptions.push({
          code: "AVAILABLE_BALANCE_MISSING",
          severity: "info",
          message: `${account.displayName} has no available balance, so current balance is used.`,
          relatedEntityIds: [account.id],
        });
      }
    }
  }

  return total;
}

function includedSpendableAccounts(accounts: Account[]): Account[] {
  return accounts.filter(
    (account) =>
      account.includeInForecast && (account.role === "spendable_cash" || account.role === "reserve_cash"),
  );
}

function staleBalanceWarning(
  account: Account,
  config: ForecastConfig,
  snapshotAsOfDate: string,
): FreshnessWarning | undefined {
  if (account.freshness.status === "missing" || account.freshness.status === "stale") {
    return {
      code: "BALANCE_STALE",
      severity: "critical",
      message: `${account.displayName} balance is ${account.freshness.status}.`,
    };
  }

  if (!account.freshness.asOf) return undefined;

  const freshnessDate = extractIsoDate(account.freshness.asOf);
  if (!freshnessDate) {
    return {
      code: "BALANCE_STALE",
      severity: "critical",
      message: `${account.displayName} balance freshness date is invalid.`,
    };
  }

  if (account.source === "manual" || account.source === "fixture" || account.freshness.source === "manual" || account.freshness.source === "fixture") {
    const ageDays = daysBetween(freshnessDate, snapshotAsOfDate);
    if (ageDays > config.staleManualBalanceDays) {
      return {
        code: "BALANCE_STALE",
        severity: "critical",
        message: `${account.displayName} balance is ${ageDays} days old, above the ${config.staleManualBalanceDays}-day manual freshness limit.`,
      };
    }
  } else {
    const ageHours = account.freshness.ageHours ?? hoursBetweenIsoLike(account.freshness.asOf, snapshotAsOfDate);
    if (ageHours !== undefined && ageHours > config.staleBalanceHours) {
      return {
        code: "BALANCE_STALE",
        severity: "critical",
        message: `${account.displayName} balance is ${ageHours} hours old, above the ${config.staleBalanceHours}-hour synced freshness limit.`,
      };
    }
  }

  return undefined;
}

function generateForecastEvents(
  snapshot: FinancialSnapshot,
  selectedPurchase: PlannedPurchase,
  horizonStartDate: string,
  horizonEndDate: string,
  includePurchase: boolean,
): InternalForecastEvent[] {
  const events: InternalForecastEvent[] = [];

  for (const income of snapshot.incomeSources) {
    if (!income.active) continue;

    const reliable =
      (income.variability === "fixed" || income.reliability === "confirmed") &&
      income.uncertainty.confidence >= snapshot.config.reliableIncomeConfidence;
    const conservativePath: ForecastPath = reliable ? "required" : "all";
    const conservativeAmount = income.minimumExpectedAmountCents;
    const dates = expandCadence(income.cadence, income.nextExpectedDate, horizonStartDate, horizonEndDate);

    for (const date of dates) {
      if (conservativeAmount > 0) {
        events.push({
          id: `income:${income.id}:${date}:minimum`,
          sourceEntityId: income.id,
          sourceType: "income",
          date,
          label: income.label,
          amountCents: conservativeAmount,
          path: conservativePath,
          requiredCashNeed: false,
          reliableIncome: reliable,
          confidence: income.uncertainty.confidence,
          order: reliable ? 5 : 6,
          highPriorityProtectedGoal: false,
        });
      }

      const expectedDelta = income.expectedAmountCents - conservativeAmount;
      if (!reliable && expectedDelta > 0) {
        events.push({
          id: `income:${income.id}:${date}:expected_delta`,
          sourceEntityId: income.id,
          sourceType: "income",
          date,
          label: `${income.label} expected amount`,
          amountCents: expectedDelta,
          path: "expected_reference",
          requiredCashNeed: false,
          reliableIncome: false,
          confidence: income.uncertainty.confidence,
          order: 6,
          highPriorityProtectedGoal: false,
        });
      }
    }
  }

  for (const obligation of snapshot.recurringObligations) {
    if (!obligation.active) continue;

    const dates = expandCadence(obligation.cadence, obligation.nextDueDate, horizonStartDate, horizonEndDate);
    const isRequired = obligation.required && obligation.importance === "required";
    for (const date of dates) {
      events.push({
        id: `obligation:${obligation.id}:${date}`,
        sourceEntityId: obligation.id,
        sourceType: "obligation",
        date,
        label: obligation.label,
        amountCents: -obligation.amountCents,
        path: isRequired ? "required" : "all",
        requiredCashNeed: isRequired,
        reliableIncome: false,
        confidence: obligation.uncertainty.confidence,
        order: isRequired ? 1 : 4,
        highPriorityProtectedGoal: false,
      });
    }
  }

  for (const goal of snapshot.goals) {
    if (!goal.active || goal.monthlyContributionCents <= 0) continue;

    const dates = expandCadence(goal.contributionCadence, goal.nextContributionDate, horizonStartDate, horizonEndDate);
    for (const date of dates) {
      events.push({
        id: `goal:${goal.id}:${date}`,
        sourceEntityId: goal.id,
        sourceType: "goal",
        date,
        label: goal.label,
        amountCents: -goal.monthlyContributionCents,
        path: goal.protection === "protected" ? "protected" : "all",
        requiredCashNeed: false,
        reliableIncome: false,
        confidence: goal.uncertainty.confidence,
        order: goal.protection === "protected" ? 2 : 4,
        highPriorityProtectedGoal: goal.protection === "protected" && goal.priority === "high",
      });
    }
  }

  if (includePurchase && selectedPurchase.amountCents && selectedPurchase.purchaseDate) {
    events.push({
      id: `planned_purchase:${selectedPurchase.id}:${selectedPurchase.purchaseDate}`,
      sourceEntityId: selectedPurchase.id,
      sourceType: "planned_purchase",
      date: selectedPurchase.purchaseDate,
      label: selectedPurchase.label,
      amountCents: -selectedPurchase.amountCents,
      path: "required",
      requiredCashNeed: true,
      reliableIncome: false,
      confidence: selectedPurchase.uncertainty.confidence,
      order: 3,
      highPriorityProtectedGoal: false,
    });
  }

  return events.sort(compareEvents);
}

function buildForecastBundle(
  openingBalanceCents: number,
  events: InternalForecastEvent[],
  horizonStartDate: string,
  horizonEndDate: string,
  config: ForecastConfig,
): ForecastBundle {
  const required = calculatePath(openingBalanceCents, events, "required", horizonStartDate, horizonEndDate, config.minimumCashBufferCents);
  const protectedPath = calculatePath(openingBalanceCents, events, "protected", horizonStartDate, horizonEndDate, config.minimumCashBufferCents);
  const all = calculatePath(openingBalanceCents, events, "all", horizonStartDate, horizonEndDate, config.minimumCashBufferCents);
  const shouldIncludeExpectedReference = events.some((event) => event.path === "expected_reference");
  const expectedReference = shouldIncludeExpectedReference
    ? calculatePath(openingBalanceCents, events, "expected_reference", horizonStartDate, horizonEndDate, config.minimumCashBufferCents)
    : undefined;

  const dailyBalances = dateRange(horizonStartDate, horizonEndDate).map((date, index) => ({
    date,
    requiredPathBalanceCents: required.dailyBalances[index] ?? openingBalanceCents,
    protectedPathBalanceCents: protectedPath.dailyBalances[index] ?? openingBalanceCents,
    allEventsPathBalanceCents: all.dailyBalances[index] ?? openingBalanceCents,
    ...(expectedReference
      ? { expectedReferencePathBalanceCents: expectedReference.dailyBalances[index] ?? openingBalanceCents }
      : {}),
  }));

  return {
    events,
    dailyBalances,
    requiredPath: required.metrics,
    protectedPath: protectedPath.metrics,
    allEventsPath: all.metrics,
    expectedReferencePath: expectedReference?.metrics,
  };
}

function calculatePath(
  openingBalanceCents: number,
  events: InternalForecastEvent[],
  path: ForecastPath,
  horizonStartDate: string,
  horizonEndDate: string,
  minimumCashBufferCents: number,
): { metrics: ForecastPathMetrics; dailyBalances: number[] } {
  let balance = openingBalanceCents;
  let minimumBalanceCents = openingBalanceCents;
  let minimumBalanceDate = horizonStartDate;
  let minimumIntradayBalanceCents = openingBalanceCents;
  let minimumIntradayBalanceDate = horizonStartDate;
  const dailyBalances: number[] = [];

  for (const date of dateRange(horizonStartDate, horizonEndDate)) {
    const dayEvents = events.filter((event) => event.date === date && pathIncludesEvent(event, path)).sort(compareEvents);

    for (const event of dayEvents) {
      balance += event.amountCents;
      if (balance < minimumIntradayBalanceCents) {
        minimumIntradayBalanceCents = balance;
        minimumIntradayBalanceDate = date;
      }
    }

    if (balance < minimumBalanceCents) {
      minimumBalanceCents = balance;
      minimumBalanceDate = date;
    }
    dailyBalances.push(balance);
  }

  return {
    metrics: {
      openingBalanceCents,
      endingBalanceCents: balance,
      minimumBalanceCents,
      minimumBalanceDate,
      minimumIntradayBalanceCents,
      minimumIntradayBalanceDate,
      bufferMarginCents: minimumIntradayBalanceCents - minimumCashBufferCents,
    },
    dailyBalances,
  };
}

function calculatePostPurchaseCash(
  openingBalanceCents: number,
  events: InternalForecastEvent[],
  purchaseDate: string,
): number {
  let balance = openingBalanceCents;
  for (const event of events.filter((candidate) => pathIncludesEvent(candidate, "required")).sort(compareEvents)) {
    if (compareDates(event.date, purchaseDate) < 0 || (event.date === purchaseDate && event.order <= 3)) {
      balance += event.amountCents;
    }
  }
  return balance;
}

function calculateTimingReserve(
  events: InternalForecastEvent[],
  purchaseDate: string,
  horizonEndDate: string,
): TimingReserve {
  const nextReliableIncomeDate = events
    .filter(
      (event) =>
        event.sourceType === "income" &&
        event.reliableIncome &&
        compareDates(event.date, purchaseDate) > 0 &&
        compareDates(event.date, horizonEndDate) <= 0,
    )
    .map((event) => event.date)
    .sort()[0];
  const reserveEndDate = nextReliableIncomeDate ?? horizonEndDate;

  const timingReserveCents = events
    .filter(
      (event) =>
        event.sourceType === "obligation" &&
        event.requiredCashNeed &&
        compareDates(event.date, purchaseDate) > 0 &&
        compareDates(event.date, reserveEndDate) <= 0,
    )
    .reduce((sum, event) => sum + Math.abs(event.amountCents), 0);

  return {
    timingReserveCents,
    timingReserveWindowEndDate: reserveEndDate,
    nextReliableIncomeDate,
  };
}

function maybeBuildIncomeCoverageReason(
  snapshot: FinancialSnapshot,
  _baselineEvents: InternalForecastEvent[],
  scenarioEvents: InternalForecastEvent[],
  opening: number,
  horizonEndDate: string,
): DecisionReason | undefined {
  if (compareDates(snapshot.coverage.incomeDeclaredCompleteThroughDate, horizonEndDate) >= 0) return undefined;

  const requiredWithoutIncomeEvents = scenarioEvents.filter((event) => event.sourceType !== "income");
  const withoutIncome = calculatePath(
    opening,
    requiredWithoutIncomeEvents,
    "required",
    snapshot.asOfDate,
    horizonEndDate,
    snapshot.config.minimumCashBufferCents,
  );
  const withIncome = calculatePath(
    opening,
    scenarioEvents,
    "required",
    snapshot.asOfDate,
    horizonEndDate,
    snapshot.config.minimumCashBufferCents,
  );

  if (
    withoutIncome.metrics.minimumIntradayBalanceCents < 0 &&
    withIncome.metrics.minimumIntradayBalanceCents >= 0
  ) {
    const relatedIncomeSourceIds = uniqueForecastEntityIds(
      scenarioEvents,
      (event) => event.sourceType === "income" && pathIncludesEvent(event, "required"),
    );
    return coverageIncompleteReason(
      "income",
      horizonEndDate,
      ["income coverage is incomplete and future income is needed to avoid a required shortfall"],
      relatedIncomeSourceIds,
    );
  }

  return undefined;
}

function decideAffordability(input: {
  scenario: ForecastBundle;
  baseline: ForecastBundle;
  scenarioEvents: InternalForecastEvent[];
  timingReserveCents: number;
  timingReserveMarginCents: number;
  timingReserve: TimingReserve;
  postPurchaseCashCents: number;
  purchaseImpactOnMinimumCents: number;
  minimumCashBufferCents: number;
}): { level: AffordabilityLevel; reasons: DecisionReason[] } {
  const postPurchaseAfterReserve = input.postPurchaseCashCents - input.timingReserveCents;
  const riskyReasons: DecisionReason[] = [];

  if (
    input.scenario.requiredPath.minimumIntradayBalanceCents < 0 &&
    input.scenario.expectedReferencePath &&
    input.scenario.expectedReferencePath.minimumIntradayBalanceCents >= 0 &&
    input.scenarioEvents.some((event) => event.path === "expected_reference" && event.sourceType === "income")
  ) {
    const expectedIncomeSourceIds = uniqueForecastEntityIds(
      input.scenarioEvents,
      (event) => event.path === "expected_reference" && event.sourceType === "income",
    );
    riskyReasons.push(
      makeReason({
        code: "VARIABLE_INCOME_NOT_GUARANTEED",
        severity: "critical",
        level: "RISKY",
        parameters: {
          requiredMinimumBalanceCents: input.scenario.requiredPath.minimumIntradayBalanceCents,
          requiredMinimumBalanceDate: input.scenario.requiredPath.minimumIntradayBalanceDate,
          expectedReferenceMinimumBalanceCents: input.scenario.expectedReferencePath.minimumIntradayBalanceCents,
          expectedReferenceMinimumBalanceDate: input.scenario.expectedReferencePath.minimumIntradayBalanceDate,
        },
        relatedEntityIds: expectedIncomeSourceIds,
        facts: ["expected reference income improves the path but is not reliable enough for the required decision"],
      }),
    );
  }

  if (input.scenario.requiredPath.minimumIntradayBalanceCents < 0) {
    riskyReasons.push(
      makeReason({
        code: "REQUIRED_OBLIGATION_SHORTFALL",
        severity: "critical",
        level: "RISKY",
        parameters: {
          requiredMinimumBalanceCents: input.scenario.requiredPath.minimumIntradayBalanceCents,
          requiredMinimumBalanceDate: input.scenario.requiredPath.minimumIntradayBalanceDate,
        },
        facts: [`required path minimum is ${input.scenario.requiredPath.minimumIntradayBalanceCents} cents`],
      }),
    );
  }

  if (postPurchaseAfterReserve < 0) {
    riskyReasons.push(
      makeReason({
        code: "TIMING_RESERVE_SHORTFALL",
        severity: "critical",
        level: "RISKY",
        parameters: timingReasonParameters(input),
        facts: [`post-purchase cash after timing reserve is ${postPurchaseAfterReserve} cents`],
      }),
    );
  }

  if (
    input.scenario.protectedPath.minimumIntradayBalanceCents < 0 &&
    input.scenarioEvents.some((event) => event.highPriorityProtectedGoal)
  ) {
    const highPriorityProtectedGoalIds = uniqueForecastEntityIds(
      input.scenarioEvents,
      (event) => event.highPriorityProtectedGoal,
    );
    riskyReasons.push(
      makeReason({
        code: "HIGH_PRIORITY_GOAL_SHORTFALL",
        severity: "critical",
        level: "RISKY",
        parameters: {
          protectedMinimumBalanceCents: input.scenario.protectedPath.minimumIntradayBalanceCents,
          protectedMinimumBalanceDate: input.scenario.protectedPath.minimumIntradayBalanceDate,
        },
        relatedEntityIds: highPriorityProtectedGoalIds,
        facts: [`protected path minimum is ${input.scenario.protectedPath.minimumIntradayBalanceCents} cents`],
      }),
    );
  }

  if (riskyReasons.length > 0) {
    return { level: "RISKY", reasons: dedupeReasons(riskyReasons) };
  }

  const tightReasons: DecisionReason[] = [];
  const lowest = lowestConservativePath(input.scenario);

  if (
    input.scenario.protectedPath.minimumIntradayBalanceCents < input.minimumCashBufferCents &&
    input.baseline.protectedPath.minimumIntradayBalanceCents >= input.minimumCashBufferCents &&
    input.scenarioEvents.some((event) => event.path === "protected" && event.sourceType === "goal")
  ) {
    const protectedGoalIds = uniqueForecastEntityIds(
      input.scenarioEvents,
      (event) => event.path === "protected" && event.sourceType === "goal",
    );
    tightReasons.push(
      makeReason({
        code: "GOAL_BUFFER_CONFLICT",
        severity: "warning",
        level: "TIGHT",
        parameters: {
          protectedMinimumBalanceCents: input.scenario.protectedPath.minimumIntradayBalanceCents,
          protectedMinimumBalanceDate: input.scenario.protectedPath.minimumIntradayBalanceDate,
          protectedBufferMarginCents: input.scenario.protectedPath.bufferMarginCents,
          baselineProtectedMinimumBalanceCents: input.baseline.protectedPath.minimumIntradayBalanceCents,
          minimumCashBufferCents: input.minimumCashBufferCents,
        },
        relatedEntityIds: protectedGoalIds,
        facts: [`protected path buffer margin is ${input.scenario.protectedPath.bufferMarginCents} cents`],
      }),
    );
  }

  if (
    input.scenario.allEventsPath.minimumIntradayBalanceCents < input.minimumCashBufferCents &&
    input.scenario.protectedPath.minimumIntradayBalanceCents >= input.minimumCashBufferCents &&
    input.scenarioEvents.some((event) => event.path === "all" && event.sourceType === "obligation")
  ) {
    const optionalObligationIds = uniqueForecastEntityIds(
      input.scenarioEvents,
      (event) => event.path === "all" && event.sourceType === "obligation",
    );
    tightReasons.push(
      makeReason({
        code: "OPTIONAL_OBLIGATION_TRADEOFF",
        severity: "warning",
        level: "TIGHT",
        parameters: {
          allEventsMinimumBalanceCents: input.scenario.allEventsPath.minimumIntradayBalanceCents,
          allEventsMinimumBalanceDate: input.scenario.allEventsPath.minimumIntradayBalanceDate,
          allEventsBufferMarginCents: input.scenario.allEventsPath.bufferMarginCents,
          minimumCashBufferCents: input.minimumCashBufferCents,
        },
        relatedEntityIds: optionalObligationIds,
        facts: [`all-events path buffer margin is ${input.scenario.allEventsPath.bufferMarginCents} cents`],
      }),
    );
  }

  if (lowest.metrics.minimumIntradayBalanceCents < input.minimumCashBufferCents) {
    tightReasons.push(
      makeReason({
        code: "BUFFER_BELOW_MINIMUM",
        severity: "warning",
        level: "TIGHT",
        parameters: {
          path: lowest.path,
          minimumBalanceCents: lowest.metrics.minimumIntradayBalanceCents,
          minimumBalanceDate: lowest.metrics.minimumIntradayBalanceDate,
          bufferMarginCents: lowest.metrics.bufferMarginCents,
          bufferShortfallCents: input.minimumCashBufferCents - lowest.metrics.minimumIntradayBalanceCents,
          minimumCashBufferCents: input.minimumCashBufferCents,
        },
        facts: [`minimum conservative path balance is ${lowest.metrics.minimumIntradayBalanceCents} cents`],
      }),
    );
  }

  if (
    input.timingReserveCents > 0 &&
    postPurchaseAfterReserve >= 0 &&
    input.timingReserveMarginCents < 0
  ) {
    tightReasons.push(
      makeReason({
        code: "TIMING_RESERVE_LOW",
        severity: "warning",
        level: "TIGHT",
        parameters: timingReasonParameters(input),
        facts: [`timing reserve margin is ${input.timingReserveMarginCents} cents`],
      }),
    );
  }

  if (
    input.baseline.requiredPath.bufferMarginCents < 0 &&
    input.purchaseImpactOnMinimumCents > 0
  ) {
    tightReasons.push(
      makeReason({
        code: "BASELINE_ALREADY_TIGHT",
        severity: "warning",
        level: "TIGHT",
        parameters: {
          baselineMinimumBalanceCents: input.baseline.requiredPath.minimumIntradayBalanceCents,
          baselineMinimumBalanceDate: input.baseline.requiredPath.minimumIntradayBalanceDate,
          baselineBufferMarginCents: input.baseline.requiredPath.bufferMarginCents,
          purchaseImpactOnMinimumCents: input.purchaseImpactOnMinimumCents,
          minimumCashBufferCents: input.minimumCashBufferCents,
        },
        facts: [`baseline required path buffer margin is ${input.baseline.requiredPath.bufferMarginCents} cents`],
      }),
    );
  }

  if (tightReasons.length > 0) {
    return { level: "TIGHT", reasons: dedupeReasons(tightReasons) };
  }

  return {
    level: "AFFORDABLE",
    reasons: [
      makeReason({
        code: "BUFFER_PASSED",
        severity: "info",
        level: "AFFORDABLE",
        parameters: {
          requiredBufferMarginCents: input.scenario.requiredPath.bufferMarginCents,
          minimumCashBufferCents: input.minimumCashBufferCents,
          minimumBalanceDate: input.scenario.requiredPath.minimumIntradayBalanceDate,
        },
        facts: [`required path buffer margin is ${input.scenario.requiredPath.bufferMarginCents} cents`],
      }),
      makeReason({
        code: "TIMING_RESERVE_PASSED",
        severity: "info",
        level: "AFFORDABLE",
        parameters: timingReasonParameters(input),
        facts: [`timing reserve margin is ${input.timingReserveMarginCents} cents`],
      }),
    ],
  };
}

function pathIncludesEvent(event: ForecastEvent, path: ForecastPath): boolean {
  if (path === "required") return event.path === "required";
  if (path === "protected") return event.path === "required" || event.path === "protected";
  if (path === "all") return event.path === "required" || event.path === "protected" || event.path === "all";
  return true;
}

function compareEvents(left: InternalForecastEvent, right: InternalForecastEvent): number {
  return (
    left.date.localeCompare(right.date) ||
    left.order - right.order ||
    left.id.localeCompare(right.id)
  );
}

function publicPurchase(purchase: PlannedPurchase | undefined): AffordabilityResponse["purchase"] {
  return {
    id: purchase?.id ?? "unknown_purchase",
    label: purchase?.label ?? "Unknown purchase",
    ...(purchase?.amountCents !== undefined ? { amountCents: purchase.amountCents } : {}),
    ...(purchase?.purchaseDate !== undefined ? { purchaseDate: purchase.purchaseDate } : {}),
  };
}

function buildUnknownResponse(input: {
  request: AffordabilityRequest;
  purchase: PlannedPurchase | undefined;
  horizonStartDate: string;
  horizonEndDate: string;
  opening: number;
  reasons: DecisionReason[];
  assumptions: Assumption[];
  freshnessWarnings: FreshnessWarning[];
  monthlySpendingSummaries: AffordabilityResponse["monthlySpendingSummaries"];
}): AffordabilityResponse {
  const emptyMetrics = emptyPathMetrics(input.opening, input.horizonStartDate, input.request.snapshot.config.minimumCashBufferCents);
  return {
    requestId: input.request.requestId,
    asOfDate: input.request.snapshot.asOfDate,
    horizonStartDate: input.horizonStartDate,
    horizonEndDate: input.horizonEndDate,
    level: "UNKNOWN",
    purchase: publicPurchase(input.purchase),
    metrics: {
      openingSpendableCashCents: input.opening,
      requiredPath: emptyMetrics,
      protectedPath: emptyMetrics,
      allEventsPath: emptyMetrics,
      postPurchaseCashCents: input.opening,
      timingReserveCents: 0,
      timingReserveMarginCents: input.opening - input.request.snapshot.config.minimumCashBufferCents,
      purchaseImpactOnMinimumCents: 0,
    },
    forecast: {
      events: [],
      dailyBalances: [],
    },
    monthlySpendingSummaries: input.monthlySpendingSummaries,
    explanation: buildExplanation("UNKNOWN", dedupeReasons(input.reasons), input.assumptions, input.freshnessWarnings),
    debug: {
      baselineMinimumCents: input.opening,
      scenarioMinimumCents: input.opening,
      deterministicVersion: ENGINE_VERSION,
    },
  };
}

function emptyPathMetrics(opening: number, asOfDate: string, minimumCashBufferCents: number): ForecastPathMetrics {
  return {
    openingBalanceCents: opening,
    endingBalanceCents: opening,
    minimumBalanceCents: opening,
    minimumBalanceDate: asOfDate,
    minimumIntradayBalanceCents: opening,
    minimumIntradayBalanceDate: asOfDate,
    bufferMarginCents: opening - minimumCashBufferCents,
  };
}

function buildExplanation(
  level: AffordabilityLevel,
  reasons: DecisionReason[],
  assumptions: Assumption[],
  freshnessWarnings: FreshnessWarning[],
  context?: { scenario: ForecastBundle; timingReserveMarginCents: number },
): DecisionExplanation {
  return {
    headlineFact: headlineFor(level, context),
    reasons,
    assumptions,
    freshnessWarnings,
    boundaries: PRODUCT_BOUNDARIES,
  };
}

function headlineFor(level: AffordabilityLevel, context?: { scenario: ForecastBundle; timingReserveMarginCents: number }): string {
  if (!context) {
    return "Affordability is unknown because critical input data is missing, stale, or incomplete.";
  }

  if (level === "AFFORDABLE") {
    return `Projected required cash stays ${context.scenario.requiredPath.bufferMarginCents} cents above the configured buffer.`;
  }
  if (level === "TIGHT") {
    return `Projected cash remains nonnegative, with a lowest buffer margin of ${Math.min(
      context.scenario.requiredPath.bufferMarginCents,
      context.scenario.protectedPath.bufferMarginCents,
      context.scenario.allEventsPath.bufferMarginCents,
    )} cents.`;
  }
  if (level === "RISKY") {
    return `Projected required cash falls to ${context.scenario.requiredPath.minimumIntradayBalanceCents} cents on ${context.scenario.requiredPath.minimumIntradayBalanceDate}.`;
  }

  return "Affordability is unknown because critical input data is missing, stale, or incomplete.";
}

function makeReason<Code extends ReasonCode>(input: {
  code: Code;
  severity: "info" | "warning" | "critical";
  level: AffordabilityLevel;
  parameters: ReasonParameterMap[Code];
  facts: string[];
  amountCents?: number;
  date?: string;
  relatedEntityIds?: string[];
}): Extract<DecisionReason, { code: Code }> {
  return {
    code: input.code,
    severity: input.severity,
    level: input.level,
    parameters: input.parameters,
    amountCents: input.amountCents,
    date: input.date,
    relatedEntityIds: input.relatedEntityIds ?? [],
    facts: input.facts,
  } as Extract<DecisionReason, { code: Code }>;
}

function missingPurchaseReason(purchase: PlannedPurchase | undefined, facts: string[]): DecisionReason {
  return makeReason({
    code: "MISSING_PURCHASE_FIELD",
    severity: "critical",
    level: "UNKNOWN",
    parameters: missingPurchaseParameters(purchase),
    facts,
    relatedEntityIds: purchase ? [purchase.id] : [],
  });
}

function missingPurchaseParameters(
  purchase: PlannedPurchase | undefined,
): ReasonParameterMap["MISSING_PURCHASE_FIELD"] {
  if (!purchase) return { missingFields: ["purchase"] };

  const missingFields: ReasonParameterMap["MISSING_PURCHASE_FIELD"]["missingFields"] = [];
  if (!purchase.amountCents || purchase.amountCents <= 0) missingFields.push("amountCents");
  if (!purchase.purchaseDate || !isIsoDate(purchase.purchaseDate)) missingFields.push("purchaseDate");

  return { missingFields };
}

function coverageIncompleteReason(
  coverageType: ReasonParameterMap["COVERAGE_INCOMPLETE"]["coverageType"],
  horizonEndDate: string | undefined,
  facts: string[],
  relatedEntityIds: string[] = [],
): DecisionReason {
  return makeReason({
    code: "COVERAGE_INCOMPLETE",
    severity: "critical",
    level: "UNKNOWN",
    parameters: { coverageType, horizonEndDate },
    relatedEntityIds,
    facts,
  });
}

function staleBalanceReason(
  accountId: string,
  freshnessWarnings: FreshnessWarning[],
  facts: string[],
): DecisionReason {
  return makeReason({
    code: "STALE_BALANCE",
    severity: "critical",
    level: "UNKNOWN",
    parameters: {
      staleAccountIds: [accountId],
      criticalFreshnessWarningCount: freshnessWarnings.filter(
        (warning) => warning.code === "BALANCE_STALE" && warning.severity === "critical",
      ).length,
    },
    relatedEntityIds: [accountId],
    facts,
  });
}

function timingReasonParameters(input: {
  postPurchaseCashCents: number;
  timingReserveCents: number;
  timingReserveMarginCents: number;
  timingReserve: TimingReserve;
  minimumCashBufferCents: number;
}): ReasonParameterMap["TIMING_RESERVE_PASSED"] {
  return {
    postPurchaseCashCents: input.postPurchaseCashCents,
    timingReserveCents: input.timingReserveCents,
    timingReserveMarginCents: input.timingReserveMarginCents,
    timingReserveWindowEndDate: input.timingReserve.timingReserveWindowEndDate,
    nextReliableIncomeDate: input.timingReserve.nextReliableIncomeDate,
    minimumCashBufferCents: input.minimumCashBufferCents,
  };
}

function lowestConservativePath(scenario: ForecastBundle): {
  path: "required" | "protected" | "all";
  metrics: ForecastPathMetrics;
} {
  const paths = [
    { path: "required" as const, metrics: scenario.requiredPath },
    { path: "protected" as const, metrics: scenario.protectedPath },
    { path: "all" as const, metrics: scenario.allEventsPath },
  ];

  return paths.reduce((lowest, candidate) =>
    candidate.metrics.minimumIntradayBalanceCents < lowest.metrics.minimumIntradayBalanceCents ? candidate : lowest,
  );
}

function addAssumption(assumptions: Assumption[], assumption: Assumption): void {
  const duplicate = assumptions.some(
    (candidate) =>
      candidate.code === assumption.code &&
      candidate.relatedEntityIds.join("|") === assumption.relatedEntityIds.join("|"),
  );

  if (!duplicate) assumptions.push(assumption);
}

function dedupeReasons(reasons: DecisionReason[]): DecisionReason[] {
  const seen = new Set<ReasonCode>();
  const deduped: DecisionReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    deduped.push(reason);
  }
  return deduped;
}

function uniqueForecastEntityIds(
  events: InternalForecastEvent[],
  predicate: (event: InternalForecastEvent) => boolean,
): string[] {
  return [...new Set(events.filter(predicate).map((event) => event.sourceEntityId))];
}

function stripInternalEvent(event: InternalForecastEvent): ForecastEvent {
  const { order: _order, highPriorityProtectedGoal: _highPriorityProtectedGoal, ...forecastEvent } = event;
  return forecastEvent;
}
