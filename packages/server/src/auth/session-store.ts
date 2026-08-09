/**
 * Session persistence.
 *
 * The bearer token the browser holds is a 256-bit random string. Only its
 * sha256 is stored, so a leaked session file cannot be replayed — an attacker
 * would still need the raw token, which lives only in the client. Verification
 * hashes the presented token and looks it up; there is no reversible secret
 * here to steal.
 */
import { createHash, randomBytes } from "node:crypto";

import type { KeyValueStore } from "./json-store";
import type { Session } from "./types";

export interface SessionStore {
  create(input: { userId: string; ttlMs: number; userAgent?: string }): Promise<{ token: string; session: Session }>;
  /** Returns the session for a live token and refreshes `lastSeenAt`; returns
   *  undefined for an unknown or expired token (expired tokens are deleted). */
  verify(token: string): Promise<Session | undefined>;
  /** Stamp this session as having just cleared the TOTP challenge. Drives the
   *  time-boxed step-up gate. No-op for an unknown/expired token. */
  markMfaVerified(token: string): Promise<void>;
  revoke(token: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class KeyValueSessionStore implements SessionStore {
  constructor(private readonly kv: KeyValueStore<Session>) {}

  async create(input: { userId: string; ttlMs: number; userAgent?: string }): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const session: Session = {
      tokenHash: hashToken(token),
      userId: input.userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
      userAgent: input.userAgent,
    };
    await this.kv.put(session.tokenHash, session);
    return { token, session };
  }

  async verify(token: string): Promise<Session | undefined> {
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    const session = await this.kv.get(tokenHash);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.kv.delete(tokenHash);
      return undefined;
    }
    session.lastSeenAt = new Date().toISOString();
    await this.kv.put(tokenHash, session);
    return session;
  }

  async markMfaVerified(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const session = await this.kv.get(tokenHash);
    if (!session) return;
    session.mfaVerifiedAt = new Date().toISOString();
    await this.kv.put(tokenHash, session);
  }

  async revoke(token: string): Promise<void> {
    await this.kv.delete(hashToken(token));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const all = await this.kv.all();
    await Promise.all(all.filter((s) => s.userId === userId).map((s) => this.kv.delete(s.tokenHash)));
  }
}
