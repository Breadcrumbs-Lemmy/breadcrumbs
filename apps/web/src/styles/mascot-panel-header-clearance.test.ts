import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B19 — the mascot popover overlapping the mobile sticky
 * header on short phones.
 *
 * `.mascot-panel` is `position: fixed; bottom: 116px` with `max-height:
 * min(72vh, 560px)`. When 72vh was the binding term (viewports ≲ 778px tall)
 * the panel's top edge rose above the mobile header (~104px, z-20) and, at
 * z-40, occluded it once the thread filled to max-height. On an iPhone SE
 * (667px) the panel top sat at ~71px — 33px inside the header.
 *
 * The fix adds a `calc(100vh - 232px)` clamp (header 104 + 12px gap + 116px
 * bottom offset). apps/web runs in node with no DOM, so this parses the actual
 * CSS values and computes the geometry rather than rendering it — the live
 * browser check confirmed the same numbers.
 */
const source = readFileSync(
  fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** The declarations inside the first balanced `{…}` following `marker`. */
function blockAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at === -1) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

const panel = blockAfter(source, ".mascot-panel {");

/** px value of a simple `prop: Npx;` declaration. */
function pxProp(block: string, prop: string): number | null {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([0-9.]+)px`));
  return m?.[1] ? parseFloat(m[1]) : null;
}

// Evaluate the panel's max-height min(...) for a given viewport height (px).
// Supports the three term shapes we use: `72vh`, `calc(100vh - Npx)`, `Npx`.
function maxHeightAt(block: string, vh: number): number {
  const m = block.match(/max-height\s*:\s*min\(([^;]+)\)\s*;/);
  if (!m?.[1]) throw new Error("max-height min() not found on .mascot-panel");
  const terms = m[1].split(",").map((t) => t.trim());
  const values = terms.map((term) => {
    const vhMatch = term.match(/^([0-9.]+)vh$/);
    if (vhMatch?.[1]) return (parseFloat(vhMatch[1]) / 100) * vh;
    const calcMatch = term.match(/^calc\(100vh\s*-\s*([0-9.]+)px\)$/);
    if (calcMatch?.[1]) return vh - parseFloat(calcMatch[1]);
    const pxMatch = term.match(/^([0-9.]+)px$/);
    if (pxMatch?.[1]) return parseFloat(pxMatch[1]);
    throw new Error(`Unrecognized max-height term: ${term}`);
  });
  return Math.min(...values);
}

const HEADER_BOTTOM = 104; // measured mobile sticky header height, z-20

describe("mascot panel clears the mobile header (B19)", () => {
  it("found the .mascot-panel rule and its bottom anchor", () => {
    expect(panel).not.toBe("");
    expect(pxProp(panel, "bottom")).toBe(116);
  });

  it("keeps a clamp so 72vh is not the sole binding term", () => {
    // The whole point: a calc(100vh - …) term must exist to cap short viewports.
    expect(panel).toMatch(/max-height:\s*min\([^;]*calc\(100vh\s*-\s*\d+px\)[^;]*\)/);
  });

  it("keeps the panel top below the header at max-height on short phones", () => {
    const bottom = pxProp(panel, "bottom")!;
    // iPhone SE (667), iPhone 5 (568), and the 736 boundary all used to overlap.
    for (const vh of [568, 667, 736]) {
      const topAtMax = vh - bottom - maxHeightAt(panel, vh);
      expect(topAtMax).toBeGreaterThanOrEqual(HEADER_BOTTOM);
    }
  });

  it("leaves tall viewports unchanged (560px cap still binds)", () => {
    // Above ~792px the 560px cap wins, so behavior is identical to before.
    expect(maxHeightAt(panel, 812)).toBe(560);
    expect(maxHeightAt(panel, 900)).toBe(560);
  });
});
