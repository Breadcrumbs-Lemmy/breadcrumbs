/**
 * Application-level encryption for individual sensitive fields at rest.
 *
 * The datastore is plain JSON files (see `persistence/atomic-file`), which are
 * mode-0600 but otherwise readable by anything with disk access. For a bearer
 * credential like a Plaid access token, file permissions alone are a thin
 * defence: a stolen disk image, a stray backup, or an over-broad host account
 * exposes it. This wraps such a value in AES-256-GCM so the ciphertext on disk
 * is useless without the key, which lives only in the environment (and ideally a
 * secrets manager), never in the datastore beside the data it protects.
 *
 * GCM is authenticated: `decrypt` verifies the tag and throws on any tampering,
 * so a modified record fails closed rather than yielding a forged value. An
 * optional `aad` binds the ciphertext to a stable context (e.g. the record's
 * id), so an attacker who can edit the file cannot swap one record's encrypted
 * token onto another record and have it still decrypt.
 *
 * The encoded form — `bcenc1:<iv>:<tag>:<ciphertext>`, all base64 — carries its
 * own version and parameters, and `decrypt` returns any value WITHOUT that prefix
 * unchanged. That passthrough is deliberate: it lets a store that previously
 * wrote plaintext keep reading its old records while writing new ones encrypted,
 * so turning encryption on needs no migration step.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "bcenc1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      // Report the length, never the bytes.
      throw new Error(`FieldCipher requires a ${KEY_BYTES}-byte key; received ${key.length} bytes.`);
    }
  }

  /** Encrypt `plaintext` into a self-describing `bcenc1:…` token. A fresh random
   *  IV per call means encrypting the same value twice yields different output. */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  /** Decrypt a `bcenc1:…` token. A value without the prefix is returned as-is
   *  (legacy plaintext passthrough). Throws if the token is malformed, or if the
   *  key or `aad` don't match the ones it was sealed with (tamper/mismatch). */
  decrypt(value: string, aad?: string): string {
    if (!FieldCipher.isEncrypted(value)) return value;
    const parts = value.split(":");
    if (parts.length !== 4) throw new Error("Malformed encrypted field: expected bcenc1:iv:tag:ciphertext.");
    const [, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, "base64"));
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }

  /** True if `value` is one of our encoded tokens (vs. legacy plaintext). */
  static isEncrypted(value: string): boolean {
    return value.startsWith(`${VERSION}:`);
  }
}

/** Raised when a configured encryption key is present but not a valid 32-byte
 *  key. Carries only the decoded length, never the key material. */
export class FieldCipherKeyError extends Error {
  constructor(actualBytes: number) {
    super(
      `BREADCRUMBS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${actualBytes}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
    this.name = "FieldCipherKeyError";
  }
}

/**
 * Build a `FieldCipher` from `BREADCRUMBS_ENCRYPTION_KEY` if it is set, else
 * return undefined so stores fall back to their prior (plaintext) behaviour —
 * the zero-config single-user path stays frictionless, and encryption is opt-in
 * by providing a key. The key may be hex (64 chars) or base64; either must
 * decode to exactly 32 bytes.
 */
export function loadFieldCipher(env: NodeJS.ProcessEnv = process.env): FieldCipher | undefined {
  const raw = env.BREADCRUMBS_ENCRYPTION_KEY?.trim();
  if (!raw) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) throw new FieldCipherKeyError(key.length);
  return new FieldCipher(key);
}
