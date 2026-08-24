/**
 * Where the assistant's model runs — and the guarantee that a "local" one cannot
 * phone home.
 *
 * Two providers behind one interface:
 *
 *   anthropic  The hosted Claude model. Reaches the Anthropic API over the
 *              internet. This is the default when ANTHROPIC_API_KEY is set.
 *   local      An OpenAI-compatible model served on this machine (Ollama,
 *              llama.cpp, LM Studio, …). Its base URL is checked at startup and
 *              REJECTED unless it is a loopback address, so the "runs locally,
 *              cannot access the internet" requirement is enforced in code, not
 *              just in a comment. A misconfiguration fails loudly at boot rather
 *              than silently shipping a user's transactions to a remote host.
 *
 * The chat loop is written against `ChatProvider`, so memory, tools, and the
 * turn orchestration are identical whichever model answers.
 */
import Anthropic from "@anthropic-ai/sdk";

import type { AgentConfig, Effort } from "./config";

export type { Effort };

export type NormalizedTool = { name: string; description: string; input_schema: Record<string, unknown> };

export type ToolInvocation = { name: string; input: Record<string, unknown> };

export type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string };

/**
 * Per-call context the tool runner needs to make provenance decisions.
 *
 * `iteration` is the model's loop index for this call: 0 is its first response
 * to the user's own message this turn — no tool result has been fed back yet —
 * while ≥1 means the model has already read at least one tool result, so the
 * call is a *continuation* driven by tool output (which may carry
 * instruction-shaped text). Memory writes are gated on this (see chat.ts). Every
 * `ChatProvider` must supply it so the gate cannot be bypassed.
 */
export type ToolCallMeta = { iteration: number };

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AgentToolCallRecord = {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
};

export type ChatProviderResult =
  | { kind: "reply"; text: string; toolCalls: AgentToolCallRecord[]; stopReason: string | null }
  | { kind: "declined"; message: string; category?: string }
  | { kind: "error"; message: string };

export type RunChatInput = {
  system: string;
  messages: ChatMessage[];
  tools: NormalizedTool[];
  executeTool: (call: ToolInvocation, meta: ToolCallMeta) => Promise<ToolOutcome>;
  effort: Effort;
  maxIterations: number;
  maxTokens: number;
};

export interface ChatProvider {
  readonly id: "anthropic" | "local";
  readonly model: string;
  /** True when the model runs on this machine with no network egress. Surfaced
   *  to the UI so a user can see whether their data leaves the device. */
  readonly offline: boolean;
  runChat(input: RunChatInput): Promise<ChatProviderResult>;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

// ---- Loopback enforcement — the no-internet guarantee -----------------------

/**
 * Accept only addresses that cannot leave the machine. Anything else throws, so
 * a "local" agent pointed at a remote URL never starts. IPv4 loopback is the
 * whole 127.0.0.0/8 block; IPv6 loopback is ::1; `localhost` resolves to one of
 * those on any sane host.
 */
export function assertLoopbackUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AgentConfigError(`Local agent URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentConfigError(`Local agent URL must be http(s): ${rawUrl}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new AgentConfigError(
      `Local agent URL must be a loopback address (127.0.0.1, ::1, or localhost) so it cannot reach the internet — got "${url.hostname}". ` +
        `To run the model on another trusted host, set BREADCRUMBZ_LOCAL_AGENT_ALLOW_NONLOOPBACK=true, which relaxes this guarantee.`,
    );
  }
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv4, including the full 127/8 loopback block.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) return m[1] === "127" && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  return false;
}

// ---- Anthropic provider (hosted) --------------------------------------------

const ANTHROPIC_SYSTEM_MAX_TOKENS = 8000;

// We send a few near-future request features by default — `output_config.effort`
// and the server-side `fallbacks` parameter — but they are per-model capabilities.
// Operators can point the agent at any model (BREADCRUMBZ_AGENT_MODEL /
// _EXTRACTION_MODEL), including ones that reject a given feature with a 400 that
// used to surface on the assistant page. Rather than maintain a model→capability
// allowlist (which rots the moment a new model ships), we send the feature, and if
// the model rejects it we strip it, retry, and remember not to send it to that
// model again. One wasted round-trip per (model, capability) the first time; zero
// after. The API reports unsupported features one 400 at a time, so a request that
// carries two of them heals across successive retries — not in a single shot.
type BetaCreateParams = Parameters<Anthropic["beta"]["messages"]["create"]>[0];
type AnthropicAPIError = InstanceType<typeof Anthropic.APIError>;

/** Return a copy of `params` with `output_config.effort` removed, dropping
 *  `output_config` entirely only if `effort` was its sole field (so structured-
 *  output `format` and any other config survive). */
