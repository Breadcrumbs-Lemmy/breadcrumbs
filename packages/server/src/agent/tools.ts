/**
 * The agent's tool surface: the deterministic engine, and nothing else.
 *
 * `D-002` says the product is decision support, not advice. `D-003` says the
 * deterministic engine comes before any AI surface. `S-010` says AI explains
 * computed facts and must not perform financial calculations. Those three
 * constraints have one architectural consequence, and it is this file: **every
 * number the agent can say comes back from `@ai-fin-os/core`.**
 *
 * The model chooses which question to ask and how to phrase the answer. It
 * never adds, divides, compares periods, or classifies a transfer — the same
 * functions that render the Spending screen produce the figures it reads, so
 * the chat and the screen cannot disagree.
 *
 * Consequently there is no `calculate` tool, and there never should be. If the
 * agent needs a figure that doesn't exist here, the fix is a new deterministic
 * function in core, not a smarter prompt.
 */
import {
  annotateRecurrenceSignals,
  buildAccountsView,
  detectInsights,
  detectRecurringSpending,
  getCategoryMetadata,
  periodForDate,
  periodFromKey,
  queryTransactions,
  spendingSeries,
  summarizeSpending,
} from "@ai-fin-os/core";
import type { Account, PeriodKind, Transaction } from "@ai-fin-os/core";

import { getLocalSpendingState } from "../local/statement-import";
import type { StatementImportStore } from "../local/store";
import type { AgentMemoryStore } from "./memory/store";

/** A calendar period kind the period-scoped tools serve (no "statement"). */
type CalendarPeriodKind = "week" | "month" | "year";

/**
 * What the user is currently looking at, forwarded from the browser.
 *
 * This is the mechanism that keeps the assistant's answer scoped to the view:
 * when the user is on Pulse ▸ Week ▸ "week of 25 May" and asks "how much did I
 * spend?", the tools default to *that* week rather than the current month. It is
 * only a default — an explicit tool parameter from the model always wins — and
 * every field is optional, so an unscoped caller behaves exactly as before.
 */
export type AgentScope = {
  /** Route id, e.g. "spending". */
  route?: string;
  /** Human screen name, e.g. "Pulse". */
  screen?: string;
  /** The selected period. `kind` may be "statement"; that names the account but
   *  not a calendar period, so the calendar-period tools ignore its kind/key. */
  period?: { kind: PeriodKind; key?: string; label?: string };
  /** The selected account filter. */
  account?: { id: string; label?: string };
  /** Extra one-line facts about the view (a drill-down focus, a filter). */
  notes?: string[];
};

export type AgentToolContext = {
  store: StatementImportStore;
  currency: string;
  /** The assistant's per-user memory. Present when a conversation is stored;
   *  absent for stateless callers (e.g. statement extraction). When absent, the
   *  memory tools are simply not offered to the model. */
  memory?: AgentMemoryStore;
  /** What the user is currently viewing. When present, the tools default their
   *  period and account filter to it so answers are scoped to the screen. */
  scope?: AgentScope;
};

/** Calendar period kinds a period-scoped tool can default to. A statement scope
 *  names an account but not a calendar period, so it never forces a period. */
const TOOL_PERIOD_KINDS = new Set<PeriodKind>(["week", "month", "year"]);

/** The viewed calendar period, when the user is on one of the calendar kinds.
 *  Undefined for a statement view — those tools don't serve statement periods,
 *  so forcing its key/kind onto them would be wrong, not merely unhelpful. */
function scopedPeriod(
  context: AgentToolContext,
): { kind: CalendarPeriodKind; key?: string } | undefined {
  const p = context.scope?.period;
  if (!p || !TOOL_PERIOD_KINDS.has(p.kind)) return undefined;
  return { kind: p.kind as CalendarPeriodKind, key: p.key };
}

/** The viewed account filter, if one is applied. Statement views carry the card
 *  here too, so "spent on this card's statement" scopes correctly. */
function scopedAccountId(context: AgentToolContext): string | undefined {
  return context.scope?.account?.id;
}

type Loaded = { accounts: Account[]; transactions: Transaction[]; asOfDate: string };

async function load(context: AgentToolContext): Promise<Loaded> {
  const state = await getLocalSpendingState(context.store, context.currency);
  const transactions = annotateRecurrenceSignals({
    transactions: state.transactions,
    accounts: state.accounts,
    currency: context.currency,
  });
  return { accounts: state.accounts, transactions, asOfDate: asOfDateFor(transactions) };
}

