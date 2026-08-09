/**
 * Agent endpoints.
 *
 * `/status` is always registered, even with no provider, so the UI can render an
 * accurate "not configured" state instead of discovering the gap through a 404.
 * The endpoints that cost money or need a model are registered only when a
 * provider exists — the same shape as the Plaid routes, and the same reason: the
 * product works without them.
 *
 * The memory endpoints are the exception: uploading learning material, browsing
 * saved facts, and reading past conversations don't need the model, so they are
 * available whenever a memory store is wired — a user can hand the assistant
 * files to learn from before turning the model on. Every one of them resolves
 * memory for `request.principal.userId`, so a caller can only ever touch their
 * own facts, files, and conversations.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { loadAgentConfig } from "../agent/config";
import { runAgentChat } from "../agent/chat";
import { extractStatement } from "../agent/statement-extraction";
import type { AgentMemoryProvider } from "../agent/memory/provider";
import { principalOf } from "../auth/middleware";
import type { StatementImportStoreProvider } from "../local/store-provider";
import { registerSafeErrorHandler } from "./errors";

export const AGENT_STATUS_PATH = "/api/v1/agent/status";
export const AGENT_CHAT_PATH = "/api/v1/agent/chat";
export const AGENT_EXTRACT_PATH = "/api/v1/agent/statement-extract";
export const AGENT_MEMORY_FACTS_PATH = "/api/v1/agent/memory/facts";
export const AGENT_MEMORY_FILES_PATH = "/api/v1/agent/memory/files";
export const AGENT_MEMORY_CONVERSATIONS_PATH = "/api/v1/agent/memory/conversations";

/** What the user is currently looking at, forwarded from the browser so the
 *  assistant scopes its answer to the view. Every field is optional and bounded;
 *  an unknown extra is stripped rather than rejected, so an older client that
 *  sends no scope, or a newer one that adds a field, both keep working. */
const ScopeSchema = z.object({
  route: z.string().max(40).optional(),
  screen: z.string().max(120).optional(),
  period: z
    .object({
      kind: z.enum(["week", "month", "year", "statement"]),
      key: z.string().max(40).optional(),
      label: z.string().max(120).optional(),
    })
    .optional(),
  account: z
    .object({
      id: z.string().max(160),
      label: z.string().max(160).optional(),
    })
    .optional(),
  notes: z.array(z.string().max(240)).max(8).optional(),
});

const ChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  currency: z.string().length(3).default("USD"),
  /** Continue a stored conversation; omit to begin a new one. */
  conversationId: z.string().min(1).max(120).optional(),
  /** The user's current view; scopes the answer to the screen. Optional. */
  scope: ScopeSchema.optional(),
});

/** 12 MB of base64 is roughly a 9 MB PDF — comfortably more than a statement,
 *  and well under the API's own 32 MB request ceiling. */
const MAX_PDF_BASE64_LENGTH = 12_000_000;

const ExtractBodySchema = z
  .object({
    pdfBase64: z.string().min(1).max(MAX_PDF_BASE64_LENGTH).optional(),
    text: z.string().min(1).max(400_000).optional(),
  })
  .refine((body) => Boolean(body.pdfBase64) !== Boolean(body.text), {
    message: "Provide exactly one of pdfBase64 or text.",
  });

/** Learning material is stored as text — a couple of MB is generous for the
 *  notes, exports, and statements a user hands the assistant to learn from. */
const MAX_FILE_TEXT_LENGTH = 2_000_000;

const UploadFileSchema = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(120).default("text/plain"),
  text: z.string().min(1).max(MAX_FILE_TEXT_LENGTH),
});

const AddFactSchema = z.object({
  text: z.string().min(1).max(2000),
  kind: z.enum(["fact", "preference"]).default("fact"),
});

export type RegisterAgentRoutesOptions = {
  stores: StatementImportStoreProvider;
  /** Per-user assistant memory. When present, memory endpoints are registered
   *  and chat gets long-term recall + conversation persistence. */
  memory?: AgentMemoryProvider;
};

