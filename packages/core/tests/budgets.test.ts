/**
 * `evaluateBudgets` is the guardrail on top of `summarizeSpending`. These tests
 * drive it through the *real* summary engine — build transactions, summarize a
 * month, then evaluate budgets against that summary — so the contract under test
 * is the one production uses, not a hand-built summary that could drift from it.
 *
 * All dates are 2022, never 2026: the app's own 2026 fixtures hide calendar bugs
 * behind a forgiving month (`CD-012`), and the pacing projection here divides by
 * real elapsed days, so the arithmetic must be exercised on a real calendar.
 *
 * The load-bearing rule is `D-B3`: **status is computed on money actually spent,
 * never on the projection.** A budget must never read "over" three days into a
 * month just because the pace is high — but it should still warn "on pace to
 * overspend". The partial-month test pins exactly that.
 */
import { describe, expect, it } from "vitest";

import { evaluateBudgets, summarizeSpending } from "../src";
import type { Account, Budget, Transaction } from "../src";

function account(over: Partial<Account> & Pick<Account, "id">): Account {
  return {
    displayName: over.id,
    institutionName: "Test Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 1_000_000,
    includeInForecast: true,
    freshness: { status: "fresh", asOf: "2022-01-01", source: "fixture", warnings: [] },
    source: "fixture",
    ...over,
  };
}

