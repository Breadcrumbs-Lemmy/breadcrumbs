/**
 * Presenting deterministic-engine output to the model.
 *
 * `S-010`/`CD-015` say the assistant may echo a computed figure but must never
 * compute one — and placing a decimal point *is* a computation. Core returns
 * money as integer **cents** (`totalOutflowCents: 169596`), so a tool result
 * that reached the model raw forced it to divide by 100 and format the result
 * itself. A local 8B model does that wrong intermittently (169596 → "$16,959.60",
 * off by 10×). The fix is not a bigger model or a sterner prompt; it is to never
 * hand the model a number it would have to reshape.
 *
 * So every tool result crosses this boundary first. Each `*Cents` field is
 * replaced by a preformatted display string on a de-suffixed key
 * (`totalOutflowCents: 169596` → `totalOutflow: "$1,695.96"`), formatted the
 * same way the web client formats it (`apps/web/src/format/money.ts`) so the
 * chat and the screen state identical amounts. The raw integer is dropped, not
 * kept alongside: leaving it in is exactly the number the model reached for and
 * got wrong.
 *
 * This is the agent's presentation layer only. Core and the HTTP API are
 * unchanged — the UI still receives raw cents and formats them itself.
 */

const UNAVAILABLE = "—";
const CENTS_SUFFIX = "Cents";

/**
 * Mirror of `apps/web/src/format/money.ts`. Absent figures render as an
 * em-dash, never `$0.00` — "$0.00" asserts a known zero, a different claim from
 * "not known". Cents show only when the amount isn't whole, matching the app.
 */
export function formatCents(cents: unknown, currency: string): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return UNAVAILABLE;

  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const showCents = absolute % 100 !== 0;

  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(absolute / 100);

  // Negatives use a leading minus, never parentheses — same as the web client.
  return `${negative ? "-" : ""}${formatted}`;
}

/**
 * Recursively rewrite a tool result so the model sees preformatted money and no
 * raw cents. Structure, ordering, and every non-money field are preserved; only
 * `*Cents` keys are transformed. Returns a new value — the input is not mutated.
 */
export function presentForModel(value: unknown, currency: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => presentForModel(item, currency));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith(CENTS_SUFFIX) && key.length > CENTS_SUFFIX.length) {
        const base = key.slice(0, -CENTS_SUFFIX.length);
        // Guard against a sibling already holding the de-suffixed name; core has
        // no such collision today, but a `*Display` fallback keeps this total.
        const target = base in (value as Record<string, unknown>) ? `${base}Display` : base;
        out[target] = formatCents(raw, currency);
      } else {
        out[key] = presentForModel(raw, currency);
      }
    }
    return out;
  }
  return value;
}
