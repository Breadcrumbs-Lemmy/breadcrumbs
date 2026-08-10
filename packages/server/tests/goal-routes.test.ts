/**
 * End-to-end cover for the savings-goal endpoints, the per-user goal store, and
 * the snapshot wiring that makes the affordability engine's goal handling run on
 * real input (`D-G7`).
 *
 * A goal is a *declaration*, never inferred (`D-G2`): the reduced input the user
 * POSTs is shaped into a canonical `Goal` by core `buildSavingsGoals`, and pace
 * is measured from the same data-derived "now" every other endpoint uses — the
 * latest transaction date. The fixture's latest transaction is 2022-07-20, so
 * pace anchors to the 1st of the next month, 2022-08-01. Dates are 2022, never
 * 2026, so the month arithmetic runs on a real calendar (`CD-012`).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSavingsGoal } from "@ai-fin-os/core";
import type { Goal } from "@ai-fin-os/core";
import { createServer } from "../src";
import { InMemoryStatementImportStore } from "../src/local/store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";
import { FieldCipher } from "../src/crypto/field-cipher";
import { FileGoalStore, InMemoryGoalStore, normalizeState } from "../src/local/goal-store";
import type { GoalState } from "../src/local/goal-store";
import {
  FileGoalStoreProvider,
  InMemoryGoalStoreProvider,
} from "../src/local/goal-store-provider";

const ACCOUNT_ID = "account_local_checking";
/** The fixture's latest transaction date → the "now" pace is measured from. */
const ASOF = "2022-07-20";
/** The 1st of the month after `ASOF` — a monthly-on-the-1st goal's next payment. */
const NEXT_CONTRIBUTION = "2022-08-01";
const BUILD_OPTS = { asOfDate: ASOF, currency: "USD" };

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

/** A valid canonical goal built through core, for the store-level tests that need
 *  to save real `Goal` shapes (not the reduced route input). */
function sampleGoal(overrides: Partial<Parameters<typeof buildSavingsGoal>[0]> = {}): Goal {
  return buildSavingsGoal(
    { label: "Emergency fund", targetAmountCents: 100_000, currentAmountCents: 40_000, monthlyContributionCents: 20_000, ...overrides },
    BUILD_OPTS,
  );
}

