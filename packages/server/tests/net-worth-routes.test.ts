/**
 * End-to-end cover for the net-worth trend endpoint.
 *
 * The domain arithmetic (back-casting, the sign rule, snapshot merge) is proven
 * exhaustively in `packages/core/tests/net-worth-trend.test.ts`. These cases
 * prove the *wiring*: that the route loads the same accounts the Accounts screen
 * does (so the current point can never disagree with the headline), that
 * capture-on-read records today's figure idempotently, that a recorded snapshot
 * supersedes the back-cast, that the window cap and validation hold, and that a
 * deleted account's snapshots are erased.
 *
 * Fixtures are dated 2022 on purpose: the reconstruction sign-rule is exactly
 * the kind of logic a present-dated fixture would never exercise, so the whole
 * path is driven on non-2026 data.
 */
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";
import { InMemoryNetWorthSnapshotProvider } from "../src/local/net-worth-store-provider";
import { OWNER_USER_ID } from "../src/auth/types";
import type { AuthConfig } from "../src/auth/config";

const TREND = "/api/v1/net-worth/trend?currency=USD";

/** A single-user server with an imported checking balance of $2,000 and three
 *  monthly paychecks (Apr–Jun 2022), plus an injected snapshot provider held by
 *  reference so a test can inspect what capture-on-read wrote. */
async function serverWithChecking() {
  const snapshots = new InMemoryNetWorthSnapshotProvider();
  const app = await createServer({
    statementImportStore: new InMemoryStatementImportStore(),
    netWorthSnapshots: snapshots,
  });
  await commit(app, {
    id: "account_local_checking",
    displayName: "Local Checking",
    type: "checking",
    currentBalanceCents: 200_000,
    rows: [
      "2022-04-01,ACME PAYROLL DIRECT DEP,-3000.00",
      "2022-05-01,ACME PAYROLL DIRECT DEP,-3000.00",
      "2022-06-01,ACME PAYROLL DIRECT DEP,-3000.00",
    ],
  });
  return { app, snapshots };
}

