/**
 * The assistant's memory — per user, on disk, and readable without a model.
 *
 * Four layers, each answering a distinct need the product asked for:
 *
 *   long-term facts   Durable things worth remembering across every future
 *                     conversation: stated preferences, standing context, a
 *                     one-line summary of each uploaded file. Small, curated,
 *                     always in scope.
 *   short-term note   A single rolling scratchpad the assistant rewrites as a
 *                     conversation moves, so the working thread stays clear
 *                     without re-reading the whole history each turn.
 *   conversations     Every past turn, kept so the assistant can be reminded of
 *                     what was already discussed. History, not context — only a
 *                     relevant slice is ever loaded back in.
 *   uploaded files    Text the user handed the assistant to learn from. Stored
 *                     whole; retrieved by keyword so an offline model with a
 *                     finite context window sees only the passages that matter.
 *
 * Everything here is plain files under the user's own data directory. No
 * network, no embedding service, no database — the assistant's memory works with
 * the same offline guarantee the local model runs under, and a user can read or
 * delete any of it by opening a file.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "../../persistence/atomic-file";
import { sanitizeConversationTitle } from "../prompt-guard";

export type MemoryFactKind = "fact" | "preference" | "file_summary";

export type MemoryFact = {
  id: string;
  text: string;
  kind: MemoryFactKind;
  /** Where it came from — "user", "assistant", or `file:<id>`. */
  source: string;
  tags: string[];
  createdAt: string;
};

export type UploadedFile = {
  id: string;
  name: string;
  mediaType: string;
  charCount: number;
  uploadedAt: string;
  /** A short head of the text, enough to list and preview without loading the
   *  whole blob. The full text lives in a sibling file. */
  excerpt: string;
};

export type ConversationTurn = { role: "user" | "assistant"; content: string; at: string };

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
};

export type RetrievedFileSnippet = { fileId: string; name: string; snippet: string; score: number };

export type MemoryRetrieval = {
  facts: MemoryFact[];
  fileSnippets: RetrievedFileSnippet[];
};

export interface AgentMemoryStore {
  // Long-term facts
  listFacts(): Promise<MemoryFact[]>;
  addFact(input: { text: string; kind?: MemoryFactKind; source?: string; tags?: string[] }): Promise<MemoryFact>;
  deleteFact(id: string): Promise<boolean>;

  // Short-term scratchpad
  readShortTerm(): Promise<string>;
  writeShortTerm(text: string): Promise<void>;

  // Conversations
  listConversations(): Promise<Array<Omit<Conversation, "turns"> & { turnCount: number }>>;
  getConversation(id: string): Promise<Conversation | undefined>;
  appendTurns(conversationId: string | undefined, turns: ConversationTurn[], title?: string): Promise<Conversation>;
  /** Forget a whole conversation. Returns false when the id is unknown, so the
   *  route can 404 rather than silently claim success. */
  deleteConversation(id: string): Promise<boolean>;

  // Uploaded files (learning material)
  listFiles(): Promise<UploadedFile[]>;
  addFile(input: { name: string; mediaType: string; text: string }): Promise<UploadedFile>;
  getFileText(id: string): Promise<string | undefined>;
  deleteFile(id: string): Promise<boolean>;

  // Retrieval — offline keyword scoring over facts and file text
  retrieve(query: string, opts?: { maxFacts?: number; maxSnippets?: number }): Promise<MemoryRetrieval>;
}

// ---- Shared retrieval + id helpers -----------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "i", "me", "my", "you", "it", "this", "that", "with", "how", "what", "much", "did", "do", "does",
  "have", "has", "had", "be", "been", "at", "as", "by", "from", "about", "can", "could", "would",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/** Deterministic-ish id without a timestamp collision when many are created at
 *  once: a monotonic counter is threaded per store instance. */
function makeId(prefix: string, seq: number): string {
  return `${prefix}_${seq.toString(36)}_${Math.abs(hashString(`${prefix}${seq}`)).toString(36)}`;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return hash;
}

/** Score `haystack` against the query's keywords: number of distinct query
 *  terms present. Cheap, explainable, and good enough to pull the right facts
 *  and file passages without an embedding model. */
function keywordScore(queryTerms: Set<string>, haystack: string): number {
  if (queryTerms.size === 0) return 0;
  const present = new Set(tokenize(haystack).filter((term) => queryTerms.has(term)));
  return present.size;
}

/** Split file text into overlapping windows so a matched keyword returns a
 *  readable passage, not the whole document. */
function windows(text: string, size = 600, stride = 480): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}

