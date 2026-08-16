import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluralize } from "../format/counts";

/**
 * Regression guard for B8 — the Recurring header hard-coded the plural noun as
 * `{recurring.count} subscriptions`, so a period with exactly one recurring
 * charge rendered "1 subscriptions". MonthlyReportScreen already pluralized the
 * same count correctly; this pins Insights to the shared `pluralize` helper so
 * the two can't drift.
 *
 * apps/web runs in node (no jsdom), so this checks the wiring in source plus the
 * helper's own singular/plural behavior for this exact noun.
 */
const source = readFileSync(
  fileURLToPath(new URL("./InsightsScreen.tsx", import.meta.url)),
  "utf8",
);

describe("Insights Recurring count pluralization (B8)", () => {
  it("pluralizes the subscription count via the shared helper", () => {
    expect(source).toMatch(/pluralize\(recurring\.count, "subscription"\)/);
  });

  it("no longer hard-codes the plural noun", () => {
    expect(source).not.toMatch(/\{recurring\.count\} subscriptions/);
  });

  it("the helper renders the singular for exactly one charge", () => {
    expect(pluralize(1, "subscription")).toBe("1 subscription");
    expect(pluralize(0, "subscription")).toBe("0 subscriptions");
    expect(pluralize(3, "subscription")).toBe("3 subscriptions");
  });
});
