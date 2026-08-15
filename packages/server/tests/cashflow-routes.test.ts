/**
 * End-to-end cover for the cash-flow calendar endpoint.
 *
 * The calendar is derived, read-only and never stored (`D-C1`): every request
 * re-runs `buildSnapshotFromHistory` over the imported statement and lays the
 * inferred income and obligations on a forward timeline. So the fixture here is a
 * *history* — three months of a biweekly paycheck and a monthly subscription,
 * the same shape core's snapshot test proves derives exactly one income source
 * and at least one recurring obligation — not a hand-built snapshot.
 *
 * Dates are 2022, never 2026, so the cadence projection runs on a real calendar
 * (`CD-012`). The anchor is the latest posted transaction (2022-07-11), never the
 * wall clock (`D-C4`/`CD-011`), so the assertions below are stable regardless of
 * when the suite runs.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";

const ACCOUNT_ID = "account_local_checking";
const OPENING_BALANCE_CENTS = 412_300;
/** The latest posted transaction date → the deterministic forecast anchor. */
const ASOF = "2022-07-11";
const UPCOMING = "/api/v1/cashflow/upcoming";

type CashFlowEvent = {
  id: string;
  sourceEntityId: string;
  kind: "income" | "obligation";
  date: string;
  amountCents: number;
  status: string;
  balanceAfterCents: number | null;
};

type CashFlowCalendar = {
  asOfDate: string;
  horizonStartDate: string;
  horizonEndDate: string;
  horizonDays: number;
  currency: string;
  openingBalanceCents: number | null;
  events: CashFlowEvent[];
  dailyBalances: { date: string; balanceCents: number }[];
  totals: {
    inflowCents: number;
    outflowCents: number;
    netCents: number;
    incomeEventCount: number;
    obligationEventCount: number;
  };
  lowestBalance: { balanceCents: number; date: string } | null;
  nextReliableIncomeDate?: string;
  outlook: { status: string; lowestBalanceCents: number | null; minimumCashBufferCents: number };
  notes: {
    balanceKnown: boolean;
    accountsMissingBalance: string[];
    incomeSourceCount: number;
    obligationCount: number;
  };
};

async function serverWithHistory() {
  const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/statement-imports/commit",
    payload: importPayload(),
  });
  expect(response.statusCode).toBe(200);
  return app;
}

async function upcoming(
  app: Awaited<ReturnType<typeof createServer>>,
  query = "?currency=USD",
) {
  const response = await app.inject({ method: "GET", url: `${UPCOMING}${query}` });
  return response;
}

