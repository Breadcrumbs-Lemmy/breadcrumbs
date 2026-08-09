/**
 * Statement import transport.
 *
 * The browser reads the file as text and posts it. It does not parse it: the
 * server's CSV reader returns the headers and sample values that the mapping
 * screen renders, so the columns the user maps are the columns the import will
 * actually read. A `split(",")` here would disagree with the real parser the
 * first time a description contained a comma.
 */
import type { ApiOutcome } from "./api";
import { post } from "./api";

export type CsvColumnInspection = {
  headers: string[];
  rowCount: number;
  sampleRows: Record<string, string>[];
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
  suggestedDateFormat?: "iso" | "mm/dd/yyyy";
  issues: ImportIssue[];
};

export type ImportIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  rowNumber?: number;
  column?: string;
};

export type ColumnMapping = {
  postedDate: string;
  amount?: string;
  debitAmount?: string;
  creditAmount?: string;
  amountSignConvention?: "signed" | "outflow_positive";
  merchantName?: string;
  description?: string;
  category?: string;
  transactionId?: string;
};

export type AccountDescriptor = {
  id: string;
  displayName: string;
  institutionName?: string;
  type: "checking" | "savings" | "cash" | "credit_card" | "loan" | "investment" | "other";
  currency: string;
  currentBalanceCents?: number;
  statementCycle?: { closingDay: number };
};

export type ImportPreview = {
  requestId: string;
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  duplicateInFileCount: number;
  duplicateAlreadyImportedCount: number;
  transactions: { id: string; postedDate: string; merchantName: string; amountCents: number; categoryDisplayName?: string }[];
  categoryMappings: { category: string; displayName: string }[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
};

export type ImportCommit = ImportPreview & {
  importedTransactionCount: number;
  storedTransactionCount: number;
};

export type ExtractedStatement = {
  kind: "extracted";
  csv: string;
  rowCount: number;
  detected: {
    accountName?: string;
    institutionName?: string;
    closingDay?: number;
    outflowPositive: boolean;
    currency?: string;
  };
  warnings: string[];
};

export function inspectCsvColumns(csv: string): Promise<ApiOutcome<CsvColumnInspection>> {
  return post("/api/v1/local/statement-imports/columns", { csv });
}

export function previewImport(body: ImportRequest): Promise<ApiOutcome<ImportPreview>> {
  return post("/api/v1/local/statement-imports/preview", body);
}

export function commitImport(body: ImportRequest): Promise<ApiOutcome<ImportCommit>> {
  return post("/api/v1/local/statement-imports/commit", body);
}

export function extractStatement(
  document: { pdfBase64: string } | { text: string },
): Promise<ApiOutcome<ExtractedStatement | { kind: "declined"; message: string }>> {
  return post("/api/v1/agent/statement-extract", document);
}

export type ImportRequest = {
  csv: string;
  accountId: string;
  account?: AccountDescriptor;
  currency: string;
  dateFormat: "iso" | "mm/dd/yyyy";
  mapping: ColumnMapping;
};

/** Reads a File as text without holding it anywhere else. Statement contents
 *  go to the local API and nowhere further. */
export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

/** PDFs go to the extraction endpoint as base64. Chunked so a large statement
 *  doesn't blow the argument limit of `String.fromCharCode`. */
export async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