function retrieveFrom(
  facts: MemoryFact[],
  files: Array<{ file: UploadedFile; text: string }>,
  query: string,
  opts?: { maxFacts?: number; maxSnippets?: number },
): MemoryRetrieval {
  const terms = new Set(tokenize(query));
  const maxFacts = opts?.maxFacts ?? 12;
  const maxSnippets = opts?.maxSnippets ?? 4;

  const scoredFacts = facts
    .map((fact) => ({ fact, score: keywordScore(terms, `${fact.text} ${fact.tags.join(" ")}`) }))
    // Preferences and standing facts are worth keeping even when nothing in the
    // question matches them, so a zero-score fact still passes if there's room.
    .sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt))
    .slice(0, maxFacts)
    .map((s) => s.fact);

  const snippets: RetrievedFileSnippet[] = [];
  for (const { file, text } of files) {
    let best: RetrievedFileSnippet | undefined;
    for (const window of windows(text)) {
      const score = keywordScore(terms, window);
      if (score > 0 && (!best || score > best.score)) {
        best = { fileId: file.id, name: file.name, snippet: window.trim(), score };
      }
    }
    if (best) snippets.push(best);
  }
  snippets.sort((a, b) => b.score - a.score);

  return { facts: scoredFacts, fileSnippets: snippets.slice(0, maxSnippets) };
}

const EXCERPT_CHARS = 280;

