/**
 * RFC 6238 TOTP primitives.
 *
 * These back the second factor, so the properties that matter are: a code
 * verifies within its own window, tolerates ±1 step of clock skew, rejects a
 * stale or malformed code, and never throws on garbage client input (a bad code
 * is an ordinary "no", not a 500). One RFC test vector anchors the maths so a
 * refactor that silently changes the algorithm is caught.
 */
import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpCode,
  verifyTotp,
} from "../src/auth/totp";

const STEP_MS = 30_000;

describe("TOTP", () => {
  it("round-trips base32 for arbitrary bytes", () => {
    const bytes = Buffer.from([0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0xff, 0xde, 0xad, 0xbe, 0xef]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("matches the RFC 6238 SHA-1 test vector at T=59s", () => {
    // RFC 6238 Appendix B: seed "12345678901234567890" (ASCII), SHA-1, 8 digits
    // → 94287082 at 59s. We use 6 digits, i.e. the low 6 of that value.
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    expect(totpCode(secret, 59_000)).toBe("287082");
  });

  it("verifies a freshly generated code at the same instant", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now), { nowMs: now })).toBe(true);
  });

  it("accepts a code from one step earlier (clock skew tolerance)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const prevCode = totpCode(secret, now - STEP_MS);
    expect(verifyTotp(secret, prevCode, { nowMs: now })).toBe(true);
  });

  it("rejects a code two steps stale (outside the ±1 window)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const oldCode = totpCode(secret, now - 2 * STEP_MS);
    expect(verifyTotp(secret, oldCode, { nowMs: now })).toBe(false);
  });

  it("rejects a code minted for a different secret", () => {
    const now = 1_700_000_000_000;
    const codeForOther = totpCode(generateTotpSecret(), now);
    expect(verifyTotp(generateTotpSecret(), codeForOther, { nowMs: now })).toBe(false);
  });

  it("returns false (never throws) for malformed or empty input", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "12345")).toBe(false); // too short
    expect(verifyTotp(secret, "1234567")).toBe(false); // too long
    expect(verifyTotp("not-base-32!!", "123456")).toBe(false);
  });

  it("tolerates spaces the user might type between digit groups", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { nowMs: now })).toBe(true);
  });

  it("builds an otpauth URI an authenticator app can import", () => {
    const uri = buildOtpauthUri({ secret: "JBSWY3DPEHPK3PXP", accountName: "alice@example.com", issuer: "Breadcrumbz" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Breadcrumbz:alice%40example\.com\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Breadcrumbz");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
