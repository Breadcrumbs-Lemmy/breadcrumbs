/**
 * TransactionList — the transaction drill-down, shared by two callers.
 *
 * The Transactions screen renders it unscoped, across every account, with a
 * per-row account tag so each line says which account it belongs to. The
 * Accounts screen renders it scoped to one account (`accountId`), where the tag
 * would be redundant and is off by default.
 *
 * This is the drill-down that makes every aggregate trustworthy: a user who
 * cannot see the rows behind "Groceries $419.70" has to take the number on
 * faith. Transfers, refunds, and unresolved movement are shown with badges
 * explaining why they are excluded from spending totals, so the list and the
 * summary visibly reconcile.
 *
 * No arithmetic on financial values happens here (`CD-011`): every figure is a
 * backend field, formatted for display and nothing more.
 */
import { useEffect, useState } from "react";
import type { TransactionPage, TransactionView } from "@ai-fin-os/core";
import { fetchTransactions, type ApiOutcome } from "../services/api";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";
import { Card, Chip, SectionLabel } from "./ui";
import { categoryColor } from "../model/category-color";
import { accountColor } from "../model/account-color";
import { issuerLabel } from "./BankCard";
import { DateRangePicker, type DateRange } from "./DateRangePicker";
import type { InsightFocus } from "../model/insight-focus";

const FLOW_FILTERS = [
  { label: "All", value: undefined },
  { label: "Spending", value: "SPEND" },
  { label: "Income", value: "INCOME" },
  { label: "Transfers", value: "TRANSFER_OUT" },
  { label: "Not sure", value: "UNCLASSIFIED" },
] as const;

/** Today as an ISO date (YYYY-MM-DD) — the upper bound for a focus fetch. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Default to "last 3 months" so the initial load is fast while still giving
// a meaningful window. The user can open it up to "All time" with one click.
export function defaultTransactionRange(): DateRange {
  const today = new Date();
  const threeMonthsAgo = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1),
  );
  return {
    from: threeMonthsAgo.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
    label: "Last 3 months",
  };
}

/** A window wide enough to hold any real transaction, used when we need to find
 *  a specific set of transactions by id regardless of when they posted. */
const ALL_TIME_FROM = "2000-01-01";