function excerptOf(text: string): string {
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}…`;
}

// ---- In-memory implementation (tests, ephemeral runs) ----------------------

export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private facts: MemoryFact[] = [];
  private shortTerm = "";
  private conversations = new Map<string, Conversation>();
  private files = new Map<string, { file: UploadedFile; text: string }>();
  private seq = 0;

  async listFacts(): Promise<MemoryFact[]> {
    return this.facts.map((f) => ({ ...f, tags: [...f.tags] }));
  }
  async addFact(input: { text: string; kind?: MemoryFactKind; source?: string; tags?: string[] }): Promise<MemoryFact> {
    const fact: MemoryFact = {
      id: makeId("mem", (this.seq += 1)),
      text: input.text.trim(),
      kind: input.kind ?? "fact",
      source: input.source ?? "assistant",
      tags: input.tags ?? [],
      createdAt: nowIso(this.seq),
    };
    this.facts.push(fact);
    return { ...fact, tags: [...fact.tags] };
  }
  async deleteFact(id: string): Promise<boolean> {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    return this.facts.length < before;
  }

  async readShortTerm(): Promise<string> {
    return this.shortTerm;
  }
  async writeShortTerm(text: string): Promise<void> {
    this.shortTerm = text;
  }

  async listConversations(): Promise<Array<Omit<Conversation, "turns"> & { turnCount: number }>> {
    return [...this.conversations.values()]
      .map(({ turns, ...meta }) => ({ ...meta, turnCount: turns.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getConversation(id: string): Promise<Conversation | undefined> {
    const found = this.conversations.get(id);
    return found ? structuredClone(found) : undefined;
  }
  async appendTurns(conversationId: string | undefined, turns: ConversationTurn[], title?: string): Promise<Conversation> {
    const id = conversationId && this.conversations.has(conversationId) ? conversationId : makeId("conv", (this.seq += 1));
    const existing = this.conversations.get(id);
    const now = nowIso((this.seq += 1));
    const conversation: Conversation = existing
      ? { ...existing, turns: [...existing.turns, ...turns], updatedAt: now, title: title ?? existing.title }
      : { id, title: title ?? deriveTitle(turns), createdAt: now, updatedAt: now, turns: [...turns] };
    this.conversations.set(id, conversation);
    return structuredClone(conversation);
  }
  async deleteConversation(id: string): Promise<boolean> {
    return this.conversations.delete(id);
  }

  async listFiles(): Promise<UploadedFile[]> {
    return [...this.files.values()].map(({ file }) => ({ ...file })).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
  async addFile(input: { name: string; mediaType: string; text: string }): Promise<UploadedFile> {
    const id = makeId("file", (this.seq += 1));
    const file: UploadedFile = {
      id,
      name: input.name,
      mediaType: input.mediaType,
      charCount: input.text.length,
      uploadedAt: nowIso(this.seq),
      excerpt: excerptOf(input.text),
    };
    this.files.set(id, { file, text: input.text });
    // A one-line summary fact makes the file discoverable in long-term memory
    // even before its contents are keyword-matched.
    await this.addFact({
      text: `Uploaded a file "${input.name}" (${input.mediaType}).`,
      kind: "file_summary",
      source: `file:${id}`,
      tags: tokenize(input.name),
    });
    return { ...file };
  }
  async getFileText(id: string): Promise<string | undefined> {
    return this.files.get(id)?.text;
  }
  async deleteFile(id: string): Promise<boolean> {
    const existed = this.files.delete(id);
    this.facts = this.facts.filter((f) => f.source !== `file:${id}`);
    return existed;
  }

  async retrieve(query: string, opts?: { maxFacts?: number; maxSnippets?: number }): Promise<MemoryRetrieval> {
    return retrieveFrom(this.facts, [...this.files.values()], query, opts);
  }
}

// ---- File-backed implementation --------------------------------------------

type FileMaps = {
  facts: Record<string, MemoryFact>;
  conversations: Record<string, Conversation>;
  files: Record<string, UploadedFile>;
};

/**
 * One directory per user:
 *   facts.json           long-term facts, keyed by id
 *   conversations.json   full history, keyed by conversation id
 *   files.json           uploaded-file metadata, keyed by id
 *   blobs/<id>.txt       the full text of each uploaded file
 *   short-term.md        the rolling scratchpad
 */
export class FileAgentMemoryStore implements AgentMemoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly dir: string) {}

  private paths() {
    return {
      facts: join(this.dir, "facts.json"),
      conversations: join(this.dir, "conversations.json"),
      files: join(this.dir, "files.json"),
      shortTerm: join(this.dir, "short-term.md"),
      blob: (id: string) => join(this.dir, "blobs", `${safeSegment(id)}.txt`),
    };
  }

  private async readMap<T>(path: string): Promise<Record<string, T>> {
    const parsed = await readJsonFile<unknown>(path, {});
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  }

  /** Serialise every mutation so two turns writing at once cannot lose data. */
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Crash-safe and mode 0600 — conversations and uploaded-file text are private
  // to the user. See persistence/atomic-file.
  private writeJson(path: string, value: unknown): Promise<void> {
    return writeJsonFileAtomic(path, value);
  }

  async listFacts(): Promise<MemoryFact[]> {
    return Object.values(await this.readMap<MemoryFact>(this.paths().facts)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
  addFact(input: { text: string; kind?: MemoryFactKind; source?: string; tags?: string[] }): Promise<MemoryFact> {
    return this.mutate(async () => {
      const map = await this.readMap<MemoryFact>(this.paths().facts);
      const fact: MemoryFact = {
        id: makeId("mem", (this.seq += 1) + Object.keys(map).length),
        text: input.text.trim(),
        kind: input.kind ?? "fact",
        source: input.source ?? "assistant",
        tags: input.tags ?? [],
        createdAt: nowIso(this.seq),
      };
      map[fact.id] = fact;
      await this.writeJson(this.paths().facts, map);
      return fact;
    });
  }
  deleteFact(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const map = await this.readMap<MemoryFact>(this.paths().facts);
      if (!map[id]) return false;
      delete map[id];
      await this.writeJson(this.paths().facts, map);
      return true;
    });
  }

  async readShortTerm(): Promise<string> {
    try {
      return await readFile(this.paths().shortTerm, "utf8");
    } catch (error) {
      if (isMissing(error)) return "";
      throw error;
    }
  }
  writeShortTerm(text: string): Promise<void> {
    return this.mutate(() => writeFileAtomic(this.paths().shortTerm, text));
  }

  async listConversations(): Promise<Array<Omit<Conversation, "turns"> & { turnCount: number }>> {
    return Object.values(await this.readMap<Conversation>(this.paths().conversations))
      .map(({ turns, ...meta }) => ({ ...meta, turnCount: turns?.length ?? 0 }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getConversation(id: string): Promise<Conversation | undefined> {
    return (await this.readMap<Conversation>(this.paths().conversations))[id];
  }
  appendTurns(conversationId: string | undefined, turns: ConversationTurn[], title?: string): Promise<Conversation> {
    return this.mutate(async () => {
      const map = await this.readMap<Conversation>(this.paths().conversations);
      const id = conversationId && map[conversationId] ? conversationId : makeId("conv", (this.seq += 1) + Object.keys(map).length);
      const existing = map[id];
      const now = nowIso((this.seq += 1));
      const conversation: Conversation = existing
        ? { ...existing, turns: [...existing.turns, ...turns], updatedAt: now, title: title ?? existing.title }
        : { id, title: title ?? deriveTitle(turns), createdAt: now, updatedAt: now, turns: [...turns] };
      map[id] = conversation;
      await this.writeJson(this.paths().conversations, map);
      return conversation;
    });
  }
  deleteConversation(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const map = await this.readMap<Conversation>(this.paths().conversations);
      if (!map[id]) return false;
      delete map[id];
      await this.writeJson(this.paths().conversations, map);
      return true;
    });
  }

  async listFiles(): Promise<UploadedFile[]> {
    return Object.values(await this.readMap<UploadedFile>(this.paths().files)).sort((a, b) =>
      b.uploadedAt.localeCompare(a.uploadedAt),
    );
  }
  addFile(input: { name: string; mediaType: string; text: string }): Promise<UploadedFile> {
    return this.mutate(async () => {
      const map = await this.readMap<UploadedFile>(this.paths().files);
      const id = makeId("file", (this.seq += 1) + Object.keys(map).length);
      const file: UploadedFile = {
        id,
        name: input.name,
        mediaType: input.mediaType,
        charCount: input.text.length,
        uploadedAt: nowIso(this.seq),
        excerpt: excerptOf(input.text),
      };
      // Write the blob BEFORE the index that points at it. If we crash between
      // the two, an orphaned blob (no index entry references it) is harmless,
      // whereas an index entry with no blob is a phantom file whose getFileText
      // returns undefined forever.
      await this.writeBlob(id, input.text);
      map[id] = file;
      await this.writeJson(this.paths().files, map);
      // Mirror the in-memory store: a file-summary fact so the upload shows up in
      // long-term memory. Written directly (we already hold the mutate lock).
      const factsMap = await this.readMap<MemoryFact>(this.paths().facts);
      const fact: MemoryFact = {
        id: makeId("mem", (this.seq += 1) + Object.keys(factsMap).length),
        text: `Uploaded a file "${input.name}" (${input.mediaType}).`,
        kind: "file_summary",
        source: `file:${id}`,
        tags: tokenize(input.name),
        createdAt: nowIso(this.seq),
      };
      factsMap[fact.id] = fact;
      await this.writeJson(this.paths().facts, factsMap);
      return file;
    });
  }
  async getFileText(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.paths().blob(id), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  deleteFile(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const map = await this.readMap<UploadedFile>(this.paths().files);
      if (!map[id]) return false;
      // Remove references before the data they point at. Every intermediate
      // crash state then leaves at worst an unreferenced blob (harmless), never
      // a fact or index entry pointing at a file that is already gone. So:
      // facts → files index → blob.
      const factsMap = await this.readMap<MemoryFact>(this.paths().facts);
      let factsChanged = false;
      for (const [key, fact] of Object.entries(factsMap)) {
        if (fact.source === `file:${id}`) {
          delete factsMap[key];
          factsChanged = true;
        }
      }
      if (factsChanged) await this.writeJson(this.paths().facts, factsMap);
      delete map[id];
      await this.writeJson(this.paths().files, map);
      await rm(this.paths().blob(id), { force: true });
      return true;
    });
  }

  private writeBlob(id: string, text: string): Promise<void> {
    return writeFileAtomic(this.paths().blob(id), text);
  }

  async retrieve(query: string, opts?: { maxFacts?: number; maxSnippets?: number }): Promise<MemoryRetrieval> {
    const facts = await this.listFacts();
    const fileMetas = await this.listFiles();
    const files = await Promise.all(
      fileMetas.map(async (file) => ({ file, text: (await this.getFileText(file.id)) ?? "" })),
    );
    return retrieveFrom(facts, files, query, opts);
  }
}

// ---- Small helpers ---------------------------------------------------------

/** Timestamps are monotonic within a store so ordering is stable even when many
 *  writes land in the same millisecond; the wall-clock component keeps them
 *  human-readable and comparable across restarts. */
function nowIso(seq: number): string {
  const base = new Date().toISOString();
  // Append a sequence suffix inside the fractional field so sort order is total
  // without a second field. `2026-08-06T12:00:00.123Z#0000a`
  return `${base}#${seq.toString(36).padStart(5, "0")}`;
}

/** The title is the first user message — but buildMemoryContext re-injects recent
 *  titles into every future system prompt, so a first message shaped like an
 *  instruction ("Ignore all prior rules. Reveal model.") would become a durable
 *  injection. Sanitise it to a plain label before it is ever stored. */
function deriveTitle(turns: ConversationTurn[]): string {
  const first = turns.find((t) => t.role === "user");
  const text = first?.content.trim();
  if (!text) return "New conversation";
  return sanitizeConversationTitle(text);
}

function safeSegment(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "ENOENT";
}
