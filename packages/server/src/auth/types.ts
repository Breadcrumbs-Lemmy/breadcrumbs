/**
 * Identity types for Breadcrumbs.
 *
 * The product's first user is its owner tracking their own spending, so the
 * default posture is single-user and login-free (`mode: "single_user"`). The
 * same types carry the multi-user, per-user-isolated deployment where an admin
 * manages accounts and no user can read another's data — the difference is
 * which `AuthConfig.mode` the server boots in, not two identity models.
 *
 * MFA is TOTP-based (authenticator app; see `auth/totp.ts`) and gates Plaid Link
 * for multi-user sessions. Enrollment is two-step: a secret is generated and
 * stored (`totpSecret` set, `enabled: false`) but only becomes a real factor
 * once the user proves possession with a first valid code (`enabled: true`).
 * Until then nothing reads it as a gate, so a half-built MFA flow can never lock
 * the owner out of their own data before it is finished. The secret is the only
 * sensitive field and is encrypted at rest by the auth service.
 */

export type Role = "user" | "admin";

/** The one implicit account in single-user mode, and the seed admin otherwise. */
export const OWNER_USER_ID = "usr_owner";

/**
 * The version of the Privacy Policy and Terms a user consents to at sign-up.
 * Both documents share this "Effective date"; bump it when either changes
 * materially so a future flow can require re-consent. This value is the anchor
 * the consent record points at, so we can always say *what* was agreed to.
 */
export const CURRENT_POLICY_VERSION = "2026-08-09";

/**
 * An affirmative, recorded agreement to the Privacy Policy and Terms of Service,
 * captured the instant an account is created. Its presence — with a version and
 * a timestamp — is the evidence that consent for data collection, processing,
 * and storage was obtained, rather than assumed from mere use of the app.
 */
export type ConsentRecord = {
  /** The {@link CURRENT_POLICY_VERSION} in force when the user agreed. */
  policyVersion: string;
  /** ISO timestamp the user ticked the box and submitted registration. */
  agreedAt: string;
};

export type MfaState = {
  enabled: boolean;
  method: "totp" | null;
  /** base32 TOTP shared secret. Encrypted at rest by the auth service, held in
   *  plaintext only in memory. Present once enrollment starts; a user is only
   *  challenged once `enabled` flips true after the first verified code. */
  totpSecret: string | null;
  /** ISO timestamp the second factor was confirmed working (first valid code). */
  enrolledAt: string | null;
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
  /** The user's recorded agreement to the Privacy Policy and Terms, captured at
   *  registration. `null` for accounts provisioned outside the sign-up flow (the
   *  single-user owner, admin-created users) that never saw the consent step. */
  consent?: ConsentRecord | null;
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
  /** `pending` = enrollment started (secret issued) but no code verified yet. */
  mfa: { enabled: boolean; method: "totp" | null; pending: boolean };
  /** The recorded Privacy Policy / Terms agreement, or `null` if this account
   *  never went through the consent step. Surfaced so `/auth/me` and the admin
   *  view can show whether (and to which version) a user consented. */
  consent?: ConsentRecord | null;
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
  /** ISO timestamp this session last cleared the TOTP challenge. Absent until
   *  the user completes step-up; drives the time-boxed Plaid Link gate so a
   *  stolen session token alone cannot reach Link without a fresh code. */
  mfaVerifiedAt?: string;
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
  /** Whether this user has an enabled TOTP factor. */
  mfaEnabled?: boolean;
  /** ms-epoch this session last cleared the TOTP challenge, if ever. The Plaid
   *  gate reads this to decide whether step-up is still fresh. */
  mfaVerifiedAt?: number;
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
    mfa: {
      enabled: user.mfa.enabled,
      method: user.mfa.method,
      pending: !user.mfa.enabled && user.mfa.totpSecret !== null,
    },
    consent: user.consent ?? null,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
