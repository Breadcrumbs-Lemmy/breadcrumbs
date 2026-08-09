import { getCategoryMetadata, summarizeMonthlySpending } from "@ai-fin-os/core";
import type { Account, MonthlySpendingSummary, Transaction } from "@ai-fin-os/core";
import { createHash } from "node:crypto";

import { parseCsv } from "./csv-parser";
import { categoryRequiredByDefault, normalizeStatementTransaction } from "./normalization";
import type {
  SaveStatementImportResult,
  StatementImportBatch,
  StatementImportState,
  StatementImportStore,
} from "./store";

export type CsvAmountSignConvention = "signed" | "outflow_positive";

export type CsvDateFormat = "iso" | "mm/dd/yyyy";

export type CsvColumnMapping = {
  postedDate: string;
  amount?: string;
  debitAmount?: string;
  creditAmount?: string;
  amountSignConvention?: CsvAmountSignConvention;
  merchantName?: string;
  description?: string;
  originalDescription?: string;
  category?: string;
  currency?: string;
  transactionId?: string;
};

export type LocalAccountInput = {
  id: string;
  displayName: string;
  institutionName?: string;
  type?: Account["type"];
  role?: Account["role"];
  currency?: string;
  currentBalanceCents?: number;
  availableBalanceCents?: number;
  includeInForecast?: boolean;
  statementCycle?: {
    closingDay: number;
    dueDayOfMonth?: number;
    lastStatementBalanceCents?: number;
  };
};

export type CsvColumnInspection = {
  headers: string[];
  rowCount: number;
  /** First few parsed rows, so the mapping screen can show real values. */
  sampleRows: Record<string, string>[];
  /** Header names this CSV appears to use, by mapping field. Suggestions only —
   *  the import still requires the user to confirm every mapping. */
  suggested: {
    postedDate?: string;
    amount?: string;
    debitAmount?: string;
    creditAmount?: string;
    description?: string;
    merchantName?: string;
    category?: string;
    transactionId?: string;
  };
  /** `iso` when every sampled date matches `YYYY-MM-DD`, `mm/dd/yyyy` when they
   *  all match that, otherwise undefined — never a guess across a mixed file. */
  suggestedDateFormat?: CsvDateFormat;
  issues: StatementImportIssue[];
};

export type CsvStatementImportInput = {
  requestId?: string;
  csv: string;
  accountId: string;
  account?: LocalAccountInput;
  currency?: string;
  timezone?: string;
  dateFormat?: CsvDateFormat;
  mapping: CsvColumnMapping;
};

export type StatementImportIssue = {
  code:
    | "EMPTY_CSV"
    | "CSV_PARSE_ERROR"
    | "MISSING_MAPPED_COLUMN"
    | "MISSING_REQUIRED_VALUE"
    | "INVALID_DATE"
    | "INVALID_AMOUNT"
    | "INVALID_CURRENCY"
    | "UNKNOWN_ACCOUNT"
    | "DUPLICATE_IN_FILE"
    | "DUPLICATE_ALREADY_IMPORTED"
    | "UNKNOWN_CATEGORY";
  severity: "error" | "warning";
  message: string;
  rowNumber?: number;
  column?: string;
};

export type CategoryMappingResult = {
  category: string;
  displayName: string;
  requiredDefault: boolean;
};

export type CsvStatementImportPreview = {
  requestId: string;
  sourceFormat: "csv";
  rawCsvStored: false;
  account?: Account;
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  duplicateInFileCount: number;
  duplicateAlreadyImportedCount: number;
  transactions: Transaction[];
  monthlySpendingSummaries: MonthlySpendingSummary[];
  categoryMappings: CategoryMappingResult[];
  errors: StatementImportIssue[];
  warnings: StatementImportIssue[];
};

export type CsvStatementImportCommit = CsvStatementImportPreview & {
  importBatch: StatementImportBatch;
  importedTransactionCount: number;
  duplicateTransactionCount: number;
  accounts: Account[];
  storedTransactionCount: number;
};

const DEFAULT_CURRENCY = "USD";

/**
 * Reads a CSV's shape without importing anything.
 *
 * The suggestions here are a convenience for the mapping screen and nothing
 * more. Nothing downstream reads them: `previewCsvStatementImport` still
 * requires an explicit mapping, and `amountSignConvention` is deliberately
 * *not* suggested — whether a positive number means money in or money out is
 * the one thing a header name cannot tell you, and guessing it wrong turns
 * income into spending.
 */
