import { CountryCode, Products } from "plaid";

import type { Account, FinancialSnapshot, Transaction } from "@ai-fin-os/core";
import type {
  AccountsGetResponse,
  InstitutionsGetByIdResponse,
  ItemPublicTokenExchangeResponse,
  LinkTokenCreateRequest,
  LinkTokenCreateResponse,
  Transaction as PlaidTransaction,
  TransactionsGetResponse,
} from "plaid";
import type { PlaidConfig } from "./config";
import { toPlaidAdapterError } from "./errors";
import { mapPlaidAccounts, mapPlaidDataToSnapshot, mapPlaidTransactions } from "./mapper";
import type { PlaidSnapshotMappingOptions } from "./mapper";
import type { PlaidTokenStore } from "./token-store";

export type PlaidClientLike = {
  linkTokenCreate(request: LinkTokenCreateRequest): Promise<{ data: LinkTokenCreateResponse }>;
  itemPublicTokenExchange(request: { public_token: string }): Promise<{ data: ItemPublicTokenExchangeResponse }>;
  accountsBalanceGet(request: { access_token: string }): Promise<{ data: AccountsGetResponse }>;
  /** Optional: resolves a Plaid institution_id to its display name. Absent on the
   *  hand-rolled test clients, so callers must feature-detect before use. */
  institutionsGetById?(request: {
    institution_id: string;
    country_codes: CountryCode[];
  }): Promise<{ data: InstitutionsGetByIdResponse }>;
  transactionsGet(request: {
    access_token: string;
    start_date: string;
    end_date: string;
    options: { count: number; offset: number; include_original_description: boolean };
  }): Promise<{ data: TransactionsGetResponse }>;
};

export type PlaidLinkTokenResult = {
  linkToken: string;
  expiration: string;
  requestId: string;
};

export type PlaidConnectionResult = {
  connectionId: string;
  itemId: string;
  requestId: string;
};

export type PlaidAccountsResult = {
  accounts: Account[];
  institutionName?: string;
  itemId?: string;
  requestId: string;
};

export type PlaidTransactionsResult = {
  transactions: Transaction[];
  rawCount: number;
  pendingExcludedCount: number;
  requestIds: string[];
};

export type PlaidSnapshotResult = {
  snapshot: FinancialSnapshot;
  requestIds: string[];
};

const TRANSACTION_PAGE_SIZE = 500;

export async function createLinkToken(
  client: PlaidClientLike,
  config: PlaidConfig,
  input: { clientUserId?: string } = {},
): Promise<PlaidLinkTokenResult> {
  try {
    const request: LinkTokenCreateRequest = {
      client_name: config.clientName,
      language: "en",
      country_codes: [CountryCode.Us],
      products: [Products.Transactions],
      user: {
        client_user_id: input.clientUserId ?? "sandbox-local-user",
      },
      redirect_uri: config.redirectUri,
      webhook: config.webhook,
    };

    const response = await client.linkTokenCreate(request);

    return {
      linkToken: response.data.link_token,
      expiration: response.data.expiration,
      requestId: response.data.request_id,
    };
  } catch (error) {
    throw toPlaidAdapterError(error, "LINK_TOKEN_CREATE_FAILED");
  }
}

export async function exchangePublicToken(
  client: PlaidClientLike,
  store: PlaidTokenStore,
  publicToken: string,
  userId?: string,
): Promise<PlaidConnectionResult> {
  try {
    const response = await client.itemPublicTokenExchange({ public_token: publicToken });
    const connection = await store.save({
      userId,
      itemId: response.data.item_id,
      accessToken: response.data.access_token,
    });

    return {
      connectionId: connection.connectionId,
      itemId: connection.itemId,
      requestId: response.data.request_id,
    };
  } catch (error) {
    throw toPlaidAdapterError(error, "PUBLIC_TOKEN_EXCHANGE_FAILED");
  }
}

export async function getAccountsAndBalances(
  client: PlaidClientLike,
  accessToken: string,
  syncedAt = new Date(),
): Promise<PlaidAccountsResult> {
  try {
    const response = await client.accountsBalanceGet({ access_token: accessToken });
    const institutionName = await resolveInstitutionName(client, response.data.item.institution_id ?? undefined);
    return {
      accounts: mapPlaidAccounts(response.data.accounts, syncedAt, institutionName),
      institutionName,
      itemId: response.data.item.item_id,
      requestId: response.data.request_id,
    };
  } catch (error) {
    throw toPlaidAdapterError(error, "ACCOUNTS_BALANCE_GET_FAILED");
  }
}

