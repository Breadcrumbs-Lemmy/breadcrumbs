/**
 * Per-user isolation for imported financial data.
 *
 * The store interface stayed exactly as it was — one user's `load()` and
 * `saveImport()`. Isolation is achieved by giving each user their *own* store
 * instance, resolved from the authenticated principal on every request, instead
 * of threading a userId through every domain call. A handler can only ever reach
 * the store for `request.principal.userId`, so cross-user reads are impossible
 * by construction, not by remembering to add a `WHERE user_id = ?`.
 *
 * When a database replaces the JSON files, this is the seam: a `PgStoreProvider`
 * returns a store bound to a userId, and nothing above it changes.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { FileStatementImportStore, InMemoryStatementImportStore } from "./store";
import type { StatementImportStore } from "./store";

export interface StatementImportStoreProvider {
  forUser(userId: string): StatementImportStore | Promise<StatementImportStore>;
}

/** Every user shares one store. Correct only in single-user mode or tests that
 *  never authenticate as more than one user. */
export class SingleStatementImportStoreProvider implements StatementImportStoreProvider {
  constructor(private readonly store: StatementImportStore) {}
  forUser(): StatementImportStore {
    return this.store;
  }
}

/** One in-memory store per user, created on first use. For tests and ephemeral
 *  runs; nothing survives a restart. */
export class InMemoryStatementImportStoreProvider implements StatementImportStoreProvider {
  private readonly stores = new Map<string, InMemoryStatementImportStore>();
  forUser(userId: string): StatementImportStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new InMemoryStatementImportStore();
      this.stores.set(userId, store);
    }
    return store;
  }
}

/** One JSON file per user under `<dataDir>/users/<userId>/`. */
export class FileStatementImportStoreProvider implements StatementImportStoreProvider {
  private readonly cache = new Map<string, FileStatementImportStore>();
  constructor(private readonly dataDir: string = defaultLocalDataDir()) {}
  forUser(userId: string): StatementImportStore {
    const key = safeUserDir(userId);
    let store = this.cache.get(key);
    if (!store) {
      store = new FileStatementImportStore(join(this.dataDir, "users", key, "statement-imports.json"));
      this.cache.set(key, store);
    }
    return store;
  }
}

export function defaultLocalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBS_LOCAL_DATA_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".breadcrumbs", "local-data");
}

/** userIds are `usr_<uuid>` / `usr_owner`, but a path is never built from
 *  unvalidated input — strip anything that could escape the per-user directory. */
function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
