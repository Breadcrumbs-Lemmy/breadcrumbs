import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B13 — the two dark palettes drifting apart.
 *
 * tokens.css defines the dark theme twice: once under `:root[data-theme="dark"]`
 * (the explicit "Dark" toggle) and once under `@media (prefers-color-scheme:
 * dark)` (the "System" choice). The file's own SYNC NOTE says the two blocks
 * "must stay identical"; `--text-tertiary` had silently diverged (#948a7c vs
 * #837a6d), so System-dark users read tertiary text ~11 lightness units darker
 * than explicit-Dark users.
 *
 * This test parses both blocks and asserts they declare the same tokens with the
 * same values — enforcing the SYNC NOTE for every token, not just the one that
 * happened to drift.
 */
const source = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

/** The declarations inside the first balanced `{…}` that follows `marker`. */
function blockAfter(src: string, marker: string, from = 0): { body: string; end: number } {
  const at = src.indexOf(marker, from);
  if (at === -1) return { body: "", end: -1 };
  const open = src.indexOf("{", at);
  if (open === -1) return { body: "", end: -1 };
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return { body: "", end: -1 };
}

/** Custom properties declared directly in a block → { name: value }. */
function customProps(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

// Explicit "Dark" toggle.
const explicitDark = customProps(blockAfter(source, ':root[data-theme="dark"]').body);
// "System" dark: the :root block nested inside the prefers-color-scheme media query.
const systemMedia = blockAfter(source, "@media (prefers-color-scheme: dark)");
const systemDark = customProps(blockAfter(systemMedia.body, ":root").body);

describe("dark theme palettes stay in sync (B13)", () => {
  it("parsed both dark blocks", () => {
    expect(Object.keys(explicitDark).length).toBeGreaterThan(10);
    expect(Object.keys(systemDark).length).toBeGreaterThan(10);
  });

  it("declares exactly the same token names in both blocks", () => {
    expect(Object.keys(systemDark).sort()).toEqual(Object.keys(explicitDark).sort());
  });

  it("declares identical values for every token (SYNC NOTE)", () => {
    // Compared as whole maps so a mismatch reports the offending token + values.
    expect(systemDark).toEqual(explicitDark);
  });
});
