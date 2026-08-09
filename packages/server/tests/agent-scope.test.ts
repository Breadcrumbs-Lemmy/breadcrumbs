/**
 * View-scoped assistant: the tools default to whatever the user is looking at.
 *
 * The bug this guards against is the one that made the assistant "say things
 * that make no sense": on Pulse ▸ Week ▸ "week of 22 May" a bare "how much did I
 * spend?" was answered for the current calendar month, because the browser never
 * told the server what was on screen. Now the browser forwards a scope, and the
 * period-scoped tools default to it (an explicit tool parameter still wins).
 *
 * Dates are deliberately in 2023, not the 2026 fixture year — the scoping logic
 * has to be right on the real 2021–2023 history a user imports, not just on
 * demo data (the CD-012 fixture blind spot).
 */
import { describe, expect, it } from "vitest";

import { runAgentChat } from "../src/agent/chat";
import type { AgentConfig } from "../src/agent/config";
import { findAgentTool } from "../src/agent/tools";
import type { AgentScope, AgentToolContext } from "../src/agent/tools";
import type {
  AgentToolCallRecord,
  ChatProvider,
  ChatProviderResult,
  RunChatInput,
  ToolInvocation,
} from "../src/agent/provider";
import { commitCsvStatementImport } from "../src/local/statement-import";
import { InMemoryStatementImportStore } from "../src/local/store";
import type { SpendingSummary, TransactionPage } from "@ai-fin-os/core";

/**
 * Spend across two ISO weeks in 2023. Week 21 (Mon 22 → Sun 28 May) holds two
 * charges totalling $72; a third, larger charge sits in June, a different month
 * *and* a different week — so a scoped answer and an unscoped one can't help but
 * differ, which is the whole point.
 */
async function seedStore(): Promise<InMemoryStatementImportStore> {
  const store = new InMemoryStatementImportStore();
  const csv = [
    "date,description,amount",
    "2023-05-24,COFFEE SHOP,12.00", // W21
    "2023-05-25,GROCERY MART,60.00", // W21
    "2023-06-10,ELECTRONICS STORE,500.00", // June — outside W21
  ].join("\n");

  await commitCsvStatementImport(
    {
      csv,
      accountId: "acct_main",
      account: {
        id: "acct_main",
        displayName: "Everyday Checking",
        institutionName: "First National",
        type: "checking",
        currency: "USD",
        currentBalanceCents: 200_000,
      },
      currency: "USD",
      dateFormat: "iso",
      mapping: {
        postedDate: "date",
        description: "description",
        amount: "amount",
        amountSignConvention: "outflow_positive",
      },
    },
    store,
  );

  return store;
}

function contextWith(store: InMemoryStatementImportStore, scope?: AgentScope): AgentToolContext {
  return { store, currency: "USD", scope };
}

// The week the user picked in the concrete report: "week of 25 May" falls in
// ISO week 21 of 2023 (Mon 22 → Sun 28 May), keyed "2023-W21".
const WEEK_21: AgentScope = {
  route: "spending",
  screen: "Pulse",
  period: { kind: "week", key: "2023-W21", label: "Week of May 22" },
};

describe("view-scoped spending summary", () => {
  it("defaults a bare summary to the viewed week, not the current month", async () => {
    const store = await seedStore();
    const tool = findAgentTool("get_spending_summary")!;

    const scoped = (await tool.run({}, contextWith(store, WEEK_21))) as SpendingSummary;

    // The headline: the answer is about the week on screen.
    expect(scoped.period.kind).toBe("week");
    expect(scoped.period.key).toBe("2023-W21");
    // Only the two in-week charges — the $500 June purchase is not counted.
    expect(scoped.totalOutflowCents).toBe(7200);
  });

  it("would answer for a different period without the scope — proving the scope changed it", async () => {
    const store = await seedStore();
    const tool = findAgentTool("get_spending_summary")!;

    const unscoped = (await tool.run({}, contextWith(store))) as SpendingSummary;

    // No scope → the old behaviour: most-recent calendar month, which is June
    // here. This is exactly the "confidently wrong" answer the scope prevents.
    expect(unscoped.period.kind).toBe("month");
    expect(unscoped.period.key).toBe("2023-06");
    expect(unscoped.period.key).not.toBe("2023-W21");
  });

  it("lets an explicit tool parameter override the scope", async () => {
    const store = await seedStore();
    const tool = findAgentTool("get_spending_summary")!;

    // The user is on the week view, but explicitly asks about June — the model's
    // stated intent must win over the ambient scope.
    const result = (await tool.run(
      { period: "month", key: "2023-06" },
      contextWith(store, WEEK_21),
    )) as SpendingSummary;

    expect(result.period.kind).toBe("month");
    expect(result.period.key).toBe("2023-06");
  });

  it("does not inherit a week key onto a month kind", async () => {
    const store = await seedStore();
    const tool = findAgentTool("get_spending_summary")!;

    // Asking for a month while the week is on screen must not carry the week key
    // '2023-W21' into the month query (it would silently fall back to current).
    const result = (await tool.run(
      { period: "month" },
      contextWith(store, WEEK_21),
    )) as SpendingSummary;

    expect(result.period.kind).toBe("month");
    // The key is resolved from the data, not the mismatched week key.
    expect(result.period.key).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("view-scoped transaction lookup", () => {
  it("scopes 'which ones' to the viewed week's real date bounds", async () => {
    const store = await seedStore();
    const tool = findAgentTool("find_transactions")!;

    const page = (await tool.run({}, contextWith(store, WEEK_21))) as TransactionPage;

    // Exactly the two W21 charges — the June purchase is outside the inherited
    // 22–28 May bounds, so it never appears.
    expect(page.totalCount).toBe(2);
    expect(page.transactions.every((t) => t.postedDate >= "2023-05-22" && t.postedDate <= "2023-05-28")).toBe(true);
  });

  it("still lets the model widen the range explicitly", async () => {
    const store = await seedStore();
    const tool = findAgentTool("find_transactions")!;

    // An explicit range is the model's decision and overrides the scope's bounds.
    const page = (await tool.run(
      { from: "2023-01-01", to: "2023-12-31" },
      contextWith(store, WEEK_21),
    )) as TransactionPage;

    expect(page.totalCount).toBe(3);
  });
});

// ---- The scope also reaches the model as prose ------------------------------

const config: AgentConfig = {
  provider: "local",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  model: "stub",
  chatEffort: "medium",
  extractionEffort: "high",
  maxToolIterations: 8,
  supportsStatementExtraction: false,
};

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
      const outcome = await input.executeTool(call);
      toolCalls.push({ tool: call.name, input: call.input, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
    }
    return { kind: "reply", text, toolCalls, stopReason: "stop" };
  };
}

describe("view scope in the system prompt", () => {
  it("names the viewed period so the model's wording matches the screen", async () => {
    const provider = new StubProvider(scripted([], "You spent $72 that week."));

    await runAgentChat({
      config,
      context: contextWith(await seedStore(), WEEK_21),
      messages: [{ role: "user", content: "How much did I spend?" }],
      provider,
    });

    const system = provider.systems[0];
    expect(system).toContain("What the user is looking at right now");
    expect(system).toContain("Week of May 22");
    expect(system).toContain("Pulse");
  });

  it("adds no scope block when the client sends none", async () => {
    const provider = new StubProvider(scripted([], "Sure."));

    await runAgentChat({
      config,
      context: contextWith(await seedStore()),
      messages: [{ role: "user", content: "How much did I spend?" }],
      provider,
    });

    expect(provider.systems[0]).not.toContain("What the user is looking at right now");
  });
});
