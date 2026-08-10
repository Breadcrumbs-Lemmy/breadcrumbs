/**
 * End-to-end cover for the budget endpoints and the per-user budget store.
 *
 * Progress is asserted against the *same* spending summary the Spending screen
 * serves — the test reads the summary first, then a budget's "spent" figure must
 * equal that summary's category total, so the two surfaces can never disagree.
 * Dates are 2022, never 2026, so the month arithmetic runs on a real calendar
 * (`CD-012`).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";
import { FieldCipher } from "../src/crypto/field-cipher";
import { FileBudgetStore, InMemoryBudgetStore, normalizeState } from "../src/local/budget-store";
import {
  FileBudgetStoreProvider,
  InMemoryBudgetStoreProvider,
} from "../src/local/budget-store-provider";

const ACCOUNT_ID = "account_local_checking";
const MONTH = "2022-07";
// ISO week Jul 4–10 2022 (Mon-start). Of the fixture rows, 2022-07-05 and
// 2022-07-08 fall inside it; 2022-07-12 and 2022-07-20 are later weeks.
const WEEK = "2022-W27";

async function serverWithSpending() {
  const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/statement-imports/commit",
    payload: importPayload(),
  });
  expect(response.statusCode).toBe(200);
  return app;
}

type Summary = {
  totalOutflowCents: number;
  categoryTotals: { category: string; outflowCents: number }[];
};

async function summaryFor(
  app: Awaited<ReturnType<typeof createServer>>,
  period: "month" | "week" = "month",
  key: string = MONTH,
): Promise<Summary> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/spending/summary?currency=USD&period=${period}&key=${key}`,
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as Summary;
}

describe("budget routes", () => {
  it("returns an empty, default budget set before anything is configured", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/budgets" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ currency: "USD", overallLimitCents: null, overallWeeklyLimitCents: null, budgets: [] });
    await app.close();
  });

  it("round-trips a save and returns the set sorted by category", async () => {
    const app = await serverWithSpending();

    const save = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        currency: "USD",
        overallLimitCents: 500_000,
        // Deliberately out of order to prove the store sorts deterministically.
        budgets: [
          { category: "shopping", limitCents: 20_000 },
          { category: "groceries", limitCents: 40_000 },
        ],
      },
    });
    expect(save.statusCode).toBe(200);
    expect(JSON.parse(save.body).budgets.map((b: { category: string }) => b.category)).toEqual([
      "groceries",
      "shopping",
    ]);

    // A fresh GET sees exactly what was saved.
    const get = await app.inject({ method: "GET", url: "/api/v1/budgets" });
    expect(JSON.parse(get.body)).toEqual({
      currency: "USD",
      overallLimitCents: 500_000,
      overallWeeklyLimitCents: null,
      budgets: [
        { category: "groceries", limitCents: 40_000 },
        { category: "shopping", limitCents: 20_000 },
      ],
    });
    await app.close();
  });

  it("rejects a duplicate category rather than silently collapsing it", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        budgets: [
          { category: "groceries", limitCents: 40_000 },
          { category: "groceries", limitCents: 10_000 },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    await app.close();
  });

  it("rejects a non-positive or non-integer limit", async () => {
    const app = await serverWithSpending();
    for (const limitCents of [0, -100, 12.5]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/budgets",
        payload: { budgets: [{ category: "groceries", limitCents }] },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    }
    await app.close();
  });

  it("rejects the PUT verb so the whole-set write stays on POST (CORS allowlist)", async () => {
    // The server's CORS allowlist advertises GET,POST,PATCH,DELETE — no PUT. A
    // PUT route passes inject-tests but fails a real browser preflight, so the
    // write is POST and PUT must not resolve at all. Guards the H-082 regression.
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/budgets",
      payload: { currency: "USD", overallLimitCents: null, budgets: [] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects an unknown top-level field (strict schema)", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: { budgets: [], surpriseField: true },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    await app.close();
  });

  it("rejects a limit above the sanity ceiling", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: { budgets: [{ category: "groceries", limitCents: 1_000_000_001 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    await app.close();
  });

  it("rejects more than 100 budgets in one save", async () => {
    const app = await serverWithSpending();
    const budgets = Array.from({ length: 101 }, (_, i) => ({ category: `cat_${i}`, limitCents: 1_000 }));
    const response = await app.inject({ method: "POST", url: "/api/v1/budgets", payload: { budgets } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    await app.close();
  });

  it("accepts an empty body and returns the default set", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "POST", url: "/api/v1/budgets", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ currency: "USD", overallLimitCents: null, overallWeeklyLimitCents: null, budgets: [] });
    await app.close();
  });

  it("computes progress that equals the spending summary's category total", async () => {
    const app = await serverWithSpending();
    const summary = await summaryFor(app);
    const top = summary.categoryTotals[0]!;
    // A limit at half of actual spend forces an unambiguous "over".
    const limitCents = Math.max(1, Math.floor(top.outflowCents / 2));

    await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        currency: "USD",
        overallLimitCents: summary.totalOutflowCents + 100_000, // comfortably above → under
        budgets: [{ category: top.category, limitCents }],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/progress?currency=USD&key=${MONTH}`,
    });
    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.body);

    const line = progress.lines.find((l: { category: string }) => l.category === top.category);
    expect(line).toBeTruthy();
    // The load-bearing invariant: budget "spent" IS the Spending screen's total.
    expect(line.spentCents).toBe(top.outflowCents);
    expect(line.limitCents).toBe(limitCents);
    expect(line.overBudgetCents).toBe(top.outflowCents - limitCents);
    expect(line.status).toBe("over");

    expect(progress.overall).toMatchObject({
      spentCents: summary.totalOutflowCents,
      status: "under",
    });
    expect(progress.currency).toBe("USD");
    await app.close();
  });

  it("defaults the progress month to the latest transaction when no key is given", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/budgets/progress?currency=USD" });
    expect(response.statusCode).toBe(200);
    // Latest transaction is in July 2022, so the period resolves to that month.
    expect(JSON.parse(response.body).period).toMatchObject({ kind: "month", key: MONTH });
    await app.close();
  });

  it("rejects a malformed progress month key", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/budgets/progress?key=2022-7" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS_PROGRESS_QUERY");
    await app.close();
  });

  it("rejects a malformed progress currency", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/budgets/progress?currency=US" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS_PROGRESS_QUERY");
    await app.close();
  });

  it("surfaces the pace projection over HTTP without moving status (D-B3)", async () => {
    // The fixture's latest transaction is 2022-07-20, so July is a partial month
    // (20 of 31 days) and progress carries a projection. A cap at 1.4× actual
    // spend is comfortably under on money spent, yet the pace (×1.55) projects
    // over — status must stay on the spend, the warning rides the projection.
    const app = await serverWithSpending();
    const summary = await summaryFor(app);
    const top = summary.categoryTotals[0]!;
    const limitCents = Math.round(top.outflowCents * 1.4);

    await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: { currency: "USD", budgets: [{ category: top.category, limitCents }] },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/progress?currency=USD&key=${MONTH}`,
    });
    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.body);
    expect(progress.period).toMatchObject({ partial: true });

    const line = progress.lines.find((l: { category: string }) => l.category === top.category);
    expect(line.status).toBe("under"); // headline status: money actually spent
    expect(line.projection.totalDays).toBe(31);
    expect(line.projection.elapsedDays).toBe(20);
    expect(line.projection.projectedStatus).toBe("over"); // …but on pace to breach
  });
});

describe("budget routes — weekly caps (D-B1)", () => {
  it("saves weekly and monthly caps on one category, echoing period only on the weekly one", async () => {
    const app = await serverWithSpending();
    const save = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        currency: "USD",
        overallLimitCents: 500_000,
        overallWeeklyLimitCents: 120_000,
        budgets: [
          { category: "groceries", limitCents: 40_000 }, // monthly (implicit)
          { category: "groceries", limitCents: 12_000, period: "week" }, // weekly
        ],
      },
    });
    expect(save.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/v1/budgets" });
    // A category may hold one cap per window; the monthly cap serialises without a
    // `period` field (unchanged on-disk shape), the weekly one keeps it.
    expect(JSON.parse(get.body)).toEqual({
      currency: "USD",
      overallLimitCents: 500_000,
      overallWeeklyLimitCents: 120_000,
      budgets: [
        { category: "groceries", limitCents: 40_000 },
        { category: "groceries", limitCents: 12_000, period: "week" },
      ],
    });
    await app.close();
  });

  it("rejects two caps for the same (window, category)", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        budgets: [
          { category: "groceries", limitCents: 12_000, period: "week" },
          { category: "groceries", limitCents: 9_000, period: "week" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS");
    await app.close();
  });

  it("scores a weekly window against the matching weekly spending summary", async () => {
    const app = await serverWithSpending();
    // The week's spend, straight from the Spending screen's own weekly summary.
    const week = await summaryFor(app, "week", WEEK);
    const top = week.categoryTotals[0]!;
    const limitCents = Math.max(1, Math.floor(top.outflowCents / 2)); // forces over

    await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: {
        currency: "USD",
        overallWeeklyLimitCents: week.totalOutflowCents + 100_000, // comfortably under
        budgets: [
          { category: top.category, limitCents, period: "week" },
          // A monthly cap on the same category must NOT bleed into the weekly view.
          { category: top.category, limitCents: 10_000_000 },
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/progress?currency=USD&period=week&key=${WEEK}`,
    });
    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.body);

    expect(progress.period).toMatchObject({ kind: "week", key: WEEK });
    // Only the weekly cap is scored — one line, not two.
    expect(progress.budgetedCount).toBe(1);
    const line = progress.lines.find((l: { category: string }) => l.category === top.category);
    expect(line.limitCents).toBe(limitCents); // the weekly cap, not the $100k monthly one
    expect(line.spentCents).toBe(top.outflowCents); // budget spent IS the weekly summary total
    expect(line.status).toBe("over");
    // The overall cap in scope is the weekly one, checked against the week's outflow.
    expect(progress.overall).toMatchObject({ spentCents: week.totalOutflowCents, status: "under" });
    await app.close();
  });

  it("warns at 90% of a weekly cap (near threshold widened from 80%)", async () => {
    const app = await serverWithSpending();
    const week = await summaryFor(app, "week", WEEK);
    const top = week.categoryTotals[0]!;
    // Size the cap so actual spend is ~90% of it: near, not yet over.
    const limitCents = Math.round(top.outflowCents / 0.9);

    await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      payload: { currency: "USD", budgets: [{ category: top.category, limitCents, period: "week" }] },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/progress?currency=USD&period=week&key=${WEEK}`,
    });
    const progress = JSON.parse(response.body);
    const line = progress.lines.find((l: { category: string }) => l.category === top.category);
    expect(line.usedBasisPoints).toBe(9_000);
    expect(line.status).toBe("near");
    await app.close();
  });

  it("defaults the weekly window to the week of the latest transaction", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/budgets/progress?currency=USD&period=week" });
    expect(response.statusCode).toBe(200);
    // Latest fixture transaction is 2022-07-20, which lands in ISO week 2022-W29.
    expect(JSON.parse(response.body).period).toMatchObject({ kind: "week", key: "2022-W29" });
    await app.close();
  });

  it("rejects a month-shaped key when asking for a weekly window", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/budgets/progress?currency=USD&period=week&key=2022-07",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_BUDGETS_PROGRESS_QUERY");
    await app.close();
  });
});

describe("FileBudgetStore encryption at rest", () => {
  let dir: string;
  let filePath: string;
  const cipher = new FieldCipher(randomBytes(32));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bc-budget-"));
    filePath = join(dir, "budgets.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes ciphertext to disk but reads back the real budgets", async () => {
    const store = new FileBudgetStore(filePath, cipher);
    await store.save({
      currency: "USD",
      overallLimitCents: 250_000,
      budgets: [{ category: "coffee_shops", limitCents: 8_000 }],
    });

    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk).toContain("bcenc1:");
    // The category — a hint at the user's spending intent — must not be legible.
    expect(onDisk).not.toContain("coffee_shops");

    const reloaded = await new FileBudgetStore(filePath, cipher).load();
    expect(reloaded.budgets).toEqual([{ category: "coffee_shops", limitCents: 8_000 }]);
    expect(reloaded.overallLimitCents).toBe(250_000);

    // 0600 — never world-readable.
    expect((await stat(filePath)).mode & 0o077).toBe(0);
  });

  it("cannot read a file written under a different key", async () => {
    await new FileBudgetStore(filePath, cipher).save({
      currency: "USD",
      overallLimitCents: null,
      budgets: [{ category: "groceries", limitCents: 40_000 }],
    });
    const wrongKey = new FileBudgetStore(filePath, new FieldCipher(randomBytes(32)));
    await expect(wrongKey.load()).rejects.toThrow();
  });

  it("refuses to read an encrypted file with no key rather than returning empty", async () => {
    await new FileBudgetStore(filePath, cipher).save({
      currency: "USD",
      overallLimitCents: null,
      budgets: [{ category: "groceries", limitCents: 40_000 }],
    });
    await expect(new FileBudgetStore(filePath).load()).rejects.toThrow(/encrypted/i);
  });
});

describe("FileBudgetStore persistence & migration", () => {
  it("returns an empty default for a missing file and does not create one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-missing-"));
    try {
      const filePath = join(dir, "budgets.json");
      const store = new FileBudgetStore(filePath);
      expect(await store.load()).toEqual({ currency: "USD", overallLimitCents: null, overallWeeklyLimitCents: null, budgets: [] });
      // A read must never materialise the file — that's a write's job.
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serialises concurrent saves so the last-enqueued write wins intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-queue-"));
    try {
      const store = new FileBudgetStore(join(dir, "budgets.json"));
      // Fire 20 saves without awaiting between them: the write queue must run
      // them in order, atomically, so the file is never a torn interleave.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.save({
            currency: "USD",
            overallLimitCents: (i + 1) * 1_000,
            budgets: [{ category: `cat_${i}`, limitCents: 1_000 }],
          }),
        ),
      );
      // Deterministic: the queue is a strict in-order chain, so #19 persists last.
      const reloaded = await store.load();
      expect(reloaded.budgets).toEqual([{ category: "cat_19", limitCents: 1_000 }]);
      expect(reloaded.overallLimitCents).toBe(20_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a legacy plaintext file and re-seals it encrypted on the next save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-migrate-"));
    try {
      const filePath = join(dir, "budgets.json");
      // A pre-encryption install: a bare plaintext state on disk.
      await new FileBudgetStore(filePath).save({
        currency: "USD",
        overallLimitCents: null,
        budgets: [{ category: "groceries", limitCents: 40_000 }],
      });
      expect(await readFile(filePath, "utf8")).toContain("groceries"); // legible

      // A cipher is now configured. The legacy file is still readable…
      const cipher = new FieldCipher(randomBytes(32));
      const store = new FileBudgetStore(filePath, cipher);
      expect((await store.load()).budgets).toEqual([{ category: "groceries", limitCents: 40_000 }]);

      // …and the next save re-seals it: ciphertext on disk, intent no longer legible.
      await store.save({ currency: "USD", overallLimitCents: null, budgets: [{ category: "groceries", limitCents: 50_000 }] });
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).toContain("bcenc1:");
      expect(onDisk).not.toContain("groceries");
      expect((await new FileBudgetStore(filePath, cipher).load()).budgets).toEqual([
        { category: "groceries", limitCents: 50_000 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("budget store normalization", () => {
  it("drops malformed budgets and coerces a bad overall cap to none", () => {
    const state = normalizeState({
      currency: "usd",
      overallLimitCents: -5 as number,
      budgets: [
        { category: "groceries", limitCents: 40_000 },
        { category: "groceries", limitCents: 1 }, // duplicate → dropped
        { category: "shopping", limitCents: 0 }, // non-positive → dropped
        { category: "", limitCents: 100 }, // empty category → dropped
        { category: "dining", limitCents: 12.5 }, // non-integer → dropped
      ] as { category: string; limitCents: number }[],
    });
    expect(state.currency).toBe("USD");
    expect(state.overallLimitCents).toBeNull();
    expect(state.budgets).toEqual([{ category: "groceries", limitCents: 40_000 }]);
  });

  it("caps a non-finite or fractional overall to none, and survives null input", () => {
    expect(normalizeState({ overallLimitCents: Infinity as number }).overallLimitCents).toBeNull();
    expect(normalizeState({ overallLimitCents: Number.NaN as number }).overallLimitCents).toBeNull();
    expect(normalizeState({ overallLimitCents: 12.5 as number }).overallLimitCents).toBeNull();
    expect(normalizeState({ overallLimitCents: 0 as number }).overallLimitCents).toBeNull();
    expect(normalizeState({ overallLimitCents: 250_000 }).overallLimitCents).toBe(250_000);
    // A missing or null file must degrade to the empty default, never throw.
    expect(normalizeState(null)).toEqual({ currency: "USD", overallLimitCents: null, overallWeeklyLimitCents: null, budgets: [] });
    expect(normalizeState(undefined).currency).toBe("USD");
  });
});

describe("budget store isolation & erase", () => {
  it("gives each user their own in-memory store", async () => {
    const provider = new InMemoryBudgetStoreProvider();
    const alice = await provider.forUser("usr_alice");
    const bob = await provider.forUser("usr_bob");
    await alice.save({ currency: "USD", overallLimitCents: null, budgets: [{ category: "groceries", limitCents: 40_000 }] });

    expect((await bob.load()).budgets).toEqual([]);
    expect((await alice.load()).budgets).toHaveLength(1);

    await provider.eraseForUser("usr_alice");
    // A fresh store for the same id is empty again.
    const aliceAgain = await provider.forUser("usr_alice");
    expect((await aliceAgain.load()).budgets).toEqual([]);
  });

  it("removes a user's budgets file on erase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-iso-"));
    try {
      const provider = new FileBudgetStoreProvider(dir);
      const store = await provider.forUser("usr_alice");
      await store.save({ currency: "USD", overallLimitCents: null, budgets: [{ category: "groceries", limitCents: 40_000 }] });
      const filePath = join(dir, "users", "usr_alice", "budgets.json");
      expect((await stat(filePath)).isFile()).toBe(true);

      await provider.eraseForUser("usr_alice");
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps each user's file separate and reloads it after a provider restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-two-"));
    try {
      const first = new FileBudgetStoreProvider(dir);
      await (await first.forUser("usr_alice")).save({
        currency: "USD",
        overallLimitCents: null,
        budgets: [{ category: "groceries", limitCents: 40_000 }],
      });
      await (await first.forUser("usr_bob")).save({
        currency: "USD",
        overallLimitCents: null,
        budgets: [{ category: "dining", limitCents: 12_000 }],
      });

      // A brand-new provider with an empty cache (a process restart) reads each
      // user's file straight back — isolation survives persistence, not just cache.
      const restarted = new FileBudgetStoreProvider(dir);
      expect((await (await restarted.forUser("usr_alice")).load()).budgets).toEqual([
        { category: "groceries", limitCents: 40_000 },
      ]);
      expect((await (await restarted.forUser("usr_bob")).load()).budgets).toEqual([
        { category: "dining", limitCents: 12_000 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lets a crafted userId escape the per-user directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-budget-trav-"));
    try {
      const provider = new FileBudgetStoreProvider(dir);
      await (await provider.forUser("../../etc/passwd")).save({
        currency: "USD",
        overallLimitCents: null,
        budgets: [{ category: "x", limitCents: 1 }],
      });
      // Path separators and dots are stripped, so nothing escapes the data dir…
      await expect(stat(join(dir, "..", "..", "etc", "passwd", "budgets.json"))).rejects.toThrow();
      // …the write lands under users/, sanitised to an alnum segment.
      expect((await stat(join(dir, "users", "etcpasswd", "budgets.json"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("budget routes — per-user isolation over HTTP", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function multiUserApp() {
    return createServer({
      authConfig: { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 },
      authPersistence: "memory",
      stores: new InMemoryStatementImportStoreProvider(),
      budgetStores: new InMemoryBudgetStoreProvider(),
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

  it("scopes budgets to the authenticated principal — no cross-user read", async () => {
    const app = await multiUserApp();
    const alice = await register(app, "alice@example.com"); // first registrant → admin
    const bob = await register(app, "bob@example.com");

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: auth(alice),
      payload: {
        currency: "USD",
        overallLimitCents: 500_000,
        budgets: [{ category: "groceries", limitCents: 40_000 }],
      },
    });
    expect(saved.statusCode).toBe(200);

    // Bob sees only his own (empty) set, never Alice's.
    const bobGet = await app.inject({ method: "GET", url: "/api/v1/budgets", headers: auth(bob) });
    expect(JSON.parse(bobGet.body)).toEqual({ currency: "USD", overallLimitCents: null, overallWeeklyLimitCents: null, budgets: [] });

    // Alice still sees hers — isolation, not deletion.
    const aliceGet = await app.inject({ method: "GET", url: "/api/v1/budgets", headers: auth(alice) });
    expect(JSON.parse(aliceGet.body).budgets).toEqual([{ category: "groceries", limitCents: 40_000 }]);

    await app.close();
  });
});

function importPayload() {
  const rows = [
    "date,description,amount",
    "2022-07-05,WHOLE FOODS MKT 102,120.00",
    "2022-07-12,WHOLE FOODS MKT 102,80.00",
    "2022-07-08,STARBUCKS STORE 214,25.00",
    "2022-07-20,SHELL OIL 5567,60.00",
    "2022-07-01,ACME PAYROLL DIRECT DEP,-3200.00",
  ];
  return {
    requestId: "budget_routes_fixture",
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
