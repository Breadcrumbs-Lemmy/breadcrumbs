/**
 * `suggestSavingsCapacity` reads two observed figures off the user's own history:
 * the median monthly surplus (floor) and median income-above-essentials (ceiling).
 * These tests drive it through the *real* spending engine (`summarizeMonthlySpending`),
 * so transfer pairing, refund netting, and month bucketing are the production ones.
 *
 * All dates are 2022, never 2026 (`CD-012`): the medians here are of whole
 * calendar months, and the partial-month window logic divides the year on a real
 * calendar — a forgiving 2026 fixture would hide an off-by-one.
 *
 * The load-bearing rules pinned below:
 *   - it is a **median**, not a mean (an outlier month must not move the figure);
 *   - only **complete** months count (a partial first/last month is dropped);
 *   - **transfers to savings are not spending** (moving money aside stays surplus);
 *   - the ceiling is always ≥ the floor, and a deficit floors at 0.
 */
import { describe, expect, it } from "vitest";

import { suggestSavingsCapacity } from "../src";
import type { Account, Transaction } from "../src";

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

/** One month's worth: a paycheck, three essentials, and some discretionary. The
 *  `disc` entries carry their own category so essential-vs-discretionary is real. */
function monthTxns(
  ym: string,
  parts: {
    income: number;
    housing: number;
    groceries: number;
    transportation: number;
    disc: { category: string; amountCents: number }[];
  },
): Transaction[] {
  const out: Transaction[] = [
    tx({ id: `${ym}-inc`, accountId: ACCT.id, amountCents: parts.income, category: "income", flowType: "INCOME", postedDate: `${ym}-01` }),
    tx({ id: `${ym}-housing`, accountId: ACCT.id, amountCents: -parts.housing, category: "housing", flowType: "SPEND", postedDate: `${ym}-03` }),
    tx({ id: `${ym}-groc`, accountId: ACCT.id, amountCents: -parts.groceries, category: "groceries", flowType: "SPEND", postedDate: `${ym}-08` }),
    tx({ id: `${ym}-transit`, accountId: ACCT.id, amountCents: -parts.transportation, category: "transportation", flowType: "SPEND", postedDate: `${ym}-12` }),
  ];
  parts.disc.forEach((d, i) =>
    out.push(
      tx({ id: `${ym}-disc${i}`, accountId: ACCT.id, amountCents: -d.amountCents, category: d.category, flowType: "SPEND", postedDate: `${ym}-15` }),
    ),
  );
  return out;
}

describe("suggestSavingsCapacity — three complete months", () => {
  // March: surplus 240000, above-essentials 320000
  // April: surplus 100000, above-essentials 270000   (the low outlier)
  // May:   surplus 220000, above-essentials 280000
  // surplus median = 220000 (mean ≈ 186667 — proves median, not mean)
  // above-essentials median = 280000 (mean = 290000 — proves median)
  const transactions: Transaction[] = [
    ...monthTxns("2022-03", { income: 500_000, housing: 130_000, groceries: 35_000, transportation: 15_000, disc: [{ category: "dining", amountCents: 50_000 }, { category: "shopping", amountCents: 30_000 }] }),
    ...monthTxns("2022-04", { income: 500_000, housing: 150_000, groceries: 50_000, transportation: 30_000, disc: [{ category: "dining", amountCents: 90_000 }, { category: "shopping", amountCents: 80_000 }] }),
    ...monthTxns("2022-05", { income: 500_000, housing: 150_000, groceries: 45_000, transportation: 25_000, disc: [{ category: "dining", amountCents: 35_000 }, { category: "entertainment", amountCents: 25_000 }] }),
  ];

  const result = suggestSavingsCapacity({
    transactions,
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-06-10", // June is partial and excluded; earliest is March so all three count
  });

  it("floor is the median monthly surplus, not the mean", () => {
    expect(result.floorCents).toBe(220_000);
  });

  it("ceiling is the median income-above-essentials, not the mean", () => {
    expect(result.ceilingCents).toBe(280_000);
  });

  it("reports how many complete months fed the medians and has enough data", () => {
    expect(result.monthsConsidered).toBe(3);
    expect(result.hasEnoughData).toBe(true);
  });

  it("keeps the ceiling at or above the floor", () => {
    expect(result.ceilingCents).toBeGreaterThanOrEqual(result.floorCents);
  });
});

describe("suggestSavingsCapacity — partial months are excluded", () => {
  // A lush partial February (earliest data 2022-02-20) and a lush partial June
  // (asOfDate 2022-06-10) would each pull the median up if wrongly counted. The
  // three complete months in between are identical to the case above.
  const transactions: Transaction[] = [
    // Partial leading month: data starts 2022-02-20, so February is not whole.
    tx({ id: "feb-inc", accountId: ACCT.id, amountCents: 900_000, category: "income", flowType: "INCOME", postedDate: "2022-02-20" }),
    tx({ id: "feb-housing", accountId: ACCT.id, amountCents: -50_000, category: "housing", flowType: "SPEND", postedDate: "2022-02-25" }),
    ...monthTxns("2022-03", { income: 500_000, housing: 130_000, groceries: 35_000, transportation: 15_000, disc: [{ category: "dining", amountCents: 50_000 }, { category: "shopping", amountCents: 30_000 }] }),
    ...monthTxns("2022-04", { income: 500_000, housing: 150_000, groceries: 50_000, transportation: 30_000, disc: [{ category: "dining", amountCents: 90_000 }, { category: "shopping", amountCents: 80_000 }] }),
    ...monthTxns("2022-05", { income: 500_000, housing: 150_000, groceries: 45_000, transportation: 25_000, disc: [{ category: "dining", amountCents: 35_000 }, { category: "entertainment", amountCents: 25_000 }] }),
    // Partial trailing month: asOfDate 2022-06-10 lands inside June.
    tx({ id: "jun-inc", accountId: ACCT.id, amountCents: 900_000, category: "income", flowType: "INCOME", postedDate: "2022-06-02" }),
    tx({ id: "jun-housing", accountId: ACCT.id, amountCents: -50_000, category: "housing", flowType: "SPEND", postedDate: "2022-06-05" }),
  ];

  const result = suggestSavingsCapacity({
    transactions,
    accounts: [ACCT],
    currency: "USD",
    asOfDate: "2022-06-10",
  });

  it("counts only the three whole months between the partial ends", () => {
    expect(result.monthsConsidered).toBe(3);
    expect(result.floorCents).toBe(220_000);
    expect(result.ceilingCents).toBe(280_000);
  });
});

