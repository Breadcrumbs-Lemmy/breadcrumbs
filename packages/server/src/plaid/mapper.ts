import type {
  Account,
  DataCoverage,
  FinancialSnapshot,
  ForecastConfig,
  Freshness,
  Transaction,
  Uncertainty,
} from "@ai-fin-os/core";
import { normalizeStatementTransaction } from "@ai-fin-os/core";
import type { AccountBase, AccountSubtype, AccountType, Transaction as PlaidTransaction } from "plaid";

export type PlaidSnapshotMappingOptions = {
  asOfDate: string;
  timezone: string;
  currency?: string;
  transactionsCompleteFromDate?: string;
  balancesDeclaredComplete?: boolean;
  incomeDeclaredCompleteThroughDate?: string;
  obligationsDeclaredCompleteThroughDate?: string;
  userConfirmedNoOtherRequiredObligations?: boolean;
  config?: Partial<ForecastConfig>;
};

const DEFAULT_CONFIG: ForecastConfig = {
  horizonDays: 30,
  minimumCashBufferCents: 25_000,
  staleBalanceHours: 72,
  staleManualBalanceDays: 7,
  reliableIncomeConfidence: 0.8,
};

export function mapPlaidAccounts(
  accounts: AccountBase[],
  syncedAt = new Date(),
  institutionName?: string,
): Account[] {
  return accounts.map((account) => mapPlaidAccount(account, syncedAt, institutionName));
}

export function mapPlaidTransactions(transactions: PlaidTransaction[], syncedAt = new Date()): Transaction[] {
  return transactions
    .filter((transaction) => !transaction.pending)
    .map((transaction) => mapPlaidTransaction(transaction, syncedAt));
}

export function mapPlaidDataToSnapshot(input: {
  accounts: AccountBase[];
  transactions: PlaidTransaction[];
  options: PlaidSnapshotMappingOptions;
  syncedAt?: Date;
}): FinancialSnapshot {
  const syncedAt = input.syncedAt ?? new Date();
  const currency = input.options.currency ?? firstIsoCurrency(input.accounts) ?? "USD";
  const asOfDate = input.options.asOfDate;
  const coverage: DataCoverage = {
    balancesDeclaredComplete: input.options.balancesDeclaredComplete ?? false,
    incomeDeclaredCompleteThroughDate: input.options.incomeDeclaredCompleteThroughDate ?? asOfDate,
    obligationsDeclaredCompleteThroughDate: input.options.obligationsDeclaredCompleteThroughDate ?? asOfDate,
    transactionsCompleteFromDate: input.options.transactionsCompleteFromDate,
    userConfirmedNoOtherRequiredObligations: input.options.userConfirmedNoOtherRequiredObligations ?? false,
  };

  return {
    asOfDate,
    timezone: input.options.timezone,
    currency,
    config: { ...DEFAULT_CONFIG, ...input.options.config },
    coverage,
    accounts: mapPlaidAccounts(input.accounts, syncedAt),
    transactions: mapPlaidTransactions(input.transactions, syncedAt),
    incomeSources: [],
    recurringObligations: [],
    goals: [],
    plannedPurchases: [],
  };
}

export function mapPlaidAccount(
  account: AccountBase,
  syncedAt = new Date(),
  institutionName?: string,
): Account {
  const type = mapAccountType(account.type, account.subtype);
  const role = mapAccountRole(account.type, account.subtype);
  const currentBalanceCents = dollarsToCents(account.balances.current ?? account.balances.available ?? 0);
  const availableBalance =
    account.balances.available === null || account.balances.available === undefined
      ? undefined
      : dollarsToCents(account.balances.available);

  return {
    id: plaidEntityId("account", account.account_id),
    displayName: account.official_name ?? account.name,
    institutionName: institutionName ?? issuerPlaceholderFromAccountName(account.official_name ?? account.name),
    type,
    role,
    currency: account.balances.iso_currency_code ?? "USD",
    currentBalanceCents,
    availableBalanceCents: role === "spendable_cash" || role === "reserve_cash" ? availableBalance : undefined,
    creditLimitCents:
      account.balances.limit === null || account.balances.limit === undefined
        ? undefined
        : dollarsToCents(account.balances.limit),
    includeInForecast: role === "spendable_cash" || role === "reserve_cash",
    freshness: freshPlaidFreshness(syncedAt),
    source: "plaid",
  };
}

