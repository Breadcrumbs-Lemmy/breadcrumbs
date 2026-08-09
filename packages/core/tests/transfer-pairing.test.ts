/**
 * `annotateTransferPairs` is the read-time transfer-pairing pass that the
 * Transactions and Insights endpoints need.
 *
 * `summarizeMonthlySpending` pairs offsetting cross-account transfers on its own
 * internal copy, so the Spending summary already excludes them. The other
 * read paths call `queryTransactions` / `detectInsights`, which read
 * `counterAccountId` and `transferMatchConfidence` but nothing on those paths
 * ever wrote them — the CD-012 failure mode where a derived field only exists on
 * hand-written fixtures. These cases pin the shared annotator that closes it.
 */
import { describe, expect, it } from "vitest";
import { annotateTransferPairs } from "../src";
import type { Account, Transaction } from "../src";

function tx(overrides: Partial<Transaction> & Pick<Transaction, "id" | "accountId" | "amountCents">): Transaction {
  return {
    postedDate: "2026-06-15",
    merchantName: "Transfer",
    originalDescription: "ACCOUNT TRANSFER",
    currency: "USD",
    category: "transfer",
    flowType: "UNCLASSIFIED",
    freshness: { status: "usable", asOf: "2026-06-15T00:00:00.000Z", source: "fixture", warnings: [] },
    uncertainty: { confidence: 1, isEstimated: false },
    source: "fixture",
    ...overrides,
  };
}

const accounts: Account[] = [
  {
    id: "acct_checking",
    displayName: "Checking",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 100_000,
    includeInForecast: true,
    freshness: { status: "usable", asOf: "2026-06-15T00:00:00.000Z", source: "fixture", warnings: [] },
    source: "fixture",
  },
  {
    id: "acct_savings",
    displayName: "Savings",
    type: "savings",
    role: "reserve_cash",
    currency: "USD",
    currentBalanceCents: 500_000,
    includeInForecast: true,
    freshness: { status: "usable", asOf: "2026-06-15T00:00:00.000Z", source: "fixture", warnings: [] },
    source: "fixture",
  },
];

describe("annotateTransferPairs", () => {
  it("pairs two offsetting cross-account transfers, setting flow, counter account, and confidence", () => {
    const paired = annotateTransferPairs({
      transactions: [
        tx({ id: "t_out", accountId: "acct_checking", amountCents: -50_000 }),
        tx({ id: "t_in", accountId: "acct_savings", amountCents: 50_000, postedDate: "2026-06-16" }),
      ],
      accounts,
    });

    const out = paired.find((t) => t.id === "t_out");
    const inbound = paired.find((t) => t.id === "t_in");

    expect(out).toMatchObject({
      flowType: "TRANSFER_OUT",
      counterAccountId: "acct_savings",
      transferMatchConfidence: 0.9,
    });
    expect(inbound).toMatchObject({
      flowType: "TRANSFER_IN",
      counterAccountId: "acct_checking",
      transferMatchConfidence: 0.9,
    });
  });

  it("does not mutate the caller's transactions", () => {
    const input = [
      tx({ id: "t_out", accountId: "acct_checking", amountCents: -50_000 }),
      tx({ id: "t_in", accountId: "acct_savings", amountCents: 50_000 }),
    ];
    annotateTransferPairs({ transactions: input, accounts });
    expect(input.every((t) => t.flowType === "UNCLASSIFIED" && t.counterAccountId === undefined)).toBe(true);
  });

  it("leaves a lone transfer with no offsetting counterparty UNCLASSIFIED", () => {
    const [lone] = annotateTransferPairs({
      transactions: [tx({ id: "t_lone", accountId: "acct_checking", amountCents: -50_000 })],
      accounts,
    });
    expect(lone.flowType).toBe("UNCLASSIFIED");
    expect(lone.counterAccountId).toBeUndefined();
  });

  it("does not pair across currencies even when amounts offset", () => {
    const paired = annotateTransferPairs({
      transactions: [
        tx({ id: "t_usd", accountId: "acct_checking", amountCents: -50_000, currency: "USD" }),
        tx({ id: "t_eur", accountId: "acct_savings", amountCents: 50_000, currency: "EUR" }),
      ],
      accounts,
    });
    expect(paired.every((t) => t.flowType === "UNCLASSIFIED")).toBe(true);
  });

  it("is idempotent — a second pass leaves already-paired rows untouched", () => {
    const once = annotateTransferPairs({
      transactions: [
        tx({ id: "t_out", accountId: "acct_checking", amountCents: -50_000 }),
        tx({ id: "t_in", accountId: "acct_savings", amountCents: 50_000 }),
      ],
      accounts,
    });
    const twice = annotateTransferPairs({ transactions: once, accounts });
    expect(twice.find((t) => t.id === "t_out")).toMatchObject({
      flowType: "TRANSFER_OUT",
      counterAccountId: "acct_savings",
      transferMatchConfidence: 0.9,
    });
  });
});