/**
 * Resolve a Plaid institution_id to its display name. Best-effort: returns
 * undefined (so the mapper's placeholder applies) when there is no id, the
 * client can't resolve names, or the lookup fails — name resolution must never
 * break a sync. H-034.
 */
async function resolveInstitutionName(
  client: PlaidClientLike,
  institutionId: string | undefined,
): Promise<string | undefined> {
  if (!institutionId || typeof client.institutionsGetById !== "function") return undefined;
  try {
    const response = await client.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    return response.data.institution.name;
  } catch {
    return undefined;
  }
}

export async function getTransactions(
  client: PlaidClientLike,
  accessToken: string,
  input: { startDate: string; endDate: string; syncedAt?: Date },
): Promise<PlaidTransactionsResult> {
  try {
    const { transactions: rawTransactions, requestIds } = await fetchAllTransactionsRaw(client, accessToken, {
      startDate: input.startDate,
      endDate: input.endDate,
    });

    const transactions = mapPlaidTransactions(rawTransactions, input.syncedAt ?? new Date());

    return {
      transactions,
      rawCount: rawTransactions.length,
      pendingExcludedCount: rawTransactions.length - transactions.length,
      requestIds,
    };
  } catch (error) {
    throw toPlaidAdapterError(error, "TRANSACTIONS_GET_FAILED");
  }
}

/**
 * Page through `/transactions/get` for the whole window, accumulating raw Plaid
 * rows. Two things stop the loop: reaching Plaid's reported total, or a page
 * that comes back empty. The empty-page stop is not just an optimisation — it is
 * the loop's safety rail. `total_transactions` is Plaid's estimate and can be
 * higher than what actually paginates (pending or just-removed items), so a loop
 * that trusted the total alone would keep re-requesting the same offset, get the
 * same empty page, and spin forever. An empty first page ends the fetch the same
 * way instead of looping. Offset advances by rows actually returned, so it never
 * skips or double-reads a page.
 */
async function fetchAllTransactionsRaw(
  client: PlaidClientLike,
  accessToken: string,
  input: { startDate: string; endDate: string },
): Promise<{ transactions: PlaidTransaction[]; requestIds: string[] }> {
  const requestIds: string[] = [];
  const transactions: PlaidTransaction[] = [];
  let offset = 0;

  for (;;) {
    const response = await client.transactionsGet({
      access_token: accessToken,
      start_date: input.startDate,
      end_date: input.endDate,
      options: {
        count: TRANSACTION_PAGE_SIZE,
        offset,
        include_original_description: true,
      },
    });

    requestIds.push(response.data.request_id);
    const page = response.data.transactions;
    transactions.push(...page);
    offset += page.length;

    if (page.length === 0 || transactions.length >= response.data.total_transactions) break;
  }

  return { transactions, requestIds };
}

export async function getCanonicalSnapshot(
  client: PlaidClientLike,
  accessToken: string,
  options: PlaidSnapshotMappingOptions & { startDate: string; endDate: string },
): Promise<PlaidSnapshotResult> {
  const syncedAt = new Date();
  const [accountsResult, transactionsResult] = await Promise.all([
    getRawAccountsAndBalances(client, accessToken),
    getRawTransactions(client, accessToken, {
      startDate: options.startDate,
      endDate: options.endDate,
    }),
  ]);

  return {
    snapshot: mapPlaidDataToSnapshot({
      accounts: accountsResult.accounts,
      transactions: transactionsResult.transactions,
      syncedAt,
      options: {
        ...options,
        transactionsCompleteFromDate: options.startDate,
      },
    }),
    requestIds: [accountsResult.requestId, ...transactionsResult.requestIds],
  };
}

async function getRawAccountsAndBalances(
  client: PlaidClientLike,
  accessToken: string,
): Promise<{ accounts: AccountsGetResponse["accounts"]; requestId: string }> {
  try {
    const response = await client.accountsBalanceGet({ access_token: accessToken });
    return { accounts: response.data.accounts, requestId: response.data.request_id };
  } catch (error) {
    throw toPlaidAdapterError(error, "ACCOUNTS_BALANCE_GET_FAILED");
  }
}

async function getRawTransactions(
  client: PlaidClientLike,
  accessToken: string,
  input: { startDate: string; endDate: string },
): Promise<{ transactions: PlaidTransaction[]; requestIds: string[] }> {
  try {
    return await fetchAllTransactionsRaw(client, accessToken, input);
  } catch (error) {
    throw toPlaidAdapterError(error, "TRANSACTIONS_GET_FAILED");
  }
}
