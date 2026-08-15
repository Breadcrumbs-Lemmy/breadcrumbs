/**
 * `buildCashFlowCalendar` lays the snapshot's income and obligations on a forward
 * timeline and draws a running balance through them. These tests drive it through
 * its real export with hand-built `IncomeSource`/`RecurringObligation`/`Account`
 * fixtures, so the contract under test is production's.
 *
 * All dates are 2022/2023, never 2026 (`CD-012`): the projection walks a real
 * calendar via `expandCadence`, so month-length and year boundaries — a monthly
 * bill on the 31st clamping to Nov 30, a biweekly paycheck straddling a month
 * end — must be exercised on real months, not the app's forgiving 2026 fixtures.
 *
 * The load-bearing rules under test: the anchor is the passed `asOfDate` never the
 * clock (`D-C4`); the balance uses expected figures so the list and the balance
 * agree (`D-C5`); same-day outflows precede inflows so the intraday low is
 * conservative (`D-C6`/`D-C7`); the schedule survives an unknown balance (`D-C8`).
 */
import { describe, expect, it } from "vitest";

import { buildCashFlowCalendar } from "../src";
import type {
  Account,
  BuildCashFlowCalendarOptions,
  Cadence,
  IncomeSource,
  RecurringObligation,
} from "../src";

const ASOF = "2022-09-15";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acc_checking",
    displayName: "Checking",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 200_000,
    includeInForecast: true,
    freshness: { status: "fresh", source: "csv", warnings: [] },
    source: "csv",
    ...over,
  };
}

function income(
  over: Partial<IncomeSource> & Pick<IncomeSource, "id" | "nextExpectedDate" | "cadence">,
): IncomeSource {
  return {
    label: "Employer",
    expectedAmountCents: 300_000,
    minimumExpectedAmountCents: 280_000,
    variability: "fixed",
    reliability: "expected",
    category: "other",
    active: true,
    freshness: { status: "usable", source: "inferred", warnings: [] },
    uncertainty: { confidence: 0.9, isEstimated: true },
    source: "inferred",
    currency: "USD",
    ...over,
  };
}

function obligation(
  over: Partial<RecurringObligation> & Pick<RecurringObligation, "id" | "nextDueDate" | "cadence">,
): RecurringObligation {
  return {
    label: "Rent",
    amountCents: 150_000,
    category: "housing",
    required: true,
    importance: "required",
    autopay: false,
    active: true,
    freshness: { status: "usable", source: "inferred", warnings: [] },
    uncertainty: { confidence: 0.9, isEstimated: true },
    source: "inferred",
    currency: "USD",
    ...over,
  };
}

function build(over: Partial<BuildCashFlowCalendarOptions> = {}) {
  return buildCashFlowCalendar({
    incomeSources: [],
    recurringObligations: [],
    accounts: [account()],
    asOfDate: ASOF,
    currency: "USD",
    ...over,
  });
}

const monthly = (dayOfMonth: number): Cadence => ({ kind: "monthly", dayOfMonth });
const biweekly = (anchorDate: string): Cadence => ({ kind: "biweekly", anchorDate });

describe("buildCashFlowCalendar — horizon window", () => {
  it("anchors the horizon to asOfDate, not the wall clock (D-C4)", () => {
    const calendar = build({ horizonDays: 30 });
    expect(calendar.asOfDate).toBe(ASOF);
    expect(calendar.horizonStartDate).toBe("2022-09-16"); // asOf + 1
    expect(calendar.horizonEndDate).toBe("2022-10-15"); // asOf + 30
    expect(calendar.horizonDays).toBe(30);
  });

  it("defaults the horizon to 45 days (D-C3)", () => {
    const calendar = build();
    expect(calendar.horizonDays).toBe(45);
    expect(calendar.horizonEndDate).toBe("2022-10-30");
  });

  it("clamps an out-of-range horizon into [7, 60]", () => {
    expect(build({ horizonDays: 0 }).horizonDays).toBe(7);
    expect(build({ horizonDays: 999 }).horizonDays).toBe(60);
    expect(build({ horizonDays: -5 }).horizonDays).toBe(7);
  });
});

