/**
 * Integration check: runs the affordability engine over every UI scenario and
 * exercises the full copy layer against the results.
 *
 * This is a development guard, not a product surface. It verifies that:
 *   - every scenario produces a level the UI can render
 *   - every emitted reason code has composable copy
 *   - every emitted assumption code has mapped copy
 *   - no rendered figure comes out as "$0.00" when the backend meant "unknown"
 */
import { SCENARIOS, type ScenarioKey } from "../src/fixtures/scenarios";
import { evaluateAffordability } from "@ai-fin-os/core";
import type { AffordabilityRequest } from "@ai-fin-os/core";
import { AffordabilityRequestValidationError } from "@ai-fin-os/core";
import type { AffordabilityOutcome } from "../src/services/outcome";
import { reasonCopy, type ReasonContext } from "../src/copy/reasons";
import { headlineFor } from "../src/copy/headline";
import { ASSUMPTION_COPY, LEVEL_WORD, FRESHNESS_COPY } from "../src/copy";
import { purchaseView } from "../src/model/purchase";
import { formatMoney } from "../src/format/money";
import { formatDate } from "../src/format/dates";
import { emptyDraft, requestFromDraft, draftIsSubmittable } from "../src/model/snapshot";
import { baseSnapshot } from "../src/fixtures/scenarios";

/**
 * Calls the engine directly rather than through `services/api.ts`.
 *
 * `D-013` forbids **browser runtime** code from calling backend calculation
 * functions, and the app's service adapter correctly goes over HTTP. This file
 * is not browser runtime — it is a Node development script that never ships in
 * the bundle. Routing it through the HTTP client would give it two properties
 * we do not want in a copy-verification guard: it would fail to compile at all
 * under Node (the adapter reads `import.meta.env`, which is Vite-only), and it
 * would require a running server just to check that a sentence renders.
 *
 * The distinction that matters is browser-versus-Node, not UI-versus-backend.
 * This script asserts nothing about transport; it asserts that every reason
 * code produces complete, non-contradictory copy.
 */
function evaluateDirect(request: AffordabilityRequest): AffordabilityOutcome {
  try {
    return { kind: "result", response: evaluateAffordability(request) };
  } catch (error) {
    if (error instanceof AffordabilityRequestValidationError) {
      return { kind: "invalid", issues: error.issues };
    }
    return { kind: "error", message: error instanceof Error ? error.message : "Unknown failure" };
  }
}

let failures = 0;
const seenCodes = new Set<string>();

function fail(message: string) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}

/** Every reason code the backend can emit, from the contract. */
const ALL_REASON_CODES = [
  "BUFFER_PASSED",
  "TIMING_RESERVE_PASSED",
  "BUFFER_BELOW_MINIMUM",
  "TIMING_RESERVE_LOW",
  "OPTIONAL_OBLIGATION_TRADEOFF",
  "GOAL_BUFFER_CONFLICT",
  "BASELINE_ALREADY_TIGHT",
  "REQUIRED_OBLIGATION_SHORTFALL",
  "TIMING_RESERVE_SHORTFALL",
  "HIGH_PRIORITY_GOAL_SHORTFALL",
  "VARIABLE_INCOME_NOT_GUARANTEED",
  "STALE_BALANCE",
  "MISSING_PURCHASE_FIELD",
  "COVERAGE_INCOMPLETE",
] as const;

