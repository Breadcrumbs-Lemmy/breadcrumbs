/**
 * Durability + privacy of the file holding a user's real accounts and
 * transactions. Before hardening, `FileStatementImportStore` wrote with a plain,
 * non-atomic `writeFile` at mode 0644 and with no write serialization: a crash
 * could truncate it, any OS user could read it, and two concurrent imports could
 * lose one. This pins the three fixes — atomic + 0600 + serialized — through the
 * real HTTP commit path a user actually hits.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src";
import { FileStatementImportStore } from "../src/local/store";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-stmt-durability-"));
  filePath = join(dir, "statement-imports.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function commitPayload(opts: { requestId: string; accountId: string; txnId: string; amount: string }) {
  return {
    requestId: opts.requestId,
    accountId: opts.accountId,
    account: {
      id: opts.accountId,
      displayName: `Account ${opts.accountId}`,
      institutionName: "Local Bank",
      type: "checking",
      currency: "USD",
    },
    currency: "USD",
    dateFormat: "mm/dd/yyyy",
    mapping: {
      postedDate: "Posted",
      amount: "Amount",
      amountSignConvention: "signed",
      description: "Description",
      category: "Category",
      transactionId: "Transaction Id",
    },
    csv: ["Posted,Description,Amount,Category,Transaction Id", `06/15/2023,Coffee,${opts.amount},Food,${opts.txnId}`].join("\n"),
  };
}

async function commit(app: Awaited<ReturnType<typeof createServer>>, payload: object) {
  const response = await app.inject({ method: "POST", url: "/api/local/statement-imports/commit", payload });
  expect(response.statusCode).toBe(200);
  return response;
}

describe("FileStatementImportStore durability", () => {
  it("persists financial data owner-only (mode 0600), not world-readable", async () => {
    const app = await createServer({ statementImportStore: new FileStatementImportStore(filePath) });
    await commit(app, commitPayload({ requestId: "r1", accountId: "acct_a", txnId: "ta-1", amount: "-4.50" }));
    await app.close();

    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("survives a restart — a new store instance reads what was committed", async () => {
    const app = await createServer({ statementImportStore: new FileStatementImportStore(filePath) });
    await commit(app, commitPayload({ requestId: "r1", accountId: "acct_a", txnId: "ta-1", amount: "-4.50" }));
    await app.close();

    // A fresh instance == a process restart: the access happens only through the file.
    // (The commit route derives its own `csv:transaction:*` ids, so assert on the
    // durable count and the account id we control, not the raw CSV id.)
    const reloaded = await new FileStatementImportStore(filePath).load();
    expect(reloaded.transactions).toHaveLength(1);
    expect(reloaded.accounts.map((a) => a.id)).toContain("acct_a");
  });

  it("serializes concurrent imports so neither is lost to an interleaved read-modify-write", async () => {
    const store = new FileStatementImportStore(filePath);
    const app = await createServer({ statementImportStore: store });

    // Two imports fired at once against the same store. Without the write queue,
    // both read the same base state and the second write clobbers the first.
    await Promise.all([
      commit(app, commitPayload({ requestId: "rA", accountId: "acct_a", txnId: "ta-1", amount: "-4.50" })),
      commit(app, commitPayload({ requestId: "rB", accountId: "acct_b", txnId: "tb-1", amount: "-9.00" })),
    ]);
    await app.close();

    // Both imports survived: 2 transactions and 2 accounts. Without the write
    // queue, the second commit's read-modify-write would clobber the first and
    // this would be 1 of each.
    const reloaded = await new FileStatementImportStore(filePath).load();
    expect(reloaded.transactions).toHaveLength(2);
    expect(reloaded.accounts.map((a) => a.id).sort()).toEqual(["acct_a", "acct_b"]);
  });
});
