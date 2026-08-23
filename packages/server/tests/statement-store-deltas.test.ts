/**
 * The statement store gained upsert (`modifiedTransactions`) and delete
 * (`removedTransactionIds`) support so a Plaid `/transactions/sync` can be
 * applied faithfully — a CSV import is append-only, but a bank sync must be able
 * to correct or drop a row it previously reported (a pending charge that settles
 * at a new amount, or is dropped entirely). These pin that the deltas land, that
 * a requested-but-absent removal is a silent no-op, and — crucially — that a
 * plain CSV-style import (neither delta field) behaves exactly as before.
 */
import type { Account, Transaction } from "@ai-fin-os/core";
import { describe, expect, it } from "vitest";

import { InMemoryStatementImportStore } from "../src/local/store";

const account: Account = {
  id: "plaid:account:checking-1",
  displayName: "Checking",
  institutionName: "Test Bank",
  type: "checking",
  role: "spendable_cash",
  currency: "USD",
  currentBalanceCents: 100000,
  includeInForecast: true,
  freshness: { status: "fresh", asOf: "2026-08-01T00:00:00Z", source: "plaid", ageHours: 0, warnings: [] },
  source: "plaid",
};

function txn(id: string, amountCents: number, merchantName = "Coffee Shop", postedDate = "2026-08-01"): Transaction {
  return {
    id,
    accountId: account.id,
    postedDate,
    merchantName,
    amountCents,
    currency: "USD",
    category: "coffee_snacks",
    flowType: "expense",
    freshness: { status: "fresh", asOf: "2026-08-01T00:00:00Z", source: "plaid", ageHours: 0, warnings: [] },
    uncertainty: { confidence: 1, confidenceReason: "Imported from Plaid.", isEstimated: false },
    source: "plaid",
  };
}

function baseBatch(id: string) {
  return {
    id,
    accountId: account.id,
    sourceFormat: "plaid" as const,
    createdAt: "2026-08-01T00:00:00Z",
    rowCount: 0,
    invalidRowCount: 0,
    rawCsvStored: false as const,
  };
}

describe("statement store sync deltas", () => {
  it("upserts a modified transaction in place (replaces, does not duplicate)", async () => {
    const store = new InMemoryStatementImportStore();
    await store.saveImport({ account, transactions: [txn("plaid:transaction:t1", -500)], batch: baseBatch("b1") });

    const result = await store.saveImport({
      account,
      transactions: [],
      modifiedTransactions: [txn("plaid:transaction:t1", -750, "Coffee Shop Downtown")],
      batch: baseBatch("b2"),
    });

    const state = await store.load();
    const rows = state.transactions.filter((t) => t.id === "plaid:transaction:t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountCents).toBe(-750);
    expect(rows[0]?.merchantName).toBe("Coffee Shop Downtown");
    expect(result.modifiedTransactions.map((t) => t.id)).toEqual(["plaid:transaction:t1"]);
  });

  it("inserts a modified transaction that was never seen (Plaid upsert semantics)", async () => {
    const store = new InMemoryStatementImportStore();
    const result = await store.saveImport({
      account,
      transactions: [],
      modifiedTransactions: [txn("plaid:transaction:new", -100)],
      batch: baseBatch("b1"),
    });

    const state = await store.load();
    expect(state.transactions.map((t) => t.id)).toContain("plaid:transaction:new");
    expect(result.modifiedTransactions).toHaveLength(1);
  });

  it("deletes a removed transaction and reports only ids that were present", async () => {
    const store = new InMemoryStatementImportStore();
    await store.saveImport({
      account,
      transactions: [txn("plaid:transaction:keep", -100), txn("plaid:transaction:drop", -200)],
      batch: baseBatch("b1"),
    });

    const result = await store.saveImport({
      account,
      transactions: [],
      removedTransactionIds: ["plaid:transaction:drop", "plaid:transaction:never-existed"],
      batch: baseBatch("b2"),
    });

    const state = await store.load();
    expect(state.transactions.map((t) => t.id)).toEqual(["plaid:transaction:keep"]);
    // Only the id that was actually present is reported as removed.
    expect(result.removedTransactionIds).toEqual(["plaid:transaction:drop"]);
  });

  it("applies removals before additions so a same-batch remove+re-add keeps the new row", async () => {
    const store = new InMemoryStatementImportStore();
    await store.saveImport({ account, transactions: [txn("plaid:transaction:t1", -500)], batch: baseBatch("b1") });

    await store.saveImport({
      account,
      transactions: [txn("plaid:transaction:t1", -999)],
      removedTransactionIds: ["plaid:transaction:t1"],
      batch: baseBatch("b2"),
    });

    const state = await store.load();
    const rows = state.transactions.filter((t) => t.id === "plaid:transaction:t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountCents).toBe(-999);
  });

  it("leaves a plain CSV-style import (no deltas) with empty delta results", async () => {
    const store = new InMemoryStatementImportStore();
    const result = await store.saveImport({
      account,
      transactions: [txn("plaid:transaction:t1", -500)],
      batch: baseBatch("b1"),
    });

    expect(result.importedTransactions).toHaveLength(1);
    expect(result.modifiedTransactions).toEqual([]);
    expect(result.removedTransactionIds).toEqual([]);
  });
});
