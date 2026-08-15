/**
 * The assistant's memory behaviour at the orchestration level: it remembers a
 * user across conversations, folds what it knows into the model's context, and
 * saves durable facts when told to — all provable without a live model.
 *
 * A stub `ChatProvider` stands in for the LLM. It lets us drive the exact tool
 * calls a real model might make and inspect the system prompt the model would
 * have seen, so the parts the product promised ("long-term memory", "a
 * short-term memory file", "remembers the user's conversations") are tested
 * rather than trusted.
 */
import { describe, expect, it } from "vitest";

import { runAgentChat } from "../src/agent/chat";
import type { AgentConfig } from "../src/agent/config";
import { InMemoryAgentMemoryStore } from "../src/agent/memory/store";
import type {
  AgentToolCallRecord,
  ChatProvider,
  ChatProviderResult,
  RunChatInput,
  ToolInvocation,
} from "../src/agent/provider";
import { InMemoryStatementImportStore } from "../src/local/store";

const config: AgentConfig = {
  provider: "local",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  model: "stub",
  chatEffort: "medium",
  extractionEffort: "high",
  maxToolIterations: 8,
  supportsStatementExtraction: false,
};

/** A provider that records every system prompt it sees and runs a fixed script
 *  of tool calls before replying — a stand-in for whatever a real model does. */
class StubProvider implements ChatProvider {
  readonly id = "local" as const;
  readonly model = "stub";
  readonly offline = true;
  readonly systems: string[] = [];

  constructor(private readonly behavior: (input: RunChatInput) => Promise<ChatProviderResult>) {}

  async runChat(input: RunChatInput): Promise<ChatProviderResult> {
    this.systems.push(input.system);
    return this.behavior(input);
  }
}

function scripted(calls: ToolInvocation[], text: string) {
  return async (input: RunChatInput): Promise<ChatProviderResult> => {
    const toolCalls: AgentToolCallRecord[] = [];
    for (const call of calls) {
      // One response batch, so every call is the model's first reply to the user.
      const outcome = await input.executeTool(call, { iteration: 0 });
      toolCalls.push({ tool: call.name, input: call.input, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
    }
    return { kind: "reply", text, toolCalls, stopReason: "stop" };
  };
}

function context(memory: InMemoryAgentMemoryStore) {
  return { store: new InMemoryStatementImportStore(), currency: "USD", memory };
}

describe("assistant memory orchestration", () => {
  it("persists an exchange and continues the same conversation by id", async () => {
    const memory = new InMemoryAgentMemoryStore();
    const provider = new StubProvider(scripted([], "You spent $42 on coffee in July."));

    const first = await runAgentChat({
      config,
      context: context(memory),
      messages: [{ role: "user", content: "How much did I spend on coffee?" }],
      provider,
    });

    expect(first.kind).toBe("reply");
    if (first.kind !== "reply") return;
    expect(first.offline).toBe(true);
    expect(first.conversationId).toBeTruthy();

    let conversations = await memory.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].turnCount).toBe(2); // the user turn + the reply

    const second = await runAgentChat({
      config,
      context: context(memory),
      messages: [
        { role: "user", content: "How much did I spend on coffee?" },
        { role: "assistant", content: "You spent $42 on coffee in July." },
        { role: "user", content: "And in June?" },
      ],
      conversationId: first.conversationId,
      provider: new StubProvider(scripted([], "You spent $38 in June.")),
    });
    expect(second.kind === "reply" && second.conversationId).toBe(first.conversationId);

    conversations = await memory.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].turnCount).toBe(4);
  });

  it("folds saved facts, the working note, and file passages into the model's context", async () => {
    const memory = new InMemoryAgentMemoryStore();
    await memory.addFact({ text: "Budgets fortnightly.", kind: "preference", source: "user" });
    await memory.writeShortTerm("Focus: cutting the takeaway habit.");
    await memory.addFile({
      name: "goals.md",
      mediaType: "text/markdown",
      text: "This year I want to halve my takeaway and restaurant spending.",
    });

    const provider = new StubProvider(scripted([], "Here's what your takeaway spending looks like."));
    await runAgentChat({
      config,
      context: context(memory),
      messages: [{ role: "user", content: "How am I doing on takeaway spending?" }],
      provider,
    });

    const system = provider.systems[0];
    expect(system).toContain("Budgets fortnightly.");
    expect(system).toContain("Focus: cutting the takeaway habit.");
    // The uploaded file's relevant passage is retrieved by keyword and injected.
    expect(system).toMatch(/takeaway/i);
    expect(system).toContain("goals.md");
  });

  it("saves a durable fact when the model calls remember_fact", async () => {
    const memory = new InMemoryAgentMemoryStore();
    const provider = new StubProvider(
      scripted(
        [{ name: "remember_fact", input: { text: "Prefers weekly summaries.", kind: "preference" } }],
        "Got it — I'll keep that in mind.",
      ),
    );

    const result = await runAgentChat({
      config,
      context: context(memory),
      messages: [{ role: "user", content: "Please give me weekly summaries from now on." }],
      provider,
    });

    expect(result.kind === "reply" && result.toolCalls.some((c) => c.tool === "remember_fact" && c.ok)).toBe(true);
    const facts = await memory.listFacts();
    expect(facts.some((f) => f.text === "Prefers weekly summaries." && f.kind === "preference")).toBe(true);
  });

  it("updates the short-term working note when the model calls update_working_note", async () => {
    const memory = new InMemoryAgentMemoryStore();
    const provider = new StubProvider(
      scripted([{ name: "update_working_note", input: { note: "Focus: August subscriptions." } }], "Noted."),
    );

    await runAgentChat({
      config,
      context: context(memory),
      messages: [{ role: "user", content: "Let's look at my subscriptions this month." }],
      provider,
    });

    expect(await memory.readShortTerm()).toBe("Focus: August subscriptions.");
  });
});
