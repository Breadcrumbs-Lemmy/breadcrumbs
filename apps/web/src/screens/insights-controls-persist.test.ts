import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B16 — the Insights period controls unmounting to a
 * Skeleton on every period switch.
 *
 * The screen used to early-return `<Skeleton/>` whenever `outcome === null`, and
 * the fetch effect set `outcome` back to null on every period/granularity
 * change. So the ENTIRE controls block (the Segmented + the period chips)
 * unmounted and remounted on each switch — it flashed out and keyboard focus on
 * the control was lost. The controls must stay mounted while only the results
 * region shows a loading state.
 *
 * apps/web tests run in a node environment (no jsdom), so this is a source guard
 * rather than a render test: it pins the structure — controls above the loading
 * gate, results dimmed in place — so the early-return can't creep back.
 */
const source = readFileSync(
  fileURLToPath(new URL("./InsightsScreen.tsx", import.meta.url)),
  "utf8",
);

const segmentedAt = source.indexOf('ariaLabel="Insights period"');
const loadingGateAt = source.indexOf("outcome === null && <Skeleton");

describe("InsightsScreen controls persist across period switches (B16)", () => {
  it("does not early-return a full-screen Skeleton before the controls", () => {
    // The precise B16 shape: `if (outcome === null) return <Skeleton />;` sat
    // above the controls, so the controls were part of what unmounted.
    expect(source).not.toMatch(/return\s*<Skeleton\s*\/>/);
    expect(source).not.toMatch(/if\s*\(\s*outcome === null\s*\)\s*return/);
  });

  it("renders the period controls above the loading gate", () => {
    expect(segmentedAt).toBeGreaterThan(-1);
    expect(loadingGateAt).toBeGreaterThan(-1);
    // The Segmented control is emitted before the results skeleton, so it stays
    // mounted while the results region swaps to a loading state.
    expect(segmentedAt).toBeLessThan(loadingGateAt);
  });

  it("keeps the previous view mounted and dimmed during a same-period refetch", () => {
    // A refreshing flag + aria-busy on the results region is how the previous
    // outcome is retained (chips keep their focus) instead of blinking away.
    expect(source).toMatch(/const \[refreshing, setRefreshing\] = useState\(false\)/);
    expect(source).toMatch(/aria-busy=\{refreshing\}/);
  });

  it("only drops to a skeleton when the granularity changes, not on every fetch", () => {
    // Same-granularity switches dim in place; a new granularity (whose available
    // periods differ) is the only thing that nulls the outcome back to skeleton.
    expect(source).toMatch(/if \(sameGranularity\) setRefreshing\(true\);\s*else setOutcome\(null\)/);
  });
});
