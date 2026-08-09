/**
 * Auth and admin endpoints.
 *
 * The session token is returned in the JSON body (for a bearer-holding SPA) and
 * also set as an httpOnly cookie, so a browser is protected from token theft via
 * script while a non-browser client can still use the header. No password hash
 * or raw token is ever logged or echoed back.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { loadAgentConfig } from "../agent/config";
import { bearerToken, principalOf, requireAdmin } from "../auth/middleware";
import type { AuthService } from "../auth/service";
import { toPublicUser } from "../auth/types";
import { registerSafeErrorHandler } from "./errors";

const CredentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
  displayName: z.string().min(1).max(120).optional(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().max(1024).default(""),
  newPassword: z.string().min(1).max(1024),
});

const AdminCreateSchema = CredentialsSchema.extend({
  role: z.enum(["user", "admin"]).default("user"),
});

/** A 6-digit authenticator code. Kept loose (whitespace tolerated) — the TOTP
 *  verifier normalizes and rejects anything malformed as a plain wrong code. */
const MfaCodeSchema = z.object({ code: z.string().min(1).max(16) });

const RoleSchema = z.object({ role: z.enum(["user", "admin"]) });
const StatusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const ResetPasswordSchema = z.object({ newPassword: z.string().min(1).max(1024) });
const UserIdParams = z.object({ id: z.string().min(1) });

export type RegisterAuthRoutesOptions = { service: AuthService };

export async function registerAuthRoutes(app: FastifyInstance, options: RegisterAuthRoutesOptions): Promise<void> {
  const { service } = options;
  registerSafeErrorHandler(app);

  /** Public: what the sign-in screen needs to decide what to render. */
  app.get("/api/v1/auth/context", async () => ({
    mode: service.config.mode,
    registrationOpen: service.config.registrationOpen,
    assistantConfigured: Boolean(loadAgentConfig()),
  }));

  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = CredentialsSchema.parse(request.body);
    const { user, token } = await service.register({ ...body, userAgent: request.headers["user-agent"] });
    return sendSession(reply, token, { user: toPublicUser(user), token });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = CredentialsSchema.parse(request.body);
    const { user, token } = await service.login({ ...body, userAgent: request.headers["user-agent"] });
    return sendSession(reply, token, { user: toPublicUser(user), token });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (token) await service.logout(token);
    reply.header("set-cookie", clearedCookie());
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (request) => {
    const principal = principalOf(request);
    const user = await service.getUser(principal.userId);
    return { user: user ? toPublicUser(user) : null, mode: service.config.mode };
  });

  app.post("/api/v1/auth/change-password", async (request) => {
    const principal = principalOf(request);
    const body = ChangePasswordSchema.parse(request.body);
    await service.changePassword(principal.userId, body.currentPassword, body.newPassword);
    return { ok: true };
  });

  // ---- Multi-factor (TOTP) -------------------------------------------------
  // Step-up model: enrolling and clearing a challenge stamp the *session*, and
  // the Plaid Link routes refuse to mint a link token until the session has
  // cleared MFA recently. Enrollment can never lock the owner out — the factor
  // is inert until a first code is verified.

  /** Begin enrollment: returns the secret + otpauth URI for the QR code. The
   *  secret is shown once, here, so the user can add it to their app. */
  app.post("/api/v1/auth/mfa/enroll", async (request) => {
    const principal = principalOf(request);
    const { secret, otpauthUri } = await service.beginMfaEnrollment(principal.userId);
    return { secret, otpauthUri };
  });

  /** Confirm enrollment with the first code; turns the factor on. */
  app.post("/api/v1/auth/mfa/enroll/verify", async (request) => {
    const principal = principalOf(request);
    const { code } = MfaCodeSchema.parse(request.body);
    const user = await service.verifyMfaEnrollment(principal.userId, code, principal.sessionToken);
    return { user: toPublicUser(user) };
  });

  /** Step-up: clear the challenge for an already-enrolled session (e.g. before
   *  Plaid Link) without a full re-login. */
  app.post("/api/v1/auth/mfa/challenge", async (request) => {
    const principal = principalOf(request);
    const { code } = MfaCodeSchema.parse(request.body);
    // In single-user mode there is no session to stamp; the owner principal
    // bypasses the Plaid gate anyway, so treat a challenge as a no-op success.
    if (!principal.sessionToken) return { ok: true };
    await service.verifyMfaChallenge(principal.userId, code, principal.sessionToken);
    return { ok: true };
  });

  /** Turn MFA off (requires a current code). */
  app.post("/api/v1/auth/mfa/disable", async (request) => {
    const principal = principalOf(request);
    const { code } = MfaCodeSchema.parse(request.body);
    const user = await service.disableMfa(principal.userId, code);
    return { user: toPublicUser(user) };
  });

  // ---- Admin ---------------------------------------------------------------

  app.get("/api/v1/admin/users", async (request) => {
    requireAdmin(request);
    const users = await service.listUsers();
    return { users: users.map(toPublicUser) };
  });

  app.post("/api/v1/admin/users", async (request, reply) => {
    requireAdmin(request);
    const body = AdminCreateSchema.parse(request.body);
    const user = await service.adminCreateUser({ ...body });
    return reply.code(201).send({ user: toPublicUser(user) });
  });

  app.patch("/api/v1/admin/users/:id/role", async (request) => {
    requireAdmin(request);
    const { id } = UserIdParams.parse(request.params);
    const { role } = RoleSchema.parse(request.body);
    return { user: toPublicUser(await service.setRole(id, role)) };
  });

  app.patch("/api/v1/admin/users/:id/status", async (request) => {
    requireAdmin(request);
    const { id } = UserIdParams.parse(request.params);
    const { status } = StatusSchema.parse(request.body);
    return { user: toPublicUser(await service.setStatus(id, status)) };
  });

  app.post("/api/v1/admin/users/:id/reset-password", async (request) => {
    requireAdmin(request);
    const { id } = UserIdParams.parse(request.params);
    const { newPassword } = ResetPasswordSchema.parse(request.body);
    await service.adminResetPassword(id, newPassword);
    return { ok: true };
  });

  app.get("/api/v1/admin/config", async (request) => {
    requireAdmin(request);
    return {
      mode: service.config.mode,
      registrationOpen: service.config.registrationOpen,
      sessionTtlDays: Math.round(service.config.sessionTtlMs / (24 * 60 * 60 * 1000)),
      assistant: { configured: Boolean(loadAgentConfig()) },
      userCount: (await service.listUsers()).length,
    };
  });
}

/** Body carries the token for header-based clients; the cookie protects browsers. */
function sendSession(reply: FastifyReply, token: string, body: unknown) {
  reply.header("set-cookie", sessionCookie(token));
  return reply.send(body);
}

/**
 * Whether to mark the session cookie `Secure` (browser only sends it over
 * HTTPS). On in production so the session token cannot leak over a plaintext
 * hop; off by default in development so it still works over http://localhost.
 * `BREADCRUMBS_FORCE_SECURE=true` forces it on when TLS terminates upstream and
 * NODE_ENV is not literally "production".
 */
function cookieIsSecure(): boolean {
  return process.env.NODE_ENV === "production" || process.env.BREADCRUMBS_FORCE_SECURE === "true";
}

function sessionCookie(token: string): string {
  // Lax lets top-level navigations carry the cookie without exposing it to
  // cross-site POSTs.
  const secure = cookieIsSecure() ? "; Secure" : "";
  return `bc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`;
}

function clearedCookie(): string {
  const secure = cookieIsSecure() ? "; Secure" : "";
  return `bc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
