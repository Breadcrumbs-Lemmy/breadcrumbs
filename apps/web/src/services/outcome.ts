/**
 * The shape the UI consumes for an affordability attempt.
 *
 * Deliberately separated from `affordability.ts`, which owns transport. This
 * module has no runtime dependencies and no `import.meta`, so Node development
 * scripts can import the type without pulling in browser-only globals.
 *
 * The distinction the three cases encode is a product one, not a transport one:
 *
 *   result  — the engine answered. Includes `UNKNOWN`, which is a real answer
 *             meaning "not enough information", and must render as a result
 *             rather than as an error.
 *   invalid — the request was malformed. The user's data was never evaluated.
 *   error   — something failed on our side. Nothing is known about the answer.
 *
 * Collapsing `invalid` or `error` into `result` would let a transport failure
 * masquerade as a financial verdict, which is the worst available outcome.
 */
import type {
  AffordabilityRequestValidationIssue,
  AffordabilityResponse,
} from "@ai-fin-os/core";

export type AffordabilityOutcome =
  | { kind: "result"; response: AffordabilityResponse }
  | { kind: "invalid"; issues: AffordabilityRequestValidationIssue[] }
  | { kind: "error"; message: string };