async function commit(
  app: Awaited<ReturnType<typeof createServer>>,
  account: { id: string; displayName: string; type: string; currentBalanceCents: number; rows: string[] },
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/statement-imports/commit",
    payload: {
      requestId: `net_worth_fixture_${account.id}`,
      csv: ["date,description,amount", ...account.rows].join("\n"),
      accountId: account.id,
      account: {
        id: account.id,
        displayName: account.displayName,
        institutionName: "Local Bank",
        type: account.type,
        currency: "USD",
        currentBalanceCents: account.currentBalanceCents,
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

const trend = async (app: Awaited<ReturnType<typeof createServer>>, url = TREND) =>
  JSON.parse((await app.inject({ method: "GET", url })).body);

describe("net-worth trend route", () => {
  it("returns the trend and its current point matches the Accounts headline", async () => {
    const { app } = await serverWithChecking();
    const body = await trend(app);

    expect(body).toMatchObject({ currency: "USD", hasData: true });
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.coverageStartMonth).toBe("2022-04"); // earliest transaction month
    // The live point equals the headline exactly — same accounts, same sign rule.
    const accounts = JSON.parse((await app.inject({ method: "GET", url: "/api/v1/accounts?currency=USD" })).body);
    expect(body.currentNetWorthCents).toBe(accounts.netPositionCents);
    expect(body.currentNetWorthCents).toBe(200_000);
    // Newest point is the live month, flagged measured rather than inferred.
    expect(body.points.at(-1)).toMatchObject({ month: "2022-06", basis: "recorded" });

    await app.close();
  });

  it("still matches the headline once a liability is in the mix", async () => {
    const snapshots = new InMemoryNetWorthSnapshotProvider();
    const app = await createServer({
      statementImportStore: new InMemoryStatementImportStore(),
      netWorthSnapshots: snapshots,
    });
    await commit(app, {
      id: "account_local_checking",
      displayName: "Local Checking",
      type: "checking",
      currentBalanceCents: 200_000,
      rows: ["2022-06-01,ACME PAYROLL DIRECT DEP,-3000.00"],
    });
    // Card balance stored as a positive "amount owed"; role makes it a debt.
    await commit(app, {
      id: "account_local_card",
      displayName: "Local Card",
      type: "credit_card",
      currentBalanceCents: 30_000,
      rows: ["2022-06-03,SOME STORE,200.00"],
    });

    const body = await trend(app);
    const accounts = JSON.parse((await app.inject({ method: "GET", url: "/api/v1/accounts?currency=USD" })).body);
    expect(body.currentNetWorthCents).toBe(accounts.netPositionCents);
    expect(body.currentNetWorthCents).toBe(170_000); // 2000 cash − 300 owed

    await app.close();
  });

  it("records today's net worth on read, idempotently", async () => {
    const { app, snapshots } = await serverWithChecking();
    await trend(app);
    await trend(app); // a second view must not add a second row for the same day

    const store = await snapshots.forUser(OWNER_USER_ID);
    const rows = await store.list("USD");
    expect(rows).toHaveLength(1);
    expect(rows[0].netWorthCents).toBe(200_000);

    await app.close();
  });

  it("lets a recorded snapshot supersede the back-cast for its month", async () => {
    const { app, snapshots } = await serverWithChecking();
    // Seed a measured May observation with a distinctive value.
    const store = await snapshots.forUser(OWNER_USER_ID);
    await store.upsert({ observedDate: "2022-05-15", currency: "USD", netWorthCents: 111_111, cashCents: 111_111, debtCents: 0 });

    const body = await trend(app);
    const may = body.points.find((p: { month: string }) => p.month === "2022-05");
    expect(may).toMatchObject({ netWorthCents: 111_111, basis: "recorded" });
    // A neighbouring month stays reconstructed.
    expect(body.points.find((p: { month: string }) => p.month === "2022-04").basis).toBe("reconstructed");

    await app.close();
  });

  it("caps the window to the requested number of months", async () => {
    const { app } = await serverWithChecking();
    const body = await trend(app, "/api/v1/net-worth/trend?currency=USD&months=2");
    expect(body.monthsCovered).toBe(2);
    expect(body.coverageStartMonth).toBe("2022-05"); // Jun, back one month
    await app.close();
  });

  it("rejects a malformed currency rather than guessing", async () => {
    const { app } = await serverWithChecking();
    const response = await app.inject({ method: "GET", url: "/api/v1/net-worth/trend?currency=US" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_NET_WORTH_QUERY");
    await app.close();
  });

  it("rejects months=1 (below minimum of 2)", async () => {
    const { app } = await serverWithChecking();
    const response = await app.inject({ method: "GET", url: "/api/v1/net-worth/trend?currency=USD&months=1" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_NET_WORTH_QUERY");
    await app.close();
  });

  it("rejects months=121 (above maximum of 120)", async () => {
    const { app } = await serverWithChecking();
    const response = await app.inject({ method: "GET", url: "/api/v1/net-worth/trend?currency=USD&months=121" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_NET_WORTH_QUERY");
    await app.close();
  });

  it("reports no data when nothing has been imported", async () => {
    const app = await createServer({
      statementImportStore: new InMemoryStatementImportStore(),
      netWorthSnapshots: new InMemoryNetWorthSnapshotProvider(),
    });
    const body = await trend(app);
    expect(body).toMatchObject({ hasData: false, points: [], currentNetWorthCents: 0, coverageStartMonth: null });
    await app.close();
  });
});

describe("net-worth snapshots — erasure on account deletion", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const multiUser = (): AuthConfig => ({ mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 });

  async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "password123" } });
    return JSON.parse(res.body) as { token: string; user: { id: string } };
  }

  it("erases a deleted user's recorded snapshots", async () => {
    const snapshots = new InMemoryNetWorthSnapshotProvider();
    const erased = vi.spyOn(snapshots, "eraseForUser");
    const app = await createServer({
      authConfig: multiUser(),
      authPersistence: "memory",
      stores: new InMemoryStatementImportStoreProvider(),
      netWorthSnapshots: snapshots,
    });

    await register(app, "admin@example.com"); // bootstrap admin
    const alice = await register(app, "alice@example.com");

    // Alice has a recorded snapshot.
    await (await snapshots.forUser(alice.user.id)).upsert({
      observedDate: "2022-05-15",
      currency: "USD",
      netWorthCents: 90_000,
      cashCents: 90_000,
      debtCents: 0,
    });
    expect(await (await snapshots.forUser(alice.user.id)).list("USD")).toHaveLength(1);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { currentPassword: "password123" },
    });
    expect(del.statusCode).toBe(200);

    expect(erased).toHaveBeenCalledWith(alice.user.id);
    expect(await (await snapshots.forUser(alice.user.id)).list("USD")).toHaveLength(0);

    await app.close();
  });
});
