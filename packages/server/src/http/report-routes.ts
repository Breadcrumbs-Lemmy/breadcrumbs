/**
 * Monthly report endpoints — JSON and CSV.
 *
 * Thin, like the spending routes (`spending-routes.ts`): parse the query, load
 * and annotate the rows once — the SAME transfer-pairing and recurrence
 * derivations the spending routes apply, so the report can never disagree with
 * the screens it summarises — compose the report in `@ai-fin-os/core`, and
 * serialise. No arithmetic and no formatting of a financial figure lives here
 * (`CD-003`, D-R10). See `docs/report.md`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  annotateRecurrenceSignals,
  annotateTransferPairs,
  buildMonthlyReport,
  getCategoryMetadata,
  toReportCsv,
} from "@ai-fin-os/core";
import type { Account, MonthlyReport, Transaction } from "@ai-fin-os/core";

import { principalOf } from "../auth/middleware";
import { getLocalSpendingState } from "../local/statement-import";
import type { StatementImportStore } from "../local/store";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const MONTHLY_REPORT_PATH = "/api/v1/reports/monthly";
export const MONTHLY_REPORT_CSV_PATH = "/api/v1/reports/monthly.csv";

const ReportQuerySchema = z.object({
  /** Explicit month (real month 01–12). Omitted → the latest complete month
   *  (D-R2). Rejecting a bad month here keeps it out of the calendar arithmetic,
   *  which throws on e.g. `2022-13`. */
  key: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM")
    .optional(),
  currency: z.string().length(3).default("USD"),
});

/** Category display labels come from the shared taxonomy so UI and API cannot
 *  drift on naming — identical to the spending routes. */
function categoryLabel(id: string): string {
  return getCategoryMetadata(id)?.displayName ?? id;
}

/**
 * `asOfDate` is the latest posted date, never the wall clock (`CD-011`) — so the
 * same imported history always produces the same report and the same CSV bytes.
 */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

type Loaded = { accounts: Account[]; transactions: Transaction[] };

export async function registerReportRoutes(
  app: FastifyInstance,
  options: { stores: StatementImportStoreProvider },
): Promise<void> {
  registerSafeErrorHandler(app);

  async function load(store: StatementImportStore, currency: string): Promise<Loaded> {
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

  /**
   * Shared by both endpoints. Returns the built report, or null after having
   * sent the error reply itself (a malformed key → 400, an empty store → 404).
   */
  async function buildFor(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<MonthlyReport | null> {
    const parsed = ReportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400).send({ error: { code: "INVALID_REPORT_QUERY", issues: parsed.error.issues } });
      return null;
    }
    const q = parsed.data;

    const store = await options.stores.forUser(principalOf(request).userId);
    const { accounts, transactions } = await load(store, q.currency);

    // Emptiness is a property of the whole dataset, not the chosen month: with no
    // imported history there is nothing to report and the web shows an "import
    // first" state (D-R8). A month that merely had no spending is a valid, quiet
    // report, not an error.
    if (transactions.length === 0) {
      reply.status(404).send({
        error: {
          code: "NO_IMPORTED_HISTORY",
          message: "Import a statement to generate a monthly report.",
        },
      });
      return null;
    }

    return buildMonthlyReport({
      transactions,
      accounts,
      currency: q.currency,
      asOfDate: asOfDateFor(transactions),
      key: q.key,
      categoryLabel,
    });
  }

  app.get(MONTHLY_REPORT_PATH, async (request, reply) => {
    const report = await buildFor(request, reply);
    if (!report) return reply;
    return reply.send(report);
  });

  app.get(MONTHLY_REPORT_CSV_PATH, async (request, reply) => {
    const report = await buildFor(request, reply);
    if (!report) return reply;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="monthly-report-${report.summary.period.key}.csv"`,
      )
      .send(toReportCsv(report));
  });
}
