import { randomUUID } from "node:crypto";

import { OWNER_USER_ID } from "../auth/types";
import { FileKeyValueStore, type KeyValueStore } from "../auth/json-store";
import { FieldCipher } from "../crypto/field-cipher";

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
  /** Opaque Plaid `/transactions/sync` cursor. Absent until the first sync, when
   *  a full history is pulled and the returned `next_cursor` is stored; every
   *  later sync resumes from here and receives only the delta. Not a secret (it
   *  encodes no account data), so it rides alongside the encrypted access token
   *  in plaintext. */
  transactionsCursor?: string;
};

export interface PlaidTokenStore {
  save(input: { userId?: string; itemId: string; accessToken: string; institutionName?: string }): Promise<StoredPlaidConnection>;
  get(connectionId: string): Promise<StoredPlaidConnection | undefined>;
  listForUser(userId: string): Promise<StoredPlaidConnection[]>;
  /** Stamp the last-synced time, and — when a sync ran — persist the new
   *  `/transactions/sync` cursor so the next sync resumes from it. Passing
   *  `undefined` for the cursor leaves the stored one untouched. */
  markSynced(connectionId: string, at: string, cursor?: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
  /** Remove every connection (and its stored access token) belonging to a user.
   *  Used when an account is deleted, so no orphaned bank credential survives. */
  deleteAllForUser(userId: string): Promise<void>;
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

  async markSynced(connectionId: string, at: string, cursor?: string): Promise<void> {
    const found = this.connections.get(connectionId);
    if (!found) return;
    found.lastSyncedAt = at;
    if (cursor !== undefined) found.transactionsCursor = cursor;
  }

  async delete(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    for (const [id, c] of this.connections) {
      if (c.userId === userId) this.connections.delete(id);
    }
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
 * Plaid requires the plaintext token on every call, so it cannot be one-way
 * hashed like a session token. Instead, when a `FieldCipher` is supplied the
 * token is encrypted at rest (AES-256-GCM, bound to its connectionId) and only
 * decrypted in memory when a caller needs it; the key lives in the environment,
 * never in this file. Without a cipher the token is stored as-is, protected by
 * the file's own 0600 permissions and disk encryption — the prior behaviour, so
 * the zero-config path is unchanged. Records written before a cipher was
 * configured stay readable: `FieldCipher.decrypt` passes plaintext through, and
 * each is re-encrypted the next time it is written (e.g. on `markSynced`).
 */
export class FilePlaidTokenStore implements PlaidTokenStore {
  private readonly store: KeyValueStore<StoredPlaidConnection>;

  constructor(
    filePath: string,
    private readonly cipher?: FieldCipher,
  ) {
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
    await this.store.put(connection.connectionId, this.encode(connection));
    // Callers always get the plaintext token back, never the on-disk ciphertext.
    return { ...connection };
  }

  async get(connectionId: string): Promise<StoredPlaidConnection | undefined> {
    const found = await this.store.get(connectionId);
    return found ? this.decode(found) : undefined;
  }

  async listForUser(userId: string): Promise<StoredPlaidConnection[]> {
    return (await this.store.all()).filter((c) => c.userId === userId).map((c) => this.decode(c));
  }

  async markSynced(connectionId: string, at: string, cursor?: string): Promise<void> {
    const found = await this.store.get(connectionId);
    if (!found) return;
    // Round-trip through decode/encode so a legacy plaintext record is migrated
    // to ciphertext on this write, and the token is never left in plaintext.
    const connection = this.decode(found);
    connection.lastSyncedAt = at;
    if (cursor !== undefined) connection.transactionsCursor = cursor;
    await this.store.put(connectionId, this.encode(connection));
  }

  async delete(connectionId: string): Promise<void> {
    await this.store.delete(connectionId);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const mine = (await this.store.all()).filter((c) => c.userId === userId);
    await Promise.all(mine.map((c) => this.store.delete(c.connectionId)));
  }

  /** Encrypt the token for storage, binding it to its connectionId. No-op when
   *  no cipher is configured. */
  private encode(connection: StoredPlaidConnection): StoredPlaidConnection {
    if (!this.cipher) return connection;
    return { ...connection, accessToken: this.cipher.encrypt(connection.accessToken, connection.connectionId) };
  }

  /** Decrypt the token coming off disk. Legacy plaintext passes through
   *  unchanged (see `FieldCipher.decrypt`). No-op when no cipher is configured. */
  private decode(connection: StoredPlaidConnection): StoredPlaidConnection {
    if (!this.cipher) return connection;
    return { ...connection, accessToken: this.cipher.decrypt(connection.accessToken, connection.connectionId) };
  }
}
