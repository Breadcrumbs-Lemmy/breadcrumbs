import { randomUUID } from "node:crypto";

import { OWNER_USER_ID } from "../auth/types";
import { FileKeyValueStore, type KeyValueStore } from "../auth/json-store";

export type StoredPlaidConnection = {
  connectionId: string;
  /** The user who owns this bank connection. Retrieval routes check the caller
   *  against this, so one user can never read another's accounts even if they
   *  guessed a connectionId. Defaults to the owner in single-user mode. */
  userId: string;
  itemId: string;
  accessToken: string;
  institutionName?: string;
  createdAt: string;
  lastSyncedAt?: string;
};

export interface PlaidTokenStore {
  save(input: { userId?: string; itemId: string; accessToken: string; institutionName?: string }): Promise<StoredPlaidConnection>;
  get(connectionId: string): Promise<StoredPlaidConnection | undefined>;
  listForUser(userId: string): Promise<StoredPlaidConnection[]>;
  markSynced(connectionId: string, at: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

export class InMemoryPlaidTokenStore implements PlaidTokenStore {
  private readonly connections = new Map<string, StoredPlaidConnection>();

  async save(input: {
    userId?: string;
    itemId: string;
    accessToken: string;
    institutionName?: string;
  }): Promise<StoredPlaidConnection> {
    const connection: StoredPlaidConnection = {
      connectionId: `plaid_conn_${randomUUID()}`,
      userId: input.userId ?? OWNER_USER_ID,
      itemId: input.itemId,
      accessToken: input.accessToken,
      institutionName: input.institutionName,
      createdAt: new Date().toISOString(),
    };
    this.connections.set(connection.connectionId, connection);
    return { ...connection };
  }

  async get(connectionId: string): Promise<StoredPlaidConnection | undefined> {
    const found = this.connections.get(connectionId);
    return found ? { ...found } : undefined;
  }

  async listForUser(userId: string): Promise<StoredPlaidConnection[]> {
    return [...this.connections.values()].filter((c) => c.userId === userId).map((c) => ({ ...c }));
  }

  async markSynced(connectionId: string, at: string): Promise<void> {
    const found = this.connections.get(connectionId);
    if (found) found.lastSyncedAt = at;
  }

  async delete(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }
}

/**
 * Durable token store: one JSON file, keyed by connectionId, holding every
 * user's bank connections. This is what makes a linked bank survive a restart —
 * the in-memory store above loses every access token when the process dies, so a
 * production box that used it would silently un-link every user's bank on each
 * deploy. Built on the same atomic, write-serialised `FileKeyValueStore` the
 * auth stores use (crash-safe temp-write-then-rename, file mode 0600), so the
 * access tokens — bearer credentials to a real bank — are not world-readable.
 *
 * The access token is stored as-is because Plaid requires the plaintext value on
 * every call; the file's own permissions and the enclosing data directory are
 * the protection, exactly as a database column would be.
 */
export class FilePlaidTokenStore implements PlaidTokenStore {
  private readonly store: KeyValueStore<StoredPlaidConnection>;

  constructor(filePath: string) {
    this.store = new FileKeyValueStore<StoredPlaidConnection>(filePath);
  }

  async save(input: {
    userId?: string;
    itemId: string;
    accessToken: string;
    institutionName?: string;
  }): Promise<StoredPlaidConnection> {
    const connection: StoredPlaidConnection = {
      connectionId: `plaid_conn_${randomUUID()}`,
      userId: input.userId ?? OWNER_USER_ID,
      itemId: input.itemId,
      accessToken: input.accessToken,
      institutionName: input.institutionName,
      createdAt: new Date().toISOString(),
    };
    await this.store.put(connection.connectionId, connection);
    return { ...connection };
  }

  async get(connectionId: string): Promise<StoredPlaidConnection | undefined> {
    return this.store.get(connectionId);
  }

  async listForUser(userId: string): Promise<StoredPlaidConnection[]> {
    return (await this.store.all()).filter((c) => c.userId === userId);
  }

  async markSynced(connectionId: string, at: string): Promise<void> {
    const found = await this.store.get(connectionId);
    if (!found) return;
    found.lastSyncedAt = at;
    await this.store.put(connectionId, found);
  }

  async delete(connectionId: string): Promise<void> {
    await this.store.delete(connectionId);
  }
}
