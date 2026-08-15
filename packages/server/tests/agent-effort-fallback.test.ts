/**
 * `output_config.effort` and the server-side `fallbacks` parameter are per-model
 * capabilities. Operators can point the agent at any model, including ones that
 * reject either with a 400 — which used to be concatenated raw onto the assistant
 * page. `createBetaMessage` sends them, and if the model rejects one it strips it,
 * retries, and remembers the model so later calls skip it. The API reports
 * unsupported features one 400 at a time, so a request carrying both heals across
 * successive retries. These cases pin that behaviour; no network is touched — the
 * Anthropic client is a recording stub.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { createBetaMessage } from "../src/agent/provider";

/** An error that is `instanceof Anthropic.APIError` with the given status/message,
 *  built via the prototype so the test doesn't depend on the SDK constructor. */
type APIError = InstanceType<typeof Anthropic.APIError>;
function apiError(status: number, message: string): APIError {
  return Object.assign(Object.create(Anthropic.APIError.prototype) as APIError, {
    status,
    message,
  });
}

const EFFORT_400 = () => apiError(400, "This model does not support the effort parameter.");

/** A recording stub shaped like the one field of `Anthropic` we use. `create`
 *  runs the next queued behaviour and records the params it was called with. */
function stubClient(behaviours: Array<() => unknown>) {
  const calls: any[] = [];
  let i = 0;
  const create = vi.fn(async (params: unknown) => {
    calls.push(params);
    const behave = behaviours[Math.min(i, behaviours.length - 1)];
    i += 1;
    return behave();
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create, calls };
}

const reply = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

describe("createBetaMessage effort fallback", () => {
  it("sends effort unchanged and returns the reply when the model accepts it", async () => {
    const { client, create, calls } = stubClient([() => reply("ok")]);
    const res = await createBetaMessage(client, {
      model: "model-accepts-effort",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "medium" },
    } as any);

    expect(create).toHaveBeenCalledTimes(1);
    expect(calls[0].output_config).toEqual({ effort: "medium" });
    expect((res as any).content[0].text).toBe("ok");
  });

  it("strips output_config entirely when effort was its only field, then retries", async () => {
    const { client, create, calls } = stubClient([
      () => {
        throw EFFORT_400();
      },
      () => reply("healed"),
    ]);
    const res = await createBetaMessage(client, {
      model: "chat-model-no-effort",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "medium" },
    } as any);

    expect(create).toHaveBeenCalledTimes(2);
    // First attempt carried effort; the retry dropped output_config completely.
    expect(calls[0].output_config).toEqual({ effort: "medium" });
    expect(calls[1].output_config).toBeUndefined();
    expect((res as any).content[0].text).toBe("healed");
  });

  it("keeps the structured-output format on retry, dropping only effort", async () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    const { client, calls } = stubClient([
      () => {
        throw EFFORT_400();
      },
      () => reply("rows"),
    ]);
    await createBetaMessage(client, {
      model: "extract-model-no-effort",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "high", format },
    } as any);

    // Retry preserved `format`, removed `effort` — extraction's guaranteed shape survives.
    expect(calls[1].output_config).toEqual({ format });
    expect(calls[1].output_config.effort).toBeUndefined();
  });

  it("omits effort up front on later calls to a model already known to reject it", async () => {
    const { client, create, calls } = stubClient([
      () => {
        throw EFFORT_400();
      },
      () => reply("first-healed"),
      () => reply("second"),
    ]);
    const params = {
      model: "sticky-no-effort-model",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "medium" },
    };

    await createBetaMessage(client, { ...params, output_config: { effort: "medium" } } as any);
    await createBetaMessage(client, { ...params, output_config: { effort: "medium" } } as any);

    // First call: attempt + retry (2). Second call: single attempt, effort pre-stripped (no failure).
    expect(create).toHaveBeenCalledTimes(3);
    expect(calls[2].output_config).toBeUndefined();
  });

  it("does not mutate the caller's params object", async () => {
    const { client } = stubClient([
      () => {
        throw EFFORT_400();
      },
      () => reply("ok"),
    ]);
    const params = {
      model: "immutability-model",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "medium" },
    };
    await createBetaMessage(client, params as any);
    // The original still carries effort — stripping happened on a copy.
    expect(params.output_config).toEqual({ effort: "medium" });
  });

  it("rethrows a 400 that is not about effort instead of swallowing it", async () => {
    const { client, create } = stubClient([
      () => {
        throw apiError(400, "messages: at least one message is required");
      },
    ]);
    await expect(
      createBetaMessage(client, {
        model: "unrelated-400-model",
        max_tokens: 100,
        messages: [],
        output_config: { effort: "medium" },
      } as any),
    ).rejects.toThrow(/at least one message/);
    // No retry — the error was not an effort rejection.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("strips fallbacks (and its server-side-fallback beta) when the model rejects it", async () => {
    const { client, create, calls } = stubClient([
      () => {
        throw apiError(400, "'some-model' does not support the `fallbacks` parameter.");
      },
      () => reply("healed"),
    ]);
    const res = await createBetaMessage(client, {
      model: "model-no-fallbacks",
      max_tokens: 100,
      messages: [],
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    } as any);

    expect(create).toHaveBeenCalledTimes(2);
    // Retry dropped `fallbacks` and the now-purposeless beta that enabled it.
    expect(calls[1].fallbacks).toBeUndefined();
    expect(calls[1].betas).toBeUndefined();
    expect((res as any).content[0].text).toBe("healed");
  });

  it("keeps unrelated betas when stripping fallbacks", async () => {
    const { client, calls } = stubClient([
      () => {
        throw apiError(400, "fallbacks: Extra inputs are not permitted");
      },
      () => reply("ok"),
    ]);
    await createBetaMessage(client, {
      model: "model-mixed-betas",
      max_tokens: 100,
      messages: [],
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01", "some-other-beta-2026"],
    } as any);

    // Only the server-side-fallback beta is dropped; the unrelated one survives.
    expect(calls[1].fallbacks).toBeUndefined();
    expect(calls[1].betas).toEqual(["some-other-beta-2026"]);
  });

  it("heals two unsupported features across successive retries (effort, then fallbacks)", async () => {
    const { client, create, calls } = stubClient([
      () => {
        throw EFFORT_400();
      },
      () => {
        throw apiError(400, "This model does not support the `fallbacks` parameter.");
      },
      () => reply("healed-twice"),
    ]);
    const res = await createBetaMessage(client, {
      model: "model-no-effort-no-fallbacks",
      max_tokens: 100,
      messages: [],
      output_config: { effort: "medium" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    } as any);

    // Attempt 1 (full) → effort 400; attempt 2 (no effort) → fallbacks 400;
    // attempt 3 (neither) → reply. The API surfaces one rejection at a time.
    expect(create).toHaveBeenCalledTimes(3);
    expect(calls[1].output_config).toBeUndefined();
    expect(calls[1].fallbacks).toBe("default");
    expect(calls[2].output_config).toBeUndefined();
    expect(calls[2].fallbacks).toBeUndefined();
    expect(calls[2].betas).toBeUndefined();
    expect((res as any).content[0].text).toBe("healed-twice");
  });
});
