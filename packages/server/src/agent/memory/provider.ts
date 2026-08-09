/**
 * Per-user isolation for the assistant's memory — the same seam the statement
 * store uses. A handler resolves the memory for `request.principal.userId` and
 * can reach no other user's facts, conversations, or uploaded files. Swap in a
 * database later by implementing this one interface.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { defaultLocalDataDir } from "../../local/store-provider";
import { FileAgentMemoryStore, InMemoryAgentMemoryStore } from "./store";
import type { AgentMemoryStore } from "./store";

export interface AgentMemoryProvider {
  forUser(userId: string): AgentMemoryStore | Promise<AgentMemoryStore>;
  /** Permanently remove a user's assistant memory (conversations, facts, files).
   *  Optional; account deletion calls it best-effort. */
  eraseForUser?(userId: string): Promise<void>;
}

/** One in-memory memory per user. Tests and ephemeral runs. */
export class InMemoryAgentMemoryProvider implements AgentMemoryProvider {
  private readonly stores = new Map<string, InMemoryAgentMemoryStore>();
  forUser(userId: string): AgentMemoryStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new InMemoryAgentMemoryStore();
      this.stores.set(userId, store);
    }
    return store;
  }
  async eraseForUser(userId: string): Promise<void> {
    this.stores.delete(userId);
  }
}

/** One directory per user under `<dataDir>/users/<userId>/agent-memory/`. */
export class FileAgentMemoryProvider implements AgentMemoryProvider {
  private readonly cache = new Map<string, FileAgentMemoryStore>();
  constructor(private readonly dataDir: string = defaultLocalDataDir()) {}
  forUser(userId: string): AgentMemoryStore {
    const key = safeUserDir(userId);
    let store = this.cache.get(key);
    if (!store) {
      store = new FileAgentMemoryStore(join(this.dataDir, "users", key, "agent-memory"));
      this.cache.set(key, store);
    }
    return store;
  }
  /** Remove the user's assistant-memory directory and drop the cached handle so
   *  a later `forUser` rebuilds against a clean slate. Best-effort. */
  async eraseForUser(userId: string): Promise<void> {
    const key = safeUserDir(userId);
    this.cache.delete(key);
    await rm(join(this.dataDir, "users", key, "agent-memory"), { recursive: true, force: true });
  }
}

function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
