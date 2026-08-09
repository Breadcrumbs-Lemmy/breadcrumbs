/**
 * The auth service: the single place identity decisions are made.
 *
 * Routes and middleware call this; they never touch the user or session stores
 * directly. That keeps every rule that matters — who becomes admin, when a
 * password is accepted, how the owner is provisioned, why a login fails — in one
 * auditable file, and lets the storage underneath change without moving policy.
 */
import { randomUUID } from "node:crypto";

import type { AuthConfig } from "./config";
import { authErrors } from "./errors";
import { hashPassword, verifyPassword } from "./password";
import type { SessionStore } from "./session-store";
import { OWNER_USER_ID, normalizeEmail } from "./types";
import type { Principal, Role, User } from "./types";
import type { UserStore } from "./user-store";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-account brute-force throttle. After LOCKOUT_THRESHOLD failed sign-ins for
// the same email inside LOCKOUT_WINDOW_MS, that email is locked for
// LOCKOUT_DURATION_MS. This is a second, credential-aware layer beneath the
// coarse per-IP rate limit: it survives an attacker rotating IPs but focusing on
// one account, and it resets the instant a correct password lands.
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

type LoginFailure = { count: number; firstAt: number; lockedUntil: number };

export type AuthServiceDeps = {
  users: UserStore;
  sessions: SessionStore;
  config: AuthConfig;
};

export type Credentials = { email: string; password: string; displayName?: string; userAgent?: string };

