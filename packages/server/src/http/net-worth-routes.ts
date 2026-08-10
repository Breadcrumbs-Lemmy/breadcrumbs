/**
 * Net-worth trend endpoint.
 *
 * `GET /api/v1/net-worth/trend?currency=USD` returns the month-by-month cash
 * net-worth line (see `docs/net-worth.md`). Thin, like the other read routes:
 * it loads the user's accounts + transactions and stored snapshots, calls the
 * core domain for every figure (`CD-011` — the browser does no arithmetic), and
 * serialises.
 *
 * Capture-on-read (D-N4): the app has no background job, so the one moment code
 * runs is an HTTP request. On each read this route records today's true net
 * worth into the per-user snapshot store, keyed by observation date, so a month
 * that is back-cast today becomes an exact *recorded* point when it is read back
 * later. The upsert is idempotent per calendar day and invisible to the response
 * body. A `GET` keeps this CORS-safe — no new write verb, no allowlist change.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  buildNetWorthTrend,
  currentNetWorthObservation,
  DEFAULT_NET_WORTH_MONTHS,
} from "@ai-fin-os/core";
import type { Transaction } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { StatementImportStoreProvider } from "../local/store-provider";
import type { NetWorthSnapshotStoreProvider } from "../local/net-worth-store-provider";
import { registerSafeErrorHandler } from "./errors";

export const NET_WORTH_TREND_PATH = "/api/v1/net-worth/trend";

const TrendQuerySchema = z.object({
  currency: z.string().length(3).default("USD"),
  months: z.coerce.number().int().min(2).max(120).default(DEFAULT_NET_WORTH_MONTHS),
});

/** Data-derived "now": the latest transaction date, never the wall clock, so the
 *  response is deterministic and fixtures never look empty (matches
 *  `spending-routes.asOfDateFor`). */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

export async function registerNetWorthRoutes(
  app: FastifyInstance,
  options: { stores: StatementImportStoreProvider; snapshots: NetWorthSnapshotStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  app.get(NET_WORTH_TREND_PATH, async (request, reply) => {
    const parsed = TrendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "INVALID_NET_WORTH_QUERY", issues: parsed.error.issues } });
    }
    const { currency, months } = parsed.data;

    const userId = principalOf(request).userId;
    const store = await options.stores.forUser(userId);
    const { accounts, transactions } = await getLocalSpendingState(store, currency);
    const asOfDate = asOfDateFor(transactions);

    // Capture-on-read: record today's measured net worth before building the
    // trend, so this exact point is a recorded (not reconstructed) value on every
    // future read. Idempotent per observation date. Skipped when there is nothing
    // to trend (no cash/debt accounts in this currency), so no empty rows accrue.
    const snapshotStore = await options.snapshots.forUser(userId);
    const observation = currentNetWorthObservation({ accounts, currency, asOfDate });
    if (observation) await snapshotStore.upsert(observation);

    const snapshots = await snapshotStore.list(currency);
    const trend = buildNetWorthTrend({
      accounts,
      transactions,
      snapshots,
      currency,
      asOfDate,
      maxMonths: months,
    });

    return reply.send(trend);
  });
}
