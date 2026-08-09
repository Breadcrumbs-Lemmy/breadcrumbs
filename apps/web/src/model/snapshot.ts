/**
 * Snapshot state helpers.
 *
 * Builds and edits the `FinancialSnapshot` that the UI sends to the engine.
 * This module shapes *inputs*. It never inspects or derives an affordability
 * outcome — backend validation decides whether the data is usable, and backend
 * calculation decides what it means.
 *
 * It also imports nothing from `packages/core/fixtures`. It used to: the base
 * snapshot came from a backend fixture bundled into the browser at build time,
 * which crossed the `D-013` deploy boundary and, worse, meant "Can I afford
 * this?" answered about fixture balances. The snapshot now arrives from
 * `GET /api/v1/affordability/snapshot`, derived from the user's own history.
 * The fixture-backed variants that remain are development scenarios and live
 * in `fixtures/`, where their purpose is obvious.
 */
import type { AffordabilityRequest, FinancialSnapshot, PlannedPurchase } from "@ai-fin-os/core";

const UI_PURCHASE_ID = "purchase_ui_draft";

/** Dollars typed by the user to integer minor units. */
export function dollarsToCents(input: string): number | undefined {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
}

export function centsToDollars(cents: number | undefined): string {
  if (cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

export type PurchaseDraft = {
  label: string;
  amount: string;
  purchaseDate: string;
  category: string;
  necessity: PlannedPurchase["necessity"];
  deferrable: boolean;
};

export function emptyDraft(asOfDate: string): PurchaseDraft {
  return {
    label: "",
    amount: "",
    purchaseDate: asOfDate,
    category: "general",
    necessity: "useful",
    deferrable: false,
  };
}

/**
 * Writes the draft into the snapshot as the planned purchase under evaluation.
 *
 * Amount and date are omitted when absent rather than defaulted, so the engine
 * sees genuinely missing critical fields and can return UNKNOWN with
 * MISSING_PURCHASE_FIELD. Substituting a zero here would manufacture a
 * confident answer from incomplete input, which is precisely the failure mode
 * H-006 was raised about.
 */
export function requestFromDraft(
  snapshot: FinancialSnapshot,
  draft: PurchaseDraft,
  requestId: string,
): AffordabilityRequest {
  const amountCents = dollarsToCents(draft.amount);
  const next = structuredClone(snapshot);

  const purchase: PlannedPurchase = {
    id: UI_PURCHASE_ID,
    label: draft.label.trim() === "" ? "This purchase" : draft.label.trim(),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(draft.purchaseDate !== "" ? { purchaseDate: draft.purchaseDate } : {}),
    category: draft.category,
    necessity: draft.necessity,
    deferrable: draft.deferrable,
    active: true,
    freshness: { status: "fresh", asOf: snapshot.asOfDate, source: "manual", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "manual",
  };

  next.plannedPurchases = [
    ...next.plannedPurchases.filter((p) => p.id !== UI_PURCHASE_ID),
    purchase,
  ];

  return { requestId, snapshot: next, plannedPurchaseId: UI_PURCHASE_ID };
}

/**
 * Whether the form has enough to submit.
 *
 * Deliberately narrow: it checks only that the two critical fields are
 * non-empty and parseable. It does not predict the result, does not check
 * balances, and does not evaluate coverage. Anything beyond "is this form
 * filled in" belongs to the engine.
 */
export function draftIsSubmittable(draft: PurchaseDraft): boolean {
  return dollarsToCents(draft.amount) !== undefined && draft.purchaseDate !== "";
}