export function TransactionList({
  accountId,
  showAccountTag = false,
  focus,
  onClearFocus,
  onBack,
}: {
  /** When set, the list is scoped to a single account server-side. */
  accountId?: string;
  /** Show a per-row pill naming the account. Defaults on for combined views,
   *  off when already scoped to one account. */
  showAccountTag?: boolean;
  /** When set, the list shows ONLY the insight's transactions — the exact ones
   *  behind it. The transactions endpoint has no by-id filter, so we fetch across
   *  all time and keep the rows whose id is in the set (selecting which backend
   *  rows to show is not arithmetic — `CD-011` stays intact). The focus also
   *  carries the insight's backend total, shown at the foot of the list. */
  focus?: InsightFocus;
  /** Called by the "See all transactions" escape hatch shown in focus mode. */
  onClearFocus?: () => void;
  /** Called by the "Back to Insights" button shown in focus mode. */
  onBack?: () => void;
}) {
  const [flow, setFlow] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(defaultTransactionRange);
  const [pages, setPages] = useState<TransactionPage[]>([]);
  const [outcome, setOutcome] = useState<ApiOutcome<TransactionPage> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const focusIds = focus?.ids;
  const focusMode = Boolean(focusIds && focusIds.length > 0);
  // A stable dependency for the effect (arrays are compared by reference).
  const focusKey = focusIds ? focusIds.join(",") : "";
  const focusSet = focusMode ? new Set(focusIds) : null;

  // The query the list runs. In focus mode the on-screen filters are hidden, so
  // we search the whole history unfiltered and let the id set do the filtering.
  const queryFor = (cursor?: string) =>
    focusMode
      ? { accountId, from: ALL_TIME_FROM, to: todayStr(), limit: 100, cursor }
      : {
          accountId,
          flowType: flow,
          search: search || undefined,
          from: dateRange.from,
          to: dateRange.to,
          limit: 40,
          cursor,
        };

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    setPages([]);
    // Debounced so typing does not fire a request per keystroke.
    const timer = setTimeout(() => {
      void fetchTransactions(queryFor()).then((next) => {
        if (cancelled) return;
        setOutcome(next);
        if (next.kind === "ok") setPages([next.data]);
      });
    }, search && !focusMode ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, flow, search, dateRange, focusMode, focusKey]);

  const cursor = pages.at(-1)?.nextCursor;
  const allRows = pages.flatMap((p) => p.transactions);
  const rows = focusSet ? allRows.filter((t) => focusSet.has(t.id)) : allRows;
  // In focus mode the meaningful count is how many of the insight's transactions
  // we're showing, not the whole-history page total.
  const total = focusSet ? rows.length : pages[0]?.totalCount ?? 0;

  // Group once, and date the headers against the newest posted date. The list is
  // newest-first, so the first group is the latest data — the app's reference
  // "now" (a data date, never the wall clock). Headers previously referenced
  // each group against ITSELF, so the years always matched and the year was
  // never shown; on multi-year history, or across a year boundary within one
  // list, "Mar 14" was ambiguous (B14). Now only the reference year is elided.
  const groups = groupByDate(rows);
  const latestPostedDate = groups[0]?.date;

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    const next = await fetchTransactions(queryFor(cursor));
    if (next.kind === "ok") setPages((prev) => [...prev, next.data]);
    setLoadingMore(false);
  }

  // Focus mode: the target rows may sit on any page of history, so keep pulling
  // pages until we've found them all (or run out). Bounded by the cursor.
  useEffect(() => {
    if (!focusMode || !focusSet || loadingMore || !cursor) return;
    if (rows.length < focusSet.size) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, focusMode, focusKey, loadingMore, cursor]);

  return (
    <div>
      {focusMode ? (
        // Focused on one insight's transactions: the merchant/flow/date filters
        // would only muddy a set that's already been chosen, so we swap them for
        // a banner that names the focus, offers a way back to Insights, and an
        // escape hatch to the full list.
        <div className="rounded-md border border-accent/40 bg-surface-raised px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="-ml-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-label text-accent hover:bg-accent/10"
              >
                <span aria-hidden="true">←</span> Back to Insights
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onClearFocus}
              className="shrink-0 text-label text-ink-tertiary underline underline-offset-2 hover:text-ink-secondary"
            >
              See all transactions
            </button>
          </div>
          <p className="mt-2 text-body text-ink-secondary">
            Showing the{" "}
            <span className="font-medium text-ink">{focusIds!.length}</span> transaction
            {focusIds!.length === 1 ? "" : "s"} behind{" "}
            <span className="text-ink">“{focus!.headline}”</span>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
              >
                ⌕
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search merchants"
                aria-label="Search merchants"
                className="w-full rounded-md border border-line-subtle bg-surface-raised py-2.5 pl-9 pr-3 text-body outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              {FLOW_FILTERS.map((f) => (
                <Chip key={f.label} active={flow === f.value} onClick={() => setFlow(f.value)}>
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>
          {/* Date range: default "Last 3 months", expandable to "All time" or
              any arbitrary range years into the past. The API accepts from/to
              ISO strings so no browser-side bucketing is needed. */}
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      )}

      {outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="mt-5">
          <p className="text-body">Couldn't load transactions.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
        </Card>
      )}

      {outcome?.kind === "ok" &&
        rows.length === 0 &&
        // In focus mode, don't declare "none" while we're still paging history
        // looking for the insight's transactions.
        !(focusMode && (loadingMore || Boolean(cursor))) && (
          <Card className="mt-5 text-center">
            <p className="text-body">
              {focusMode ? "Couldn't find those transactions." : "No transactions match."}
            </p>
          </Card>
        )}

      {rows.length > 0 && (
        <>
          <div className="mb-2 mt-5 flex items-baseline justify-between">
            <SectionLabel>{total} transactions</SectionLabel>
            <span className="text-meta text-ink-tertiary">Newest first</span>
          </div>
          <Card padded={false} className="overflow-hidden">
            {groups.map((group, gi) => (
              <div key={group.date}>
                <div
                  className={`flex items-baseline justify-between bg-surface-sunken px-5 py-2 ${
                    gi ? "border-t border-line-subtle" : ""
                  }`}
                >
                  <span className="text-label text-ink-secondary">
                    {formatDate(group.date, latestPostedDate)}
                  </span>
                  <span className="text-meta text-ink-tertiary">{purchaseCount(group.items)}</span>
                </div>
                {group.items.map((t, i) => (
                  <Row key={t.id} t={t} first={i === 0} showAccountTag={showAccountTag} />
                ))}
              </div>
            ))}
            {/* In focus mode the list auto-pages to gather the whole set, so the
                manual "Load more" is hidden; a slim note shows while it works. */}
            {cursor && !focusMode && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="w-full border-t border-line-subtle py-3 text-label text-ink-secondary hover:bg-surface-sunken disabled:opacity-40"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            {focusMode && loadingMore && (
              <p className="border-t border-line-subtle py-3 text-center text-meta text-ink-tertiary">
                Gathering the rest…
              </p>
            )}
          </Card>
          {/* The total that ties the rows together. It is the insight's own
              figure carried over from the backend — not a sum computed here —
              so the list shows what these transactions add up to without the
              browser ever doing money arithmetic (`CD-011`). */}
          {focusMode && focus && (
            <div className="mt-3 flex items-baseline justify-between rounded-md border border-line-subtle bg-surface-raised px-5 py-4">
              <span className="text-body text-ink-secondary">These add up to</span>
              <span className="numeral text-figure text-ink">
                {formatMoney(focus.totalCents)}
                {focus.perMonth && (
                  <span className="text-meta font-normal text-ink-tertiary">/mo</span>
                )}
              </span>
            </div>
          )}
          <p className="mt-3 text-meta leading-relaxed text-ink-tertiary">
            {focusMode
              ? "The total is the insight's own figure; these are the exact transactions it was built from."
              : "Transfers and unresolved movement appear here but are excluded from spending totals."}
          </p>
        </>
      )}
    </div>
  );
}

