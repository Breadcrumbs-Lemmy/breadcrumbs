import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B17 — the Monthly Report printing dark cards on paper.
 *
 * The `@media print` block sets a white page background but did not reset the
 * theme custom properties, so a dark-theme (or System-dark) user kept dark
 * `--surface-*` / cream `--text-*` values; with `print-color-adjust: exact`
 * those dark card backgrounds actually inked onto the page.
 *
 * The fix re-declares the neutral + semantic tokens at their light values
 * inside `@media print`. This test extracts the light values from the `:root`
 * block in tokens.css and asserts the print block re-declares each with the
 * *same* value and `!important` — so if the light palette changes and the print
 * block isn't updated to match, CI fails (the two must stay in sync).
 *
 * Print rendering can't be exercised in node/jsdom; this is a source guard.
 */
const tokens = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);
const index = readFileSync(
  fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** The declarations inside the first balanced `{…}` that follows `marker`. */
function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) return "";
  const open = source.indexOf("{", at);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/** Read a custom property's value from a block, `!important` stripped. */
function tokenValue(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m?.[1]?.replace(/!important/, "").trim() ?? null;
}

// The light palette is the plain `:root {` block (the dark ones are
// `:root[data-theme="dark"]` / inside `@media (prefers-color-scheme: dark)`).
const lightRoot = blockAfter(tokens, ":root {");
const printBlock = blockAfter(index, "@media print");
// The reset lives in the `:root {` nested inside the print block.
const printReset = blockAfter(printBlock, ":root {");

// Every neutral/semantic token the Monthly Report actually paints.
const TOKENS = [
  "--surface-base",
  "--surface-raised",
  "--surface-sunken",
  "--surface-inset",
  "--border-subtle",
  "--border-strong",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-inverse",
  "--accent",
  "--alert",
];

describe("print theme reset (B17)", () => {
  it("has a :root token reset inside @media print", () => {
    expect(printReset).not.toBe("");
  });

  it.each(TOKENS)("resets %s to its light value with !important", (name) => {
    const light = tokenValue(lightRoot, name);
    expect(light).toBeTruthy();

    const printDecl = printReset.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    expect(printDecl, `${name} must be re-declared in the print block`).toBeTruthy();
    const declValue = printDecl?.[1] ?? "";
    expect(declValue).toContain("!important");
    expect(tokenValue(printReset, name)).toBe(light);
  });
});
