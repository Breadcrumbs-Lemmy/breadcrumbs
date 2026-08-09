/**
 * The file-based equivalent of database migrations.
 *
 * This app has no database — persistence is JSON files under the user's data
 * directory. That does not mean the on-disk format can never change; it means
 * there is no migration tool watching over those changes. This module is that
 * tool. A single `meta.json` at the data-dir root records the format version
 * (like a `schema_migrations` row), and `migrateDataDir` — run once at startup,
 * before any store touches a file — brings an existing directory up to the
 * version this build expects:
 *
 *   fresh / empty dir      → stamp meta at the current version, nothing else.
 *   meta == current        → no-op.
 *   meta <  current, or     → back up the whole data dir, run each pending
 *   legacy data, no meta      migration in order, then stamp meta.
 *   meta >  current        → refuse (throw). The data was written by a newer
 *                            build; an older one writing to it could silently
 *                            drop fields it does not know about.
 *
 * The one migration today (to version 1) tightens filesystem permissions on a
 * pre-existing data directory: builds before this change wrote the statement
 * file world-readable (mode 0644), and while every write is now owner-only, an
 * already-written file stays 0644 until it is next rewritten. The migration
 * closes that on the first versioned launch. The next format change ships as one
 * more entry here and is applied, in order, with an automatic pre-migration
 * backup, on every user's next launch.
 */
import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFile, readJsonFile, writeJsonFileAtomic } from "./atomic-file";
import { backupDataDir, type BackupResult } from "./backup";

/**
 * Bump this whenever the on-disk shape of any persisted file changes in a way an
 * older build could not read, AND append a `Migration` to `MIGRATIONS` that
 * transforms the previous version's data to the new one.
 */
export const CURRENT_SCHEMA_VERSION = 1;

const META_FILENAME = "meta.json";

export type DataDirMeta = {
  app: "breadcrumbs";
  schemaVersion: number;
  updatedAt: string;
};

export type Migration = {
  /** The version this migration produces. Runs when the on-disk version is
   *  below it (and at or below the target). */
  version: number;
  description: string;
  up: (dataDir: string) => Promise<void>;
};

/** Ordered ascending by `version`. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Tighten permissions on data written by pre-versioning builds (files 0600, dirs 0700).",
    up: tightenDataDirPermissions,
  },
];

/**
 * Recursively set every file under the data dir to 0600 and every directory to
 * 0700, matching what all writes now produce. Best-effort per entry: a single
 * un-chmod-able file must not block startup. But do NOT pretend the failure is
 * harmless — a write-once record (e.g. an imported statement, never rewritten in
 * normal use) would stay world-readable forever, and this migration only runs
 * once. So any path we could not tighten is collected and warned about loudly,
 * making the residual exposure observable rather than silent. The backup taken
 * before this runs lives outside the data dir, so it is never touched.
 */
async function tightenDataDirPermissions(dataDir: string): Promise<void> {
  const failed: string[] = [];
  await chmodBestEffort(dataDir, 0o700, failed);
  await walk(dataDir);

  if (failed.length > 0) {
    console.warn(
      `[migration] Could not tighten permissions on ${failed.length} path(s); they keep their previous mode ` +
        "and are NOT retried on later boots. On a shared host this can leave financial data readable by other " +
        `OS users — inspect and chmod them manually. Paths: ${failed.slice(0, 20).join(", ")}` +
        (failed.length > 20 ? `, …(+${failed.length - 20} more)` : ""),
    );
  }

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await chmodBestEffort(full, 0o700, failed);
        await walk(full);
      } else if (entry.isFile()) {
        await chmodBestEffort(full, 0o600, failed);
      }
    }
  }
}

async function chmodBestEffort(path: string, mode: number, failed: string[]): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    failed.push(path);
  }
}

export type MigrationOutcome = {
  fromVersion: number;
  toVersion: number;
  /** Versions of the migrations actually applied, in order. */
  ranMigrations: number[];
  /** The snapshot taken before migrating, or `null` when none was needed. */
  backup: BackupResult | null;
};

export function metaPath(dataDir: string): string {
  return join(dataDir, META_FILENAME);
}

