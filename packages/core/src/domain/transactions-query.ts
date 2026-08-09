/**
 * Transaction listing for the Transactions screen.
 *
 * This is the drill-down that makes every aggregate above it trustworthy. A
 * user who cannot see the rows behind "Groceries $419.70" has to take the
 * number on faith, and a finance product that asks for faith has already lost.
 *
 * Filtering and pagination only — no aggregation. Totals come from
 * `summarizeSpending` so the list and the summary can never disagree.
 */
import type { Account, FlowType, Transaction } from "./types";
import { compareDates } from "./dates";

const TRUSTED_TRANSFER_CONFIDENCE = 0.8;

/** Why a movement could not be resolved. Surfaced so the UI can explain the
 *  "not sure" badge rather than leaving it looking like a defect. */
export type UnclassifiedReason =
  | "COUNTER_ACCOUNT_NOT_CONNECTED"
  | "COUNTER_ACCOUNT_UNKNOWN"
  | "LOW_MATCH_CONFIDENCE";

export type TransactionView = {
  id: string;
  postedDate: string;
  merchantName: string;
  originalDescription?: string;
  amountCents: number;
  currency: string;
  category: string;
  categoryDisplayName: string;
  accountId: string;
  accountDisplayName: string;
  institutionName: string;
  flowType: FlowType;
  counterAccountId?: string;
  counterAccountDisplayName?: string;
  unclassifiedReason?: UnclassifiedReason;
  isRecurring: boolean;
  pending: boolean;
  normalizationUncertaintyCodes: string[];
};

export type TransactionQuery = {
  transactions: Transaction[];
  accounts: Account[];
  currency?: string;
  from?: string;
  to?: string;
  accountId?: string;
  category?: string;
  /** Filters on the *effective* flow, so an untrusted transfer is found by
   *  searching for unclassified rather than by its declared type. */
  flowType?: FlowType;
  search?: string;
  cursor?: string;
  limit?: number;
  categoryLabel?: (id: string) => string;
};

export type TransactionPage = {
  transactions: TransactionView[];
  nextCursor?: string;
  totalCount: number;
};

function resolve(
  t: Transaction,
  accountIds: Set<string>,
): { flow: FlowType; reason?: UnclassifiedReason } {
  if (t.flowType !== "TRANSFER_OUT" && t.flowType !== "TRANSFER_IN") {
    return { flow: t.flowType };
  }
  if (!t.counterAccountId) {
    return { flow: "UNCLASSIFIED", reason: "COUNTER_ACCOUNT_UNKNOWN" };
  }
  if (!accountIds.has(t.counterAccountId)) {
    return { flow: "UNCLASSIFIED", reason: "COUNTER_ACCOUNT_NOT_CONNECTED" };
  }
  if ((t.transferMatchConfidence ?? 0) < TRUSTED_TRANSFER_CONFIDENCE) {
    return { flow: "UNCLASSIFIED", reason: "LOW_MATCH_CONFIDENCE" };
  }
  return { flow: t.flowType };
}

export function queryTransactions(query: TransactionQuery): TransactionPage {
  const {
    transactions,
    accounts,
    currency,
    from,
    to,
    accountId,
    category,
    flowType,
    search,
    cursor,
    limit = 50,
    categoryLabel = (id) => id,
  } = query;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountIds = new Set(accounts.map((a) => a.id));
  const needle = search?.trim().toLowerCase();

  const matched = transactions.filter((t) => {
    if (currency && t.currency !== currency) return false;
    if (from && compareDates(t.postedDate, from) < 0) return false;
    if (to && compareDates(t.postedDate, to) > 0) return false;
    if (accountId && t.accountId !== accountId) return false;
    if (category && t.category !== category) return false;
    if (flowType && resolve(t, accountIds).flow !== flowType) return false;
    if (needle) {
      const haystack = `${t.merchantName} ${t.originalDescription ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  // Newest first, with id as a stable tiebreak so pagination is deterministic
  // when several transactions share a date.
  matched.sort((a, b) => compareDates(b.postedDate, a.postedDate) || a.id.localeCompare(b.id));

  const offset = cursor ? decodeCursor(cursor) : 0;
  const page = matched.slice(offset, offset + limit);

  return {
    transactions: page.map((t) => {
      const { flow, reason } = resolve(t, accountIds);
      const account = accountById.get(t.accountId);
      const counter = t.counterAccountId ? accountById.get(t.counterAccountId) : undefined;
      return {
        id: t.id,
        postedDate: t.postedDate,
        merchantName: t.merchantName,
        originalDescription: t.originalDescription,
        amountCents: t.amountCents,
        currency: t.currency,
        category: t.category,
        categoryDisplayName: categoryLabel(t.category),
        accountId: t.accountId,
        accountDisplayName: account?.displayName ?? t.accountId,
        institutionName: account?.institutionName ?? "Unknown",
        flowType: flow,
        counterAccountId: t.counterAccountId,
        counterAccountDisplayName: counter?.displayName,
        unclassifiedReason: reason,
        isRecurring: t.recurrenceSignal?.isLikelyRecurring ?? false,
        pending: Boolean(t.authorizedDate && !t.postedDate),
        normalizationUncertaintyCodes: t.normalizationUncertaintyCodes ?? [],
      } satisfies TransactionView;
    }),
    nextCursor: offset + limit < matched.length ? encodeCursor(offset + limit) : undefined,
    totalCount: matched.length,
  };
}

// base64url via btoa/atob rather than Node's Buffer: this module is bundled for
// the browser too (apps/web imports it), where Buffer is undefined. btoa/atob are
// declared by both the DOM lib and @types/node and run in both, and the payload
// is pure ASCII, so this is portable and preserves the exact base64url wire format.
function encodeCursor(offset: number): string {
  const json = JSON.stringify({ o: offset });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): number {
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(base64)) as { o?: number };
    return typeof parsed.o === "number" && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}