describe("goal routes", () => {
  it("returns an empty, default goal set before anything is configured", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/goals" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ currency: "USD", goals: [] });
    await app.close();
  });

  it("shapes reduced input into canonical goals and returns them sorted by id", async () => {
    const app = await serverWithSpending();

    const save = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: {
        currency: "USD",
        // Deliberately out of id order to prove the store sorts deterministically.
        goals: [
          { label: "Vacation", targetAmountCents: 300_000, monthlyContributionCents: 50_000 },
          { label: "Emergency fund", targetAmountCents: 100_000, currentAmountCents: 40_000, monthlyContributionCents: 20_000 },
        ],
      },
    });
    expect(save.statusCode).toBe(200);
    const saved = JSON.parse(save.body);
    expect(saved.goals.map((g: { id: string }) => g.id)).toEqual(["goal_emergency-fund", "goal_vacation"]);

    // The reduced input became a full canonical Goal, filled deterministically.
    expect(saved.goals[0]).toMatchObject({
      id: "goal_emergency-fund",
      label: "Emergency fund",
      goalType: "monthly_savings_target",
      targetAmountCents: 100_000,
      currentAmountCents: 40_000,
      monthlyContributionCents: 20_000,
      nextContributionDate: NEXT_CONTRIBUTION,
      contributionCadence: { kind: "monthly", dayOfMonth: 1 },
      priority: "medium",
      protection: "flexible",
      active: true,
      source: "manual",
      currency: "USD",
    });
    // A user-set goal is full-confidence and never estimated.
    expect(saved.goals[0].uncertainty).toMatchObject({ confidence: 1, isEstimated: false });
    expect(saved.goals[0].freshness).toMatchObject({ status: "usable", asOf: ASOF, source: "manual" });

    // A fresh GET sees exactly what was saved.
    const get = await app.inject({ method: "GET", url: "/api/v1/goals" });
    expect(JSON.parse(get.body)).toEqual(saved);
    await app.close();
  });

  it("honours explicit priority, protection, deadline and category", async () => {
    const app = await serverWithSpending();
    const save = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: {
        goals: [
          {
            label: "House down payment",
            targetAmountCents: 5_000_000,
            currentAmountCents: 1_000_000,
            monthlyContributionCents: 200_000,
            targetDate: "2024-01-01",
            priority: "high",
            protection: "protected",
            category: "housing",
          },
        ],
      },
    });
    expect(save.statusCode).toBe(200);
    expect(JSON.parse(save.body).goals[0]).toMatchObject({
      priority: "high",
      protection: "protected",
      targetDate: "2024-01-01",
      category: "housing",
    });
    await app.close();
  });

  it("suffixes ids when two goals slug to the same id, never dropping one", async () => {
    const app = await serverWithSpending();
    const save = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: {
        goals: [
          { label: "Emergency fund", targetAmountCents: 100_000 },
          { label: "Emergency fund", targetAmountCents: 50_000 },
        ],
      },
    });
    expect(save.statusCode).toBe(200);
    expect(JSON.parse(save.body).goals.map((g: { id: string }) => g.id)).toEqual([
      "goal_emergency-fund",
      "goal_emergency-fund_2",
    ]);
    await app.close();
  });

  it("rejects the PUT verb so the whole-set write stays on POST (CORS allowlist)", async () => {
    // The server's CORS allowlist advertises GET,POST,PATCH,DELETE — no PUT. A
    // PUT route passes inject-tests but fails a real browser preflight, so the
    // write is POST and PUT must not resolve at all. Guards the H-082 regression.
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/goals",
      payload: { currency: "USD", goals: [] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects an unknown top-level field (strict schema)", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { goals: [], surpriseField: true },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    await app.close();
  });

  it("rejects an unknown per-goal field (strict schema)", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { goals: [{ label: "x", targetAmountCents: 1_000, sneaky: 1 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    await app.close();
  });

  it("rejects a target above the sanity ceiling", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { goals: [{ label: "x", targetAmountCents: 1_000_000_001 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    await app.close();
  });

  it("rejects a non-integer or negative amount", async () => {
    const app = await serverWithSpending();
    for (const targetAmountCents of [12.5, -100]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/goals",
        payload: { goals: [{ label: "x", targetAmountCents }] },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    }
    await app.close();
  });

  it("rejects an empty label and a malformed targetDate", async () => {
    const app = await serverWithSpending();
    for (const goal of [
      { label: "", targetAmountCents: 1_000 },
      { label: "x", targetAmountCents: 1_000, targetDate: "2022-7-1" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/goals", payload: { goals: [goal] } });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    }
    await app.close();
  });

  it("rejects more than 100 goals in one save", async () => {
    const app = await serverWithSpending();
    const goals = Array.from({ length: 101 }, (_, i) => ({ label: `goal ${i}`, targetAmountCents: 1_000 }));
    const response = await app.inject({ method: "POST", url: "/api/v1/goals", payload: { goals } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS");
    await app.close();
  });

  it("accepts an empty body and returns the default set", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "POST", url: "/api/v1/goals", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ currency: "USD", goals: [] });
    await app.close();
  });

  it("computes progress, status and pace against the stored goals at the data-derived asOf", async () => {
    const app = await serverWithSpending();
    await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: {
        goals: [
          // Funded, no deadline → on_track. 60k left ÷ 20k = 3 payments, last lands 2022-10-01.
          { label: "Emergency fund", targetAmountCents: 100_000, currentAmountCents: 40_000, monthlyContributionCents: 20_000 },
          // Over-saved → reached, bar capped, no projection.
          { label: "New laptop", targetAmountCents: 50_000, currentAmountCents: 60_000 },
          // Funded but the deadline is before the projected completion → behind.
          { label: "Car", targetAmountCents: 100_000, currentAmountCents: 0, monthlyContributionCents: 20_000, targetDate: "2022-09-01" },
        ],
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/goals/progress?currency=USD" });
    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.body);

    expect(progress.asOfDate).toBe(ASOF);
    expect(progress.currency).toBe("USD");
    // Worst-first: behind (Car, 0%), then on_track (Emergency, 40%), then reached (Laptop).
    expect(progress.goals.map((g: { id: string }) => g.id)).toEqual([
      "goal_car",
      "goal_emergency-fund",
      "goal_new-laptop",
    ]);
    expect(progress).toMatchObject({ behindCount: 1, onTrackCount: 1, reachedCount: 1 });
    expect(progress.totalTargetCents).toBe(250_000);
    expect(progress.totalSavedCents).toBe(100_000); // 40k + 60k + 0
    expect(progress.totalRemainingCents).toBe(160_000); // 60k + 0 + 100k

    const [car, emergency, laptop] = progress.goals;
    expect(car.status).toBe("behind");
    expect(car.projection).toMatchObject({ monthsToClose: 5, projectedCompletionDate: "2022-12-01", onPace: false });

    expect(emergency.status).toBe("on_track");
    expect(emergency.progressBasisPoints).toBe(4_000);
    expect(emergency.projection).toMatchObject({ monthsToClose: 3, projectedCompletionDate: "2022-10-01", onPace: true });

    expect(laptop.status).toBe("reached");
    expect(laptop.progressBasisPoints).toBe(10_000);
    expect(laptop.projection).toBeUndefined();
    await app.close();
  });

  it("reports an empty, zeroed rollup before any goal is configured", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/goals/progress?currency=USD" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      asOfDate: ASOF,
      currency: "USD",
      goals: [],
      totalTargetCents: 0,
      totalSavedCents: 0,
      totalRemainingCents: 0,
      reachedCount: 0,
      onTrackCount: 0,
      behindCount: 0,
    });
    await app.close();
  });

  it("rejects a malformed progress currency", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/goals/progress?currency=US" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_GOALS_PROGRESS_QUERY");
    await app.close();
  });
});