export async function registerAgentRoutes(
  app: FastifyInstance,
  options: RegisterAgentRoutesOptions,
): Promise<void> {
  const config = loadAgentConfig();
  const memoryProvider = options.memory;

  app.get(AGENT_STATUS_PATH, async () => {
    const capabilities: string[] = [];
    if (config) capabilities.push("chat");
    if (config?.supportsStatementExtraction) capabilities.push("statement_extraction");
    if (memoryProvider) capabilities.push("memory");

    // Extraction can run on a different provider than chat, so its provider,
    // model, and offline status are reported separately. `offline` is the CHAT
    // guarantee; `extractionOffline` is the import-time one. Collapsing them into
    // a single flag would lie whenever chat is local but extraction is hosted —
    // statement text leaves the machine on import even though chat never does.
    const extractionProvider = config ? (config.extractionProvider ?? config.provider) : null;

    return {
      configured: Boolean(config),
      provider: config?.provider ?? null,
      // The headline guarantee for the local provider, surfaced so the UI can
      // tell the user their chat never leaves the machine.
      offline: config?.provider === "local",
      model: config?.model ?? null,
      // Where statement extraction runs, and whether IT stays on the machine.
      extractionProvider,
      extractionModel: config ? (config.extractionModel ?? config.model) : null,
      extractionOffline: extractionProvider ? extractionProvider === "local" : null,
      memory: Boolean(memoryProvider),
      capabilities,
      // Stated rather than implied: the agent reads the deterministic engine's
      // output and cannot write, move money, or compute a figure itself.
      boundaries: [
        "READ_ONLY_DECISION_SUPPORT",
        "NOT_PERSONALIZED_FINANCIAL_ADVICE",
        "NO_ACCOUNT_WRITES",
        "FIGURES_FROM_DETERMINISTIC_ENGINE",
      ],
      ...(config
        ? {}
        : {
            reason:
              "Set ANTHROPIC_API_KEY for the hosted assistant, or BREADCRUMBS_AGENT_PROVIDER=local with BREADCRUMBS_LOCAL_AGENT_BASE_URL for a local, offline one.",
          }),
    };
  });

  if (config) {
    app.post(AGENT_CHAT_PATH, async (request, reply) => {
      const body = ChatBodySchema.parse(request.body);
      const userId = principalOf(request).userId;
      const store = await options.stores.forUser(userId);
      const memory = memoryProvider ? await memoryProvider.forUser(userId) : undefined;

      const result = await runAgentChat({
        config,
        context: { store, currency: body.currency, memory, scope: body.scope },
        messages: body.messages,
        conversationId: body.conversationId,
      });

      if (result.kind === "error") return reply.code(502).send({ error: result });
      return result;
    });

    // Statement transcription is gated on `supportsStatementExtraction`, true for
    // both providers: the hosted model reads the PDF bytes directly, and for the
    // local model the server extracts the PDF's text layer and sends only text.
    // A provider that cannot transcribe at all leaves the route unregistered.
    if (config.supportsStatementExtraction) {
      app.post(AGENT_EXTRACT_PATH, async (request, reply) => {
        const body = ExtractBodySchema.parse(request.body);
        const result = await extractStatement({
          config,
          document: body.pdfBase64
            ? { kind: "pdf", base64: body.pdfBase64 }
            : { kind: "text", text: body.text ?? "" },
        });

        if (result.kind === "error") return reply.code(502).send({ error: result });
        return result;
      });
    }
  }

  if (memoryProvider) {
    registerMemoryRoutes(app, memoryProvider);
  }

  registerSafeErrorHandler(app);
}

/** The memory surface — long-term facts, uploaded learning material, and past
 *  conversations. Model-independent, and always scoped to the caller. */
function registerMemoryRoutes(app: FastifyInstance, memoryProvider: AgentMemoryProvider): void {
  const memoryFor = (request: FastifyRequest) =>
    Promise.resolve(memoryProvider.forUser(principalOf(request).userId));

  app.get(AGENT_MEMORY_FACTS_PATH, async (request) => {
    const memory = await memoryFor(request);
    return { facts: await memory.listFacts() };
  });

  app.post(AGENT_MEMORY_FACTS_PATH, async (request, reply) => {
    const body = AddFactSchema.parse(request.body);
    const memory = await memoryFor(request);
    const fact = await memory.addFact({ text: body.text, kind: body.kind, source: "user" });
    return reply.code(201).send({ fact });
  });

  app.delete(`${AGENT_MEMORY_FACTS_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = await memoryFor(request);
    const removed = await memory.deleteFact(id);
    if (!removed) return reply.code(404).send({ error: { message: "No such fact." } });
    return { deleted: true };
  });

  app.get(AGENT_MEMORY_FILES_PATH, async (request) => {
    const memory = await memoryFor(request);
    return { files: await memory.listFiles() };
  });

  app.post(AGENT_MEMORY_FILES_PATH, async (request, reply) => {
    const body = UploadFileSchema.parse(request.body);
    const memory = await memoryFor(request);
    const file = await memory.addFile({ name: body.name, mediaType: body.mediaType, text: body.text });
    return reply.code(201).send({ file });
  });

  app.get(`${AGENT_MEMORY_FILES_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = await memoryFor(request);
    const text = await memory.getFileText(id);
    if (text === undefined) return reply.code(404).send({ error: { message: "No such file." } });
    return { id, text };
  });

  app.delete(`${AGENT_MEMORY_FILES_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = await memoryFor(request);
    const removed = await memory.deleteFile(id);
    if (!removed) return reply.code(404).send({ error: { message: "No such file." } });
    return { deleted: true };
  });

  app.get(AGENT_MEMORY_CONVERSATIONS_PATH, async (request) => {
    const memory = await memoryFor(request);
    return { conversations: await memory.listConversations() };
  });

  app.get(`${AGENT_MEMORY_CONVERSATIONS_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = await memoryFor(request);
    const conversation = await memory.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: { message: "No such conversation." } });
    return { conversation };
  });

  app.delete(`${AGENT_MEMORY_CONVERSATIONS_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memory = await memoryFor(request);
    const removed = await memory.deleteConversation(id);
    if (!removed) return reply.code(404).send({ error: { message: "No such conversation." } });
    return { deleted: true };
  });
}
