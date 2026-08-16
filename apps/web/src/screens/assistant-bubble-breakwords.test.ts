import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B20 — assistant/user chat bubbles overflowing on a long
 * unbroken token.
 *
 * Both bubbles are width-capped (`max-w-[85%]` / `max-w-[95%]`). The assistant
 * bubble's `whitespace-pre-wrap` wraps at normal break opportunities, but a long
 * unbroken string — a URL, hash, or 60-digit account number — has none, so it
 * overflowed horizontally (worst at 375px). Neither bubble set
 * `overflow-wrap: break-word`.
 *
 * apps/web runs in node with no DOM (and the assistant needs a provider key to
 * exercise live), so this pins `break-words` on both bubbles; the computed
 * `overflow-wrap` and non-overflow were checked with a probe in the browser.
 */
const source = readFileSync(
  fileURLToPath(new URL("./AssistantScreen.tsx", import.meta.url)),
  "utf8",
);

const start = source.indexOf("function Bubble(");
const end = source.indexOf("\nfunction ", start + 1);
const bubble = source.slice(start, end);

describe("Assistant bubbles break long tokens (B20)", () => {
  it("found the Bubble component", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("the user bubble sets break-words alongside its width cap", () => {
    expect(bubble).toMatch(/max-w-\[85%\] break-words/);
  });

  it("the assistant bubble sets break-words alongside whitespace-pre-wrap", () => {
    expect(bubble).toMatch(/max-w-\[95%\] whitespace-pre-wrap break-words/);
  });
});
