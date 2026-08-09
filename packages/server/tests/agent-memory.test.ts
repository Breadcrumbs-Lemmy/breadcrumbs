/**
 * The assistant's memory: long-term facts, uploaded learning material, a rolling
 * working note, past conversations — and, above all, that one user's memory is
 * unreachable from another's.
 *
 * Both implementations are exercised: the in-memory one that tests and ephemeral
 * runs use, and the file-backed one that a real install writes to disk. They are
 * held to the same behaviour, because the product swaps between them by
 * environment and neither is allowed to be the odd one out.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileAgentMemoryProvider,
  InMemoryAgentMemoryProvider,
} from "../src/agent/memory/provider";
import type { AgentMemoryProvider } from "../src/agent/memory/provider";
import { FileAgentMemoryStore, InMemoryAgentMemoryStore } from "../src/agent/memory/store";
import type { AgentMemoryStore } from "../src/agent/memory/store";

// Each factory returns a fresh, empty store plus a cleanup for anything on disk.
type Factory = { make: () => Promise<{ store: AgentMemoryStore; cleanup: () => Promise<void> }>; name: string };

const factories: Factory[] = [
  { name: "in-memory", make: async () => ({ store: new InMemoryAgentMemoryStore(), cleanup: async () => {} }) },
  {
    name: "file-backed",
    make: async () => {
      const dir = await mkdtemp(join(tmpdir(), "bc-mem-"));
      return { store: new FileAgentMemoryStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

for (const factory of factories) {
  describe(`AgentMemoryStore (${factory.name})`, () => {
    let store: AgentMemoryStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await factory.make());
    });
    afterEach(async () => {
      await cleanup();
    });

    it("saves and lists long-term facts", async () => {
      await store.addFact({ text: "Budgets fortnightly.", kind: "preference", source: "user" });
      const facts = await store.listFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ text: "Budgets fortnightly.", kind: "preference" });
    });

    it("records an uploaded file, a summary fact, and retrieves its text by keyword", async () => {
      const file = await store.addFile({
        name: "goals.md",
        mediaType: "text/markdown",
        text: "My goal this year is to cut restaurant and takeaway spending in half.",
      });

      expect((await store.listFiles()).map((f) => f.id)).toContain(file.id);
      expect(await store.getFileText(file.id)).toMatch(/takeaway/);

      // The upload leaves a file_summary fact so it is discoverable in long-term
      // memory even before its contents are matched.
      expect((await store.listFacts()).some((f) => f.kind === "file_summary")).toBe(true);

      const hit = await store.retrieve("how do I reduce takeaway restaurant costs");
      expect(hit.fileSnippets.some((s) => /takeaway/.test(s.snippet))).toBe(true);
    });

    it("keeps a working note that survives rewrites", async () => {
      expect(await store.readShortTerm()).toBe("");
      await store.writeShortTerm("Focus: July groceries.");
      expect(await store.readShortTerm()).toBe("Focus: July groceries.");
      await store.writeShortTerm("Focus: August subscriptions.");
      expect(await store.readShortTerm()).toBe("Focus: August subscriptions.");
    });

    it("starts a conversation, then continues the same one by id", async () => {
      const first = await store.appendTurns(undefined, [
        { role: "user", content: "How much did I spend on coffee?", at: "2026-08-01T10:00:00.000Z" },
        { role: "assistant", content: "You spent $42 on coffee in July.", at: "2026-08-01T10:00:01.000Z" },
      ]);
      expect(first.turns).toHaveLength(2);
      expect(first.title).toMatch(/coffee/i);

      const continued = await store.appendTurns(first.id, [
        { role: "user", content: "And in June?", at: "2026-08-01T10:01:00.000Z" },
        { role: "assistant", content: "You spent $38 on coffee in June.", at: "2026-08-01T10:01:01.000Z" },
      ]);
      expect(continued.id).toBe(first.id);
      expect(continued.turns).toHaveLength(4);

      const list = await store.listConversations();
      expect(list).toHaveLength(1);
      expect(list[0].turnCount).toBe(4);

      const loaded = await store.getConversation(first.id);
      expect(loaded?.turns).toHaveLength(4);
    });

    it("deletes a conversation by id, and reports an unknown id as not found", async () => {
      const started = await store.appendTurns(undefined, [
        { role: "user", content: "What are my subscriptions?", at: "2026-08-02T09:00:00.000Z" },
        { role: "assistant", content: "You have five recurring charges.", at: "2026-08-02T09:00:01.000Z" },
      ]);

      expect(await store.deleteConversation(started.id)).toBe(true);
      expect(await store.getConversation(started.id)).toBeUndefined();
      expect(await store.listConversations()).toHaveLength(0);
      // A second delete — or an id that never existed — is a miss, so the route
      // can 404 rather than falsely claim it removed something.
      expect(await store.deleteConversation(started.id)).toBe(false);
      expect(await store.deleteConversation("conv_missing")).toBe(false);
    });

    it("deletes a file, its text, and its summary fact together", async () => {
      const file = await store.addFile({ name: "notes.txt", mediaType: "text/plain", text: "temporary" });
      expect(await store.deleteFile(file.id)).toBe(true);
      expect(await store.getFileText(file.id)).toBeUndefined();
      expect((await store.listFacts()).some((f) => f.source === `file:${file.id}`)).toBe(false);
      expect(await store.deleteFile(file.id)).toBe(false);
    });

    it("deletes a fact by id", async () => {
      const fact = await store.addFact({ text: "Dislikes surprises on the bill." });
      expect(await store.deleteFact(fact.id)).toBe(true);
      expect(await store.listFacts()).toHaveLength(0);
      expect(await store.deleteFact(fact.id)).toBe(false);
    });
  });
}

describe("AgentMemoryProvider isolation", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  async function providers(): Promise<AgentMemoryProvider[]> {
    tmp = await mkdtemp(join(tmpdir(), "bc-mem-prov-"));
    return [new InMemoryAgentMemoryProvider(), new FileAgentMemoryProvider(tmp)];
  }

  it("gives each user their own memory and hands the same user the same store", async () => {
    for (const provider of await providers()) {
      const alice = await provider.forUser("usr_alice");
      const bob = await provider.forUser("usr_bob");
      const aliceAgain = await provider.forUser("usr_alice");

      await alice.addFact({ text: "Alice prefers weekly summaries." });

      // Bob cannot see Alice's fact...
      expect(await bob.listFacts()).toHaveLength(0);
      // ...and the same user resolves to the same underlying memory.
      expect((await aliceAgain.listFacts())[0]?.text).toBe("Alice prefers weekly summaries.");
    }
  });
});
