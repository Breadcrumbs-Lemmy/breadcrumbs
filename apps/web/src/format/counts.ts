/**
 * Count-with-noun formatting.
 *
 * Small, pure helpers for "N thing(s)" phrasing. Kept in one place so the same
 * phrase can't be pluralized correctly in one component and hard-coded plural in
 * another — the drift that had the Spending hero read "1 banks · 3 accounts"
 * while the Accounts roster below it correctly read "1 bank · 3 accounts" (B6).
 */

/** "1 bank" / "3 banks" — pluralizes the noun by count. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * "1 bank · 3 accounts" — the accounts-coverage summary shown on the Spending
 * hero and again on the Accounts roster. One source so the two never disagree.
 */
export function banksAndAccounts(bankCount: number, accountCount: number): string {
  return `${pluralize(bankCount, "bank")} · ${pluralize(accountCount, "account")}`;
}