describe("buildCashFlowCalendar — event projection", () => {
  it("projects a monthly bill forward, clamping day 31 to the month length (CD-012)", () => {
    const calendar = build({
      accounts: [account()],
      recurringObligations: [obligation({ id: "ob_card", nextDueDate: "2022-10-31", cadence: monthly(31) })],
      asOfDate: "2022-10-15",
      horizonDays: 60, // reaches into December
    });
    const dates = calendar.events.map((event) => event.date);
    expect(dates).toContain("2022-10-31");
    expect(dates).toContain("2022-11-30"); // clamped from the 31st, never "2022-11-31"
    expect(dates).not.toContain("2022-11-31");
    expect(dates.every((date) => date <= calendar.horizonEndDate)).toBe(true);
  });

  it("projects biweekly income across a month boundary", () => {
    const calendar = build({
      incomeSources: [income({ id: "inc_pay", nextExpectedDate: "2022-09-23", cadence: biweekly("2022-09-23") })],
    });
    expect(calendar.events.map((event) => event.date)).toEqual([
      "2022-09-23",
      "2022-10-07",
      "2022-10-21",
    ]);
    expect(calendar.events.every((event) => event.kind === "income")).toBe(true);
    expect(calendar.events.every((event) => event.amountCents === 300_000)).toBe(true);
  });

  it("includes an annual charge inside the horizon and omits one outside it", () => {
    const inside = build({
      recurringObligations: [
        obligation({ id: "ob_ins", label: "Insurance", nextDueDate: "2022-10-20", cadence: { kind: "annual", month: 10, dayOfMonth: 20 } }),
      ],
    });
    expect(inside.events.map((event) => event.date)).toEqual(["2022-10-20"]);

    const outside = build({
      recurringObligations: [
        obligation({ id: "ob_ins", label: "Insurance", nextDueDate: "2022-12-20", cadence: { kind: "annual", month: 12, dayOfMonth: 20 } }),
      ],
    });
    expect(outside.events).toHaveLength(0);
  });

  it("gives each occurrence a unique, date-stamped id", () => {
    const calendar = build({
      recurringObligations: [obligation({ id: "ob_rent", nextDueDate: "2022-09-30", cadence: monthly(30) })],
    });
    expect(calendar.events[0]!.id).toBe("ob_rent@2022-09-30");
    expect(calendar.events.map((event) => event.date)).toEqual(["2022-09-30", "2022-10-30"]);
    expect(new Set(calendar.events.map((event) => event.id)).size).toBe(calendar.events.length);
  });

  it("collapses duplicate-id occurrences so a bill seen from N accounts is counted once (D-C13)", () => {
    // The subscription detector groups per (merchant, account), so one merchant
    // billed from three imported accounts reaches the snapshot as three
    // obligations sharing a merchant-derived id. That is one recurring bill, not
    // three: the calendar must count it once, apply it to the balance once, and
    // never emit two events with the same React key.
    const gym = (over: Partial<RecurringObligation> = {}): RecurringObligation =>
      obligation({
        id: "obligation_inferred_touchstone",
        label: "Touchstone Climbing",
        amountCents: 7_850,
        required: false,
        importance: "optional",
        nextDueDate: "2022-09-20",
        cadence: monthly(20),
        ...over,
      });
    const calendar = build({
      accounts: [account({ currentBalanceCents: 100_000 })],
      recurringObligations: [gym({ accountId: "a" }), gym({ accountId: "b" }), gym({ accountId: "c" })],
      horizonDays: 20,
    });

    // One event per occurrence date, not three.
    expect(calendar.events.map((event) => event.id)).toEqual(["obligation_inferred_touchstone@2022-09-20"]);
    expect(new Set(calendar.events.map((event) => event.id)).size).toBe(calendar.events.length);
    // The bill lands once in the totals and once against the balance.
    expect(calendar.totals.outflowCents).toBe(7_850);
    expect(calendar.totals.obligationEventCount).toBe(1);
    expect(calendar.events[0]!.balanceAfterCents).toBe(100_000 - 7_850);
  });

  it("excludes inactive entities and other-currency entities", () => {
    const calendar = build({
      currency: "USD",
      incomeSources: [income({ id: "inc_off", nextExpectedDate: "2022-09-20", cadence: { kind: "once" }, active: false })],
      recurringObligations: [
        obligation({ id: "ob_usd", nextDueDate: "2022-09-20", cadence: { kind: "once" } }),
        obligation({ id: "ob_eur", nextDueDate: "2022-09-20", cadence: { kind: "once" }, currency: "EUR" }),
      ],
    });
    expect(calendar.events.map((event) => event.sourceEntityId)).toEqual(["ob_usd"]);
    expect(calendar.notes.obligationCount).toBe(1);
    expect(calendar.notes.incomeSourceCount).toBe(0);
  });
});