async function run() {
  for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
    const request = SCENARIOS[key].build();
    const outcome = evaluateDirect(request);

    console.log(`\n── ${SCENARIOS[key].label} ${"─".repeat(Math.max(0, 40 - SCENARIOS[key].label.length))}`);

    if (outcome.kind !== "result") {
      console.log(`  outcome: ${outcome.kind}`);
      if (outcome.kind === "invalid") {
        for (const issue of outcome.issues) console.log(`    ${issue.path.join(".")}: ${issue.message}`);
      } else {
        console.log(`    ${outcome.message}`);
      }
      continue;
    }

    const response = outcome.response;
    const snapshot = request.snapshot;
    const buffer = snapshot.config.minimumCashBufferCents;

    const labels = new Map<string, string>();
    for (const a of snapshot.accounts) labels.set(a.id, a.displayName);
    for (const i of snapshot.incomeSources) labels.set(i.id, i.label);
    for (const o of snapshot.recurringObligations) labels.set(o.id, o.label);
    for (const g of snapshot.goals) labels.set(g.id, g.label);
    for (const p of snapshot.plannedPurchases) labels.set(p.id, p.label);

    const context: ReasonContext = {
      labelFor: (id) => labels.get(id) ?? "an item",
      relatedEntityIds: [],
      referenceDate: response.asOfDate,
      horizonEndDate: response.horizonEndDate,
    };

    console.log(`  level:    ${response.level}  → "${LEVEL_WORD[response.level]}"`);
    console.log(`  headline: ${headlineFor(response, buffer)}`);

    response.explanation.reasons.forEach((reason, index) => {
      let copy;
      try {
        copy = reasonCopy(reason, context);
      } catch (error) {
        fail(`reason ${reason.code} threw: ${String(error)}`);
        return;
      }
      console.log(`  ${index === 0 ? "primary" : "  also "}: [${reason.code}] ${copy.primary}`);
      if (copy.resolution) console.log(`           → ${copy.resolution.label}`);
      seenCodes.add(reason.code);
      if (!copy.primary || copy.primary.includes("undefined")) {
        fail(`reason ${reason.code} produced incomplete copy: "${copy.primary}"`);
      }
      // A reason that names entities but renders the generic fallback means a
      // label failed to resolve. Type-safe, reads as broken.
      if (reason.relatedEntityIds.length > 0 && copy.primary.includes("an item")) {
        fail(`reason ${reason.code} fell back to "an item" despite naming entities`);
      }
    });

    for (const assumption of response.explanation.assumptions) {
      const copy = ASSUMPTION_COPY[assumption.code];
      if (!copy) fail(`assumption ${assumption.code} has no mapped copy`);
      else console.log(`  assume : ${copy}`);
    }

    for (const warning of response.explanation.freshnessWarnings) {
      if (!FRESHNESS_COPY[warning.code]) fail(`freshness ${warning.code} has no mapped copy`);
    }

    // H-006 guard: when the engine reports a missing purchase field, the UI
    // must not render the backend's placeholder as a real figure.
    const view = purchaseView(response);
    const missing = response.explanation.reasons.some((r) => r.code === "MISSING_PURCHASE_FIELD");
    const rendered = formatMoney(view.amountCents);
    const renderedDate = view.purchaseDate ? formatDate(view.purchaseDate, response.asOfDate) : "—";
    console.log(`  purchase: ${view.label} — ${rendered} — ${renderedDate}`);
    if (missing && rendered !== "—") {
      fail(`MISSING_PURCHASE_FIELD present but amount rendered as "${rendered}" instead of an em-dash`);
    }
    if (response.level === "UNKNOWN" && rendered === "$0.00") {
      fail(`UNKNOWN result rendered a $0.00 amount`);
    }
  }

  await verifyFormPath();

  const unexercised = ALL_REASON_CODES.filter((code) => !seenCodes.has(code));
  console.log(`\n── Reason code coverage ${"─".repeat(18)}`);
  console.log(`  ${seenCodes.size}/${ALL_REASON_CODES.length} exercised at runtime`);
  if (unexercised.length > 0) {
    // Not a failure: these are compile-verified by the exhaustive record and
    // are tracked in H-010. Reported so the gap stays visible.
    console.log(`  not yet exercised: ${unexercised.join(", ")}`);
  }

  console.log(
    failures === 0
      ? "\n✓ All scenarios rendered with complete copy and no false-precision figures.\n"
      : `\n✗ ${failures} failure(s).\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Exercises the Screen 2 path: a user-entered draft becomes a request and is
 * evaluated by the real engine.
 *
 * The important case is the empty amount. The form must omit `amountCents`
 * rather than sending 0, so the engine sees a genuinely missing critical field
 * and returns UNKNOWN. Sending a zero would manufacture a confident answer out
 * of an unfinished form.
 */
async function verifyFormPath() {
  console.log(`\n── Form path ${"─".repeat(29)}`);
  const snapshot = baseSnapshot();

  const filled = requestFromDraft(
    snapshot,
    { ...emptyDraft(snapshot.asOfDate), label: "New laptop", amount: "1050" },
    "verify-filled",
  );
  const filledOutcome = evaluateDirect(filled);
  if (filledOutcome.kind !== "result") {
    fail(`filled draft did not evaluate: ${filledOutcome.kind}`);
  } else {
    console.log(`  filled draft  → ${filledOutcome.response.level}`);
    if (filledOutcome.response.level === "UNKNOWN") {
      fail("a complete draft produced UNKNOWN");
    }
  }

  const blank = requestFromDraft(snapshot, emptyDraft(snapshot.asOfDate), "verify-blank");
  const blankPurchase = blank.snapshot.plannedPurchases.at(-1);
  if (blankPurchase && "amountCents" in blankPurchase) {
    fail("empty amount was sent as a value instead of being omitted");
  }
  const blankOutcome = evaluateDirect(blank);
  if (blankOutcome.kind !== "result") {
    fail(`blank draft did not evaluate: ${blankOutcome.kind}`);
  } else {
    console.log(`  blank amount  → ${blankOutcome.response.level}`);
    if (blankOutcome.response.level !== "UNKNOWN") {
      fail(`blank amount produced ${blankOutcome.response.level}, expected UNKNOWN`);
    }
    const view = purchaseView(blankOutcome.response);
    if (formatMoney(view.amountCents) !== "—") {
      fail("blank amount rendered as a currency figure");
    }
  }

  if (draftIsSubmittable(emptyDraft(snapshot.asOfDate))) {
    fail("an empty draft was reported as submittable");
  }
}

void run();
