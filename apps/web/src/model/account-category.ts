/**
 * Account categories — the grouping that stops every account from landing in one
 * undifferentiated pile.
 *
 * Accounts arrive grouped by *institution*, but when the backend hasn't resolved
 * the bank behind a connection the institution reads "Unknown", so grouping by
 * it collapses everything into a single bin. The account's *type* is always
 * known, though — checking, savings, a credit card, a loan, an investment — and
 * that is the grouping a person actually thinks in. So we categorise by what the
 * account *is*.
 *
 * This is classification straight from backend-provided fields (`type`,
 * `isDebt`); no financial value is summed or derived here (`CD-011`). A category
 * carries a display order, a one-line hint, and a stable accent hue so each
 * section reads as its own thing.
 */
import type { AccountView } from "@ai-fin-os/core";

export type AccountCategoryKey =
  | "cash"
  | "savings"
  | "credit"
  | "loans"
  | "investments"
  | "other";

export type AccountCategory = {
  key: AccountCategoryKey;
  /** Section heading, e.g. "Credit cards". */
  label: string;
  /** One-line description under the heading. */
  hint: string;
  /** Ascending display order across the screen. */
  order: number;
  /** A stable accent for the section's dot — a CSS custom property. */
  accent: string;
};

/** The categories, keyed for O(1) lookup and carrying their own display order. */
const CATEGORIES: Record<AccountCategoryKey, AccountCategory> = {
  cash: {
    key: "cash",
    label: "Cash",
    hint: "Everyday, spendable money",
    order: 0,
    accent: "var(--cat-2)",
  },
  savings: {
    key: "savings",
    label: "Savings",
    hint: "Set aside and earning",
    order: 1,
    accent: "var(--cat-4)",
  },
  credit: {
    key: "credit",
    label: "Credit cards",
    hint: "What you owe on cards",
    order: 2,
    accent: "var(--cat-6)",
  },
  loans: {
    key: "loans",
    label: "Loans",
    hint: "Longer-term debt",
    order: 3,
    accent: "var(--cat-7)",
  },
  investments: {
    key: "investments",
    label: "Investments",
    hint: "Retirement and brokerage",
    order: 4,
    accent: "var(--cat-1)",
  },
  other: {
    key: "other",
    label: "Other",
    hint: "Everything else",
    order: 5,
    accent: "var(--cat-8)",
  },
};

/** The category an account belongs to, decided from its backend `type` (with the
 *  debt flag as a fallback so an unrecognised type still lands sensibly). */
export function categoryFor(account: AccountView): AccountCategory {
  switch (account.type) {
    case "checking":
    case "cash":
      return CATEGORIES.cash;
    case "savings":
      return CATEGORIES.savings;
    case "credit_card":
      return CATEGORIES.credit;
    case "loan":
      return CATEGORIES.loans;
    case "investment":
      return CATEGORIES.investments;
    default:
      // An unknown type still has a debt flag; a debt with no known type is far
      // more likely a loan than "cash", so lean on that before falling to Other.
      return account.isDebt ? CATEGORIES.loans : CATEGORIES.other;
  }
}

/** One account paired with the institution it came from, so a category section
 *  can render the card without re-deriving where the account lives. */
export type CategorizedAccount = {
  account: AccountView;
  institutionName: string;
};

/** Group accounts into categories, ordered for display. Empty categories are
 *  omitted. Order within a category is preserved from the input. */
export function groupByCategory(
  items: CategorizedAccount[],
): { category: AccountCategory; items: CategorizedAccount[] }[] {
  const buckets = new Map<AccountCategoryKey, CategorizedAccount[]>();
  for (const item of items) {
    const key = categoryFor(item.account).key;
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([key, groupItems]) => ({ category: CATEGORIES[key], items: groupItems }))
    .sort((a, b) => a.category.order - b.category.order);
}