export function inspectCsvColumns(csv: string, sampleRowCount = 5): CsvColumnInspection {
  const parsed = parseCsv(csv);
  const issues: StatementImportIssue[] = parsed.issues.map((issue) => ({
    code: issue.code === "EMPTY_CSV" ? "EMPTY_CSV" : "CSV_PARSE_ERROR",
    severity: "error",
    message: issue.message,
    rowNumber: issue.rowNumber,
  }));

  const sampleRows = parsed.rows.slice(0, sampleRowCount).map((row) => row.values);
  const suggested = suggestMapping(parsed.headers);
  const dateColumn = suggested.postedDate;

  return {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    sampleRows,
    suggested,
    suggestedDateFormat: dateColumn ? detectDateFormat(parsed.rows, dateColumn) : undefined,
    issues,
  };
}

const HEADER_HINTS: { field: keyof CsvColumnInspection["suggested"]; patterns: RegExp[] }[] = [
  { field: "postedDate", patterns: [/^(posted|transaction|post|trans)?\s*date$/i, /^date$/i] },
  { field: "debitAmount", patterns: [/^debit/i, /withdrawal/i] },
  { field: "creditAmount", patterns: [/^credit$/i, /^deposit/i] },
  { field: "amount", patterns: [/^amount$/i, /^amt$/i, /^transaction amount$/i] },
  { field: "merchantName", patterns: [/^(merchant|payee|name)$/i] },
  { field: "description", patterns: [/^(description|memo|details|narrative)$/i] },
  { field: "category", patterns: [/^category$/i] },
  { field: "transactionId", patterns: [/^(transaction )?id$/i, /reference/i] },
];

function suggestMapping(headers: string[]): CsvColumnInspection["suggested"] {
  const suggested: CsvColumnInspection["suggested"] = {};
  for (const { field, patterns } of HEADER_HINTS) {
    if (suggested[field]) continue;
    const match = headers.find((header) => patterns.some((pattern) => pattern.test(header.trim())));
    if (match) suggested[field] = match;
  }
  // Debit/credit pairs and a single signed amount are mutually exclusive in the
  // mapping schema. Offering both would produce a preview that fails validation.
  if (suggested.debitAmount && suggested.creditAmount) delete suggested.amount;
  else {
    delete suggested.debitAmount;
    delete suggested.creditAmount;
  }
  return suggested;
}

