/**
 * Verify that a webhook really came from Plaid, unmodified.
 *
 * A webhook endpoint is a public, unauthenticated URL — anyone who learns it can
 * POST to it. Acting on an unverified body would let a forger trigger syncs or
 * flag a bank for re-auth at will. Plaid signs every webhook with a short-lived
 * ES256 JWT carried in the `Plaid-Verification` header; the JWT's payload pins
 * the SHA-256 of the exact request body. Verifying both the signature (proves
 * Plaid sent it) and the body hash (proves nothing changed in flight) is what
 * makes it safe to act on. The public keys come from Plaid's own
 * `/webhook_verification_key/get`, looked up by the JWT's `kid`.
 *
 * There is no JWT library in the tree, and pulling one in for one endpoint is
 * more surface than it saves — Node's `crypto` verifies ES256 directly once the
 * JWK is imported as a public key. The one non-obvious detail is `dsaEncoding:
 * "ieee-p1363"`: a JWS ECDSA signature is the raw r‖s concatenation, not the DER
 * envelope Node's ECDSA defaults to, so the verify must be told which it is.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

/** A Plaid webhook-verification public key, as returned by
 *  `/webhook_verification_key/get`. Only the EC-JWK fields are needed to import
 *  it; `expired_at` lets a cache drop a rotated-out key. */
export type PlaidJwk = {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid?: string;
  alg?: string;
  use?: string;
  created_at?: number | null;
  expired_at?: number | null;
};

/** Thrown when a webhook cannot be proven to be a genuine, unmodified Plaid
 *  delivery. The message is deliberately coarse — the caller turns any failure
 *  into the same opaque 400, so an attacker learns nothing about which check
 *  tripped. */
export class PlaidWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidWebhookVerificationError";
  }
}

/** How old a verification JWT may be before it is rejected. Plaid's own guidance
 *  is five minutes; past it, a captured header replayed against the endpoint is
 *  refused even though its signature is still cryptographically valid. */
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export type VerifyPlaidWebhookInput = {
  /** The raw `Plaid-Verification` header value: a compact ES256 JWS. */
  signedJwt: string;
  /** The exact request body bytes as received, before any re-serialisation. The
   *  body hash is computed over this, so it must be Plaid's original text. */
  rawBody: string;
  /** Resolve a verification key by its `kid`. Injected (rather than a Plaid
   *  client) so this stays a pure function and a caller can cache in front of it. */
  fetchKey: (keyId: string) => Promise<PlaidJwk>;
  /** Current time; injectable so freshness is testable without real clocks. */
  now?: Date;
  maxAgeMs?: number;
};

/**
 * Throw unless `signedJwt` is a genuine, unexpired Plaid signature over exactly
 * `rawBody`. Returns nothing on success; every failure path raises
 * `PlaidWebhookVerificationError`, so a caller can treat "did not throw" as
 * "safe to act on this body".
 */
export async function verifyPlaidWebhook(input: VerifyPlaidWebhookInput): Promise<void> {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const parts = input.signedJwt.split(".");
  if (parts.length !== 3) throw new PlaidWebhookVerificationError("Malformed verification header.");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJson(headerB64, "header");
  // Pin the algorithm before trusting anything else: accepting the token's own
  // `alg` blindly is the classic JWS downgrade (e.g. "none", or an HMAC verified
  // with the public key as its secret). Plaid signs webhooks with ES256 only.
  if (header.alg !== "ES256") throw new PlaidWebhookVerificationError("Unexpected signing algorithm.");
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    throw new PlaidWebhookVerificationError("Verification header is missing a key id.");
  }

  const jwk = await input.fetchKey(kid);
  const publicKey = importVerificationKey(jwk);

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
  const signature = base64UrlToBuffer(signatureB64);
  // ieee-p1363: a JWS ECDSA signature is the raw r‖s pair, not DER. Without this
  // Node expects a DER envelope and a valid signature fails to verify.
  const signatureValid = cryptoVerify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  if (!signatureValid) throw new PlaidWebhookVerificationError("Signature verification failed.");

  const payload = decodeJson(payloadB64, "payload");
  const issuedAtMs = typeof payload.iat === "number" ? payload.iat * 1000 : Number.NaN;
  if (!Number.isFinite(issuedAtMs) || now.getTime() - issuedAtMs > maxAgeMs) {
    throw new PlaidWebhookVerificationError("Verification token is expired.");
  }

  const expectedHash = payload.request_body_sha256;
  if (typeof expectedHash !== "string") {
    throw new PlaidWebhookVerificationError("Verification token is missing the body hash.");
  }
  const actualHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  if (!timingSafeHexEqual(actualHash, expectedHash)) {
    throw new PlaidWebhookVerificationError("Request body does not match its signature.");
  }
}

/**
 * Wrap a Plaid client's `webhookVerificationKeyGet` in a per-`kid` cache.
 * Verification keys are immutable for a given `kid` and rotate rarely, so a live
 * production endpoint would otherwise make a Plaid round-trip on every webhook
 * just to fetch a key it already holds. A rotated-out key (Plaid stamps it with
 * `expired_at`) is dropped so the fresh one is fetched on next use.
 */
export function createCachingKeyFetcher(
  client: { webhookVerificationKeyGet(request: { key_id: string }): Promise<{ data: { key: PlaidJwk } }> },
): (keyId: string) => Promise<PlaidJwk> {
  const cache = new Map<string, PlaidJwk>();
  return async (keyId: string): Promise<PlaidJwk> => {
    const cached = cache.get(keyId);
    if (cached && !cached.expired_at) return cached;
    const response = await client.webhookVerificationKeyGet({ key_id: keyId });
    cache.set(keyId, response.data.key);
    return response.data.key;
  };
}

function importVerificationKey(jwk: PlaidJwk) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new PlaidWebhookVerificationError("Unsupported verification key type.");
  }
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch {
    throw new PlaidWebhookVerificationError("Verification key could not be parsed.");
  }
}

function decodeJson(segment: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(base64UrlToBuffer(segment).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through to the shared error
  }
  throw new PlaidWebhookVerificationError(`Malformed verification ${label}.`);
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Constant-time hex-string comparison; falls back cleanly on a length mismatch,
 *  which `timingSafeEqual` would otherwise throw on. */
function timingSafeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