/** Derived from the data, never the wall clock — same rule as the HTTP routes,
 *  so the agent and the screens describe the same "now". */
function asOfDateFor(transactions: Transaction[]): string {
  let latest = "1970-01-01";
  for (const t of transactions) if (t.postedDate > latest) latest = t.postedDate;
  return latest === "1970-01-01" ? new Date().toISOString().slice(0, 10) : latest;
}

function categoryLabel(id: string): string {
  return getCategoryMetadata(id)?.displayName ?? id;
}

export type AgentToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>, context: AgentToolContext) => Promise<unknown>;
};

/**
 * Descriptions state *when* to call, not just what the tool does — recent Opus
 * models reach for tools conservatively, and a trigger condition in the
 * description is what closes that gap.
 */
export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "get_spending_summary",
    description:
      "Totals for one period: money out, money in, what's left, category breakdown, per-account attribution, and the comparison against recent periods. Call this whenever the user asks how much they spent, what they spent it on, how a period compares to another, or where their money went. Transfers between the user's own accounts and credit-card payments are already excluded — do not subtract them again.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["week", "month", "year"],
          description: "Calendar period kind. Defaults to month.",
        },
        key: {
          type: "string",
          description:
            "Which period: '2026-07' for a month, '2026-W30' for a week, '2026' for a year. Omit for the most recent period in the data.",
        },
        accountId: { type: "string", description: "Limit to one account." },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      const sp = scopedPeriod(context);
      const kind = (input.period as PeriodKind) ?? sp?.kind ?? "month";
      // Inherit the viewed key only when the model didn't name one AND the kind
      // still matches the view — a week key like '2026-W21' is meaningless to a
      // month summary and would silently fall back to the current month.
      const key =
        (input.key as string | undefined) ?? (sp && sp.kind === kind ? sp.key : undefined);
      const accountId =
        (input.accountId as string | undefined) ?? scopedAccountId(context);
      return summarizeSpending({
        transactions,
        accounts,
        currency: context.currency,
        asOfDate,
        kind,
        key,
        accountId,
        categoryLabel,
      });
    },
  },
  {
    name: "get_spending_trend",
    description:
      "Totals across the last N periods, plus per-category series. Call this when the user asks about trends, whether something is going up or down over time, or wants several periods at once. Prefer this over calling get_spending_summary repeatedly.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["week", "month", "year"] },
        count: { type: "integer", minimum: 2, maximum: 24 },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      // A trend spans many periods, so only the granularity carries over from
      // the view, never a single period key.
      const sp = scopedPeriod(context);
      return spendingSeries({
        transactions,
        accounts,
        currency: context.currency,
        asOfDate,
        kind: (input.period as CalendarPeriodKind) ?? sp?.kind ?? "month",
        count: (input.count as number) ?? 6,
        categoryLabel,
      });
    },
  },
  {
    name: "find_transactions",
    description:
      "The individual transactions behind a figure, filtered by date range, account, category, flow type, or merchant search. Call this whenever the user asks 'which ones', 'what were they', or doubts a total — every claim you make should be checkable against real rows.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to: { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        accountId: { type: "string" },
        category: { type: "string", description: "Category id, e.g. groceries." },
        flowType: {
          type: "string",
          enum: ["SPEND", "INCOME", "TRANSFER_OUT", "TRANSFER_IN", "REFUND", "FEE", "UNCLASSIFIED"],
        },
        search: { type: "string", description: "Merchant name substring." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      let from = input.from as string | undefined;
      let to = input.to as string | undefined;
      // When the model names no date range, inherit the viewed period's exact
      // bounds so "which ones?" lists the rows behind the figure on screen — the
      // week the user picked, not an unbounded search across all history.
      if (from === undefined && to === undefined) {
        const sp = scopedPeriod(context);
        const period = sp
          ? sp.key
            ? periodFromKey(sp.kind, sp.key, asOfDate)
            : periodForDate(sp.kind, asOfDate, asOfDate)
          : undefined;
        if (period) {
          from = period.startDate;
          to = period.endDate;
        }
      }
      const accountId =
        (input.accountId as string | undefined) ?? scopedAccountId(context);
      return queryTransactions({
        transactions,
        accounts,
        currency: context.currency,
        from,
        to,
        accountId,
        category: input.category as string | undefined,
        flowType: input.flowType as never,
        search: input.search as string | undefined,
        limit: (input.limit as number) ?? 25,
        categoryLabel,
      });
    },
  },
  {
    name: "get_insights",
    description:
      "Detected patterns for a period: frequent small purchases, categories rising sharply, overlapping services, and the recurring-subscription list with its monthly total. Call this when the user asks what stands out, where they're wasting money, what they could cut, or about subscriptions.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["week", "month", "year"] },
        key: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      const sp = scopedPeriod(context);
      const kind = (input.period as CalendarPeriodKind) ?? sp?.kind ?? "month";
      const key =
        (input.key as string | undefined) ?? (sp && sp.kind === kind ? sp.key : undefined);
      return detectInsights({
        transactions,
        accounts,
        currency: context.currency,
        asOfDate,
        kind,
        key,
        categoryLabel,
      });
    },
  },
  {
    name: "get_recurring_detail",
    description:
      "Full detection detail for recurring charges: cadence, evidence, confidence, assumptions, and why specific merchants were excluded. Call this when the user questions a subscription finding or asks why something was or wasn't counted.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: async (_input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      return detectRecurringSpending({
        transactions,
        accounts,
        currency: context.currency,
        analysisDate: asOfDate,
        includeDiagnostics: true,
      });
    },
  },
  {
    name: "get_accounts",
    description:
      "Connected institutions, balances, net position, and credit-card statement cycles. Call this when the user asks about balances, which accounts exist, or what their card's current statement covers.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: async (_input, context) => {
      const { accounts, transactions, asOfDate } = await load(context);
      return buildAccountsView({ accounts, transactions, currency: context.currency, asOfDate });
    },
  },
];

