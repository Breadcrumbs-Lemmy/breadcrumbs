/**
 * End-to-end cover for the screen-facing endpoints.
 *
 * These routes had no tests, and the gap hid a real defect: the insights
 * `recurring` block reads `Transaction.recurrenceSignal`, which only ever
 * existed on hand-written fixtures. Every CSV-imported transaction arrived
 * without it, so a dataset containing four monthly subscriptions reported zero.
 * Each case here starts from an actual CSV import rather than a fixture, so the
 * data reaching the domain is the data a user would produce.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";

const ACCOUNT_ID = "account_local_checking";

async function serverWithImportedStatement() {
  const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/statement-imports/commit",
    payload: importPayload(),
  });
  expect(response.statusCode).toBe(200);
  return app;
}

describe("spending routes", () => {
  it("summarises an imported statement by month", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=month&key=2026-06",
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.period).toMatchObject({ kind: "month", key: "2026-06" });
    expect(body.totalOutflowCents).toBeGreaterThan(0);
    expect(body.categoryTotals.length).toBeGreaterThan(0);
    await app.close();
  });

  it("serves week and year periods, not only calendar months", async () => {
    const app = await serverWithImportedStatement();

    const week = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=week&key=2026-W24",
    });
    const year = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=year&key=2026",
    });

    expect(JSON.parse(week.body).period).toMatchObject({ kind: "week", key: "2026-W24" });
    expect(JSON.parse(year.body).period).toMatchObject({ kind: "year", key: "2026" });
    await app.close();
  });

  it("rejects a statement period with no account rather than guessing one", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=statement",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("ACCOUNT_ID_REQUIRED_FOR_STATEMENT");
    await app.close();
  });

  it("detects subscriptions in imported data, which carries no recurrence flag", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/insights?currency=USD&period=month&key=2026-06",
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.recurring.count).toBeGreaterThan(0);
    expect(body.recurring.totalMonthlyCents).toBeGreaterThan(0);
    expect(body.recurring.items.map((item: { displayName: string }) => item.displayName)).toContain(
      "Netflix",
    );
    await app.close();
  });

  it("honours a requested week key on insights", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/insights?currency=USD&period=week&key=2026-W20",
    });

    expect(JSON.parse(response.body).period.key).toBe("2026-W20");
    await app.close();
  });

  it("marks imported subscription transactions as recurring in the transaction list", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?currency=USD&search=netflix&limit=50",
    });
    const body = JSON.parse(response.body);

    expect(body.transactions.length).toBeGreaterThan(0);
    expect(body.transactions.every((t: { isRecurring: boolean }) => t.isRecurring)).toBe(true);
    await app.close();
  });

  it("returns accounts built from the imported statement", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({ method: "GET", url: "/api/v1/accounts?currency=USD" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.institutions).toHaveLength(1);
    expect(body.institutions[0].accounts[0]).toMatchObject({ id: ACCOUNT_ID });
    await app.close();
  });

  it("pairs an inter-account transfer on the transactions screen, not only inside the spending summary", async () => {
    // Two accounts, one $500 move between them, each side imported from its own
    // single-account CSV — exactly how a user with two connected accounts loads
    // data. Neither side is a transfer until both accounts' rows are in the store,
    // so the pairing can only be derived at read time. Before the shared
    // `annotateTransferPairs` pass ran in `load()`, the Spending summary paired
    // these on its private copy while the Transactions screen showed two orphaned
    // UNCLASSIFIED rows with no counter account — the CD-012 cross-screen gap.
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
    await commitTransferSide(app, {
      accountId: "account_local_checking",
      displayName: "Local Checking",
      type: "checking",
      description: "TRANSFER TO SAVINGS",
      amount: "500.00", // outflow_positive: +500 leaves checking -> -50000 cents
    });
    await commitTransferSide(app, {
      accountId: "account_local_savings",
      displayName: "Local Savings",
      type: "savings",
      description: "TRANSFER FROM CHECKING",
      amount: "-500.00", // outflow_positive: -500 enters savings -> +50000 cents
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?currency=USD&limit=50",
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    const out = body.transactions.find((t: { accountId: string }) => t.accountId === "account_local_checking");
    const inbound = body.transactions.find((t: { accountId: string }) => t.accountId === "account_local_savings");

    expect(out).toMatchObject({
      flowType: "TRANSFER_OUT",
      counterAccountId: "account_local_savings",
      counterAccountDisplayName: "Local Savings",
    });
    expect(inbound).toMatchObject({
      flowType: "TRANSFER_IN",
      counterAccountId: "account_local_checking",
      counterAccountDisplayName: "Local Checking",
    });
    expect(out.unclassifiedReason).toBeUndefined();
    expect(inbound.unclassifiedReason).toBeUndefined();
    await app.close();
  });
});

/** Commits one side of an inter-account transfer as its own single-row import. */
async function commitTransferSide(
  app: Awaited<ReturnType<typeof createServer>>,
  opts: { accountId: string; displayName: string; type: string; description: string; amount: string },
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/statement-imports/commit",
    payload: {
      requestId: `transfer_${opts.accountId}`,
      csv: ["date,description,amount", `2026-06-15,${opts.description},${opts.amount}`].join("\n"),
      accountId: opts.accountId,
      account: {
        id: opts.accountId,
        displayName: opts.displayName,
        institutionName: "Local Bank",
        type: opts.type,
        currency: "USD",
        currentBalanceCents: 100000,
        includeInForecast: true,
      },
      currency: "USD",
      dateFormat: "iso",
      mapping: {
        postedDate: "date",
        amount: "amount",
        amountSignConvention: "outflow_positive",
        description: "description",
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

/** Three months of a monthly subscription set plus ordinary spending, which is
 *  the minimum history the recurring detector needs to conclude anything. */
function importPayload() {
  const rows = ["date,description,amount"];
  for (const month of ["04", "05", "06"]) {
    rows.push(`2026-${month}-05,NETFLIX.COM,15.99`);
    rows.push(`2026-${month}-08,SPOTIFY USA,11.99`);
    rows.push(`2026-${month}-02,RENT PAYMENT MGMT CO,1450.00`);
    rows.push(`2026-${month}-11,WHOLE FOODS MKT 102,88.40`);
    rows.push(`2026-${month}-01,ACME PAYROLL DIRECT DEP,-3200.00`);
  }

  return {
    requestId: "spending_routes_fixture",
    csv: rows.join("\n"),
    accountId: ACCOUNT_ID,
    account: {
      id: ACCOUNT_ID,
      displayName: "Local Checking",
      institutionName: "Local Bank",
      type: "checking",
      currency: "USD",
      currentBalanceCents: 412300,
      includeInForecast: true,
    },
    currency: "USD",
    dateFormat: "iso",
    mapping: {
      postedDate: "date",
      amount: "amount",
      amountSignConvention: "outflow_positive",
      description: "description",
    },
  };
}
