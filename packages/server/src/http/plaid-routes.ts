/**
 * Plaid endpoints — connect a real bank, then pull its accounts and history.
 *
 * Every route here is scoped to the authenticated caller. A connection records
 * the user who created it (`connection.userId`), and each handler checks the
 * caller against it before returning anything, so a guessed `connectionId`
 * cannot read another person's bank. In single-user mode the caller is always
 * the owner, so this is invisible; in multi-user mode it is the boundary.
 *
 * `sync` is the one that matters day to day: it fetches accounts and
 * transactions from Plaid and writes them into the *same* per-user statement
 * store the CSV importer uses, deduping by transaction id. After a sync the
 * spending, transactions, and insights screens light up with real bank data
 * with no further wiring — a Plaid transaction and a hand-imported one are the
 * same shape by the time they reach the store.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Account, Transaction } from "@ai-fin-os/core";

import {
  createLinkToken,
  exchangePublicToken,
  getAccountsAndBalances,
  getCanonicalSnapshot,
  getTransactions,
  syncTransactions,
} from "../plaid/adapter";
import type { PlaidClientLike } from "../plaid/adapter";
import type { PlaidConfig } from "../plaid/config";
import type { PlaidTokenStore, StoredPlaidConnection } from "../plaid/token-store";
import { OWNER_USER_ID } from "../auth/types";
import { authErrors } from "../auth/errors";
import type { StatementImportStore } from "../local/store";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { principalOf } from "../auth/middleware";
import { registerSafeErrorHandler } from "./errors";

/**
 * How long a session's cleared TOTP challenge is honoured before Plaid Link
 * demands a fresh code. Long enough to enroll-then-connect in one sitting,
 * short enough that a walked-away-from session cannot reach Link indefinitely.
 */
const MFA_STEPUP_WINDOW_MS = 15 * 60 * 1000;

const LinkTokenBodySchema = z.object({
  clientUserId: z.string().min(1).max(128).optional(),
});

const ExchangeBodySchema = z.object({
  publicToken: z.string().min(1),
});

const ConnectionParamsSchema = z.object({
  connectionId: z.string().min(1),
});

/**
 * A boolean carried in a query string. `z.coerce.boolean()` is wrong for this:
 * it applies JS truthiness, so the string "false" (and every other non-empty
 * string) becomes `true`. These flags gate affordability decisions, so a caller
 * passing `?balancesDeclaredComplete=false` must read as false, not true.
 */
const QueryBooleanSchema = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const DateRangeQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const SnapshotQuerySchema = DateRangeQuerySchema.extend({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).default("America/Chicago"),
  currency: z.string().length(3).default("USD"),
  balancesDeclaredComplete: QueryBooleanSchema.optional(),
  userConfirmedNoOtherRequiredObligations: QueryBooleanSchema.optional(),
});

export type RegisterPlaidRoutesOptions = {
  client: PlaidClientLike;
  config: PlaidConfig;
  tokenStore: PlaidTokenStore;
  /** Where a sync writes the fetched bank data. Optional so the Plaid routes can
   *  be tested in isolation without a full store; sync 501s when it is absent. */
  stores?: StatementImportStoreProvider;
};

