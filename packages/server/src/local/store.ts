import type { Account, Transaction } from "@ai-fin-os/core";
import { homedir } from "node:os";
import { join } from "node:path";

import { FieldCipher } from "../crypto/field-cipher";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-file";

/** On disk, an encrypted state file is `{ "$enc": "bcenc1:…" }` — the whole
 *  serialized state sealed as one blob. A legacy file is the bare state object
 *  (no `$enc`), so the two are told apart by this key's presence. */
type EncryptedStateEnvelope = { $enc: string };

/** Domain-separation label bound as GCM additional data, so a state blob can
 *  never be decrypted as if it were some other kind of encrypted field. */
const STATE_AAD = "statement-import-state";

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
  /**
   * Plaid `/transactions/sync` deltas. A bank sync is not append-only the way a
   * CSV import is: an already-imported transaction can change (a pending charge
   * settles at a different amount, a merchant name resolves) or disappear (a
   * pending charge is dropped). `modifiedTransactions` upserts by id — it
   * replaces the stored row, or inserts it if unseen, exactly as Plaid instructs
   * clients to treat added and modified alike. `removedTransactionIds` deletes by
   * id. CSV import passes neither, so its append-and-dedupe behaviour is byte-for-
   * byte unchanged.
   */
  modifiedTransactions?: Transaction[];
  removedTransactionIds?: string[];
};

export type SaveStatementImportResult = {
  state: StatementImportState;
  batch: StatementImportBatch;
  importedTransactions: Transaction[];
  duplicateTransactions: Transaction[];
  /** Upserted rows (from `modifiedTransactions`). Empty for a CSV import. */
  modifiedTransactions: Transaction[];
  /** Ids that were present and are now deleted (from `removedTransactionIds`).
   *  A requested id that was not in the store is silently skipped, so this lists
   *  only what actually changed. Empty for a CSV import. */
  removedTransactionIds: string[];
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

  constructor(
    private readonly filePath = defaultStatementImportStorePath(),
    /** When set, the whole state blob (accounts, transactions, batches) is
     *  encrypted at rest. Absent = prior plaintext behaviour. */
    private readonly cipher?: FieldCipher,
  ) {}

  async load(): Promise<StatementImportState> {
    // A missing file reads as `{}`, which `normalizeState` turns into a fresh
    // empty state — no shared reference to a module-level constant to mutate.
    const raw = await readJsonFile<Partial<StatementImportState> & Partial<EncryptedStateEnvelope>>(this.filePath, {});
    if (raw && typeof raw === "object" && typeof (raw as EncryptedStateEnvelope).$enc === "string") {
      // The file is encrypted. Without a key we cannot — and must not silently
      // pretend to — read it; fail loudly rather than returning empty state and
      // letting the next import overwrite the user's real history.
      if (!this.cipher) {
        throw new Error(
          "Statement store is encrypted but no encryption key is configured (BREADCRUMBZ_ENCRYPTION_KEY).",
        );
      }
      const plaintext = this.cipher.decrypt((raw as EncryptedStateEnvelope).$enc, STATE_AAD);
      return normalizeState(JSON.parse(plaintext) as Partial<StatementImportState>);
    }
    // No `$enc` key: a legacy plaintext state file (or empty). Readable whether
    // or not a cipher is configured; a cipher re-seals it on the next write.
    return normalizeState(raw as Partial<StatementImportState>);
  }

  saveImport(input: SaveStatementImportInput): Promise<SaveStatementImportResult> {
    const next = this.queue.then(async () => {
      const current = await this.load();
      const result = saveToState(current, input);
      await this.persist(result.state);
      return result;
    });
    // Keep the chain alive even if one write throws, so a single failure does
    // not wedge every later import behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Write the state, encrypting the whole blob when a cipher is configured.
   *  Crash-safe (temp-write-then-rename) and mode 0600 either way: this is the
   *  user's real accounts and transactions, so it must survive a mid-write crash
   *  intact and never be world-readable. See persistence/atomic-file. */
  private async persist(state: StatementImportState): Promise<void> {
    const payload: StatementImportState | EncryptedStateEnvelope = this.cipher
      ? { $enc: this.cipher.encrypt(JSON.stringify(state), STATE_AAD) }
      : state;
    await writeJsonFileAtomic(this.filePath, payload);
  }
}

export function createDefaultStatementImportStore(
  env: NodeJS.ProcessEnv = process.env,
  cipher?: FieldCipher,
): StatementImportStore {
  return new FileStatementImportStore(defaultStatementImportStorePath(env), cipher);
}

export function defaultStatementImportStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBZ_LOCAL_DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0 ? configured : join(homedir(), ".breadcrumbz", "local-data");
  return join(dataDir, "statement-imports.json");
}

function saveToState(
  state: StatementImportState,
  input: SaveStatementImportInput,
): SaveStatementImportResult {
  const accounts = upsertAccount(state.accounts, input.account);

  // 1. Removals first, so a remove-then-re-add of the same id in one batch does
  //    not fight itself. Only ids actually present are reported as removed.
  const removedIds = new Set(input.removedTransactionIds ?? []);
  const removedTransactionIds: string[] = [];
  let working = state.transactions.filter((transaction) => {
    if (removedIds.has(transaction.id)) {
      removedTransactionIds.push(transaction.id);
      return false;
    }
    return true;
  });

  // 2. Additions: append, deduping by id against what survives the removal pass.
  const existingTransactionIds = new Set(working.map((transaction) => transaction.id));
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
  working = [...working, ...importedTransactions];

  // 3. Modifications: upsert by id (replace in place, or insert if unseen).
  const modifiedTransactions: Transaction[] = [];
  if (input.modifiedTransactions && input.modifiedTransactions.length > 0) {
    const byId = new Map(working.map((transaction) => [transaction.id, transaction]));
    for (const transaction of input.modifiedTransactions) {
      byId.set(transaction.id, transaction);
      modifiedTransactions.push(transaction);
    }
    working = [...byId.values()];
  }

  const batch: StatementImportBatch = {
    ...input.batch,
    importedTransactionCount: importedTransactions.length,
    duplicateTransactionCount: duplicateTransactions.length + (input.knownDuplicateTransactionCount ?? 0),
  };
  const nextState = {
    accounts,
    transactions: working.sort((left, right) => {
      return left.postedDate.localeCompare(right.postedDate) || left.id.localeCompare(right.id);
    }),
    importBatches: [...state.importBatches, batch],
  };

  return {
    state: cloneState(nextState),
    batch,
    importedTransactions: cloneTransactions(importedTransactions),
    duplicateTransactions: cloneTransactions(duplicateTransactions),
    modifiedTransactions: cloneTransactions(modifiedTransactions),
    removedTransactionIds: [...removedTransactionIds],
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
