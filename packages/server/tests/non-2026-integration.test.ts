/**
 * A full import → summary run on real historical dates, not 2026.
 *
 * Every fixture in the repo is dated 2026 — a calendar that is uniquely
 * forgiving (2026 is not a leap year and its statement cycles never straddle a
 * short February). That let a real class of bugs hide in the shared domain code:
 * date extraction, month bucketing and cycle math that only 2026 data ever
 * exercised (the "fixture-2026-blind-spot"). The unit tests in core now pin the
 * primitives directly; this closes the loop at the seam a user actually hits —
 * a CSV commit and the spending summary computed from it — using 2021–2024 data,
 * including a 2024-02-29 leap day. If bucketing or extraction mishandled a real
 * year, the totals below would be wrong or the leap-day row would vanish.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";

function historicalImportPayload() {
  return {
    requestId: "non-2026-import",
    accountId: "account_local_checking",
    account: {
      id: "account_local_checking",
      displayName: "Local Checking",
      institutionName: "Local Bank",
      type: "checking",
      currency: "USD",
    },
    currency: "USD",
    dateFormat: "mm/dd/yyyy",
    mapping: {
      postedDate: "Posted",
      amount: "Amount",
      amountSignConvention: "signed",
      description: "Description",
      category: "Category",
      transactionId: "Transaction Id",
    },
    csv: [
      "Posted,Description,Amount,Category,Transaction Id",
      "06/15/2021,Amazon Marketplace,-68.00,Shopping,nz-2021-1",
      "06/20/2021,Northstar Payroll,2290.00,Income,nz-2021-2",
      "02/28/2022,Trader Joe's,-40.00,Groceries,nz-2022-1",
      "02/29/2024,Trader Joe's,-83.25,Groceries,nz-2024-1", // real leap day
    ].join("\n"),
  };
}

describe("non-2026 historical import (fixture-2026-blind-spot)", () => {
  it("buckets 2021 spend and income into the correct historical month", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: historicalImportPayload(),
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.importedTransactionCount).toBe(4);

    const june2021 = body.monthlySpendingSummaries.find((s: { month: string }) => s.month === "2021-06");
    expect(june2021, "a 2021-06 bucket must exist").toBeDefined();
    expect(june2021).toMatchObject({
      totalOutflowCents: 6800, // Amazon -$68.00
      totalInflowCents: 229000, // Payroll +$2290.00
    });

    await app.close();
  });

  it("imports and buckets a 2024-02-29 leap day instead of dropping or shifting it", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: historicalImportPayload(),
    });

    const commit = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: historicalImportPayload(),
    });
    // The leap-day row lands in February 2024 with its exact amount.
    const feb2024 = JSON.parse(commit.body).monthlySpendingSummaries.find(
      (s: { month: string }) => s.month === "2024-02",
    );
    expect(feb2024, "a 2024-02 bucket must exist for the leap-day row").toBeDefined();
    expect(feb2024.totalOutflowCents).toBe(8325); // Trader Joe's -$83.25

    // And the stored transaction keeps the literal calendar date — no TZ shift to
    // the 28th or March 1st, which is exactly what the old date handling risked.
    const state = await app.inject({ method: "GET", url: "/api/local/spending-summary" });
    const postedDates = JSON.parse(state.body).transactions.map((t: { postedDate: string }) => t.postedDate);
    expect(postedDates).toContain("2024-02-29");
    expect(postedDates).toContain("2021-06-15");

    await app.close();
  });
});