export async function registerPlaidRoutes(app: FastifyInstance, options: RegisterPlaidRoutesOptions): Promise<void> {
  /** The authenticated caller. The global auth hook guarantees `principal` on
   *  every `/api` request in multi-user mode (or 401s first); the owner fallback
   *  covers single-user mode and isolated tests with no hook attached. */
  const callerId = (request: Parameters<typeof principalOf>[0]): string =>
    request.principal?.userId ?? OWNER_USER_ID;

  /**
   * Gate Plaid Link on a recently-cleared second factor. Enforced only for a
   * real multi-user session: single-user mode's owner principal (`owner: true`)
   * and route-only tests with no principal skip it, since there is no login to
   * add a factor to. A logged-in user with no enabled factor is told to enroll;
   * one whose step-up has gone stale is told to re-challenge. Both are 403s the
   * web client branches on to show the right prompt before Link ever opens.
   */
  function requireMfaForPlaid(request: Parameters<typeof principalOf>[0]): void {
    const principal = request.principal;
    if (!principal || principal.owner) return;
    if (!principal.mfaEnabled) throw authErrors.mfaEnrollmentRequired();
    const verifiedAt = principal.mfaVerifiedAt ?? 0;
    if (Date.now() - verifiedAt > MFA_STEPUP_WINDOW_MS) throw authErrors.mfaRequired();
  }

  /** Load the caller's connection, or reply 404 — the same 404 whether it does
   *  not exist or belongs to someone else, so the routes never confirm the
   *  existence of another user's connection. */
  async function ownedConnection(
    request: Parameters<typeof principalOf>[0],
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    connectionId: string,
  ): Promise<StoredPlaidConnection | undefined> {
    const connection = await options.tokenStore.get(connectionId);
    if (!connection || connection.userId !== callerId(request)) {
      reply.code(404).send({ error: { code: "PLAID_CONNECTION_NOT_FOUND" } });
      return undefined;
    }
    return connection;
  }

  app.post("/api/plaid/link-token", async (request) => {
    // MFA gate: refuse to even mint a Link token until the session has cleared a
    // second factor. Failing here keeps Plaid's own UI from ever opening for an
    // unverified caller.
    requireMfaForPlaid(request);
    const body = LinkTokenBodySchema.parse(request.body ?? {});
    // Default the Plaid client_user_id to the caller so Plaid's own records line
    // up with ours; an explicit clientUserId still wins.
    return createLinkToken(options.client, options.config, {
      clientUserId: body.clientUserId ?? callerId(request),
    });
  });

  app.post("/api/plaid/exchange-public-token", async (request) => {
    // Gate the exchange too, not just the token mint: a client that skipped the
    // link-token call (or replayed an old public token) still cannot attach a
    // bank without a fresh second factor.
    requireMfaForPlaid(request);
    const body = ExchangeBodySchema.parse(request.body);
    return exchangePublicToken(options.client, options.tokenStore, body.publicToken, callerId(request));
  });

  app.get("/api/plaid/connections", async (request) => {
    const connections = await options.tokenStore.listForUser(callerId(request));
    // Never leak the access token to the browser — it is the bearer of the bank
    // itself. The UI only needs enough to list and act on a connection.
    return {
      connections: connections.map((c) => ({
        connectionId: c.connectionId,
        itemId: c.itemId,
        institutionName: c.institutionName ?? null,
        createdAt: c.createdAt,
        lastSyncedAt: c.lastSyncedAt ?? null,
      })),
    };
  });

  app.get("/api/plaid/connections/:connectionId/accounts", async (request, reply) => {
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const connection = await ownedConnection(request, reply, connectionId);
    if (!connection) return reply;
    return getAccountsAndBalances(options.client, connection.accessToken);
  });

  app.get("/api/plaid/connections/:connectionId/transactions", async (request, reply) => {
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const query = DateRangeQuerySchema.parse(request.query);
    const connection = await ownedConnection(request, reply, connectionId);
    if (!connection) return reply;
    return getTransactions(options.client, connection.accessToken, query);
  });

  app.get("/api/plaid/connections/:connectionId/snapshot", async (request, reply) => {
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const query = SnapshotQuerySchema.parse(request.query);
    const connection = await ownedConnection(request, reply, connectionId);
    if (!connection) return reply;

    return getCanonicalSnapshot(options.client, connection.accessToken, {
      ...query,
      asOfDate: query.asOfDate ?? query.endDate,
    });
  });

  /**
   * Pull the bank's latest accounts + transaction delta into the caller's
   * statement store. This is what turns a fresh connection into visible spending
   * and keeps it current. Cursor-based (`/transactions/sync`): the first sync
   * pulls full history, every later sync resumes from the stored cursor and
   * applies only what changed — new rows added, corrected rows upserted, dropped
   * rows removed. Idempotent by construction, so a redundant sync is a cheap
   * no-op that advances the cursor.
   */
  app.post("/api/plaid/connections/:connectionId/sync", async (request, reply) => {
    if (!options.stores) {
      return reply.code(501).send({ error: { code: "SYNC_STORE_UNAVAILABLE" } });
    }
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const connection = await ownedConnection(request, reply, connectionId);
    if (!connection) return reply;

    const [accountsResult, syncResult] = await Promise.all([
      getAccountsAndBalances(options.client, connection.accessToken),
      syncTransactions(options.client, connection.accessToken, { cursor: connection.transactionsCursor }),
    ]);

    const store = await options.stores.forUser(callerId(request));
    const summary = await syncIntoStore(store, {
      connectionId,
      accounts: accountsResult.accounts,
      added: syncResult.added,
      modified: syncResult.modified,
      removedIds: syncResult.removedIds,
    });

    const syncedAt = new Date().toISOString();
    // Persist the advanced cursor together with the sync time, so the next sync
    // resumes exactly here and never re-pulls what we just applied.
    await options.tokenStore.markSynced(connectionId, syncedAt, syncResult.nextCursor);

    return {
      connectionId,
      syncedAt,
      accountsSynced: accountsResult.accounts.length,
      // `synced` is the headline count the UI shows (rows new or changed).
      synced: summary.added + summary.modified,
      transactionsAdded: summary.added,
      transactionsModified: summary.modified,
      transactionsRemoved: summary.removed,
      transactionsDuplicate: summary.duplicate,
    };
  });

  app.delete("/api/plaid/connections/:connectionId", async (request, reply) => {
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const connection = await ownedConnection(request, reply, connectionId);
    if (!connection) return reply;
    await options.tokenStore.delete(connectionId);
    return { ok: true, connectionId };
  });

  registerSafeErrorHandler(app);
}

