import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for B14 — transaction date-group headers never showing a year.
 *
 * The header called `formatDate(group.date, group.date)`, passing each group's
 * date as its own year reference. `formatDate` only shows the year when it
 * differs from the reference, so the years always matched and the year was never
 * rendered — every header read a bare "Mar 14", ambiguous on multi-year history.
 *
 * The behavioural contract lives in format/dates.test.ts; this source guard
 * pins the caller so the self-reference bug can't creep back: the header must
 * date each group against the list's reference date, not against itself.
 */
const source = readFileSync(
  fileURLToPath(new URL("./TransactionList.tsx", import.meta.url)),
  "utf8",
);

describe("TransactionList date header (B14)", () => {
  it("does not date a group against its own date", () => {
    expect(source).not.toMatch(/formatDate\(\s*group\.date\s*,\s*group\.date\s*\)/);
  });

  it("dates each group header against the latest posted date", () => {
    expect(source).toMatch(/formatDate\(\s*group\.date\s*,\s*latestPostedDate\s*\)/);
  });
});
