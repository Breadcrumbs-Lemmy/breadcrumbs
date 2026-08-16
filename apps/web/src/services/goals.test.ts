import { describe, expect, it } from "vitest";
import type { SavingsCapacitySuggestion } from "@ai-fin-os/core";
import { shouldInviteImport } from "./goals";

/** A suggestion with the given data-sufficiency; other fields are unused here. */
function suggestion(hasEnoughData: boolean): SavingsCapacitySuggestion {
  return {
    currency: "USD",
    floorCents: hasEnoughData ? 42000 : 0,
    ceilingCents: hasEnoughData ? 90000 : 0,
    monthsConsidered: hasEnoughData ? 3 : 0,
    hasEnoughData,
  };
}

describe("shouldInviteImport (B10)", () => {
  it("invites an import when there's no suggestion at all", () => {
    expect(shouldInviteImport(null)).toBe(true);
  });

  it("invites an import when there isn't yet enough history to measure pace", () => {
    expect(shouldInviteImport(suggestion(false))).toBe(true);
  });

  it("does NOT invite an import once there's enough history for the savings note", () => {
    // This is the B10 fix: the savings-room note renders on hasEnoughData, so the
    // invite must stay silent — otherwise the card claims both a known surplus and
    // "No statement imported yet?" at once.
    expect(shouldInviteImport(suggestion(true))).toBe(false);
  });

  it("is the exact complement of the note's gate (never both, never neither)", () => {
    for (const s of [null, suggestion(false), suggestion(true)]) {
      const noteShows = s?.hasEnoughData ?? false;
      const inviteShows = shouldInviteImport(s);
      expect(inviteShows).toBe(!noteShows);
    }
  });
});
