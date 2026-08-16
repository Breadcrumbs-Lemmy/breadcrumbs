import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B7 — the "Where it went" card rendering empty on a
 * zero-spend month.
 *
 * `Categories` maps over `summary.categoryTotals`. A month with accounts but no
 * spending (August, in the seed) has an empty array, so the `<Card>` rendered
 * with no children — a bare bordered box under the heading, no copy. The
 * top-level "Nothing here yet" empty state only fires when there's no data at
 * all, so this case slipped through.
 *
 * apps/web tests run in node (no jsdom), so this pins the empty-state row and
 * its copy in source rather than rendering it.
 */
const source = readFileSync(
  fileURLToPath(new URL("./SpendingScreen.tsx", import.meta.url)),
  "utf8",
);

// The Categories component body (from its declaration to the next top-level fn).
const categoriesStart = source.indexOf("function Categories(");
const categoriesEnd = source.indexOf("\nfunction ", categoriesStart + 1);
const categories = source.slice(categoriesStart, categoriesEnd);

describe("Spending Categories empty state (B7)", () => {
  it("renders an empty-state row when there are no category totals", () => {
    expect(categoriesStart).toBeGreaterThan(-1);
    expect(categories).toMatch(/all\.length === 0/);
    expect(categories).toMatch(/No spending recorded this \{periodNoun\}/);
  });

  it("phrases the statement period so the copy never reads 'this statement'", () => {
    expect(categories).toMatch(
      /period\.kind === "statement"\s*\?\s*"statement period"\s*:\s*summary\.period\.kind/,
    );
  });
});