describe("goal snapshot injection (D-G7)", () => {
  it("carries no goals in the snapshot until the user declares some", async () => {
    const app = await serverWithSpending();
    const response = await app.inject({ method: "GET", url: "/api/v1/affordability/snapshot?currency=USD" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).snapshot.goals).toEqual([]);
    await app.close();
  });

  it("injects the user's declared goals into the affordability snapshot", async () => {
    const app = await serverWithSpending();
    await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: {
        goals: [
          {
            label: "Emergency fund",
            targetAmountCents: 100_000,
            currentAmountCents: 40_000,
            monthlyContributionCents: 20_000,
            priority: "high",
            protection: "protected",
          },
        ],
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/affordability/snapshot?currency=USD" });
    expect(response.statusCode).toBe(200);
    const { snapshot } = JSON.parse(response.body);
    // The engine's goal handling now runs on real input, not the dead `goals: []`.
    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]).toMatchObject({
      id: "goal_emergency-fund",
      goalType: "monthly_savings_target",
      monthlyContributionCents: 20_000,
      priority: "high",
      protection: "protected",
      currency: "USD",
    });
    await app.close();
  });

  it("excludes a goal in another currency from the snapshot (single-currency verdict)", async () => {
    // The snapshot is asked in one currency; the engine blocks on any mixed
    // currency, so a goal saved in another currency is out of scope, not a 500.
    const app = await serverWithSpending();
    await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { currency: "EUR", goals: [{ label: "Trip", targetAmountCents: 100_000, monthlyContributionCents: 10_000 }] },
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/affordability/snapshot?currency=USD" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).snapshot.goals).toEqual([]);
    await app.close();
  });
});

