/**
 * The monthly report is a *composition*, so its tests pin two things the header
 * promises and nothing else invents:
 *
 *   1. Month resolution — the default is the latest **complete** calendar month
 *      relative to `asOfDate`, and an explicit key overrides it (D-R2).
 *   2. Composition equivalence — `buildMonthlyReport` returns exactly what
 *      `summarizeSpending` and `detectInsights` return for that month, so the
 *      report can never disagree with the screens (D-R1, `CD-003`).
 *
 * Plus the one genuinely new artefact: the CSV serializer's shape, RFC-4180
 * escaping, and pure-integer rounding (D-R6, D-R7).
 *
 * Dates are 2021–2023, never 2026 — the report leans on real calendar-month
 * arithmetic (partial-vs-complete, month step-back across a year), which the
 * forgiving 2026 fixtures would not exercise (`CD-012`).
 */
import { describe, expect, it } from "vitest";

import {
  buildMonthlyReport,
  detectInsights,
  summarizeSpending,
  toReportCsv,
} from "../src";
import type { Account, MonthlyReport, Transaction } from "../src";

function account(over: Partial<Account> & Pick<Account, "id">): Account {
  return {
    displayName: over.id,
    institutionName: "Test Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 100_000,
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

const CHK = account({ id: "chk", displayName: "Everyday" });

/** Labels chosen so one contains a comma — the only field that can need
 *  RFC-4180 quoting. */
const LABELS: Record<string, string> = {
  groceries: "Groceries",
  dining: "Dining",
  bars: "Bars, Pubs",
};
const label = (id: string): string => LABELS[id] ?? id;

/** A single April-2022 month: two grocery spends, a dining spend with a partial
 *  refund, and one comma-labelled category. */
const APRIL_2022: Transaction[] = [
  tx({ id: "g1", accountId: "chk", amountCents: -5000, category: "groceries", flowType: "SPEND", postedDate: "2022-04-03" }),
  tx({ id: "g2", accountId: "chk", amountCents: -3000, category: "groceries", flowType: "SPEND", postedDate: "2022-04-18" }),
  tx({ id: "d1", accountId: "chk", amountCents: -2500, category: "dining", flowType: "SPEND", postedDate: "2022-04-10" }),
  tx({ id: "d2", accountId: "chk", amountCents: 500, category: "dining", flowType: "REFUND", postedDate: "2022-04-12" }),
  tx({ id: "b1", accountId: "chk", amountCents: -1000, category: "bars", flowType: "SPEND", postedDate: "2022-04-20" }),
];

describe("buildMonthlyReport — month resolution (D-R2)", () => {
  const base = { transactions: [] as Transaction[], accounts: [CHK], currency: "USD" };

  it("defaults to the latest COMPLETE month (steps back from a partial current month)", () => {
    const report = buildMonthlyReport({ ...base, asOfDate: "2022-05-14" });
    expect(report.requestedKey).toBeNull();
    expect(report.fromLatestComplete).toBe(true);
    expect(report.summary.period.key).toBe("2022-04");
  });

  it("uses the current month when asOfDate is its final day (the month is complete)", () => {
    const report = buildMonthlyReport({ ...base, asOfDate: "2022-04-30" });
    expect(report.summary.period.key).toBe("2022-04");
    expect(report.fromLatestComplete).toBe(true);
  });

  it("steps back across a year boundary", () => {
    const report = buildMonthlyReport({ ...base, asOfDate: "2023-01-05" });
    expect(report.summary.period.key).toBe("2022-12");
  });

  it("honours an explicit month key over the default", () => {
    const report = buildMonthlyReport({ ...base, asOfDate: "2022-05-14", key: "2022-03" });
    expect(report.requestedKey).toBe("2022-03");
    expect(report.fromLatestComplete).toBe(false);
    expect(report.summary.period.key).toBe("2022-03");
  });

  it("falls back to the default when the key is malformed (never renders an unasked month)", () => {
    const report = buildMonthlyReport({ ...base, asOfDate: "2022-05-14", key: "nonsense" });
    expect(report.requestedKey).toBeNull();
    expect(report.fromLatestComplete).toBe(true);
    expect(report.summary.period.key).toBe("2022-04");
  });
});

describe("buildMonthlyReport — composition equivalence (D-R1, CD-003)", () => {
  it("returns exactly what the two engines return for the resolved month", () => {
    const shared = {
      transactions: APRIL_2022,
      accounts: [CHK],
      currency: "USD",
      asOfDate: "2022-05-14",
      categoryLabel: label,
    };
    const report = buildMonthlyReport(shared);
    const key = report.summary.period.key;
    expect(key).toBe("2022-04");

    expect(report.summary).toEqual(summarizeSpending({ ...shared, kind: "month", key }));
    expect(report.insights).toEqual(detectInsights({ ...shared, kind: "month", key }));
  });
});

describe("toReportCsv — shape, escaping, rounding (D-R6, D-R7)", () => {
  function april(): MonthlyReport {
    return buildMonthlyReport({
      transactions: APRIL_2022,
      accounts: [CHK],
      currency: "USD",
      asOfDate: "2022-05-14",
      key: "2022-04",
      categoryLabel: label,
    });
  }

  it("is a clean single table: header, category rows largest-net-first, then Total", () => {
    const csv = toReportCsv(april());
    expect(csv).toBe(
      "Category,Spent,Refunds,Net,Share %,Transactions\r\n" +
        "Groceries,80.00,0.00,80.00,72.73,2\r\n" +
        "Dining,25.00,5.00,20.00,18.18,1\r\n" +
        '"Bars, Pubs",10.00,0.00,10.00,9.09,1\r\n' +
        "Total,115.00,5.00,110.00,100.00,4\r\n",
    );
  });

  it("terminates every record with CRLF, including the last", () => {
    const csv = toReportCsv(april());
    expect(csv.endsWith("\r\n")).toBe(true);
    // 1 header + 3 categories + 1 total = 5 records, each ending in CRLF.
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(5);
  });

  it("renders a quiet month as header + zeroed Total, never an error", () => {
    const quiet = buildMonthlyReport({
      transactions: [],
      accounts: [CHK],
      currency: "USD",
      asOfDate: "2022-05-14",
    });
    expect(toReportCsv(quiet)).toBe(
      "Category,Spent,Refunds,Net,Share %,Transactions\r\nTotal,0.00,0.00,0.00,0.00,0\r\n",
    );
  });

  it("keeps the sign on a category whose refunds exceed its spend", () => {
    const report = buildMonthlyReport({
      transactions: [
        tx({ id: "r1", accountId: "chk", amountCents: -1000, category: "returns", flowType: "SPEND", postedDate: "2022-04-05" }),
        tx({ id: "r2", accountId: "chk", amountCents: 3000, category: "returns", flowType: "REFUND", postedDate: "2022-04-06" }),
      ],
      accounts: [CHK],
      currency: "USD",
      asOfDate: "2022-05-14",
      key: "2022-04",
      categoryLabel: (id) => (id === "returns" ? "Returns" : id),
    });
    const csv = toReportCsv(report);
    // Net = 1000 spend − 3000 refund = −2000 → "-20.00"; share is 0 because a
    // negative total has no meaningful denominator. The count is 1: the one
    // spend is counted, the refund is not.
    expect(csv).toContain("Returns,10.00,30.00,-20.00,0.00,1\r\n");
    expect(csv).toContain("Total,10.00,30.00,-20.00,0.00,1\r\n");
  });
});
