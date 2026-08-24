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
import { readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OWNER_USER_ID } from "../src/auth/types";
import { FieldCipher } from "../src/crypto/field-cipher";
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

  it("persists the /transactions/sync cursor so the next sync resumes from it", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });
    expect(saved.transactionsCursor).toBeUndefined();

    await store.markSynced(saved.connectionId, "2026-08-08T12:00:00.000Z", { cursor: "cursor-page-1" });

    const afterRestart = new FilePlaidTokenStore(filePath);
    const loaded = await afterRestart.get(saved.connectionId);
    expect(loaded?.transactionsCursor).toBe("cursor-page-1");

    // A later markSynced with no cursor argument leaves the stored cursor intact.
    await afterRestart.markSynced(saved.connectionId, "2026-08-09T12:00:00.000Z");
    const again = await new FilePlaidTokenStore(filePath).get(saved.connectionId);
    expect(again?.transactionsCursor).toBe("cursor-page-1");
    expect(again?.lastSyncedAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("unions coverage bounds across syncs — start only widens, end only advances", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });

    // First sync: full-history drain sets both bounds.
    await store.markSynced(saved.connectionId, "2026-08-08T12:00:00.000Z", {
      cursor: "c1",
      coverage: { start: "2024-03-15", end: "2026-08-08" },
    });
    let loaded = await new FilePlaidTokenStore(filePath).get(saved.connectionId);
    expect(loaded?.coverageStart).toBe("2024-03-15");
    expect(loaded?.coverageEnd).toBe("2026-08-08");

    // Later delta sync: a newer end advances it; a *later* start must NOT shrink coverage.
    await store.markSynced(saved.connectionId, "2026-08-09T12:00:00.000Z", {
      cursor: "c2",
      coverage: { start: "2026-08-09", end: "2026-08-09" },
    });
    loaded = await new FilePlaidTokenStore(filePath).get(saved.connectionId);
    expect(loaded?.coverageStart).toBe("2024-03-15"); // unchanged — only ever widens
    expect(loaded?.coverageEnd).toBe("2026-08-09"); // advanced

    // A sync with no coverage (e.g. an empty delta) leaves the bounds intact.
    await store.markSynced(saved.connectionId, "2026-08-10T12:00:00.000Z", { cursor: "c3" });
    loaded = await new FilePlaidTokenStore(filePath).get(saved.connectionId);
    expect(loaded?.coverageStart).toBe("2024-03-15");
    expect(loaded?.coverageEnd).toBe("2026-08-09");
  });

  it("looks a connection up by its Plaid item id (how a webhook finds it)", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-xyz", accessToken: "tok-a" });
    await store.save({ userId: "usr_bob", itemId: "item-other", accessToken: "tok-b" });

    const reader = new FilePlaidTokenStore(filePath);
    const byItem = await reader.listByItemId("item-xyz");
    expect(byItem.map((c) => c.connectionId)).toEqual([saved.connectionId]);
    expect(byItem[0]?.accessToken).toBe("tok-a");
    expect(await reader.listByItemId("item-missing")).toEqual([]);
  });

  it("flags re-auth durably and clears it on the next successful sync", async () => {
    const store = new FilePlaidTokenStore(filePath);
    const saved = await store.save({ userId: "usr_alice", itemId: "item-a", accessToken: "tok-a" });

    await store.setReauthRequired(saved.connectionId, true);
    expect((await new FilePlaidTokenStore(filePath).get(saved.connectionId))?.reauthRequired).toBe(true);

    // A sync that succeeds is proof the login works again, so it retires the flag.
    await store.markSynced(saved.connectionId, "2026-08-09T00:00:00.000Z", { cursor: "cursor-1" });
    const after = await new FilePlaidTokenStore(filePath).get(saved.connectionId);
    expect(after?.reauthRequired).toBeUndefined();
    expect(after?.transactionsCursor).toBe("cursor-1");
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

  describe("encryption at rest", () => {
    const cipher = new FieldCipher(randomBytes(32));

    it("stores the access token as ciphertext on disk but returns it plaintext", async () => {
      const writer = new FilePlaidTokenStore(filePath, cipher);
      const saved = await writer.save({ userId: "usr_alice", itemId: "item-a", accessToken: "access-alice-secret" });
      // The caller still gets the usable plaintext token.
      expect(saved.accessToken).toBe("access-alice-secret");

      // The plaintext must never touch the file.
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).not.toContain("access-alice-secret");
      expect(onDisk).toContain("bcenc1:");

      // A fresh instance with the same key reads it back intact.
      const reader = new FilePlaidTokenStore(filePath, cipher);
      const loaded = await reader.get(saved.connectionId);
      expect(loaded?.accessToken).toBe("access-alice-secret");
    });

    it("cannot read tokens written under a different key", async () => {
      const saved = await new FilePlaidTokenStore(filePath, cipher).save({
        userId: "usr_alice",
        itemId: "item-a",
        accessToken: "tok",
      });
      const wrongKey = new FilePlaidTokenStore(filePath, new FieldCipher(randomBytes(32)));
      await expect(wrongKey.get(saved.connectionId)).rejects.toThrow();
    });

    it("reads legacy plaintext records and migrates them to ciphertext on next write", async () => {
      // Simulate a record written before encryption was enabled.
      const legacy = await new FilePlaidTokenStore(filePath).save({
        userId: "usr_alice",
        itemId: "item-a",
        accessToken: "legacy-plain",
      });
      expect(await readFile(filePath, "utf8")).toContain("legacy-plain");

      // Turning encryption on: the old token is still readable (passthrough)...
      const encrypted = new FilePlaidTokenStore(filePath, cipher);
      expect((await encrypted.get(legacy.connectionId))?.accessToken).toBe("legacy-plain");

      // ...and a write (markSynced) re-encrypts it in place.
      await encrypted.markSynced(legacy.connectionId, "2026-08-09T00:00:00.000Z");
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).not.toContain("legacy-plain");
      expect(onDisk).toContain("bcenc1:");
      expect((await encrypted.get(legacy.connectionId))?.accessToken).toBe("legacy-plain");
    });
  });
});
