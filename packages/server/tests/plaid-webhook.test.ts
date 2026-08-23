/**
 * Webhook signature verification is the *only* thing standing between a public,
 * unauthenticated URL and an attacker who can trigger syncs or flag banks for
 * re-auth at will. So these tests exercise it as an adversary would: a genuine
 * Plaid-shaped signature must pass, and every forgery must fail — a body changed
 * after signing, a key swapped for one the attacker controls, the "none"/HMAC
 * algorithm-downgrade dodge, and a captured-but-stale header replayed later.
 *
 * The signatures here are real ES256 JWSs over a real EC P-256 key generated in
 * the test, verified against the exact code path production uses — not mocks of
 * the crypto. That is the point: a bug in the r‖s encoding or the body hash would
 * fail here exactly as it would against Plaid.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PlaidWebhookVerificationError, verifyPlaidWebhook, type PlaidJwk } from "../src/plaid/webhook";

const NOW = new Date("2026-08-23T12:00:00.000Z");

describe("verifyPlaidWebhook", () => {
  it("accepts a genuine Plaid signature over the exact body", async () => {
    const kp = keypair("kid-1");
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "item-1" });
    const jwt = sign(kp, body, NOW);

    await expect(
      verifyPlaidWebhook({ signedJwt: jwt, rawBody: body, fetchKey: fetcher(kp.jwk), now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("rejects a body altered after signing", async () => {
    const kp = keypair("kid-1");
    const jwt = sign(kp, JSON.stringify({ item_id: "item-1" }), NOW);

    // Same signature, different body: the hash in the JWT no longer matches.
    await expect(
      verifyPlaidWebhook({ signedJwt: jwt, rawBody: JSON.stringify({ item_id: "item-EVIL" }), fetchKey: fetcher(kp.jwk), now: NOW }),
    ).rejects.toBeInstanceOf(PlaidWebhookVerificationError);
  });

  it("rejects a signature made with a key the server does not trust", async () => {
    const attacker = keypair("kid-1");
    const legitimate = keypair("kid-1");
    const body = JSON.stringify({ item_id: "item-1" });
    const jwt = sign(attacker, body, NOW);

    // The attacker signs with their own key but the server fetches Plaid's real
    // key for that kid — the signature cannot verify against it.
    await expect(
      verifyPlaidWebhook({ signedJwt: jwt, rawBody: body, fetchKey: fetcher(legitimate.jwk), now: NOW }),
    ).rejects.toBeInstanceOf(PlaidWebhookVerificationError);
  });

  it("refuses an algorithm other than ES256 (no 'none'/HMAC downgrade)", async () => {
    const kp = keypair("kid-1");
    const body = JSON.stringify({ item_id: "item-1" });
    const header = b64url(JSON.stringify({ alg: "none", kid: "kid-1", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: Math.floor(NOW.getTime() / 1000), request_body_sha256: sha256(body) }));
    const forged = `${header}.${payload}.`;

    await expect(
      verifyPlaidWebhook({ signedJwt: forged, rawBody: body, fetchKey: fetcher(kp.jwk), now: NOW }),
    ).rejects.toBeInstanceOf(PlaidWebhookVerificationError);
  });

  it("rejects a stale (replayed) header past the freshness window", async () => {
    const kp = keypair("kid-1");
    const body = JSON.stringify({ item_id: "item-1" });
    const signedAt = new Date(NOW.getTime() - 6 * 60 * 1000); // 6 minutes old
    const jwt = sign(kp, body, signedAt);

    await expect(
      verifyPlaidWebhook({ signedJwt: jwt, rawBody: body, fetchKey: fetcher(kp.jwk), now: NOW }),
    ).rejects.toBeInstanceOf(PlaidWebhookVerificationError);
  });

  it("rejects a malformed verification header", async () => {
    await expect(
      verifyPlaidWebhook({ signedJwt: "not-a-jwt", rawBody: "{}", fetchKey: async () => keypair("kid-1").jwk, now: NOW }),
    ).rejects.toBeInstanceOf(PlaidWebhookVerificationError);
  });
});

type Keypair = { kid: string; privateKey: KeyObject; jwk: PlaidJwk };

function keypair(kid: string): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" }) as { crv?: string; x?: string; y?: string };
  return {
    kid,
    privateKey,
    jwk: { kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "", kid, alg: "ES256", use: "sig" },
  };
}

/** Build a real ES256 JWS, exactly as Plaid does: r‖s raw signature, body hash
 *  pinned in the payload, iat at the given time. */
function sign(kp: Keypair, body: string, at: Date): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: kp.kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: Math.floor(at.getTime() / 1000), request_body_sha256: sha256(body) }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign({ key: kp.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function fetcher(jwk: PlaidJwk): (keyId: string) => Promise<PlaidJwk> {
  return async () => jwk;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
