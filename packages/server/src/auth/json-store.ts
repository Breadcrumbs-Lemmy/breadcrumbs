/**
 * A tiny durable JSON map, shared by the user and session stores.
 *
 * It exists so identity persistence follows the same "in-memory for tests, a
 * JSON file under ~/.breadcrumbz for local use" shape the statement import store
 * already established — one persistence idea in the codebase, not three. When a
 * real database is connected later, only these stores are reimplemented; every
 * caller is written against the interfaces above them, not this file.
 */
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-file";

export interface KeyValueStore<T> {
  all(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryKeyValueStore<T> implements KeyValueStore<T> {
  private readonly map = new Map<string, T>();

  async all(): Promise<T[]> {
    return [...this.map.values()].map((value) => structuredClone(value));
  }
  async get(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async put(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class FileKeyValueStore<T> implements KeyValueStore<T> {
  /** Serialises writes so two near-simultaneous saves cannot interleave a
   *  read-modify-write and lose one of them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async all(): Promise<T[]> {
    return Object.values(await this.read());
  }
  async get(key: string): Promise<T | undefined> {
    return (await this.read())[key];
  }
  put(key: string, value: T): Promise<void> {
    return this.mutate((map) => {
      map[key] = value;
    });
  }
  delete(key: string): Promise<void> {
    return this.mutate((map) => {
      delete map[key];
    });
  }

  private async read(): Promise<Record<string, T>> {
    const parsed = await readJsonFile<unknown>(this.filePath, {});
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  }

  private mutate(apply: (map: Record<string, T>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const map = await this.read();
      apply(map);
      // Crash-safe (temp-write-then-rename) and mode 0600 — these files hold
      // session hashes and Plaid access tokens, so they must not be readable by
      // other OS users. See persistence/atomic-file.
      await writeJsonFileAtomic(this.filePath, map);
    });
    // Keep the chain alive even if this write throws, or a single failure would
    // wedge every future write behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
