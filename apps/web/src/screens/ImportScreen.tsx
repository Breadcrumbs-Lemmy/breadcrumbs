/**
 * Import — the product's front door (`L-003a`).
 *
 * Every other screen reads imported statements, and until this existed the only
 * way to produce one was an HTTP client. A fresh install showed four working
 * screens and no way to put anything in them.
 *
 * Four steps, and the order is the point: **choose a file → map its columns →
 * preview → commit.** Preview-then-commit means a wrong column mapping costs a
 * second attempt rather than polluting totals that are hard to un-pollute.
 *
 * The browser performs no financial arithmetic here. It reads the file as text,
 * sends it, and renders what the server's parser and validator return.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  commitImport,
  extractStatement,
  inspectCsvColumns,
  previewImport,
  readFileAsBase64,
  readFileAsText,
  type AccountDescriptor,
  type ColumnMapping,
  type CsvColumnInspection,
  type ImportCommit,
  type ImportIssue,
  type ImportPreview,
} from "../services/import";
import { formatMoney } from "../format/money";
import { Card, SectionLabel } from "../components/ui";

type Step = "file" | "map" | "preview" | "done";

type AccountDraft = {
  displayName: string;
  institutionName: string;
  type: AccountDescriptor["type"];
  balance: string;
  closingDay: string;
};

const EMPTY_ACCOUNT: AccountDraft = {
  displayName: "",
  institutionName: "",
  type: "checking",
  balance: "",
  closingDay: "",
};

/** Mapping fields the screen offers, in the order they're asked for. */
const OPTIONAL_FIELDS = [
  { key: "merchantName", label: "Merchant" },
  { key: "description", label: "Description" },
  { key: "category", label: "Category from your bank" },
  { key: "transactionId", label: "Transaction ID" },
] as const;

