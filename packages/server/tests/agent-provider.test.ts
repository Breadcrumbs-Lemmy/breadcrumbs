/**
 * The no-internet guarantee for the local assistant.
 *
 * The product promises a model that "runs locally and cannot access the
 * internet". That promise is only worth anything if it is enforced in code, so
 * these cases prove the enforcement point: a local provider pointed anywhere but
 * a loopback address refuses to start, and a hosted provider is never mistaken
 * for an offline one. No network is touched — construction alone is the subject.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AgentConfigError,
  AnthropicChatProvider,
  assertLoopbackUrl,
  createChatProvider,
  describeAnthropicError,
  isLoopbackHost,
  LocalChatProvider,
} from "../src/agent/provider";
import { describeAgentConfigConcerns, loadAgentConfig } from "../src/agent/config";
import type { AgentConfig } from "../src/agent/config";

function localConfig(baseUrl: string, allowNonLoopback = false): AgentConfig {
  return {
    provider: "local",
    localBaseUrl: baseUrl,
    allowNonLoopback,
    model: "local-model",
    chatEffort: "medium",
    extractionEffort: "high",
    maxToolIterations: 12,
    supportsStatementExtraction: false,
  };
}

function anthropicConfig(): AgentConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-test-not-real",
    model: "claude-opus-5",
    chatEffort: "medium",
    extractionEffort: "high",
    maxToolIterations: 12,
    supportsStatementExtraction: true,
  };
}

describe("isLoopbackHost", () => {
  it("accepts every loopback form and nothing else", () => {
    for (const host of ["127.0.0.1", "127.5.6.7", "::1", "localhost", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    // 0.0.0.0 is a bind-all address, not a loopback destination, and public or
    // private LAN addresses are exactly what must be refused.
    for (const host of ["0.0.0.0", "10.0.0.5", "192.168.1.10", "8.8.8.8", "api.openai.com", "example.com"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("assertLoopbackUrl", () => {
  it("returns the URL for a loopback endpoint", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:11434/v1").hostname).toBe("127.0.0.1");
    expect(assertLoopbackUrl("http://localhost:1234/v1").hostname).toBe("localhost");
  });

  it("refuses a remote host so the local agent cannot phone home", () => {
    expect(() => assertLoopbackUrl("https://api.openai.com/v1")).toThrow(AgentConfigError);
    expect(() => assertLoopbackUrl("http://10.1.2.3:11434")).toThrow(/loopback/i);
  });

  it("refuses a non-http protocol and a malformed URL", () => {
    expect(() => assertLoopbackUrl("ftp://127.0.0.1")).toThrow(AgentConfigError);
    expect(() => assertLoopbackUrl("not a url")).toThrow(AgentConfigError);
  });
});

describe("createChatProvider", () => {
  it("builds an offline local provider for a loopback endpoint", () => {
    const provider = createChatProvider(localConfig("http://127.0.0.1:11434/v1"));
    expect(provider).toBeInstanceOf(LocalChatProvider);
    expect(provider.offline).toBe(true);
  });

  it("refuses to build a local provider aimed off-machine", () => {
    expect(() => createChatProvider(localConfig("https://api.openai.com/v1"))).toThrow(AgentConfigError);
  });

  it("honours the explicit non-loopback escape hatch", () => {
    const provider = createChatProvider(localConfig("http://10.0.0.2:11434/v1", true));
    expect(provider).toBeInstanceOf(LocalChatProvider);
    // Still offline in the sense that matters to the UI copy: it is the local
    // provider, just trusted to a LAN host the operator opted into.
    expect(provider.offline).toBe(true);
  });

  it("builds a hosted provider that is never marked offline", () => {
    const provider = createChatProvider(anthropicConfig());
    expect(provider).toBeInstanceOf(AnthropicChatProvider);
    expect(provider.offline).toBe(false);
  });
});

describe("describeAnthropicError never leaks the raw provider message to the UI", () => {
  // The exact blob a user caught on the assistant page: a real model rejecting an
  // unsupported request parameter. The raw provider message is operator-diagnostic
  // (it can echo request internals — an unsupported param, a prompt fragment,
  // potentially the key), so it must never be concatenated into what we show.
  const RAW = "This model does not support the effort parameter.";

  it("genericises an Anthropic APIError (400) but keeps the safe status code", () => {
    const apiError = new Anthropic.APIError(400, undefined, RAW, undefined);
    const shown = describeAnthropicError(apiError);
    expect(shown).not.toContain(RAW);
    expect(shown).not.toMatch(/effort/i);
    // The status code is safe and useful for triage, so it survives.
    expect(shown).toContain("400");
  });

  it("genericises an unknown Error rather than echoing its message", () => {
    const shown = describeAnthropicError(new Error(RAW));
    expect(shown).not.toContain(RAW);
    expect(shown).not.toMatch(/effort/i);
    expect(shown.length).toBeGreaterThan(0);
  });

  it("passes our own actionable AgentConfigError through unchanged", () => {
    // Hand-authored, safe, and the fix is in the message — do not genericise it.
    const message = "Anthropic agent requires ANTHROPIC_API_KEY.";
    expect(describeAnthropicError(new AgentConfigError(message))).toBe(message);
  });

  it("keeps the specific auth and rate-limit hints", () => {
    const auth = new Anthropic.AuthenticationError(401, undefined, "raw auth detail", new Headers());
    expect(describeAnthropicError(auth)).toMatch(/ANTHROPIC_API_KEY/);
    const rate = new Anthropic.RateLimitError(429, undefined, "raw rate detail", new Headers());
    expect(describeAnthropicError(rate)).toMatch(/rate limited/i);
  });
});

describe("loadAgentConfig provider selection", () => {
  it("stays unconfigured when nothing is set", () => {
    expect(loadAgentConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("stays unconfigured for a local provider with no endpoint", () => {
    expect(loadAgentConfig({ BREADCRUMBZ_AGENT_PROVIDER: "local" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("configures a local provider that extracts statements from a PDF's text layer", () => {
    const config = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_MODEL: "qwen2.5",
    } as NodeJS.ProcessEnv);
    expect(config?.provider).toBe("local");
    expect(config?.model).toBe("qwen2.5");
    // The server extracts the PDF's text and hands it to the local model, so the
    // local provider now transcribes digital statements offline. Only scanned,
    // image-only PDFs still need the hosted model.
    expect(config?.supportsStatementExtraction).toBe(true);
  });

  it("configures the hosted provider from an API key", () => {
    const config = loadAgentConfig({ ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(config?.provider).toBe("anthropic");
    expect(config?.supportsStatementExtraction).toBe(true);
  });

  it("gives local statement extraction its own model, defaulting to the chat model", () => {
    // The split: a fast small chat model paired with a stronger extractor — chat
    // only phrases pre-computed figures, extraction reads the statement layout.
    const split = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_MODEL: "qwen2.5:3b",
      BREADCRUMBZ_LOCAL_EXTRACTION_MODEL: "qwen2.5:32b",
    } as NodeJS.ProcessEnv);
    expect(split?.model).toBe("qwen2.5:3b");
    expect(split?.extractionModel).toBe("qwen2.5:32b");

    // Unset ⇒ the single-model setup is untouched: extraction uses the chat model.
    const single = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_MODEL: "qwen2.5:7b",
    } as NodeJS.ProcessEnv);
    expect(single?.extractionModel).toBe("qwen2.5:7b");
  });

  it("lets the hosted provider run a different extraction model than chat", () => {
    const split = loadAgentConfig({
      ANTHROPIC_API_KEY: "sk-test",
      BREADCRUMBZ_AGENT_MODEL: "claude-haiku-4-5-20251001",
      BREADCRUMBZ_EXTRACTION_MODEL: "claude-opus-5",
    } as NodeJS.ProcessEnv);
    expect(split?.model).toBe("claude-haiku-4-5-20251001");
    expect(split?.extractionModel).toBe("claude-opus-5");

    // Unset ⇒ extraction falls back to the chat model (here, the default).
    const single = loadAgentConfig({ ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(single?.extractionModel).toBe(single?.model);
  });
});

describe("loadAgentConfig extraction provider split", () => {
  it("defaults the extraction provider to the chat provider, mirroring its credentials", () => {
    // Unset BREADCRUMBZ_EXTRACTION_PROVIDER must be a pure no-op: extraction runs
    // exactly where chat does, with the same key / URL — full backward compat.
    const hosted = loadAgentConfig({ ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(hosted?.extractionProvider).toBe("anthropic");
    expect(hosted?.extractionApiKey).toBe("sk-test");
    expect(hosted?.supportsStatementExtraction).toBe(true);

    const local = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
    } as NodeJS.ProcessEnv);
    expect(local?.extractionProvider).toBe("local");
    expect(local?.extractionLocalBaseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(local?.supportsStatementExtraction).toBe(true);
  });

  it("pairs a local (offline) chat model with a small, cheap HOSTED extractor", () => {
    // The cost-minimising shape the split exists for: chat is free/on-device, and
    // the narrow extraction job runs on a cheap hosted model the operator names.
    const config = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_MODEL: "qwen2.5:3b",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-extract",
      BREADCRUMBZ_EXTRACTION_MODEL: "claude-haiku-4-5-20251001",
    } as NodeJS.ProcessEnv);

    expect(config?.provider).toBe("local");
    expect(config?.extractionProvider).toBe("anthropic");
    // The hosted extractor carries its OWN key even though chat (local) has none.
    expect(config?.apiKey).toBeUndefined();
    expect(config?.extractionApiKey).toBe("sk-extract");
    expect(config?.extractionModel).toBe("claude-haiku-4-5-20251001");
    expect(config?.supportsStatementExtraction).toBe(true);
  });

  it("defaults a hosted extractor to a small, cheap model — never the local chat tag", () => {
    // A hosted extractor with no BREADCRUMBZ_EXTRACTION_MODEL must fall back to a
    // valid hosted model, NOT the local chat tag ("qwen2.5:3b") — which would 404.
    // In this mixed config (local chat) the fallback is a small/cheap model, not
    // the big chat default: the config is entered to save money, so a forgotten
    // knob must not silently bill the priciest model.
    const config = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_MODEL: "qwen2.5:3b",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-extract",
    } as NodeJS.ProcessEnv);
    expect(config?.extractionModel).toBe("claude-haiku-4-5-20251001");
    expect(config?.extractionModel).not.toBe("qwen2.5:3b");
    // And not the big chat default.
    expect(config?.extractionModel).not.toBe("claude-opus-5");
  });

  it("disables extraction (chat stays up) when a hosted extractor has no key", () => {
    const config = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "anthropic",
      // no ANTHROPIC_API_KEY
    } as NodeJS.ProcessEnv);
    // Chat is unaffected — the agent is still configured.
    expect(config?.provider).toBe("local");
    // But extraction is off, and the operator is warned rather than left guessing.
    expect(config?.supportsStatementExtraction).toBe(false);
    expect(describeAgentConfigConcerns(config as AgentConfig).join(" ")).toMatch(/ANTHROPIC_API_KEY is missing/);
  });

  it("routes extraction to a separate LOCAL endpoint, with its own loopback hatch", () => {
    const config = loadAgentConfig({
      ANTHROPIC_API_KEY: "sk-test",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL: "http://127.0.0.1:8080/v1",
      BREADCRUMBZ_LOCAL_EXTRACTION_MODEL: "nuextract",
    } as NodeJS.ProcessEnv);
    expect(config?.provider).toBe("anthropic");
    expect(config?.extractionProvider).toBe("local");
    expect(config?.extractionLocalBaseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(config?.extractionModel).toBe("nuextract");
    expect(config?.supportsStatementExtraction).toBe(true);
  });

  it("disables extraction when a local extractor has no base URL", () => {
    const config = loadAgentConfig({
      ANTHROPIC_API_KEY: "sk-test",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "local",
      // no BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL
    } as NodeJS.ProcessEnv);
    expect(config?.supportsStatementExtraction).toBe(false);
    expect(describeAgentConfigConcerns(config as AgentConfig).join(" ")).toMatch(/BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL is missing/);
  });

  it("inherits the loopback hatch only when extraction reuses the chat endpoint", () => {
    // Same-endpoint split: extraction rides the chat host's relaxation.
    const shared = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://ollama:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_ALLOW_NONLOOPBACK: "true",
      BREADCRUMBZ_LOCAL_EXTRACTION_MODEL: "qwen2.5:32b",
    } as NodeJS.ProcessEnv);
    expect(shared?.extractionLocalBaseUrl).toBe("http://ollama:11434/v1");
    expect(shared?.extractionAllowNonLoopback).toBe(true);

    // A DISTINCT extraction URL must opt in on its own — it does not inherit.
    const distinct = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_LOCAL_AGENT_ALLOW_NONLOOPBACK: "true",
      BREADCRUMBZ_LOCAL_EXTRACTION_BASE_URL: "http://extractor.lan:8080/v1",
    } as NodeJS.ProcessEnv);
    expect(distinct?.extractionAllowNonLoopback).toBe(false);
  });

  it("warns that the on-device guarantee is chat-only when extraction is hosted", () => {
    const config = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
      BREADCRUMBZ_EXTRACTION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-extract",
    } as NodeJS.ProcessEnv);
    const concerns = describeAgentConfigConcerns(config as AgentConfig);
    expect(concerns.join(" ")).toMatch(/leaves this machine/i);

    // The all-local and all-hosted setups raise nothing (extraction supported and
    // running on the same provider as chat).
    const allLocal = loadAgentConfig({
      BREADCRUMBZ_AGENT_PROVIDER: "local",
      BREADCRUMBZ_LOCAL_AGENT_BASE_URL: "http://127.0.0.1:11434/v1",
    } as NodeJS.ProcessEnv);
    expect(describeAgentConfigConcerns(allLocal as AgentConfig)).toEqual([]);
    expect(describeAgentConfigConcerns(anthropicConfig())).toEqual([]);
  });
});
