import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B11 — the "View as table" trend table overflowing the
 * viewport on mobile.
 *
 * TrendTable renders five money columns (Month | Net worth | Cash | Owed |
 * Basis) whose intrinsic width (~433px) exceeds a phone viewport. With no
 * horizontal-scroll wrapper the whole page overflowed and horizontal scroll was
 * locked, so the rightmost "Basis" column clipped off-screen and was
 * unreachable. Wrapping the table in `overflow-x-auto` (mirroring the chart's
 * wrapper) keeps it scrollable within its own box.
 *
 * The real defect is a browser layout computation, which neither node nor jsdom
 * can reproduce (no layout engine); it was verified by measurement in a real
 * viewport at 320/360/375/390px. This is a source-level guard so a future
 * refactor that drops the wrapper fails CI instead of silently regressing.
 */
const source = readFileSync(
  fileURLToPath(new URL("./NetWorthScreen.tsx", import.meta.url)),
  "utf8",
);

/** The source slice from the "View as table" details up to the trend table's
 *  opening tag — everything that wraps the table. */
function wrapperBeforeTrendTable(): string {
  const detailsAt = source.indexOf("View as table");
  const tableAt = source.indexOf('<table className="mt-2 w-full text-meta">');
  if (detailsAt === -1 || tableAt === -1 || tableAt < detailsAt) return "";
  return source.slice(detailsAt, tableAt);
}

describe("NetWorthScreen trend table (B11)", () => {
  it("still has the trend table in the source", () => {
    expect(source).toContain('<table className="mt-2 w-full text-meta">');
  });

  it("wraps the trend table in a horizontal-scroll container", () => {
    // Without this, the 5-column money table overflows the mobile viewport and
    // the rightmost "Basis" column is clipped off-screen and unreachable.
    expect(wrapperBeforeTrendTable()).toMatch(/overflow-x-auto/);
  });
});