export class AuthService {
  readonly config: AuthConfig;
  private readonly users: UserStore;
  private readonly sessions: SessionStore;
  /** In-memory failed-login tally keyed by normalized email. Intentionally not
   *  persisted: a lockout is a short-lived defense, and losing it on restart is
   *  acceptable where persisting per-email attacker input is not. */
  private readonly loginFailures = new Map<string, LoginFailure>();

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.sessions = deps.sessions;
    this.config = deps.config;
  }

  // ---- Boot ---------------------------------------------------------------

  /**
   * Guarantee the owner account exists. In single-user mode this is the one
   * account the whole app runs as; in multi-user mode it is a convenience so a
   * fresh deployment has a first admin to sign in as if `BREADCRUMBS_OWNER_*`
   * are set. Idempotent — safe to call on every boot.
   */
  async ensureOwner(seed?: { email?: string; password?: string; displayName?: string }): Promise<User> {
    const existing = await this.users.getById(OWNER_USER_ID);
    if (existing) return existing;
    const email = normalizeEmail(seed?.email ?? this.config.ownerEmail ?? "owner@breadcrumbs.local");
    const now = new Date().toISOString();
    const owner: User = {
      id: OWNER_USER_ID,
      email,
      displayName: seed?.displayName ?? "Owner",
      role: "admin",
      passwordHash: seed?.password ? await hashPassword(seed.password) : "",
      status: "active",
      createdAt: now,
      updatedAt: now,
      mfa: { enabled: false, method: null, phoneE164: null, phoneVerified: false },
    };
    return this.users.create(owner);
  }

  /** The synthesised caller for single-user mode: always the owner, no session. */
  ownerPrincipal(): Principal {
    return { userId: OWNER_USER_ID, role: "admin", owner: true };
  }

  // ---- Registration & login ----------------------------------------------

  async register(input: Credentials): Promise<{ user: User; token: string }> {
    if (this.config.mode === "multi_user" && !this.config.registrationOpen) {
      // The very first account is always allowed, so a closed deployment can
      // still bootstrap its first admin.
      if ((await this.users.count()) > 0) throw authErrors.registrationClosed();
    }
    const email = normalizeEmail(input.email);
    if (!EMAIL_RE.test(email)) throw authErrors.invalidEmail();
    if (input.password.length < this.config.passwordMinLength) {
      throw authErrors.weakPassword(this.config.passwordMinLength);
    }
    if (await this.users.getByEmail(email)) throw authErrors.emailTaken();

    const firstEver = (await this.users.count()) === 0;
    const role: Role = firstEver || email === this.config.ownerEmail ? "admin" : "user";
    const now = new Date().toISOString();
    const user = await this.users.create({
      id: `usr_${randomUUID()}`,
      email,
      displayName: input.displayName?.trim() || email.split("@")[0]!,
      role,
      passwordHash: await hashPassword(input.password),
      status: "active",
      createdAt: now,
      updatedAt: now,
      mfa: { enabled: false, method: null, phoneE164: null, phoneVerified: false },
    });
    const { token } = await this.sessions.create({ userId: user.id, ttlMs: this.config.sessionTtlMs, userAgent: input.userAgent });
    return { user, token };
  }

  async login(input: Credentials): Promise<{ user: User; token: string }> {
    const email = normalizeEmail(input.email);
    this.assertNotLockedOut(email);
    const user = await this.users.getByEmail(email);
    // Verify against a dummy hash even when the user is missing, so a caller
    // cannot distinguish "no such account" from "wrong password" by timing.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      this.recordLoginFailure(email);
      throw authErrors.invalidCredentials();
    }
    if (user.status === "disabled") throw authErrors.accountDisabled();

    this.loginFailures.delete(email);
    await this.users.update(user.id, { lastLoginAt: new Date().toISOString() });
    const { token } = await this.sessions.create({ userId: user.id, ttlMs: this.config.sessionTtlMs, userAgent: input.userAgent });
    return { user, token };
  }

  /** Throw if this email is currently locked out. Prunes an entry whose window
   *  has fully elapsed so a quiet account starts fresh. */
  private assertNotLockedOut(email: string): void {
    const entry = this.loginFailures.get(email);
    if (!entry) return;
    const now = Date.now();
    if (entry.lockedUntil > now) {
      throw authErrors.tooManyAttempts(Math.ceil((entry.lockedUntil - now) / 1000));
    }
    if (now - entry.firstAt > LOCKOUT_WINDOW_MS && entry.lockedUntil <= now) {
      this.loginFailures.delete(email);
    }
  }

  private recordLoginFailure(email: string): void {
    const now = Date.now();
    const entry = this.loginFailures.get(email);
    if (!entry || now - entry.firstAt > LOCKOUT_WINDOW_MS) {
      this.loginFailures.set(email, { count: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    }
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /** Resolve a bearer token to a caller, or undefined. Disabled accounts and
   *  users deleted since the session was issued resolve to undefined. */
  async authenticateToken(token: string): Promise<Principal | undefined> {
    const session = await this.sessions.verify(token);
    if (!session) return undefined;
    const user = await this.users.getById(session.userId);
    if (!user || user.status === "disabled") return undefined;
    return { userId: user.id, role: user.role, sessionToken: token };
  }

  // ---- Self-service -------------------------------------------------------

  getUser(id: string): Promise<User | undefined> {
    return this.users.getById(id);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.users.getById(userId);
    if (!user) throw authErrors.notFound();
    // A user with no password yet (freshly provisioned owner) sets one without
    // proving the empty current.
    if (user.passwordHash && !(await verifyPassword(current, user.passwordHash))) {
      throw authErrors.invalidCredentials();
    }
    if (next.length < this.config.passwordMinLength) throw authErrors.weakPassword(this.config.passwordMinLength);
    await this.users.update(userId, { passwordHash: await hashPassword(next) });
    // Every other session for this user is invalidated on a password change.
    await this.sessions.revokeAllForUser(userId);
  }

  // ---- Admin --------------------------------------------------------------

  listUsers(): Promise<User[]> {
    return this.users.list();
  }

  async adminCreateUser(input: Credentials & { role?: Role }): Promise<User> {
    const created = await this.register({ ...input });
    if (input.role && input.role !== "user") {
      const updated = await this.users.update(created.user.id, { role: input.role });
      return updated ?? created.user;
    }
    return created.user;
  }

  async setRole(userId: string, role: Role): Promise<User> {
    const user = await this.users.getById(userId);
    if (!user) throw authErrors.notFound();
    if (user.role === "admin" && role !== "admin" && (await this.adminCount()) <= 1) {
      throw authErrors.cannotDemoteLastAdmin();
    }
    return (await this.users.update(userId, { role }))!;
  }

  async setStatus(userId: string, status: "active" | "disabled"): Promise<User> {
    const user = await this.users.getById(userId);
    if (!user) throw authErrors.notFound();
    if (status === "disabled" && user.role === "admin" && (await this.adminCount()) <= 1) {
      throw authErrors.cannotDemoteLastAdmin();
    }
    if (status === "disabled") await this.sessions.revokeAllForUser(userId);
    return (await this.users.update(userId, { status }))!;
  }

  async adminResetPassword(userId: string, next: string): Promise<void> {
    const user = await this.users.getById(userId);
    if (!user) throw authErrors.notFound();
    if (next.length < this.config.passwordMinLength) throw authErrors.weakPassword(this.config.passwordMinLength);
    await this.users.update(userId, { passwordHash: await hashPassword(next) });
    await this.sessions.revokeAllForUser(userId);
  }

  private async adminCount(): Promise<number> {
    return (await this.users.list()).filter((u) => u.role === "admin" && u.status === "active").length;
  }
}

/** A well-formed scrypt hash of a random value, used to keep login timing flat
 *  for unknown emails. Its plaintext is never known, so it can never verify. */
const DUMMY_HASH = "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);
