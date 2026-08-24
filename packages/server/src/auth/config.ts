/**
 * Auth configuration and the mode switch that decides how much identity the
 * product enforces.
 *
 *   single_user  (default) — one implicit owner. No login screen, no friction;
 *                 the app tracks the owner's own money. Every request acts as
 *                 the owner, and their data is still isolated from any future
 *                 user should the mode change.
 *   multi_user   — real registration and login. Every data request needs a live
 *                 session, users cannot read each other's data, and an admin
 *                 manages accounts. This is the deployed, shared posture.
 *
 * Default is single_user because that is the product's first and primary use.
 * The server logs loudly at boot which mode it is in, so a shared deployment
 * that forgot to set multi_user is obvious rather than silent.
 */
export type AuthMode = "single_user" | "multi_user";

export type AuthConfig = {
  mode: AuthMode;
  sessionTtlMs: number;
  /** multi_user only: whether the public register endpoint accepts new signups.
   *  Closed deployments provision users through the admin page instead. */
  registrationOpen: boolean;
  /** This email, if it registers, is made an admin. The very first account in a
   *  fresh multi_user deployment is also made admin so someone can get in. */
  ownerEmail?: string;
  passwordMinLength: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode: AuthMode = env.BREADCRUMBZ_AUTH_MODE?.trim() === "multi_user" ? "multi_user" : "single_user";
  const ttlDays = Number.parseInt(env.BREADCRUMBZ_SESSION_TTL_DAYS ?? "", 10);
  return {
    mode,
    sessionTtlMs: (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30) * DAY_MS,
    // Registration is open by default in multi_user so a fresh deployment is
    // usable; close it with BREADCRUMBZ_REGISTRATION=closed once seeded.
    registrationOpen: env.BREADCRUMBZ_REGISTRATION?.trim() !== "closed",
    ownerEmail: env.BREADCRUMBZ_OWNER_EMAIL?.trim()?.toLowerCase() || undefined,
    passwordMinLength: 8,
  };
}
