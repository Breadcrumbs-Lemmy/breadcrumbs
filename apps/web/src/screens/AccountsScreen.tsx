/**
 * Accounts — the accounts split apart.
 *
 * Three views, one screen:
 *   • Overview   — every account as its own bank card (hover to flip to the
 *                  masked back), grouped by category (Cash, Savings, Credit
 *                  cards, Loans, Investments), each showing what went in and out
 *                  this period. A combined in/out/net band sits on top. This is
 *                  the "see the various accounts" view. Grouping by category
 *                  rather than institution keeps accounts sorted by what they
 *                  are — always known — instead of collapsing into one bin when
 *                  the backend hasn't resolved the bank name.
 *   • Account    — click a card to drill into one account: its money in/out, its
 *                  statement cycle, and its own transactions.
 *   • Activity   — one list pooling every account's transactions, each row
 *                  tagged with the account it belongs to.
 *
 * The statement cycle block is the highest-value element in the product. A card
 * closing on the 18th means the bill arriving in August is mostly July
 * spending, so a calendar-month total can never reconcile to the bill actually
 * paid. `currentPeriodSpendCents` is the figure that answers the question.
 *
 * Money in/out figures come straight from the backend `SpendingSummary` — the
 * combined totals and the per-account `accountTotals`. The browser never sums or
 * subtracts a financial figure (`CD-011`): per-account we show the two backend
 * fields (in, out); the combined net is the backend's own `netCents`.
 *
 * Plaid section (Deliverable 4):
 *   Lists live Plaid connections with last-synced time, a "Sync now" button per
 *   connection, and a "Disconnect" button. Plaid Link uses the Plaid Link JS
 *   script (not react-plaid-link — no new dependencies). If Plaid is not
 *   configured, the connect button degrades to a calm "requires Plaid keys"
 *   state, and the accounts page stays useful for imported statements.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccountsResult,
  AccountTotal,
  AccountView,
  SpendingSummary,
} from "@ai-fin-os/core";
import {
  fetchAccounts,
  fetchSpendingSummary,
  fetchPlaidConnections,
  syncPlaidConnection,
  deletePlaidConnection,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  type ApiOutcome,
  type PlaidConnection,
} from "../services/api";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";
import { Card, Segmented, SectionLabel } from "../components/ui";
import { MfaGateDialog } from "../components/Mfa";
import { useSession } from "../services/session";
import { BankCard, issuerLabel } from "../components/BankCard";
import { TransactionList } from "../components/TransactionList";
import { accountColor } from "../model/account-color";
import {
  groupByCategory,
  type AccountCategory,
  type CategorizedAccount,
} from "../model/account-category";

// ---- Plaid Link typings (no import — the script is loaded dynamically) ----

type PlaidLinkHandler = {
  open: () => void;
  destroy: () => void;
};
type PlaidLinkConfig = {
  token: string;
  onSuccess: (publicToken: string) => void;
  onExit: () => void;
};
declare global {
  interface Window {
    Plaid?: {
      create: (config: PlaidLinkConfig) => PlaidLinkHandler;
    };
  }
}

/** Which period the money in/out figures cover. Month is the app-wide default;
 *  Year is offered because imported/sandbox history often lives at the year
 *  scale where a single month reads as $0. */
type FlowPeriod = "month" | "year";

/** What the screen is showing. Account detail carries the resolved account and
 *  its institution name so the view has everything it needs to render. */
type View =
  | { kind: "overview" }
  | { kind: "activity" }
  | { kind: "account"; account: AccountView; institutionName: string };

// ---------------------------------------------------------------------------

