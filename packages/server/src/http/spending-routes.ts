/**
 * Spending, transactions, insights, and accounts endpoints.
 *
 * Implements the payloads in `docs/ui-api-contract.md`, which was written by
 * working backwards from designed screens. Every field returned here exists
 * because something on a screen renders it.
 *
 * These routes are thin. All calculation lives in `@ai-fin-os/core`; this layer
 * parses query parameters, calls the domain, and serialises. If a handler ever
 * needs arithmetic, the arithmetic belongs in core.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  annotateRecurrenceSignals,
  annotateTransferPairs,
  buildAccountsView,
  detectInsights,
  getCategoryMetadata,
  queryTransactions,
  spendingSeries,
  summarizeSpending,
} from "@ai-fin-os/core";
import type { Account, FlowType, Transaction } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { StatementImportStore } from "../local/store";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const SPENDING_SUMMARY_PATH = "/api/v1/spending/summary";
export const SPENDING_SERIES_PATH = "/api/v1/spending/series";
export const TRANSACTIONS_PATH = "/api/v1/transactions";
export const INSIGHTS_PATH = "/api/v1/insights";
export const ACCOUNTS_PATH = "/api/v1/accounts";

const PeriodKindSchema = z.enum(["week", "month", "year", "statement"]);
const CalendarKindSchema = z.enum(["week", "month", "year"]);

/** Calendar-date bound (`YYYY-MM-DD`). Transaction dates are stored as ISO date
 *  strings, so a filter must be the same shape or it silently matches nothing. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const SummaryQuerySchema = z.object({
  period: PeriodKindSchema.default("month"),
  key: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  currency: z.string().length(3).default("USD"),
  baselineCount: z.coerce.number().int().min(1).max(12).default(3),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});

const SeriesQuerySchema = z.object({
  period: CalendarKindSchema.default("month"),
  count: z.coerce.number().int().min(2).max(36).default(12),
  currency: z.string().length(3).default("USD"),
});

const TransactionsQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  accountId: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  flowType: z
    .enum(["SPEND", "INCOME", "TRANSFER_OUT", "TRANSFER_IN", "REFUND", "FEE", "UNCLASSIFIED"])
    .optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  currency: z.string().length(3).default("USD"),
});

const InsightsQuerySchema = z.object({
  period: CalendarKindSchema.default("month"),
  key: z.string().min(1).optional(),
  currency: z.string().length(3).default("USD"),
});

const AccountsQuerySchema = z.object({
  currency: z.string().length(3).default("USD"),
});

/** Category display labels come from the shared taxonomy so UI and API cannot
 *  drift on naming. */
function categoryLabel(id: string): string {
  return getCategoryMetadata(id)?.displayName ?? id;
}

/**
 * `asOfDate` is derived from the data, not the wall clock.
 *
 * Using `new Date()` would make every response non-deterministic and would
 * make a fixture-backed demo show empty periods whenever the fixture is older
 * than today. The latest transaction is the honest "now" for a dataset.
 */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

type Loaded = { accounts: Account[]; transactions: Transaction[] };