describe("buildCashFlowCalendar — totals", () => {
  it("sums inflows and outflows independently and nets them", () => {
    const calendar = build({
      incomeSources: [income({ id: "inc_pay", nextExpectedDate: "2022-09-30", cadence: { kind: "once" } })],
      recurringObligations: [obligation({ id: "ob_rent", amountCents: 150_000, nextDueDate: "2022-09-20", cadence: { kind: "once" } })],
    });
    expect(calendar.totals).toMatchObject({
      inflowCents: 300_000,
      outflowCents: 150_000,
      netCents: 150_000,
      incomeEventCount: 1,
      obligationEventCount: 1,
    });
  });
});

describe("buildCashFlowCalendar — running balance and the pre-payday low", () => {
  it("counts a same-day outflow before the inflow, so the intraday low is conservative (D-C6/D-C7)", () => {
    const calendar = build({
      accounts: [account({ currentBalanceCents: 200_000 })],
      incomeSources: [income({ id: "inc_pay", expectedAmountCents: 300_000, nextExpectedDate: "2022-09-30", cadence: { kind: "once" } })],
      recurringObligations: [obligation({ id: "ob_rent", amountCents: 150_000, nextDueDate: "2022-09-30", cadence: { kind: "once" } })],
    });
    // Same day: rent (−150k) is applied first → dips to 50k, then pay (+300k) → 350k.
    expect(calendar.events.map((event) => [event.kind, event.balanceAfterCents])).toEqual([
      ["obligation", 50_000],
      ["income", 350_000],
    ]);
    expect(calendar.lowestBalance).toEqual({ balanceCents: 50_000, date: "2022-09-30" });
    // End-of-day balance nets both to 350k.
    expect(calendar.dailyBalances.at(-1)).toEqual({ date: "2022-10-30", balanceCents: 350_000 });
  });

  it("treats the opening balance as the low when every event is an inflow", () => {
    const calendar = build({
      accounts: [account({ currentBalanceCents: 120_000 })],
      incomeSources: [income({ id: "inc_pay", nextExpectedDate: "2022-09-20", cadence: { kind: "once" } })],
    });
    expect(calendar.lowestBalance).toEqual({ balanceCents: 120_000, date: "2022-09-16" });
  });

  it("sums opening spendable cash across included cash accounts using min(current, available) (D-C9)", () => {
    const calendar = build({
      accounts: [
        account({ id: "a", role: "spendable_cash", currentBalanceCents: 200_000, availableBalanceCents: 180_000 }),
        account({ id: "b", role: "reserve_cash", currentBalanceCents: 50_000 }),
        account({ id: "c", role: "liability", currentBalanceCents: 999_999 }), // excluded by role
        account({ id: "d", role: "spendable_cash", includeInForecast: false, currentBalanceCents: 999_999 }), // excluded
      ],
    });
    expect(calendar.openingBalanceCents).toBe(180_000 + 50_000);
  });

  it("produces one daily balance per horizon day", () => {
    const calendar = build({ horizonDays: 10 });
    expect(calendar.dailyBalances).toHaveLength(10);
    expect(calendar.dailyBalances[0]!.date).toBe("2022-09-16");
    expect(calendar.dailyBalances.at(-1)!.date).toBe("2022-09-25");
  });
});

describe("buildCashFlowCalendar — unknown balance keeps the schedule (D-C8)", () => {
  it("returns events but no projection when no cash account has a known balance", () => {
    const calendar = build({
      accounts: [account({ displayName: "Checking", freshness: { status: "missing", source: "manual", warnings: [] } })],
      recurringObligations: [obligation({ id: "ob_rent", nextDueDate: "2022-09-30", cadence: monthly(30) })],
    });
    expect(calendar.events.length).toBeGreaterThan(0);
    expect(calendar.events.every((event) => event.balanceAfterCents === null)).toBe(true);
    expect(calendar.openingBalanceCents).toBeNull();
    expect(calendar.dailyBalances).toEqual([]);
    expect(calendar.lowestBalance).toBeNull();
    expect(calendar.outlook.status).toBe("unknown");
    expect(calendar.notes.balanceKnown).toBe(false);
    expect(calendar.notes.accountsMissingBalance).toEqual(["Checking"]);
  });
});

