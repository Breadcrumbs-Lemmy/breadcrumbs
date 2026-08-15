/**
 * Breadcrumbs shell.
 *
 * Opens on Spending. The product's question is "where is my money going?"
 * (`D-011`); affordability is a secondary action reached from that screen.
 *
 * Web first: layout and navigation live in `AppShell`, which is a sidebar at
 * desktop and a top bar below `lg`.
 *
 * This component holds routing and form input, nothing financial. The
 * affordability snapshot is fetched from the API (`L-007`) rather than built
 * in the browser — the verdict is about the user's own imported accounts, and
 * the numbers behind it never cross the deploy boundary as a bundled fixture.
 *
 * Auth (Deliverable 3):
 *   The SessionProvider wraps the whole tree. In single_user mode the auth
 *   layer is invisible — no login wall, no user menu (unless a user object
 *   somehow appears). In multi_user mode, the SessionGate renders Login/Register
 *   until a valid session exists, then shows the main UI with user controls.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { AffordabilityRequest, FinancialSnapshot } from "@ai-fin-os/core";
import { checkAffordability, fetchAffordabilitySnapshot, changePassword, type SnapshotNotes } from "./services/api";
import type { AffordabilityOutcome } from "./services/outcome";
import { SessionProvider, useSession } from "./services/session";
import { AssistantScopeProvider } from "./services/assistant-scope";
import { AppShell, type NavItem, type NavSection } from "./components/AppShell";
import { CheckScreen } from "./screens/CheckScreen";
import { SpendingScreen } from "./screens/SpendingScreen";
import { BudgetsScreen } from "./screens/BudgetsScreen";
import { GoalsScreen } from "./screens/GoalsScreen";
import { CashflowScreen } from "./screens/CashflowScreen";
import { MonthlyReportScreen } from "./screens/MonthlyReportScreen";
import { TransactionsScreen } from "./screens/TransactionsScreen";
import { InsightsScreen } from "./screens/InsightsScreen";
import { AccountsScreen } from "./screens/AccountsScreen";
import { NetWorthScreen } from "./screens/NetWorthScreen";
import { ImportScreen } from "./screens/ImportScreen";
import { AssistantScreen } from "./screens/AssistantScreen";
import { ResultScreen } from "./screens/ResultScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { emptyDraft, requestFromDraft, type PurchaseDraft } from "./model/snapshot";
import type { InsightFocus } from "./model/insight-focus";
import type { PeriodKind } from "./model/period";
import { BOUNDARY_COPY, UI_COPY } from "./copy";
import { Card } from "./components/ui";
import { Ambient } from "./components/Ambient";
import { NeuralPulses } from "./components/NeuralPulses";
import { AssistantMascot } from "./components/AssistantMascot";
import { useMascotPrefs } from "./mascot-prefs";
import { Logo } from "./components/Logo";

/**
 * The dev-only scenario switcher, and the fake-money fixtures behind it, are
 * pulled in through a dynamic import gated by `import.meta.env.DEV`. Vite
 * replaces that flag with a literal `false` in a production build, so Rollup
 * eliminates this branch and never emits the chunk — the fixtures cannot ship
 * beside a user's real accounts. In development it resolves to the real
 * component, lazily loaded. See ./dev/ScenarioAside.
 */
const ScenarioAside = import.meta.env.DEV ? lazy(() => import("./dev/ScenarioAside")) : null;

type Route =
  | "spending"
  | "budgets"
  | "goals"
  | "cashflow"
  | "report"
  | "transactions"
  | "insights"
  | "accounts"
  | "networth"
  | "assistant"
  | "import"
  | "check"
  | "result"
  | "admin"
  | "settings";

// ---- top-level wrapper (supplies session context) --------------------------

export default function App() {
  return (
    <SessionProvider>
      <Ambient />
      <NeuralPulses />
      <SessionGate />
    </SessionProvider>
  );
}

/** Decides whether to render the login wall or the main application. */
function SessionGate() {
  const { state } = useSession();

  if (state.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <Logo variant="mark" size={46} beacon />
        <span className="sr-only">Loading Breadcrumbs…</span>
      </div>
    );
  }

  // single_user: no login ever, no user object, full app immediately.
  if (state.mode === "single_user") {
    return <AppContent />;
  }

  // multi_user + no session → show the auth screens.
  if (!state.user) {
    return (
      <LoginScreen
        registrationOpen={state.registrationOpen}
      />
    );
  }

  // multi_user + authenticated → full app with user context in the shell.
  return <AppContent />;
}

