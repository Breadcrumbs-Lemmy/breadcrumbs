/**
 * Display view over `response.purchase`.
 *
 * H-006 is resolved: the backend now omits `amountCents` and `purchaseDate`
 * rather than substituting `0` and `asOfDate`, so an absent figure arrives as
 * `undefined` and renders as an em-dash instead of a false "$0.00".
 *
 * This module normalises `undefined` to `null` for the display layer and
 * cross-checks against `MISSING_PURCHASE_FIELD.parameters.missingFields`, which
 * remains the authoritative statement of what is absent. Keeping the belt and
 * braces is cheap and means a future regression in either place surfaces as an
 * em-dash rather than an invented number.
 *
 * Presentation only — no calculation.
 */
import type { AffordabilityResponse } from "@ai-fin-os/core";

export type PurchaseView = {
  label: string;
  labelKnown: boolean;
  /** null when the backend could not determine an amount. */
  amountCents: number | null;
  /** null when the backend could not determine a date. */
  purchaseDate: string | null;
};

export function purchaseView(response: AffordabilityResponse): PurchaseView {
  const missing = new Set<string>();
  for (const reason of response.explanation.reasons) {
    if (reason.code === "MISSING_PURCHASE_FIELD") {
      for (const field of reason.parameters.missingFields) missing.add(field);
    }
  }

  const purchaseMissingEntirely = missing.has("purchase");
  const labelKnown = !purchaseMissingEntirely && response.purchase.label !== "Unknown purchase";

  return {
    label: labelKnown ? response.purchase.label : "This purchase",
    labelKnown,
    amountCents:
      purchaseMissingEntirely || missing.has("amountCents")
        ? null
        : (response.purchase.amountCents ?? null),
    purchaseDate:
      purchaseMissingEntirely || missing.has("purchaseDate")
        ? null
        : (response.purchase.purchaseDate ?? null),
  };
}
