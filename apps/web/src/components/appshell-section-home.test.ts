import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B18 — tapping a section tab/tile navigates to the section's first page even
 * when you're already inside that section (e.g. from Goals to Cash-flow).
 *
 * Evaluated and deliberately KEPT as-is: this is a "section home" one-tap
 * shortcut, documented on the collapsed rail tile (CollapsedSection) and
 * mirrored by the mobile Row-1 section pill. Within-section page navigation is
 * handled by the mobile Row 2 page pills, and `aria-current` marks the active
 * *section*, not the specific page.
 *
 * This guard locks the two nav surfaces to the SAME behavior so a future change
 * can't silently diverge them — e.g. turning one into a no-op (`onNavigate(
 * current)`) while the other still jumps to the first page. apps/web runs in
 * node with no DOM; the live jump was reproduced in the browser.
 */
const source = readFileSync(
  fileURLToPath(new URL("./AppShell.tsx", import.meta.url)),
  "utf8",
);

const SECTION_HOME_HANDLER = "onClick={() => primary && onNavigate(primary.id)}";

describe("section pills use the documented 'section home' shortcut (B18)", () => {
  it("both the mobile section pill and the collapsed rail tile jump to the section's first page", () => {
    const count = source.split(SECTION_HOME_HANDLER).length - 1;
    // Exactly two — the mobile Row-1 pill and the collapsed rail tile. Keeping
    // them equal is the point: the behavior must not diverge between surfaces.
    expect(count).toBe(2);
  });

  it("no section control silently no-ops to the current page instead of section home", () => {
    // The finding's alternative fix was `onNavigate(current)`; adopting it on
    // one surface only would reintroduce the divergence this guard prevents.
    expect(source).not.toContain("onNavigate(current)");
  });

  it("documents the deliberate section-home behavior at the mobile section nav", () => {
    const navAt = source.indexOf('aria-label="Sections"');
    expect(navAt).toBeGreaterThan(-1);
    // The intent is recorded just below, where the mobile pill is built.
    const region = source.slice(navAt, navAt + 700);
    expect(region).toMatch(/section home/i);
  });
});
