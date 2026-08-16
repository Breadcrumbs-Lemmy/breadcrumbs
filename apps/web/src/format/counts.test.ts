import { describe, expect, it } from "vitest";
import { banksAndAccounts, pluralize } from "./counts";

describe("pluralize", () => {
  it("uses the singular noun only for a count of 1", () => {
    expect(pluralize(1, "bank")).toBe("1 bank");
    expect(pluralize(0, "bank")).toBe("0 banks");
    expect(pluralize(3, "bank")).toBe("3 banks");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(1, "entry", "entries")).toBe("1 entry");
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});

describe("banksAndAccounts (B6)", () => {
  it("pluralizes each noun independently by its own count", () => {
    // The exact B6 regression: 1 bank must not read "1 banks".
    expect(banksAndAccounts(1, 3)).toBe("1 bank · 3 accounts");
    expect(banksAndAccounts(1, 1)).toBe("1 bank · 1 account");
    expect(banksAndAccounts(2, 5)).toBe("2 banks · 5 accounts");
  });
});
