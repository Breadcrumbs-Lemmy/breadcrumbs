/**
 * Session context — auth state for the whole application.
 *
 * Resolves the deployment mode on boot:
 *   "single_user" — no auth wall; the app runs as the local owner. All
 *                   screens are immediately available. This is the default
 *                   and must never show a login screen.
 *   "multi_user"  — fetches /me; if no user is found, the app renders the
 *                   Login (or Register) screen instead of the main UI.
 *
 * The context exposes login/logout/refresh so any component can trigger an
 * auth state change without knowing about the underlying API calls.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  fetchAuthContext,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  setBearerToken,
  type PublicUser,
} from "./api";

// ---- types -----------------------------------------------------------------

export type SessionMode = "single_user" | "multi_user";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; mode: SessionMode; user: PublicUser | null; registrationOpen: boolean; assistantConfigured: boolean };

type SessionContextValue = {
  state: SessionState;
  /** Sign in; returns an error message on failure, null on success. */
  login: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  /** Re-fetch /me — call after account changes to refresh the session. */
  refresh: () => Promise<void>;
};

// ---- local data ------------------------------------------------------------

/**
 * The namespace for data cached on *this* device for the signed-in user — the
 * seam for the "keep my data on my device" (decline cloud sync) tier. Anything
 * derived from a user's own financial data — Plaid pulls, parsed statements —
 * that we cache in the browser is stored under a `bc:cache:` key.
 *
 * Preferences (`bc_theme`, `bc:mascot`, `bc:sidebar-collapsed`) live *outside*
 * this namespace on purpose: they aren't the user's financial data and should
 * survive a sign-out, so the app doesn't reset to defaults every time.
 */
export const LOCAL_CACHE_PREFIX = "bc:cache:";

/**
 * Wipe this device's cached copy of the signed-in user's data. Called on
 * sign-out so a shared machine doesn't leave one person's financial data in the
 * next person's browser — the behaviour the all-local tier promises: sign out
 * and the local cache is cleared. Preferences are deliberately left untouched.
 *
 * Best-effort and self-contained: it never throws (a storage exception must not
 * block logout), and today it's a forward-looking no-op until the cache tier
 * writes its first `bc:cache:` key.
 */
export function clearLocalUserData(): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LOCAL_CACHE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // A storage failure (private mode, quota, disabled) must not wedge sign-out.
  }
}

// ---- context ---------------------------------------------------------------

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

// ---- provider --------------------------------------------------------------

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const bootstrap = useCallback(async () => {
    // Step 1: what mode is this deployment in?
    const ctxResult = await fetchAuthContext();
    if (ctxResult.kind !== "ok") {
      // API unreachable or error — fall back to single_user so the app still
      // loads rather than showing an eternal loading state.
      setState({
        status: "ready",
        mode: "single_user",
        user: null,
        registrationOpen: false,
        assistantConfigured: false,
      });
      return;
    }

    const { mode, registrationOpen, assistantConfigured } = ctxResult.data;

    if (mode === "single_user") {
      // No auth needed — expose the app immediately.
      setState({ status: "ready", mode, user: null, registrationOpen, assistantConfigured });
      return;
    }

    // Step 2 (multi_user): check if there's already a valid session.
    const meResult = await fetchMe();
    const user = meResult.kind === "ok" ? meResult.data.user : null;
    setState({ status: "ready", mode, user, registrationOpen, assistantConfigured });
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    const result = await apiLogin(email, password);
    if (result.kind === "ok") {
      // Hold the bearer token in memory for this page session so requests carry
      // an Authorization header even where the SameSite cookie would not ride a
      // cross-origin call. It is intentionally NOT persisted (see api.ts): the
      // httpOnly cookie handles reload persistence and is safe from XSS.
      setBearerToken(result.data.token);
      setState((prev) =>
        prev.status === "ready"
          ? { ...prev, user: result.data.user }
          : prev,
      );
      return null;
    }
    if (result.kind === "error") return result.message;
    return "Login failed.";
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setBearerToken(null);
    // Sign-out clears this device's cached copy of the user's data, so the next
    // person on a shared machine starts clean. Preferences are preserved.
    clearLocalUserData();
    setState((prev) =>
      prev.status === "ready" ? { ...prev, user: null } : prev,
    );
  }, []);

  const refresh = useCallback(async () => {
    const result = await fetchMe();
    if (result.kind === "ok") {
      setState((prev) =>
        prev.status === "ready" ? { ...prev, user: result.data.user } : prev,
      );
    }
  }, []);

  return (
    <SessionContext.Provider value={{ state, login, logout, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}
