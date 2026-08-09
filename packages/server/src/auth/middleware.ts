/**
 * Request authentication, enforced in one place.
 *
 * A single `onRequest` hook resolves the caller for every `/api` request and
 * rejects unauthenticated access to anything not on the public allowlist. Doing
 * it here rather than per-route means there is exactly one gate to audit, and a
 * new data route is protected by default — you have to *opt out* (add it to the
 * allowlist) to make something public, which is the safe direction to fail.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthError, authErrors } from "./errors";
import type { AuthService } from "./service";
import type { Principal } from "./types";

declare module "fastify" {
  interface FastifyRequest {
    /** The resolved caller. Present on every protected route; the hook 401s
     *  before a handler runs if it could not be resolved. */
    principal?: Principal;
  }
}

/** Paths reachable without a session. Everything else under `/api` needs one. */
const PUBLIC_PATHS = new Set<string>([
  "/health",
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/context",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Agent status advertises capability to a signed-out login screen; harmless.
  return pathname === "/api/v1/agent/status";
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  const cookie = request.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "bc_session") return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

export function createAuthHook(service: AuthService) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // CORS preflight carries no credentials and is answered elsewhere.
    if (request.method === "OPTIONS") return;

    const pathname = request.url.split("?")[0] ?? request.url;
    if (!pathname.startsWith("/api")) return;

    // Single-user mode: every request is the owner, no token required. The data
    // it reaches is still the owner's own isolated store.
    if (service.config.mode === "single_user") {
      request.principal = service.ownerPrincipal();
      return;
    }

    const token = bearerToken(request);
    const principal = token ? await service.authenticateToken(token) : undefined;
    if (principal) {
      request.principal = principal;
      return;
    }

    if (isPublic(pathname)) return;
    void reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
  };
}

/** For handlers: the caller, guaranteed. Throws if somehow reached unauthenticated. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw authErrors.unauthenticated();
  return request.principal;
}

export function requireAdmin(request: FastifyRequest): Principal {
  const principal = principalOf(request);
  if (principal.role !== "admin") throw authErrors.forbidden();
  return principal;
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