describe("suggestSavingsCapacity — transfers to savings stay surplus", () => {
  const SAVINGS = account({ id: "acct_savings", type: "savings", role: "reserve_cash", displayName: "Savings" });
  // Two identical months: income 300000, housing 100000, and a 150000 transfer to
  // savings. Money moved to savings is not spending, so surplus is 300000 − 100000
  // = 200000, never 50000. This pins that the transfer is excluded, not subtracted.
  function monthWithTransfer(ym: string): Transaction[] {
    return [
      tx({ id: `${ym}-inc`, accountId: ACCT.id, amountCents: 300_000, category: "income", flowType: "INCOME", postedDate: `${ym}-01` }),
      tx({ id: `${ym}-housing`, accountId: ACCT.id, amountCents: -100_000, category: "housing", flowType: "SPEND", postedDate: `${ym}-03` }),
      tx({ id: `${ym}-xfer`, accountId: ACCT.id, amountCents: -150_000, category: "savings_transfer", flowType: "TRANSFER_OUT", counterAccountId: SAVINGS.id, transferMatchConfidence: 0.9, postedDate: `${ym}-05` }),
    ];
  }
  const transactions = [...monthWithTransfer("2022-03"), ...monthWithTransfer("2022-04")];

  const result = suggestSavingsCapacity({
    transactions,
    accounts: [ACCT, SAVINGS],
    currency: "USD",
    asOfDate: "2022-05-10",
  });

  it("does not count a savings transfer as spending", () => {
    expect(result.monthsConsidered).toBe(2);
    expect(result.floorCents).toBe(200_000);
    expect(result.ceilingCents).toBe(200_000);
  });
});

describe("suggestSavingsCapacity — thin and degenerate inputs", () => {
  it("returns zeros and hasEnoughData=false with no transactions", () => {
    const result = suggestSavingsCapacity({ transactions: [], accounts: [ACCT], currency: "USD" });
    expect(result).toMatchObject({ floorCents: 0, ceilingCents: 0, monthsConsidered: 0, hasEnoughData: false });
  });

  it("computes a single complete month but flags it as not enough data", () => {
    const transactions = monthTxns("2022-03", {
      income: 400_000,
      housing: 120_000,
      groceries: 30_000,
      transportation: 20_000,
      disc: [{ category: "dining", amountCents: 40_000 }],
    });
    // asOfDate after March, earliest in March → exactly one complete month.
    const result = suggestSavingsCapacity({ transactions, accounts: [ACCT], currency: "USD", asOfDate: "2022-04-15" });
    // surplus = 400000 − 210000 = 190000; above-essentials = 400000 − 170000 = 230000
    expect(result.monthsConsidered).toBe(1);
    expect(result.floorCents).toBe(190_000);
    expect(result.ceilingCents).toBe(230_000);
    expect(result.hasEnoughData).toBe(false);
  });

  it("floors a spend-more-than-earned month at 0 without going negative", () => {
    // Two months that each spend beyond income: surplus negative → floor clamps to
    // 0, but discretionary spend leaves the ceiling positive.
    const overspend = (ym: string): Transaction[] =>
      monthTxns(ym, { income: 200_000, housing: 150_000, groceries: 40_000, transportation: 30_000, disc: [{ category: "shopping", amountCents: 60_000 }] });
    const transactions = [...overspend("2022-03"), ...overspend("2022-04")];
    const result = suggestSavingsCapacity({ transactions, accounts: [ACCT], currency: "USD", asOfDate: "2022-05-10" });
    // surplus = 200000 − 280000 = −80000 → floor 0; above-essentials = 200000 − 220000 = −20000 → 0
    expect(result.floorCents).toBe(0);
    expect(result.ceilingCents).toBe(0);
    expect(result.monthsConsidered).toBe(2);
  });

  it("ignores transactions in another currency", () => {
    const usd = monthTxns("2022-03", { income: 500_000, housing: 130_000, groceries: 35_000, transportation: 15_000, disc: [{ category: "dining", amountCents: 50_000 }] });
    const eur = usd.map((t, i) => ({ ...t, id: `eur-${i}`, currency: "EUR", amountCents: t.amountCents * 5 }));
    const result = suggestSavingsCapacity({ transactions: [...usd, ...eur], accounts: [ACCT], currency: "USD", asOfDate: "2022-04-15" });
    // Only the USD month survives → surplus = 500000 − 230000 = 270000
    expect(result.monthsConsidered).toBe(1);
    expect(result.floorCents).toBe(270_000);
  });
});
