/**
 * Stable colour identity for spending categories.
 *
 * The design system originally banned category colour outright, on the grounds
 * that a rainbow palette implies categories carry different moral weight
 * (`D-006`). That was too blunt. Apple Card shows why: hue used as *identity*
 * makes a list scannable, and carries no judgement at all. What must stay
 * banned is hue used as *verdict* — red for overspending, green for virtue.
 *
 * So the rule is now:
 *
 *   - Allowed: a fixed hue per category, for recognition.
 *   - Banned: hue that encodes good or bad.
 *
 * Two properties make the first safe. The eight hues sit at deliberately
 * similar chroma and lightness, so none reads as louder than another. And the
 * assignment is a stable hash of the category id, so Dining is the same colour
 * every time it appears — including in periods where it happens to be the
 * largest or smallest line. A colour that moved with rank would be a verdict.
 */

const PALETTE = [
  "var(--cat-1)",
  "var(--cat-2)",
  "var(--cat-3)",
  "var(--cat-4)",
  "var(--cat-5)",
  "var(--cat-6)",
  "var(--cat-7)",
  "var(--cat-8)",
] as const;

/**
 * Deliberate assignments for the categories a user sees most, so the common
 * cases feel considered rather than arbitrary. Anything unlisted falls through
 * to the hash, which is stable but unowned.
 */
const FIXED: Record<string, number> = {
  housing: 0,
  groceries: 7,
  dining: 1,
  coffee_snacks: 4,
  transportation: 2,
  travel: 5,
  shopping: 3,
  utilities: 2,
  streaming: 3,
  software: 5,
  music_audio: 3,
  cloud_storage: 5,
  medical: 6,
  education: 6,
  fees: 6,
  cash: 6,
};

export function categoryColor(categoryId: string): string {
  const fixed = FIXED[categoryId];
  if (fixed !== undefined) return PALETTE[fixed]!;

  // Stable across sessions and independent of rank, ordering, or period.
  let hash = 0;
  for (let i = 0; i < categoryId.length; i += 1) {
    hash = (hash * 31 + categoryId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
