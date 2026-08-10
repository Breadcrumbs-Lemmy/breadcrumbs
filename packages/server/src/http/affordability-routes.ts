import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AffordabilityRequestValidationError,
  annotateRecurrenceSignals,
  buildSnapshotFromHistory,
  evaluateAffordability,
} from "@ai-fin-os/core";
import type {
  AffordabilityRequestValidationIssue,
  AffordabilityResponse,
} from "@ai-fin-os/core";
import type { Goal } from "@ai-fin-os/core";
import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { GoalStoreProvider } from "../local/goal-store-provider";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const AFFORDABILITY_API_V1_PATH = "/api/v1/affordability/evaluate";
export const AFFORDABILITY_SNAPSHOT_PATH = "/api/v1/affordability/snapshot";

export type AffordabilityApiInvalidRequestError = {
  error: {
    code: "INVALID_AFFORDABILITY_REQUEST";
    issues: AffordabilityRequestValidationIssue[];
  };
};

export type RegisterAffordabilityRoutesOptions = {
  stores: StatementImportStoreProvider;
  /** User-declared savings goals, injected into the snapshot so the engine's
   *  goal handling runs on real input (`D-G7`). Optional: without it the snapshot
   *  carries no goals, exactly as before this feature. */
  goals?: GoalStoreProvider;
};

export async function registerAffordabilityRoutes(
  app: FastifyInstance,
  options: RegisterAffordabilityRoutesOptions,
): Promise<void> {
  app.post(AFFORDABILITY_API_V1_PATH, evaluateAffordabilityRequest);

  /**
   * The snapshot the affordability question should be asked against.
   *
   * The browser used to build this from a fixture shipped inside
   * `packages/core`, so the verdict described fixture balances and a fixture
   * paycheck. Deriving it here keeps the calculation server-side (`CD-003`)
   * and means the answer is about the user's own imported accounts.
   *
   * `notes` travels with the snapshot on purpose: a derived income source is a
   * guess with evidence behind it, and the screen should be able to say which
   * guesses it made rather than presenting them as declared facts.
   */
  app.get(AFFORDABILITY_SNAPSHOT_PATH, async (request, reply) => {
    const currency = currencyFrom(request.query);
    const userId = principalOf(request).userId;
    const store = await options.stores.forUser(userId);
    const state = await getLocalSpendingState(store, currency);

    if (state.transactions.length === 0) {
      return reply.code(404).send({
        error: {
          code: "NO_IMPORTED_HISTORY",
          message: "Import a statement before asking whether a purchase fits.",
        },
      });
    }

    // Inject the user's declared goals so the engine's already-written goal
    // handling runs on real input (`D-G7`). Goals are passed in, never derived
    // (`D-G2`), so "nothing is invented" still holds. Only goals in the snapshot
    // currency are injected: the engine blocks on any mixed currency, and a goal
    // saved in another currency is out of scope for this single-currency verdict.
    const goals = await loadGoalsInCurrency(options.goals, userId, currency);

    return buildSnapshotFromHistory({
      accounts: state.accounts,
      transactions: annotateRecurrenceSignals({
        transactions: state.transactions,
        accounts: state.accounts,
        currency,
      }),
      currency,
      goals,
    });
  });

  registerSafeErrorHandler(app);
}

function currencyFrom(query: unknown): string {
  const value = (query as { currency?: unknown } | null | undefined)?.currency;
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : "USD";
}

/** The user's stored goals for the snapshot currency. Absent provider (or store)
 *  yields none, so the snapshot is unchanged from before this feature. A goal
 *  with no currency is treated as the snapshot currency (it was declared there). */
async function loadGoalsInCurrency(
  provider: GoalStoreProvider | undefined,
  userId: string,
  currency: string,
): Promise<Goal[]> {
  if (!provider) return [];
  const store = await provider.forUser(userId);
  const { goals } = await store.load();
  return goals.filter((goal) => (goal.currency ?? currency).toUpperCase() === currency);
}

async function evaluateAffordabilityRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AffordabilityResponse | FastifyReply> {
  try {
    return evaluateAffordability(request.body);
  } catch (error) {
    if (error instanceof AffordabilityRequestValidationError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_AFFORDABILITY_REQUEST",
          issues: error.issues,
        },
      } satisfies AffordabilityApiInvalidRequestError);
    }

    throw error;
  }
}
