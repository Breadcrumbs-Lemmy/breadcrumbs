import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  commitCsvStatementImport,
  getLocalSpendingState,
  inspectCsvColumns,
  previewCsvStatementImport,
} from "../local/statement-import";
import { principalOf } from "../auth/middleware";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

/**
 * A card's billing cycle, supplied by the person importing the statement.
 *
 * `source` is fixed to `user_provided` here on purpose: this value came from a
 * human typing the closing day off their statement, and the UI labels an
 * inferred cycle differently from a stated one. A route that let the caller
 * claim `plaid` or `inferred` would let a guess wear the wrong badge.
 */
const StatementCycleInputSchema = z.object({
  closingDay: z.number().int().min(1).max(31),
  dueDayOfMonth: z.number().int().min(1).max(31).optional(),
  lastStatementBalanceCents: z.number().int().optional(),
});

const AccountInputSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  institutionName: z.string().min(1).optional(),
  type: z
    .enum(["checking", "savings", "cash", "credit_card", "loan", "investment", "other"])
    .default("checking"),
  role: z.enum(["spendable_cash", "reserve_cash", "liability", "excluded"]).optional(),
  currency: z.string().length(3).default("USD"),
  currentBalanceCents: z.number().int().optional(),
  availableBalanceCents: z.number().int().optional(),
  includeInForecast: z.boolean().optional(),
  statementCycle: StatementCycleInputSchema.optional(),
});

/** Just enough of a CSV to build a column-mapping screen. */
const CsvInspectBodySchema = z.object({
  csv: z.string().min(1),
  sampleRows: z.coerce.number().int().min(1).max(20).default(5),
});

const ColumnMappingSchema = z
  .object({
    postedDate: z.string().min(1),
    amount: z.string().min(1).optional(),
    debitAmount: z.string().min(1).optional(),
    creditAmount: z.string().min(1).optional(),
    amountSignConvention: z.enum(["signed", "outflow_positive"]).optional(),
    merchantName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    originalDescription: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
  })
  .superRefine((mapping, context) => {
    if (!mapping.amount && !mapping.debitAmount && !mapping.creditAmount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Map either amount or debit/credit amount columns.",
      });
    }
    if (mapping.amount && (mapping.debitAmount || mapping.creditAmount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Use either one signed amount column or debit/credit columns, not both.",
      });
    }
    if (mapping.amount && !mapping.amountSignConvention) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountSignConvention"],
        message: "A single amount column requires amountSignConvention.",
      });
    }
    if (!mapping.amount && (!mapping.debitAmount || !mapping.creditAmount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["debitAmount"],
        message: "Debit/credit imports require both debitAmount and creditAmount mappings.",
      });
    }
    if (!mapping.merchantName && !mapping.description) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["merchantName"],
        message: "Map merchantName or description.",
      });
    }
  });

const CsvImportBodySchema = z.object({
  requestId: z.string().min(1).optional(),
  csv: z.string().min(1),
  accountId: z.string().min(1),
  account: AccountInputSchema.optional(),
  currency: z.string().length(3).default("USD"),
  timezone: z.string().min(1).default("America/Chicago"),
  dateFormat: z.enum(["iso", "mm/dd/yyyy"]).default("iso"),
  mapping: ColumnMappingSchema,
});

const SpendingSummaryQuerySchema = z.object({
  currency: z.string().length(3).default("USD"),
});

const LOCAL_API_PREFIXES = ["/api/local", "/api/v1/local"] as const;

export type RegisterLocalRoutesOptions = {
  stores: StatementImportStoreProvider;
};

export async function registerLocalRoutes(app: FastifyInstance, options: RegisterLocalRoutesOptions): Promise<void> {
  for (const prefix of LOCAL_API_PREFIXES) {
    /**
     * Reads a CSV's header row and a few sample values so the import screen can
     * offer real column names to map.
     *
     * This exists so the browser never parses a financial file itself. Splitting
     * the first line on commas would be close enough until it met a quoted
     * header containing one — and the same parser that reads the header here is
     * the one that will read the rows on commit, so the mapping the user sees
     * cannot disagree with the mapping the import applies.
     */
    app.post(`${prefix}/statement-imports/columns`, async (request) => {
      const body = CsvInspectBodySchema.parse(request.body);
      return inspectCsvColumns(body.csv, body.sampleRows);
    });

    app.post(`${prefix}/statement-imports/preview`, async (request) => {
      const body = CsvImportBodySchema.parse(request.body);
      const store = await options.stores.forUser(principalOf(request).userId);
      return previewCsvStatementImport(body, store);
    });

    app.post(`${prefix}/statement-imports/commit`, async (request, reply) => {
      const body = CsvImportBodySchema.parse(request.body);
      const store = await options.stores.forUser(principalOf(request).userId);
      const result = await commitCsvStatementImport(body, store);
      if (result.errors.length > 0) return reply.code(422).send(result);
      return result;
    });

    app.get(`${prefix}/spending-summary`, async (request) => {
      const query = SpendingSummaryQuerySchema.parse(request.query);
      const store = await options.stores.forUser(principalOf(request).userId);
      return getLocalSpendingState(store, query.currency);
    });
  }

  registerSafeErrorHandler(app);
}
