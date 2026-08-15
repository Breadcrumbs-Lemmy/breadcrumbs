/**
 * Assistant transport.
 *
 * The live transcript lives in browser state and is sent whole on each turn, so
 * the model always has the full thread even though the request is stateless.
 * When the server has a memory store wired, it also persists each exchange under
 * a `conversationId` and can learn from files the user uploads — so the two
 * things the product promises ("remembers your conversations", "learns from the
 * files you give it") are reachable here, not just in the backend.
 */
import { del, get, post, type ApiOutcome } from "./api";
import type { AssistantScope } from "./assistant-scope";

export type AgentStatus = {
  configured: boolean;
  model: string | null;
  capabilities: string[];
  boundaries: string[];
  /** "anthropic" (hosted) or "local" (on-device). Null when unconfigured. */
  provider?: "anthropic" | "local" | null;
  /** True when the CHAT model runs on this machine with no network egress. */
  offline?: boolean;
  /** Where statement extraction runs — it can differ from `provider`. */
  extractionProvider?: "anthropic" | "local" | null;
  /** True when statement extraction stays on the machine. False means a PDF's
   *  text is sent to a hosted model on import, so `offline` alone would overstate
   *  the guarantee — the UI must qualify the on-device claim when this is false. */
  extractionOffline?: boolean | null;
  /** True when a memory store is wired: uploads, saved facts, and persistent
   *  conversation history are available. */
  memory?: boolean;
  reason?: string;
};

export type AgentMessage = { role: "user" | "assistant"; content: string };

export type AgentToolCallRecord = {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
};

export type AgentReply =
  | {
      kind: "reply";
      text: string;
      toolCalls: AgentToolCallRecord[];
      stopReason: string | null;
      /** The thread this exchange was saved under, echoed so the next turn can
       *  continue it. Absent when memory isn't wired. */
      conversationId?: string;
      /** True when this reply came from the on-device model. */
      offline?: boolean;
    }
  | { kind: "declined"; message: string; category?: string };

/** Defense-in-depth for the assistant surfaces. The server already sanitizes
 *  model/provider errors (see the `describe*Error` helpers), returning short,
 *  intended one-liners. But the assistant screen renders error text verbatim, so
 *  a stale server binary, a proxy, or a future regression could still hand the
 *  client a raw dump (an API error body, a leaked key) that would land in the DOM.
 *  Gate it here: pass a server message through only when it reads like an intended
 *  message; otherwise fall back to a generic line. Scoped to the assistant on
 *  purpose — login and validation screens legitimately show verbatim server text. */
const GENERIC_ASSISTANT_ERROR = "The assistant couldn't answer that. Please try again.";

export function safeAssistantError(message?: string | null): string {
  const trimmed = message?.trim();
  if (!trimmed) return GENERIC_ASSISTANT_ERROR;
  const looksRaw =
    trimmed.length > 200 || // intended messages are short one-liners; a dump is long
    /[\n\r]/.test(trimmed) || // multiple lines ⇒ a stack/body, not a sentence
    /[{}]/.test(trimmed) || // JSON error body
    /sk-[A-Za-z0-9-]{8,}/.test(trimmed); // a leaked API key
  return looksRaw ? GENERIC_ASSISTANT_ERROR : trimmed;
}

export function fetchAgentStatus(): Promise<ApiOutcome<AgentStatus>> {
  return get("/api/v1/agent/status");
}

/** Send one turn. Pass the `conversationId` returned by the previous reply to
 *  keep the exchange stored as one coherent thread rather than many fragments.
 *  `scope` describes what the user is currently looking at (screen + selected
 *  period + account filter); the server uses it to scope the answer to that
 *  view rather than the whole dataset. Optional — omit for an unscoped ask. */
export function sendAgentTurn(
  messages: AgentMessage[],
  conversationId?: string,
  scope?: AssistantScope,
): Promise<ApiOutcome<AgentReply>> {
  return post("/api/v1/agent/chat", { messages, currency: "USD", conversationId, scope });
}

// ---- Memory: files the assistant learns from -------------------------------

/** A file the user has handed the assistant to learn from. The full text lives
 *  on the server (this user's data dir only); the browser holds just metadata
 *  and a short excerpt. Mirrors the backend `UploadedFile`. */
export type LearnedFile = {
  id: string;
  name: string;
  mediaType: string;
  charCount: number;
  uploadedAt: string;
  excerpt: string;
};

export function listAgentFiles(): Promise<ApiOutcome<{ files: LearnedFile[] }>> {
  return get("/api/v1/agent/memory/files");
}

/** Upload a text document for the assistant to learn from. The backend caps the
 *  text at ~2MB and writes a short summary fact so recall works without a model. */
export function uploadAgentFile(
  name: string,
  text: string,
  mediaType = "text/plain",
): Promise<ApiOutcome<{ file: LearnedFile }>> {
  return post("/api/v1/agent/memory/files", { name, mediaType, text });
}

export function deleteAgentFile(id: string): Promise<ApiOutcome<null>> {
  return del(`/api/v1/agent/memory/files/${id}`);
}

// ---- Memory: past conversations (the chat-history browser) ------------------

/** One row in the history list — the conversation without its turns, plus a
 *  count so the list can show how long it was. Mirrors the backend list shape. */
export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
};

export type StoredConversationTurn = { role: "user" | "assistant"; content: string; at: string };

/** A full past conversation, loaded when the user reopens one from history. */
export type StoredConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: StoredConversationTurn[];
};

/** Past conversations for the signed-in user, newest first. Model-independent —
 *  reading history never touches the AI provider, so it works even offline. */
export function listConversations(): Promise<ApiOutcome<{ conversations: ConversationSummary[] }>> {
  return get("/api/v1/agent/memory/conversations");
}

export function getConversation(id: string): Promise<ApiOutcome<{ conversation: StoredConversation }>> {
  return get(`/api/v1/agent/memory/conversations/${id}`);
}

export function deleteConversation(id: string): Promise<ApiOutcome<{ deleted: boolean }>> {
  return del(`/api/v1/agent/memory/conversations/${id}`);
}

/** Plain-language names for the tools, so the "how it knows" line reads as an
 *  explanation rather than an internal function list. */
export const TOOL_LABELS: Record<string, string> = {
  get_spending_summary: "your spending totals",
  get_spending_trend: "your spending over time",
  find_transactions: "your transactions",
  get_insights: "detected patterns",
  get_recurring_detail: "recurring charge detection",
  get_accounts: "your accounts",
};