function Row({
  t,
  first,
  showAccountTag,
}: {
  t: TransactionView;
  first: boolean;
  showAccountTag: boolean;
}) {
  const inflow = t.amountCents > 0;
  const muted =
    t.flowType === "TRANSFER_OUT" || t.flowType === "TRANSFER_IN" || t.flowType === "UNCLASSIFIED";

  return (
    <div
      className={`flex items-center justify-between gap-3 px-5 py-3 ${
        first ? "" : "border-t border-line-subtle"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-pill"
          style={{ background: muted ? "var(--text-tertiary)" : categoryColor(t.category) }}
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-body text-ink">{t.merchantName}</span>
            <Badge t={t} />
            {/* The account tag: which card this row belongs to. Only shown in
                the combined view, where the list pools every account. */}
            {showAccountTag && <AccountTag t={t} />}
          </span>
          <span className="block truncate text-meta text-ink-tertiary">
            {t.categoryDisplayName}
            {!showAccountTag && ` · ${t.accountDisplayName}`}
          </span>
        </span>
      </span>
      <span
        className="tabular shrink-0 text-amount"
        style={{
          color: inflow ? "var(--accent)" : muted ? "var(--text-secondary)" : "var(--text-primary)",
        }}
      >
        {inflow ? "+" : "−"}
        {formatMoney(Math.abs(t.amountCents))}
      </span>
    </div>
  );
}

/** A pill naming the account a row is tied to, with the account's stable colour
 *  dot so the combined list stays scannable by account. */
function AccountTag({ t }: { t: TransactionView }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-surface-sunken px-2 py-0.5 text-meta text-ink-secondary"
      title={`${t.accountDisplayName} · ${issuerLabel(t.institutionName, t.accountDisplayName)}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-pill"
        style={{ background: accountColor(t.accountId) }}
      />
      <span className="max-w-[12ch] truncate">{t.accountDisplayName}</span>
    </span>
  );
}

/** The badge explains why a row is treated differently. An unexplained
 *  exclusion reads as a defect; a labelled one reads as honesty. */
function Badge({ t }: { t: TransactionView }) {
  if (t.flowType === "UNCLASSIFIED") {
    return (
      <span
        title={reasonText(t)}
        className="shrink-0 rounded-pill border border-dashed border-line-strong px-1.5 py-0.5 text-meta text-ink-secondary"
      >
        not sure
      </span>
    );
  }
  if (t.flowType === "TRANSFER_OUT" || t.flowType === "TRANSFER_IN") {
    return <Tag>transfer</Tag>;
  }
  if (t.flowType === "REFUND") return <Tag>refund</Tag>;
  if (t.isRecurring) return <Tag>recurring</Tag>;
  return null;
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-pill bg-surface-sunken px-1.5 py-0.5 text-meta text-ink-tertiary">
      {children}
    </span>
  );
}

function reasonText(t: TransactionView): string {
  switch (t.unclassifiedReason) {
    case "COUNTER_ACCOUNT_NOT_CONNECTED":
      return "Moved to an account you haven't connected, so we can't tell if it was spent.";
    case "LOW_MATCH_CONFIDENCE":
      return "We couldn't confidently match this to another of your accounts.";
    default:
      return "We can't tell where this went.";
  }
}

/** Empty on a day with no purchases — an income-only day reading "0 purchases"
 *  is noise, and "1 purchases" is just wrong. */
function purchaseCount(items: TransactionView[]): string {
  const count = items.filter((t) => t.flowType === "SPEND").length;
  if (count === 0) return "";
  return count === 1 ? "1 purchase" : `${count} purchases`;
}

function groupByDate(rows: TransactionView[]): { date: string; items: TransactionView[] }[] {
  const map = new Map<string, TransactionView[]>();
  for (const t of rows) {
    const list = map.get(t.postedDate) ?? [];
    list.push(t);
    map.set(t.postedDate, list);
  }
  return [...map.entries()].map(([date, items]) => ({ date, items }));
}

function Skeleton() {
  return <div className="mt-5 h-[420px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />;
}