// ---- main application ------------------------------------------------------

function AppContent() {
  const { state, logout, refresh } = useSession();
  const user = state.status === "ready" ? state.user : null;

  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [snapshotNotes, setSnapshotNotes] = useState<SnapshotNotes | null>(null);
  const [draft, setDraft] = useState<PurchaseDraft>(() => emptyDraft(todayIso()));
  // Land on Accounts — the same destination the Breadcrumbs logo (onHome) goes
  // to — so the first screen and the logo click are in sync.
  const [route, setRoute] = useState<Route>("accounts");
  /** The screen the Import flow was opened from, so its back button returns
   *  there rather than to a fixed page. Defaults to accounts. */
  const [importOrigin, setImportOrigin] = useState<Route>("accounts");
  /** When set, the Transactions screen is scoped to exactly one insight's
   *  transactions — the ones the user clicked through to verify — and carries
   *  that insight's backend total so the drill-down can show what they add up
   *  to. Cleared when Transactions is reached from the nav instead. */
  const [txFocus, setTxFocus] = useState<InsightFocus | null>(null);
  /** Insights filter selection, held here rather than inside InsightsScreen so it
   *  survives the round trip to the Transactions drill-down: that screen replaces
   *  Insights (unmounting it), so screen-local state would snap back to the
   *  default month when the user navigates back. */
  const [insightsPeriod, setInsightsPeriod] = useState<PeriodKind>("month");
  const [insightsPeriodKey, setInsightsPeriodKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AffordabilityOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The user's own statement that the derived bill list is complete. Reset on
   *  every fresh snapshot: a new import changes what the list contains. */
  const [obligationsConfirmed, setObligationsConfirmed] = useState(false);
  /** The snapshot the current result was produced from, so the result screen
   *  resolves labels against the exact inputs that produced it. */
  const [evaluated, setEvaluated] = useState<FinancialSnapshot | null>(null);

  // Change-password inline modal state
  const [showChangePassword, setShowChangePassword] = useState(false);

  // Mascot visibility gates whether the coin mounts at all (movement/character
  // are read inside the mascot). Shared store, so toggling it on the Settings
  // screen adds/removes the corner coin live.
  const { prefs: mascotPrefs } = useMascotPrefs();

  const loadSnapshot = useCallback(async () => {
    const result = await fetchAffordabilitySnapshot();
    if (result.kind !== "ok") {
      // A 404 here means "nothing imported yet", which is an ordinary state and
      // not an error worth shouting about. The check screen explains it.
      setSnapshot(null);
      setSnapshotNotes(null);
      return;
    }
    setSnapshot(result.data.snapshot);
    setSnapshotNotes(result.data.notes);
    setObligationsConfirmed(false);
    setDraft((current) =>
      current.purchaseDate ? current : emptyDraft(result.data.snapshot.asOfDate),
    );
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const submit = useCallback(async () => {
    if (!snapshot) return;
    setSubmitting(true);
    // The user's answer to "are these all your bills" is theirs to give, and
    // the engine blocks without it. Applying it here keeps the derived snapshot
    // itself untouched — nothing read from a statement claims this.
    const confirmed: FinancialSnapshot = {
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        userConfirmedNoOtherRequiredObligations: obligationsConfirmed,
      },
    };
    const request = requestFromDraft(confirmed, draft, `ui-${Date.now()}`);
    const result = await checkAffordability(request);
    setEvaluated(request.snapshot);
    setOutcome(result);
    setSubmitting(false);
    setRoute("result");
  }, [snapshot, draft, obligationsConfirmed]);

  // Runs a dev scenario request (built inside the DEV-only aside) through the
  // real engine. Takes the request rather than a scenario key so this always-live
  // callback never references the fixtures, keeping them out of production.
  const applyScenario = useCallback(async (request: AffordabilityRequest) => {
    setSnapshot(request.snapshot);
    setSnapshotNotes(null);
    const result = await checkAffordability(request);
    setEvaluated(request.snapshot);
    setOutcome(result);
    setRoute("result");
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    // After logout in single_user mode nothing changes; in multi_user the
    // SessionGate will re-render to show the login screen.
    setRoute("spending");
  }, [logout]);

  // The nav is grouped into four sections whose headers — Pulse · Ledger ·
  // Ahead · Next — spell P·L·A·N down the retracted rail, a small wink for a
  // planning app. The word is a by-product of honest grouping, not the driver:
  // every feature sits in the section it belongs to (retrospective / accounts +
  // records / forward-looking / decide), each with a plain name. Reordering the
  // sections changes the word but not where anything lives.
  //
  // Result isn't its own section — it's the output of a Check, so it appears in
  // "Next" as "Last check" only once a check has produced one. Settings stays
  // off the nav entirely (a gear at the sidebar foot); adding it here would tack
  // a stray letter onto PLAN. Admin is a trailing utility, outside the acrostic.
  //
  // Monthly report and Net worth keep their in-screen entry points (from
  // Spending and Accounts) and stay off the sidebar, exactly as before — folding
  // them into a section is a later IA call, not part of this nav change.
  const sections: NavSection<Route>[] = [
    {
      header: "Pulse",
      items: [
        { id: "spending", label: "Spending" },
        { id: "insights", label: "Insights" },
      ],
    },
    {
      header: "Ledger",
      items: [
        { id: "accounts", label: "Accounts" },
        { id: "transactions", label: "Transactions" },
        { id: "import", label: "Import" },
      ],
    },
    {
      header: "Ahead",
      items: [
        { id: "cashflow", label: "Cash-flow" },
        { id: "budgets", label: "Budgets" },
        { id: "goals", label: "Goals" },
      ],
    },
    {
      header: "Next",
      items: [
        { id: "check", label: "Check", hint: "Can I afford it?" },
        // Only reachable once a check has run — it's that check's verdict.
        ...(outcome ? [{ id: "result" as Route, label: "Last check", hint: "Latest verdict" }] : []),
        { id: "assistant", label: "Assistant" },
      ],
    },
  ];

  // Admin only renders for admins. The condition lives here rather than in
  // AppShell so AppShell stays generic.
  const trailing: NavItem<Route>[] =
    user?.role === "admin" ? [{ id: "admin", label: "Admin" }] : [];

  return (
    /* The scope provider spans the screens (which publish their current
       selection) and the mascot (which reads it), so the assistant can answer
       about exactly what the user is looking at. */
    <AssistantScopeProvider>
      {showChangePassword && (
        <ChangePasswordModal
          onClose={() => setShowChangePassword(false)}
          onRefresh={() => void refresh()}
        />
      )}

      <AppShell
        sections={sections}
        trailing={trailing}
        current={route}
        onNavigate={(next) => {
          // Reaching Transactions from the nav (rather than from an insight)
          // means "show me everything" — drop any lingering insight focus.
          if (next === "transactions") setTxFocus(null);
          setRoute(next);
        }}
        onHome={() => setRoute("accounts")}
        onOpenSettings={() => setRoute("settings")}
        settingsActive={route === "settings"}
        user={
          user
            ? {
                displayName: user.displayName,
                email: user.email,
                role: user.role,
              }
            : null
        }
        onLogout={user ? () => void handleLogout() : undefined}
        onChangePassword={user ? () => setShowChangePassword(true) : undefined}
        aside={
          ScenarioAside ? (
            <Suspense fallback={null}>
              <ScenarioAside onPick={(request) => void applyScenario(request)} />
            </Suspense>
          ) : undefined
        }
        footer={
          <p className="text-meta text-ink-tertiary lg:text-left">
            {BOUNDARY_COPY.READ_ONLY_DECISION_SUPPORT}
          </p>
        }
      >
        {route === "spending" && (
          <SpendingScreen
            onCheckPurchase={() => setRoute("check")}
            onImport={() => setRoute("import")}
            onOpenBudgets={() => setRoute("budgets")}
            onOpenCashflow={() => setRoute("cashflow")}
            onOpenReport={() => setRoute("report")}
          />
        )}

        {route === "budgets" && (
          <BudgetsScreen
            onBack={() => setRoute("spending")}
            onImport={() => {
              setImportOrigin("budgets");
              setRoute("import");
            }}
          />
        )}

        {route === "goals" && (
          <GoalsScreen
            onImport={() => {
              setImportOrigin("goals");
              setRoute("import");
            }}
          />
        )}

        {route === "cashflow" && (
          <CashflowScreen
            onImport={() => {
              setImportOrigin("cashflow");
              setRoute("import");
            }}
          />
        )}

        {route === "report" && (
          <MonthlyReportScreen
            onBack={() => setRoute("spending")}
            onImport={() => {
              setImportOrigin("report");
              setRoute("import");
            }}
          />
        )}

        {route === "transactions" && (
          <TransactionsScreen
            focus={txFocus ?? undefined}
            onClearFocus={() => setTxFocus(null)}
            onBack={() => setRoute("insights")}
          />
        )}

        {route === "insights" && (
          <InsightsScreen
            period={insightsPeriod}
            setPeriod={setInsightsPeriod}
            periodKey={insightsPeriodKey}
            setPeriodKey={setInsightsPeriodKey}
            onSeeTransactions={(focus) => {
              // Carry the insight's transactions AND its backend total into the
              // Transactions screen so the drill-down filters to that set and can
              // show what they add up to — without the browser summing anything.
              setTxFocus(focus);
              setRoute("transactions");
            }}
          />
        )}

        {route === "accounts" && (
          <AccountsScreen
            onConnect={() => {
              setImportOrigin("accounts");
              setRoute("import");
            }}
            onOpenNetWorth={() => setRoute("networth")}
          />
        )}

        {route === "networth" && <NetWorthScreen onBack={() => setRoute("accounts")} />}

        {route === "assistant" && (
          <AssistantScreen
            onImport={() => {
              setImportOrigin("assistant");
              setRoute("import");
            }}
          />
        )}

        {route === "import" && (
          <ImportScreen
            onBack={() => setRoute(importOrigin)}
            onImported={() => {
              // A fresh import changes the accounts and history the affordability
              // snapshot is derived from, so it is rebuilt rather than left stale.
              void loadSnapshot();
            }}
          />
        )}

        {route === "check" && (
          <CheckScreen
            draft={draft}
            onChange={setDraft}
            onSubmit={() => void submit()}
            submitting={submitting}
            onOpenGoals={() => setRoute("goals")}
            snapshotNotes={snapshotNotes}
            obligations={snapshot?.recurringObligations.filter((o) => o.required)}
            obligationsConfirmed={obligationsConfirmed}
            onConfirmObligations={setObligationsConfirmed}
            blockedBy={
              snapshot === null
                ? {
                    message:
                      "Import a statement first — this answer is built from your own accounts and history.",
                    onFix: () => setRoute("import"),
                  }
                : undefined
            }
          />
        )}

        {route === "result" && outcome?.kind === "result" && evaluated && (
          <ResultScreen
            response={outcome.response}
            snapshot={evaluated}
            onResolve={(target) => setRoute(target === "purchase" ? "check" : "import")}
          />
        )}

        {route === "result" && outcome === null && (
          <p className="text-body text-ink-secondary">{UI_COPY.emptyNoPurchase}</p>
        )}

        {/* A thrown validation error is distinct from a valid UNKNOWN result. */}
        {route === "result" && outcome?.kind === "invalid" && (
          <div className="max-w-[560px]">
            <p className="text-body">{UI_COPY.errorBoundary}</p>
            <ul className="mt-3 space-y-1 text-meta text-ink-tertiary">
              {outcome.issues.map((issue, i) => (
                <li key={i}>
                  {issue.path.join(".")}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {route === "result" && outcome?.kind === "error" && (
          <div className="max-w-[560px]">
            <p className="text-body">{UI_COPY.errorBoundary}</p>
            <p className="mt-2 text-meta text-ink-tertiary">{outcome.message}</p>
          </div>
        )}

        {route === "admin" && (user?.role === "admin" ? <AdminScreen /> : (
          <p className="text-body text-ink-secondary">Admin access required.</p>
        ))}

        {route === "settings" && <SettingsScreen />}
      </AppShell>

      {/* The living "b" — a floating, page-aware assistant. Hidden on the
          Assistant screen itself, where the full experience already lives, and
          when the user has hidden the coin in Settings (the assistant is still
          reachable from the nav). */}
      {route !== "assistant" && mascotPrefs.visible && (
        <AssistantMascot route={route} onOpenAssistant={() => setRoute("assistant")} />
      )}
    </AssistantScopeProvider>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Change password modal -------------------------------------------------

function ChangePasswordModal({
  onClose,
  onRefresh,
}: {
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await changePassword(current, next);
    setBusy(false);
    if (result.kind === "ok") {
      setDone(true);
      onRefresh();
      setTimeout(onClose, 1500);
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setError("Password change failed.");
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Change password"
    >
      <Card className="w-full max-w-[400px]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-heading text-ink">Change password</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-tertiary hover:text-ink"
          >
            ✕
          </button>
        </div>

        {done ? (
          <p className="text-body text-accent">Password changed successfully.</p>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-label text-ink-secondary">Current password</span>
              <input
                type="password"
                className="input"
                value={current}
                autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label text-ink-secondary">New password</span>
              <input
                type="password"
                className="input"
                value={next}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={8}
              />
            </label>

            {error && <p className="text-body text-alert">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="min-h-[40px] w-full rounded-md bg-accent text-body font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Change password"}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
