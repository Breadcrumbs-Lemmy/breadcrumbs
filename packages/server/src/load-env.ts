/**
 * Load environment variables before any other module initialises.
 *
 * The server is started as `tsx src/main.ts` (see package.json `dev`), which
 * runs with `cwd = packages/server`. A bare `import "dotenv/config"` resolves
 * `.env` against that cwd, so it only ever finds `packages/server/.env` — which
 * does not exist — and silently misses the repo-root `.env` where the shared
 * config lives (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, …). The API then
 * boots with Plaid unconfigured even though the keys are right there at the root,
 * and the Accounts screen shows "Plaid not configured yet".
 *
 * This module fixes that at the source: it loads a cwd-local `.env` first (to
 * preserve the previous behaviour for anyone who relies on it), then walks up
 * from this file to the workspace root (marked by `pnpm-workspace.yaml`) and
 * loads the root `.env`. dotenv never overrides an already-set variable, so
 * precedence is: real process env (inline / docker-compose / scratch launches) >
 * cwd `.env` > root `.env`. Import it FIRST in main.ts so the env is populated
 * before any module reads `process.env`.
 */
import { config as loadEnvFile } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 1. A cwd-local .env keeps its previous precedence (loaded first; dotenv will
//    not override these when the root .env is loaded next).
loadEnvFile();

// 2. Walk up to the workspace root and load its .env. Resolving from this
//    module's own location (not cwd) is what makes the load cwd-independent.
const startDir = dirname(fileURLToPath(import.meta.url));
let dir = startDir;
for (let hops = 0; hops < 12; hops += 1) {
  if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    loadEnvFile({ path: resolve(dir, ".env") });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break; // reached the filesystem root
  dir = parent;
}