export async function registerSpendingRoutes(
  app: FastifyInstance,
  options: { stores: StatementImportStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  async function load(store: StatementImportStore, currency: string): Promise<Loaded> {
    const state = await getLocalSpendingState(store, currency);
    // Two derivations that cannot be stamped at import time, applied once here so
    // every screen sees the same rows:
    //   - Transfer pairing. An offsetting pair only exists once both accounts'
    //     rows are in the store, so `counterAccountId`/`transferMatchConfidence`
    //     are derived from the whole set. Without this the Spending summary
    //     (which pairs internally) disagreed with the Transactions and Insights
    //     screens, where an inter-account transfer stayed `UNCLASSIFIED`.
    //   - Recurrence. A subscription is a property of a series, not a single
    //     charge, so `recurrenceSignal` is derived from the full history. Without
    //     it the subscriptions panel reads zero over data that plainly contains
    //     subscriptions.
    return {
      accounts: state.accounts,
      transactions: annotateRecurrenceSignals({
        transactions: annotateTransferPairs({
          transactions: state.transactions,
          accounts: state.accounts,
        }),
        accounts: state.accounts,
        currency,
      }),
    };
  }

  app.get(SPENDING_SUMMARY_PATH, async (request, reply) => {
    const parsed = SummaryQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_SPENDING_QUERY", parsed.error.issues);
    const q = parsed.data;

    // Span validation: both from/to must be supplied together, and start <= end.
    const hasFrom = q.from !== undefined;
    const hasTo = q.to !== undefined;
    if (hasFrom !== hasTo) {
      return badRequest(reply, "SPAN_REQUIRES_BOTH_DATES", [
        { path: ["from", "to"], message: "Both 'from' and 'to' are required to define a span." },
      ]);
    }
    if (hasFrom && hasTo && q.from! > q.to!) {
      return badRequest(reply, "SPAN_START_AFTER_END", [
        { path: ["from"], message: "'from' must not be after 'to'." },
      ]);
    }

    const isSpanRequest = hasFrom && hasTo;

    // The statement-period guard only applies when no explicit span is given;
    // a span overrides period-based bucketing entirely.
    if (!isSpanRequest && q.period === "statement" && !q.accountId) {
      return badRequest(reply, "ACCOUNT_ID_REQUIRED_FOR_STATEMENT", [
        { path: ["accountId"], message: "A statement period is specific to one card." },
      ]);
    }

    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);
    return reply.send(
      summarizeSpending({
        transactions,
        accounts,
        currency: q.currency,
        asOfDate: asOfDateFor(transactions),
        kind: q.period,
        key: q.key,
        accountId: q.accountId,
        baselineCount: q.baselineCount,
        categoryLabel,
        ...(isSpanRequest ? { span: { startDate: q.from!, endDate: q.to! } } : {}),
      }),
    );
  });

  app.get(SPENDING_SERIES_PATH, async (request, reply) => {
    const parsed = SeriesQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_SERIES_QUERY", parsed.error.issues);
    const q = parsed.data;
    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);
    return reply.send(
      spendingSeries({
        transactions,
        accounts,
        currency: q.currency,
        asOfDate: asOfDateFor(transactions),
        kind: q.period,
        count: q.count,
        categoryLabel,
      }),
    );
  });

  app.get(TRANSACTIONS_PATH, async (request, reply) => {
    const parsed = TransactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_TRANSACTIONS_QUERY", parsed.error.issues);
    const q = parsed.data;
    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);
    return reply.send(
      queryTransactions({
        transactions,
        accounts,
        currency: q.currency,
        from: q.from,
        to: q.to,
        accountId: q.accountId,
        category: q.category,
        flowType: q.flowType as FlowType | undefined,
        search: q.search,
        cursor: q.cursor,
        limit: q.limit,
        categoryLabel,
      }),
    );
  });

  app.get(INSIGHTS_PATH, async (request, reply) => {
    const parsed = InsightsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_INSIGHTS_QUERY", parsed.error.issues);
    const q = parsed.data;
    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);
    return reply.send(
      detectInsights({
        transactions,
        accounts,
        currency: q.currency,
        asOfDate: asOfDateFor(transactions),
        kind: q.period,
        key: q.key,
        categoryLabel,
      }),
    );
  });

  app.get(ACCOUNTS_PATH, async (request, reply) => {
    const parsed = AccountsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_ACCOUNTS_QUERY", parsed.error.issues);
    const q = parsed.data;
    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);
    return reply.send(
      buildAccountsView({
        accounts,
        transactions,
        currency: q.currency,
        asOfDate: asOfDateFor(transactions),
      }),
    );
  });
}

function badRequest(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  code: string,
  issues: unknown[],
) {
  return reply.status(400).send({ error: { code, issues } });
}
