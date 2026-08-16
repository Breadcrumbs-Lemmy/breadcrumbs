import type { ApiOutcome } from "../services/api";

/**
 * Turn a non-ok admin toggle result into a message to show inline.
 *
 * The role/status toggles used to act only on `kind === "ok"`, so a server
 * rejection — e.g. demoting or disabling the last admin — landed as a silent
 * no-op: the row didn't change and nothing explained why (B4). This maps the
 * failure kinds to user-facing copy so every rejection surfaces.
 *
 * `action` is a verb phrase completing "Couldn't {action}." for the cases with
 * no server-supplied message.
 */
export function toggleErrorMessage(result: ApiOutcome<unknown>, action: string): string {
  if (result.kind === "error") return result.message;
  if (result.kind === "unauthenticated") return "Access denied. Admin role required.";
  return `Couldn't ${action}.`;
}
