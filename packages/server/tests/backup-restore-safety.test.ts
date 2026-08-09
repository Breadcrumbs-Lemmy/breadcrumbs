/**
 * A restore must never destroy the live data directory if it fails partway.
 * The naive "rm dataDir then cp backup" loses everything when the copy dies
 * (e.g. ENOSPC — a disk can be too full to hold the copy but never too full to
 * delete). This pins the safe order: copy the snapshot into a staging sibling
 * FIRST, and only swap it in once the copy has fully succeeded.
 *
 * `cp` is mocked to fail exactly on the copy that reads FROM a backup (the
 * restore step) while the pre-restore safety backup (which reads from the live
 * data dir) still succeeds. Keying on the SOURCE keeps the injection
 * implementation-agnostic: it hits the restore copy whether that lands in a
 * staging dir or straight over the data dir. Isolated in its own file so the
 * real backup tests keep the real cp.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: vi.fn(async (source: string, dest: string, opts?: unknown) => {
      // The restore copy reads FROM the backup dir; the pre-restore safety backup
      // reads from the live data dir. Fail only the former, so the safety backup
      // still succeeds and we isolate "the restore copy died mid-flight".
      if (source.includes("/backups/")) {
        throw Object.assign(new Error("ENOSPC: no space left on device, cp"), { code: "ENOSPC" });
      }
      return (actual.cp as (s: string, d: string, o?: unknown) => Promise<void>)(source, dest, opts);
    }),
  };
});

import { backupDataDir, restoreDataDir } from "../src/persistence/backup";

const T1 = new Date("2026-01-01T08:30:00Z");
const T2 = new Date("2026-02-02T09:45:15Z");

let root: string;
let dataDir: string;
let backupRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-restore-safe-"));
  dataDir = join(root, "local-data");
  backupRoot = join(root, "backups");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [{ id: "a1" }] }), "utf8");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("restoreDataDir failure safety", () => {
  it("preserves the live data directory when the restore copy fails partway", async () => {
    const backup = await backupDataDir(dataDir, { timestamp: T1, backupRoot });
    expect(backup).not.toBeNull();

    // Change the live data so we can prove the ORIGINAL is preserved (not the
    // backup's older content) when the restore blows up.
    await writeFile(join(dataDir, "statement-imports.json"), JSON.stringify({ accounts: [{ id: "LIVE" }] }), "utf8");

    await expect(restoreDataDir(backup!.path, dataDir, { timestamp: T2, backupRoot })).rejects.toMatchObject({
      code: "ENOSPC",
    });

    // The data dir is intact — the failed staging copy never touched it.
    expect(await readFile(join(dataDir, "statement-imports.json"), "utf8")).toContain("LIVE");
    // No half-written staging directory was left behind.
    expect((await readdir(root)).filter((name) => name.includes(".restore-"))).toEqual([]);
  });
});
