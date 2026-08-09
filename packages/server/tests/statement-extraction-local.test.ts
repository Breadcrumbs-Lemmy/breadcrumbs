/**
 * Local statement extraction — the offline PDF/text path.
 *
 * The hosted model reads a PDF natively; the local model only ever sees text we
 * extract and hand it in chunks. These cases prove the parts that are ours, not
 * the model's: chunk-merging, tolerant JSON parsing, the CSV that rejoins the
 * ordinary import path, the scanned-PDF (no text layer) report, and — the one
 * that matters most — that the loopback guarantee still holds here, so a
 * statement's text can never be posted off the machine.
 *
 * `fetch` is stubbed so these run without a model; the live model path is
 * covered end-to-end in verification, not here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractStatement } from "../src/agent/statement-extraction";
import type { AgentConfig } from "../src/agent/config";

const LOCAL_CONFIG: AgentConfig = {
  provider: "local",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  allowNonLoopback: false,
  model: "test-model",
  chatEffort: "medium",
  extractionEffort: "high",
  maxToolIterations: 12,
  supportsStatementExtraction: true,
};

/** An OpenAI-compatible chat-completions response carrying `content`. */
function modelReply(content: string) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] };
    },
    async text() {
      return content;
    },
  } as unknown as Response;
}

function jsonReply(body: unknown): Response {
  return modelReply(JSON.stringify(body));
}

/** A reply the server stopped at its token limit (`finish_reason: "length"`). */
function truncatedReply(content: string): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content }, finish_reason: "length" }] };
    },
    async text() {
      return content;
    },
  } as unknown as Response;
}

/** The statement text a given fetch call actually carried to the model — what
 *  sits between the prompt's framing lines in the user message. */
