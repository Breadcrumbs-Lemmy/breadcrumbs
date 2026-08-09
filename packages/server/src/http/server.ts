import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { join } from "node:path";

import { createPlaidClient } from "../plaid/client";
import type { PlaidConfig } from "../plaid/config";
import { loadFieldCipher } from "../crypto/field-cipher";
import type { FieldCipher } from "../crypto/field-cipher";
import { FilePlaidTokenStore, InMemoryPlaidTokenStore } from "../plaid/token-store";
import type { PlaidClientLike } from "../plaid/adapter";
import type { PlaidTokenStore } from "../plaid/token-store";
import type { StatementImportStore } from "../local/store";
import {
  FileStatementImportStoreProvider,
  SingleStatementImportStoreProvider,
  defaultLocalDataDir,
} from "../local/store-provider";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { FileAgentMemoryProvider, InMemoryAgentMemoryProvider } from "../agent/memory/provider";
import type { AgentMemoryProvider } from "../agent/memory/provider";
import { buildAuthService } from "../auth/build";
import type { AuthPersistence } from "../auth/build";
import { loadAuthConfig } from "../auth/config";
import type { AuthConfig } from "../auth/config";
import { createAuthHook } from "../auth/middleware";
import type { AuthService } from "../auth/service";
import { loadAgentConfig, describeAgentConfigConcerns } from "../agent/config";
import { registerAffordabilityRoutes } from "./affordability-routes";
import { registerAgentRoutes } from "./agent-routes";
import { registerAuthRoutes } from "./auth-routes";
import { registerLocalRoutes } from "./local-routes";
import { registerSpendingRoutes } from "./spending-routes";
import { registerPlaidRoutes } from "./plaid-routes";

export type CreateServerOptions = {
  plaidConfig?: PlaidConfig;
  plaidClient?: PlaidClientLike;
  plaidTokenStore?: PlaidTokenStore;
  /** Back-compat single-store injection. Wrapped in a provider that hands the
   *  same store to every caller — correct for single-user runs and tests that
   *  never authenticate as more than one user. Ignored when `stores` is given. */
  statementImportStore?: StatementImportStore;
  /** Per-user store isolation. When present, wins over `statementImportStore`. */
  stores?: StatementImportStoreProvider;
  /** Per-user assistant memory. Injected in tests; otherwise built to match the
   *  same ephemeral/persistent choice the stores use. */
  agentMemory?: AgentMemoryProvider;
  /** Identity service. Inject one in tests or from `main` so the boot sequence
   *  can seed the owner; otherwise it is built from `authConfig`. */
  authService?: AuthService;
  authConfig?: AuthConfig;
  authPersistence?: AuthPersistence;
  allowedCorsOrigins?: string[];
  /** Global request rate limit. Defaults to a generous per-IP cap in every
   *  environment except `test` (so the suite never trips it). Pass `false` to
   *  disable, or an override to tune `max`/`timeWindow`. */
  rateLimit?: { max?: number; timeWindow?: string } | false;
  /** Max request body size in bytes. Defaults to 12 MiB to admit a large PDF
   *  statement while still rejecting a body sent to exhaust memory. */
  bodyLimit?: number;
};

const DEFAULT_BODY_LIMIT = 12 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_RATE_LIMIT_WINDOW = "1 minute";