function tx(
  over: Partial<Transaction> &
    Pick<Transaction, "id" | "accountId" | "amountCents" | "category" | "flowType" | "postedDate">,
): Transaction {
  return {
    merchantName: "Merchant",
    normalizedMerchantId: "merchant",
    currency: "USD",
    freshness: { status: "fresh", asOf: over.postedDate, source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...over,
  };
}

const ACCT = account({ id: "acct_checking", displayName: "Everyday Checking" });

/** Nicer labels, so we can prove the display name flows through from the summary. */
const LABELS: Record<string, string> = {
  groceries: "Groceries",
  dining: "Dining out",
  shopping: "Shopping",
  transport: "Transport",
  entertainment: "Entertainment",
};
const label = (id: string) => LABELS[id] ?? id;

describe("evaluateBudgets — a complete month", () => {
  // July 2022, viewed in August: the month is closed, so nothing is projected
  // and every status is final.
  const transactions: Transaction[] = [
    tx({ id: "t1", accountId: ACCT.id, amountCents: -30_000, category: "groceries", flowType: "SPEND", postedDate: "2022-07-05" }),
    tx({ id: "t2", accountId: ACCT.id, amountCents: -18_000, category: "dining", flowType: "SPEND", postedDate: "2022-07-11" }),
    tx({ id: "t3", accountId: ACCT.id, amountCents: -25_000, category: "shopping", flowType: "SPEND", postedDate: "2022-07-19" }),
    // Transport nets negative: a small spend fully reversed by a larger refund.
    tx({ id: "t4", accountId: ACCT.id, amountCents: -2_000, category: "transport", flowType: "SPEND", postedDate: "2022-07-02" }),
    tx({ id: "t5", accountId: ACCT.id, amountCents: 5_000, category: "transport", flowType: "REFUND", postedDate: "2022-07-20" }),
  ];

  const summary = summarizeSpending({
    transactions,
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-08-15", // after July → complete period
    kind: "month",
    key: "2022-07",
    categoryLabel: label,
  });

  const budgets: Budget[] = [
    { category: "groceries", limitCents: 40_000 },
    { category: "dining", limitCents: 20_000 },
    { category: "shopping", limitCents: 20_000 },
    { category: "transport", limitCents: 10_000 },
    { category: "entertainment", limitCents: 5_000 }, // budgeted, but no spend
  ];

  const progress = evaluateBudgets({
    summary,
    budgets,
    overallLimitCents: 60_000,
    categoryLabel: label,
  });

  it("sanity-checks the summary it consumes", () => {
    expect(summary.period.partial).toBe(false);
    expect(summary.totalOutflowCents).toBe(70_000); // 30000+18000+25000-3000
  });

  it("classifies each category by actual spend against its limit", () => {
    const byCat = new Map(progress.lines.map((line) => [line.category, line]));

    expect(byCat.get("groceries")).toMatchObject({
      spentCents: 30_000,
      remainingCents: 10_000,
      overBudgetCents: 0,
      usedBasisPoints: 7_500,
      status: "under",
    });
    expect(byCat.get("dining")).toMatchObject({
      spentCents: 18_000,
      usedBasisPoints: 9_000,
      status: "near",
    });
    expect(byCat.get("shopping")).toMatchObject({
      spentCents: 25_000,
      remainingCents: -5_000,
      overBudgetCents: 5_000,
      usedBasisPoints: 12_500,
      status: "over",
    });
  });

  it("floors a refund-dominated category at 0% rather than a negative bar", () => {
    const transport = progress.lines.find((line) => line.category === "transport")!;
    expect(transport.spentCents).toBe(-3_000);
    expect(transport.usedBasisPoints).toBe(0);
    expect(transport.remainingCents).toBe(13_000);
    expect(transport.overBudgetCents).toBe(0);
    expect(transport.status).toBe("under");
  });

  it("includes a budgeted category with no spend, labelled via the fallback", () => {
    const entertainment = progress.lines.find((line) => line.category === "entertainment")!;
    expect(entertainment.spentCents).toBe(0);
    expect(entertainment.transactionCount).toBe(0);
    expect(entertainment.remainingCents).toBe(5_000);
    expect(entertainment.status).toBe("under");
    // No summary total exists for it, so the display name comes from the labeller.
    expect(entertainment.displayName).toBe("Entertainment");
  });

  it("carries the display name through from the summary", () => {
    const dining = progress.lines.find((line) => line.category === "dining")!;
    expect(dining.displayName).toBe("Dining out");
  });

  it("orders lines worst-first (over, then near, then under)", () => {
    expect(progress.lines.map((line) => line.category)).toEqual([
      "shopping", // over, 125%
      "dining", // near, 90%
      "groceries", // under, 75%
      "entertainment", // under, 0% — ties on used, sorts before transport by id
      "transport", // under, 0%
    ]);
  });

  it("rolls up counts and totals", () => {
    expect(progress.budgetedCount).toBe(5);
    expect(progress.overCount).toBe(1);
    expect(progress.nearCount).toBe(1);
    expect(progress.underCount).toBe(3);
    expect(progress.totalLimitCents).toBe(95_000);
    expect(progress.totalSpentCents).toBe(70_000);
    expect(progress.currency).toBe("USD");
  });

  it("evaluates the optional overall cap against total outflow", () => {
    expect(progress.overall).toMatchObject({
      limitCents: 60_000,
      spentCents: 70_000,
      remainingCents: -10_000,
      overBudgetCents: 10_000,
      usedBasisPoints: 11_667, // round(70000/60000*10000)
      status: "over",
    });
  });

  it("projects nothing for a complete month", () => {
    for (const line of progress.lines) expect(line.projection).toBeUndefined();
    expect(progress.overall?.projection).toBeUndefined();
  });
});

describe("evaluateBudgets — a partial month (D-B3: status ≠ projection)", () => {
  // June 2022, viewed on the 10th: 10 of 30 days elapsed. $150 spent so far, on
  // pace for $450 — over a $400 cap — yet only 37.5% of the cap is actually gone.
  const summary = summarizeSpending({
    transactions: [
      tx({ id: "p1", accountId: ACCT.id, amountCents: -15_000, category: "groceries", flowType: "SPEND", postedDate: "2022-06-05" }),
    ],
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-06-10",
    kind: "month",
    key: "2022-06",
    categoryLabel: label,
  });

  const progress = evaluateBudgets({
    summary,
    budgets: [{ category: "groceries", limitCents: 40_000 }],
  });

  it("keeps status on actual spend — under, not over", () => {
    const groceries = progress.lines[0]!;
    expect(summary.period.partial).toBe(true);
    expect(groceries.usedBasisPoints).toBe(3_750);
    expect(groceries.status).toBe("under");
  });

  it("projects end-of-month spend from the elapsed pace and warns early", () => {
    const groceries = progress.lines[0]!;
    expect(groceries.projection).toEqual({
      projectedSpendCents: 45_000, // round(15000 * 30 / 10)
      projectedStatus: "over", // the pace breaches the cap…
      elapsedDays: 10,
      totalDays: 30,
    });
    expect(groceries.status).toBe("under"); // …but the headline status does not
  });

  it("projects the overall cap on the same pace, status still on actual spend", () => {
    // $150 spent of a $400 overall cap = 37.5% (under), but on pace for $450 —
    // over the cap. The overall cap must project like a line, and — D-B3 — its
    // headline status stays on money actually spent.
    const withOverall = evaluateBudgets({
      summary,
      budgets: [{ category: "groceries", limitCents: 40_000 }],
      overallLimitCents: 40_000,
    });
    expect(withOverall.overall).toMatchObject({ spentCents: 15_000, status: "under" });
    expect(withOverall.overall?.projection).toEqual({
      projectedSpendCents: 45_000, // round(15000 * 30 / 10)
      projectedStatus: "over",
      elapsedDays: 10,
      totalDays: 30,
    });
  });
});

describe("evaluateBudgets — edges & config", () => {
  const summary = summarizeSpending({
    transactions: [
      tx({ id: "e1", accountId: ACCT.id, amountCents: -12_000, category: "dining", flowType: "SPEND", postedDate: "2022-07-04" }),
    ],
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-08-01",
    kind: "month",
    key: "2022-07",
    categoryLabel: label,
  });

  it("returns an empty, no-overall picture when nothing is budgeted", () => {
    const progress = evaluateBudgets({ summary, budgets: [] });
    expect(progress.lines).toEqual([]);
    expect(progress.overall).toBeUndefined();
    expect(progress.budgetedCount).toBe(0);
    expect(progress.totalLimitCents).toBe(0);
    expect(progress.totalSpentCents).toBe(0);
  });

  it("ignores non-positive and duplicate-category budgets defensively", () => {
    const progress = evaluateBudgets({
      summary,
      budgets: [
        { category: "dining", limitCents: 20_000 },
        { category: "dining", limitCents: 5_000 }, // duplicate → dropped
        { category: "shopping", limitCents: 0 }, // non-positive → dropped
        { category: "groceries", limitCents: -100 }, // non-positive → dropped
      ],
    });
    expect(progress.lines.map((line) => line.category)).toEqual(["dining"]);
    expect(progress.lines[0]!.limitCents).toBe(20_000); // first wins
  });

  it("omits the overall cap when it is absent, non-positive, or non-finite", () => {
    expect(evaluateBudgets({ summary, budgets: [] }).overall).toBeUndefined();
    expect(evaluateBudgets({ summary, budgets: [], overallLimitCents: 0 }).overall).toBeUndefined();
    expect(evaluateBudgets({ summary, budgets: [], overallLimitCents: null }).overall).toBeUndefined();
    expect(evaluateBudgets({ summary, budgets: [], overallLimitCents: -100 }).overall).toBeUndefined();
    expect(evaluateBudgets({ summary, budgets: [], overallLimitCents: Infinity }).overall).toBeUndefined();
    expect(evaluateBudgets({ summary, budgets: [], overallLimitCents: Number.NaN }).overall).toBeUndefined();
  });

  it("excludes unbudgeted-category spend from the totals", () => {
    // The summary carries $120 of dining spend, but only groceries is budgeted
    // (and has no spend). Unbudgeted spend must never leak into totalSpentCents.
    const progress = evaluateBudgets({ summary, budgets: [{ category: "groceries", limitCents: 40_000 }] });
    expect(progress.lines.map((line) => line.category)).toEqual(["groceries"]);
    expect(progress.lines[0]!.spentCents).toBe(0);
    expect(progress.totalSpentCents).toBe(0);
  });

  it("falls back to the raw category id when neither summary nor labeller names it", () => {
    // No summary total (never spent) and no categoryLabel supplied → the id itself.
    const progress = evaluateBudgets({ summary, budgets: [{ category: "pet-care", limitCents: 5_000 }] });
    expect(progress.lines[0]!.displayName).toBe("pet-care");
  });

  it("honours a custom threshold config", () => {
    // dining spent $120 of a $200 cap = 60%. Default → under. With near at 50% it
    // becomes near; with over at 55% it becomes over.
    const near = evaluateBudgets({
      summary,
      budgets: [{ category: "dining", limitCents: 20_000 }],
      config: { nearRatioBasisPoints: 5_000, overRatioBasisPoints: 10_000 },
    });
    expect(near.lines[0]!.status).toBe("near");

    const over = evaluateBudgets({
      summary,
      budgets: [{ category: "dining", limitCents: 20_000 }],
      config: { nearRatioBasisPoints: 5_000, overRatioBasisPoints: 5_500 },
    });
    expect(over.lines[0]!.status).toBe("over");
  });
});

describe("evaluateBudgets — status boundaries (D-B4)", () => {
  // A closed month so status is final and nothing is projected. Each category
  // holds one spend sized to sit exactly on a threshold. Status is read off the
  // *rounded* basis-point share — the same number the bar shows — so the word
  // and the bar can never disagree. These pin the exact comparison operators:
  // `over` is strictly > 100%, `near` is >= 80%.
  const summary = summarizeSpending({
    transactions: [
      tx({ id: "b1", accountId: ACCT.id, amountCents: -10_000, category: "at_limit", flowType: "SPEND", postedDate: "2022-07-03" }),
      tx({ id: "b2", accountId: ACCT.id, amountCents: -10_001, category: "over_by_one_cent", flowType: "SPEND", postedDate: "2022-07-04" }),
      tx({ id: "b3", accountId: ACCT.id, amountCents: -8_000, category: "at_near", flowType: "SPEND", postedDate: "2022-07-05" }),
      tx({ id: "b4", accountId: ACCT.id, amountCents: -7_999, category: "just_under_near", flowType: "SPEND", postedDate: "2022-07-06" }),
      tx({ id: "b5", accountId: ACCT.id, amountCents: -15_999, category: "rounds_up_to_near", flowType: "SPEND", postedDate: "2022-07-07" }),
    ],
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-08-15",
    kind: "month",
    key: "2022-07",
  });

  const progress = evaluateBudgets({
    summary,
    budgets: [
      { category: "at_limit", limitCents: 10_000 },
      { category: "over_by_one_cent", limitCents: 10_000 },
      { category: "at_near", limitCents: 10_000 },
      { category: "just_under_near", limitCents: 10_000 },
      { category: "rounds_up_to_near", limitCents: 20_000 },
    ],
  });
  const byCat = new Map(progress.lines.map((line) => [line.category, line]));

  it("reads exactly 100% of the limit as near, not over (the > boundary)", () => {
    expect(byCat.get("at_limit")).toMatchObject({
      usedBasisPoints: 10_000,
      overBudgetCents: 0,
      remainingCents: 0,
      status: "near",
    });
  });

  it("reads one cent over the limit as over", () => {
    expect(byCat.get("over_by_one_cent")).toMatchObject({
      usedBasisPoints: 10_001,
      overBudgetCents: 1,
      remainingCents: -1,
      status: "over",
    });
  });

  it("reads exactly the near threshold (80%) as near (the >= boundary)", () => {
    expect(byCat.get("at_near")).toMatchObject({ usedBasisPoints: 8_000, status: "near" });
  });

  it("reads one cent below the near threshold as under", () => {
    expect(byCat.get("just_under_near")).toMatchObject({ usedBasisPoints: 7_999, status: "under" });
  });

  it("rounds a half-basis-point share up, so 79.995% reads as near", () => {
    // 15999/20000 = 79.995% → round(7999.5) = 8000 bp. Status reads off that same
    // rounded share, so bar (80%) and word ("near") agree.
    expect(byCat.get("rounds_up_to_near")).toMatchObject({ usedBasisPoints: 8_000, status: "near" });
  });
});

describe("evaluateBudgets — deterministic ordering at equal share", () => {
  const summary = summarizeSpending({
    transactions: [
      // Input order is banana-then-apple; the sort must not preserve it.
      tx({ id: "o_b", accountId: ACCT.id, amountCents: -9_000, category: "banana", flowType: "SPEND", postedDate: "2022-07-05" }),
      tx({ id: "o_a", accountId: ACCT.id, amountCents: -9_000, category: "apple", flowType: "SPEND", postedDate: "2022-07-06" }),
    ],
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-08-01",
    kind: "month",
    key: "2022-07",
  });

  it("breaks a status+share tie by category id, ascending", () => {
    const progress = evaluateBudgets({
      summary,
      budgets: [
        { category: "banana", limitCents: 10_000 },
        { category: "apple", limitCents: 10_000 },
      ],
    });
    // Both 90% of the cap (near); the tie resolves alphabetically, not by input
    // order — the earlier zero-share tiebreak test can't prove this on its own.
    expect(progress.lines.map((line) => line.category)).toEqual(["apple", "banana"]);
    expect(progress.lines.every((line) => line.status === "near")).toBe(true);
    expect(progress.lines.every((line) => line.usedBasisPoints === 9_000)).toBe(true);
  });
});

describe("evaluateBudgets — projection on a short month (CD-012)", () => {
  // February 2022 has 28 days. Viewed on the 14th, exactly half is elapsed, so
  // the pace projection doubles — and it must use 28, not a hard-coded 30/31.
  const summary = summarizeSpending({
    transactions: [
      tx({ id: "f1", accountId: ACCT.id, amountCents: -14_000, category: "groceries", flowType: "SPEND", postedDate: "2022-02-05" }),
    ],
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-02-14",
    kind: "month",
    key: "2022-02",
    categoryLabel: label,
  });

  it("projects from the month's real length, not a 30/31-day assumption", () => {
    expect(summary.period.partial).toBe(true);
    const progress = evaluateBudgets({ summary, budgets: [{ category: "groceries", limitCents: 40_000 }] });
    expect(progress.lines[0]!.projection).toEqual({
      projectedSpendCents: 28_000, // round(14000 * 28 / 14) — halfway through a 28-day month
      projectedStatus: "under", // 28000/40000 = 70%
      elapsedDays: 14,
      totalDays: 28,
    });
  });
});
