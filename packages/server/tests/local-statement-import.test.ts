import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";

describe("local CSV statement import routes", () => {
  it("starts the local API without Plaid credentials", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      plaidEnv: "disabled",
      localImports: "enabled",
      // Single-user is the default posture; a shared deployment reports
      // multi_user here so its security mode is visible at a glance.
      authMode: "single_user",
      // The assistant is optional in the same way Plaid is: with no API key the
      // routes are not registered and every other endpoint still works.
      agent: process.env.ANTHROPIC_API_KEY?.trim() ? "enabled" : "disabled",
    });
    await app.close();
  });

  it("previews CSV rows through explicit column mapping without committing them", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/preview",
      payload: validImportPayload(),
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      sourceFormat: "csv",
      rawCsvStored: false,
      rowCount: 6,
      validRowCount: 6,
      invalidRowCount: 0,
      duplicateInFileCount: 0,
      duplicateAlreadyImportedCount: 0,
      account: {
        id: "account_local_checking",
        displayName: "Local Checking",
        institutionName: "Local Bank",
        source: "csv",
      },
    });
    expect(body.transactions).toHaveLength(6);
    expect(body.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          merchantName: "Amazon",
          normalizedMerchantId: "amazon",
          category: "shopping",
          categoryDisplayName: "Shopping",
          flowType: "SPEND",
          amountCents: -6800,
          source: "csv",
        }),
        expect.objectContaining({
          merchantName: "Southwest Airlines",
          category: "travel",
          flowType: "SPEND",
          amountCents: -21599,
        }),
        expect.objectContaining({
          merchantName: "Northstar Payroll",
          category: "income",
          flowType: "INCOME",
          amountCents: 229000,
        }),
        expect.objectContaining({
          merchantName: "Venmo Transfer",
          category: "transfer",
          flowType: "UNCLASSIFIED",
          amountCents: -22000,
        }),
        expect.objectContaining({
          merchantName: "Amazon",
          normalizedMerchantId: "amazon",
          category: "shopping",
          flowType: "REFUND",
          amountCents: 2500,
        }),
      ]),
    );

    const stored = await app.inject({ method: "GET", url: "/api/local/spending-summary" });
    expect(JSON.parse(stored.body)).toMatchObject({ empty: true, transactions: [] });
    await app.close();
  });

  it("commits valid CSV imports, summarizes spending, and avoids duplicate re-imports", async () => {
    const store = new InMemoryStatementImportStore();
    const app = await createServer({ statementImportStore: store });

    const first = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: validImportPayload(),
    });
    const firstBody = JSON.parse(first.body);
    const august = firstBody.monthlySpendingSummaries.find((summary: { month: string }) => summary.month === "2026-08");

    expect(first.statusCode).toBe(200);
    expect(firstBody).toMatchObject({
      importedTransactionCount: 6,
      duplicateTransactionCount: 0,
      storedTransactionCount: 6,
      importBatch: {
        accountId: "account_local_checking",
        sourceFormat: "csv",
        rawCsvStored: false,
        importedTransactionCount: 6,
      },
    });
    expect(august).toMatchObject({
      totalOutflowCents: 34224,
      grossOutflowCents: 36724,
      totalInflowCents: 229000,
      refundCents: 2500,
      unclassifiedOutflowCents: 22000,
    });
    expect(august.categoryTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "shopping", outflowCents: 4300, refundCents: 2500 }),
        expect.objectContaining({ category: "travel", outflowCents: 21599 }),
        expect.objectContaining({ category: "groceries", outflowCents: 8325 }),
      ]),
    );

    const second = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: validImportPayload(),
    });
    const secondBody = JSON.parse(second.body);

    expect(second.statusCode).toBe(200);
    expect(secondBody).toMatchObject({
      importedTransactionCount: 0,
      duplicateTransactionCount: 6,
      storedTransactionCount: 6,
      duplicateAlreadyImportedCount: 6,
    });
    await app.close();
  });

  it("rejects commit when mapping or row validation fails", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: {
        ...validImportPayload(),
        csv: [
          "Posted,Description,Amount,Currency",
          "08/40/2026,Target,-15.00,USD",
          "08/02/2026,Shell,abc,USD",
          "08/03/2026,Bookstore,-20.00,CAD",
        ].join("\n"),
        mapping: {
          postedDate: "Posted",
          amount: "Amount",
          amountSignConvention: "signed",
          description: "Description",
          currency: "Currency",
        },
      },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(422);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_DATE", rowNumber: 2 }),
        expect.objectContaining({ code: "INVALID_AMOUNT", rowNumber: 3 }),
        expect.objectContaining({ code: "INVALID_CURRENCY", rowNumber: 4 }),
      ]),
    );

    const stored = await app.inject({ method: "GET", url: "/api/local/spending-summary" });
    expect(JSON.parse(stored.body)).toMatchObject({ empty: true, transactions: [] });
    await app.close();
  });

  it("imports a split debit/credit CSV where the unused column is 0.00", async () => {
    // Real bank exports fill the side that doesn't apply with 0.00, not a blank.
    // Every one of these rows must import cleanly — a 0.00 credit on a debit row
    // must not read as "both present" and reject the row.
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/preview",
      payload: {
        ...validImportPayload(),
        mapping: {
          postedDate: "Posted",
          debitAmount: "Debit",
          creditAmount: "Credit",
          description: "Description",
          transactionId: "Transaction Id",
        },
        csv: [
          "Posted,Description,Debit,Credit,Transaction Id",
          "08/01/2026,Amazon Marketplace,68.00,0.00,dc-row-1",
          "08/04/2026,Northstar Payroll,0.00,2290.00,dc-row-2",
        ].join("\n"),
      },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ rowCount: 2, validRowCount: 2, invalidRowCount: 0 });
    expect(body.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ merchantName: "Amazon", amountCents: -6800, flowType: "SPEND" }),
        expect.objectContaining({ merchantName: "Northstar Payroll", amountCents: 229000, flowType: "INCOME" }),
      ]),
    );
    await app.close();
  });

  it("requires an account descriptor for the first import into an account", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const response = await app.inject({
      method: "POST",
      url: "/api/local/statement-imports/commit",
      payload: {
        ...validImportPayload(),
        account: undefined,
      },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(422);
    expect(body.errors).toEqual([expect.objectContaining({ code: "UNKNOWN_ACCOUNT" })]);
    await app.close();
  });
});

function validImportPayload() {
  return {
    requestId: "test-csv-import",
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
      "08/01/2026,Amazon Marketplace,-68.00,Shopping,bank-row-1",
      "08/02/2026,Southwest Airlines,-215.99,Travel,bank-row-2",
      "08/03/2026,Trader Joe's,-83.25,Groceries,bank-row-3",
      "08/04/2026,Northstar Payroll,2290.00,Income,bank-row-4",
      "08/05/2026,Venmo Transfer,-220.00,Transfer,bank-row-5",
      "08/06/2026,Amazon Refund,25.00,Shopping,bank-row-6",
    ].join("\n"),
  };
}
