/**
 * Assistant — conversation over the deterministic engine.
 *
 * `D-003` puts the deterministic engine before any AI surface, and `S-010`
 * limits AI to explaining computed facts. Both show up here as one visible
 * property: **every reply names the tools it read.** A figure the assistant
 * states is a figure that came back from the same functions the Spending
 * screen calls, and the user can see which ones.
 *
 * The assistant is optional. Without an API key the screen says so and points
 * at the setting, rather than presenting a chat box that fails on submit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteAgentFile,
  deleteConversation,
  fetchAgentStatus,
  getConversation,
  listAgentFiles,
  listConversations,
  safeAssistantError,
  sendAgentTurn,
  uploadAgentFile,
  TOOL_LABELS,
  type AgentMessage,
  type AgentStatus,
  type AgentToolCallRecord,
  type ConversationSummary,
  type LearnedFile,
} from "../services/agent";
import { Card, SectionLabel } from "../components/ui";

type Turn = AgentMessage & { toolCalls?: AgentToolCallRecord[] };

const SUGGESTIONS = [
  "Where did my money go last month?",
  "What am I paying for every month?",
  "What stands out in my spending?",
  "How much did I spend on groceries, and on what?",
];

export function AssistantScreen({ onImport }: { onImport?: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server threads every exchange onto one stored conversation; we hold its
  // id so each turn continues the same thread rather than starting a new one.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // While a past conversation loads back in, the composer is locked so a stray
  // turn can't append to the wrong thread mid-swap.
  const [loadingConversation, setLoadingConversation] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAgentStatus().then((outcome) => {
      if (cancelled) return;
      setStatus(outcome.kind === "ok" ? outcome.data : { configured: false, model: null, capabilities: [], boundaries: [] });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, thinking]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || thinking || loadingConversation) return;

      const nextTurns: Turn[] = [...turns, { role: "user", content: question }];
      setTurns(nextTurns);
      setDraft("");
      setThinking(true);
      setError(null);

      // Only role and content go back — the tool records are display state and
      // would be noise in the model's context. The conversationId keeps the
      // server-side thread coherent across turns.
      const outcome = await sendAgentTurn(
        nextTurns.map(({ role, content }) => ({ role, content })),
        conversationId,
      );
      setThinking(false);

      if (outcome.kind !== "ok") {
        setError(
          outcome.kind === "error"
            ? safeAssistantError(outcome.message)
            : "The assistant couldn't answer that.",
        );
        return;
      }
      if (outcome.data.kind === "declined") {
        setError(safeAssistantError(outcome.data.message));
        return;
      }

      if (outcome.data.conversationId) setConversationId(outcome.data.conversationId);
      setTurns([
        ...nextTurns,
        { role: "assistant", content: outcome.data.text, toolCalls: outcome.data.toolCalls },
      ]);
    },
    [turns, thinking, loadingConversation, conversationId],
  );

  // Start a fresh thread: the server begins a new stored conversation on the next
  // turn (no id sent), so this only clears the local view — nothing is deleted.
  const startNewChat = useCallback(() => {
    setTurns([]);
    setConversationId(undefined);
    setError(null);
    setHistoryOpen(false);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setHistoryOpen(false);
    setError(null);
    setLoadingConversation(true);
    const outcome = await getConversation(id);
    setLoadingConversation(false);
    if (outcome.kind !== "ok") {
      setError(outcome.kind === "error" ? safeAssistantError(outcome.message) : "That conversation couldn't be opened.");
      return;
    }
    // Stored turns carry only role/content — tool-call provenance isn't persisted,
    // so a reopened answer shows without its "Read from…" line. That's honest: the
    // sources were shown live, and history is a record, not a re-derivation.
    setTurns(outcome.data.conversation.turns.map((t) => ({ role: t.role, content: t.content })));
    setConversationId(outcome.data.conversation.id);
  }, []);

  if (status === null) {
    return <div className="h-[420px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />;
  }

  if (!status.configured) {
    return <NotConfigured status={status} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col">
      {status.memory && (
        <ConversationBar
          canStartNew={turns.length > 0 || conversationId !== undefined}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen((open) => !open)}
          onNewChat={startNewChat}
        />
      )}
      {status.memory && historyOpen && (
        <HistoryPanel
          activeId={conversationId}
          onOpen={(id) => void openConversation(id)}
          onNewChat={startNewChat}
        />
      )}

      <StatusStrip
        status={status}
        memoryOpen={memoryOpen}
        onToggleMemory={() => setMemoryOpen((open) => !open)}
      />
      {status.memory && memoryOpen && <MemoryPanel />}

      {turns.length === 0 && !loadingConversation && (
        <Opening onPick={(text) => void send(text)} onImport={onImport} />
      )}

      <div className="space-y-5">
        {turns.map((turn, i) => (
          <Bubble key={i} turn={turn} />
        ))}
        {loadingConversation && (
          <p className="text-body text-ink-tertiary">Opening that chat…</p>
        )}
        {thinking && (
          <p className="text-body text-ink-tertiary">Looking at your transactions…</p>
        )}
        {error && (
          <Card>
            <p className="text-body text-ink">{error}</p>
          </Card>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="composer-dock sticky bottom-0 mt-6 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            className="input min-h-[44px] resize-none py-2.5"
            rows={1}
            value={draft}
            placeholder="Ask about your spending"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || thinking || loadingConversation}
            className="min-h-[44px] shrink-0 rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            Ask
          </button>
        </div>
        <p className="mt-2 text-meta leading-relaxed text-ink-tertiary">
          Answers come from your imported transactions. Read-only, and not financial advice.
        </p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] break-words rounded-lg bg-surface-sunken px-4 py-2.5 text-body text-ink">
          {turn.content}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-[95%] whitespace-pre-wrap break-words text-body leading-relaxed text-ink">
        {turn.content}
      </div>
      {turn.toolCalls && turn.toolCalls.length > 0 && <Sources toolCalls={turn.toolCalls} />}
    </div>
  );
}

/**
 * What the answer was read from.
 *
 * This is the honesty mechanism, not decoration: an assistant that states a
 * figure without showing where it came from is asking to be trusted, and the
 * product's position is that it shouldn't have to be.
 */
