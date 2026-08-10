/**
 * Category budget endpoints — set caps, read progress.
 *
 * Two concerns, kept apart on purpose:
 *   - `/api/v1/budgets` (GET/POST) is the user's *intent* — the caps they set. The
 *     store holds only this. POST replaces the whole set, because the UI edits a
 *     small set as one object and whole-set replace is the simplest correct
 *     semantics (no partial-merge ambiguity). POST (not PUT) keeps this route on
 *     the same small verb set every other mutation in the API uses.
 *   - `/api/v1/budgets/progress` (GET) is *computed*, never stored: it summarises
 *     the user's transactions for a month and runs core `evaluateBudgets` over
 *     that. All arithmetic is in `@ai-fin-os/core`; this layer parses, calls the
 *     domain, and serialises (`CD-003`).
 *
 * Budgets are monthly by design (`D-B2`), so progress is always a month period —
 * a monthly cap shown against a week would mislead. The route does not expose a
 * period kind.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  annotateRecurrenceSignals,
  annotateTransferPairs,
  evaluateBudgets,
  getCategoryMetadata,
  summarizeSpending,
} from "@ai-fin-os/core";
import type { Account, Transaction } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { BudgetStore, BudgetState } from "../local/budget-store";
import type { BudgetStoreProvider } from "../local/budget-store-provider";
import type { StatementImportStore } from "../local/store";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const BUDGETS_PATH = "/api/v1/budgets";
export const BUDGETS_PROGRESS_PATH = "/api/v1/budgets/progress";

/** A limit is integer cents, positive, and bounded well below any real budget so
 *  a fat-fingered or hostile value can't overflow downstream arithmetic. */
const LimitCentsSchema = z
  .number()
  .int()
  .positive()
  .max(1_000_000_000); // $10,000,000 — a monthly cap will never legitimately exceed this.

const BudgetSchema = z.object({
  category: z.string().min(1).max(64),
  limitCents: LimitCentsSchema,
});

const SaveBudgetsSchema = z
  .object({
    currency: z.string().length(3).default("USD"),
    overallLimitCents: LimitCentsSchema.nullable().default(null),
    budgets: z.array(BudgetSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    // One cap per category. Silently collapsing duplicates would let the UI
    // think it saved two limits when only one survived; reject so the mistake is
    // visible.
    const seen = new Set<string>();
    value.budgets.forEach((budget, index) => {
      if (seen.has(budget.category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["budgets", index, "category"],
          message: `Duplicate budget for category "${budget.category}".`,
        });
      }
      seen.add(budget.category);
    });
  });

const ProgressQuerySchema = z.object({
  // Budgets are monthly (`D-B2`). `key` selects which month (e.g. 2026-08);
  // omitted means the month of the latest transaction.
  key: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Expected a month key YYYY-MM")
    .optional(),
  currency: z.string().length(3).default("USD"),
});

function categoryLabel(id: string): string {
  return getCategoryMetadata(id)?.displayName ?? id;
}

/** Same data-derived "now" every other endpoint uses: the latest transaction
 *  date, never the wall clock, so responses are deterministic. */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

type Loaded = { accounts: Account[]; transactions: Transaction[] };

export async function registerBudgetRoutes(
  app: FastifyInstance,
  options: { budgets: BudgetStoreProvider; stores: StatementImportStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  /** Load spending rows with the same two whole-history derivations the spending
   *  screens apply (transfer pairing + recurrence), so a budget's "spent" figure
   *  is identical to the Spending screen's category total for that month. */
  async function loadSpending(store: StatementImportStore, currency: string): Promise<Loaded> {
    const state = await getLocalSpendingState(store, currency);
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

  app.get(BUDGETS_PATH, async (request, reply) => {
    const store = await options.budgets.forUser(principalOf(request).userId);
    return reply.send(await store.load());
  });

  app.post(BUDGETS_PATH, async (request, reply) => {
    const parsed = SaveBudgetsSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "INVALID_BUDGETS", parsed.error.issues);

    const store: BudgetStore = await options.budgets.forUser(principalOf(request).userId);
    const next: BudgetState = {
      currency: parsed.data.currency,
      overallLimitCents: parsed.data.overallLimitCents,
      budgets: parsed.data.budgets,
    };
    return reply.send(await store.save(next));
  });

  app.get(BUDGETS_PROGRESS_PATH, async (request, reply) => {
    const parsed = ProgressQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_BUDGETS_PROGRESS_QUERY", parsed.error.issues);
    const q = parsed.data;

    const userId = principalOf(request).userId;
    const [budgetStore, spendingStore] = await Promise.all([
      options.budgets.forUser(userId),
      options.stores.forUser(userId),
    ]);
    const budgetState = await budgetStore.load();
    const { accounts, transactions } = await loadSpending(spendingStore, q.currency);

    const summary = summarizeSpending({
      transactions,
      accounts,
      currency: q.currency,
      asOfDate: asOfDateFor(transactions),
      kind: "month",
      key: q.key,
      categoryLabel,
    });

    return reply.send(
      evaluateBudgets({
        summary,
        budgets: budgetState.budgets,
        overallLimitCents: budgetState.overallLimitCents,
        categoryLabel,
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