export async function createServer(configOrOptions: PlaidConfig | CreateServerOptions = {}) {
  const options = normalizeCreateServerOptions(configOrOptions);
  const app = fastify({ logger: false, bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT });

  await registerRateLimit(app, options.rateLimit);

  registerCors(app, options.allowedCorsOrigins ?? []);

  // Identity gate, resolved in one place for every request. In single-user mode
  // (the default) every request is the owner and no token is required; in
  // multi-user mode a live session is demanded for every `/api` route not on the
  // public allowlist. Registered after CORS so a 401 still carries CORS headers,
  // and before the data routes so `request.principal` is set by the time a
  // handler runs and calls `principalOf`.
  // A caller that injects a concrete store wants the ephemeral, test-shaped
  // server: identity stays in-memory so a test never writes users or sessions
  // into the real `~/.breadcrumbs`. A bare `createServer()` (as `main.ts` calls
  // it) persists identity to disk so accounts survive a restart.
  const ephemeral = Boolean(options.statementImportStore) || Boolean(options.stores);
  // One encryption key, loaded once, protects everything at rest: the per-user
  // transaction store, the Plaid access tokens, and TOTP secrets. On a real
  // (persistent) server with no key, financial data is stored behind file
  // permissions only — warn loudly, once, since a production box should set one.
  const fieldCipher = loadFieldCipher(process.env);
  if (!ephemeral && !fieldCipher) {
    console.warn(
      "[security] WARNING: BREADCRUMBS_ENCRYPTION_KEY is not set — imported financial " +
        "data and Plaid access tokens are stored WITHOUT application-level encryption " +
        "(file permissions only). Set a 32-byte key (openssl rand -base64 32) to encrypt at rest.",
    );
  }
  const authService =
    options.authService ??
    buildAuthService(options.authConfig ?? loadAuthConfig(), {
      persistence: options.authPersistence ?? (ephemeral ? "memory" : "file"),
      cipher: fieldCipher,
    });
  // Guarantee the owner account exists in single-user mode, where it is the one
  // account the whole app runs as. Idempotent, so a pre-seeded injected service
  // (as `main.ts` provides) is unaffected. Deliberately NOT done in multi-user
  // mode: a passwordless seed there would make `users.count()` non-zero and rob
  // the first real registrant of the bootstrap admin role, leaving a deployment
  // with an admin that cannot log in and no user who can administer it.
  if (authService.config.mode === "single_user") {
    await authService.ensureOwner();
  }
  app.addHook("onRequest", createAuthHook(authService));

  const agentConfig = loadAgentConfig();
  // Say the risky configurations out loud, once, at boot — chiefly a local
  // (offline) chat model paired with a HOSTED extractor, where statement text
  // leaves the machine on import even though chat does not.
  if (agentConfig) {
    for (const concern of describeAgentConfigConcerns(agentConfig)) {
      console.warn(`[agent] ${concern}`);
    }
  }
  app.get("/health", async () => ({
    status: "ok",
    plaidEnv: options.plaidConfig?.env ?? "disabled",
    localImports: "enabled",
    authMode: authService.config.mode,
    agent: agentConfig ? (agentConfig.provider === "local" ? "local" : "enabled") : "disabled",
  }));

  // One provider resolves a per-user store on each request, so a handler can only
  // ever reach the store for its authenticated principal — cross-user reads are
  // impossible by construction rather than by remembering a `WHERE user_id = ?`.
  // The spending endpoints still read exactly what the import endpoints wrote for
  // the same user, so the screens and the importer can never disagree. The same
  // `fieldCipher` loaded above encrypts the transaction store and Plaid tokens.
  const stores = resolveStoreProvider(options, fieldCipher);
  // The assistant's memory follows the same isolation seam as the stores, and
  // the same ephemeral/persistent choice: an injected store means a test-shaped
  // server whose memory stays in RAM; a bare `createServer()` persists memory to
  // disk under the user's data directory, next to their imported statements.
  const agentMemory = options.agentMemory ?? (ephemeral ? new InMemoryAgentMemoryProvider() : new FileAgentMemoryProvider());

  // Bank connections persist to disk for a real server (so a restart doesn't
  // un-link every user's bank) and stay in RAM for an ephemeral/test server.
  // Built here, above the auth routes, so account deletion can erase a user's
  // stored bank tokens too. Only exists when Plaid is configured. Reuses the
  // same at-rest key loaded above (see the [security] warning).
  const plaidTokenStore = options.plaidConfig
    ? options.plaidTokenStore ??
      (ephemeral
        ? new InMemoryPlaidTokenStore()
        : new FilePlaidTokenStore(join(defaultLocalDataDir(), "plaid", "connections.json"), fieldCipher))
    : undefined;

  // Full per-user erasure for account deletion: the auth service removes the
  // identity (user record + sessions); this wipes everything a user's id owns in
  // the data stores. Best-effort and idempotent — each store's eraser tolerates
  // "nothing there". Memory is erased before the statement store because the
  // latter removes the whole `users/<id>/` directory the memory lives under.
  const eraseUserData = async (userId: string): Promise<void> => {
    await agentMemory.eraseForUser?.(userId);
    await stores.eraseForUser?.(userId);
    await plaidTokenStore?.deleteAllForUser(userId);
  };

  await registerAuthRoutes(app, { service: authService, eraseUserData });
  await registerAffordabilityRoutes(app, { stores });
  await registerLocalRoutes(app, { stores });
  await registerSpendingRoutes(app, { stores });
  await registerAgentRoutes(app, { stores, memory: agentMemory });

  if (options.plaidConfig && plaidTokenStore) {
    await registerPlaidRoutes(app, {
      client: options.plaidClient ?? createPlaidClient(options.plaidConfig),
      config: options.plaidConfig,
      tokenStore: plaidTokenStore,
      stores,
    });
  }

  return app;
}

function resolveStoreProvider(
  options: CreateServerOptions,
  cipher?: FieldCipher,
): StatementImportStoreProvider {
  if (options.stores) return options.stores;
  if (options.statementImportStore) return new SingleStatementImportStoreProvider(options.statementImportStore);
  return new FileStatementImportStoreProvider(defaultLocalDataDir(), cipher);
}

function normalizeCreateServerOptions(configOrOptions: PlaidConfig | CreateServerOptions): CreateServerOptions {
  if ("env" in configOrOptions) return { plaidConfig: configOrOptions };
  return configOrOptions;
}

/**
 * Global per-IP rate limit. A blanket ceiling that lets normal use through
 * while denying a script that hammers login or the agent endpoint. Skipped in
 * the `test` environment and when the caller passes `rateLimit: false`. A 429
 * is returned through the same safe error shape as everything else.
 */
async function registerRateLimit(
  app: FastifyInstance,
  override: CreateServerOptions["rateLimit"],
): Promise<void> {
  if (override === false) return;
  if (process.env.NODE_ENV === "test" && override === undefined) return;
  await app.register(rateLimit, {
    max: override?.max ?? DEFAULT_RATE_LIMIT_MAX,
    timeWindow: override?.timeWindow ?? DEFAULT_RATE_LIMIT_WINDOW,
    // Keep the rejection body consistent with the rest of the API.
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests. Retry in ${context.after}.`,
      },
    }),
  });
}

function registerCors(app: FastifyInstance, explicitOrigins: string[]): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin && isAllowedOrigin(origin, explicitOrigins)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "content-type,authorization");
      // The session also rides in an httpOnly cookie; the browser only sends it
      // cross-origin when credentials are explicitly allowed.
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
  });

  app.options("/api/*", async (_request: FastifyRequest, reply: FastifyReply) => reply.code(204).send());
}

function isAllowedOrigin(origin: string, explicitOrigins: string[]): boolean {
  if (explicitOrigins.includes(origin)) return true;
  // Loopback origins are convenient in development but must not be blanket-
  // trusted in production, where a browser reaching a plaintext localhost origin
  // with credentials is either a misconfiguration or an attacker on the host.
  // In production only the explicit allowlist above is honored.
  if (process.env.NODE_ENV === "production") return false;
  return (
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/\[::1\]:\d+$/.test(origin)
  );
}
