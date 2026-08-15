/**
 * Per-user isolation for budgets — the same seam as the statement store.
 *
 * A handler resolves the store for its authenticated principal via
 * `forUser(userId)` and can never reach another user's budgets, so cross-user
 * reads are impossible by construction rather than by remembering a filter. When
 * a database replaces the JSON files, a `PgBudgetStoreProvider` slots in here and
 * nothing above it changes.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { FieldCipher } from "../crypto/field-cipher";
import { FileBudgetStore, InMemoryBudgetStore } from "./budget-store";
import type { BudgetStore } from "./budget-store";
import { defaultLocalDataDir } from "./store-provider";

export interface BudgetStoreProvider {
  forUser(userId: string): BudgetStore | Promise<BudgetStore>;
  /** Permanently remove a user's budgets. Optional so a bare single-user
   *  provider can decline; account deletion calls it best-effort. */
  eraseForUser?(userId: string): Promise<void>;
}

/** Every user shares one store. Correct only in single-user mode or tests that
 *  never authenticate as more than one user. */
export class SingleBudgetStoreProvider implements BudgetStoreProvider {
  constructor(private readonly store: BudgetStore) {}
  forUser(): BudgetStore {
    return this.store;
  }
}

/** One in-memory store per user, created on first use. For tests and ephemeral
 *  runs; nothing survives a restart. */
export class InMemoryBudgetStoreProvider implements BudgetStoreProvider {
  private readonly stores = new Map<string, InMemoryBudgetStore>();
  forUser(userId: string): BudgetStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new InMemoryBudgetStore();
      this.stores.set(userId, store);
    }
    return store;
  }
  async eraseForUser(userId: string): Promise<void> {
    this.stores.delete(userId);
  }
}

/** One JSON file per user at `<dataDir>/users/<userId>/budgets.json`, next to
 *  that user's statement store. When a cipher is supplied every user's budgets
 *  are encrypted at rest with it. */
export class FileBudgetStoreProvider implements BudgetStoreProvider {
  private readonly cache = new Map<string, FileBudgetStore>();
  constructor(
    private readonly dataDir: string = defaultLocalDataDir(),
    private readonly cipher?: FieldCipher,
  ) {}
  forUser(userId: string): BudgetStore {
    const key = safeUserDir(userId);
    let store = this.cache.get(key);
    if (!store) {
      store = new FileBudgetStore(join(this.dataDir, "users", key, "budgets.json"), this.cipher);
      this.cache.set(key, store);
    }
    return store;
  }
  /** Drop the cached store and remove the budgets file. The statement store's
   *  eraser removes the whole `users/<key>/` directory, which would take this
   *  file with it, but clearing the cache here means a re-created store re-reads
   *  an empty set rather than serving a stale in-process copy. Best-effort: a
   *  missing file is fine (`force`). */
  async eraseForUser(userId: string): Promise<void> {
    const key = safeUserDir(userId);
    this.cache.delete(key);
    await rm(join(this.dataDir, "users", key, "budgets.json"), { force: true });
  }
}

/** userIds are `usr_<uuid>` / `usr_owner`, but a path is never built from
 *  unvalidated input — strip anything that could escape the per-user directory.
 *  Kept in step with `safeUserDir` in store-provider.ts. */
function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
