/**
 * Per-user isolation for net-worth snapshots — the same seam the statement
 * import store uses (`store-provider.ts`): each user gets their *own* store
 * instance, resolved from the authenticated principal on every request, so a
 * handler can only ever reach the snapshots for `request.principal.userId` and
 * cross-user reads are impossible by construction.
 *
 * The per-user file lives under the same `users/<id>/` directory as that user's
 * imported statements, so deleting the account (which removes that whole
 * directory) erases these snapshots too; `eraseForUser` is still wired
 * explicitly so the in-memory path and any future layout stay correct.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { FieldCipher } from "../crypto/field-cipher";
import { FileNetWorthSnapshotStore, InMemoryNetWorthSnapshotStore } from "./net-worth-store";
import type { NetWorthSnapshotStore } from "./net-worth-store";
import { defaultLocalDataDir } from "./store-provider";

export interface NetWorthSnapshotStoreProvider {
  forUser(userId: string): NetWorthSnapshotStore | Promise<NetWorthSnapshotStore>;
  /** Permanently remove a user's recorded snapshots. Optional so a bare provider
   *  can decline; account deletion calls it best-effort. */
  eraseForUser?(userId: string): Promise<void>;
}

/** One in-memory store per user, created on first use. Tests and ephemeral runs. */
export class InMemoryNetWorthSnapshotProvider implements NetWorthSnapshotStoreProvider {
  private readonly stores = new Map<string, InMemoryNetWorthSnapshotStore>();
  forUser(userId: string): NetWorthSnapshotStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new InMemoryNetWorthSnapshotStore();
      this.stores.set(userId, store);
    }
    return store;
  }
  async eraseForUser(userId: string): Promise<void> {
    this.stores.delete(userId);
  }
}

/** One JSON file per user under `<dataDir>/users/<userId>/net-worth-snapshots.json`.
 *  Encrypts the amounts at rest when a cipher is supplied. */
export class FileNetWorthSnapshotProvider implements NetWorthSnapshotStoreProvider {
  private readonly cache = new Map<string, FileNetWorthSnapshotStore>();
  constructor(
    private readonly dataDir: string = defaultLocalDataDir(),
    private readonly cipher?: FieldCipher,
  ) {}
  forUser(userId: string): NetWorthSnapshotStore {
    const key = safeUserDir(userId);
    let store = this.cache.get(key);
    if (!store) {
      store = new FileNetWorthSnapshotStore(
        join(this.dataDir, "users", key, "net-worth-snapshots.json"),
        this.cipher,
      );
      this.cache.set(key, store);
    }
    return store;
  }
  /** Remove just this user's snapshot file. Best-effort (`force`): a user who
   *  never opened the trend has no file, and the whole `users/<id>/` directory is
   *  also removed by the statement store's eraser. */
  async eraseForUser(userId: string): Promise<void> {
    const key = safeUserDir(userId);
    this.cache.delete(key);
    await rm(join(this.dataDir, "users", key, "net-worth-snapshots.json"), { force: true });
  }
}

/** userIds are `usr_<uuid>` / `usr_owner`, but never build a path from
 *  unvalidated input — strip anything that could escape the per-user directory
 *  (matches `store-provider.ts`). */
function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
