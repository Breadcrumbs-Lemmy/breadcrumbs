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
 *     the user's transactions for one window (a week or a month, per `?period=`)
 *     and runs core `evaluateBudgets` over that. All arithmetic is in
 *     `@ai-fin-os/core`; this layer parses, calls the domain, and serialises
 *     (`CD-003`).
 *
 * A cap governs one window (`D-B2`): progress for `?period=month` scores monthly
 * caps against a month, `?period=week` scores weekly caps against an ISO week. A
 * monthly cap shown against a week (or vice versa) would mislead, so core filters
 * caps by the summary's period kind and the route passes the window-appropriate
 * overall cap.
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

/** Which window a cap governs. Omitted on input means `"month"` — the v1 default
 *  — so a client that predates weekly caps keeps working unchanged. */
const BudgetPeriodSchema = z.enum(["week", "month"]).default("month");

const BudgetSchema = z.object({
  category: z.string().min(1).max(64),
  limitCents: LimitCentsSchema,
  period: BudgetPeriodSchema,
});

const SaveBudgetsSchema = z
  .object({
    currency: z.string().length(3).default("USD"),
    overallLimitCents: LimitCentsSchema.nullable().default(null),
    overallWeeklyLimitCents: LimitCentsSchema.nullable().default(null),
    budgets: z.array(BudgetSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    // One cap per (window, category): a category may hold one weekly cap and one
    // monthly cap, but not two of either. Silently collapsing duplicates would
    // let the UI think it saved two limits when only one survived; reject so the
    // mistake is visible.
    const seen = new Set<string>();
    value.budgets.forEach((budget, index) => {
      const key = `${budget.period}:${budget.category}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["budgets", index, "category"],
          message: `Duplicate ${budget.period} budget for category "${budget.category}".`,
        });
      }
      seen.add(key);
    });
  });

const ProgressQuerySchema = z
  .object({
    // Which window to score (`D-B2`). `key` selects which one: a month key
    // (2026-08) for `period=month`, an ISO-week key (2026-W32) for `period=week`.
    // Omitted `key` means the window containing the latest transaction.
    period: BudgetPeriodSchema,
    key: z.string().optional(),
    currency: z.string().length(3).default("USD"),
  })
  .superRefine((value, ctx) => {
    if (value.key === undefined) return;
    const expected = value.period === "week" ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/;
    if (!expected.test(value.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message:
          value.period === "week"
            ? "Expected an ISO week key YYYY-Www"
            : "Expected a month key YYYY-MM",
      });
    }
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
      overallWeeklyLimitCents: parsed.data.overallWeeklyLimitCents,
      // The store normalises: a monthly cap is stored without a `period` field
      // (unchanged on-disk shape), a weekly cap keeps `period: "week"`.
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
      kind: q.period,
      key: q.key,
      categoryLabel,
    });

    // Core filters `budgets` to the summary's window, so weekly and monthly caps
    // can coexist; the route only has to pick the overall cap for this window.
    const overallLimitCents =
      q.period === "week" ? budgetState.overallWeeklyLimitCents : budgetState.overallLimitCents;

    return reply.send(
      evaluateBudgets({
        summary,
        budgets: budgetState.budgets,
        overallLimitCents,
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
