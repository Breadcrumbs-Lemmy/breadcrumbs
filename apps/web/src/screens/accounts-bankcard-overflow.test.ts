import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B5 — the account tile overflowing its mobile grid track.
 *
 * The `.bankcard-flip` button is a grid item (grid-cols-1 on mobile). A grid
 * item's default `min-width: auto` pins it to its ~377px min-content width, so
 * on a ~335px mobile track it overflowed the cell and the viewport, pushing the
 * right-aligned balance off-screen where the page can't scroll to reach it.
 * `min-w-0` lets the item shrink to the track (the account name then truncates
 * by design). See the fix at the button's className.
 *
 * The real defect is a browser layout computation, which neither node nor jsdom
 * can reproduce (no layout engine); it was verified by measurement in a real
 * viewport at 320/360/375/390px. This test is a source-level guard so a future
 * refactor that drops the shrink class fails CI instead of silently regressing.
 */
const source = readFileSync(
  fileURLToPath(new URL("./AccountsScreen.tsx", import.meta.url)),
  "utf8",
);

/** The className string of whichever element carries the `bankcard-flip` class. */
function bankcardFlipClassName(): string {
  // Match a className="…bankcard-flip…" attribute (double-quoted, single line).
  const match = source.match(/className="([^"]*\bbankcard-flip\b[^"]*)"/);
  return match?.[1] ?? "";
}

describe("AccountsScreen bankcard tile (B5)", () => {
  it("has the bankcard-flip button in the source", () => {
    expect(bankcardFlipClassName()).not.toBe("");
  });

  it("lets the grid item shrink to its track with min-w-0", () => {
    // Without this, the tile overflows the mobile grid cell and the viewport.
    expect(bankcardFlipClassName()).toMatch(/\bmin-w-0\b/);
  });
});
