import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AuthError } from "../auth/errors";
import { PlaidAdapterError } from "../plaid/errors";

const registeredApps = new WeakSet<FastifyInstance>();

export function registerSafeErrorHandler(app: FastifyInstance): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }

    if (error instanceof PlaidAdapterError) {
      return reply.code(error.safe.statusCode ?? 502).send({ error: error.safe });
    }

    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          issues: error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      });
    }

    // Fastify-native client errors (body too large -> 413, unsupported media
    // type -> 415, malformed content -> 400, etc.) carry their own 4xx
    // statusCode and a safe, generic message. Preserve them instead of masking
    // a client mistake as a 500 the client would retry forever. Their `code`
    // (e.g. FST_ERR_CTP_BODY_TOO_LARGE) is framework-generic, not internal.
    const err = error as { statusCode?: number; code?: string; message?: string };
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: { code: err.code ?? "BAD_REQUEST", message: err.message },
      });
    }

    // Anything else is an unexpected server fault: 500 with no internals leaked.
    return reply.code(500).send({ error: { code: "INTERNAL_SERVER_ERROR" } });
  });
}
