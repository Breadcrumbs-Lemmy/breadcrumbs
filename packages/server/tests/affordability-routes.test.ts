import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createServer } from "../src";

describe("affordability HTTP routes", () => {
  it("evaluates affordability through the versioned API endpoint", async () => {
    const app = await createServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/affordability/evaluate",
      payload: fixtureRequest(),
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      requestId: "fixture_affordable_steady_paycheck",
      level: "AFFORDABLE",
      explanation: {
        boundaries: expect.arrayContaining([
          "READ_ONLY_DECISION_SUPPORT",
          "NOT_PERSONALIZED_FINANCIAL_ADVICE",
          "NO_ACCOUNT_WRITES",
          "DETERMINISTIC_CALCULATION",
        ]),
      },
    });
    expect(body.monthlySpendingSummaries).toEqual(expect.any(Array));
    await app.close();
  });

  it("returns structured 400 issues for malformed affordability requests", async () => {
    const app = await createServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/affordability/evaluate",
      payload: {
        requestId: "",
        plannedPurchaseId: "",
        snapshot: {},
      },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "INVALID_AFFORDABILITY_REQUEST",
        issues: expect.any(Array),
      },
    });
    expect(body.error.issues.length).toBeGreaterThan(0);
    await app.close();
  });

  it("allows configured deployed frontend origins in addition to local development origins", async () => {
    const app = await createServer({
      allowedCorsOrigins: ["https://breadcrumbs-web.example"],
    });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/affordability/evaluate",
      headers: {
        origin: "https://breadcrumbs-web.example",
        "access-control-request-method": "POST",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://breadcrumbs-web.example");
    await app.close();
  });
});

function fixtureRequest(): Record<string, unknown> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(currentDir, "../../core/fixtures/mvp0/affordable-steady-paycheck.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { input: Record<string, unknown> };
  return fixture.input;
}