describe("FileGoalStore encryption at rest", () => {
  let dir: string;
  let filePath: string;
  const cipher = new FieldCipher(randomBytes(32));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bc-goal-"));
    filePath = join(dir, "goals.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes ciphertext to disk but reads back the real goals", async () => {
    const store = new FileGoalStore(filePath, cipher);
    await store.save({ currency: "USD", goals: [sampleGoal({ label: "Wedding fund" })] });

    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk).toContain("bcenc1:");
    // The label — a hint at the user's private plans — must not be legible.
    expect(onDisk).not.toContain("Wedding");

    const reloaded = await new FileGoalStore(filePath, cipher).load();
    expect(reloaded.goals).toHaveLength(1);
    expect(reloaded.goals[0].label).toBe("Wedding fund");

    // 0600 — never world-readable.
    expect((await stat(filePath)).mode & 0o077).toBe(0);
  });

  it("cannot read a file written under a different key", async () => {
    await new FileGoalStore(filePath, cipher).save({ currency: "USD", goals: [sampleGoal()] });
    const wrongKey = new FileGoalStore(filePath, new FieldCipher(randomBytes(32)));
    await expect(wrongKey.load()).rejects.toThrow();
  });

  it("refuses to read an encrypted file with no key rather than returning empty", async () => {
    await new FileGoalStore(filePath, cipher).save({ currency: "USD", goals: [sampleGoal()] });
    await expect(new FileGoalStore(filePath).load()).rejects.toThrow(/encrypted/i);
  });
});