describe("buildCashFlowCalendar — outlook status (D-C11)", () => {
  const openingWithRent = (currentBalanceCents: number, rentCents: number) =>
    build({
      accounts: [account({ currentBalanceCents })],
      recurringObligations: [obligation({ id: "ob_rent", amountCents: rentCents, nextDueDate: "2022-09-20", cadence: { kind: "once" } })],
      config: { minimumCashBufferCents: 25_000 },
    });

  it("is clear when the low stays at or above the buffer", () => {
    expect(openingWithRent(200_000, 100_000).outlook.status).toBe("clear");
  });

  it("is tight when the low dips below the buffer but stays positive", () => {
    expect(openingWithRent(120_000, 100_000).outlook.status).toBe("tight");
  });

  it("is shortfall when the low goes negative", () => {
    const calendar = openingWithRent(80_000, 100_000);
    expect(calendar.outlook.status).toBe("shortfall");
    expect(calendar.lowestBalance!.balanceCents).toBe(-20_000);
  });
});

describe("buildCashFlowCalendar — next reliable income", () => {
  it("picks the first income at/above the reliability threshold and skips uncertain or low-confidence ones", () => {
    const calendar = build({
      incomeSources: [
        income({ id: "inc_gig", label: "Gig", nextExpectedDate: "2022-09-18", cadence: { kind: "once" }, reliability: "uncertain", uncertainty: { confidence: 0.6, isEstimated: true } }),
        income({ id: "inc_lowconf", label: "Side", nextExpectedDate: "2022-09-22", cadence: { kind: "once" }, reliability: "expected", uncertainty: { confidence: 0.75, isEstimated: true } }),
        income({ id: "inc_pay", label: "Payroll", nextExpectedDate: "2022-09-30", cadence: { kind: "once" }, reliability: "expected", uncertainty: { confidence: 0.9, isEstimated: true } }),
      ],
      config: { reliableIncomeConfidence: 0.8 },
    });
    expect(calendar.nextReliableIncomeDate).toBe("2022-09-30");
  });

  it("omits nextReliableIncomeDate entirely when no income is reliable enough", () => {
    const calendar = build({
      incomeSources: [income({ id: "inc_gig", nextExpectedDate: "2022-09-18", cadence: { kind: "once" }, reliability: "uncertain", uncertainty: { confidence: 0.6, isEstimated: true } })],
    });
    expect("nextReliableIncomeDate" in calendar).toBe(false);
  });
});

describe("buildCashFlowCalendar — event status and metadata", () => {
  it("labels income status by reliability and carries variability + confidence", () => {
    const calendar = build({
      incomeSources: [income({ id: "inc_pay", nextExpectedDate: "2022-09-20", cadence: { kind: "once" }, reliability: "expected", variability: "variable", uncertainty: { confidence: 0.75, isEstimated: true } })],
    });
    expect(calendar.events[0]).toMatchObject({
      kind: "income",
      status: "expected",
      variability: "variable",
      confidence: 0.75,
      required: false,
    });
  });

  it("marks inferred obligations estimated and preserves the required flag", () => {
    const calendar = build({
      recurringObligations: [
        obligation({ id: "ob_rent", nextDueDate: "2022-09-20", cadence: { kind: "once" }, required: true, source: "inferred" }),
        obligation({ id: "ob_netflix", label: "Netflix", nextDueDate: "2022-09-21", cadence: { kind: "once" }, required: false, importance: "optional", source: "inferred" }),
      ],
    });
    expect(calendar.events.map((event) => [event.sourceEntityId, event.status, event.required, event.amountCents < 0])).toEqual([
      ["ob_rent", "estimated", true, true],
      ["ob_netflix", "estimated", false, true],
    ]);
  });
});

describe("buildCashFlowCalendar — empty and deterministic", () => {
  it("returns a valid empty calendar when nothing recurs", () => {
    const calendar = build({ horizonDays: 20 });
    expect(calendar.events).toEqual([]);
    expect(calendar.totals).toMatchObject({ inflowCents: 0, outflowCents: 0, netCents: 0 });
    expect(calendar.dailyBalances).toHaveLength(20);
    expect(calendar.outlook.status).toBe("clear"); // opening 200k ≥ buffer, no events
  });

  it("is deterministic — identical inputs give a deep-equal result", () => {
    const options: Partial<BuildCashFlowCalendarOptions> = {
      incomeSources: [income({ id: "inc_pay", nextExpectedDate: "2022-09-30", cadence: biweekly("2022-09-30") })],
      recurringObligations: [obligation({ id: "ob_rent", nextDueDate: "2022-09-20", cadence: monthly(20) })],
    };
    expect(build(options)).toEqual(build(options));
  });
});
