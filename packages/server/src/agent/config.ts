/**
 * Agent configuration, and the switch that keeps the product working without it.
 *
 * The agent is optional in exactly the way Plaid is optional: without a provider
 * the routes are not registered, every deterministic endpoint still works, and
 * the UI shows how to turn it on rather than a broken chat box. A finance
 * product whose spending screen depends on an LLM being reachable is a worse
 * product than one where the LLM is a layer on top.
 *
 * Two providers, chosen by `BREADCRUMBZ_AGENT_PROVIDER`:
 *
 *   anthropic  (default) The hosted Claude model. Enabled by ANTHROPIC_API_KEY.
 *              Can also transcribe PDF statements.
 *   local      An OpenAI-compatible model served on this machine. Enabled by
 *              BREADCRUMBZ_LOCAL_AGENT_BASE_URL, which must be a loopback address
 *              (enforced in `provider.ts`) so the assistant cannot reach the
 *              internet. It answers chat AND transcribes digital PDFs offline —
 *              the server extracts the text layer and the local model reads it.
 *
 * Chat and statement extraction are two different jobs and can run on two
 * different providers (`BREADCRUMBZ_EXTRACTION_PROVIDER`, defaulting to the chat
 * provider). Extraction is a narrow, well-defined task — statement text into
 * rows — so it can be pointed at a small, cheap specialist while chat runs
 * on-device, or vice-versa. That independence has a privacy consequence: with a
 * local chat model and a HOSTED extractor, a statement's text leaves the machine
 * on import even though chat never does. So the offline guarantee is resolved and
 * reported PER JOB (see the status route), never collapsed into one flag that
 * would then be a lie in exactly that configuration.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentProvider = "anthropic" | "local";

export type AgentConfig = {
  provider: AgentProvider;
  /** Present for the hosted provider. */
  apiKey?: string;
  /** Present for the local provider — a loopback OpenAI-compatible base URL. */
  localBaseUrl?: string;
  /** Escape hatch: run the local model on a trusted non-loopback host. Relaxes
   *  the no-internet guarantee, so it is opt-in and off by default. */
  allowNonLoopback?: boolean;
  model: string;
  /** The model used for statement extraction. Interactive chat only phrases
   *  pre-computed tool results (present.ts guarantees the figures), so a small
   *  fast model is safe there; extraction reads an unfamiliar statement layout
   *  into structured rows — the one job where model capability really shows.
   *  Defaults to the chat `model`, so a fast chat model can be paired with a
   *  stronger extractor without forcing the single-model setup to change.
   *  `loadAgentConfig` always sets it; optional only so a hand-built config
   *  (tests) can omit it and fall back to `model`. */
  extractionModel?: string;

  /** The provider that reads PDF/text statements, resolved independently of the
   *  chat provider (`BREADCRUMBZ_EXTRACTION_PROVIDER`). Defaults to `provider`,
   *  so an unset var is a pure no-op. `loadAgentConfig` always sets it; optional
   *  only so a hand-built config (tests) can omit it and fall back to `provider`.
   *
   *  PRIVACY: when this is "anthropic" while `provider` is "local", statement
   *  text leaves the machine on import even though chat is offline. That case is
   *  why `offline` must be reported per-job, never as a single flag. */
  extractionProvider?: AgentProvider;
  /** The API key for a HOSTED extractor. Resolved from ANTHROPIC_API_KEY, the
   *  same key chat uses when both are hosted — but kept as its own field so a
   *  local chat model (no `apiKey`) can still drive a hosted extractor. Consumers
   *  fall back to `apiKey` when a hand-built config omits it. */
  extractionApiKey?: string;
  /** The loopback base URL for a LOCAL extractor. Defaults to the chat
   *  `localBaseUrl` when extraction shares the local provider and no separate URL
   *  is set. Consumers fall back to `localBaseUrl` when a config omits it. */
  extractionLocalBaseUrl?: string;
  /** Escape hatch for a non-loopback LOCAL extractor. Inherited from the chat
   *  leg only when reusing its endpoint; a distinct extraction URL must opt in on
   *  its own, so a new host can't silently ride the chat host's relaxation. */
  extractionAllowNonLoopback?: boolean;

  /** Reasoning depth. Chat is interactive, so it runs lower than extraction. */
  chatEffort: Effort;
  extractionEffort: Effort;
  maxToolIterations: number;
  /** Whether the statement-extract route is registered: true when the extraction
   *  provider has the credentials it needs (a hosted key, or a local base URL).
   *  Both providers transcribe — the local one reads a digital PDF's text layer —
   *  so this is off only when an explicit `BREADCRUMBZ_EXTRACTION_PROVIDER` is
   *  missing its credential. */
  supportsStatementExtraction: boolean;
};