function Sources({ toolCalls }: { toolCalls: AgentToolCallRecord[] }) {
  const names = [...new Set(toolCalls.map((call) => TOOL_LABELS[call.tool] ?? call.tool))];
  const failed = toolCalls.filter((call) => !call.ok);

  return (
    <p className="mt-2 text-meta leading-relaxed text-ink-tertiary">
      Read from {names.join(", ")}.
      {failed.length > 0 && ` ${failed.length} lookup${failed.length === 1 ? "" : "s"} failed.`}
    </p>
  );
}

function Opening({ onPick, onImport }: { onPick: (text: string) => void; onImport?: () => void }) {
  return (
    <div className="mb-6">
      <p className="font-display text-[1.35rem] font-medium text-ink">Ask about your money</p>
      <p className="mt-2 max-w-[52ch] text-body text-ink-secondary">
        Every figure comes from the same calculations behind your Spending screen — the assistant
        reads them, it doesn't do the maths itself. If you haven't imported a statement yet,{" "}
        <button
          type="button"
          onClick={onImport}
          className="text-accent underline underline-offset-4"
        >
          start there
        </button>
        .
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-pill border border-line-subtle px-3 py-1.5 text-meta text-ink-secondary hover:border-line-strong hover:text-ink"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotConfigured({ status }: { status: AgentStatus }) {
  return (
    <Card className="mx-auto max-w-[560px]">
      <p className="font-display text-[1.35rem] font-medium text-ink">The assistant isn't set up</p>
      <p className="mt-2 text-body text-ink-secondary">
        {status.reason ?? "Set ANTHROPIC_API_KEY to enable it."}
      </p>
      <p className="mt-4 text-meta leading-relaxed text-ink-tertiary">
        Add <span className="font-mono text-[11px]">ANTHROPIC_API_KEY</span> to your{" "}
        <span className="font-mono text-[11px]">.env</span> and restart the API. Everything else in
        the app works without it — the assistant is a layer over the spending engine, not a
        dependency of it.
      </p>
      <div className="mt-4">
        <SectionLabel>When enabled it can</SectionLabel>
        <ul className="mt-1 space-y-1 text-body text-ink-secondary">
          <li>Answer questions about your imported spending</li>
          <li>Read PDF statements your bank doesn't export as CSV</li>
        </ul>
      </div>
    </Card>
  );
}

/**
 * A quiet line about how the assistant runs and what it remembers. The
 * on-device pill is the one that matters: when the model is local, this is where
 * the user sees that their questions never leave the machine.
 */
function StatusStrip({
  status,
  memoryOpen,
  onToggleMemory,
}: {
  status: AgentStatus;
  memoryOpen: boolean;
  onToggleMemory: () => void;
}) {
  const pills: string[] = [];
  // The on-device claim is only absolute when BOTH jobs stay on the machine.
  // When chat is local but statement extraction runs on the hosted model, a
  // PDF's text leaves the machine on import — so the pill is qualified rather
  // than making a promise the import path would break.
  const extractionLeavesMachine =
    status.capabilities.includes("statement_extraction") && status.extractionOffline === false;
  if (status.offline) {
    pills.push(
      extractionLeavesMachine
        ? "Chat on-device — statement import uses the hosted model"
        : "On-device — nothing leaves this machine",
    );
  }
  if (status.memory) pills.push("Remembers across chats");
  if (pills.length === 0 && !status.memory) return null;

  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex flex-wrap gap-1.5">
        {pills.map((label) => (
          <span key={label} className="rounded-pill bg-surface-sunken px-2.5 py-1 text-meta text-ink-tertiary">
            {label}
          </span>
        ))}
      </div>
      {status.memory && (
        <button
          type="button"
          onClick={onToggleMemory}
          aria-expanded={memoryOpen}
          className="shrink-0 rounded-pill border border-line-subtle px-3 py-1 text-meta text-ink-secondary hover:border-line-strong hover:text-ink"
        >
          {memoryOpen ? "Hide files" : "Teach the assistant"}
        </button>
      )}
    </div>
  );
}

