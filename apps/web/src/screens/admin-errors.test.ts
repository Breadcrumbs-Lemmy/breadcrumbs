import { describe, expect, it } from "vitest";
import type { ApiOutcome } from "../services/api";
import { toggleErrorMessage } from "./admin-errors";

/**
 * B4 — Admin role/status toggles were a silent no-op on server rejection. The
 * handlers now route every non-ok result through `toggleErrorMessage`, so this
 * pins the copy each failure kind produces.
 */
describe("toggleErrorMessage (B4)", () => {
  it("surfaces the server's message on an error (e.g. last-admin guard)", () => {
    const result: ApiOutcome<unknown> = {
      kind: "error",
      message: "There must be at least one admin. Promote another user first.",
      code: "LAST_ADMIN",
    };
    expect(toggleErrorMessage(result, "change this user's role")).toBe(
      "There must be at least one admin. Promote another user first.",
    );
  });

  it("explains an auth failure", () => {
    expect(toggleErrorMessage({ kind: "unauthenticated" }, "change this user's status")).toBe(
      "Access denied. Admin role required.",
    );
  });

  it("falls back to a generic message using the action for other kinds", () => {
    expect(toggleErrorMessage({ kind: "invalid", issues: [] }, "change this user's role")).toBe(
      "Couldn't change this user's role.",
    );
    // `rejected` carries a data payload but no message — still must not be silent.
    expect(
      toggleErrorMessage({ kind: "rejected", data: {} }, "change this user's status"),
    ).toBe("Couldn't change this user's status.");
  });
});