const DEFAULT_MODEL = "claude-opus-5";
// The mixed-config default: when chat is LOCAL and extraction is pointed at the
// HOSTED provider without naming a model, extraction is transcription — a narrow,
// well-defined job — so it defaults to a small, cheap model rather than the big
// chat default. That config is entered precisely to save money; silently billing
// the priciest model when the operator forgets the knob would defeat its purpose.
// (All-hosted extraction still inherits the chat model — see `resolveExtraction`.)
const DEFAULT_HOSTED_EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOOL_ITERATIONS = 12;

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig | undefined {
  // The chat leg gates the WHOLE agent, exactly as before: no chat provider, no
  // assistant. A misconfigured extraction leg never turns chat off — it only
  // withholds the extraction capability (see `resolveExtraction`).
  const chat = loadChatLeg(env);
  if (!chat) return undefined;

  const extraction = resolveExtraction(env, chat);

  return {
    provider: chat.provider,
    apiKey: chat.apiKey,
    localBaseUrl: chat.localBaseUrl,
    allowNonLoopback: chat.allowNonLoopback,
    model: chat.model,
    // Chat answers one question against tool results; medium keeps it responsive
    // without shallow reasoning. Extraction reads a real bank statement where a
    // misread row becomes a wrong total, so it runs high.
    chatEffort: "medium",
    extractionEffort: "high",
    // A hard ceiling on the tool loop. The tools are read-only, so a runaway loop
    // costs tokens rather than data — but it should still terminate.
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    extractionProvider: extraction.provider,
    extractionApiKey: extraction.apiKey,
    extractionLocalBaseUrl: extraction.localBaseUrl,
    extractionAllowNonLoopback: extraction.allowNonLoopback,
    extractionModel: extraction.model,
    supportsStatementExtraction: extraction.supported,
  };
}

/** Everything the CHAT provider needs, resolved on its own so it can gate the
 *  agent independently of extraction. `undefined` ⇒ not configured (degrade like
 *  a missing key rather than throwing). */
type ChatLeg = {
  provider: AgentProvider;
  apiKey?: string;
  localBaseUrl?: string;
  allowNonLoopback?: boolean;
  model: string;
};

