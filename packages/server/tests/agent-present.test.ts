/**
 * The agent's presentation boundary — S-010/CD-015 enforced in code.
 *
 * The assistant may echo a computed figure but must never compute one, and
 * placing a decimal point is a computation. Core returns money as integer cents;
 * these cases prove the boundary hands the model preformatted amounts on
 * de-suffixed keys and drops the raw integer entirely, so there is no number
 * left for the model to reshape. The headline case is the exact input that once
 * produced a 10x-off answer from a local model.
 */
import { describe, expect, it } from "vitest";

import { formatCents, presentForModel } from "../src/agent/present";

describe("formatCents", () => {
  it("formats the exact figure a local model once got 10x wrong", () => {
    // 169596c → "$16,959.60" was the observed defect (H-042); the engine's
    // figure is $1,695.96 and the model must only ever echo it.
    expect(formatCents(169596, "USD")).toBe("$1,695.96");
  });

  it("shows cents only when the amount isn't whole, matching the web client", () => {
    expect(formatCents(5000, "USD")).toBe("$50");
    expect(formatCents(4599, "USD")).toBe("$45.99");
    expect(formatCents(0, "USD")).toBe("$0");
  });

  it("uses a leading minus for negatives, never parentheses", () => {
    expect(formatCents(-129900, "USD")).toBe("-$1,299");
    expect(formatCents(-4599, "USD")).toBe("-$45.99");
  });

  it("renders an absent figure as an em-dash, never $0.00", () => {
    expect(formatCents(null, "USD")).toBe("—");
    expect(formatCents(undefined, "USD")).toBe("—");
    expect(formatCents(Number.NaN, "USD")).toBe("—");
  });

  it("honours the context currency", () => {
    expect(formatCents(169596, "EUR")).toBe("€1,695.96");
  });
});

describe("presentForModel", () => {
  it("replaces *Cents keys with preformatted strings and drops the raw integer", () => {
    const out = presentForModel({ totalOutflowCents: 169596 }, "USD") as Record<string, unknown>;
    expect(out.totalOutflow).toBe("$1,695.96");
    expect(out).not.toHaveProperty("totalOutflowCents");
    // No raw money integer survives anywhere the model could reach for it.
    expect(JSON.stringify(out)).not.toMatch(/169596/);
  });

  it("transforms money nested in objects and arrays while preserving everything else", () => {
    const out = presentForModel(
      {
        totalOutflowCents: 169596,
        period: "2026-07",
        categories: [{ id: "groceries", amountCents: 42350, count: 12 }],
        comparison: { baselineAverageOutflowCents: 120000 },
      },
      "USD",
    ) as any;

    expect(out.totalOutflow).toBe("$1,695.96");
    expect(out.period).toBe("2026-07"); // non-money untouched
    expect(out.categories[0]).toEqual({ id: "groceries", amount: "$423.50", count: 12 });
    expect(out.comparison.baselineAverageOutflow).toBe("$1,200");
    expect(JSON.stringify(out)).not.toMatch(/Cents/);
  });

  it("falls back to a *Display key when the de-suffixed name is already taken", () => {
    const out = presentForModel({ amount: "raw", amountCents: 4599 }, "USD") as Record<string, unknown>;
    expect(out.amount).toBe("raw");
    expect(out.amountDisplay).toBe("$45.99");
  });

  it("leaves primitives and non-money fields alone", () => {
    expect(presentForModel("hello", "USD")).toBe("hello");
    expect(presentForModel(42, "USD")).toBe(42);
    expect(presentForModel({ count: 3, ok: true }, "USD")).toEqual({ count: 3, ok: true });
  });
});
