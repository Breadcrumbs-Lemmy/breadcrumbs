import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B12 — the Admin header subtitle flashed "0 accounts"
 * during the initial load.
 *
 * `users` starts `[]` and `loading` starts `true`, but the "N accounts"
 * subtitle rendered unconditionally, so it showed "0 accounts" while the fetch
 * was in flight, then jumped to the real count. The count must not render until
 * the fetch settles.
 *
 * The Admin screen is multi-user (needs created accounts to exercise live), and
 * apps/web runs in node with no DOM, so this pins the gating in source.
 */
const source = readFileSync(
  fileURLToPath(new URL("./AdminScreen.tsx", import.meta.url)),
  "utf8",
);

describe("Admin account count loading gate (B12)", () => {
  it("no longer renders the count unconditionally", () => {
    // The old unconditional subtitle rendered the count with no loading gate.
    expect(source).not.toMatch(/\{users\.length\} \{users\.length === 1 \? "account" : "accounts"\}/);
  });

  it("holds a placeholder until the fetch settles", () => {
    expect(source).toMatch(
      /loading \|\| error \? "—" : pluralize\(users\.length, "account"\)/,
    );
  });
});