function withoutEffort(params: BetaCreateParams): BetaCreateParams {
  const oc = (params as { output_config?: Record<string, unknown> }).output_config;
  if (!oc || !("effort" in oc)) return params;
  const { effort: _dropped, ...restOfConfig } = oc;
  const next = { ...params } as BetaCreateParams & { output_config?: Record<string, unknown> };
  if (Object.keys(restOfConfig).length > 0) next.output_config = restOfConfig;
  else delete next.output_config;
  return next;
}

/** Return a copy of `params` with the server-side `fallbacks` parameter removed,
 *  along with the now-purposeless `server-side-fallback-*` beta that enabled it. */
function withoutFallbacks(params: BetaCreateParams): BetaCreateParams {
  const next = { ...params } as BetaCreateParams & { fallbacks?: unknown; betas?: unknown };
  delete next.fallbacks;
  if (Array.isArray(next.betas)) {
    const kept = next.betas.filter((b) => !/server-side-fallback/i.test(String(b)));
    if (kept.length > 0) next.betas = kept;
    else delete next.betas;
  }
  return next;
}

/** A request feature some models don't accept. Each knows how to spot itself in
 *  the params, recognise the 400 that rejects it, and strip itself back out. */
type ModelCapability = {
  label: string;
  /** Models known to reject this feature — filled in as we learn, so later calls
   *  to the same model omit it up front. */
  rejectedBy: Set<string>;
  present: (params: BetaCreateParams) => boolean;
  rejects: (error: AnthropicAPIError) => boolean;
  strip: (params: BetaCreateParams) => BetaCreateParams;
};

const CAPABILITIES: ModelCapability[] = [
  {
    label: "output_config.effort",
    rejectedBy: new Set<string>(),
    present: (p) => {
      const oc = (p as { output_config?: Record<string, unknown> }).output_config;
      return Boolean(oc && "effort" in oc);
    },
    rejects: (e) => /effort/i.test(e.message),
    strip: withoutEffort,
  },
  {
    label: "the fallbacks parameter",
    rejectedBy: new Set<string>(),
    present: (p) => (p as { fallbacks?: unknown }).fallbacks !== undefined,
    rejects: (e) => /fallbacks/i.test(e.message),
    strip: withoutFallbacks,
  },
];

/** `client.beta.messages.create`, but resilient to a model that doesn't support a
 *  near-future feature we send by default (`output_config.effort`, server-side
 *  `fallbacks`). Strips features the model is already known to reject up front, and
 *  self-heals the first time a new model 400s on one: strip it, retry, and
 *  remember. Multiple unsupported features heal across successive retries, since
 *  the API reports them one 400 at a time. Any 400 we don't recognise — or a repeat
 *  rejection of something already stripped — propagates unchanged. */
export async function createBetaMessage(
  client: Anthropic,
  params: BetaCreateParams,
): Promise<Anthropic.Beta.BetaMessage> {
  const model = params.model;
  // Pre-strip everything this model is already known to reject.
  let attempt = CAPABILITIES.reduce(
    (p, cap) => (cap.rejectedBy.has(model) && cap.present(p) ? cap.strip(p) : p),
    params,
  );

  // At most one heal per capability, so the loop is bounded by CAPABILITIES.length.
  for (let i = 0; i <= CAPABILITIES.length; i += 1) {
    try {
      return (await client.beta.messages.create(attempt)) as Anthropic.Beta.BetaMessage;
    } catch (error) {
      if (!(error instanceof Anthropic.APIError) || error.status !== 400) throw error;
      // `present` guards against re-stripping (and thus an infinite loop): once a
      // feature is gone it can't match again, so an unchanged repeat 400 rethrows.
      const cap = CAPABILITIES.find((c) => c.present(attempt) && c.rejects(error));
      if (!cap) throw error;
      cap.rejectedBy.add(model);
      console.warn(
        `[agent] model "${model}" rejected ${cap.label} — retrying without it and omitting it for future calls.`,
      );
      attempt = cap.strip(attempt);
    }
  }
  // Exhausted the known capabilities; a final attempt lets the real error surface.
  return (await client.beta.messages.create(attempt)) as Anthropic.Beta.BetaMessage;
}

export class AnthropicChatProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly offline = false;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async runChat(input: RunChatInput): Promise<ChatProviderResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const toolCalls: AgentToolCallRecord[] = [];

    try {
      for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
        const response = await createBetaMessage(this.client, {
          model: this.model,
          max_tokens: input.maxTokens || ANTHROPIC_SYSTEM_MAX_TOKENS,
          system: input.system,
          output_config: { effort: input.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema as Anthropic.Beta.BetaTool["input_schema"],
          })),
          messages,
        });

        if (response.stop_reason === "refusal") {
          return {
            kind: "declined",
            message: "That request was declined. Try asking about your spending instead.",
            category: response.stop_details?.category ?? undefined,
          };
        }

        const toolUses = response.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
        );

        if (toolUses.length === 0) {
          return { kind: "reply", text: textFromAnthropic(response.content), toolCalls, stopReason: response.stop_reason };
        }

        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.Beta.BetaContentBlockParam[] = [];
        for (const toolUse of toolUses) {
          const call = { name: toolUse.name, input: (toolUse.input ?? {}) as Record<string, unknown> };
          const outcome = await input.executeTool(call, { iteration });
          toolCalls.push({ tool: call.name, input: call.input, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: outcome.ok ? JSON.stringify(outcome.output) : outcome.error,
            is_error: !outcome.ok,
          });
        }
        messages.push({ role: "user", content: results });
      }

      return { kind: "error", message: "The assistant kept looking things up without answering. Try a narrower question." };
    } catch (error) {
      return { kind: "error", message: describeAnthropicError(error) };
    }
  }
}

