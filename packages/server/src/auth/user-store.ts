/**
 * User persistence. A thin, intention-revealing layer over a key-value store so
 * the rest of the auth code never touches storage details, and swapping in a
 * real database later means reimplementing this one class.
 */
import type { KeyValueStore } from "./json-store";
import { normalizeEmail } from "./types";
import type { User } from "./types";

export interface UserStore {
  create(user: User): Promise<User>;
  getById(id: string): Promise<User | undefined>;
  getByEmail(email: string): Promise<User | undefined>;
  list(): Promise<User[]>;
  update(id: string, patch: Partial<Omit<User, "id">>): Promise<User | undefined>;
  /** Permanently remove a user record. Idempotent — deleting an unknown id is a
   *  no-op, so a double call can't fail. */
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

export class KeyValueUserStore implements UserStore {
  constructor(private readonly kv: KeyValueStore<User>) {}

  async create(user: User): Promise<User> {
    const existing = await this.getByEmail(user.email);
    if (existing) {
      const error = new Error("EMAIL_TAKEN");
      error.name = "EmailTakenError";
      throw error;
    }
    await this.kv.put(user.id, user);
    return user;
  }

  getById(id: string): Promise<User | undefined> {
    return this.kv.get(id);
  }

  async getByEmail(email: string): Promise<User | undefined> {
    const normalized = normalizeEmail(email);
    const all = await this.kv.all();
    return all.find((user) => user.email === normalized);
  }

  list(): Promise<User[]> {
    return this.kv.all();
  }

  async update(id: string, patch: Partial<Omit<User, "id">>): Promise<User | undefined> {
    const current = await this.kv.get(id);
    if (!current) return undefined;
    const next: User = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    await this.kv.put(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(id);
  }

  async count(): Promise<number> {
    return (await this.kv.all()).length;
  }
}