describe("cash-flow calendar routes", () => {
  it("404s before any statement is imported — no empty calendar dressed as data", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
    const response = await upcoming(app);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("NO_IMPORTED_HISTORY");
    await app.close();
  });

  it("projects the derived income and obligations onto a forward timeline", async () => {
    const app = await serverWithHistory();
    const response = await upcoming(app);
    expect(response.statusCode).toBe(200);
    const calendar = JSON.parse(response.body) as CashFlowCalendar;

    // Anchored to the latest posted transaction, not today (D-C4/CD-011).
    expect(calendar.asOfDate).toBe(ASOF);
    expect(calendar.horizonStartDate).toBe("2022-07-12"); // day after the anchor
    expect(calendar.horizonEndDate).toBe("2022-08-25"); // anchor + default 45 days
    expect(calendar.horizonDays).toBe(45);
    expect(calendar.currency).toBe("USD");

    // The biweekly paycheck derives exactly one income source (core proves this);
    // the monthly subscription derives at least one obligation.
    expect(calendar.notes.incomeSourceCount).toBe(1);
    expect(calendar.notes.obligationCount).toBeGreaterThanOrEqual(1);

    // Every event carries a signed amount and a stable, per-occurrence id, and
    // lands strictly inside the horizon window.
    expect(calendar.events.length).toBeGreaterThan(0);
    for (const event of calendar.events) {
      expect(event.id).toBe(`${event.sourceEntityId}@${event.date}`);
      expect(event.date >= calendar.horizonStartDate).toBe(true);
      expect(event.date <= calendar.horizonEndDate).toBe(true);
      if (event.kind === "income") expect(event.amountCents).toBeGreaterThan(0);
      else expect(event.amountCents).toBeLessThan(0);
    }

    // Both sides of the ledger show up over a 45-day window.
    expect(calendar.totals.incomeEventCount).toBeGreaterThan(0);
    expect(calendar.totals.obligationEventCount).toBeGreaterThan(0);
    expect(calendar.totals.inflowCents).toBeGreaterThan(0);
    expect(calendar.totals.outflowCents).toBeGreaterThan(0);
    // netCents is a pure identity — it must never disagree with its parts.
    expect(calendar.totals.netCents).toBe(
      calendar.totals.inflowCents - calendar.totals.outflowCents,
    );
    expect(calendar.events).toHaveLength(
      calendar.totals.incomeEventCount + calendar.totals.obligationEventCount,
    );

    await app.close();
  });

  it("opens on the imported balance and draws a known running line through it", async () => {
    const app = await serverWithHistory();
    const calendar = JSON.parse((await upcoming(app)).body) as CashFlowCalendar;

    // The checking account carried a balance, so the projection is grounded, not
    // a guess wearing a number (D-C8). The opening reconciles to the import.
    expect(calendar.notes.balanceKnown).toBe(true);
    expect(calendar.notes.accountsMissingBalance).toEqual([]);
    expect(calendar.openingBalanceCents).toBe(OPENING_BALANCE_CENTS);

    // A known opening balance means a running line and an intraday low, and a
    // decided outlook (never "unknown").
    expect(calendar.dailyBalances.length).toBe(45); // one point per horizon day
    expect(calendar.lowestBalance).not.toBeNull();
    expect(["clear", "tight", "shortfall"]).toContain(calendar.outlook.status);
    expect(calendar.outlook.lowestBalanceCents).toBe(calendar.lowestBalance!.balanceCents);

    // The last event's balanceAfter equals opening + net — the walk is consistent.
    const lastKnown = [...calendar.events].reverse().find((e) => e.balanceAfterCents !== null);
    expect(lastKnown?.balanceAfterCents).toBe(OPENING_BALANCE_CENTS + calendar.totals.netCents);

    await app.close();
  });

  it("honours a caller-supplied horizon and keeps events inside the tighter window", async () => {
    const app = await serverWithHistory();
    const response = await upcoming(app, "?currency=USD&horizon=7");
    expect(response.statusCode).toBe(200);
    const calendar = JSON.parse(response.body) as CashFlowCalendar;

    expect(calendar.horizonDays).toBe(7);
    expect(calendar.horizonEndDate).toBe("2022-07-18"); // anchor + 7 days
    expect(calendar.dailyBalances.length).toBe(7);
    for (const event of calendar.events) {
      expect(event.date <= "2022-07-18").toBe(true);
    }
    await app.close();
  });

  it("rejects an out-of-range horizon as a clear 400 rather than silently clamping", async () => {
    const app = await serverWithHistory();
    for (const horizon of [3, 61, 0, -5]) {
      const response = await upcoming(app, `?currency=USD&horizon=${horizon}`);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe("INVALID_CASHFLOW_QUERY");
    }
    await app.close();
  });

  it("rejects a malformed currency", async () => {
    const app = await serverWithHistory();
    const response = await upcoming(app, "?currency=US");
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_CASHFLOW_QUERY");
    await app.close();
  });

  it("is read-only: the path resolves for GET but not for a write verb", async () => {
    // The endpoint computes and never stores (D-C1). A POST must not resolve at
    // all — there is no write surface to reach.
    const app = await serverWithHistory();
    const response = await app.inject({ method: "POST", url: UPCOMING, payload: {} });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("is deterministic: two identical requests return byte-identical bodies", async () => {
    const app = await serverWithHistory();
    const first = await upcoming(app);
    const second = await upcoming(app);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe(second.body);
    await app.close();
  });
});

describe("cash-flow calendar routes — per-user isolation over HTTP", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function multiUserApp() {
    return createServer({
      authConfig: { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 },
      authPersistence: "memory",
      stores: new InMemoryStatementImportStoreProvider(),
    });
  }

  async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "password123" },
    });
    const token = JSON.parse(res.body).token as string;
    expect(typeof token).toBe("string");
    return token;
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("projects only the authenticated principal's own history", async () => {
    const app = await multiUserApp();
    const alice = await register(app, "alice@example.com"); // first registrant → admin
    const bob = await register(app, "bob@example.com");

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/local/statement-imports/commit",
      headers: auth(alice),
      payload: importPayload(),
    });
    expect(imported.statusCode).toBe(200);

    // Alice sees her projected calendar…
    const aliceView = await app.inject({ method: "GET", url: `${UPCOMING}?currency=USD`, headers: auth(alice) });
    expect(aliceView.statusCode).toBe(200);
    expect((JSON.parse(aliceView.body) as CashFlowCalendar).events.length).toBeGreaterThan(0);

    // …Bob, who imported nothing, gets an honest "import first", never Alice's data.
    const bobView = await app.inject({ method: "GET", url: `${UPCOMING}?currency=USD`, headers: auth(bob) });
    expect(bobView.statusCode).toBe(404);
    expect(JSON.parse(bobView.body).error.code).toBe("NO_IMPORTED_HISTORY");

    await app.close();
  });
});

/** Three months of a biweekly paycheck and a monthly subscription — the shape
 *  core's snapshot test proves derives one income source and a recurring bill.
 *  Sign convention is `outflow_positive`: a spend is positive, income negative. */
function importPayload() {
  const paydays = ["2022-05-02", "2022-05-16", "2022-05-30", "2022-06-13", "2022-06-27", "2022-07-11"];
  const subscriptions = ["2022-05-05", "2022-06-05", "2022-07-05"];
  const rows = [
    "date,description,amount",
    ...paydays.map((date) => `${date},ACME PAYROLL DIRECT DEP,-3200.00`),
    ...subscriptions.map((date) => `${date},NETFLIX.COM,15.99`),
  ];
  return {
    requestId: "cashflow_routes_fixture",
    csv: rows.join("\n"),
    accountId: ACCOUNT_ID,
    account: {
      id: ACCOUNT_ID,
      displayName: "Local Checking",
      institutionName: "Local Bank",
      type: "checking",
      currency: "USD",
      currentBalanceCents: OPENING_BALANCE_CENTS,
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
