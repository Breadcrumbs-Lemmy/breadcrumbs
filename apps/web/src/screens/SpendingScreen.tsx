/**
 * Spending home — the product's primary surface (`D-011`).
 * Specified in `docs/ui-spending-home.md`.
 *
 * Web first. At desktop the screen is a two-column grid: the figures and the
 * category breakdown on the left, secondary panels on the right. Below `lg` it
 * collapses to one column in the same reading order, so nothing is lost and the
 * layout an iOS build would start from is already correct.
 *
 * Every figure is a named field from `MonthlySpendingSummary`. The one
 * arithmetic operation is `totalInflowCents - totalOutflowCents` for "left
 * over", which composes two adjacent backend figures for display rather than
 * deriving anything financial.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpendingSummary } from "@ai-fin-os/core";
import {
  loadSpending,
  loadStatementAccounts,
  type SpendingOutcome,
  type StatementAccount,
} from "../services/spending";
import { PERIOD_LABELS, isPeriodSupported, type PeriodKind } from "../model/period";
import { useAssistantView } from "../services/assistant-scope";
import { categoryColor } from "../model/category-color";
import { formatMoney } from "../format/money";
import { Bar, Card, Chip, CountUpMoney, Delta, Segmented, SectionLabel } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { issuerLabel } from "../components/BankCard";

const PERIODS: PeriodKind[] = ["week", "month", "year", "statement"];

export function SpendingScreen({
  onCheckPurchase,
  onImport,
  onOpenBudgets,
  onOpenCashflow,
  onOpenReport,
}: {
  onCheckPurchase?: () => void;
  onImport?: () => void;
  onOpenBudgets?: () => void;
  onOpenCashflow?: () => void;
  onOpenReport?: () => void;
}) {
  const [period, setPeriod] = useState<PeriodKind>("month");
  const [outcome, setOutcome] = useState<SpendingOutcome | null>(null);
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  /** Cards that actually carry a closing day. Statement periods are offered
   *  only when one exists — discovered from the API rather than declared in a
   *  local flag, per `CD-013`. Without a cycle the endpoint silently falls back
   *  to a calendar month, which is the confusion this view exists to prevent. */
  const [statementAccounts, setStatementAccounts] = useState<StatementAccount[] | null>(null);
  /** True while a scoped re-fetch is in flight but the previous view is still on
   *  screen. Switching the account filter re-scopes the same period, so the page
   *  dims in place instead of blinking down to a skeleton — the "everything jumps"
   *  the redesign removes. */
  const [refreshing, setRefreshing] = useState(false);
  /** The full account roster + top-line total from the most recent *unscoped*
   *  load. A filtered summary only carries the one account it was scoped to, so
   *  without this the account picker would collapse to a single row the moment a
   *  filter is applied — the "Savings sometimes shows, sometimes doesn't" bug. */
  const [roster, setRoster] = useState<{
    accounts: SpendingSummary["accountTotals"];
    totalOutflowCents: number;
    bankCount: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadStatementAccounts().then((next) => !cancelled && setStatementAccounts(next));
    return () => {
      cancelled = true;
    };
  }, []);

  const statementReady = (statementAccounts?.length ?? 0) > 0;
  const supported = useCallback(
    (kind: PeriodKind) => (kind === "statement" ? statementReady : isPeriodSupported(kind)),
    [statementReady],
  );

  // A card whose statement is being viewed is chosen here, not by the account
  // filter: the API requires an accountId for this period kind and rejects the
  // request without one.
  const statementAccountId = accountId ?? statementAccounts?.[0]?.id;

  // The "dataset" currently on screen — the period plus the specific key, but
  // *not* the account filter. Switching account re-scopes the same dataset, so
  // it should refresh in place rather than blink the whole page down to a
  // skeleton and back.
  const datasetRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // An unsupported period is not a request worth making. Sending it anyway
    // returns a 400, which the screen used to render as "Couldn't load your
    // spending — start the API" over a perfectly healthy API.
    if (!supported(period)) {
      setOutcome(null);
      datasetRef.current = null;
      return;
    }
    const datasetKey = `${period}|${monthKey ?? ""}`;
    const sameDataset = datasetRef.current === datasetKey;
    datasetRef.current = datasetKey;
    // A genuinely new period gets the skeleton; a same-period account switch
    // keeps the current view and dims it while the scoped figures load.
    if (sameDataset) setRefreshing(true);
    else setOutcome(null);
    const scopedAccount = period === "statement" ? statementAccountId : accountId ?? undefined;
    void loadSpending(period, monthKey ?? undefined, scopedAccount).then((next) => {
      if (cancelled) return;
      setOutcome(next);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [period, monthKey, accountId, supported, statementAccountId]);

  // Snapshot the account roster from every unscoped, all-accounts load, so a
  // later filtered load still has the full list to render the picker from.
  // Statement periods are always scoped to one card, so they never define the
  // roster.
  useEffect(() => {
    if (outcome?.kind === "ready" && accountId === null && period !== "statement") {
      setRoster({
        accounts: outcome.summary.accountTotals,
        totalOutflowCents: outcome.summary.totalOutflowCents,
        bankCount: outcome.summary.institutionTotals.length,
      });
    }
  }, [outcome, accountId, period]);

  const summary = outcome?.kind === "ready" ? outcome.summary : undefined;
  const available = useMemo(
    () => (outcome?.kind === "ready" ? outcome.available : []),
    [outcome],
  );

  // Prefer the snapshotted all-accounts roster; before the first unscoped load
  // has landed (e.g. arriving straight into a statement period) fall back to
  // whatever the current summary carries so the picker still has something.
  const rosterData =
    roster ??
    (summary
      ? {
          accounts: summary.accountTotals,
          totalOutflowCents: summary.totalOutflowCents,
          bankCount: summary.institutionTotals.length,
        }
      : null);
  const selectedAccount =
    accountId && rosterData ? rosterData.accounts.find((a) => a.id === accountId) : undefined;

  // Tell the assistant exactly what's on screen: the resolved period (the
  // backend-echoed key/label, so "Week of 19 May" scopes the answer to that
  // week, not the current month) and the account filter. For a statement period
  // the viewed card *is* the filter even when the picker reads "All accounts",
  // so fall back to the statement card so the scope names the right account.
  const scopedAccount = selectedAccount
    ? { id: selectedAccount.id, label: selectedAccount.displayName }
    : period === "statement" && statementAccountId
      ? {
          id: statementAccountId,
          label: statementAccounts?.find((a) => a.id === statementAccountId)?.displayName,
        }
      : undefined;
  useAssistantView(
    summary
      ? {
          period: {
            kind: summary.period.kind,
            key: summary.period.key,
            label: summary.period.label,
          },
          account: scopedAccount,
        }
      : null,
  );

  return (
    <>
      {/* Controls sit above the grid so they govern the whole page, not one
          column. Period on the left, period navigation on the right — the
          desktop convention, and it keeps both reachable without scrolling. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-[360px]">
          <Segmented
            ariaLabel="Time period"
            value={period}
            onChange={(next) => {
              setPeriod(next);
              // Period keys are kind-specific: "2026-06" means nothing to the
              // week endpoint, which would quietly fall back to the current
              // week rather than reporting the mismatch.
              setMonthKey(null);
              setExpanded(false);
              // A new period has its own account roster and figures; drop the
              // filter so the picker re-snapshots against the period on screen.
              setAccountId(null);
            }}
            options={PERIODS.map((p) => ({
              value: p,
              label: PERIOD_LABELS[p],
              muted: !supported(p),
            }))}
          />
        </div>

        {summary && available.length > 1 && (
          /* overflow-x-auto handles any number of periods. The -slice(-6) cap
             is deliberately removed so users can scroll back as far as their
             data reaches — the headline complaint was "only a couple of days". */
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {available.map((p) => (
              <Chip
                key={p.key}
                active={p.key === summary.period.key}
                onClick={() => {
                  setMonthKey(p.key);
                  setExpanded(false);
                  setAccountId(null);
                }}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {!supported(period) && <NotYet period={period} />}
      {supported(period) && outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="mt-6 max-w-[560px]">
          <p className="text-body">Couldn't load your spending.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {outcome?.kind === "empty" && (
        <Card className="mt-6 max-w-[560px] text-center">
          <div className="mb-4 flex justify-center">
            <LogoMark size={46} beacon />
          </div>
          <p className="font-display text-[1.35rem] font-medium text-ink">Nothing here yet</p>
          <p className="mx-auto mt-2 max-w-[38ch] text-body text-ink-secondary">
            Import a statement and your spending will show up here, grouped and compared — follow
            the trail your money left.
          </p>
          <button
            type="button"
            onClick={onImport}
            className="mt-5 min-h-[40px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover"
          >
            Import a statement
          </button>
        </Card>
      )}

      {summary && (
        <div
          // Keyed on the period only: switching account re-scopes the same grid
          // in place, so it must not remount (a remount would replay the fade
          // and read as the page "jumping").
          key={summary.period.key}
          className={`fade-in mt-6 grid grid-cols-1 gap-5 transition-opacity duration-200 lg:grid-cols-12 ${
            refreshing ? "opacity-60" : "opacity-100"
          }`}
          aria-busy={refreshing}
        >
          {/* ---- Primary column ---------------------------------------- */}
          <div className="space-y-5 lg:col-span-7 xl:col-span-8">
            <Figures summary={summary} accountId={accountId} />

            <div>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <SectionLabel>Where it went</SectionLabel>
                {selectedAccount && (
                  <span className="shrink-0 truncate text-meta text-ink-tertiary">
                    {selectedAccount.displayName} only
                  </span>
                )}
              </div>
              {/* The summary is already scoped to the selected account server-
                  side, so its categoryTotals are that account's own breakdown —
                  no need to hide it behind "clear the filter". Keeping the card
                  present is also what stops the layout from collapsing when a
                  filter is applied. */}
              <Categories
                summary={summary}
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
              />
            </div>
          </div>

          {/* ---- Secondary column -------------------------------------- */}
          <div className="space-y-5 lg:col-span-5 xl:col-span-4">
            {rosterData && rosterData.accounts.length > 0 && (
              <AccountsPanel
                accounts={rosterData.accounts}
                bankCount={rosterData.bankCount}
                totalOutflowCents={rosterData.totalOutflowCents}
                selected={accountId}
                onSelect={setAccountId}
              />
            )}
            <Excluded summary={summary} />

            <button
              type="button"
              onClick={onCheckPurchase}
              className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
              style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
            >
              <span>
                <span className="block text-body text-ink">Thinking about a purchase?</span>
                <span className="mt-0.5 block text-meta text-ink-tertiary">
                  See if it fits before you buy
                </span>
              </span>
              <span aria-hidden="true" className="text-ink-tertiary">
                ›
              </span>
            </button>

            {/* Budgets live on their own screen, reached from here rather than a
                nav tab (the rail spells C·A·P·I·T·A·L). Caps aren't shown inline
                because this screen is multi-period and a cap for one window shown
                against another would mislead — see docs/budgets.md D-B10. */}
            {onOpenBudgets && (
              <button
                type="button"
                onClick={onOpenBudgets}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">Budgets</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    Set weekly or monthly caps and track them
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}

            {/* The forward-looking companion to this backward-looking screen:
                what's scheduled to hit before the next paycheck. Reached from
                here as a button card, not a nav tab (the rail spells
                C·A·P·I·T·A·L, so it stays off it — same rule as Settings) —
                see docs/cashflow.md D-C12. */}
            {onOpenCashflow && (
              <button
                type="button"
                onClick={onOpenCashflow}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">What's coming up</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    Upcoming income and bills before payday
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}

            {/* The monthly "where did my money go" report — a readable,
                printable, exportable summary of a chosen month. Reached from
                here as a button card, not a nav tab (the rail spells
                C·A·P·I·T·A·L, so it stays off it — same rule as Settings) —
                see docs/report.md. */}
            {onOpenReport && (
              <button
                type="button"
                onClick={onOpenReport}
                className="card flex w-full items-center justify-between px-5 py-4 text-left hover:shadow-md"
                style={{ transition: "box-shadow var(--dur-base) var(--ease-out)" }}
              >
                <span>
                  <span className="block text-body text-ink">Where did my money go?</span>
                  <span className="mt-0.5 block text-meta text-ink-tertiary">
                    A monthly report to read, print, or export
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  ›
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The figures block. Three stats across at desktop, stacked on phone.
 * "Went out" stays visually dominant everywhere — it is the question the screen
 * exists to answer.
 */
function Figures({
  summary,
  accountId,
}: {
  summary: SpendingSummary;
  accountId: string | null;
}) {
  const account = accountId ? summary.accountTotals.find((a) => a.id === accountId) : undefined;
  const out = account ? account.totalOutflowCents : summary.totalOutflowCents;
  const inflow = account ? account.totalInflowCents : summary.totalInflowCents;
  // netCents is backend-owned (H-022). The UI no longer subtracts.
  const net = account ? account.totalInflowCents - account.totalOutflowCents : summary.netCents;
  const share = inflow + out > 0 ? (inflow / (inflow + out)) * 100 : 50;
  const c = summary.comparison;
  const showDelta =
    !account && c && c.comparable && (c.direction === "up" || c.direction === "down");

  // The hero size (2.75rem) needs ~23px per character, and a third of this card
  // is 160px of content at a 1280px viewport — room for six characters. The
  // screen was designed against small demo totals; against a real month
  // ("$6,704.48" wants 207px) the figure ran under the divider and collided
  // with "Came in". Stepping down one size is not the nicest resolution — a
  // wider cell or a rounded headline would both keep the emphasis — but a
  // figure that reads as two overlapping numbers is worse than a smaller one.
  const outText = formatMoney(out);
  const outSize = outText.length > 6 ? "text-figure" : "text-hero";

  return (
    <Card className="overflow-hidden" padded={false}>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className="border-b border-line-subtle p-5 sm:col-span-1 sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Went out</p>
          <p className={`numeral mt-1.5 whitespace-nowrap ${outSize} text-ink`}>
            <CountUpMoney cents={out} />
          </p>
          {showDelta && (
            <div className="mt-2.5">
              <Delta direction={c!.direction === "up" ? "up" : "down"}>
                {formatMoney(Math.abs(c!.outflowChangeCents))} on {c!.baselineLabel}
              </Delta>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-line-subtle p-5 sm:flex-col sm:items-start sm:justify-center sm:border-b-0 sm:border-r sm:p-6">
          <p className="text-label text-ink-tertiary">Came in</p>
          <p className="numeral whitespace-nowrap text-figure text-ink sm:mt-1.5">
            {formatMoney(inflow)}
          </p>
        </div>

        <div className="flex items-center justify-between p-5 sm:flex-col sm:items-start sm:justify-center sm:p-6">
          <p className="text-label text-ink-tertiary">Left over</p>
          <p
            className="numeral whitespace-nowrap text-figure sm:mt-1.5"
            style={{ color: net >= 0 ? "var(--accent)" : "var(--text-primary)" }}
          >
            {net >= 0 ? "+" : "−"}
            {formatMoney(Math.abs(net))}
          </p>
        </div>
      </div>

      <div className="border-t border-line-subtle px-5 py-4 sm:px-6">
        <div className="flex h-[6px] overflow-hidden rounded-pill bg-surface-inset">
          <div
            className="bar-fill h-full"
            style={{ width: `${share}%`, background: "var(--accent)" }}
          />
        </div>
        <p className="mt-2.5 text-meta text-ink-tertiary">
          {account
            ? `${account.displayName} only`
            : `${summary.institutionTotals.length} banks · ${summary.accountTotals.length} accounts`}
        </p>
      </div>
    </Card>
  );
}

function Categories({
  summary,
  expanded,
  onToggle,
}: {
  summary: SpendingSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const all = summary.categoryTotals;
  // More rows fit comfortably at desktop, so the fold sits lower there.
  const shown = expanded ? all : all.slice(0, 8);

  return (
    <Card padded={false} className="overflow-hidden">
      {shown.map((c, i) => {
        const delta = c.comparison;
        // Negative comes from a refund with no matching spend this period.
        // Intended (H-016). No bar: a share-of-period width has no meaning
        // below zero.
        const negative = c.outflowCents < 0;
        // shareBasisPoints is backend-supplied so the UI performs no division.
        const pct = negative ? 0 : c.shareBasisPoints / 100;
        const notable = delta && Math.abs(delta.outflowChangeCents) >= 3000;

        return (
          <div key={c.category} className={`px-5 py-3.5 sm:px-6 ${i ? "border-t border-line-subtle" : ""}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-pill"
                  style={{ background: categoryColor(c.category) }}
                />
                <span className="truncate text-body text-ink">{c.displayName}</span>
                {c.category === "unknown" && (
                  // Honest explainer: "Unknown" is a backend classification
                  // gap (unmapped bank category codes, tracked in H-036), not a
                  // real spending place. The copy never invents a category.
                  <span className="group relative inline-flex shrink-0">
                    <button
                      type="button"
                      aria-label="Why is this labelled Unknown?"
                      aria-describedby="unknown-category-help"
                      className="flex h-4 w-4 items-center justify-center rounded-pill border border-line-strong text-[10px] font-semibold leading-none text-ink-tertiary transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none"
                    >
                      ?
                    </button>
                    <span
                      id="unknown-category-help"
                      role="tooltip"
                      className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-52 rounded-md border border-line-subtle bg-surface-raised px-3 py-2 text-meta leading-snug text-ink-secondary opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      Your bank feed didn&rsquo;t tag these with a category the
                      app recognizes yet, so they&rsquo;re grouped here &mdash;
                      not a real place your money went.
                    </span>
                  </span>
                )}
                {notable && (delta!.direction === "up" || delta!.direction === "down") && (
                  <Delta direction={delta!.direction === "up" ? "up" : "down"}>
                    {formatMoney(Math.abs(delta!.outflowChangeCents))}
                  </Delta>
                )}
                {delta?.direction === "new" && (
                  <span className="shrink-0 rounded-pill bg-surface-sunken px-1.5 py-0.5 text-meta text-ink-tertiary">
                    new
                  </span>
                )}
              </span>
              <span className="tabular shrink-0 text-amount text-ink">
                {negative && "−"}
                {formatMoney(Math.abs(c.outflowCents))}
              </span>
            </div>

            {!negative && <Bar pct={pct} color={categoryColor(c.category)} delay={i * 35} />}

            {c.refundCents > 0 && (
              <p className="mt-2 text-meta text-ink-tertiary">
                after {formatMoney(c.refundCents)} back
              </p>
            )}
          </div>
        );
      })}

      {all.length > 8 && (
        <button
          type="button"
          onClick={onToggle}
          className="w-full border-t border-line-subtle py-3 text-label text-ink-secondary hover:bg-surface-sunken"
        >
          {expanded ? "Show less" : `Show ${all.length - 8} more`}
        </button>
      )}
    </Card>
  );
}

/**
 * Accounts — now also the account filter.
 *
 * Previously the screen had two account surfaces: cryptic "Card / Market /
 * Saving" filter chips over "Where it went", and this read-only roster. They
 * said the same thing twice, and selecting a chip silently rescoped the whole
 * page. Folding the filter into the roster leaves one place for accounts:
 * each row shows the account and its outflow, and tapping it scopes every
 * figure and the category breakdown to that account. "All accounts" clears it.
 *
 * The roster is rendered from the last *unscoped* load (`accounts`), so it
 * always lists every account with its full-period outflow — it never collapses
 * to the single row a filtered summary carries.
 */
function AccountsPanel({
  accounts,
  bankCount,
  totalOutflowCents,
  selected,
  onSelect,
}: {
  accounts: SpendingSummary["accountTotals"];
  bankCount: number;
  totalOutflowCents: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [showIdle, setShowIdle] = useState(false);
  // Accounts with no movement this period are folded away by default: on a
  // spending screen a row of "$0" accounts is noise, and the seed data carries
  // several dormant ones. Nothing is summed or dropped — the selected account
  // stays visible even when idle, and the count is stated on the toggle.
  const idleCount = accounts.filter(
    (a) => a.totalOutflowCents === 0 && a.id !== selected,
  ).length;
  const shown = showIdle
    ? accounts
    : accounts.filter((a) => a.totalOutflowCents !== 0 || a.id === selected);

  return (
    <div>
      <SectionLabel>Accounts</SectionLabel>
      <Card padded={false} className="overflow-hidden">
        <AccountRow
          first
          label="All accounts"
          sub={`${bankCount} ${bankCount === 1 ? "bank" : "banks"} · ${accounts.length} ${
            accounts.length === 1 ? "account" : "accounts"
          }`}
          amount={totalOutflowCents}
          active={selected === null}
          onClick={() => onSelect(null)}
        />
        {shown.map((a) => (
          <AccountRow
            key={a.id}
            label={a.displayName}
            sub={issuerLabel(a.institutionName, a.displayName)}
            amount={a.totalOutflowCents}
            active={selected === a.id}
            onClick={() => onSelect(a.id)}
          />
        ))}
        {idleCount > 0 && (
          <button
            type="button"
            onClick={() => setShowIdle((v) => !v)}
            className="w-full border-t border-line-subtle py-3 text-label text-ink-secondary hover:bg-surface-sunken"
          >
            {showIdle ? "Hide dormant accounts" : `Show ${idleCount} with no activity`}
          </button>
        )}
      </Card>
      <p className="mt-2 text-meta text-ink-tertiary">
        Tap an account to see just its spending and where it went.
      </p>
    </div>
  );
}

function AccountRow({
  label,
  sub,
  amount,
  active,
  first = false,
  onClick,
}: {
  label: string;
  sub: string;
  amount: number;
  active: boolean;
  first?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors ${
        first ? "" : "border-t border-line-subtle"
      } ${active ? "bg-surface-sunken" : "hover:bg-surface-sunken/60"}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-pill ${active ? "bg-accent" : "bg-transparent"}`}
        />
        <span className="min-w-0">
          <span className="block truncate text-body text-ink">{label}</span>
          <span className="block truncate text-meta text-ink-tertiary">{sub}</span>
        </span>
      </span>
      <span
        className={`tabular shrink-0 text-amount ${amount ? "text-ink" : "text-ink-tertiary"}`}
      >
        {formatMoney(amount)}
      </span>
    </button>
  );
}

function Excluded({ summary }: { summary: SpendingSummary }) {
  const transfers = summary.excludedTransferOutflowCents;
  const unclassified = summary.unclassifiedOutflowCents;
  if (transfers === 0 && unclassified === 0) return null;

  return (
    <div>
      <SectionLabel>Not counted as spending</SectionLabel>
      <div className="space-y-2.5">
        {transfers > 0 && (
          <Card>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink">Moved between your accounts</span>
              <span className="tabular text-amount text-ink">{formatMoney(transfers)}</span>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-ink-tertiary">
              Paying a card moves money already counted when the card was charged. Counting it twice
              would show {formatMoney(summary.totalOutflowCents + transfers)} instead of{" "}
              {formatMoney(summary.totalOutflowCents)}.
            </p>
          </Card>
        )}

        {unclassified > 0 && (
          <div
            className="rounded-lg border border-dashed px-5 py-4"
            style={{ borderColor: "var(--border-strong)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink">Not sure about this</span>
              <span className="tabular text-amount text-ink">{formatMoney(unclassified)}</span>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-ink-secondary">
              Money moved somewhere you haven't connected. We can't tell whether it was spent, so it
              isn't counted either way.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function NotYet({ period }: { period: PeriodKind }) {
  const copy: Record<string, { title: string; body: string }> = {
    statement: {
      title: "Statement periods need a closing day",
      body: "This follows a card's billing cycle instead of the calendar month, so the total matches the bill you actually pay. Add the day your card closes when you import it — a CSV export never contains one, and without it this view would silently show a calendar month instead.",
    },
  };
  const text = copy[period] ?? { title: "Not available yet", body: "" };
  return (
    <div
      className="mt-6 max-w-[560px] rounded-lg border border-dashed px-6 py-7"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <p className="text-heading text-ink">{text.title}</p>
      <p className="mt-2 text-body text-ink-secondary">{text.body}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12" aria-hidden="true">
      <div className="space-y-5 lg:col-span-7 xl:col-span-8">
        <div className="skeleton h-[190px] rounded-lg" />
        <div className="skeleton h-[380px] rounded-lg" />
      </div>
      <div className="space-y-5 lg:col-span-5 xl:col-span-4">
        <div className="skeleton h-[150px] rounded-lg" />
        <div className="skeleton h-[180px] rounded-lg" />
      </div>
    </div>
  );
}
