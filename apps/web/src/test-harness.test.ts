import { describe, expect, it } from "vitest";

// Smoke test proving the web app's vitest harness is wired up. Real unit tests
// live next to the source they cover (e.g. `format/dates.test.ts`).
describe("web test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