// ---- Local provider (OpenAI-compatible, loopback-only) ----------------------

type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export class LocalChatProvider implements ChatProvider {
  readonly id = "local" as const;
  readonly offline = true;
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly model: string,
    baseUrl: string,
    opts: { allowNonLoopback?: boolean; requestTimeoutMs?: number } = {},
  ) {
    // The guarantee: unless explicitly relaxed, the endpoint must be loopback.
    if (!opts.allowNonLoopback) assertLoopbackUrl(baseUrl);
    // Normalise `.../v1` → `.../v1/chat/completions`.
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  async runChat(input: RunChatInput): Promise<ChatProviderResult> {
    const messages: OpenAiMessage[] = [
      { role: "system", content: input.system },
      ...input.messages.map((m) => ({ role: m.role, content: m.content }) as OpenAiMessage),
    ];
    const tools = input.tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    const toolCalls: AgentToolCallRecord[] = [];

    try {
      for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
        const message = await this.callModel(messages, tools, input.maxTokens);
        const requested = message.tool_calls ?? [];

        if (requested.length === 0) {
          return {
            kind: "reply",
            text: (typeof message.content === "string" ? message.content : "").trim(),
            toolCalls,
            stopReason: "stop",
          };
        }

        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: requested });
        for (const toolCall of requested) {
          const parsed = safeParseArgs(toolCall.function.arguments);
          const call = { name: toolCall.function.name, input: parsed };
          const outcome = await input.executeTool(call, { iteration });
          toolCalls.push({ tool: call.name, input: parsed, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: outcome.ok ? JSON.stringify(outcome.output) : `ERROR: ${outcome.error}`,
          });
        }
      }
      return { kind: "error", message: "The assistant kept looking things up without answering. Try a narrower question." };
    } catch (error) {
      return { kind: "error", message: describeLocalError(error, this.endpoint) };
    }
  }

  private async callModel(
    messages: OpenAiMessage[],
    tools: unknown[],
    maxTokens: number,
  ): Promise<{ content: string | null; tool_calls?: OpenAiToolCall[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
          temperature: 0.2,
          max_tokens: maxTokens || 1024,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Local model returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content: string | null; tool_calls?: OpenAiToolCall[] } }>;
      };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("Local model returned no message.");
      return message;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- Factory ----------------------------------------------------------------

export function createChatProvider(config: AgentConfig): ChatProvider {
  if (config.provider === "local") {
    if (!config.localBaseUrl) throw new AgentConfigError("Local agent requires BREADCRUMBZ_LOCAL_AGENT_BASE_URL.");
    return new LocalChatProvider(config.model, config.localBaseUrl, {
      allowNonLoopback: config.allowNonLoopback,
    });
  }
  if (!config.apiKey) throw new AgentConfigError("Anthropic agent requires ANTHROPIC_API_KEY.");
  return new AnthropicChatProvider(config.model, config.apiKey);
}

// ---- Error/text helpers -----------------------------------------------------

function textFromAnthropic(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function describeAnthropicError(error: unknown): string {
  // Our own config guards (e.g. loopback enforcement) are hand-authored and
  // actionable — pass them through; only raw/unknown errors get genericized.
  if (error instanceof AgentConfigError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again in a moment.";
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  // The raw error.message can echo request internals (invalid params, the API key,
  // prompt fragments). Log it for the operator; hand the user only the status code.
  if (error instanceof Anthropic.APIError) {
    console.warn(`[agent] Anthropic API error (${error.status ?? "unknown"}):`, error.message);
    return `The assistant hit an API error (${error.status ?? "unknown"}). Please try again.`;
  }
  console.warn("[agent] assistant failure:", error);
  return "The assistant failed. Please try again.";
}

function describeLocalError(error: unknown, endpoint: string): string {
  if (error instanceof AgentConfigError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "The local model timed out. Is it running and responsive?";
  if (error instanceof Error && /fetch failed|ECONNREFUSED/i.test(error.message)) {
    return `Couldn't reach the local model at ${endpoint}. Is it running?`;
  }
  console.warn("[agent] local model failure:", error);
  return "The local assistant failed. Please try again.";
}
