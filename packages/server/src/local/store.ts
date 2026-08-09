import type { Account, Transaction } from "@ai-fin-os/core";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-file";

export type StatementImportBatch = {
  id: string;
  accountId: string;
  /** How the rows arrived. `csv` is a hand-imported statement; `plaid` is a
   *  bank sync. Both land in the same store and dedupe by transaction id, so the
   *  spending screens read one merged history regardless of source. */
  sourceFormat: "csv" | "plaid";
  createdAt: string;
  rowCount: number;
  importedTransactionCount: number;
  duplicateTransactionCount: number;
  invalidRowCount: number;
  rawCsvStored: false;
};

export type StatementImportState = {
  accounts: Account[];
  transactions: Transaction[];
  importBatches: StatementImportBatch[];
};

export type SaveStatementImportInput = {
  account: Account;
  transactions: Transaction[];
  batch: Omit<StatementImportBatch, "importedTransactionCount" | "duplicateTransactionCount">;
  knownDuplicateTransactionCount?: number;
};

export type SaveStatementImportResult = {
  state: StatementImportState;
  batch: StatementImportBatch;
  importedTransactions: Transaction[];
  duplicateTransactions: Transaction[];
};

export interface StatementImportStore {
  load(): Promise<StatementImportState>;
  saveImport(input: SaveStatementImportInput): Promise<SaveStatementImportResult>;
}

const EMPTY_STATE: StatementImportState = {
  accounts: [],
  transactions: [],
  importBatches: [],
};

export class InMemoryStatementImportStore implements StatementImportStore {
  private state: StatementImportState;

  constructor(initialState: StatementImportState = EMPTY_STATE) {
    this.state = cloneState(initialState);
  }

  async load(): Promise<StatementImportState> {
    return cloneState(this.state);
  }

  async saveImport(input: SaveStatementImportInput): Promise<SaveStatementImportResult> {
    const result = saveToState(this.state, input);
    this.state = result.state;
    return result;
  }
}

export class FileStatementImportStore implements StatementImportStore {
  /** Serialises writes so two near-simultaneous imports (e.g. two browser tabs)
   *  cannot interleave their read-modify-write and silently drop one import's
   *  transactions. Same guard the auth/Plaid `FileKeyValueStore` uses. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = defaultStatementImportStorePath()) {}

  async load(): Promise<StatementImportState> {
    // A missing file reads as `{}`, which `normalizeState` turns into a fresh
    // empty state — no shared reference to a module-level constant to mutate.
    return normalizeState(await readJsonFile<Partial<StatementImportState>>(this.filePath, {}));
  }

  saveImport(input: SaveStatementImportInput): Promise<SaveStatementImportResult> {
    const next = this.queue.then(async () => {
      const current = await this.load();
      const result = saveToState(current, input);
      // Crash-safe (temp-write-then-rename) and mode 0600: this is the user's
      // real accounts and transactions. It must survive a mid-write crash intact
      // and never be world-readable. See persistence/atomic-file.
      await writeJsonFileAtomic(this.filePath, result.state);
      return result;
    });
    // Keep the chain alive even if one write throws, so a single failure does
    // not wedge every later import behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function createDefaultStatementImportStore(env: NodeJS.ProcessEnv = process.env): StatementImportStore {
  return new FileStatementImportStore(defaultStatementImportStorePath(env));
}

export function defaultStatementImportStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBS_LOCAL_DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0 ? configured : join(homedir(), ".breadcrumbs", "local-data");
  return join(dataDir, "statement-imports.json");
}

function saveToState(
  state: StatementImportState,
  input: SaveStatementImportInput,
): SaveStatementImportResult {
  const accounts = upsertAccount(state.accounts, input.account);
  const existingTransactionIds = new Set(state.transactions.map((transaction) => transaction.id));
  const importedTransactions: Transaction[] = [];
  const duplicateTransactions: Transaction[] = [];

  for (const transaction of input.transactions) {
    if (existingTransactionIds.has(transaction.id)) {
      duplicateTransactions.push(transaction);
      continue;
    }
    importedTransactions.push(transaction);
    existingTransactionIds.add(transaction.id);
  }

  const batch: StatementImportBatch = {
    ...input.batch,
    importedTransactionCount: importedTransactions.length,
    duplicateTransactionCount: duplicateTransactions.length + (input.knownDuplicateTransactionCount ?? 0),
  };
  const nextState = {
    accounts,
    transactions: [...state.transactions, ...importedTransactions].sort((left, right) => {
      return left.postedDate.localeCompare(right.postedDate) || left.id.localeCompare(right.id);
    }),
    importBatches: [...state.importBatches, batch],
  };

  return {
    state: cloneState(nextState),
    batch,
    importedTransactions: cloneTransactions(importedTransactions),
    duplicateTransactions: cloneTransactions(duplicateTransactions),
  };
}

function upsertAccount(accounts: Account[], account: Account): Account[] {
  const next = accounts.filter((candidate) => candidate.id !== account.id);
  next.push(account);
  return next.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function normalizeState(input: Partial<StatementImportState>): StatementImportState {
  return {
    accounts: Array.isArray(input.accounts) ? input.accounts : [],
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
    importBatches: Array.isArray(input.importBatches) ? input.importBatches : [],
  };
}

function cloneState(state: StatementImportState): StatementImportState {
  return {
    accounts: state.accounts.map((account) => ({ ...account })),
    transactions: cloneTransactions(state.transactions),
    importBatches: state.importBatches.map((batch) => ({ ...batch })),
  };
}

function cloneTransactions(transactions: Transaction[]): Transaction[] {
  return transactions.map((transaction) => ({
    ...transaction,
    freshness: {
      ...transaction.freshness,
      warnings: transaction.freshness.warnings.map((warning) => ({ ...warning })),
    },
    uncertainty: { ...transaction.uncertainty },
    recurrenceSignal: transaction.recurrenceSignal ? { ...transaction.recurrenceSignal } : undefined,
  }));
}
