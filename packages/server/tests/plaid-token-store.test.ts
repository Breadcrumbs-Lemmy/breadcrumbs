/**
 * Durable Plaid token storage.
 *
 * `FilePlaidTokenStore` is what makes a linked bank survive a restart: the
 * in-memory store loses every access token when the process dies, so a
 * production box on it would silently un-link every user's bank on each deploy.
 * The file it writes holds bearer credentials to a real bank, so two properties
 * matter as much as "it saves": a second process reads the same tokens back
 * (persistence), and one user's connection is never returned to another
 * (isolation). It was only ever checked by hand — these pin it.
 */
import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OWNER_USER_ID } from "../src/auth/types";
import { FilePlaidTokenStore } from "../src/plaid/token-store";

describe("FilePlaidTokenStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bc-plaid-store-"));
    filePath = join(dir, "connections.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a saved connection from a fresh store instance, tokens intact", async () => {
    // A separate instance over the same file stands in for a process restart:
    // nothing is shared in memory, so anything it reads came off disk.
    const writer = new FilePlaidTokenStore(filePath);
    const saved = await writer.save({ userId: "usr_alice", itemId: "item-alice", accessToken: "access-alice" });

    const afterRestart = new FilePlaidTokenStore(filePath);
    const loaded = await afterRestart.get(saved.connectionId);

    expect(loaded).toBeDefined();
    expect(loaded).toMatchObject({
      connectionId: saved.connectionId,
      userId: "usr_alice",
      itemId: "item-alice",
      accessToken: "access-alice",
    });
  });

  it("defaults an ownerless save to the owner and never leaks it to another user", async () => {
    const store = new FilePlaidTokenStore(filePath);
    await store.save({ itemId: "item-owner", accessToken: "access-owner" });

    const ownerList = await store.listForUser(OWNER_USER_ID);
    expect(ownerList).toHaveLength(1);
    expect(ownerList[0]).toMatchObject({ userId: OWNER_USER_ID, accessToken: "access-owner" });

    expect(await store.listForUser("usr_someone_else")).toEqual([]);
  });

  it("scopes listForUser to the owning user in both directions", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const alice = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });
    const bob = await store.save({ userId: "usr_bob", itemId: "item-b", accessToken: "tok-b" });

    const reader = new FilePlaidTokenStore(filePath);
    const aliceConns = await reader.listForUser("usr_alice");
    const bobConns = await reader.listForUser("usr_bob");

    expect(aliceConns.map((c) => c.connectionId)).toEqual([alice.connectionId]);
    expect(bobConns.map((c) => c.connectionId)).toEqual([bob.connectionId]);
    // The cross-check: neither user's access token appears in the other's list.
    expect(aliceConns.some((c) => c.accessToken === "tok-b")).toBe(false);
    expect(bobConns.some((c) => c.accessToken === "tok-a")).toBe(false);
  });

  it("persists markSynced so the last-sync time survives a restart", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });
    expect(saved.lastSyncedAt).toBeUndefined();

    const syncedAt = "2026-08-08T12:00:00.000Z";
    await store.markSynced(saved.connectionId, syncedAt);

    const afterRestart = new FilePlaidTokenStore(filePath);
    const loaded = await afterRestart.get(saved.connectionId);
    expect(loaded?.lastSyncedAt).toBe(syncedAt);
  });

  it("deletes a connection durably", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });

    await store.delete(saved.connectionId);

    const afterRestart = new FilePlaidTokenStore(filePath);
    expect(await afterRestart.get(saved.connectionId)).toBeUndefined();
    expect(await afterRestart.listForUser("usr_alice")).toEqual([]);
  });

  it("writes the token file with owner-only 0600 permissions", async () => {
    // These are live bank credentials; the file must not be readable by other OS
    // users. The store writes a 0600 temp file and renames it into place, which
    // preserves the mode. 0o777 masks off the file-type bits stat reports.
    const store = new FilePlaidTokenStore(filePath);
    await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });

    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
