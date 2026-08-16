import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B15 — the Import error card looked like a normal card.
 *
 * `.card` draws a subtle 1px border on all sides. The error card added
 * `border-l-2` (left-border WIDTH only) but no color and no alert text class, so
 * a failed import rendered with a plain grey stripe and plain ink text —
 * indistinguishable from an ordinary info card. The card must carry the app's
 * alert treatment (`text-alert`, and an alert-colored left stripe).
 *
 * apps/web runs in node with no DOM, so this pins the classes in source; the
 * computed border color was checked live in the browser.
 */
const source = readFileSync(
  fileURLToPath(new URL("./ImportScreen.tsx", import.meta.url)),
  "utf8",
);

// The error card block, from the `{error &&` guard to its closing paren.
const start = source.indexOf("{error && (");
const errorCard = source.slice(start, start + 200);

describe("Import error card alert styling (B15)", () => {
  it("colors the left stripe with the alert token", () => {
    expect(start).toBeGreaterThan(-1);
    expect(errorCard).toMatch(/border-l-2 border-l-alert/);
  });

  it("renders the message in alert text, not plain ink", () => {
    expect(errorCard).toMatch(/text-body text-alert/);
    expect(errorCard).not.toMatch(/text-body text-ink\b/);
  });
});
