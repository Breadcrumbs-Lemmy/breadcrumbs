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
import { createCachingKeyFetcher, verifyPlaidWebhook } from "../plaid/webhook";
import { OWNER_USER_ID } from "../auth/types";
import { authErrors } from "../auth/errors";
import type { StatementImportStore } from "../local/store";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { principalOf } from "../auth/middleware";
import { registerSafeErrorHandler } from "./errors";

/** Plaid `TRANSACTIONS` webhook codes that mean "there is a delta to pull". Each
 *  is handled the same way — run a cursor sync, which is idempotent — so a spare
 *  or duplicate delivery is a cheap no-op. */
const TRANSACTIONS_SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "DEFAULT_UPDATE",
]);

/** The shape we read off a verified Plaid webhook body. Everything else Plaid
 *  sends is ignored; these four fields drive the dispatch. */
type PlaidWebhookBody = {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string } | null;
};

/** Fastify hangs the raw request text here (see the webhook's content-type
 *  parser) so the body hash can be checked against Plaid's signature. */
type RawBodyRequest = { rawBody?: string };

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
        coverageStart: c.coverageStart ?? null,
        coverageEnd: c.coverageEnd ?? null,
        // Lets the UI prompt "reconnect this bank" without exposing why.
        reauthRequired: c.reauthRequired ?? false,
      })),
    };
  });

  app.get("/api/plaid/coverage", async (request) => {
    const connections = await options.tokenStore.listForUser(callerId(request));
    let earliest: string | null = null;
    let latest: string | null = null;
    for (const c of connections) {
      if (c.coverageStart && (earliest === null || c.coverageStart < earliest)) earliest = c.coverageStart;
      if (c.coverageEnd && (latest === null || c.coverageEnd > latest)) latest = c.coverageEnd;
    }
    const today = isoDate(new Date());
    // Plaid transactionsGet reaches ~24 months back for most institutions.
    const floor = isoDate(new Date(Date.now() - 730 * 24 * 60 * 60 * 1000));
    return {
      earliestSynced: earliest,
      latestSynced: latest,
      floor,
      today,
      connections: connections.map((c) => ({
        connectionId: c.connectionId,
        institutionName: c.institutionName ?? null,
        coverageStart: c.coverageStart ?? null,
        coverageEnd: c.coverageEnd ?? null,
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

    const store = await options.stores.forUser(callerId(request));
    const result = await runConnectionSync(options.client, options.tokenStore, store, connection);

    return {
      connectionId,
      syncedAt: result.syncedAt,
      accountsSynced: result.accountsSynced,
      // `synced` is the headline count the UI shows (rows new or changed).
      synced: result.added + result.modified,
      transactionsAdded: result.added,
      transactionsModified: result.modified,
      transactionsRemoved: result.removed,
      transactionsDuplicate: result.duplicate,
      // Coverage bounds after this sync, so the caller can refresh the rail
      // without a second round-trip to /coverage.
      coverage: { start: result.coverageStart, end: result.coverageEnd },
    };
  });

  /**
   * Inbound Plaid webhooks. Public and machine-to-machine: no session rides on
   * it, so trust comes entirely from the signature check below (the path is on
   * the auth allowlist for that reason). It lives in its own encapsulated scope
   * because it needs the *raw* request body to verify Plaid's body hash — the
   * content-type parser here keeps that raw text, and being encapsulated means it
   * never changes how any other route parses JSON.
   */
  const fetchWebhookKey = createCachingKeyFetcher({
    async webhookVerificationKeyGet(request) {
      if (typeof options.client.webhookVerificationKeyGet !== "function") {
        throw new Error("Plaid client cannot fetch webhook verification keys.");
      }
      return options.client.webhookVerificationKeyGet(request);
    },
  });

  // Not awaited on purpose: awaiting boots the instance, which would freeze the
  // error handler registered at the end of this function out (Fastify refuses
  // `setErrorHandler` once ready). Fastify loads this encapsulated plugin at
  // `ready()`/first-request time either way.
  void app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      (request as unknown as RawBodyRequest).rawBody = raw;
      try {
        done(null, raw.length > 0 ? JSON.parse(raw) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    webhookScope.post("/api/plaid/webhook", async (request, reply) => {
      const rawBody = (request as unknown as RawBodyRequest).rawBody ?? "";
      const signedJwt = request.headers["plaid-verification"];
      // One opaque 400 for every failure — a missing header, a bad signature, a
      // tampered body — so a prober learns nothing about which check it tripped.
      if (typeof signedJwt !== "string" || signedJwt.length === 0) {
        return reply.code(400).send({ error: { code: "PLAID_WEBHOOK_UNVERIFIED" } });
      }
      try {
        await verifyPlaidWebhook({ signedJwt, rawBody, fetchKey: fetchWebhookKey });
      } catch {
        return reply.code(400).send({ error: { code: "PLAID_WEBHOOK_UNVERIFIED" } });
      }

      await handlePlaidWebhook((request.body ?? {}) as PlaidWebhookBody);
      // Plaid retries any non-2xx, so once verified we always ack — even a
      // no-op code — to stop it re-delivering something already handled.
      return { received: true };
    });
  });

  /**
   * Act on a verified webhook. A `TRANSACTIONS` delta triggers the same cursor
   * sync the manual route runs (idempotent, so a redundant delivery is cheap); an
   * `ITEM_LOGIN_REQUIRED`-class event flags the connection for re-auth, and a
   * repair clears it. Everything else is acknowledged without action.
   */
  async function handlePlaidWebhook(body: PlaidWebhookBody): Promise<void> {
    const itemId = body.item_id;
    if (!itemId) return;
    const connections = await options.tokenStore.listByItemId(itemId);
    if (connections.length === 0) return;

    if (body.webhook_type === "TRANSACTIONS" && body.webhook_code && TRANSACTIONS_SYNC_CODES.has(body.webhook_code)) {
      // No store wired (isolated route tests) means nowhere to write the delta —
      // ack without syncing rather than 500.
      if (!options.stores) return;
      for (const connection of connections) {
        const store = await options.stores.forUser(connection.userId);
        await runConnectionSync(options.client, options.tokenStore, store, connection);
      }
      return;
    }

    if (body.webhook_type === "ITEM") {
      if (isReauthSignal(body)) {
        await Promise.all(connections.map((c) => options.tokenStore.setReauthRequired(c.connectionId, true)));
      } else if (body.webhook_code === "LOGIN_REPAIRED") {
        await Promise.all(connections.map((c) => options.tokenStore.setReauthRequired(c.connectionId, false)));
      }
    }
  }

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
 * Pull one connection's latest accounts + transaction delta and apply it. Shared
 * by the manual sync route and the webhook receiver so both advance the cursor,
 * write the same store, and clear a stale re-auth flag identically — there is one
 * definition of "sync a connection", not two that can drift.
 *
 * The same pass also maintains the connection's coverage bounds, which drive the
 * spending-calendar rail. `/transactions/sync` always drains to the present, so a
 * successful sync means we hold every transaction through today — coverageEnd
 * advances to the sync date. coverageStart takes the earliest posted date this
 * sync applied (on the first sync that is the full-history floor); the store
 * unions it, so it only ever widens.
 */
async function runConnectionSync(
  client: PlaidClientLike,
  tokenStore: PlaidTokenStore,
  store: StatementImportStore,
  connection: StoredPlaidConnection,
): Promise<{
  syncedAt: string;
  accountsSynced: number;
  added: number;
  modified: number;
  removed: number;
  duplicate: number;
  coverageStart: string | null;
  coverageEnd: string | null;
}> {
  const [accountsResult, syncResult] = await Promise.all([
    getAccountsAndBalances(client, connection.accessToken),
    syncTransactions(client, connection.accessToken, { cursor: connection.transactionsCursor }),
  ]);

  const summary = await syncIntoStore(store, {
    connectionId: connection.connectionId,
    accounts: accountsResult.accounts,
    added: syncResult.added,
    modified: syncResult.modified,
    removedIds: syncResult.removedIds,
  });

  const syncedAt = new Date().toISOString();
  // Earliest posted date across everything this sync applied. On the first sync
  // (full history) that is the true floor of available data; on a later delta it
  // is just the new/changed rows, or nothing when the delta was empty.
  const observedStart = earliestPostedDate([...syncResult.added, ...syncResult.modified]);
  // Cursor sync drains to the present, so we are complete through today — advance
  // coverageEnd to the sync date even when the delta added nothing.
  const coverage = { start: observedStart, end: isoDate(new Date(syncedAt)) };
  // Persist the advanced cursor together with the sync time and coverage, so the
  // next sync resumes exactly here and the calendar rail stays accurate. markSynced
  // also clears any re-auth flag — a sync that succeeded is proof the login works.
  await tokenStore.markSynced(connection.connectionId, syncedAt, { cursor: syncResult.nextCursor, coverage });
  const updated = await tokenStore.get(connection.connectionId);

  return {
    syncedAt,
    accountsSynced: accountsResult.accounts.length,
    ...summary,
    coverageStart: updated?.coverageStart ?? null,
    coverageEnd: updated?.coverageEnd ?? null,
  };
}

/** The earliest `postedDate` (YYYY-MM-DD) among a set of transactions, or
 *  `undefined` when the set is empty. Dates are ISO strings, so a lexical min is
 *  a chronological min. */
function earliestPostedDate(transactions: Transaction[]): string | undefined {
  let earliest: string | undefined;
  for (const t of transactions) {
    if (t.postedDate && (earliest === undefined || t.postedDate < earliest)) earliest = t.postedDate;
  }
  return earliest;
}

/** Format a Date as a `YYYY-MM-DD` UTC day stamp. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** True when an `ITEM` webhook means the bank login is broken and needs Link to
 *  repair it — either the dedicated `PENDING_EXPIRATION` code, or an `ERROR`
 *  carrying `ITEM_LOGIN_REQUIRED`. */
function isReauthSignal(body: PlaidWebhookBody): boolean {
  if (body.webhook_code === "PENDING_EXPIRATION") return true;
  return body.webhook_code === "ERROR" && body.error?.error_code === "ITEM_LOGIN_REQUIRED";
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
