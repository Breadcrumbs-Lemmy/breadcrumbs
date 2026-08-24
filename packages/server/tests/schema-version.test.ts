/**
 * The file-based migration harness: the decision table that keeps an on-disk
 * upgrade safe. Because these paths only ever run against a user's real
 * financial data at startup, every branch is pinned — fresh install, legacy
 * (unversioned) data, an applied migration, a no-op, and the fail-closed refusal
 * of a directory written by a newer build.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrateDataDir, readMeta } from "../src/persistence/schema-version";

let root: string;
let dataDir: string;
const NOW = new Date("2026-08-08T12:00:00Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-schema-"));
  dataDir = join(root, "local-data");
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeMetaFile(version: number, updatedAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
  await writeFile(join(dataDir, "meta.json"), JSON.stringify({ app: "breadcrumbz", schemaVersion: version, updatedAt }), "utf8");
}

describe("migrateDataDir", () => {
  it("stamps a fresh empty directory at the current version without a backup", async () => {
    const backup = vi.fn();
    const outcome = await migrateDataDir(dataDir, { now: NOW, backup: backup as never });

    expect(outcome).toMatchObject({ fromVersion: CURRENT_SCHEMA_VERSION, toVersion: CURRENT_SCHEMA_VERSION, ranMigrations: [], backup: null });
    expect(backup).not.toHaveBeenCalled();
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, updatedAt: NOW.toISOString() });
  });

  it("treats a fresh install with no data directory at all as current, creating the marker", async () => {
    const fresh = join(root, "brand-new");
    const outcome = await migrateDataDir(fresh, { now: NOW, backup: (async () => null) as never });
    expect(outcome.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(await readMeta(fresh)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
  });

  it("detects unversioned legacy data as v0, backs it up, and stamps it to the target", async () => {
    // Pre-versioning data: a data file exists but there is no meta.json.
    await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [] }), "utf8");
    const backup = vi.fn(async (_dataDir: string, _opts?: { label?: string; timestamp?: Date }) => ({ path: "/tmp/snap", name: "snap" }));

    const outcome = await migrateDataDir(dataDir, { now: NOW, targetVersion: 1, migrations: [], backup: backup as never });

    expect(outcome).toMatchObject({ fromVersion: 0, toVersion: 1, ranMigrations: [], backup: { name: "snap" } });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup.mock.calls[0][1]).toMatchObject({ label: "pre-migration-v1" });
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: 1 });
  });

  it("runs each pending migration in order and stamps to the new version", async () => {
    await writeMetaFile(1);
    const ran: number[] = [];
    const migrations = [
      { version: 3, description: "third", up: async () => void ran.push(3) },
      { version: 2, description: "second", up: async (dir: string) => { ran.push(2); await writeFile(join(dir, "migrated-v2.marker"), "ok"); } },
    ];

    const outcome = await migrateDataDir(dataDir, {
      now: NOW,
      targetVersion: 3,
      migrations,
      backup: (async () => ({ path: "/tmp/s", name: "s" })) as never,
    });

    expect(ran).toEqual([2, 3]); // sorted ascending despite input order
    expect(outcome.ranMigrations).toEqual([2, 3]);
    expect(outcome.toVersion).toBe(3);
    await expect(stat(join(dataDir, "migrated-v2.marker"))).resolves.toBeDefined();
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: 3 });
  });

  it("is a no-op that takes no backup when already at the target version", async () => {
    await writeMetaFile(CURRENT_SCHEMA_VERSION, "2026-03-03T03:03:03.000Z");
    const backup = vi.fn();

    const outcome = await migrateDataDir(dataDir, { now: NOW, backup: backup as never });

    expect(outcome).toMatchObject({ ranMigrations: [], backup: null });
    expect(backup).not.toHaveBeenCalled();
    // The existing marker (and its updatedAt) is left untouched.
    expect(await readMeta(dataDir)).toMatchObject({ updatedAt: "2026-03-03T03:03:03.000Z" });
  });

  it("refuses to run against a directory written by a newer build (fail closed)", async () => {
    await writeMetaFile(99);
    const backup = vi.fn();

    await expect(migrateDataDir(dataDir, { now: NOW, targetVersion: 1, backup: backup as never })).rejects.toThrow(/newer than this build/);
    expect(backup).not.toHaveBeenCalled();
    // Nothing was stamped over the newer marker.
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: 99 });
  });

  it("v1 migration tightens permissions on pre-existing world-readable data (files 0600, dirs 0700)", async () => {
    // A legacy dir written by a pre-versioning build: sensitive file at 0644, a
    // subdir at 0755, no meta.json.
    await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [] }), { mode: 0o644 });
    await mkdir(join(dataDir, "auth"), { recursive: true });
    await chmod(join(dataDir, "auth"), 0o755);
    await writeFile(join(dataDir, "auth", "users.json"), "{}", { mode: 0o644 });

    // Default MIGRATIONS + real backup (a sibling backups/ dir under `root`).
    const outcome = await migrateDataDir(dataDir, { now: NOW });

    expect(outcome.fromVersion).toBe(0);
    expect(outcome.ranMigrations).toEqual([1]);
    expect((await stat(join(dataDir, "statement-imports.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "auth", "users.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "auth"))).mode & 0o777).toBe(0o700);
  });

  it("takes a real snapshot (sibling backups dir) when migrating legacy data end-to-end", async () => {
    await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [{ id: "a1" }] }), "utf8");

    const outcome = await migrateDataDir(dataDir, { now: NOW, targetVersion: 1, migrations: [] });

    expect(outcome.backup).not.toBeNull();
    // Default backup root is a sibling of the data dir.
    const snapshot = join(root, "backups", outcome.backup!.name);
    expect(await readFile(join(snapshot, "statement-imports.json"), "utf8")).toContain("a1");
  });

  it("aborts rather than migrating if the pre-migration backup comes back null", async () => {
    // Legacy data present, but the backup step reports the dir vanished (null).
    await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [] }), "utf8");
    const backup = vi.fn(async () => null);

    await expect(
      migrateDataDir(dataDir, { now: NOW, targetVersion: 1, migrations: [], backup: backup as never }),
    ).rejects.toThrow(/disappeared before its pre-migration backup/i);
    // Nothing was stamped — the next boot retries rather than migrating blind.
    expect(await readMeta(dataDir)).toBeUndefined();
  });

  it("checkpoints each migration so a partial failure resumes instead of re-running completed ones", async () => {
    await writeMetaFile(1);
    const okBackup = (async () => ({ path: "/tmp/s", name: "s" })) as never;

    const firstPass: number[] = [];
    const failing = [
      { version: 2, description: "ok", up: async () => void firstPass.push(2) },
      { version: 3, description: "boom", up: async () => { firstPass.push(3); throw new Error("boom"); } },
    ];
    await expect(
      migrateDataDir(dataDir, { now: NOW, targetVersion: 3, migrations: failing, backup: okBackup }),
    ).rejects.toThrow(/boom/);
    // v2 completed and was checkpointed; v3 threw before its stamp.
    expect(firstPass).toEqual([2, 3]);
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: 2 });

    // Second boot with v3 now fixed: only v3 re-runs — v2 is already applied.
    const secondPass: number[] = [];
    const fixed = [
      { version: 2, description: "ok", up: async () => void secondPass.push(2) },
      { version: 3, description: "ok now", up: async () => void secondPass.push(3) },
    ];
    const outcome = await migrateDataDir(dataDir, { now: NOW, targetVersion: 3, migrations: fixed, backup: okBackup });
    expect(secondPass).toEqual([3]); // v2 NOT re-run
    expect(outcome.ranMigrations).toEqual([3]);
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: 3 });
  });

  it("treats a directory holding only an orphaned .tmp write as a fresh install, not legacy data", async () => {
    // A crash during the very first meta.json write leaves a stray temp file.
    await writeFile(join(dataDir, "meta.json.abc123.tmp"), "{half-written", "utf8");
    const backup = vi.fn();

    const outcome = await migrateDataDir(dataDir, { now: NOW, backup: backup as never });

    expect(outcome.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(outcome.backup).toBeNull();
    expect(backup).not.toHaveBeenCalled();
    expect(await readMeta(dataDir)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
  });
});
