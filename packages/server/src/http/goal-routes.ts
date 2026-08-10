/**
 * Savings-goal endpoints — set goals, read progress.
 *
 * Two concerns, kept apart on purpose:
 *   - `/api/v1/goals` (GET/POST) is the user's *intent* — the savings targets they
 *     declared. The store holds only this. POST replaces the whole set, because
 *     the UI edits a small set as one object and whole-set replace is the simplest
 *     correct semantics (no partial-merge ambiguity). The body is the reduced
 *     *input* shape; core `buildSavingsGoals` shapes it into the canonical `Goal`
 *     the affordability engine consumes, so all shaping arithmetic stays in
 *     `@ai-fin-os/core` (`CD-003`). POST (not PUT) keeps this route on the same
 *     small verb set every other mutation in the API uses.
 *   - `/api/v1/goals/progress` (GET) is *computed*, never stored: core
 *     `evaluateGoals` reports progress and pace over the stored goals at the
 *     data-derived `asOfDate` (the latest transaction date). This layer parses,
 *     calls the domain, and serialises.
 *
 * A goal is a declaration, never inferred (`D-G2`) — so unlike the spending
 * endpoints these routes never derive anything from transactions except the one
 * deterministic "now" that pace is measured from.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { buildSavingsGoals, evaluateGoals } from "@ai-fin-os/core";
import type { SavingsGoalInput, Transaction } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { GoalStore, GoalState } from "../local/goal-store";
import type { GoalStoreProvider } from "../local/goal-store-provider";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const GOALS_PATH = "/api/v1/goals";
export const GOALS_PROGRESS_PATH = "/api/v1/goals/progress";

/** An amount is integer cents, non-negative, and bounded well below any real
 *  goal so a fat-fingered or hostile value can't overflow downstream
 *  arithmetic. */
const AmountCentsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(1_000_000_000); // $10,000,000 — a savings target will never legitimately exceed this.

/** The reduced shape a user declares. `buildSavingsGoals` fills the rest of the
 *  canonical `Goal`. `strict()` so a typo'd field is a visible 400, not a
 *  silently dropped value. */
const GoalInputSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    label: z.string().min(1).max(120),
    targetAmountCents: AmountCentsSchema,
    currentAmountCents: AmountCentsSchema.optional(),
    monthlyContributionCents: AmountCentsSchema.optional(),
    // A calendar-shaped deadline so pace comparisons stay well-ordered. Kept as a
    // format check (not a full calendar validation) to match the rest of the API.
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date YYYY-MM-DD")
      .optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    protection: z.enum(["protected", "flexible"]).optional(),
    category: z.string().min(1).max(64).optional(),
  })
  .strict();

const SaveGoalsSchema = z
  .object({
    currency: z.string().length(3).default("USD"),
    goals: z.array(GoalInputSchema).max(100).default([]),
  })
  .strict();

const ProgressQuerySchema = z.object({
  currency: z.string().length(3).default("USD"),
});

/** Same data-derived "now" every other endpoint uses: the latest transaction
 *  date, never the wall clock, so responses are deterministic. Falls back to
 *  today only when there is no history to anchor to. */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

export async function registerGoalRoutes(
  app: FastifyInstance,
  options: { goals: GoalStoreProvider; stores: StatementImportStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  app.get(GOALS_PATH, async (request, reply) => {
    const store = await options.goals.forUser(principalOf(request).userId);
    return reply.send(await store.load());
  });

  app.post(GOALS_PATH, async (request, reply) => {
    const parsed = SaveGoalsSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "INVALID_GOALS", parsed.error.issues);

    const currency = parsed.data.currency;
    // Pace is anchored to the user's data-derived "now", so a goal's next
    // contribution is computed relative to their latest transaction, not the
    // server clock — deterministic and consistent with progress.
    const userId = principalOf(request).userId;
    const [store, spendingStore] = await Promise.all([
      options.goals.forUser(userId),
      options.stores.forUser(userId),
    ]);
    const asOfDate = asOfDateFor((await getLocalSpendingState(spendingStore, currency)).transactions);

    const goals = buildSavingsGoals(parsed.data.goals as SavingsGoalInput[], { asOfDate, currency });
    const next: GoalState = { currency, goals };
    return reply.send(await (store as GoalStore).save(next));
  });

  app.get(GOALS_PROGRESS_PATH, async (request, reply) => {
    const parsed = ProgressQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_GOALS_PROGRESS_QUERY", parsed.error.issues);
    const currency = parsed.data.currency;

    const userId = principalOf(request).userId;
    const [goalStore, spendingStore] = await Promise.all([
      options.goals.forUser(userId),
      options.stores.forUser(userId),
    ]);
    const goalState = await goalStore.load();
    const asOfDate = asOfDateFor((await getLocalSpendingState(spendingStore, currency)).transactions);

    return reply.send(evaluateGoals({ goals: goalState.goals, asOfDate, currency }));
  });
}

function badRequest(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  code: string,
  issues: unknown[],
) {
  return reply.status(400).send({ error: { code, issues } });
}
