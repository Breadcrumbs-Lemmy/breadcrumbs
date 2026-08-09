/**
 * Assemble an `AuthService` with the right persistence for the situation.
 *
 * One place decides in-memory vs. file-backed identity, so `createServer` and
 * any test can ask for a service without repeating the store wiring. `file`
 * puts users and sessions under the same `~/.breadcrumbs` data dir the
 * statement store already uses; `memory` keeps everything per-process for tests.
 */
import { join } from "node:path";

import type { AuthConfig } from "./config";
import { FileKeyValueStore, InMemoryKeyValueStore } from "./json-store";
import { KeyValueSessionStore } from "./session-store";
import { AuthService } from "./service";
import type { Session, User } from "./types";
import { KeyValueUserStore } from "./user-store";
import { defaultLocalDataDir } from "../local/store-provider";

export type AuthPersistence = "memory" | "file";

export function buildAuthService(
  config: AuthConfig,
  opts: { persistence?: AuthPersistence; dataDir?: string } = {},
): AuthService {
  const persistence = opts.persistence ?? "file";
  if (persistence === "memory") {
    return new AuthService({
      users: new KeyValueUserStore(new InMemoryKeyValueStore<User>()),
      sessions: new KeyValueSessionStore(new InMemoryKeyValueStore<Session>()),
      config,
    });
  }

  const dir = join(opts.dataDir ?? defaultLocalDataDir(), "auth");
  return new AuthService({
    users: new KeyValueUserStore(new FileKeyValueStore<User>(join(dir, "users.json"))),
    sessions: new KeyValueSessionStore(new FileKeyValueStore<Session>(join(dir, "sessions.json"))),
    config,
  });
}
