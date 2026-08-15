/**
 * Cash-flow calendar endpoint — read-only, computed, never stored.
 *
 * `GET /api/v1/cashflow/upcoming` derives the same snapshot the affordability
 * verdict uses (`buildSnapshotFromHistory`) and lays its income and obligations on
 * a forward timeline (`buildCashFlowCalendar`). There is no store and no persisted
 * state (`D-C1`): the projection is recomputed from imported history each request,
 * so it can never drift out of sync with a freshly imported statement.
 *
 * All arithmetic is in `@ai-fin-os/core` (`CD-003`/`CD-011`); this layer parses the
 * query, derives the snapshot, calls the domain, and serialises. The verb is `GET`
 * (`D-C12`) — already on the shared CORS allowlist, so no security-relevant
 * allowlist change is needed (see the `cors-verb-allowlist-blindspot` note).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  annotateRecurrenceSignals,
  annotateTransferPairs,
  buildCashFlowCalendar,
  buildSnapshotFromHistory,
} from "@ai-fin-os/core";
import type { CashFlowCalendar } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const CASHFLOW_UPCOMING_PATH = "/api/v1/cashflow/upcoming";

const UpcomingQuerySchema = z.object({
  currency: z.string().length(3).default("USD"),
  // The forward window in days (`D-C3`). Coerced from the query string; clamped
  // here to the same [7, 60] the domain enforces, so an out-of-range value is a
  // clear 400 rather than a silent clamp the caller can't see.
  horizon: z.coerce.number().int().min(7).max(60).default(45),
});

export async function registerCashflowRoutes(
  app: FastifyInstance,
  options: { stores: StatementImportStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  app.get(CASHFLOW_UPCOMING_PATH, async (request, reply) => {
    const parsed = UpcomingQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "INVALID_CASHFLOW_QUERY", parsed.error.issues);
    const q = parsed.data;
    const currency = q.currency.toUpperCase();

    const store = await options.stores.forUser(principalOf(request).userId);
    const state = await getLocalSpendingState(store, currency);

    // Same guard the affordability snapshot uses: no history in this currency
    // means there is nothing to project, and an empty calendar dressed as data
    // would be worse than an honest "import first".
    if (state.transactions.length === 0) {
      return reply.code(404).send({
        error: {
          code: "NO_IMPORTED_HISTORY",
          message: "Import a statement before viewing what's coming up.",
        },
      });
    }

    // Derive the snapshot from the same two whole-history annotations every
    // spending screen applies, in the same order: transfer pairing first (so an
    // internal transfer between the user's own accounts is not misread as income
    // or a bill), then recurrence signals. Getting this wrong would put a
    // checking→savings transfer on the calendar as a "bill".
    const { snapshot } = buildSnapshotFromHistory({
      accounts: state.accounts,
      transactions: annotateRecurrenceSignals({
        transactions: annotateTransferPairs({
          transactions: state.transactions,
          accounts: state.accounts,
        }),
        accounts: state.accounts,
        currency,
      }),
      currency,
    });

    const calendar: CashFlowCalendar = buildCashFlowCalendar({
      incomeSources: snapshot.incomeSources,
      recurringObligations: snapshot.recurringObligations,
      accounts: snapshot.accounts,
      asOfDate: snapshot.asOfDate,
      currency: snapshot.currency,
      horizonDays: q.horizon,
      config: snapshot.config,
    });

    return reply.send(calendar);
  });
}

function badRequest(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  code: string,
  issues: unknown[],
) {
  return reply.status(400).send({ error: { code, issues } });
}
