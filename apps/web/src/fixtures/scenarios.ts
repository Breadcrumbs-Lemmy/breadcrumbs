/**
 * UI development scenarios.
 *
 * The base snapshot is the canonical backend fixture
 * (packages/core/fixtures/mvp0/affordable-steady-paycheck.json), imported
 * rather than copied so it cannot drift from the backend's own tests.
 *
 * Variants mutate *inputs* only — a bigger purchase amount, an older balance,
 * a removed field. The affordability level of each variant is whatever the
 * real engine decides. Nothing here asserts or hard-codes a level; the
 * scenario names are expectations for local development, not fixtures.
 */
import type { AffordabilityRequest, PlannedPurchase } from "@ai-fin-os/core";
import baseFixture from "../../../../packages/core/fixtures/mvp0/affordable-steady-paycheck.json";
import savingsFixture from "../../../../packages/core/fixtures/mvp0/monthly-savings-discretionary-purchases.json";
import optionalTradeoffFixture from "../../../../packages/core/fixtures/mvp0/optional-obligation-tradeoff.json";
import baselineTightFixture from "../../../../packages/core/fixtures/mvp0/baseline-already-tight.json";
import variableIncomeFixture from "../../../../packages/core/fixtures/mvp0/variable-income-not-guaranteed.json";
import coverageIncompleteFixture from "../../../../packages/core/fixtures/mvp0/coverage-incomplete.json";

/** Loads a backend fixture verbatim. No mutation — the engine decides the level. */
function fixture(source: unknown): () => AffordabilityRequest {
  return () => structuredClone((source as Fixture).input);
}

type Fixture = { input: AffordabilityRequest };

export function base(): AffordabilityRequest {
  // Structured clone keeps each scenario independent across re-renders.
  return structuredClone((baseFixture as unknown as Fixture).input);
}

/** The fixture snapshot, for development scripts that exercise engine states
 *  without an import. Product code gets its snapshot from the API. */
export function baseSnapshot(): AffordabilityRequest["snapshot"] {
  return base().snapshot;
}

/**
 * The monthly-savings fixture (H-011, D-010) carries three discretionary
 * purchases in one shared snapshot. Scenarios select between them by switching
 * `plannedPurchaseId` — no snapshot mutation, and no assumption about which
 * level each produces. The engine decides.
 */
function savings(plannedPurchaseId: string): () => AffordabilityRequest {
  return () => {
    const request = structuredClone((savingsFixture as unknown as Fixture).input);
    return { ...request, plannedPurchaseId };
  };
}

function withPurchase(
  mutate: (purchase: PlannedPurchase) => void,
): () => AffordabilityRequest {
  return () => {
    const request = base();
    const purchase = request.snapshot.plannedPurchases.find(
      (p) => p.id === request.plannedPurchaseId,
    );
    if (purchase) mutate(purchase);
    return request;
  };
}

export type ScenarioKey =
  | "affordable"
  | "tight"
  | "risky"
  | "unknownStale"
  | "unknownMissing"
  | "savingsGame"
  | "savingsConsole"
  | "savingsMeal"
  | "optionalTradeoff"
  | "baselineTight"
  | "variableIncome"
  | "coverageIncomplete";

export const SCENARIOS: Record<ScenarioKey, { label: string; build: () => AffordabilityRequest }> = {
  affordable: {
    label: "Affordable",
    build: base,
  },

  tight: {
    label: "Tight",
    // Verified against the engine: this snapshot turns TIGHT between $950 and
    // $1,150, and RISKY at $1,200. $1,050 sits mid-band so small changes to the
    // fixture don't silently flip the scenario into another level.
    build: withPurchase((purchase) => {
      purchase.label = "New laptop";
      purchase.amountCents = 105000;
    }),
  },

  risky: {
    label: "Risky",
    // Past the point where required obligations can be covered.
    build: withPurchase((purchase) => {
      purchase.label = "Emergency car repair";
      purchase.amountCents = 180000;
    }),
  },

  unknownStale: {
    label: "Unknown · stale",
    build: () => {
      const request = base();
      const account = request.snapshot.accounts[0];
      if (account) {
        account.freshness = {
          ...account.freshness,
          status: "stale",
          asOf: "2026-07-10",
          ageHours: 24 * 24,
        };
      }
      return request;
    },
  },

  unknownMissing: {
    label: "Unknown · missing amount",
    // Exercises the missing-critical-field path: the response omits
    // amountCents, and the UI must render an em-dash rather than "$0.00".
    build: withPurchase((purchase) => {
      delete (purchase as { amountCents?: number }).amountCents;
    }),
  },

  // Monthly savings goal scenarios (D-010, H-011). These matter beyond level
  // coverage: the goal is a named entity, so goal-related reason codes resolve
  // a real label instead of falling back to generic wording.
  savingsGame: {
    label: "Savings · $99 game",
    build: savings("purchase_video_game_99"),
  },
  savingsConsole: {
    label: "Savings · $499 console",
    build: savings("purchase_video_game_console_499"),
  },
  savingsMeal: {
    label: "Savings · $125 meal",
    build: savings("purchase_restaurant_meal_125"),
  },

  // Reason-code coverage fixtures from H-010. Loaded verbatim so the copy layer
  // is exercised against the four codes that were previously compile-verified
  // only. No mutation and no expected level asserted here.
  optionalTradeoff: {
    label: "Optional tradeoff",
    build: fixture(optionalTradeoffFixture),
  },
  baselineTight: {
    label: "Already tight",
    build: fixture(baselineTightFixture),
  },
  variableIncome: {
    label: "Unreliable income",
    build: fixture(variableIncomeFixture),
  },
  coverageIncomplete: {
    label: "Coverage gap",
    build: fixture(coverageIncompleteFixture),
  },
};