function loadChatLeg(env: NodeJS.ProcessEnv): ChatLeg | undefined {
  const provider = normalizeProvider(env.BREADCRUMBZ_AGENT_PROVIDER, "anthropic");

  if (provider === "local") {
    const localBaseUrl = env.BREADCRUMBZ_LOCAL_AGENT_BASE_URL?.trim();
    if (!localBaseUrl) return undefined;
    const model = env.BREADCRUMBZ_LOCAL_AGENT_MODEL?.trim() || env.BREADCRUMBZ_AGENT_MODEL?.trim() || "local-model";
    return {
      provider: "local",
      localBaseUrl,
      allowNonLoopback: env.BREADCRUMBZ_LOCAL_AGENT_ALLOW_NONLOOPBACK?.trim() === "true",
      model,
    };
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.BREADCRUMBZ_AGENT_MODEL?.trim() || DEFAULT_MODEL;
  return { provider: "anthropic", apiKey, model };
}

/** Everything the EXTRACTION provider needs, resolved from its own env vars and
 *  defaulting to the chat leg so an unset `BREADCRUMBZ_EXTRACTION_PROVIDER` is a
 *  pure no-op (every field mirrors chat — backward compatible). */
type ExtractionLeg = {
  provider: AgentProvider;
  apiKey?: string;
  localBaseUrl?: string;
  allowNonLoopback?: boolean;
  model: string;
  supported: boolean;
};

function resolveExtraction(env: NodeJS.ProcessEnv, chat: ChatLeg): ExtractionLeg {
  const provider = normalizeProvider(env.BREADCRUMBZ_EXTRACTION_PROVIDER, chat.provider);

  if (provider === "anthropic") {
    // Reuse ANTHROPIC_API_KEY — there is no separate extraction key. When chat is
    // also hosted this is literally the chat key; when chat is local, it is the
    // key an operator adds to send statements to a hosted extractor.
    const apiKey = env.ANTHROPIC_API_KEY?.trim() || (chat.provider === "anthropic" ? chat.apiKey : undefined);
    // Do NOT inherit a local chat model name (e.g. "qwen2.5:3b") as a hosted
    // model. Default to the chat model only when chat is itself hosted; in the
    // mixed config (local chat) there is no hosted chat model to borrow, so fall
    // back to a small, cheap specialist (not the big chat default) — this split
    // exists so extraction need not run a big model, and the config is entered to
    // save money. The operator can still override with BREADCRUMBZ_EXTRACTION_MODEL.
    const model =
      env.BREADCRUMBZ_EXTRACTION_MODEL?.trim() ||
      (chat.provider === "anthropic" ? chat.model : DEFAULT_HOSTED_EXTRACTION_MODEL);
    // Explicitly requesting a hosted extractor with no key on hand leaves
    // extraction OFF (route unregistered) rather than silently falling back —
    // `describeAgentConfigConcerns` turns that into a startup warning.
    return { provider, apiKey, model, supported: Boolean(apiKey) };
  }

  // provider === "local"
  const explicitUrl = env.BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL?.trim();
  // Reuse the chat model's endpoint when extraction shares the local provider and
  // no separate URL is given — the common "same Ollama, bigger extraction model".
  const localBaseUrl = explicitUrl || (chat.provider === "local" ? chat.localBaseUrl : undefined);
  // Inherit the loopback escape hatch ONLY when reusing the chat endpoint; a
  // distinct extraction URL must opt in on its own.
  const inheritedHatch = !explicitUrl && chat.provider === "local" ? Boolean(chat.allowNonLoopback) : false;
  const allowNonLoopback = env.BREADCRUMBZ_LOCAL_EXTRACTION_ALLOW_NONLOOPBACK?.trim() === "true" || inheritedHatch;
  const model =
    env.BREADCRUMBZ_LOCAL_EXTRACTION_MODEL?.trim() || (chat.provider === "local" ? chat.model : "local-model");
  return { provider, localBaseUrl, allowNonLoopback, model, supported: Boolean(localBaseUrl) };
}

/**
 * Operator-facing warnings about the resolved agent config — logged once at
 * startup (see `server.ts`). Two cases both centre on the extraction split:
 *
 *  1. An explicit `BREADCRUMBZ_EXTRACTION_PROVIDER` whose credential is missing:
 *     chat still works, but statement import is silently off until it is fixed.
 *     (Detectable from the config alone: a defaulted extraction leg mirrors the
 *     chat creds, so `supported` is false ONLY when a provider was named.)
 *  2. Local chat + HOSTED extraction: chat is on-device but statements leave the
 *     machine on import. The on-device guarantee is chat-only, and that must be
 *     said out loud, not buried in a config file.
 */
export function describeAgentConfigConcerns(config: AgentConfig): string[] {
  const warnings: string[] = [];
  const extractionProvider = config.extractionProvider ?? config.provider;

  if (!config.supportsStatementExtraction) {
    warnings.push(
      extractionProvider === "anthropic"
        ? "BREADCRUMBZ_EXTRACTION_PROVIDER=anthropic is set but ANTHROPIC_API_KEY is missing — statement extraction is disabled (chat still works)."
        : "BREADCRUMBZ_EXTRACTION_PROVIDER=local is set but BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL is missing — statement extraction is disabled (chat still works).",
    );
  } else if (config.provider === "local" && extractionProvider === "anthropic") {
    warnings.push(
      "Chat runs on-device, but statement extraction uses the HOSTED provider: a statement's text leaves this machine when a PDF is imported. The on-device guarantee covers chat only.",
    );
  }

  return warnings;
}

function normalizeProvider(raw: string | undefined, fallback: AgentProvider): AgentProvider {
  const value = raw?.trim().toLowerCase();
  if (value === "local") return "local";
  if (value === "anthropic") return "anthropic";
  return fallback;
}