export async function readMeta(dataDir: string): Promise<DataDirMeta | undefined> {
  const meta = await readJsonFile<Partial<DataDirMeta> | undefined>(metaPath(dataDir), undefined);
  if (!meta || typeof meta !== "object" || typeof meta.schemaVersion !== "number") return undefined;
  return { app: "breadcrumbs", schemaVersion: meta.schemaVersion, updatedAt: meta.updatedAt ?? "" };
}

async function writeMeta(dataDir: string, version: number, now: Date): Promise<void> {
  const meta: DataDirMeta = { app: "breadcrumbs", schemaVersion: version, updatedAt: now.toISOString() };
  await writeJsonFileAtomic(metaPath(dataDir), meta);
}

/**
 * Bring `dataDir` up to the target schema version. See the module comment for
 * the full decision table. Idempotent: running it twice in a row is a no-op the
 * second time.
 *
 * The options exist for tests (inject a clock, a target version, a migration
 * list, or a stub backup) and for the migration runner to stay deterministic.
 */
export async function migrateDataDir(
  dataDir: string,
  opts: {
    now?: Date;
    targetVersion?: number;
    migrations?: Migration[];
    backup?: typeof backupDataDir;
  } = {},
): Promise<MigrationOutcome> {
  const now = opts.now ?? new Date();
  const target = opts.targetVersion ?? CURRENT_SCHEMA_VERSION;
  const migrations = [...(opts.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  const backupFn = opts.backup ?? backupDataDir;

  const meta = await readMeta(dataDir);
  // No meta means either a legacy directory written before versioning existed
  // (treat as version 0 so its data gets migrated) or a genuinely fresh install
  // (nothing to migrate — adopt the target directly).
  const fromVersion = meta ? meta.schemaVersion : (await hasExistingData(dataDir)) ? 0 : target;

  if (fromVersion > target) {
    throw new Error(
      `Data directory schema version ${fromVersion} is newer than this build supports (${target}). ` +
        "Upgrade the app, or restore a backup written by a compatible version. " +
        "Refusing to run so newer data is not corrupted.",
    );
  }

  if (fromVersion === target) {
    // Stamp a fresh (or somehow unstamped) dir so the next boot is a clean no-op.
    if (!meta || meta.schemaVersion !== target || !meta.updatedAt) {
      await writeMeta(dataDir, target, now);
    }
    return { fromVersion, toVersion: target, ranMigrations: [], backup: null };
  }

  // We are about to change real, existing data. Snapshot it first so a failed or
  // mistaken migration is fully recoverable.
  const backup = await backupFn(dataDir, { label: `pre-migration-v${target}`, timestamp: now });
  if (!backup) {
    // Reaching here means fromVersion < target, which only happens when the dir
    // held a meta stamp or legacy data moments ago. A null backup means the data
    // dir vanished in between — abort rather than migrate with no recovery point.
    throw new Error(
      "Data directory disappeared before its pre-migration backup could be taken. " +
        "Refusing to migrate without a recoverable snapshot.",
    );
  }

  const pending = migrations.filter((m) => m.version > fromVersion && m.version <= target);
  for (const migration of pending) {
    await migration.up(dataDir);
    // Checkpoint after each step. If a later migration throws, the next boot
    // resumes from the last completed version instead of re-running an
    // already-applied (and possibly non-idempotent) migration from scratch.
    await writeMeta(dataDir, migration.version, now);
  }
  // Adopt the target explicitly: covers the no-pending case and any gap between
  // the final migration's version and the target.
  await writeMeta(dataDir, target, now);

  return { fromVersion, toVersion: target, ranMigrations: pending.map((m) => m.version), backup };
}

/**
 * Does the directory hold data from a build that predates versioning? True when
 * it exists and contains anything other than the meta file, dotfiles (e.g.
 * `.DS_Store`), and in-flight `.tmp` files. The `.tmp` exclusion matters: a fresh
 * install whose very first `meta.json` write crashed after the temp write but
 * before the rename would otherwise be misread as legacy data and needlessly
 * "migrated" (with a deceptive empty backup). A fresh install has no data dir
 * yet, or an empty one — either way there is nothing real to migrate.
 */
async function hasExistingData(dataDir: string): Promise<boolean> {
  try {
    const entries = await readdir(dataDir);
    return entries.some((name) => name !== META_FILENAME && !name.startsWith(".") && !name.endsWith(".tmp"));
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