/**
 * Write one connection's sync delta into the store, one account at a time
 * (`saveImport` upserts a single account and applies its rows). Every balance
 * account is written even with no transactions, so its balance still appears.
 *
 * `added` and `modified` carry an account id, so they are grouped per account.
 * A `/transactions/sync` `removed` entry carries only a transaction id (Plaid
 * does not say which account), and the store deletes globally by id — so the
 * removals ride on the first account's write. Every live connection has at least
 * one balance account here, so removals are never dropped.
 */
async function syncIntoStore(
  store: StatementImportStore,
  input: { connectionId: string; accounts: Account[]; added: Transaction[]; modified: Transaction[]; removedIds: string[] },
): Promise<{ added: number; modified: number; removed: number; duplicate: number }> {
  const addedByAccount = groupByAccount(input.added);
  const modifiedByAccount = groupByAccount(input.modified);

  const createdAt = new Date().toISOString();
  let added = 0;
  let modified = 0;
  let removed = 0;
  let duplicate = 0;

  let firstAccount = true;
  for (const account of input.accounts) {
    const accountAdded = addedByAccount.get(account.id) ?? [];
    const accountModified = modifiedByAccount.get(account.id) ?? [];
    const result = await store.saveImport({
      account,
      transactions: accountAdded,
      modifiedTransactions: accountModified,
      // Removals are id-keyed and global; attach them once, to the first write.
      removedTransactionIds: firstAccount ? input.removedIds : [],
      batch: {
        id: `plaid_${input.connectionId}_${account.id}_${createdAt}`,
        accountId: account.id,
        sourceFormat: "plaid",
        createdAt,
        rowCount: accountAdded.length + accountModified.length,
        invalidRowCount: 0,
        rawCsvStored: false,
      },
    });
    added += result.importedTransactions.length;
    duplicate += result.duplicateTransactions.length;
    modified += result.modifiedTransactions.length;
    removed += result.removedTransactionIds.length;
    firstAccount = false;
  }

  return { added, modified, removed, duplicate };
}

/** Group transactions by their account id, preserving order within each group. */
function groupByAccount(transactions: Transaction[]): Map<string, Transaction[]> {
  const byAccount = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const list = byAccount.get(transaction.accountId) ?? [];
    list.push(transaction);
    byAccount.set(transaction.accountId, list);
  }
  return byAccount;
}