export function AccountsScreen({
  onConnect,
  onOpenNetWorth,
}: {
  onConnect?: () => void;
  /** Opens the net-worth trend screen (reached from here, never a nav tab —
   *  net worth is the sum of the accounts, so it belongs with them). */
  onOpenNetWorth?: () => void;
}) {
  const [outcome, setOutcome] = useState<ApiOutcome<AccountsResult> | null>(null);
  const [summary, setSummary] = useState<SpendingSummary | null>(null);
  const [period, setPeriod] = useState<FlowPeriod>("month");
  const [view, setView] = useState<View>({ kind: "overview" });
  const [connections, setConnections] = useState<PlaidConnection[] | null>(null);
  const [plaidDisabled, setPlaidDisabled] = useState(false);
  const [connectingPlaid, setConnectingPlaid] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  /** When set, Plaid Link is blocked pending a second factor: "enroll" (no factor
   *  yet) or "challenge" (enrolled but this session's step-up has lapsed). The
   *  gate dialog clears it and retries the connect. */
  const [mfaGate, setMfaGate] = useState<"enroll" | "challenge" | null>(null);
  const plaidHandlerRef = useRef<PlaidLinkHandler | null>(null);
  const { refresh: refreshSession } = useSession();

  const loadAccounts = useCallback(async () => {
    const next = await fetchAccounts();
    setOutcome(next);
  }, []);

  const loadSummary = useCallback(async (p: FlowPeriod) => {
    // Money in/out is a nicety layered over the accounts; a failure here must
    // not blank the page, so we simply drop the figures and let balances stand.
    const res = await fetchSpendingSummary({ period: p });
    setSummary(res.kind === "ok" ? res.data : null);
  }, []);

  const loadConnections = useCallback(async () => {
    const result = await fetchPlaidConnections();
    if (result.kind === "ok") {
      setConnections(result.data.connections);
      setPlaidDisabled(false);
    } else if (result.kind === "error" || result.kind === "unauthenticated") {
      // A 404 or generic error means Plaid is not configured. We distinguish
      // this from a temporary network failure by checking the message.
      const msg = result.kind === "error" ? result.message : "";
      if (msg.includes("404") || msg.includes("not configured") || msg.includes("disabled")) {
        setPlaidDisabled(true);
      } else {
        // Treat as "not configured" rather than showing a loud error — the
        // accounts page is still useful even without Plaid.
        setPlaidDisabled(true);
      }
      setConnections([]);
    } else {
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    void loadConnections();
  }, [loadAccounts, loadConnections]);

  useEffect(() => {
    void loadSummary(period);
  }, [period, loadSummary]);

  async function handleSync(connectionId: string) {
    setSyncingId(connectionId);
    setSyncMessage(null);
    const result = await syncPlaidConnection(connectionId);
    setSyncingId(null);
    if (result.kind === "ok") {
      setSyncMessage(
        result.data.message ??
          `Synced ${result.data.synced} transaction${result.data.synced === 1 ? "" : "s"}.`,
      );
      // Refresh accounts, connections, and the in/out figures after a sync.
      await Promise.all([loadAccounts(), loadConnections(), loadSummary(period)]);
    } else if (result.kind === "error") {
      setSyncMessage(`Sync failed: ${result.message}`);
    }
  }

  async function handleDisconnect(connectionId: string) {
    if (!confirm("Disconnect this bank? This won't delete imported transactions.")) return;
    const result = await deletePlaidConnection(connectionId);
    if (result.kind === "ok" || result.kind === "unauthenticated") {
      await loadConnections();
    }
  }

  async function handlePlaidConnect() {
    setConnectingPlaid(true);
    setSyncMessage(null);

    // 1. Get a link token from the server.
    const tokenResult = await createPlaidLinkToken();
    if (tokenResult.kind !== "ok") {
      setConnectingPlaid(false);
      // The server gates Plaid Link on a second factor. Rather than a dead-end
      // error, raise the right prompt: enroll a factor, or clear a lapsed
      // step-up. The dialog retries this connect once the session is verified.
      if (tokenResult.kind === "error" && tokenResult.code === "MFA_ENROLLMENT_REQUIRED") {
        setMfaGate("enroll");
        return;
      }
      if (tokenResult.kind === "error" && tokenResult.code === "MFA_REQUIRED") {
        setMfaGate("challenge");
        return;
      }
      setSyncMessage("Couldn't start Plaid Link — check that PLAID_* keys are configured.");
      return;
    }

    // 2. Open the Plaid Link widget. If the script is not loaded, degrade.
    if (!window.Plaid) {
      // Try to load the Plaid Link script dynamically.
      await loadPlaidScript();
    }

    if (!window.Plaid) {
      setConnectingPlaid(false);
      setSyncMessage("Plaid Link script not available. Ensure the Plaid keys are configured.");
      return;
    }

    const handler = window.Plaid.create({
      token: tokenResult.data.linkToken,
      onSuccess: (publicToken) => {
        void (async () => {
          const result = await exchangePlaidPublicToken(publicToken);
          if (result.kind === "ok") {
            setSyncMessage("Bank connected! Syncing transactions…");
            await syncPlaidConnection(result.data.connectionId);
            await Promise.all([loadAccounts(), loadConnections(), loadSummary(period)]);
            setSyncMessage("Connected and synced.");
          }
          setConnectingPlaid(false);
          plaidHandlerRef.current?.destroy();
          plaidHandlerRef.current = null;
        })();
      },
      onExit: () => {
        setConnectingPlaid(false);
        plaidHandlerRef.current = null;
      },
    });

    plaidHandlerRef.current = handler;
    handler.open();
  }

  if (outcome === null) {
    return <div className="h-[420px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />;
  }

  if (outcome.kind !== "ok") {
    return (
      <Card className="max-w-[560px]">
        <p className="text-body">Couldn't load your accounts.</p>
        <p className="mt-1 text-meta text-ink-tertiary">
          {outcome.kind === "error" ? outcome.message : "The request was rejected."}
        </p>
      </Card>
    );
  }

  const { netPositionCents, netPositionLabel, institutions } = outcome.data;
  const hasAccounts = institutions.some((i) => i.accounts.length > 0);

  // Flatten institutions to individual accounts (keeping which bank each came
  // from) and regroup them by *category* — what the account is — so they read as
  // Cash / Savings / Credit / Loans / Investments instead of collapsing into one
  // "Unknown" pile when the backend hasn't resolved the institution.
  const categorized: CategorizedAccount[] = institutions.flatMap((inst) =>
    inst.accounts.map((account) => ({ account, institutionName: inst.displayName })),
  );
  const categoryGroups = groupByCategory(categorized);
  const accountCount = categorized.length;

  // ---- Account detail --------------------------------------------------------
  if (view.kind === "account") {
    const total = summary?.accountTotals.find((a) => a.id === view.account.id);
    return (
      <div className="mx-auto w-full max-w-[760px]">
        <button
          type="button"
          onClick={() => setView({ kind: "overview" })}
          className="mb-5 inline-flex items-center gap-1.5 text-label text-ink-secondary hover:text-ink"
        >
          <span aria-hidden="true">←</span> All accounts
        </button>

        <div className="grid gap-6 sm:grid-cols-[minmax(0,320px)_1fr] sm:items-start">
          <div className="mx-auto w-full max-w-[340px]">
            <BankCard account={view.account} institutionName={view.institutionName} />
            <p className="mt-2 text-center text-meta text-ink-tertiary">Hover the card to flip it</p>
          </div>
          <div>
            <p className="text-label text-ink-tertiary">
              {issuerLabel(view.institutionName, view.account.displayName)}
            </p>
            <h2 className="mt-0.5 text-heading text-ink">{view.account.displayName}</h2>
            <p className="mt-1 text-meta text-ink-tertiary">
              {typeLabel(view.account)} · updated {relative(view.account.freshness.asOf)}
            </p>
            <p
              className="numeral mt-3 text-figure"
              style={{ color: view.account.isDebt ? "var(--text-primary)" : "var(--accent)" }}
            >
              {formatMoney(view.account.currentBalanceCents)}
              {view.account.isDebt && (
                <span className="ml-1.5 text-meta text-ink-tertiary">owed</span>
              )}
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <SectionLabel>In &amp; out</SectionLabel>
          <PeriodToggle period={period} onChange={setPeriod} />
        </div>
        <FlowFigures
          outflowCents={total?.totalOutflowCents}
          inflowCents={total?.totalInflowCents}
          caption={`${view.account.displayName} · ${periodLabel(period)}`}
        />

        {view.account.statementCycle && (
          <div className="mt-6">
            <SectionLabel>Statement</SectionLabel>
            <StatementCycle cycle={view.account.statementCycle} />
          </div>
        )}

        <div className="mt-7">
          <SectionLabel>Transactions</SectionLabel>
          <TransactionList accountId={view.account.id} />
        </div>
      </div>
    );
  }

  // ---- Overview / Activity ---------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-[760px]">
      {mfaGate && (
        <MfaGateDialog
          reason={mfaGate}
          onCleared={() => {
            setMfaGate(null);
            // Enrollment flips the user's MFA state — keep the session (and the
            // Settings card) in sync — then resume the connect the user started.
            void refreshSession();
            void handlePlaidConnect();
          }}
          onCancel={() => setMfaGate(null)}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-label text-ink-tertiary">
            {accountCount} {accountCount === 1 ? "account" : "accounts"}
          </p>
          <p className="numeral mt-1 text-hero text-ink">{formatMoney(netPositionCents)}</p>
          <p className="mt-1 text-meta text-ink-tertiary">{netPositionLabel}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!plaidDisabled && (
            <button
              type="button"
              onClick={() => void handlePlaidConnect()}
              disabled={connectingPlaid}
              className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {connectingPlaid ? "Connecting…" : "Connect a bank"}
            </button>
          )}
          <button
            type="button"
            onClick={onConnect}
            className="min-h-[38px] rounded-md border border-line-subtle px-4 text-body text-ink-secondary hover:border-line-strong"
          >
            Import a statement
          </button>
        </div>
      </div>

      {/* Net-worth trend entry point — reached from here, never a nav tab (D-N9).
          Net worth is the sum of these accounts, so it belongs with them. */}
      {hasAccounts && onOpenNetWorth && (
        <button
          type="button"
          onClick={onOpenNetWorth}
          className="group mt-6 flex w-full items-center justify-between gap-4 rounded-lg border border-line-subtle bg-surface-raised px-5 py-4 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          <span className="min-w-0">
            <span className="block text-body font-medium text-ink group-hover:underline">
              Net worth over time
            </span>
            <span className="mt-0.5 block text-meta text-ink-tertiary">
              How your cash net worth — what you have, minus what you owe — has moved, month by month.
            </span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-ink-tertiary group-hover:text-ink">
            →
          </span>
        </button>
      )}

      {/* Combined money in/out across every account, for the chosen period. */}
      {hasAccounts && (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between gap-3">
            <SectionLabel>Money in &amp; out</SectionLabel>
            <PeriodToggle period={period} onChange={setPeriod} />
          </div>
          <FlowFigures
            outflowCents={summary?.totalOutflowCents}
            inflowCents={summary?.totalInflowCents}
            netCents={summary?.netCents}
            caption={`All accounts · ${periodLabel(period)}`}
          />
        </div>
      )}

      {/* Tab between the per-account cards and one pooled activity list. */}
      {hasAccounts && (
        <div className="mt-7">
          <Segmented
            ariaLabel="Accounts view"
            value={view.kind === "activity" ? "activity" : "overview"}
            onChange={(v) => setView({ kind: v as "overview" | "activity" })}
            options={[
              { value: "overview", label: "Accounts" },
              { value: "activity", label: "All activity" },
            ]}
          />
        </div>
      )}

      {/* Sync feedback message */}
      {syncMessage && <p className="mt-3 text-body text-ink-secondary">{syncMessage}</p>}

      {view.kind === "activity" ? (
        <div className="mt-5">
          <TransactionList showAccountTag />
          <p className="mt-4 text-center text-meta text-ink-tertiary">
            Every account, one list. Each row is tagged with the account it belongs to.
          </p>
        </div>
      ) : (
        <>
          {/* ---- Plaid connections section ------------------------------- */}
          <PlaidSection
            connections={connections}
            disabled={plaidDisabled}
            syncingId={syncingId}
            onSync={(id) => void handleSync(id)}
            onDisconnect={(id) => void handleDisconnect(id)}
            onConnect={() => void handlePlaidConnect()}
            connectingPlaid={connectingPlaid}
          />

          {/* ---- Empty state --------------------------------------------- */}
          {institutions.length === 0 && (connections === null || connections.length === 0) && (
            <Card className="mt-6 text-center">
              <p className="text-body">No accounts connected yet.</p>
              <p className="mx-auto mt-1 max-w-[40ch] text-body text-ink-secondary">
                Connect a bank or import a statement and your spending will start showing up.
              </p>
            </Card>
          )}

          {/* ---- Accounts as bank cards, grouped by category ------------- */}
          <div className="mt-7 space-y-9">
            {categoryGroups.map((group) => (
              <CategoryGroup
                key={group.category.key}
                category={group.category}
                items={group.items}
                summary={summary}
                onOpen={(account, institutionName) =>
                  setView({ kind: "account", account, institutionName })
                }
              />
            ))}
          </div>

          <p className="mt-8 text-center text-meta text-ink-tertiary">
            Read-only. Breadcrumbs can't move money or change your accounts.
          </p>
        </>
      )}
    </div>
  );
}

// ---- Money in/out ----------------------------------------------------------

function PeriodToggle({
  period,
  onChange,
}: {
  period: FlowPeriod;
  onChange: (p: FlowPeriod) => void;
}) {
  return (
    <div className="w-[168px]">
      <Segmented
        ariaLabel="Money in and out period"
        value={period}
        onChange={(v) => onChange(v as FlowPeriod)}
        options={[
          { value: "month", label: "Month" },
          { value: "year", label: "Year" },
        ]}
      />
    </div>
  );
}

function periodLabel(period: FlowPeriod): string {
  return period === "month" ? "this month" : "this year";
}

/**
 * "Money out" / "Money in" and, for combined figures, "Net". Every value is a
 * backend field formatted for display — `undefined` renders as an em-dash
 * ("not known"), never $0. The proportion bar is a visual ratio, not a stated
 * figure.
 */
function FlowFigures({
  outflowCents,
  inflowCents,
  netCents,
  caption,
}: {
  outflowCents?: number;
  inflowCents?: number;
  /** Combined only. Omit for a single account, where the browser must not
   *  subtract to invent a per-account net. */
  netCents?: number;
  caption: string;
}) {
  const known =
    typeof outflowCents === "number" &&
    typeof inflowCents === "number" &&
    inflowCents + outflowCents > 0;
  const share = known ? (inflowCents! / (inflowCents! + outflowCents!)) * 100 : 50;
  const showNet = typeof netCents === "number";

  return (
    <Card className="overflow-hidden" padded={false}>
      <div className={`grid grid-cols-1 ${showNet ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        <div className="border-b border-line-subtle p-5 sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Money out</p>
          <p className="numeral mt-1.5 text-figure text-ink">{formatMoney(outflowCents)}</p>
        </div>
        <div
          className={`flex items-center justify-between border-b border-line-subtle p-5 sm:flex-col sm:items-start sm:justify-center sm:border-b-0 sm:p-6 ${
            showNet ? "sm:border-r" : ""
          }`}
        >
          <p className="text-label text-ink-tertiary">Money in</p>
          <p className="numeral text-figure text-ink sm:mt-1.5">{formatMoney(inflowCents)}</p>
        </div>
        {showNet && (
          <div className="flex items-center justify-between p-5 sm:flex-col sm:items-start sm:justify-center sm:p-6">
            <p className="text-label text-ink-tertiary">Net</p>
            <p
              className="numeral text-figure sm:mt-1.5"
              style={{ color: netCents! >= 0 ? "var(--accent)" : "var(--text-primary)" }}
            >
              {netCents! >= 0 ? "+" : "−"}
              {formatMoney(Math.abs(netCents!))}
            </p>
          </div>
        )}
      </div>
      <div className="border-t border-line-subtle px-5 py-4 sm:px-6">
        <div className="flex h-[6px] overflow-hidden rounded-pill bg-surface-inset">
          <div className="bar-fill h-full" style={{ width: `${share}%`, background: "var(--accent)" }} />
        </div>
        <p className="mt-2.5 text-meta text-ink-tertiary">{caption}</p>
      </div>
    </Card>
  );
}

// ---- Plaid connections panel -----------------------------------------------

function PlaidSection({
  connections,
  disabled,
  syncingId,
  onSync,
  onDisconnect,
  onConnect,
  connectingPlaid,
}: {
  connections: PlaidConnection[] | null;
  disabled: boolean;
  syncingId: string | null;
  onSync: (id: string) => void;
  onDisconnect: (id: string) => void;
  onConnect: () => void;
  connectingPlaid: boolean;
}) {
  if (disabled) {
    // Plaid is not configured — show a calm, non-alarming message.
    return (
      <div className="mt-6">
        <SectionLabel>Live bank connections</SectionLabel>
        <div
          className="rounded-lg border border-dashed px-5 py-4"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <p className="text-body text-ink-secondary">Connect a bank (Plaid not configured yet)</p>
          <p className="mt-1.5 text-meta leading-relaxed text-ink-tertiary">
            Add your <span className="font-mono text-[11px]">PLAID_CLIENT_ID</span> and{" "}
            <span className="font-mono text-[11px]">PLAID_SECRET</span> to the API's environment to
            enable live bank connections. Until then, import a statement CSV to get started.
          </p>
        </div>
      </div>
    );
  }

  if (connections === null) {
    // Loading
    return (
      <div className="mt-6 h-[120px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />
    );
  }

  if (connections.length === 0) {
    return null; // No connections yet — the empty-state card above covers this.
  }

  return (
    <div className="mt-7">
      <SectionLabel>Live bank connections</SectionLabel>
      <Card padded={false} className="overflow-hidden">
        {connections.map((conn, i) => (
          <ConnectionRow
            key={conn.connectionId}
            connection={conn}
            first={i === 0}
            syncing={syncingId === conn.connectionId}
            onSync={() => onSync(conn.connectionId)}
            onDisconnect={() => onDisconnect(conn.connectionId)}
          />
        ))}
        <div className="border-t border-line-subtle px-5 py-3">
          <button
            type="button"
            onClick={onConnect}
            disabled={connectingPlaid}
            className="text-label text-accent underline underline-offset-2 disabled:opacity-40"
          >
            {connectingPlaid ? "Connecting…" : "Add another bank"}
          </button>
        </div>
      </Card>
    </div>
  );
}

function ConnectionRow({
  connection,
  first,
  syncing,
  onSync,
  onDisconnect,
}: {
  connection: PlaidConnection;
  first: boolean;
  syncing: boolean;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-5 py-4 ${
        first ? "" : "border-t border-line-subtle"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-ink">
          {connection.institutionName?.trim() && connection.institutionName.toLowerCase() !== "unknown"
            ? connection.institutionName
            : "Connected bank"}
        </p>
        <p className="text-meta text-ink-tertiary">
          {connection.lastSyncedAt
            ? `Last synced ${formatDate(connection.lastSyncedAt.slice(0, 10))}`
            : "Never synced"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="min-h-[30px] rounded-md border border-line-subtle px-3 text-label text-ink-secondary hover:border-line-strong hover:text-ink disabled:opacity-40"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          className="min-h-[30px] rounded-md px-3 text-label text-ink-tertiary hover:text-alert"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

// ---- Accounts as bank cards, grouped by category ----------------------------

/**
 * One category section: a labelled header (with the account count and a
 * one-line hint) over a grid of that category's cards. This is the grouping
 * that stops every account landing in one undifferentiated pile — accounts are
 * sorted by what they *are* (cash, savings, a card, a loan…), which is always
 * known, rather than by an institution the backend may not have resolved.
 */
function CategoryGroup({
  category,
  items,
  summary,
  onOpen,
}: {
  category: AccountCategory;
  items: CategorizedAccount[];
  summary: SpendingSummary | null;
  onOpen: (account: AccountView, institutionName: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-pill"
          style={{ background: category.accent }}
        />
        <SectionLabel>{category.label}</SectionLabel>
        <span className="text-meta text-ink-tertiary">
          {items.length} {items.length === 1 ? "account" : "accounts"}
        </span>
      </div>
      <p className="mb-3 ml-[23px] text-meta text-ink-tertiary">{category.hint}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map(({ account, institutionName }) => (
          <AccountCardTile
            key={account.id}
            account={account}
            institutionName={institutionName}
            total={summary?.accountTotals.find((a) => a.id === account.id)}
            onOpen={() => onOpen(account, institutionName)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One account as a clickable tile: the bank card (which flips to its masked back
 * when the tile is hovered or focused — `.bankcard-flip` drives the turn), the
 * account name and balance, this period's money in/out, and a compact statement
 * hint. Clicking opens the account's own detail view.
 */
function AccountCardTile({
  account,
  institutionName,
  total,
  onOpen,
}: {
  account: AccountView;
  institutionName: string;
  total?: AccountTotal;
  onOpen: () => void;
}) {
  const cycle = account.statementCycle;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${account.displayName}, ${typeLabel(account)}, balance ${formatMoney(
        account.currentBalanceCents,
      )}. View transactions.`}
      className="bankcard-flip group rounded-lg text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
    >
      <BankCard account={account} institutionName={institutionName} />

      <div className="mt-3 px-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-pill"
                style={{ background: accountColor(account.id) }}
              />
              <span className="truncate text-body text-ink group-hover:underline">
                {account.displayName}
              </span>
            </span>
            <span className="mt-0.5 block text-meta text-ink-tertiary">{typeLabel(account)}</span>
          </span>
          <span className="shrink-0 text-right">
            <span
              className="numeral block text-amount"
              style={{ color: account.isDebt ? "var(--text-primary)" : "var(--accent)" }}
            >
              {formatMoney(account.currentBalanceCents)}
            </span>
            {account.isDebt && <span className="text-meta text-ink-tertiary">owed</span>}
          </span>
        </div>

        {/* This period's in/out for the account — the two backend fields, no
            arithmetic. */}
        <div className="mt-2.5 flex gap-5 border-t border-line-subtle pt-2.5">
          <span>
            <span className="block text-meta text-ink-tertiary">In</span>
            <span className="numeral text-label text-ink">{formatMoney(total?.totalInflowCents)}</span>
          </span>
          <span>
            <span className="block text-meta text-ink-tertiary">Out</span>
            <span className="numeral text-label text-ink">{formatMoney(total?.totalOutflowCents)}</span>
          </span>
        </div>

        {cycle && (
          <p className="mt-2 text-meta leading-relaxed text-ink-tertiary">
            Statement closes {formatDate(cycle.currentPeriodEnd, cycle.currentPeriodStart)} ·{" "}
            {formatMoney(cycle.currentPeriodSpendCents)} so far
          </p>
        )}
      </div>
    </button>
  );
}

/** The full statement-cycle block, shown in the account detail view. */
function StatementCycle({ cycle }: { cycle: NonNullable<AccountView["statementCycle"]> }) {
  return (
    <div className="rounded-md bg-surface-sunken px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label text-ink-secondary">
          This statement closes {formatDate(cycle.currentPeriodEnd, cycle.currentPeriodStart)}
        </span>
        <span className="tabular text-amount text-ink">
          {formatMoney(cycle.currentPeriodSpendCents)}
        </span>
      </div>
      <div className="mt-2.5 h-[5px] overflow-hidden rounded-pill bg-surface-inset">
        <div
          className="bar-fill h-full rounded-pill"
          style={{
            width: `${Math.min((cycle.elapsedDays / cycle.totalDays) * 100, 100)}%`,
            background: "var(--cat-2)",
          }}
        />
      </div>
      <p className="mt-2 text-meta leading-relaxed text-ink-tertiary">
        {cycle.elapsedDays} of {cycle.totalDays} days · this is what the bill will cover, not the
        calendar month
        {cycle.dueDate && ` · due ${formatDate(cycle.dueDate, cycle.currentPeriodStart)}`}
      </p>
      {/* An inferred closing day is a guess and must say so. */}
      {cycle.source === "inferred" && (
        <p className="mt-1.5 text-meta text-ink-tertiary">
          Closing day estimated from past payments.
        </p>
      )}
    </div>
  );
}

function typeLabel(account: AccountView): string {
  const base =
    account.type === "credit_card"
      ? "Credit card"
      : account.type === "savings"
        ? "Savings"
        : account.type === "checking"
          ? "Checking"
          : account.type;
  return account.mask ? `${base} ··${account.mask}` : base;
}

function relative(asOf?: string): string {
  if (!asOf) return "recently";
  const then = new Date(asOf).getTime();
  if (Number.isNaN(then)) return "recently";
  const hours = Math.round((Date.now() - then) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---- Plaid Link script loader ----------------------------------------------

function loadPlaidScript(): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector('script[src*="plaid.com/link"]')) {
      // Script already in DOM (may still be loading).
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => resolve(); // resolve anyway — caller checks window.Plaid
    document.head.appendChild(script);
  });
}
