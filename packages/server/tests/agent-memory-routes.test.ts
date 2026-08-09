/**
 * The memory HTTP surface — uploading learning material, saving facts, browsing
 * conversations — and the guarantee that it, like every other data route, is
 * scoped to the caller.
 *
 * These endpoints don't need a model, so they are exercised with no API key:
 * a user can hand the assistant files to learn from before turning it on. The
 * load-bearing case is isolation — one user's uploaded file must be invisible
 * and unreachable to another, asserted end to end over `app.inject`.
 */
import { describe, expect, it } from "vitest";

import { createServer } from "../src";
import type { AuthConfig } from "../src/auth/config";
import { InMemoryStatementImportStore } from "../src/local/store";
import { InMemoryStatementImportStoreProvider } from "../src/local/store-provider";

const DAY_MS = 24 * 60 * 60 * 1000;

function multiUserConfig(): AuthConfig {
  return { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8 };
}

async function multiUserServer() {
  return createServer({
    authConfig: multiUserConfig(),
    authPersistence: "memory",
    stores: new InMemoryStatementImportStoreProvider(),
  });
}

async function register(app: Awaited<ReturnType<typeof createServer>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "password123" },
  });
  return (JSON.parse(response.body) as { token: string }).token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("agent status reports the memory capability", () => {
  it("advertises memory even with no model configured", async () => {
    const app = await createServer({ statementImportStore: new InMemoryStatementImportStore() });
    const response = await app.inject({ method: "GET", url: "/api/v1/agent/status" });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.memory).toBe(true);
    expect(body.capabilities).toContain("memory");
    await app.close();
  });
});

describe("uploaded learning material (multi_user)", () => {
  it("keeps one user's uploaded file invisible and unreachable to another", async () => {
    const app = await multiUserServer();
    const aliceToken = await register(app, "alice@example.com");
    const bobToken = await register(app, "bob@example.com");

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/agent/memory/files",
      headers: auth(aliceToken),
      payload: { name: "budget.md", text: "Alice keeps a strict grocery budget of $400 a month." },
    });
    expect(upload.statusCode).toBe(201);
    const fileId = JSON.parse(upload.body).file.id as string;

    const aliceList = await app.inject({ method: "GET", url: "/api/v1/agent/memory/files", headers: auth(aliceToken) });
    expect(JSON.parse(aliceList.body).files).toHaveLength(1);

    const bobList = await app.inject({ method: "GET", url: "/api/v1/agent/memory/files", headers: auth(bobToken) });
    expect(JSON.parse(bobList.body).files).toHaveLength(0);

    // Bob cannot fetch Alice's file text even with its id — the id is scoped to
    // her memory, so to his it simply does not exist.
    const bobReach = await app.inject({
      method: "GET",
      url: `/api/v1/agent/memory/files/${fileId}`,
      headers: auth(bobToken),
    });
    expect(bobReach.statusCode).toBe(404);

    const aliceReach = await app.inject({
      method: "GET",
      url: `/api/v1/agent/memory/files/${fileId}`,
      headers: auth(aliceToken),
    });
    expect(aliceReach.statusCode).toBe(200);
    expect(JSON.parse(aliceReach.body).text).toMatch(/grocery budget/);

    await app.close();
  });

  it("rejects an unauthenticated upload", async () => {
    const app = await multiUserServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/memory/files",
      payload: { name: "x.txt", text: "secret" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("saved facts (multi_user)", () => {
  it("adds, lists, and deletes a fact, scoped to the caller", async () => {
    const app = await multiUserServer();
    const aliceToken = await register(app, "alice@example.com");
    const bobToken = await register(app, "bob@example.com");

    const add = await app.inject({
      method: "POST",
      url: "/api/v1/agent/memory/facts",
      headers: auth(aliceToken),
      payload: { text: "Prefers fortnightly summaries.", kind: "preference" },
    });
    expect(add.statusCode).toBe(201);
    const factId = JSON.parse(add.body).fact.id as string;

    const aliceFacts = await app.inject({ method: "GET", url: "/api/v1/agent/memory/facts", headers: auth(aliceToken) });
    expect(JSON.parse(aliceFacts.body).facts.some((f: { id: string }) => f.id === factId)).toBe(true);

    const bobFacts = await app.inject({ method: "GET", url: "/api/v1/agent/memory/facts", headers: auth(bobToken) });
    expect(JSON.parse(bobFacts.body).facts).toHaveLength(0);

    // Bob deleting Alice's fact by id is a 404, not a silent success.
    const bobDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/memory/facts/${factId}`,
      headers: auth(bobToken),
    });
    expect(bobDelete.statusCode).toBe(404);

    const aliceDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/memory/facts/${factId}`,
      headers: auth(aliceToken),
    });
    expect(aliceDelete.statusCode).toBe(200);
    await app.close();
  });
});

describe("conversations (multi_user)", () => {
  it("starts empty for a new user", async () => {
    const app = await multiUserServer();
    const token = await register(app, "alice@example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent/memory/conversations",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).conversations).toEqual([]);
    await app.close();
  });

  it("deleting a conversation that isn't there is a 404, not a silent success", async () => {
    const app = await multiUserServer();
    const token = await register(app, "alice@example.com");
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/agent/memory/conversations/conv_missing",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
