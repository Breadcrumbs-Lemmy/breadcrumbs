/**
 * The leading sign glyph for a signed cents amount in the transaction list.
 *
 * Positive is an inflow ("+"), negative an outflow ("−", U+2212 minus). Exactly
 * zero is neither an inflow nor an outflow, so it carries no sign: a 0-cent row
 * renders "$0", never "−$0" (B21). The amount itself is formatted separately by
 * formatMoney; this is only the leading glyph.
 *
 * A non-finite amount is treated as unsigned — formatMoney renders it as the
 * em-dash placeholder, which no sign should precede.
 */
export function amountSign(amountCents: number): "+" | "−" | "" {
  if (!Number.isFinite(amountCents) || amountCents === 0) return "";
  return amountCents > 0 ? "+" : "−";
}