describe("FileGoalStore persistence & migration", () => {
  it("returns an empty default for a missing file and does not create one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-missing-"));
    try {
      const filePath = join(dir, "goals.json");
      const store = new FileGoalStore(filePath);
      expect(await store.load()).toEqual({ currency: "USD", goals: [] });
      // A read must never materialise the file — that's a write's job.
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serialises concurrent saves so the last-enqueued write wins intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-queue-"));
    try {
      const store = new FileGoalStore(join(dir, "goals.json"));
      // Fire 20 saves without awaiting between them: the write queue must run
      // them in order, atomically, so the file is never a torn interleave.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.save({ currency: "USD", goals: [sampleGoal({ id: `goal_${i}`, label: `Goal ${i}`, targetAmountCents: (i + 1) * 1_000 })] }),
        ),
      );
      // Deterministic: the queue is a strict in-order chain, so #19 persists last.
      const reloaded = await store.load();
      expect(reloaded.goals).toHaveLength(1);
      expect(reloaded.goals[0].id).toBe("goal_19");
      expect(reloaded.goals[0].targetAmountCents).toBe(20_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a legacy plaintext file and re-seals it encrypted on the next save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-migrate-"));
    try {
      const filePath = join(dir, "goals.json");
      // A pre-encryption install: a bare plaintext state on disk.
      await new FileGoalStore(filePath).save({ currency: "USD", goals: [sampleGoal({ label: "Retirement" })] });
      expect(await readFile(filePath, "utf8")).toContain("Retirement"); // legible

      // A cipher is now configured. The legacy file is still readable…
      const cipher = new FieldCipher(randomBytes(32));
      const store = new FileGoalStore(filePath, cipher);
      expect((await store.load()).goals[0].label).toBe("Retirement");

      // …and the next save re-seals it: ciphertext on disk, intent no longer legible.
      await store.save({ currency: "USD", goals: [sampleGoal({ label: "Retirement", targetAmountCents: 200_000 })] });
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).toContain("bcenc1:");
      expect(onDisk).not.toContain("Retirement");
      expect((await new FileGoalStore(filePath, cipher).load()).goals[0].targetAmountCents).toBe(200_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("goal store normalization", () => {
  it("drops malformed goals, collapses duplicate ids, and sorts by id", () => {
    const gA = sampleGoal({ id: "goal_a", label: "A", targetAmountCents: 1_000 });
    const gB = sampleGoal({ id: "goal_b", label: "B", targetAmountCents: 2_000 });
    const state = normalizeState({
      currency: "usd",
      goals: [
        gB,
        gA,
        { nonsense: true } as unknown as Goal, // fails GoalSchema → dropped
        { ...gA }, // duplicate id → dropped
      ],
    });
    expect(state.currency).toBe("USD");
    expect(state.goals.map((g) => g.id)).toEqual(["goal_a", "goal_b"]);
  });

  it("degrades a missing or null file to the empty default rather than throwing", () => {
    expect(normalizeState(null)).toEqual({ currency: "USD", goals: [] });
    expect(normalizeState(undefined)).toEqual({ currency: "USD", goals: [] });
    expect(normalizeState({ currency: "gb" } as Partial<GoalState>).currency).toBe("USD"); // bad length → default
  });
});

describe("goal store isolation & erase", () => {
  it("gives each user their own in-memory store", async () => {
    const provider = new InMemoryGoalStoreProvider();
    const alice = await provider.forUser("usr_alice");
    const bob = await provider.forUser("usr_bob");
    await alice.save({ currency: "USD", goals: [sampleGoal()] });

    expect((await bob.load()).goals).toEqual([]);
    expect((await alice.load()).goals).toHaveLength(1);

    await provider.eraseForUser("usr_alice");
    // A fresh store for the same id is empty again.
    const aliceAgain = await provider.forUser("usr_alice");
    expect((await aliceAgain.load()).goals).toEqual([]);
  });

  it("removes a user's goals file on erase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-iso-"));
    try {
      const provider = new FileGoalStoreProvider(dir);
      const store = await provider.forUser("usr_alice");
      await store.save({ currency: "USD", goals: [sampleGoal()] });
      const filePath = join(dir, "users", "usr_alice", "goals.json");
      expect((await stat(filePath)).isFile()).toBe(true);

      await provider.eraseForUser("usr_alice");
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps each user's file separate and reloads it after a provider restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-two-"));
    try {
      const first = new FileGoalStoreProvider(dir);
      await (await first.forUser("usr_alice")).save({ currency: "USD", goals: [sampleGoal({ id: "goal_alice" })] });
      await (await first.forUser("usr_bob")).save({ currency: "USD", goals: [sampleGoal({ id: "goal_bob" })] });

      // A brand-new provider with an empty cache (a process restart) reads each
      // user's file straight back — isolation survives persistence, not just cache.
      const restarted = new FileGoalStoreProvider(dir);
      expect((await (await restarted.forUser("usr_alice")).load()).goals.map((g) => g.id)).toEqual(["goal_alice"]);
      expect((await (await restarted.forUser("usr_bob")).load()).goals.map((g) => g.id)).toEqual(["goal_bob"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lets a crafted userId escape the per-user directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-goal-trav-"));
    try {
      const provider = new FileGoalStoreProvider(dir);
      await (await provider.forUser("../../etc/passwd")).save({ currency: "USD", goals: [sampleGoal()] });
      // Path separators and dots are stripped, so nothing escapes the data dir…
      await expect(stat(join(dir, "..", "..", "etc", "passwd", "goals.json"))).rejects.toThrow();
      // …the write lands under users/, sanitised to an alnum segment.
      expect((await stat(join(dir, "users", "etcpasswd", "goals.json"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("goal routes — per-user isolation over HTTP", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function multiUserApp() {
    return createServer({
      authConfig: { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 },
      authPersistence: "memory",
      stores: new InMemoryStatementImportStoreProvider(),
      goalStores: new InMemoryGoalStoreProvider(),
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

  it("scopes goals to the authenticated principal — no cross-user read", async () => {
    const app = await multiUserApp();
    const alice = await register(app, "alice@example.com"); // first registrant → admin
    const bob = await register(app, "bob@example.com");

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/goals",
      headers: auth(alice),
      payload: { goals: [{ label: "Emergency fund", targetAmountCents: 100_000, monthlyContributionCents: 20_000 }] },
    });
    expect(saved.statusCode).toBe(200);

    // Bob sees only his own (empty) set, never Alice's.
    const bobGet = await app.inject({ method: "GET", url: "/api/v1/goals", headers: auth(bob) });
    expect(JSON.parse(bobGet.body)).toEqual({ currency: "USD", goals: [] });

    // Alice still sees hers — isolation, not deletion.
    const aliceGet = await app.inject({ method: "GET", url: "/api/v1/goals", headers: auth(alice) });
    expect(JSON.parse(aliceGet.body).goals.map((g: { id: string }) => g.id)).toEqual(["goal_emergency-fund"]);

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
    requestId: "goal_routes_fixture",
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