function detectDateFormat(
  rows: { values: Record<string, string> }[],
  column: string,
): CsvDateFormat | undefined {
  const values = rows
    .map((row) => (row.values[column] ?? "").trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  if (values.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return "iso";
  if (values.every((value) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value))) return "mm/dd/yyyy";
  return undefined;
}

export async function previewCsvStatementImport(
  input: CsvStatementImportInput,
  store: StatementImportStore,
  now = new Date(),
): Promise<CsvStatementImportPreview> {
  const state = await store.load();
  return buildPreview(input, state, now);
}

export async function commitCsvStatementImport(
  input: CsvStatementImportInput,
  store: StatementImportStore,
  now = new Date(),
): Promise<CsvStatementImportCommit> {
  const preview = await previewCsvStatementImport(input, store, now);
  if (preview.errors.length > 0 || !preview.account) {
    const emptyBatch = {
      ...createBatch(input.accountId, now, preview.rowCount, preview.invalidRowCount),
      importedTransactionCount: 0,
      duplicateTransactionCount: 0,
    };
    return {
      ...preview,
      importBatch: emptyBatch,
      importedTransactionCount: 0,
      duplicateTransactionCount: 0,
      accounts: preview.account ? [preview.account] : [],
      storedTransactionCount: 0,
    };
  }

  const saved = await store.saveImport({
    account: preview.account,
    transactions: preview.transactions,
    batch: createBatch(input.accountId, now, preview.rowCount, preview.invalidRowCount),
    knownDuplicateTransactionCount: preview.duplicateAlreadyImportedCount + preview.duplicateInFileCount,
  });

  return buildCommitResponse(preview, saved);
}

export async function getLocalSpendingState(
  store: StatementImportStore,
  currency = DEFAULT_CURRENCY,
): Promise<{
  source: "local";
  rawCsvStored: false;
  accounts: Account[];
  transactions: Transaction[];
  importBatches: StatementImportBatch[];
  monthlySpendingSummaries: MonthlySpendingSummary[];
  empty: boolean;
}> {
  const state = await store.load();
  return {
    source: "local",
    rawCsvStored: false,
    accounts: state.accounts,
    transactions: state.transactions.filter((transaction) => transaction.currency === currency),
    importBatches: state.importBatches,
    monthlySpendingSummaries: summarizeMonthlySpending(state.transactions, currency, state.accounts),
    empty: state.transactions.length === 0,
  };
}

function buildPreview(
  input: CsvStatementImportInput,
  state: StatementImportState,
  now: Date,
): CsvStatementImportPreview {
  const requestId = input.requestId ?? `csv_preview_${now.getTime()}`;
  const parsed = parseCsv(input.csv);
  const errors: StatementImportIssue[] = [];
  const warnings: StatementImportIssue[] = [];
  const currency = (input.currency ?? input.account?.currency ?? DEFAULT_CURRENCY).toUpperCase();
  const account = resolveAccount(input, state, currency, now);

  for (const issue of parsed.issues) {
    errors.push({
      code: issue.code === "EMPTY_CSV" ? "EMPTY_CSV" : "CSV_PARSE_ERROR",
      severity: "error",
      message: issue.message,
      rowNumber: issue.rowNumber,
    });
  }

  const missingColumns = findMissingColumns(parsed.headers, input.mapping);
  for (const column of missingColumns) {
    errors.push({
      code: "MISSING_MAPPED_COLUMN",
      severity: "error",
      message: `Mapped column "${column}" was not found in the CSV header.`,
      column,
    });
  }

  if (!account) {
    errors.push({
      code: "UNKNOWN_ACCOUNT",
      severity: "error",
      message: `Account "${input.accountId}" is not known. Include an account descriptor on the first import for this account.`,
    });
  }

  const transactions: Transaction[] = [];
  const rowErrors = new Set<number>();
  const seenTransactionIds = new Set<string>();
  const existingTransactionIds = new Set(state.transactions.map((transaction) => transaction.id));

  if (missingColumns.length === 0 && account) {
    for (const row of parsed.rows) {
      const mapped = mapCsvRow(row.values, row.rowNumber, input, account, currency, now);
      for (const error of mapped.errors) {
        errors.push(error);
        if (error.rowNumber) rowErrors.add(error.rowNumber);
      }
      warnings.push(...mapped.warnings);
      if (!mapped.transaction) continue;

      if (seenTransactionIds.has(mapped.transaction.id)) {
        warnings.push({
          code: "DUPLICATE_IN_FILE",
          severity: "warning",
          rowNumber: row.rowNumber,
          message: "This row matches another row in the same import and will not be imported twice.",
        });
        continue;
      }
      seenTransactionIds.add(mapped.transaction.id);

      if (existingTransactionIds.has(mapped.transaction.id)) {
        warnings.push({
          code: "DUPLICATE_ALREADY_IMPORTED",
          severity: "warning",
          rowNumber: row.rowNumber,
          message: "This row was already imported and will not be committed again.",
        });
        continue;
      }

      transactions.push(mapped.transaction);
    }
  }

  const previewTransactions = [...state.transactions, ...transactions];
  const accountList = account ? upsertAccountForSummary(state.accounts, account) : state.accounts;
  const duplicateInFileCount = warnings.filter((warning) => warning.code === "DUPLICATE_IN_FILE").length;
  const duplicateAlreadyImportedCount = warnings.filter((warning) => warning.code === "DUPLICATE_ALREADY_IMPORTED").length;

  return {
    requestId,
    sourceFormat: "csv",
    rawCsvStored: false,
    account: account ? { ...account } : undefined,
    rowCount: parsed.rows.length,
    validRowCount: transactions.length,
    invalidRowCount: rowErrors.size + (parsed.rows.length === 0 ? 1 : 0),
    duplicateInFileCount,
    duplicateAlreadyImportedCount,
    transactions,
    monthlySpendingSummaries: summarizeMonthlySpending(previewTransactions, currency, accountList),
    categoryMappings: buildCategoryMappings(transactions),
    errors,
    warnings,
  };
}

function mapCsvRow(
  row: Record<string, string>,
  rowNumber: number,
  input: CsvStatementImportInput,
  account: Account,
  expectedCurrency: string,
  now: Date,
): { transaction?: Transaction; errors: StatementImportIssue[]; warnings: StatementImportIssue[] } {
  const errors: StatementImportIssue[] = [];
  const warnings: StatementImportIssue[] = [];
  const postedDate = parseStatementDate(readMappedValue(row, input.mapping.postedDate), input.dateFormat ?? "iso");
  if (!postedDate) {
    errors.push(rowError("INVALID_DATE", rowNumber, input.mapping.postedDate, "Date must match the selected date format."));
  }

  const amount = parseMappedAmount(row, input.mapping, rowNumber);
  errors.push(...amount.errors);

  const currency = readOptionalMappedValue(row, input.mapping.currency)?.toUpperCase() ?? expectedCurrency;
  if (!/^[A-Z]{3}$/.test(currency) || currency !== expectedCurrency) {
    errors.push(
      rowError(
        "INVALID_CURRENCY",
        rowNumber,
        input.mapping.currency,
        `Currency must be ${expectedCurrency}.`,
      ),
    );
  }

  const merchantSource =
    readOptionalMappedValue(row, input.mapping.merchantName) ??
    readOptionalMappedValue(row, input.mapping.description);
  if (!merchantSource) {
    errors.push(
      rowError(
        "MISSING_REQUIRED_VALUE",
        rowNumber,
        input.mapping.merchantName ?? input.mapping.description,
        "Merchant or description is required.",
      ),
    );
  }

  if (!postedDate || amount.amountCents === undefined || !merchantSource || errors.length > 0) {
    return { errors, warnings };
  }

  const originalDescription =
    readOptionalMappedValue(row, input.mapping.originalDescription) ??
    readOptionalMappedValue(row, input.mapping.description) ??
    merchantSource;
  const rawCategory = readOptionalMappedValue(row, input.mapping.category);
  const normalized = normalizeStatementTransaction({
    merchantName: merchantSource,
    originalDescription,
    rawCategory,
    amountCents: amount.amountCents,
  });

  if (normalized.category === "unknown") {
    warnings.push({
      code: "UNKNOWN_CATEGORY",
      severity: "warning",
      rowNumber,
      message: "This row could not be categorized precisely and was mapped to unknown.",
    });
  }

  const sourceTransactionId = readOptionalMappedValue(row, input.mapping.transactionId);
  const transactionId = buildTransactionId({
    accountId: account.id,
    sourceTransactionId,
    postedDate,
    amountCents: amount.amountCents,
    normalizedMerchantId: normalized.normalizedMerchantId,
    originalDescription,
  });

  return {
    transaction: {
      id: transactionId,
      accountId: account.id,
      postedDate,
      merchantName: normalized.merchantName,
      originalDescription,
      amountCents: amount.amountCents,
      currency,
      category: normalized.category,
      categoryDisplayName: normalized.categoryDisplayName,
      categoryRequiredDefault: normalized.categoryRequiredDefault,
      normalizedMerchantId: normalized.normalizedMerchantId,
      merchantCanonical: normalized.merchantCanonical,
      merchantAmbiguity: normalized.merchantAmbiguity,
      flowType: normalized.flowType,
      normalizationUncertaintyCodes: normalized.uncertaintyCodes,
      freshness: {
        status: "usable",
        asOf: now.toISOString(),
        source: "csv",
        warnings: [],
      },
      uncertainty: {
        confidence: normalized.confidence,
        confidenceReason: normalized.confidenceReason,
        isEstimated: normalized.confidence < 0.9,
        estimateMethod: normalized.confidence < 0.9 ? "category_average" : undefined,
      },
      source: "csv",
    },
    errors,
    warnings,
  };
}

function parseMappedAmount(
  row: Record<string, string>,
  mapping: CsvColumnMapping,
  rowNumber: number,
): { amountCents?: number; errors: StatementImportIssue[] } {
  const errors: StatementImportIssue[] = [];

  if (mapping.amount) {
    const parsed = parseMoneyCents(readMappedValue(row, mapping.amount));
    if (parsed === undefined) {
      return {
        errors: [rowError("INVALID_AMOUNT", rowNumber, mapping.amount, "Amount must be a valid decimal money value.")],
      };
    }
    const convention = mapping.amountSignConvention;
    if (!convention) {
      return {
        errors: [
          rowError(
            "INVALID_AMOUNT",
            rowNumber,
            mapping.amount,
            "A single amount column requires amountSignConvention.",
          ),
        ],
      };
    }
    return {
      amountCents: convention === "outflow_positive" ? -parsed : parsed,
      errors,
    };
  }

  // Banks that ship separate debit and credit columns put 0.00 — not a blank —
  // in the side that does not apply to a row. Treat a parsed zero as "not this
  // side", so a debit row carrying a 0.00 credit reads as a clean debit instead
  // of tripping the "only one may be present" check and rejecting every row.
  const debit = zeroAsAbsent(mapping.debitAmount ? parseOptionalMoneyCents(readMappedValue(row, mapping.debitAmount)) : undefined);
  const credit = zeroAsAbsent(mapping.creditAmount ? parseOptionalMoneyCents(readMappedValue(row, mapping.creditAmount)) : undefined);
  const hasDebit = debit !== undefined;
  const hasCredit = credit !== undefined;

  if (hasDebit && hasCredit) {
    errors.push(rowError("INVALID_AMOUNT", rowNumber, mapping.debitAmount, "Only one of debit or credit may be present."));
  }
  if (!hasDebit && !hasCredit) {
    errors.push(rowError("INVALID_AMOUNT", rowNumber, mapping.debitAmount ?? mapping.creditAmount, "Debit or credit amount is required."));
  }
  if ((debit ?? 0) < 0 || (credit ?? 0) < 0) {
    errors.push(rowError("INVALID_AMOUNT", rowNumber, mapping.debitAmount ?? mapping.creditAmount, "Debit and credit columns must contain positive values."));
  }

  if (errors.length > 0) return { errors };
  return {
    amountCents: hasDebit ? -Math.abs(debit as number) : Math.abs(credit as number),
    errors,
  };
}

function parseOptionalMoneyCents(value: string): number | undefined {
  return value.trim().length === 0 ? undefined : parseMoneyCents(value);
}

/** For the split debit/credit convention, a zero means "this side is unused" —
 *  the same signal a blank cell carries — so collapse it to absent. */
function zeroAsAbsent(value: number | undefined): number | undefined {
  return value === 0 ? undefined : value;
}

function parseMoneyCents(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const negativeByParens = /^\(.+\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const negative = cleaned.startsWith("-") || negativeByParens;
  const unsigned = cleaned.replace(/^-/, "");
  const [dollarsPart, centsPart = ""] = unsigned.split(".");
  const cents = Number.parseInt(dollarsPart, 10) * 100 + Number.parseInt(centsPart.padEnd(2, "0"), 10);
  return negative ? -cents : cents;
}

function parseStatementDate(value: string, format: CsvDateFormat): string | undefined {
  const trimmed = value.trim();
  if (format === "iso") {
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
  }

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return undefined;
  const month = Number.parseInt(match[1] ?? "", 10);
  const day = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function findMissingColumns(headers: string[], mapping: CsvColumnMapping): string[] {
  const headerSet = new Set(headers);
  return mappedColumns(mapping).filter((column) => !headerSet.has(column));
}

function mappedColumns(mapping: CsvColumnMapping): string[] {
  return [
    mapping.postedDate,
    mapping.amount,
    mapping.debitAmount,
    mapping.creditAmount,
    mapping.merchantName,
    mapping.description,
    mapping.originalDescription,
    mapping.category,
    mapping.currency,
    mapping.transactionId,
  ].filter((column): column is string => Boolean(column));
}

function readMappedValue(row: Record<string, string>, column: string): string {
  return row[column] ?? "";
}

function readOptionalMappedValue(row: Record<string, string>, column: string | undefined): string | undefined {
  if (!column) return undefined;
  const value = readMappedValue(row, column).trim();
  return value.length > 0 ? value : undefined;
}

function resolveAccount(
  input: CsvStatementImportInput,
  state: StatementImportState,
  currency: string,
  now: Date,
): Account | undefined {
  const existing = state.accounts.find((account) => account.id === input.accountId);
  if (!input.account && existing) return existing;
  if (!input.account) return undefined;

  return createLocalAccount(
    {
      ...input.account,
      id: input.accountId,
      currency,
    },
    now,
  );
}

function createLocalAccount(input: Required<Pick<LocalAccountInput, "id" | "displayName">> & LocalAccountInput, now: Date): Account {
  const type = input.type ?? "checking";
  const role = input.role ?? defaultRoleForAccountType(type);
  const balanceKnown = input.currentBalanceCents !== undefined || input.availableBalanceCents !== undefined;
  return {
    id: input.id,
    displayName: input.displayName,
    institutionName: input.institutionName,
    type,
    role,
    currency: input.currency ?? DEFAULT_CURRENCY,
    currentBalanceCents: input.currentBalanceCents ?? input.availableBalanceCents ?? 0,
    availableBalanceCents: input.availableBalanceCents,
    // A cash account someone imported is part of their cash picture — leaving
    // it out meant the affordability forecast had no spendable balance at all
    // and answered UNKNOWN for every imported statement. Liabilities stay out:
    // a card balance is not money available to spend.
    includeInForecast: input.includeInForecast ?? (role === "spendable_cash" || role === "reserve_cash"),
    // A cycle is only meaningful on something you get a bill for. Accepting one
    // on a checking account would put a "closes on the 18th" badge on an
    // account that never closes.
    ...(input.statementCycle && (type === "credit_card" || type === "loan")
      ? {
          statementCycle: {
            closingDay: input.statementCycle.closingDay,
            dueDayOfMonth: input.statementCycle.dueDayOfMonth,
            lastStatementBalanceCents: input.statementCycle.lastStatementBalanceCents,
            source: "user_provided" as const,
          },
        }
      : {}),
    freshness: {
      status: balanceKnown ? "usable" : "estimated",
      asOf: now.toISOString(),
      source: "csv",
      warnings: balanceKnown
        ? []
        : [
            {
              code: "ESTIMATED_VALUE",
              severity: "warning",
              message: "CSV statement import did not include a current account balance.",
            },
          ],
    },
    source: "csv",
  };
}

function defaultRoleForAccountType(type: Account["type"]): Account["role"] {
  if (type === "checking" || type === "cash") return "spendable_cash";
  if (type === "savings") return "reserve_cash";
  if (type === "credit_card" || type === "loan") return "liability";
  return "excluded";
}

function buildTransactionId(input: {
  accountId: string;
  sourceTransactionId?: string;
  postedDate: string;
  amountCents: number;
  normalizedMerchantId: string;
  originalDescription: string;
}): string {
  const source = input.sourceTransactionId
    ? `source:${input.accountId}:${input.sourceTransactionId}`
    : `derived:${input.accountId}:${input.postedDate}:${input.amountCents}:${input.normalizedMerchantId}:${input.originalDescription}`;
  return `csv:transaction:${hash(source).slice(0, 24)}`;
}

function createBatch(
  accountId: string,
  now: Date,
  rowCount: number,
  invalidRowCount: number,
): Omit<StatementImportBatch, "importedTransactionCount" | "duplicateTransactionCount"> {
  return {
    id: `csv_import_${now.getTime()}_${hash(`${accountId}:${rowCount}:${now.toISOString()}`).slice(0, 8)}`,
    accountId,
    sourceFormat: "csv",
    createdAt: now.toISOString(),
    rowCount,
    invalidRowCount,
    rawCsvStored: false,
  };
}

function buildCommitResponse(
  preview: CsvStatementImportPreview,
  saved: SaveStatementImportResult,
): CsvStatementImportCommit {
  return {
    ...preview,
    transactions: saved.importedTransactions,
    monthlySpendingSummaries: summarizeMonthlySpending(saved.state.transactions, preview.account?.currency ?? DEFAULT_CURRENCY, saved.state.accounts),
    importBatch: saved.batch,
    importedTransactionCount: saved.importedTransactions.length,
    duplicateTransactionCount: saved.batch.duplicateTransactionCount,
    accounts: saved.state.accounts,
    storedTransactionCount: saved.state.transactions.length,
  };
}

function buildCategoryMappings(transactions: Transaction[]): CategoryMappingResult[] {
  const categories = new Set(transactions.map((transaction) => transaction.category));
  return [...categories]
    .sort()
    .map((category) => ({
      category,
      displayName: getCategoryMetadata(category).displayName,
      requiredDefault: categoryRequiredByDefault(category),
    }));
}

function upsertAccountForSummary(accounts: Account[], account: Account): Account[] {
  return [...accounts.filter((candidate) => candidate.id !== account.id), account];
}

function rowError(
  code: StatementImportIssue["code"],
  rowNumber: number,
  column: string | undefined,
  message: string,
): StatementImportIssue {
  return {
    code,
    severity: "error",
    rowNumber,
    column,
    message,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
