/**
 * Field-level encryption at rest.
 *
 * These pin the properties the Plaid token store depends on: a value round-trips
 * only with the right key and context, tampering is caught (GCM), legacy
 * plaintext passes through so turning encryption on needs no migration, and the
 * key loader validates length without ever echoing the key.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FieldCipher, FieldCipherKeyError, loadFieldCipher } from "../src/crypto/field-cipher";

const KEY = randomBytes(32);

describe("FieldCipher", () => {
  it("round-trips a value and never stores it in the clear", () => {
    const cipher = new FieldCipher(KEY);
    const token = "access-sandbox-1234-abcd";
    const sealed = cipher.encrypt(token);

    expect(sealed).not.toContain(token);
    expect(sealed.startsWith("bcenc1:")).toBe(true);
    expect(cipher.decrypt(sealed)).toBe(token);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const cipher = new FieldCipher(KEY);
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("passes non-encrypted (legacy plaintext) values through unchanged", () => {
    const cipher = new FieldCipher(KEY);
    expect(cipher.decrypt("access-legacy-plaintext")).toBe("access-legacy-plaintext");
  });

  it("fails to decrypt with the wrong key", () => {
    const sealed = new FieldCipher(KEY).encrypt("secret");
    expect(() => new FieldCipher(randomBytes(32)).decrypt(sealed)).toThrow();
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const cipher = new FieldCipher(KEY);
    const sealed = cipher.encrypt("secret");
    const parts = sealed.split(":");
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64");
    expect(() => cipher.decrypt(parts.join(":"))).toThrow();
  });

  it("binds ciphertext to its AAD context", () => {
    const cipher = new FieldCipher(KEY);
    const sealed = cipher.encrypt("secret", "conn-a");
    expect(cipher.decrypt(sealed, "conn-a")).toBe("secret");
    // The same ciphertext under a different context must not decrypt — this is
    // what stops a swapped record from validating.
    expect(() => cipher.decrypt(sealed, "conn-b")).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new FieldCipher(randomBytes(16))).toThrow(/32-byte key/);
  });
});

describe("loadFieldCipher", () => {
  it("returns undefined when no key is set", () => {
    expect(loadFieldCipher({})).toBeUndefined();
  });

  it("accepts a base64 32-byte key and yields a working cipher", () => {
    const cipher = loadFieldCipher({ BREADCRUMBZ_ENCRYPTION_KEY: KEY.toString("base64") });
    expect(cipher).toBeInstanceOf(FieldCipher);
    expect(cipher!.decrypt(cipher!.encrypt("x"))).toBe("x");
  });

  it("accepts a hex 32-byte key", () => {
    const cipher = loadFieldCipher({ BREADCRUMBZ_ENCRYPTION_KEY: KEY.toString("hex") });
    expect(cipher).toBeInstanceOf(FieldCipher);
  });

  it("throws a length error (never echoing the key) on a malformed key", () => {
    try {
      loadFieldCipher({ BREADCRUMBZ_ENCRYPTION_KEY: "too-short" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldCipherKeyError);
      expect((error as Error).message).not.toContain("too-short");
    }
  });
});
