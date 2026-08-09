/**
 * Per-user isolation for the assistant's memory — the same seam the statement
 * store uses. A handler resolves the memory for `request.principal.userId` and
 * can reach no other user's facts, conversations, or uploaded files. Swap in a
 * database later by implementing this one interface.
 */
import { join } from "node:path";

import { defaultLocalDataDir } from "../../local/store-provider";
import { FileAgentMemoryStore, InMemoryAgentMemoryStore } from "./store";
import type { AgentMemoryStore } from "./store";

export interface AgentMemoryProvider {
  forUser(userId: string): AgentMemoryStore | Promise<AgentMemoryStore>;
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
}

function safeUserDir(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}
