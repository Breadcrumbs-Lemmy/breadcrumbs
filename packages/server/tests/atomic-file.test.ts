/**
 * The one durable-write primitive every store now shares. If this is wrong,
 * every persisted file — financial data, session hashes, bank tokens — inherits
 * the bug, so its two guarantees (atomic, and mode 0600) are pinned directly.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMissingFile, readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "../src/persistence/atomic-file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes the content owner-only (mode 0600) and leaves no temp file behind", async () => {
    const path = join(dir, "secret.txt");
    await writeFileAtomic(path, "bank token");

    expect(await readFile(path, "utf8")).toBe("bank token");
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
    // The sibling temp file must have been renamed away, not left lying around.
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates missing parent directories", async () => {
    const path = join(dir, "nested", "deep", "value.txt");
    await writeFileAtomic(path, "ok");
    expect(await readFile(path, "utf8")).toBe("ok");
  });

  it("replaces existing content in place", async () => {
    const path = join(dir, "v.txt");
    await writeFileAtomic(path, "first");
    await writeFileAtomic(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
  });

  it("survives many concurrent writes to the same path — one complete winner, no leftover temp", async () => {
    const path = join(dir, "hot.json");
    // Fire many writers at the same target at once. A fixed `.tmp` name would let
    // them clobber each other's temp file — one rename lands another's bytes, or
    // throws ENOENT. A per-call unique temp name makes every writer independent.
    const writers = Array.from({ length: 25 }, (_, i) => writeJsonFileAtomic(path, { writer: i }));
    await expect(Promise.all(writers)).resolves.toBeDefined();

    // Whatever won is exactly one complete value, never a torn or merged document.
    const parsed = JSON.parse(await readFile(path, "utf8")) as { writer: number };
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(25);

    // Every writer's temp file was renamed away — none left lying around.
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeJsonFileAtomic + readJsonFile", () => {
  it("round-trips a value as pretty JSON with a trailing newline", async () => {
    const path = join(dir, "data.json");
    const value = { a: 1, b: ["x", "y"], nested: { ok: true } };
    await writeJsonFileAtomic(path, value);

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  "); // indented, not minified
    expect(await readJsonFile(path, null)).toEqual(value);
  });

  it("returns the fallback when the file does not exist", async () => {
    expect(await readJsonFile(join(dir, "missing.json"), { fallback: true })).toEqual({ fallback: true });
  });

  it("throws — never silently discards — when an existing file holds malformed JSON", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not valid json", "utf8");
    await expect(readJsonFile(path, {})).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("isMissingFile", () => {
  it("is true only for ENOENT", () => {
    expect(isMissingFile({ code: "ENOENT" })).toBe(true);
    expect(isMissingFile({ code: "EACCES" })).toBe(false);
    expect(isMissingFile(new Error("boom"))).toBe(false);
    expect(isMissingFile(null)).toBe(false);
    expect(isMissingFile("ENOENT")).toBe(false);
  });
});