export function ImportScreen({
  onImported,
  onBack,
}: {
  onImported?: () => void;
  onBack?: () => void;
}) {
  const [step, setStep] = useState<Step>("file");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [csv, setCsv] = useState("");
  const [inspection, setInspection] = useState<CsvColumnInspection | null>(null);
  const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);

  const [mapping, setMapping] = useState<ColumnMapping>({ postedDate: "" });
  const [dateFormat, setDateFormat] = useState<"iso" | "mm/dd/yyyy">("iso");
  const [account, setAccount] = useState<AccountDraft>(EMPTY_ACCOUNT);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [commit, setCommit] = useState<ImportCommit | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const accountId = useMemo(
    () => `acct_${slug(account.displayName || "imported")}`,
    [account.displayName],
  );

  const request = useCallback(
    () => ({
      csv,
      accountId,
      account: {
        id: accountId,
        displayName: account.displayName.trim() || "Imported account",
        institutionName: account.institutionName.trim() || undefined,
        type: account.type,
        currency: "USD",
        currentBalanceCents: dollarsToCents(account.balance),
        ...(account.type === "credit_card" && account.closingDay.trim()
          ? { statementCycle: { closingDay: Number(account.closingDay) } }
          : {}),
      } satisfies AccountDescriptor,
      currency: "USD",
      dateFormat,
      mapping,
    }),
    [csv, accountId, account, dateFormat, mapping],
  );

  // ---- Step 1: file ------------------------------------------------------

  const loadCsvText = useCallback(async (text: string, warnings: string[] = []) => {
    setBusy("Reading columns…");
    setError(null);
    const outcome = await inspectCsvColumns(text);
    setBusy(null);

    if (outcome.kind !== "ok") {
      setError(outcome.kind === "error" ? outcome.message : "That file couldn't be read.");
      return;
    }

    setCsv(text);
    setInspection(outcome.data);
    setExtractionWarnings(warnings);
    // Suggestions are prefilled, never applied silently — the user still sees
    // and confirms every column before a preview runs.
    setMapping({
      postedDate: outcome.data.suggested.postedDate ?? "",
      amount: outcome.data.suggested.amount,
      debitAmount: outcome.data.suggested.debitAmount,
      creditAmount: outcome.data.suggested.creditAmount,
      merchantName: outcome.data.suggested.merchantName,
      description: outcome.data.suggested.description,
      category: outcome.data.suggested.category,
      transactionId: outcome.data.suggested.transactionId,
    });
    if (outcome.data.suggestedDateFormat) setDateFormat(outcome.data.suggestedDateFormat);
    setStep("map");
  }, []);

  const onPickFile = useCallback(
    async (file: File) => {
      setError(null);
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      if (!isPdf) {
        await loadCsvText(await readFileAsText(file));
        return;
      }

      setBusy("Reading the statement…");
      const outcome = await extractStatement({ pdfBase64: await readFileAsBase64(file) });
      setBusy(null);

      if (outcome.kind !== "ok") {
        setError(
          outcome.kind === "error"
            ? outcome.message
            : "PDF statements need the assistant. Turn on a provider (local or hosted) in Assistant, or export a CSV from your bank.",
        );
        return;
      }
      if (!("csv" in outcome.data)) {
        setError(outcome.data.message);
        return;
      }

      const extracted = outcome.data;
      await loadCsvText(extracted.csv, extracted.warnings);
      // The extractor reads the statement's own sign convention off the page.
      // It is still shown as an editable choice below — this only preselects it.
      setMapping((current) => ({
        ...current,
        amountSignConvention: extracted.detected.outflowPositive ? "outflow_positive" : "signed",
      }));
      setAccount((current) => ({
        ...current,
        displayName: current.displayName || extracted.detected.accountName || "",
        institutionName: current.institutionName || extracted.detected.institutionName || "",
        closingDay: current.closingDay || String(extracted.detected.closingDay ?? ""),
      }));
    },
    [loadCsvText],
  );

  // ---- Step 2 → 3: preview ------------------------------------------------

  const runPreview = useCallback(async () => {
    setBusy("Checking rows…");
    setError(null);
    const outcome = await previewImport(request());
    setBusy(null);

    if (outcome.kind === "ok" || outcome.kind === "rejected") {
      setPreview(outcome.data);
      setStep("preview");
      return;
    }
    setError(
      outcome.kind === "error" ? outcome.message : "That mapping isn't valid — check the fields above.",
    );
  }, [request]);

  const runCommit = useCallback(async () => {
    setBusy("Importing…");
    setError(null);
    const outcome = await commitImport(request());
    setBusy(null);

    if (outcome.kind === "ok") {
      setCommit(outcome.data);
      setStep("done");
      onImported?.();
      return;
    }
    if (outcome.kind === "rejected") {
      // 422: rows failed validation. The body carries the same diagnostics the
      // preview showed, so send the user back to them rather than a dead end.
      setPreview(outcome.data as ImportPreview);
      setError("Some rows still aren't valid. Nothing was imported.");
      return;
    }
    setError(outcome.kind === "error" ? outcome.message : "The import was rejected.");
  }, [request, onImported]);

  // ---- Render -------------------------------------------------------------

  const mappingReady = Boolean(
    mapping.postedDate &&
      (mapping.merchantName || mapping.description) &&
      ((mapping.amount && mapping.amountSignConvention) ||
        (mapping.debitAmount && mapping.creditAmount)),
  );

  return (
    <div className="mx-auto w-full max-w-[820px]">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex items-center gap-1.5 text-label text-ink-secondary hover:text-ink"
        >
          <span aria-hidden="true">←</span> Accounts
        </button>
      )}

      <Steps current={step} />

      {error && (
        <Card className="mt-5 border-l-2 border-l-alert">
          <p className="text-body text-alert">{error}</p>
        </Card>
      )}

      {busy && <p className="mt-5 text-body text-ink-secondary">{busy}</p>}

      {step === "file" && !busy && (
        <FileStep inputRef={fileInput} onPick={(file) => void onPickFile(file)} />
      )}

      {step === "map" && inspection && !busy && (
        <MapStep
          inspection={inspection}
          mapping={mapping}
          onMapping={setMapping}
          dateFormat={dateFormat}
          onDateFormat={setDateFormat}
          account={account}
          onAccount={setAccount}
          extractionWarnings={extractionWarnings}
          ready={mappingReady}
          onBack={() => setStep("file")}
          onNext={() => void runPreview()}
        />
      )}

      {step === "preview" && preview && !busy && (
        <PreviewStep
          preview={preview}
          onBack={() => setStep("map")}
          onCommit={() => void runCommit()}
        />
      )}

      {step === "done" && commit && (
        <DoneStep
          commit={commit}
          onAgain={() => {
            setStep("file");
            setCsv("");
            setInspection(null);
            setPreview(null);
            setCommit(null);
            setMapping({ postedDate: "" });
            setExtractionWarnings([]);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Steps({ current }: { current: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "file", label: "File" },
    { id: "map", label: "Columns" },
    { id: "preview", label: "Check" },
    { id: "done", label: "Done" },
  ];
  const index = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-2 text-meta text-ink-tertiary">
      {steps.map((step, i) => (
        <li key={step.id} className="flex items-center gap-2">
          <span className={i <= index ? "text-ink" : undefined}>
            {i + 1}. {step.label}
          </span>
          {i < steps.length - 1 && <span aria-hidden="true">›</span>}
        </li>
      ))}
    </ol>
  );
}

function FileStep({
  inputRef,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: (file: File) => void;
}) {
  return (
    <Card className="mt-6">
      <p className="font-display text-[1.35rem] font-medium text-ink">Import a statement</p>
      <p className="mt-2 max-w-[56ch] text-body text-ink-secondary">
        Export a CSV from your bank and choose it here. PDF statements work too when the assistant
        is configured — it transcribes the rows, and they go through exactly the same checks as a
        CSV before anything is imported.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,.pdf,application/pdf"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-5 min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse"
        style={{ background: "var(--accent)" }}
      >
        Choose a file
      </button>

      <p className="mt-5 text-meta leading-relaxed text-ink-tertiary">
        Your statement is sent to the local API on your own machine and stored outside this project.
        Nothing is uploaded anywhere else, and the raw file is never kept.
      </p>
    </Card>
  );
}

function MapStep({
  inspection,
  mapping,
  onMapping,
  dateFormat,
  onDateFormat,
  account,
  onAccount,
  extractionWarnings,
  ready,
  onBack,
  onNext,
}: {
  inspection: CsvColumnInspection;
  mapping: ColumnMapping;
  onMapping: (next: ColumnMapping) => void;
  dateFormat: "iso" | "mm/dd/yyyy";
  onDateFormat: (next: "iso" | "mm/dd/yyyy") => void;
  account: AccountDraft;
  onAccount: (next: AccountDraft) => void;
  extractionWarnings: string[];
  ready: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const set = (patch: Partial<ColumnMapping>) => onMapping({ ...mapping, ...patch });
  const useDebitCredit = Boolean(mapping.debitAmount || mapping.creditAmount);

  return (
    <>
      {extractionWarnings.length > 0 && (
        <Card className="mt-6">
          <SectionLabel>The transcription wasn't certain about</SectionLabel>
          <ul className="mt-2 space-y-1 text-body text-ink-secondary">
            {extractionWarnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <SectionLabel>Which account is this?</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              className="input"
              value={account.displayName}
              placeholder="Everyday Checking"
              onChange={(e) => onAccount({ ...account, displayName: e.target.value })}
            />
          </Field>
          <Field label="Bank">
            <input
              className="input"
              value={account.institutionName}
              placeholder="First National"
              onChange={(e) => onAccount({ ...account, institutionName: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <select
              className="input"
              value={account.type}
              onChange={(e) =>
                onAccount({ ...account, type: e.target.value as AccountDescriptor["type"] })
              }
            >
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
              <option value="credit_card">Credit card</option>
              <option value="cash">Cash</option>
            </select>
          </Field>
          <Field label="Current balance (optional)">
            <input
              className="input"
              inputMode="decimal"
              value={account.balance}
              placeholder="4123.00"
              onChange={(e) => onAccount({ ...account, balance: e.target.value })}
            />
          </Field>

          {/* The statement period is the view this product exists for, and it
              needs exactly one number a CSV never contains. */}
          {account.type === "credit_card" && (
            <Field label="Statement closing day">
              <input
                className="input"
                inputMode="numeric"
                value={account.closingDay}
                placeholder="18"
                onChange={(e) => onAccount({ ...account, closingDay: e.target.value })}
              />
              <p className="mt-1.5 text-meta text-ink-tertiary">
                The day of the month your card closes. This turns on the statement view, where the
                total matches the bill you actually pay instead of the calendar month.
              </p>
            </Field>
          )}
        </div>
      </Card>

      <Card className="mt-5">
        <div className="flex items-baseline justify-between">
          <SectionLabel>Match your columns</SectionLabel>
          <span className="text-meta text-ink-tertiary">{inspection.rowCount} rows found</span>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Date" required>
            <ColumnSelect
              headers={inspection.headers}
              value={mapping.postedDate}
              onChange={(value) => set({ postedDate: value })}
            />
          </Field>
          <Field label="Date format" required>
            <select
              className="input"
              value={dateFormat}
              onChange={(e) => onDateFormat(e.target.value as "iso" | "mm/dd/yyyy")}
            >
              <option value="iso">2026-07-18</option>
              <option value="mm/dd/yyyy">07/18/2026</option>
            </select>
          </Field>

          {!useDebitCredit ? (
            <>
              <Field label="Amount" required>
                <ColumnSelect
                  headers={inspection.headers}
                  value={mapping.amount ?? ""}
                  onChange={(value) => set({ amount: value || undefined })}
                />
              </Field>
              <Field label="A purchase appears as" required>
                <select
                  className="input"
                  value={mapping.amountSignConvention ?? ""}
                  onChange={(e) =>
                    set({
                      amountSignConvention:
                        (e.target.value as ColumnMapping["amountSignConvention"]) || undefined,
                    })
                  }
                >
                  <option value="">Choose…</option>
                  <option value="outflow_positive">A positive number (24.99)</option>
                  <option value="signed">A negative number (−24.99)</option>
                </select>
                {/* No default, deliberately: banks disagree, and getting this
                    backwards turns income into spending. */}
                <p className="mt-1.5 text-meta text-ink-tertiary">
                  Check a purchase in the sample below. There's no default — banks disagree, and
                  getting this backwards would turn your pay into spending.
                </p>
              </Field>
            </>
          ) : (
            <>
              <Field label="Money out" required>
                <ColumnSelect
                  headers={inspection.headers}
                  value={mapping.debitAmount ?? ""}
                  onChange={(value) => set({ debitAmount: value || undefined })}
                />
              </Field>
              <Field label="Money in" required>
                <ColumnSelect
                  headers={inspection.headers}
                  value={mapping.creditAmount ?? ""}
                  onChange={(value) => set({ creditAmount: value || undefined })}
                />
              </Field>
            </>
          )}

          {OPTIONAL_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <ColumnSelect
                headers={inspection.headers}
                value={(mapping[field.key] as string | undefined) ?? ""}
                onChange={(value) => set({ [field.key]: value || undefined })}
              />
            </Field>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            useDebitCredit
              ? onMapping({ ...mapping, debitAmount: undefined, creditAmount: undefined })
              : onMapping({ ...mapping, amount: undefined, amountSignConvention: undefined })
          }
          className="mt-4 text-label text-accent underline underline-offset-4"
        >
          {useDebitCredit
            ? "My statement has one amount column instead"
            : "My statement has separate debit and credit columns"}
        </button>

        <p className="mt-4 text-meta text-ink-tertiary">
          Map either a merchant or a description — the rest are optional.
        </p>
      </Card>

      {inspection.sampleRows.length > 0 && (
        <SamplePreview inspection={inspection} />
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack} className="text-label text-ink-secondary">
          Back
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={onNext}
          className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          Check these rows
        </button>
      </div>
    </>
  );
}

function SamplePreview({ inspection }: { inspection: CsvColumnInspection }) {
  return (
    <div className="mt-5">
      <SectionLabel>From your file</SectionLabel>
      <Card padded={false} className="overflow-x-auto">
        <table className="w-full text-meta">
          <thead>
            <tr className="border-b border-line-subtle">
              {inspection.headers.map((header) => (
                <th key={header} className="whitespace-nowrap px-4 py-2 text-left text-ink-secondary">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inspection.sampleRows.map((row, i) => (
              <tr key={i} className={i ? "border-t border-line-subtle" : ""}>
                {inspection.headers.map((header) => (
                  <td key={header} className="whitespace-nowrap px-4 py-2 text-ink-tertiary">
                    {row[header] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function PreviewStep({
  preview,
  onBack,
  onCommit,
}: {
  preview: ImportPreview;
  onBack: () => void;
  onCommit: () => void;
}) {
  const blocked = preview.errors.length > 0 || preview.validRowCount === 0;

  return (
    <>
      <Card className="mt-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Ready to import" value={preview.validRowCount} emphasis />
          <Stat label="Rows with problems" value={preview.invalidRowCount} />
          <Stat label="Already imported" value={preview.duplicateAlreadyImportedCount} />
          <Stat label="Repeated in file" value={preview.duplicateInFileCount} />
        </div>
      </Card>

      {preview.errors.length > 0 && (
        <IssueList title="These rows can't be imported" issues={preview.errors} />
      )}
      {preview.warnings.length > 0 && (
        <IssueList title="Worth knowing" issues={preview.warnings} />
      )}

      {preview.transactions.length > 0 && (
        <div className="mt-5">
          <SectionLabel>First rows as they'll be saved</SectionLabel>
          <Card padded={false} className="overflow-hidden">
            {preview.transactions.slice(0, 8).map((transaction, i) => (
              <div
                key={transaction.id}
                className={`flex items-baseline justify-between gap-3 px-5 py-3 ${
                  i ? "border-t border-line-subtle" : ""
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink">{transaction.merchantName}</span>
                  <span className="text-meta text-ink-tertiary">
                    {transaction.postedDate}
                    {transaction.categoryDisplayName ? ` · ${transaction.categoryDisplayName}` : ""}
                  </span>
                </span>
                <span className="tabular shrink-0 text-amount text-ink">
                  {transaction.amountCents < 0 ? "−" : "+"}
                  {formatMoney(Math.abs(transaction.amountCents))}
                </span>
              </div>
            ))}
          </Card>
          <p className="mt-2 text-meta text-ink-tertiary">
            Check the signs: purchases should show a minus, pay should show a plus. If they're
            reversed, go back and flip how a purchase appears.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack} className="text-label text-ink-secondary">
          Back to columns
        </button>
        <button
          type="button"
          disabled={blocked}
          onClick={onCommit}
          className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          Import {preview.validRowCount} rows
        </button>
      </div>
    </>
  );
}

function DoneStep({ commit, onAgain }: { commit: ImportCommit; onAgain: () => void }) {
  return (
    <Card className="mt-6">
      <p className="text-heading text-ink">Imported {commit.importedTransactionCount} transactions</p>
      <p className="mt-2 text-body text-ink-secondary">
        You now have {commit.storedTransactionCount} transactions saved. Spending, Transactions,
        Insights, and Accounts are all reading them.
      </p>
      <button
        type="button"
        onClick={onAgain}
        className="mt-4 text-label text-accent underline underline-offset-4"
      >
        Import another statement
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function IssueList({ title, issues }: { title: string; issues: ImportIssue[] }) {
  return (
    <div className="mt-5">
      <SectionLabel>{title}</SectionLabel>
      <Card padded={false} className="overflow-hidden">
        {issues.slice(0, 12).map((issue, i) => (
          <p key={i} className={`px-5 py-2.5 text-meta text-ink-secondary ${i ? "border-t border-line-subtle" : ""}`}>
            {issue.rowNumber !== undefined && (
              <span className="text-ink-tertiary">Row {issue.rowNumber}: </span>
            )}
            {issue.message}
          </p>
        ))}
        {issues.length > 12 && (
          <p className="border-t border-line-subtle px-5 py-2.5 text-meta text-ink-tertiary">
            and {issues.length - 12} more
          </p>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-label text-ink-tertiary">{label}</p>
      <p className={`numeral mt-1 ${emphasis ? "text-figure text-ink" : "text-amount text-ink-secondary"}`}>
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-label text-ink-secondary">
        {label}
        {required && <span className="text-ink-tertiary"> ·  required</span>}
      </span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

function ColumnSelect({
  headers,
  value,
  onChange,
}: {
  headers: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not in my file</option>
      {headers.map((header) => (
        <option key={header} value={header}>
          {header}
        </option>
      ))}
    </select>
  );
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "imported";
}

/** Dollars typed by a person to integer minor units. Not a financial
 *  calculation — a unit conversion on one field the user typed. */
function dollarsToCents(input: string): number | undefined {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * 100) : undefined;
}
