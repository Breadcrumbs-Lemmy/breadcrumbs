export type CsvParseIssue = {
  code: "EMPTY_CSV" | "UNTERMINATED_QUOTE" | "ROW_LENGTH_MISMATCH" | "DUPLICATE_HEADER";
  rowNumber?: number;
  message: string;
};

export type ParsedCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type ParsedCsv = {
  headers: string[];
  rows: ParsedCsvRow[];
  issues: CsvParseIssue[];
};

export function parseCsv(text: string): ParsedCsv {
  const rawRows = parseCsvRows(text);
  const issues: CsvParseIssue[] = [...rawRows.issues];
  const nonEmptyRows = rawRows.rows.filter((row) => row.cells.some((cell) => cell.trim().length > 0));
  const headerRow = nonEmptyRows[0];

  if (!headerRow) {
    return { headers: [], rows: [], issues: [...issues, emptyCsvIssue()] };
  }

  const headers = headerRow.cells.map((cell, index) => normalizeHeader(cell, index));
  const seenHeaders = new Set<string>();
  for (const header of headers) {
    const key = header.toLowerCase();
    if (seenHeaders.has(key)) {
      issues.push({
        code: "DUPLICATE_HEADER",
        rowNumber: headerRow.rowNumber,
        message: `Duplicate CSV header: ${header}`,
      });
    }
    seenHeaders.add(key);
  }

  const rows: ParsedCsvRow[] = [];
  for (const row of nonEmptyRows.slice(1)) {
    if (row.cells.length !== headers.length) {
      issues.push({
        code: "ROW_LENGTH_MISMATCH",
        rowNumber: row.rowNumber,
        message: `Expected ${headers.length} columns but found ${row.cells.length}.`,
      });
      continue;
    }

    rows.push({
      rowNumber: row.rowNumber,
      values: Object.fromEntries(headers.map((header, index) => [header, row.cells[index] ?? ""])),
    });
  }

  if (rows.length === 0 && !issues.some((issue) => issue.code === "EMPTY_CSV")) {
    issues.push(emptyCsvIssue());
  }

  return { headers, rows, issues };
}

type RawCsvParseResult = {
  rows: { rowNumber: number; cells: string[] }[];
  issues: CsvParseIssue[];
};

function parseCsvRows(text: string): RawCsvParseResult {
  const rows: { rowNumber: number; cells: string[] }[] = [];
  const issues: CsvParseIssue[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowNumber = 1;
  let fieldStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"') {
      if (!fieldStarted && field.length === 0) {
        inQuotes = true;
        fieldStarted = true;
        continue;
      }
      field += char;
      continue;
    }

    if (char === ",") {
      cells.push(field);
      field = "";
      fieldStarted = false;
      continue;
    }

    if (char === "\n") {
      cells.push(field);
      rows.push({ rowNumber, cells });
      cells = [];
      field = "";
      fieldStarted = false;
      rowNumber += 1;
      continue;
    }

    if (char === "\r") {
      continue;
    }

    fieldStarted = true;
    field += char;
  }

  if (inQuotes) {
    issues.push({
      code: "UNTERMINATED_QUOTE",
      rowNumber,
      message: "CSV contains a quoted field that was not closed.",
    });
  }

  if (field.length > 0 || fieldStarted || cells.length > 0) {
    cells.push(field);
    rows.push({ rowNumber, cells });
  }

  return { rows, issues };
}

function normalizeHeader(header: string, index: number): string {
  const trimmed = index === 0 ? header.replace(/^\uFEFF/, "").trim() : header.trim();
  return trimmed.length > 0 ? trimmed : `column_${index + 1}`;
}

function emptyCsvIssue(): CsvParseIssue {
  return {
    code: "EMPTY_CSV",
    message: "CSV must include a header row and at least one data row.",
  };
}
