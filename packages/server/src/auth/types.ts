/**
 * Identity types for Breadcrumbs.
 *
 * The product's first user is its owner tracking their own spending, so the
 * default posture is single-user and login-free (`mode: "single_user"`). The
 * same types carry the multi-user, per-user-isolated deployment where an admin
 * manages accounts and no user can read another's data — the difference is
 * which `AuthConfig.mode` the server boots in, not two identity models.
 *
 * MFA fields are present but not yet enforced. SMS step-up (`H-MFA`) writes to
 * `mfa.*`; nothing reads it as a gate yet, so a half-built MFA flow can never
 * lock the owner out of their own data before it is finished.
 */

export type Role = "user" | "admin";

/** The one implicit account in single-user mode, and the seed admin otherwise. */
export const OWNER_USER_ID = "usr_owner";

export type MfaState = {
  enabled: boolean;
  method: "sms" | null;
  /** E.164, e.g. +14155550123. Stored only once verified for a real send. */
  phoneE164: string | null;
  phoneVerified: boolean;
};

export type User = {
  id: string;
  /** Normalised to lowercase; unique across users. */
  email: string;
  displayName: string;
  role: Role;
  /** scrypt-encoded. Empty string means "no password set" (owner in single-user
   *  mode before one is chosen) — such a user can never pass password login. */
  passwordHash: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  mfa: MfaState;
};

/** What leaves the server. Never carries the password hash. */
export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
  mfa: { enabled: boolean; method: "sms" | null; phoneVerified: boolean };
};

export type Session = {
  /** sha256 of the bearer token. The raw token is returned to the client once
   *  and never stored, so a dump of the session store cannot be replayed. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
};

/**
 * The resolved caller on a request. `owner: true` marks the synthesised
 * principal used in single-user mode, where there is no real session but every
 * request still acts as exactly one isolated user.
 */
export type Principal = {
  userId: string;
  role: Role;
  sessionToken?: string;
  owner?: boolean;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    mfa: { enabled: user.mfa.enabled, method: user.mfa.method, phoneVerified: user.mfa.phoneVerified },
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
