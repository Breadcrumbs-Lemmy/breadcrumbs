/**
 * Per-user isolation for savings goals — the same seam as the statement
 * store.
 *
 * A handler resolves the store for its authenticated principal via
 * `forUser(userId)` and can never reach another user's goals, so cross-user reads
 * are impossible by construction rather than by remembering a filter. When a
 * database replaces the JSON files, a `PgGoalStoreProvider` slots in here and
 * nothing above it changes.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { FieldCipher } from "../crypto/field-cipher";
import { FileGoalStore, InMemoryGoalStore } from "./goal-store";
import type { GoalStore } from "./goal-store";
import { defaultLocalDataDir } from "./store-provider";

export interface GoalStoreProvider {
  forUser(userId: string): GoalStore | Promise<GoalStore>;
  /** Permanently remove a user's goals. Optional so a bare single-user provider
   *  can decline; account deletion calls it best-effort. */
  eraseForUser?(userId: string): Promise<void>;
}

/** Every user shares one store. Correct only in single-user mode or tests that
 *  never authenticate as more than one user. */
export class SingleGoalStoreProvider implements GoalStoreProvider {
  constructor(private readonly store: GoalStore) {}
  forUser(): GoalStore {
    return this.store;
  }
}

/** One in-memory store per user, created on first use. For tests and ephemeral
 *  runs; nothing survives a restart. */
export class InMemoryGoalStoreProvider implements GoalStoreProvider {
  private readonly stores = new Map<string, InMemoryGoalStore>();
  forUser(userId: string): GoalStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new InMemoryGoalStore();
      this.stores.set(userId, store);
    }
    return store;
  }
  async eraseForUser(userId: string): Promise<void> {
    this.stores.delete(userId);
  }
}

/** One JSON file per user at `<dataDir>/users/<userId>/goals.json`, next to that
 *  user's statement store. When a cipher is supplied every user's
 *  goals are encrypted at rest with it. */
export class FileGoalStoreProvider implements GoalStoreProvider {
  private readonly cache = new Map<string, FileGoalStore>();
  constructor(
    private readonly dataDir: string = defaultLocalDataDir(),
    private readonly cipher?: FieldCipher,
  ) {}
  forUser(userId: string): GoalStore {
    const key = safeUserDir(userId);
    let store = this.cache.get(key);
    if (!store) {
      store = new FileGoalStore(join(this.dataDir, "users", key, "goals.json"), this.cipher);
      this.cache.set(key, store);
    }
    return store;
  }
  /** Drop the cached store and remove the goals file. The statement store's
   *  eraser removes the whole `users/<key>/` directory, which would take this
   *  file with it, but clearing the cache here means a re-created store re-reads
   *  an empty set rather than serving a stale in-process copy. Best-effort: a
   *  missing file is fine (`force`). */
  async eraseForUser(userId: string): Promise<void> {
    const key = safeUserDir(userId);
    this.cache.delete(key);
    await rm(join(this.dataDir, "users", key, "goals.json"), { force: true });
  }
}

/** userIds are `usr_<uuid>` / `usr_owner`, but a path is never built from
 *  unvalidated input — strip anything that could escape the per-user directory.
 *  Kept in step with `safeUserDir` in store-provider.ts. */
function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
