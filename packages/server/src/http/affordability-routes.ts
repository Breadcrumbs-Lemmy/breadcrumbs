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
import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
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
    const store = await options.stores.forUser(principalOf(request).userId);
    const state = await getLocalSpendingState(store, currency);

    if (state.transactions.length === 0) {
      return reply.code(404).send({
        error: {
          code: "NO_IMPORTED_HISTORY",
          message: "Import a statement before asking whether a purchase fits.",
        },
      });
    }

    return buildSnapshotFromHistory({
      accounts: state.accounts,
      transactions: annotateRecurrenceSignals({
        transactions: state.transactions,
        accounts: state.accounts,
        currency,
      }),
      currency,
    });
  });

  registerSafeErrorHandler(app);
}

function currencyFrom(query: unknown): string {
  const value = (query as { currency?: unknown } | null | undefined)?.currency;
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : "USD";
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
