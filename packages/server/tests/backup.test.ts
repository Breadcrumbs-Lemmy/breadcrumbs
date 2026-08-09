/**
 * Backup / restore of the local data directory — for a single-user install this
 * IS the database dump-and-restore path, so its fidelity and its safety rails
 * (snapshots outside the data dir; a restore that snapshots current data first)
 * are pinned here.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupDataDir, listBackups, restoreDataDir } from "../src/persistence/backup";

let root: string; // a scratch root holding both the data dir and its sibling backups
let dataDir: string;
let backupRoot: string;

const T1 = new Date("2026-01-01T08:30:00Z"); // → 20260101-083000
const T2 = new Date("2026-02-02T09:45:15Z"); // → 20260202-094515

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-backup-"));
  dataDir = join(root, "local-data");
  backupRoot = join(root, "backups");
  await seedDataDir(dataDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedDataDir(dir: string): Promise<void> {
  await mkdir(join(dir, "auth"), { recursive: true });
  await mkdir(join(dir, "users", "usr_owner"), { recursive: true });
  await writeFile(join(dir, "statement-imports.json"), JSON.stringify({ accounts: [{ id: "a1" }] }), "utf8");
  await writeFile(join(dir, "auth", "users.json"), JSON.stringify({ usr_owner: { id: "usr_owner" } }), "utf8");
  await writeFile(join(dir, "users", "usr_owner", "statement-imports.json"), JSON.stringify({ transactions: [] }), "utf8");
}

describe("backupDataDir", () => {
  it("copies the whole tree, then restores it byte-for-byte after the original changes", async () => {
    const backup = await backupDataDir(dataDir, { timestamp: T1, backupRoot });
    expect(backup).not.toBeNull();

    const originalAuth = await readFile(join(dataDir, "auth", "users.json"), "utf8");

    // Corrupt and delete parts of the live data.
    await writeFile(join(dataDir, "auth", "users.json"), "TAMPERED", "utf8");
    await rm(join(dataDir, "users"), { recursive: true, force: true });

    await restoreDataDir(backup!.path, dataDir, { skipSafetyBackup: true, backupRoot });

    expect(await readFile(join(dataDir, "auth", "users.json"), "utf8")).toBe(originalAuth);
    expect(await readFile(join(dataDir, "users", "usr_owner", "statement-imports.json"), "utf8")).toContain(
      "transactions",
    );
  });

  it("excludes in-flight .tmp files from the snapshot", async () => {
    await writeFile(join(dataDir, "statement-imports.json.tmp"), "half-written", "utf8");
    const backup = await backupDataDir(dataDir, { timestamp: T1, backupRoot });

    await expect(readFile(join(backup!.path, "statement-imports.json.tmp"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // ...but the real file is present.
    expect(await readFile(join(backup!.path, "statement-imports.json"), "utf8")).toContain("accounts");
  });

  it("returns null when there is no data directory yet", async () => {
    const backup = await backupDataDir(join(root, "does-not-exist"), { backupRoot });
    expect(backup).toBeNull();
  });

  it("does not merge two same-second, same-label snapshots — the later one reflects the live data", async () => {
    // The stamp is only second-precise, so a migration runner retrying within one
    // second would resolve to the same directory. `cp` merges into an existing
    // dir, so without a uniqueness guard a deleted file would silently survive.
    const first = await backupDataDir(dataDir, { timestamp: T1, label: "migration", backupRoot });
    await rm(join(dataDir, "auth", "users.json"), { force: true }); // the live data loses a file
    const second = await backupDataDir(dataDir, { timestamp: T1, label: "migration", backupRoot });

    // The second snapshot took a distinct, uniquified name...
    expect(second!.name).not.toBe(first!.name);
    // ...and reflects the deletion rather than merging in the first snapshot's copy.
    await expect(readFile(join(second!.path, "auth", "users.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The first snapshot is untouched and still holds the original file.
    expect(await readFile(join(first!.path, "auth", "users.json"), "utf8")).toContain("usr_owner");
  });

  it("refuses a backup root inside the data directory", async () => {
    await expect(
      backupDataDir(dataDir, { backupRoot: join(dataDir, "backups") }),
    ).rejects.toThrow(/must be outside the data directory/);
  });
});

describe("listBackups", () => {
  it("lists snapshots newest-first and returns [] when none exist", async () => {
    expect(await listBackups(dataDir, { backupRoot })).toEqual([]);

    await backupDataDir(dataDir, { timestamp: T1, backupRoot });
    await backupDataDir(dataDir, { timestamp: T2, backupRoot });

    const backups = await listBackups(dataDir, { backupRoot });
    expect(backups.map((b) => b.name)).toEqual(["20260202-094515", "20260101-083000"]);
  });
});

describe("restoreDataDir", () => {
  it("snapshots the current data as a pre-restore backup before overwriting it", async () => {
    const backup = await backupDataDir(dataDir, { timestamp: T1, backupRoot });

    // Change the live data so we can tell the safety backup captured the *current*
    // state, not the older snapshot being restored.
    await writeFile(join(dataDir, "auth", "users.json"), "CURRENT-STATE", "utf8");

    const { safetyBackup } = await restoreDataDir(backup!.path, dataDir, { timestamp: T2, backupRoot });

    expect(safetyBackup).not.toBeNull();
    expect(safetyBackup!.name).toContain("pre-restore");
    expect(await readFile(join(safetyBackup!.path, "auth", "users.json"), "utf8")).toBe("CURRENT-STATE");
  });

  it("throws when the backup to restore does not exist", async () => {
    await expect(restoreDataDir(join(backupRoot, "nope"), dataDir, { backupRoot })).rejects.toThrow(/not found/i);
  });
});
