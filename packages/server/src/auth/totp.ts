/**
 * Time-based one-time passwords (TOTP, RFC 6238) — the second factor.
 *
 * TOTP is chosen over SMS deliberately: it needs no third-party sender (no
 * Twilio, no new subprocessor), works offline, and is immune to SIM-swap — the
 * right fit for a privacy-first, self-hostable app. The shared secret is the
 * only sensitive material; the caller (the auth service) is responsible for
 * storing it encrypted at rest. Nothing here persists or logs a secret.
 *
 * Implementation is pure `node:crypto` (HMAC-SHA1 per the standard, which every
 * authenticator app speaks): a base32 secret, a 30-second step, 6 digits, and a
 * ±1-step verification window to tolerate clock skew between phone and server.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** How many steps either side of "now" a presented code is still accepted.
 *  ±1 tolerates ~30s of clock drift without meaningfully widening the guess
 *  space (a 6-digit code across 3 windows is still 1-in-333k per attempt, and
 *  attempts are rate-limited and lock out). */
const DEFAULT_WINDOW = 1;

/** RFC 4648 base32 alphabet (no padding), the encoding every authenticator app
 *  expects in an `otpauth://` secret. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh random secret as a base32 string. 20 bytes = 160 bits, the SHA-1
 *  block size and the standard TOTP secret length. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The `otpauth://totp/...` URI an authenticator app imports (usually via a QR
 * code the browser renders from this string). `issuer` and the account label
 * are what the user sees in their app so they can tell this factor apart from
 * every other one they hold.
 */
export function buildOtpauthUri(params: { secret: string; accountName: string; issuer: string }): string {
  const issuer = encodeURIComponent(params.issuer);
  const label = `${issuer}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secret.replace(/=+$/, ""),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** The current 6-digit code for a secret, at time `nowMs` (defaults to now).
 *  Exposed mainly so tests can assert against a known instant. */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secret), counterAt(nowMs));
}

/**
 * Whether `token` is a valid code for `secret` at `nowMs`, within ±`window`
 * steps. Returns false for any malformed input rather than throwing, so a
 * garbage code from the client is an ordinary "wrong code", not a 500. The
 * per-window compare is constant-time to avoid leaking how close a guess was.
 */
export function verifyTotp(
  secret: string,
  token: string,
  opts: { nowMs?: number; window?: number } = {},
): boolean {
  const normalized = (token ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const window = opts.window ?? DEFAULT_WINDOW;
  const center = counterAt(opts.nowMs ?? Date.now());
  // Walk the whole window even after a match so timing does not reveal which
  // step matched (or how many were checked).
  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = hotp(key, center + offset);
    if (constantTimeEqual(candidate, normalized)) matched = true;
  }
  return matched;
}

// ---- internals -------------------------------------------------------------

/** RFC 4226 HOTP: HMAC-SHA1 of the counter, dynamically truncated to `DIGITS`. */
function hotp(key: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  // 53-bit safe: counter is seconds/30, far below 2^32 for any real time, but
  // write the high word too so the encoding is a correct 64-bit big-endian.
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", key).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

function counterAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 character in TOTP secret.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
