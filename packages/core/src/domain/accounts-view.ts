/**
 * Accounts view, grouped by institution.
 *
 * Carries `statementCycle` for credit cards, which is the highest-value item in
 * the whole UI contract. The user's problem in their words: *"I spend a lot on
 * my credit card and then towards the end of the month I am racing behind
 * trying to figure out how, and I still have to pay it off."*
 *
 * A card closing on the 18th means the bill arriving in August is mostly July
 * spending. `currentPeriodSpendCents` is the figure that answers their
 * question, and it cannot be derived from a calendar month.
 */
import type { Account, Transaction } from "./types";
import { containsDate, statementPeriodForDate } from "./periods";
import { clampDay, formatDate, parseDateParts } from "./dates";

export type AccountConnectionStatus = "healthy" | "syncing" | "needs_attention" | "disconnected";

export type StatementCycleView = {
  closingDay: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  currentPeriodSpendCents: number;
  elapsedDays: number;
  totalDays: number;
  dueDate?: string;
  lastStatementBalanceCents?: number;
  source: "plaid" | "user_provided" | "inferred";
};

export type AccountView = {
  id: string;
  displayName: string;
  mask?: string;
  type: Account["type"];
  role: Account["role"];
  currentBalanceCents: number;
  availableBalanceCents?: number;
  creditLimitCents?: number;
  /** True for cards and loans. The UI renders "owed" rather than a balance
   *  instead of inferring intent from a minus sign. */
  isDebt: boolean;
  /** Always positive. What this account contributes to net position, signed. */
  netContributionCents: number;
  freshness: Account["freshness"];
  statementCycle?: StatementCycleView;
};

export type InstitutionView = {
  id: string;
  displayName: string;
  connectionStatus: AccountConnectionStatus;
  lastSyncedAt?: string;
  accounts: AccountView[];
};

export type AccountsResult = {
  /** Cash minus card debt. Backend-owned so the UI never sums balances. */
  netPositionCents: number;
  netPositionLabel: string;
  institutions: InstitutionView[];
};

function isSpend(t: Transaction): boolean {
  return t.flowType === "SPEND" || t.flowType === "FEE";
}

/** Cash adds, debt subtracts, excluded accounts contribute nothing. */
function netContribution(account: Account): number {
  const magnitude = Math.abs(account.currentBalanceCents);
  if (account.role === "liability") return -magnitude;
  if (account.role === "excluded") return 0;
  return magnitude;
}

export function buildAccountsView(options: {
  accounts: Account[];
  transactions: Transaction[];
  currency: string;
  asOfDate: string;
}): AccountsResult {
  const { accounts, transactions, currency, asOfDate } = options;
  const scoped = transactions.filter((t) => t.currency === currency);

  let net = 0;
  const institutions = new Map<string, InstitutionView>();

  for (const account of accounts) {
    // Sign by role, not by the raw figure. Fixtures and providers disagree on
    // whether a card balance is positive (amount owed) or negative (a debt), so
    // trusting the sign would silently add debt to cash.
    net += netContribution(account);

    const institutionName = account.institutionName ?? "Unknown";
    const id = institutionName.toLowerCase().replace(/\s+/g, "_");
    const institution =
      institutions.get(id) ??
      ({
        id,
        displayName: institutionName,
        connectionStatus: connectionStatusFor(account),
        lastSyncedAt: account.freshness.asOf,
        accounts: [],
      } satisfies InstitutionView);

    institution.accounts.push({
      id: account.id,
      displayName: account.displayName,
      mask: account.displayName.match(/(\d{4})$/)?.[1],
      type: account.type,
      role: account.role,
      currentBalanceCents: Math.abs(account.currentBalanceCents),
      isDebt: account.role === "liability",
      netContributionCents: netContribution(account),
      availableBalanceCents: account.availableBalanceCents,
      creditLimitCents: account.creditLimitCents,
      freshness: account.freshness,
      statementCycle: buildCycle(account, scoped, asOfDate),
    });

    // Worst status across the institution's accounts wins — a single broken
    // connection should not be hidden by healthy siblings.
    institution.connectionStatus = worst(
      institution.connectionStatus,
      connectionStatusFor(account),
    );
    institutions.set(id, institution);
  }

  return {
    netPositionCents: net,
    netPositionLabel: "Cash, minus what you owe on cards",
    institutions: [...institutions.values()],
  };
}

function buildCycle(
  account: Account,
  transactions: Transaction[],
  asOfDate: string,
): StatementCycleView | undefined {
  if (account.type !== "credit_card") return undefined;
  const cycle = account.statementCycle;
  // No known closing day: return nothing rather than guessing. An inferred
  // cycle presented as fact is worse than no cycle at all.
  if (!cycle) return undefined;

  const period = statementPeriodForDate(
    asOfDate,
    cycle.closingDay,
    asOfDate,
    account.id,
    account.displayName,
  );

  const spend = transactions
    .filter((t) => t.accountId === account.id && isSpend(t) && containsDate(period, t.postedDate))
    .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

  const refunds = transactions
    .filter(
      (t) =>
        t.accountId === account.id && t.flowType === "REFUND" && containsDate(period, t.postedDate),
    )
    .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

  return {
    closingDay: cycle.closingDay,
    currentPeriodStart: period.startDate,
    currentPeriodEnd: period.endDate,
    currentPeriodSpendCents: spend - refunds,
    elapsedDays: period.elapsedDays,
    totalDays: period.totalDays,
    dueDate: cycle.dueDayOfMonth ? dueDateFor(period.endDate, cycle.dueDayOfMonth) : undefined,
    lastStatementBalanceCents: cycle.lastStatementBalanceCents,
    source: cycle.source,
  };
}

function dueDateFor(periodEnd: string, dueDayOfMonth: number): string {
  const { year, month } = parseDateParts(periodEnd);
  let dueYear = year;
  let dueMonth = month + 1;
  if (dueMonth > 12) {
    dueMonth = 1;
    dueYear += 1;
  }
  return formatDate(dueYear, dueMonth, clampDay(dueYear, dueMonth, dueDayOfMonth));
}

function connectionStatusFor(account: Account): AccountConnectionStatus {
  switch (account.freshness.status) {
    case "fresh":
    case "usable":
      return "healthy";
    case "stale":
      return "needs_attention";
    case "missing":
      return "disconnected";
    default:
      return "syncing";
  }
}

const ORDER: AccountConnectionStatus[] = ["healthy", "syncing", "needs_attention", "disconnected"];

function worst(a: AccountConnectionStatus, b: AccountConnectionStatus): AccountConnectionStatus {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}
