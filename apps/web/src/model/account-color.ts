/**
 * Stable colour identity for accounts — the same idea as category-color.ts, and
 * for the same reason. When transactions from every account are pooled into one
 * combined list, a small hue per account makes the list scannable: the user can
 * see at a glance which card a row belongs to. The hue is a stable hash of the
 * account id, so an account keeps its colour everywhere it appears, and it
 * carries no judgement — it is identity, never a verdict (`D-006`).
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

export function accountColor(accountId: string): string {
  let hash = 0;
  for (let i = 0; i < accountId.length; i += 1) {
    hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
