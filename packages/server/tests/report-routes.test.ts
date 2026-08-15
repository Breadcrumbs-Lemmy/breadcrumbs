/**
 * End-to-end cover for the monthly-report endpoints.
 *
 * The data comes from an actual CSV import (2022 dates, so real calendar-month
 * arithmetic runs, not the forgiving 2026 fixtures — `CD-012`), so the rows the
 * report composes are the rows a user would produce. The cases pin the contract
 * the web depends on: the default is the latest COMPLETE month, an explicit key
 * overrides it, the CSV carries download headers, a bad key is a 400, and an
 * empty store is the NO_IMPORTED_HISTORY 404 the web maps to its empty state.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";

const ACCOUNT_ID = "account_local_checking";

/** Three months (Apr–Jun 2022) of subscriptions, rent, groceries, and payroll.
 *  The newest posted date is 2022-06-11, so the latest COMPLETE month is May. */
function importPayload() {
  const rows = ["date,description,amount"];
  for (const month of ["04", "05", "06"]) {
    rows.push(`2022-${month}-05,NETFLIX.COM,15.99`);
    rows.push(`2022-${month}-08,SPOTIFY USA,11.99`);
    rows.push(`2022-${month}-02,RENT PAYMENT MGMT CO,1450.00`);
    rows.push(`2022-${month}-11,WHOLE FOODS MKT 102,88.40`);
    rows.push(`2022-${month}-01,ACME PAYROLL DIRECT DEP,-3200.00`);
  }
  return {
    requestId: "report_routes_fixture",
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

describe("monthly report routes", () => {
  it("defaults to the latest COMPLETE month (May, not the partial June)", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({ method: "GET", url: "/api/v1/reports/monthly?currency=USD" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.summary.period.key).toBe("2022-05");
    expect(body.fromLatestComplete).toBe(true);
    expect(body.requestedKey).toBeNull();
    // It is a composition: both engines' payloads are present and agree on the month.
    expect(body.insights.period.key).toBe("2022-05");
    expect(body.summary.categoryTotals.length).toBeGreaterThan(0);
    await app.close();
  });

  it("honours an explicit month key", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly?currency=USD&key=2022-06",
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.summary.period.key).toBe("2022-06");
    expect(body.requestedKey).toBe("2022-06");
    expect(body.fromLatestComplete).toBe(false);
    await app.close();
  });

  it("serves the CSV as a downloadable attachment named for the month", async () => {
    const app = await serverWithImportedStatement();

    const response = await app.inject({ method: "GET", url: "/api/v1/reports/monthly.csv?currency=USD" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="monthly-report-2022-05.csv"',
    );

    const lines = response.body.split("\r\n");
    expect(lines[0]).toBe("Category,Spent,Refunds,Net,Share %,Transactions");
    expect(response.body).toContain("\r\nTotal,");
    expect(response.body.endsWith("\r\n")).toBe(true);
    await app.close();
  });

  it("rejects a malformed month key with a 400 rather than a 500", async () => {
    const app = await serverWithImportedStatement();

    const bad = await app.inject({ method: "GET", url: "/api/v1/reports/monthly?key=2022-13" });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe("INVALID_REPORT_QUERY");

    const junk = await app.inject({ method: "GET", url: "/api/v1/reports/monthly?key=nope" });
    expect(junk.statusCode).toBe(400);
    await app.close();
  });

  it("returns NO_IMPORTED_HISTORY (404) when nothing has been imported", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });

    const json = await app.inject({ method: "GET", url: "/api/v1/reports/monthly?currency=USD" });
    expect(json.statusCode).toBe(404);
    expect(JSON.parse(json.body).error.code).toBe("NO_IMPORTED_HISTORY");

    const csv = await app.inject({ method: "GET", url: "/api/v1/reports/monthly.csv?currency=USD" });
    expect(csv.statusCode).toBe(404);
    await app.close();
  });
});
