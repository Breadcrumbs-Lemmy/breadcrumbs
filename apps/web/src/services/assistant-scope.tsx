/**
 * Assistant view-scope.
 *
 * The floating coin and the full Assistant answer over the same grounded tools,
 * but a good answer depends on *what the user is currently looking at*. Before
 * this, the model received only the message thread, so on Pulse ▸ Week ▸ "week
 * of 25 May" a plain "how much did I spend?" was answered for the current
 * calendar month — confidently wrong, because its context was everything.
 *
 * This module is the narrow channel that carries the current selection from the
 * screen that owns it to the assistant that needs it. It is **presentation-only**:
 * nothing here derives a financial figure. It names the selection (route, the
 * selected period, the account filter); the server resolves that to concrete
 * tool parameters and a system-prompt line so the reply is scoped to the view.
 *
 * Shape of the plumbing:
 *   - `AssistantScopeProvider` holds the current screen's `view` (the part a
 *     screen contributes — everything except route/screen, which the shell adds).
 *   - a screen calls `useAssistantView(view)` in an effect; it publishes on
 *     change and **clears on unmount**, so a stale filter never leaks into the
 *     next screen's scope.
 *   - the mascot reads `useAssistantViewScope()` and composes the full
 *     `AssistantScope` from its own route/label plus the published view.
 *
 * Everything is optional: a screen that publishes nothing, or a client with no
 * provider, simply sends no scope and the assistant behaves as it did before.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** The user's current view, sent to the assistant so its answers are scoped to
 *  exactly what's on screen. The server maps these fields to tool defaults. */
export type AssistantScope = {
  /** Route id, e.g. "spending". */
  route: string;
  /** Human screen name shown to the model, e.g. "Pulse". */
  screen: string;
  /** The selected time period, when the screen has one. */
  period?: {
    kind: "week" | "month" | "year" | "statement";
    /** Backend period key, e.g. "2026-05" or "2026-W21". Omit for "most recent". */
    key?: string;
    /** Human label the screen already shows, e.g. "Week of 19 May". */
    label?: string;
  };
  /** The selected account filter, when one is applied. */
  account?: { id: string; label?: string };
  /** Extra one-line facts about the current view (a drill-down focus, a filter). */
  notes?: string[];
};

/** The screen-specific part a screen contributes — route/screen come from the
 *  shell, so a screen only supplies the selection. */
export type ScopeView = Omit<AssistantScope, "route" | "screen">;

type ScopeContextValue = {
  view: ScopeView | null;
  setView: (view: ScopeView | null) => void;
};

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function AssistantScopeProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ScopeView | null>(null);
  const value = useMemo<ScopeContextValue>(() => ({ view, setView }), [view]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/**
 * Publish the current screen's selection to the assistant.
 *
 * Call this once from a screen with the live selection; pass `null` when the
 * screen has nothing to contribute yet. It re-publishes only when the selection
 * actually changes (a serialized dependency, not object identity), and clears
 * the scope on unmount so the next screen starts clean.
 */
export function useAssistantView(view: ScopeView | null): void {
  const ctx = useContext(ScopeContext);
  const setView = ctx?.setView;
  // Serialise for a stable dependency: screens rebuild the view object every
  // render, but we only want to re-publish when its contents change.
  const key = view ? JSON.stringify(view) : null;
  useEffect(() => {
    if (!setView) return;
    setView(key ? (JSON.parse(key) as ScopeView) : null);
    return () => setView(null);
    // key captures every field of `view`; setView is stable from useState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setView, key]);
}

/** Read the currently-published view (the mascot composes the full scope from
 *  this plus its own route/screen). Null when no screen has published one. */
export function useAssistantViewScope(): ScopeView | null {
  return useContext(ScopeContext)?.view ?? null;
}