function statementTextOf(call: unknown[]): string {
  const body = JSON.parse((call[1] as RequestInit).body as string) as {
    messages: Array<{ content: string }>;
  };
  const user = body.messages[1].content;
  const match = /Statement text:\n\n([\s\S]*)\n\nTranscribe every transaction/.exec(user);
  return match ? match[1] : "";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractStatement (local provider)", () => {
  it("transcribes a single chunk into rows, detected fields, and CSV", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonReply({
        accountName: "Everyday Checking",
        institutionName: "First Platypus Bank",
        currency: "USD",
        closingDay: 15,
        outflowPositive: true,
        warnings: ["Ambiguous year on line 2"],
        rows: [
          { date: "2026-07-03", description: "BLUE BOTTLE COFFEE", amount: "4.50" },
          { date: "2026-07-05", description: "ACME, INC. PAYROLL", amount: "-2200.00" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "Everyday Checking statement …" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(2);
    expect(result.detected).toEqual({
      accountName: "Everyday Checking",
      institutionName: "First Platypus Bank",
      currency: "USD",
      closingDay: 15,
      outflowPositive: true,
    });
    // Every field quoted so a comma in a description can't shift columns — and
    // this is the exact shape the CSV import reader already handles.
    expect(result.csv).toBe(
      'date,description,amount\n' +
        '"2026-07-03","BLUE BOTTLE COFFEE","4.50"\n' +
        '"2026-07-05","ACME, INC. PAYROLL","-2200.00"',
    );
    expect(result.warnings).toContain("Ambiguous year on line 2");

    // The endpoint is the base URL with /chat/completions, and it asked for JSON.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(JSON.parse((init as RequestInit).body as string).response_format).toEqual({
      type: "json_object",
    });
  });

  it("sends the configured extraction model, not the chat model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonReply({ outflowPositive: true, warnings: [], rows: [{ date: "2026-07-03", description: "X", amount: "1.00" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Chat runs a small fast model; extraction runs a stronger one. The request
    // that reads the statement must carry the extractor — that is the whole split.
    await extractStatement({
      config: { ...LOCAL_CONFIG, model: "chat-small", extractionModel: "extract-strong" },
      document: { kind: "text", text: "…" },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe("extract-strong");
  });

  it("falls back to the chat model when no extraction model is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonReply({ outflowPositive: true, warnings: [], rows: [{ date: "2026-07-03", description: "X", amount: "1.00" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // LOCAL_CONFIG carries model:"test-model" and no extractionModel — the
    // single-model setup must keep working untouched.
    await extractStatement({ config: LOCAL_CONFIG, document: { kind: "text", text: "…" } });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe("test-model");
  });

  it("merges rows across chunks and keeps the first chunk's metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonReply({
          accountName: "Acct One",
          outflowPositive: true,
          warnings: [],
          rows: [{ date: "2026-07-01", description: "FIRST", amount: "1.00" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonReply({
          // A later chunk's conflicting metadata must not overwrite the first.
          accountName: "Wrong Later Name",
          outflowPositive: false,
          warnings: ["part two note"],
          rows: [{ date: "2026-07-02", description: "SECOND", amount: "2.00" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // One text page longer than the 6000-char chunk budget is hard-split, so the
    // model is called twice and the two replies must be stitched in order.
    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "L".repeat(7000) },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain('"FIRST","1.00"');
    expect(result.csv).toContain('"SECOND","2.00"');
    // First non-empty reading wins for metadata and sign convention.
    expect(result.detected.accountName).toBe("Acct One");
    expect(result.detected.outflowPositive).toBe(true);
    expect(result.warnings).toContain("part two note");
  });

  it("parses JSON even when the model wraps it in a code fence or prose", async () => {
    const fenced =
      "Sure, here is the statement:\n```json\n" +
      JSON.stringify({
        outflowPositive: false,
        warnings: [],
        rows: [{ date: "2026-06-30", description: "RENT", amount: "-1800" }],
      }) +
      "\n```\nLet me know if you need anything else.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelReply(fenced)));

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain('"RENT","-1800"');
  });

  it("coerces numeric amounts and drops empty rows instead of failing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonReply({
          outflowPositive: true,
          // No warnings field, an amount as a number, and a blank row.
          rows: [
            { date: "2026-07-07", description: "GROCERY", amount: 52.4 },
            { date: "", description: "", amount: "" },
          ],
        }),
      ),
    );

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain('"GROCERY","52.4"');
    expect(result.warnings).toEqual([]);
  });

  it("reports a statement with no readable text (a scan) rather than importing nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "   \n  " },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toMatch(/no readable text/i);
    // No point calling the model when there is nothing to transcribe.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a friendly error when the local model is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("http://127.0.0.1:11434/v1");
  });

  it("refuses a non-loopback model URL so statement text cannot leave the machine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStatement({
      config: { ...LOCAL_CONFIG, localBaseUrl: "http://statements.example.com/v1" },
      document: { kind: "text", text: "sensitive statement text" },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toMatch(/loopback/i);
    // The guard trips before any network call — the text is never sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes the sign convention from the first chunk with rows, not a cover page's guess", async () => {
    // A cover/summary chunk carries no transactions but must still emit
    // `outflowPositive`; the model guesses (here, the wrong way). Latching that
    // guess would invert every amount, so the value must come from a chunk that
    // actually has rows.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonReply({ outflowPositive: false, warnings: [], rows: [] }))
      .mockResolvedValueOnce(
        jsonReply({
          outflowPositive: true,
          warnings: [],
          rows: [{ date: "2026-07-02", description: "PAYCHECK", amount: "-2200" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // Two chunks (>6000 chars): the first returns no rows, the second does.
    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "L".repeat(7000) },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);
    // true, from the chunk that had transactions — not false from the empty one.
    expect(result.detected.outflowPositive).toBe(true);
  });

  it("reads a sign convention the model returned as a string, and says it did", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonReply({
          // A local model may emit the boolean as text; the wrong sign silently
          // inverts every amount, so it is coerced and the reading is surfaced.
          outflowPositive: "true",
          warnings: [],
          rows: [{ date: "2026-07-02", description: "COFFEE", amount: "3.50" }],
        }),
      ),
    );

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.detected.outflowPositive).toBe(true);
    expect(result.warnings.some((w) => /sign convention/i.test(w))).toBe(true);
  });

  it("splits an oversized page at line breaks so no transaction row is bisected", async () => {
    const line = (i: number) => `LINE-${String(i).padStart(4, "0")}-${"X".repeat(90)}`;
    const page = Array.from({ length: 80 }, (_, i) => line(i)).join("\n"); // ~8000 chars
    const fetchMock = vi.fn().mockResolvedValue(
      jsonReply({ outflowPositive: false, warnings: [], rows: [{ date: "2026-07-01", description: "X", amount: "1" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await extractStatement({ config: LOCAL_CONFIG, document: { kind: "text", text: page } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chunks = fetchMock.mock.calls.map(statementTextOf);
    // The pieces partition the page exactly — nothing lost, nothing duplicated —
    // and every piece but the last ends on a line break, so no row is cut in two.
    expect(chunks.join("")).toBe(page);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith("\n")).toBe(true);
    // Every line that appears is whole: no fragment missing its prefix or suffix.
    for (const chunk of chunks) {
      for (const text of chunk.split("\n").filter(Boolean)) {
        expect(text).toMatch(/^LINE-\d{4}-X{90}$/);
      }
    }
  });

  it("imports a truncated reply's rows but warns they may be cut off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        truncatedReply(
          JSON.stringify({
            outflowPositive: false,
            warnings: [],
            rows: [{ date: "2026-07-01", description: "RENT", amount: "-1800" }],
          }),
        ),
      ),
    );

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.rowCount).toBe(1);
    expect(result.warnings.some((w) => /cut off|output limit/i.test(w))).toBe(true);
  });

  it("blames truncation, not a scan, when a cut-off reply yields no rows", async () => {
    // A reply cut at the token limit is invalid JSON; with no rows to show, the
    // error must point at the output limit rather than suggesting it is a scan.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(truncatedReply('{"outflowPositive": false, "rows": [{"date": "2026-07-01её')));

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toMatch(/cut off|output limit/i);
    expect(result.message).not.toMatch(/scan/i);
  });

  it("keeps backticks inside a description instead of stripping them as a code fence", async () => {
    // The reply is raw JSON (not fenced) whose description contains ```; a global
    // fence strip would delete those characters and corrupt the merchant.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonReply({
          outflowPositive: false,
          warnings: [],
          rows: [{ date: "2026-07-01", description: "CAFE ```GRID```", amount: "5.00" }],
        }),
      ),
    );

    const result = await extractStatement({
      config: LOCAL_CONFIG,
      document: { kind: "text", text: "…" },
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.csv).toContain("CAFE ```GRID```");
  });
});
