/**
 * Routes added for the import UI, statement periods, real-account
 * affordability, and the assistant.
 *
 * The agent cases here deliberately exercise the *unconfigured* path, which is
 * the one that must never break: without an API key the product still has to
 * import statements and render every screen. Cases that would call the
 * Anthropic API are not run here — a test suite that needs a live model and a
 * paid key is a test suite that gets skipped.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";

const CSV = [
  "Post Date,Description,Amount",
  "07/05/2026,NETFLIX.COM,15.99",
  "07/12/2026,WHOLE FOODS MKT,88.40",
  "07/01/2026,ACME PAYROLL,-3200.00",
].join("\n");

async function server() {
  return createServer({ statementImportStore: new InMemoryStatementImportStore() });
}

describe("CSV column inspection", () => {
  it("returns headers, samples, and suggested mappings", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/columns",
      payload: { csv: CSV },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.headers).toEqual(["Post Date", "Description", "Amount"]);
    expect(body.rowCount).toBe(3);
    expect(body.sampleRows[0]).toMatchObject({ Description: "NETFLIX.COM" });
    expect(body.suggested).toMatchObject({
      postedDate: "Post Date",
      amount: "Amount",
      description: "Description",
    });
    expect(body.suggestedDateFormat).toBe("mm/dd/yyyy");
    await app.close();
  });

  it("never suggests a sign convention", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/columns",
      payload: { csv: CSV },
    });

    // Whether a positive number means money in or out is the one thing a header
    // name cannot tell you, and guessing it turns income into spending. The
    // user must choose it.
    expect(JSON.parse(response.body).suggested).not.toHaveProperty("amountSignConvention");
    await app.close();
  });

  it("reports an unreadable file rather than throwing", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/columns",
      payload: { csv: "   " },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).issues.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("statement cycles from import", () => {
  it("stores a user-provided closing day on a credit card", async () => {
    const app = await server();
    await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      payload: cardImport({ statementCycle: { closingDay: 18 } }),
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/accounts?currency=USD" });
    const account = JSON.parse(response.body).institutions[0].accounts[0];

    expect(account.statementCycle).toMatchObject({ closingDay: 18, source: "user_provided" });
    await app.close();
  });

  it("serves a statement period once a closing day exists", async () => {
    const app = await server();
    await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      payload: cardImport({ statementCycle: { closingDay: 18 } }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=statement&accountId=acct_card",
    });
    const period = JSON.parse(response.body).period;

    expect(period.kind).toBe("statement");
    // 19th to 18th — the bill, not the calendar month.
    expect(period.endDate.endsWith("-18")).toBe(true);
    await app.close();
  });

  it("ignores a cycle on an account that never gets a bill", async () => {
    const app = await server();
    await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      payload: cardImport({ type: "checking", statementCycle: { closingDay: 18 } }),
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/accounts?currency=USD" });

    expect(JSON.parse(response.body).institutions[0].accounts[0].statementCycle).toBeUndefined();
    await app.close();
  });
});

describe("affordability snapshot", () => {
  it("says so when there is no history to derive from", async () => {
    const app = await server();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/affordability/snapshot?currency=USD",
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("NO_IMPORTED_HISTORY");
    await app.close();
  });

  it("derives a snapshot from imported accounts and history", async () => {
    const app = await server();
    await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      payload: payrollImport(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/affordability/snapshot?currency=USD",
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.snapshot.accounts[0].id).toBe("acct_checking");
    expect(body.snapshot.incomeSources.length).toBeGreaterThan(0);
    expect(body.snapshot.incomeSources[0].source).toBe("inferred");
    // An import can't know about accounts it wasn't given.
    expect(body.snapshot.coverage.userConfirmedNoOtherRequiredObligations).toBe(false);
    expect(body.notes.incomeSourceCount).toBeGreaterThan(0);
    await app.close();
  });
});

describe("agent routes without an API key", () => {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

  it("reports status either way, so the UI can explain itself", async () => {
    const app = await server();

    const response = await app.inject({ method: "GET", url: "/api/v1/agent/status" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.configured).toBe(configured);
    expect(body.boundaries).toContain("FIGURES_FROM_DETERMINISTIC_ENGINE");
    if (!configured) expect(body.reason).toMatch(/ANTHROPIC_API_KEY/);
    await app.close();
  });

  it.skipIf(configured)("does not register chat when unconfigured", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.skipIf(configured)("still imports and summarises with no assistant", async () => {
    const app = await server();
    await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      payload: payrollImport(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/spending/summary?currency=USD&period=month&key=2026-07",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).totalOutflowCents).toBeGreaterThan(0);
    await app.close();
  });
});

// ---------------------------------------------------------------------------

function cardImport(account: { type?: string; statementCycle?: { closingDay: number } }) {
  return {
    csv: ["date,description,amount", "2026-07-20,WHOLE FOODS MKT,88.40"].join("\n"),
    accountId: "acct_card",
    account: {
      id: "acct_card",
      displayName: "Rewards Card",
      institutionName: "First National",
      type: account.type ?? "credit_card",
      currency: "USD",
      currentBalanceCents: -120_000,
      ...(account.statementCycle ? { statementCycle: account.statementCycle } : {}),
    },
    currency: "USD",
    dateFormat: "iso",
    mapping: {
      postedDate: "date",
      description: "description",
      amount: "amount",
      amountSignConvention: "outflow_positive",
    },
  };
}

function payrollImport() {
  const rows = ["date,description,amount"];
  for (const date of ["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12", "2026-06-26", "2026-07-10"]) {
    rows.push(`${date},ACME PAYROLL DIRECT DEP,-3200.00`);
  }
  for (const date of ["2026-05-05", "2026-06-05", "2026-07-05"]) {
    rows.push(`${date},NETFLIX.COM,15.99`);
  }
  rows.push("2026-07-12,WHOLE FOODS MKT 102,88.40");

  return {
    csv: rows.join("\n"),
    accountId: "acct_checking",
    account: {
      id: "acct_checking",
      displayName: "Everyday Checking",
      institutionName: "First National",
      type: "checking",
      currency: "USD",
      currentBalanceCents: 412_300,
      includeInForecast: true,
    },
    currency: "USD",
    dateFormat: "iso",
    mapping: {
      postedDate: "date",
      description: "description",
      amount: "amount",
      amountSignConvention: "outflow_positive",
    },
  };
}
