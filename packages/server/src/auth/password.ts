/**
 * Password hashing with scrypt from node's own crypto — no native dependency,
 * so the server installs and runs anywhere Node does. scrypt is memory-hard,
 * which is the property that matters against offline cracking of a leaked hash.
 *
 * The encoded form carries its own parameters (`scrypt$N$r$p$salt$hash`), so a
 * later change to the cost factors can re-hash on next login without a
 * migration — a stored hash is verified against the parameters it was made with.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { BinaryLike, ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// `promisify(scrypt)` resolves to the overload without an options object, so the
// cost parameters cannot be passed under its inferred type. At runtime promisify
// forwards every argument before the callback, so the options form works; the
// cast just tells the type system about the overload we are actually calling.
const scryptAsync = promisify(scrypt) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** 16 MiB of memory per hash (128 * N * r): steep for an attacker, trivial for
 *  a login. Kept under node's 32 MiB scrypt default so no maxmem tuning is
 *  needed. */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = (await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: n,
      r,
      p,
      // A hash made with different params could need more than the default;
      // size the ceiling to the stored cost so verification never throws.
      maxmem: 256 * n * r,
    })) as Buffer;
  } catch {
    return false;
  }
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
