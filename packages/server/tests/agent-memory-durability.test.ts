/**
 * Crash-ordering of the file-backed assistant memory. An uploaded file lives as
 * two writes — the blob (its text) and the index entry that points at it. If
 * they land in the wrong order, a crash between them leaves a phantom: an entry
 * `listFiles` returns whose `getFileText` is gone forever. This pins that the
 * blob is written first, so a failed write leaves at worst an unreferenced blob.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileAgentMemoryStore } from "../src/agent/memory/store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-mem-dura-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileAgentMemoryStore addFile crash-ordering", () => {
  it("writes the blob before the index, so a failed blob write records no phantom file", async () => {
    // Force the blob write to fail without patching internals: occupy the
    // `blobs/` path with a regular file, so the `mkdir(blobs)` inside the atomic
    // blob write throws before any index/fact write can happen.
    await writeFile(join(dir, "blobs"), "not a directory", "utf8");
    const store = new FileAgentMemoryStore(dir);

    await expect(
      store.addFile({ name: "budget.txt", mediaType: "text/plain", text: "hello" }),
    ).rejects.toBeTruthy();

    // Nothing was recorded: no index entry (the old order wrote it before the
    // blob, leaving a phantom) and no dangling file_summary fact.
    expect(await store.listFiles()).toEqual([]);
    expect((await store.listFacts()).some((fact) => fact.kind === "file_summary")).toBe(false);
  });

  it("still records a normal upload end-to-end after the reorder", async () => {
    const store = new FileAgentMemoryStore(dir);
    const file = await store.addFile({ name: "goals.md", mediaType: "text/markdown", text: "cut takeaway spend" });

    expect((await store.listFiles()).map((f) => f.id)).toContain(file.id);
    expect(await store.getFileText(file.id)).toContain("takeaway");
    expect((await store.listFacts()).some((f) => f.source === `file:${file.id}`)).toBe(true);
  });
});
