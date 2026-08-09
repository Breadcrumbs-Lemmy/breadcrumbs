/**
 * Statement extraction across a chat/extraction provider split.
 *
 * The chat provider and the extraction provider are resolved independently, so a
 * local (offline) chat model can hand statements to a HOSTED extractor, or a
 * hosted chat model can hand them to a LOCAL one. These cases prove the fork
 * itself: extraction routes on `extractionProvider`, the hosted path carries the
 * `extractionApiKey`/`extractionModel` (not the chat leg's), and the local path
 * checks loopback against `extractionLocalBaseUrl`. The offline path is covered
 * in depth in `statement-extraction-local.test.ts`; here we only assert routing.
 *
 * The Anthropic SDK is mocked so the hosted path runs without a network call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractStatement } from "../src/agent/statement-extraction";
import type { AgentConfig } from "../src/agent/config";

// Hoisted so the mock factory (evaluated before imports) can close over them.
const { anthropicCtor, anthropicCreate } = vi.hoisted(() => {
  const anthropicCreate = vi.fn();
  const anthropicCtor = vi.fn(() => ({ beta: { messages: { create: anthropicCreate } } }));
  return { anthropicCtor, anthropicCreate };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicCtor }));

/** A hosted structured-output response carrying one transaction row. */
function hostedReply() {
  return {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          outflowPositive: true,
          warnings: [],
          rows: [{ date: "2026-07-01", description: "COFFEE", amount: "4.50" }],
        }),
      },
    ],
  };
}

/** An OpenAI-compatible local reply with one row. */
function localReply(): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                outflowPositive: true,
                warnings: [],
                rows: [{ date: "2026-07-01", description: "COFFEE", amount: "4.50" }],
              }),
            },
          },
        ],
      };
    },
    async text() {
      return "";
    },
  } as unknown as Response;
}

const BASE: Omit<AgentConfig, "provider" | "extractionProvider"> = {
  model: "chat-model",
  chatEffort: "medium",
  extractionEffort: "high",
  maxToolIterations: 12,
  supportsStatementExtraction: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  anthropicCtor.mockClear();
  anthropicCreate.mockReset();
});

describe("extractStatement provider split", () => {
  it("routes a LOCAL chat + HOSTED extraction config to the hosted path, with the extraction key", async () => {
    anthropicCreate.mockResolvedValue(hostedReply());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStatement({
      config: {
        ...BASE,
        provider: "local",
        localBaseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:3b",
        extractionProvider: "anthropic",
        extractionApiKey: "sk-extract",
        extractionModel: "claude-haiku-4-5-20251001",
      },
      document: { kind: "text", text: "COFFEE 4.50" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);

    // Hosted path taken: the SDK was constructed with the EXTRACTION key (the
    // local chat leg has none), and the local OpenAI endpoint was never hit.
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-extract" });
    expect(anthropicCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a HOSTED chat + LOCAL extraction config to the local path, at the extraction URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(localReply());
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStatement({
      config: {
        ...BASE,
        provider: "anthropic",
        apiKey: "sk-chat",
        model: "claude-opus-5",
        extractionProvider: "local",
        extractionLocalBaseUrl: "http://127.0.0.1:8080/v1",
        extractionAllowNonLoopback: false,
        extractionModel: "nuextract",
      },
      document: { kind: "text", text: "COFFEE 4.50" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);

    // Local path taken at the EXTRACTION endpoint, carrying the extraction model;
    // the hosted SDK was never constructed.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(JSON.parse((init as RequestInit).body as string).model).toBe("nuextract");
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("checks loopback against the EXTRACTION url, so a non-loopback extractor is refused before any send", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Chat is loopback-clean, but extraction points off-machine without the hatch:
    // the statement text must never be posted, and the guard trips on the URL that
    // is actually used — the extraction one.
    const result = await extractStatement({
      config: {
        ...BASE,
        provider: "local",
        localBaseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:3b",
        extractionProvider: "local",
        extractionLocalBaseUrl: "http://statements.example.com/v1",
        extractionAllowNonLoopback: false,
      },
      document: { kind: "text", text: "sensitive statement text" },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toMatch(/loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