export function mapPlaidTransaction(transaction: PlaidTransaction, syncedAt = new Date()): Transaction {
  const amountCents = dollarsToCents(-transaction.amount);
  const normalized = normalizeStatementTransaction({
    merchantName: transaction.merchant_name ?? transaction.name ?? "Unknown merchant",
    originalDescription: transaction.original_description ?? transaction.name ?? undefined,
    rawCategory: plaidCategoryText(transaction),
    amountCents,
  });
  return {
    id: plaidEntityId("transaction", transaction.transaction_id),
    accountId: plaidEntityId("account", transaction.account_id),
    postedDate: transaction.date,
    authorizedDate: transaction.authorized_date ?? undefined,
    merchantName: normalized.merchantName,
    originalDescription: transaction.original_description ?? transaction.name ?? undefined,
    amountCents,
    currency: transaction.iso_currency_code ?? "USD",
    category: normalized.category,
    categoryDisplayName: normalized.categoryDisplayName,
    categoryRequiredDefault: normalized.categoryRequiredDefault,
    normalizedMerchantId: normalized.normalizedMerchantId,
    merchantCanonical: normalized.merchantCanonical,
    merchantAmbiguity: normalized.merchantAmbiguity,
    flowType: normalized.flowType,
    normalizationUncertaintyCodes: normalized.uncertaintyCodes,
    freshness: freshPlaidFreshness(syncedAt),
    uncertainty: importedPlaidUncertainty(normalized.confidence, normalized.confidenceReason),
    source: "plaid",
  };
}

function mapAccountType(type: AccountType, subtype: AccountSubtype | null): Account["type"] {
  if (type === "credit") return "credit_card";
  if (type === "loan") return "loan";
  if (type === "investment" || type === "brokerage") return "investment";
  if (type !== "depository") return "other";
  if (subtype === "checking" || subtype === "cash management" || subtype === "limited purpose checking") return "checking";
  if (subtype === "savings" || subtype === "cd" || subtype === "money market") return "savings";
  return "cash";
}

function mapAccountRole(type: AccountType, subtype: AccountSubtype | null): Account["role"] {
  if (type === "credit" || type === "loan") return "liability";
  if (type === "investment" || type === "brokerage") return "excluded";
  if (type !== "depository") return "excluded";
  if (subtype === "checking" || subtype === "cash management" || subtype === "limited purpose checking") {
    return "spendable_cash";
  }
  if (subtype === "savings" || subtype === "cd" || subtype === "money market") return "reserve_cash";
  return "spendable_cash";
}

/**
 * A documented placeholder for the institution name when Plaid's
 * institutions/get_by_id can't resolve one (a null institution_id, or a client
 * without the method). Uses the account name's leading brand word — "Plaid Gold
 * Standard Checking" → "Plaid" — a truthful reading of data already present, so
 * accounts never surface the literal "Unknown". H-034.
 */
function issuerPlaceholderFromAccountName(name: string): string {
  const firstWord = name.trim().split(/\s+/)[0];
  return firstWord && firstWord.length > 0 ? firstWord : "Linked bank";
}

function plaidCategoryText(transaction: PlaidTransaction): string | undefined {
  return (
    transaction.personal_finance_category?.detailed ??
    transaction.personal_finance_category?.primary ??
    transaction.category?.join(" ")
  );
}

function freshPlaidFreshness(syncedAt: Date): Freshness {
  return {
    status: "fresh",
    asOf: syncedAt.toISOString(),
    source: "plaid",
    ageHours: 0,
    warnings: [],
  };
}

function importedPlaidUncertainty(confidence: number, confidenceReason: string): Uncertainty {
  return {
    confidence,
    confidenceReason: `Imported from Plaid Sandbox. ${confidenceReason}`,
    isEstimated: confidence < 0.9,
    estimateMethod: confidence < 0.9 ? "category_average" : undefined,
  };
}

function firstIsoCurrency(accounts: AccountBase[]): string | undefined {
  return accounts.find((account) => account.balances.iso_currency_code)?.balances.iso_currency_code ?? undefined;
}

function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

function plaidEntityId(kind: "account" | "transaction", plaidId: string): string {
  return `plaid:${kind}:${plaidId}`;
}
