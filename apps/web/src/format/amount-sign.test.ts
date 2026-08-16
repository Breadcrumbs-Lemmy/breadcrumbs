import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { amountSign } from "./amount-sign";

/**
 * B21 — a zero-cent transaction row rendered "−$0".
 *
 * The Row hardcoded `inflow ? "+" : "−"` off a strict `amountCents > 0`, so a
 * 0-cent amount (neither inflow nor outflow) fell to the outflow branch and got
 * a spurious minus. amountSign returns no glyph at exactly zero.
 */
describe("amountSign (B21)", () => {
  it("signs a positive amount as an inflow", () => {
    expect(amountSign(1)).toBe("+");
    expect(amountSign(4599)).toBe("+");
  });

  it("signs a negative amount as an outflow (U+2212 minus)", () => {
    expect(amountSign(-1)).toBe("−");
    expect(amountSign(-4599)).toBe("−");
    // Not the ASCII hyphen-minus.
    expect(amountSign(-1)).toBe("−");
    expect(amountSign(-1)).not.toBe("-");
  });

  it("gives exactly zero no sign, so a 0-cent row is not '−$0'", () => {
    expect(amountSign(0)).toBe("");
    // -0 is a possible arithmetic artefact; it must stay unsigned too.
    expect(amountSign(-0)).toBe("");
  });

  it("gives a non-finite amount no sign (formatMoney renders the em-dash)", () => {
    expect(amountSign(Number.NaN)).toBe("");
    expect(amountSign(Number.POSITIVE_INFINITY)).toBe("");
  });
});

/**
 * The Row must actually route its leading glyph through amountSign rather than
 * the old strict-`> 0` ternary. apps/web runs in node with no DOM, so this pins
 * the wiring; the rendered output was checked with a fetch-stubbed 0-cent row
 * in the browser.
 */
const listSource = readFileSync(
  fileURLToPath(new URL("../components/TransactionList.tsx", import.meta.url)),
  "utf8",
);

describe("TransactionList Row wires amountSign (B21)", () => {
  it("imports amountSign", () => {
    expect(listSource).toMatch(/import\s*\{\s*amountSign\s*\}\s*from\s*["']\.\.\/format\/amount-sign["']/);
  });

  it("derives the leading glyph from amountSign, not a strict-positive ternary", () => {
    expect(listSource).toMatch(/const sign = amountSign\(t\.amountCents\)/);
    expect(listSource).not.toMatch(/inflow \? "\+" : "−"/);
  });
});
