import "./load-env";

import { loadPlaidConfig } from "./plaid/config";
import { loadAuthConfig } from "./auth/config";
import { buildAuthService } from "./auth/build";
import { createServer } from "./http/server";
import { defaultLocalDataDir } from "./local/store-provider";
import { migrateDataDir } from "./persistence/schema-version";

// A crash in an async handler that escaped every try/catch, or a rejected
// promise nobody awaited, leaves the process in an undefined state. Log it and
// exit non-zero so the supervisor (systemd, Docker, a platform) restarts a
// clean process instead of routing traffic to a half-dead one.
process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException:", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

await main();

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  const host = process.env.HOST ?? "127.0.0.1";

  // Bring the on-disk data format up to date before anything reads or writes it
  // — the file-based equivalent of running database migrations at boot. On a
  // fresh install this just stamps a version marker; on an existing one it
  // snapshots the whole data directory and applies any pending migration before
  // the app touches a single file. A newer-than-supported directory stops the
  // boot rather than risk corrupting data written by a later build.
  try {
    const dataDir = defaultLocalDataDir();
    const outcome = await migrateDataDir(dataDir);
    if (outcome.ranMigrations.length > 0) {
      console.log(
        `[data] migrated ${dataDir}: schema v${outcome.fromVersion} → v${outcome.toVersion} ` +
          `(backup at ${outcome.backup?.path ?? "n/a"})`,
      );
    } else if (outcome.backup) {
      console.log(`[data] adopted schema v${outcome.toVersion} for existing data (backup at ${outcome.backup.path})`);
    }
  } catch (error) {
    console.error("[fatal] data directory migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Build identity first so a misconfiguration fails before we bind a port.
  const authConfig = loadAuthConfig();

  // A shared deployment that forgot to switch to multi_user runs with NO login —
  // every request acts as the owner. That is the correct default for a personal
  // single-tenant install, but a loud, unmissable warning in production so it is
  // never an accident on a box that others can reach.
  if (authConfig.mode === "single_user" && process.env.NODE_ENV === "production") {
    console.warn(
      "[auth] WARNING: running in single_user mode in production — NO login is required and " +
        "every request acts as the owner. Set BREADCRUMBS_AUTH_MODE=multi_user for a shared deployment.",
    );
  }

  let plaidConfig;
  try {
    plaidConfig = shouldLoadPlaidConfig(process.env) ? loadPlaidConfig() : undefined;
  } catch (error) {
    // A bad/incomplete Plaid config is a boot-time contract violation, not a
    // runtime blip. Fail fast with a clear message rather than a bare stack.
    console.error("[fatal] invalid Plaid configuration:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const authService = buildAuthService(authConfig, { persistence: "file" });

  // Seed the implicit owner ONLY in single-user mode, where it is the one account
  // the whole app runs as. In multi-user mode, seeding it here would put a
  // passwordless account in the store, making `users.count()` non-zero so the
  // first real registrant is denied the admin role that bootstrap grants — a
  // fresh deployment would then have an admin that cannot log in and no user who
  // can administer. There, the first registrant (or `BREADCRUMBS_OWNER_EMAIL`)
  // becomes admin instead.
  if (authConfig.mode === "single_user") {
    await authService.ensureOwner();
  }

  const server = await createServer({
    plaidConfig,
    authService,
    allowedCorsOrigins: parseCsvEnv(process.env.BREADCRUMBS_CORS_ORIGINS),
  });

  await server.listen({ port, host });
  console.log(`AI Finance OS server listening on http://${host}:${port}`);
  console.log(
    authConfig.mode === "single_user"
      ? "Auth mode: single_user — no login required; every request acts as the owner."
      : "Auth mode: multi_user — a live session is required for every data request.",
  );
}

function shouldLoadPlaidConfig(env: NodeJS.ProcessEnv): boolean {
  if (env.PLAID_ENV && env.PLAID_ENV !== "sandbox") return true;
  return Boolean(env.PLAID_CLIENT_ID?.trim() || env.PLAID_SECRET?.trim());
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