/**
 * The files the assistant learns from. Upload is deliberately plain-text: the
 * store keeps the text and retrieves passages by keyword, offline, so a note, a
 * budget, or an exported statement all work and nothing is sent to a third party.
 */
function MemoryPanel() {
  const [files, setFiles] = useState<LearnedFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listAgentFiles().then((outcome) => {
      if (cancelled) return;
      setFiles(outcome.kind === "ok" ? outcome.data.files : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onFile = useCallback(async (file: File) => {
    setNote(null);
    // The backend caps stored text at ~2 MB; catch it here so the user gets a
    // clear message instead of a rejected request.
    if (file.size > 2_000_000) {
      setNote(`"${file.name}" is larger than 2 MB. Trim it or split it up.`);
      return;
    }
    setBusy(true);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setBusy(false);
      setNote("Couldn't read that file.");
      return;
    }
    const outcome = await uploadAgentFile(file.name, text, file.type || "text/plain");
    setBusy(false);
    if (outcome.kind !== "ok") {
      setNote(outcome.kind === "error" ? safeAssistantError(outcome.message) : "That file couldn't be saved.");
      return;
    }
    setFiles((current) => [outcome.data.file, ...(current ?? [])]);
    setNote(`Learned from "${outcome.data.file.name}".`);
  }, []);

  const remove = useCallback(async (id: string) => {
    const outcome = await deleteAgentFile(id);
    if (outcome.kind === "ok") setFiles((current) => (current ?? []).filter((f) => f.id !== id));
  }, []);

  return (
    <Card className="mb-6">
      <SectionLabel>Teach the assistant</SectionLabel>
      <p className="mt-1 text-meta leading-relaxed text-ink-tertiary">
        Add a text file — notes, a budget, an exported statement — and the assistant can refer to it
        in later answers. It stays on the server with your own data and is never sent anywhere else.
        (PDFs are read on the Import screen, not here.)
      </p>

      <div className="mt-3">
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.csv,.md,.json,.log,.tsv,text/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-md border border-line-subtle px-3 py-1.5 text-meta text-ink-secondary hover:border-line-strong hover:text-ink disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add a file"}
        </button>
      </div>

      {note && <p className="mt-2 text-meta text-ink-tertiary">{note}</p>}

      {files === null ? (
        <p className="mt-3 text-meta text-ink-tertiary">Loading…</p>
      ) : files.length === 0 ? (
        <p className="mt-3 text-meta text-ink-tertiary">No files yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 text-body text-ink">
              <span className="min-w-0 truncate">
                {file.name}
                <span className="ml-2 text-meta text-ink-tertiary">{formatChars(file.charCount)}</span>
              </span>
              <button
                type="button"
                onClick={() => void remove(file.id)}
                className="shrink-0 text-meta text-ink-tertiary hover:text-ink"
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function formatChars(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k chars` : `${count} chars`;
}

// ---------------------------------------------------------------------------

/**
 * The thin toolbar above the transcript: start a fresh thread, or open the list
 * of past ones. Only rendered when a memory store is wired — without it there is
 * nothing to browse, because conversations aren't persisted.
 */
function ConversationBar({
  canStartNew,
  historyOpen,
  onToggleHistory,
  onNewChat,
}: {
  canStartNew: boolean;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onNewChat: () => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onNewChat}
        disabled={!canStartNew}
        className="rounded-pill border border-line-subtle px-3 py-1 text-meta text-ink-secondary hover:border-line-strong hover:text-ink disabled:opacity-40"
      >
        New chat
      </button>
      <button
        type="button"
        onClick={onToggleHistory}
        aria-expanded={historyOpen}
        className="rounded-pill border border-line-subtle px-3 py-1 text-meta text-ink-secondary hover:border-line-strong hover:text-ink"
      >
        {historyOpen ? "Hide history" : "History"}
      </button>
    </div>
  );
}

/**
 * The chat-history browser. Lists this user's past conversations newest-first —
 * each stored as plain files on this machine, never uploaded — and reopens one
 * on click or forgets one on delete. The list is fetched fresh each time the
 * panel opens, so a conversation you just had shows up without a reload.
 */
function HistoryPanel({
  activeId,
  onOpen,
  onNewChat,
}: {
  activeId: string | undefined;
  onOpen: (id: string) => void;
  onNewChat: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listConversations().then((outcome) => {
      if (cancelled) return;
      setItems(outcome.kind === "ok" ? outcome.data.conversations : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      const outcome = await deleteConversation(id);
      setBusyId(null);
      if (outcome.kind !== "ok") return;
      setItems((current) => (current ?? []).filter((c) => c.id !== id));
      // Deleting the chat you're looking at drops you back to a blank thread.
      if (id === activeId) onNewChat();
    },
    [activeId, onNewChat],
  );

  return (
    <Card className="mb-4">
      <SectionLabel>Past chats</SectionLabel>
      {items === null ? (
        <p className="mt-3 text-meta text-ink-tertiary">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
          No past chats yet. Ask something and it's saved here — as plain files on this machine, with
          your own data, never uploaded.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {items.map((conversation) => (
            <li key={conversation.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(conversation.id)}
                aria-current={conversation.id === activeId}
                className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken ${
                  conversation.id === activeId ? "bg-surface-sunken" : ""
                }`}
              >
                <span className="block truncate text-body text-ink">{conversation.title}</span>
                <span className="mt-0.5 block text-meta text-ink-tertiary">
                  {formatWhen(conversation.updatedAt)} · {conversation.turnCount} message
                  {conversation.turnCount === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void remove(conversation.id)}
                disabled={busyId === conversation.id}
                className="shrink-0 text-meta text-ink-tertiary hover:text-ink disabled:opacity-40"
                aria-label={`Delete "${conversation.title}"`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A short, human "when" for a stored conversation. The backend stamps carry a
 *  `#seq` sort suffix (see the memory store) — strip it before parsing. */
function formatWhen(stamp: string): string {
  const then = new Date(stamp.split("#")[0] ?? stamp);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = Date.now() - then.getTime();
  const day = 86_400_000;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