export function findAgentTool(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/**
 * The memory tools. Offered only when the context carries a memory store, and
 * kept separate from the deterministic tools so the read-only-over-core
 * invariant stays obvious: none of these touch a financial figure. They let the
 * assistant keep durable notes, manage a working scratchpad, and re-read what
 * the user has uploaded — all against files on this machine, no network.
 */
export const MEMORY_TOOLS: AgentToolDefinition[] = [
  {
    name: "remember_fact",
    description:
      "Save something durable about this user so you still know it in future conversations — a stated preference (e.g. they budget fortnightly, they want to cut takeaway), a standing circumstance, or a correction they made. Call this when the user tells you something worth remembering long-term. Do not store transaction amounts or figures; those come from the deterministic tools. Keep each fact to one sentence.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, in one plain sentence." },
        kind: {
          type: "string",
          enum: ["fact", "preference"],
          description: "'preference' for how they want things done; 'fact' for a standing circumstance.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const memory = requireMemory(context);
      const text = String(input.text ?? "").trim();
      if (!text) throw new Error("Nothing to remember.");
      const fact = await memory.addFact({
        text,
        kind: input.kind === "preference" ? "preference" : "fact",
        source: "user",
      });
      return { saved: true, id: fact.id };
    },
  },
  {
    name: "update_working_note",
    description:
      "Rewrite your short-term working note — the running scratchpad for the current thread (what the user is trying to do, the period in focus, what you've established so far). Keep it brief. Call this when the focus of the conversation shifts, so you don't have to re-derive context each turn. This replaces the whole note.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The full new working note. Markdown is fine." },
      },
      required: ["note"],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const memory = requireMemory(context);
      await memory.writeShortTerm(String(input.note ?? ""));
      return { updated: true };
    },
  },
  {
    name: "search_memory",
    description:
      "Search your long-term facts and the files the user has uploaded for passages relevant to a query. Call this when the user refers to something they told you before or to a document they gave you, and the answer isn't already in front of you. Returns matching facts and file snippets — not financial figures.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const memory = requireMemory(context);
      const query = String(input.query ?? "").trim();
      if (!query) return { facts: [], fileSnippets: [] };
      const retrieval = await memory.retrieve(query, { maxFacts: 8, maxSnippets: 4 });
      return {
        facts: retrieval.facts.map((f) => ({ text: f.text, kind: f.kind })),
        fileSnippets: retrieval.fileSnippets.map((s) => ({ file: s.name, snippet: s.snippet })),
      };
    },
  },
];

function requireMemory(context: AgentToolContext): AgentMemoryStore {
  if (!context.memory) throw new Error("Memory is not available in this context.");
  return context.memory;
}

/** The tools the model is offered for a given context: always the deterministic
 *  engine, plus the memory tools when a memory store is present. */
export function toolsForContext(context: AgentToolContext): AgentToolDefinition[] {
  return context.memory ? [...AGENT_TOOLS, ...MEMORY_TOOLS] : AGENT_TOOLS;
}
