/**
 * Snapshot and restore the whole local data directory.
 *
 * For a single-user, self-hosted install the JSON files under
 * `~/.breadcrumbs/local-data` ARE the database — so "back up the database" means
 * "copy that directory somewhere safe", and "restore" means "put a copy back".
 * This module is that, plus two safety properties a hand-rolled `cp` would miss:
 *
 *   - the backup lives OUTSIDE the data directory (a sibling `backups/` folder by
 *     default), so a snapshot never contains earlier snapshots and a restore that
 *     wipes the data dir never destroys the backups; and
 *   - a restore first snapshots the CURRENT data (labelled `pre-restore`), so
 *     restoring the wrong backup is itself undoable.
 *
 * The migration runner (schema-version.ts) calls `backupDataDir` before it
 * transforms anything, which is what makes a file-format upgrade safe to ship.
 */
import { cp, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isMissingFile } from "./atomic-file";

export type BackupResult = { path: string; name: string };
export type BackupInfo = { name: string; path: string; createdAt: string };

/** Where snapshots go: `BREADCRUMBS_BACKUP_DIR` if set, else a `backups/` folder
 *  beside the data dir (e.g. `~/.breadcrumbs/backups`). Deliberately a sibling of
 *  the data dir, never inside it. */
export function defaultBackupRootDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBS_BACKUP_DIR?.trim();
  if (configured && configured.length > 0) return configured;
  return join(resolve(dataDir), "..", "backups");
}

/**
 * Copy the entire data directory into a timestamped snapshot folder.
 *
 * Returns the snapshot's path, or `null` when there is nothing to back up
 * (the data dir does not exist yet — a first run). Transient `.tmp` files from
 * an in-flight atomic write are skipped.
 */
export async function backupDataDir(
  dataDir: string,
  opts: { label?: string; timestamp?: Date; backupRoot?: string } = {},
): Promise<BackupResult | null> {
  if (!(await pathExists(dataDir))) return null;

  const root = opts.backupRoot ?? defaultBackupRootDir(dataDir);
  assertBackupRootOutsideDataDir(dataDir, root);

  const stamp = formatStamp(opts.timestamp ?? new Date());
  const baseName = opts.label ? `${stamp}-${sanitizeLabel(opts.label)}` : stamp;
  // The stamp is only second-precise, so two snapshots with the same label in
  // the same second (e.g. a migration runner retrying) would resolve to one
  // path. `cp` MERGES into an existing directory rather than replacing it —
  // silently keeping files the source no longer has, producing a snapshot that
  // never existed. Pick a fresh `-2`, `-3`… name instead of merging.
  let name = baseName;
  let dest = join(root, name);
  for (let n = 2; await pathExists(dest); n += 1) {
    name = `${baseName}-${n}`;
    dest = join(root, name);
  }

  await cp(dataDir, dest, {
    recursive: true,
    force: true,
    // Skip half-written atomic-write temp files; they are never valid data.
    filter: (source) => !source.endsWith(".tmp"),
  });

  return { path: dest, name };
}

/**
 * Replace the live data directory with the contents of a backup.
 *
 * Destructive by nature — the current data dir is removed and rebuilt from the
 * snapshot — so unless `skipSafetyBackup` is set it first snapshots the current
 * data as a `pre-restore` backup. That snapshot is what makes an accidental
 * restore recoverable.
 */
export async function restoreDataDir(
  backupPath: string,
  dataDir: string,
  opts: { backupRoot?: string; timestamp?: Date; skipSafetyBackup?: boolean } = {},
): Promise<{ safetyBackup: BackupResult | null }> {
  if (!(await pathExists(backupPath))) {
    throw new Error(`Backup not found: ${backupPath}`);
  }
  const root = opts.backupRoot ?? defaultBackupRootDir(dataDir);
  assertBackupRootOutsideDataDir(dataDir, root);

  const safetyBackup = opts.skipSafetyBackup
    ? null
    : await backupDataDir(dataDir, { label: "pre-restore", timestamp: opts.timestamp, backupRoot: root });

  // Copy the snapshot into a staging sibling FIRST, then swap it in. A naive
  // "rm dataDir then cp backup" loses all live data if the copy fails partway
  // (e.g. ENOSPC — the disk can be too full to hold the copy but never too full
  // to delete). Here the space-consuming copy happens before anything is
  // removed, so a failure leaves the live data dir untouched.
  const staging = `${resolve(dataDir)}.restore-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(backupPath, staging, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // Swap: the only destructive step, now just two metadata ops. `rename` cannot
  // overwrite a non-empty directory, so remove the live dir immediately before
  // moving the fully-formed staging copy into place. The window is tiny and the
  // safety backup above still holds the prior state regardless.
  await rm(dataDir, { recursive: true, force: true });
  await rename(staging, dataDir);

  return { safetyBackup };
}

/** Every snapshot under the backup root, newest first. */
export async function listBackups(
  dataDir: string,
  opts: { backupRoot?: string } = {},
): Promise<BackupInfo[]> {
  const root = opts.backupRoot ?? defaultBackupRootDir(dataDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const infos = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name);
        const stats = await stat(path);
        return { name: entry.name, path, createdAt: stats.mtime.toISOString() };
      }),
  );
  // Names are timestamp-prefixed and zero-padded, so a reverse name sort is
  // reverse-chronological without parsing dates.
  return infos.sort((a, b) => b.name.localeCompare(a.name));
}

/** A sortable, filesystem-safe UTC stamp: `20260808-123456`. */
function formatStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "backup";
}

/**
 * A backup root inside the data dir would be catastrophic: a snapshot would try
 * to copy itself, and a restore's `rm -rf dataDir` would delete the very
 * pre-restore safety backup it just wrote. Refuse loudly instead.
 */
function assertBackupRootOutsideDataDir(dataDir: string, backupRoot: string): void {
  const data = resolve(dataDir);
  const root = resolve(backupRoot);
  const rel = relative(data, root);
  const inside = root === data || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
    throw new Error(
      `Backup directory (${root}) must be outside the data directory (${data}). ` +
        "Set BREADCRUMBS_BACKUP_DIR to a location outside your data dir.",
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
