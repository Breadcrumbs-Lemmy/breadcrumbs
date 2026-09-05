#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = join(repoRoot, ".env.production.local");

if (!existsSync(profilePath)) {
  console.error(
    "Missing .env.production.local. Create it with your Production PLAID_CLIENT_ID and PLAID_SECRET; " +
      "the regular .env remains the Sandbox profile.",
  );
  process.exit(1);
}

try {
  process.loadEnvFile(profilePath);
} catch (error) {
  console.error(`Could not load ${profilePath}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

const configuredDataDir = process.env.BREADCRUMBZ_LOCAL_DATA_DIR?.trim();
const dataDir = configuredDataDir ? expandHome(configuredDataDir) : join(homedir(), ".breadcrumbz", "production-local");

const child = spawn("pnpm", ["--filter", "@ai-fin-os/server", "dev"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PLAID_ENV: "production",
    PLAID_REDIRECT_URI: "https://localhost:5173/",
    BREADCRUMBZ_CORS_ORIGINS: "https://localhost:5173",
    BREADCRUMBZ_FORCE_SECURE: "true",
    BREADCRUMBZ_LOCAL_DATA_DIR: dataDir,
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error("Could not start the Production-local API:", error.message);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
