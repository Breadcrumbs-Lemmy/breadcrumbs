/**
 * Budgets — set monthly spending caps and see how the month is tracking.
 *
 * Reached from the Spending (Pulse) screen, never a nav tab (D-B8: a tab would
 * add an "S"/"B" and spoil the C·A·P·I·T·A·L acrostic). The screen has two
 * halves:
 *
 *   1. "This month" — read-only progress. Every bar, status, remaining figure and
 *      projection is computed server-side by core `evaluateBudgets` and rendered
 *      verbatim. The browser does no arithmetic on a financial value (`CD-011`);
 *      it formats cents and draws a bar whose width is a backend basis-point share.
 *   2. "Set your caps" — the editor. Here the browser only holds the *numbers the
 *      user types* and hands them back via PUT. Entering an intended cap is input,
 *      not calculation, so this stays inside the boundary.
 *
 * Status colour is word-first (D-B9): the word ("On track" / "Nearly there" /
 * "Over") and the bar carry the meaning; the hue is a restrained accent, never
 * the sole signal — the same discipline the `Delta` component uses.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BudgetLine, BudgetStatus, OverallBudgetProgress } from "@ai-fin-os/core";
import {
  loadBudgets,
  saveBudgets,
  type BudgetsOutcome,
} from "../services/budgets";
import type { BudgetConfig } from "../services/api";
import { centsToDollars, dollarsToCents } from "../model/snapshot";
import { formatMoney } from "../format/money";
import { categoryColor } from "../model/category-color";
import { Bar, Card, SectionLabel } from "../components/ui";
import { LogoMark } from "../components/Logo";

type ReadyView = Extract<BudgetsOutcome, { kind: "ready" }>;

/** One editable cap row in the "Set your caps" form (dollars as typed). */
type Draft = { category: string; displayName: string; amount: string };

/** Word + restrained accent per status (D-B9). The word is always present; the
 *  colour is decoration on top of it, never the only signal. */
const STATUS_META: Record<BudgetStatus, { label: string; color: string; soft: string }> = {
  under: { label: "On track", color: "var(--accent)", soft: "var(--accent-soft)" },
  near: { label: "Nearly there", color: "var(--rise)", soft: "var(--rise-soft)" },
  over: { label: "Over", color: "var(--alert)", soft: "var(--alert-soft)" },
};

export function BudgetsScreen({
  onBack,
  onImport,
}: {
  onBack: () => void;
  onImport?: () => void;
}) {
  const [outcome, setOutcome] = useState<BudgetsOutcome | null>(null);
  /** The month progress resolved to; carried so a post-save reload stays on the
   *  same month rather than jumping if the latest-data month were to change. */
  const [monthKey, setMonthKey] = useState<string | undefined>(undefined);

  const [draft, setDraft] = useState<Draft[]>([]);
  const [overallAmount, setOverallAmount] = useState("");
  const [addCategory, setAddCategory] = useState("");
  const [addAmount, setAddAmount] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (key?: string) => {
    setOutcome(null);
    const next = await loadBudgets(key);
    setOutcome(next);
    if (next.kind === "ready") {
      const labels = labelMap(next);
      setMonthKey(next.monthKey);
      setDraft(
        next.config.budgets.map((b) => ({
          category: b.category,
          displayName: labels.get(b.category) ?? b.category,
          amount: centsToDollars(b.limitCents),
        })),
      );
      setOverallAmount(
        next.config.overallLimitCents != null ? centsToDollars(next.config.overallLimitCents) : "",
      );
      setAddCategory("");
      setAddAmount("");
      setSaveError(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Editing anything invalidates a prior "Saved ✓" so the confirmation never
  // lingers over changes it doesn't describe.
  const touch = useCallback(() => setSaved(false), []);

  const ready = outcome?.kind === "ready" ? outcome : null;

  const labels = useMemo(() => (ready ? labelMap(ready) : new Map<string, string>()), [ready]);

  // Categories the user spent in this month that aren't already capped — the
  // menu for "add a budget". A category with a cap but no spend this month stays
  // out of the menu (it's already a row above).
  const addable = useMemo(() => {
    if (!ready) return [];
    const taken = new Set(draft.map((d) => d.category));
    return ready.categories.filter((c) => !taken.has(c.category));
  }, [ready, draft]);

  const handleSave = useCallback(async () => {
    setSaveError(null);

    const budgets: { category: string; limitCents: number }[] = [];
    for (const row of draft) {
      // A blank amount means "drop this cap" — the row simply isn't sent.
      if (row.amount.trim() === "") continue;
      const cents = dollarsToCents(row.amount);
      if (cents === undefined || cents <= 0) {
        setSaveError(`Enter a positive amount for ${row.displayName}, or remove it.`);
        return;
      }
      budgets.push({ category: row.category, limitCents: cents });
    }

    let overallLimitCents: number | null = null;
    if (overallAmount.trim() !== "") {
      const cents = dollarsToCents(overallAmount);
      if (cents === undefined || cents <= 0) {
        setSaveError("Enter a positive overall cap, or clear it.");
        return;
      }
      overallLimitCents = cents;
    }

    const config: BudgetConfig = {
      currency: ready?.config.currency ?? "USD",
      overallLimitCents,
      budgets,
    };

    setSaving(true);
    const result = await saveBudgets(config);
    setSaving(false);

    if (result.kind === "ok") {
      // Reload so the progress bars reflect the caps just saved (and the server's
      // canonical sort order), then confirm.
      await load(monthKey);
      setSaved(true);
      return;
    }
    setSaveError(
      result.kind === "error"
        ? result.message
        : result.kind === "invalid"
          ? "The server rejected these budgets — check the amounts."
          : "Couldn't save your budgets.",
    );
  }, [draft, overallAmount, ready, monthKey, load]);

  function updateAmount(category: string, amount: string) {
    setDraft((d) => d.map((row) => (row.category === category ? { ...row, amount } : row)));
    touch();
  }

  function removeRow(category: string) {
    setDraft((d) => d.filter((row) => row.category !== category));
    touch();
  }

  function addBudget() {
    const cents = dollarsToCents(addAmount);
    if (!addCategory || cents === undefined || cents <= 0) return;
    const displayName = labels.get(addCategory) ?? addCategory;
    setDraft((d) => [...d, { category: addCategory, displayName, amount: addAmount }]);
    setAddCategory("");
    setAddAmount("");
    touch();
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="mb-1 text-label text-ink-secondary transition-colors hover:text-ink"
          >
            ‹ Spending
          </button>
          <h1 className="font-display text-[1.6rem] font-medium text-ink">Budgets</h1>
          <p className="mt-1 max-w-[52ch] text-body text-ink-secondary">
            Set a monthly cap for a category and watch the month track against it. Caps never move
            money — they just tell you where you stand.
          </p>
        </div>
        {ready && (
          <span className="shrink-0 rounded-pill bg-surface-sunken px-3 py-1 text-meta text-ink-secondary">
            {ready.monthLabel}
          </span>
        )}
      </div>

      {outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="max-w-[560px]">
          <p className="text-body">Couldn't load your budgets.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {ready && <BudgetsBody
        view={ready}
        draft={draft}
        overallAmount={overallAmount}
        addCategory={addCategory}
        addAmount={addAmount}
        addable={addable}
        saving={saving}
        saved={saved}
        saveError={saveError}
        onImport={onImport}
        onOverallChange={(v) => { setOverallAmount(v); touch(); }}
        onUpdateAmount={updateAmount}
        onRemoveRow={removeRow}
        onAddCategory={setAddCategory}
        onAddAmount={setAddAmount}
        onAdd={addBudget}
        onSave={() => void handleSave()}
      />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BudgetsBody({
  view,
  draft,
  overallAmount,
  addCategory,
  addAmount,
  addable,
  saving,
  saved,
  saveError,
  onImport,
  onOverallChange,
  onUpdateAmount,
  onRemoveRow,
  onAddCategory,
  onAddAmount,
  onAdd,
  onSave,
}: {
  view: ReadyView;
  draft: Draft[];
  overallAmount: string;
  addCategory: string;
  addAmount: string;
  addable: ReadyView["categories"];
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  onImport?: () => void;
  onOverallChange: (value: string) => void;
  onUpdateAmount: (category: string, amount: string) => void;
  onRemoveRow: (category: string) => void;
  onAddCategory: (category: string) => void;
  onAddAmount: (amount: string) => void;
  onAdd: () => void;
  onSave: () => void;
}) {
  const { progress } = view;
  const nothingImported = progress.budgetedCount === 0 && view.categories.length === 0 && draft.length === 0;

  if (nothingImported) {
    return (
      <Card className="max-w-[560px] text-center">
        <div className="mb-4 flex justify-center">
          <LogoMark size={46} beacon />
        </div>
        <p className="font-display text-[1.35rem] font-medium text-ink">Nothing to budget yet</p>
        <p className="mx-auto mt-2 max-w-[40ch] text-body text-ink-secondary">
          Import a statement first. Once your spending is grouped into categories, you can set a
          monthly cap on any of them here.
        </p>
        {onImport && (
          <button
            type="button"
            onClick={onImport}
            className="mt-5 min-h-[40px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover"
          >
            Import a statement
          </button>
        )}
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {/* ---- This month: computed progress (read-only) --------------------- */}
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <SectionLabel>This month</SectionLabel>
          {progress.budgetedCount > 0 && (
            <span className="text-meta text-ink-tertiary">
              {summarizeCounts(progress.overCount, progress.nearCount, progress.underCount)}
            </span>
          )}
        </div>

        {progress.overall && <OverallCard overall={progress.overall} />}

        {progress.lines.length > 0 ? (
          <Card padded={false} className="mt-3 overflow-hidden">
            {progress.lines.map((line, i) => (
              <LineRow key={line.category} line={line} first={i === 0} />
            ))}
          </Card>
        ) : (
          !progress.overall && (
            <p className="text-body text-ink-secondary">
              No caps set yet. Add one below and it&rsquo;ll start tracking this month.
            </p>
          )
        )}
      </section>

      {/* ---- Set your caps: the editor ------------------------------------- */}
      <section>
        <SectionLabel>Set your caps</SectionLabel>

        <Card className="space-y-5">
          {/* Overall monthly cap */}
          <div>
            <label className="mb-1 block text-label text-ink-secondary" htmlFor="budget-overall">
              Overall monthly cap
            </label>
            <div className="flex items-center gap-2">
              <MoneyInput
                id="budget-overall"
                value={overallAmount}
                onChange={onOverallChange}
                placeholder="No overall cap"
              />
              {overallAmount.trim() !== "" && (
                <button
                  type="button"
                  onClick={() => onOverallChange("")}
                  className="shrink-0 text-meta text-ink-tertiary hover:text-ink"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="mt-1 text-meta text-ink-tertiary">
              Optional. A ceiling across every category, checked against total spending.
            </p>
          </div>

          {/* Per-category caps */}
          {draft.length > 0 && (
            <div className="space-y-3 border-t border-line-subtle pt-5">
              {draft.map((row) => (
                <div key={row.category} className="flex items-center gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-pill"
                      style={{ background: categoryColor(row.category) }}
                    />
                    <span className="truncate text-body text-ink">{row.displayName}</span>
                  </span>
                  <MoneyInput
                    value={row.amount}
                    onChange={(v) => onUpdateAmount(row.category, v)}
                    placeholder="0"
                    className="w-[128px]"
                    ariaLabel={`Monthly cap for ${row.displayName}`}
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveRow(row.category)}
                    aria-label={`Remove ${row.displayName} budget`}
                    className="shrink-0 text-meta text-ink-tertiary hover:text-alert"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add a category cap */}
          {addable.length > 0 && (
            <div className="border-t border-line-subtle pt-5">
              <p className="mb-2 text-label text-ink-secondary">Add a budget</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  className="input sm:flex-1"
                  value={addCategory}
                  onChange={(e) => onAddCategory(e.target.value)}
                  aria-label="Category to budget"
                >
                  <option value="">Choose a category…</option>
                  {addable.map((c) => (
                    <option key={c.category} value={c.category}>
                      {c.displayName} · {formatMoney(c.outflowCents)} this month
                    </option>
                  ))}
                </select>
                <MoneyInput
                  value={addAmount}
                  onChange={onAddAmount}
                  placeholder="Cap"
                  className="sm:w-[128px]"
                  ariaLabel="Monthly cap for the new budget"
                />
                <button
                  type="button"
                  onClick={onAdd}
                  disabled={!addCategory || dollarsToCents(addAmount) === undefined}
                  className="min-h-[40px] shrink-0 rounded-md border border-line-strong px-4 text-body text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {/* Save */}
          <div className="flex items-center gap-3 border-t border-line-subtle pt-5">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="min-h-[40px] rounded-md bg-accent px-5 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save budgets"}
            </button>
            {saved && !saveError && <span className="text-meta text-accent">Saved ✓</span>}
            {saveError && <span className="text-meta text-alert">{saveError}</span>}
          </div>
        </Card>

        <p className="mt-3 text-meta text-ink-tertiary">
          Spending figures are computed from your imported statements — the same numbers the
          Spending screen shows. Budgets are stored only on your device.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OverallCard({ overall }: { overall: OverallBudgetProgress }) {
  const meta = STATUS_META[overall.status];
  const pct = Math.min(overall.usedBasisPoints / 100, 100);
  return (
    <Card className="mb-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-body text-ink">Overall</span>
        <StatusPill status={overall.status} />
      </div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="tabular text-amount text-ink">
          {formatMoney(overall.spentCents)}{" "}
          <span className="text-ink-tertiary">of {formatMoney(overall.limitCents)}</span>
        </span>
        <span className="text-meta" style={{ color: meta.color }}>
          {overall.status === "over"
            ? `${formatMoney(overall.overBudgetCents)} over`
            : `${formatMoney(overall.remainingCents)} left`}
        </span>
      </div>
      <Bar pct={pct} color={meta.color} />
      {overall.projection && <ProjectionNote projected={overall.projection.projectedSpendCents} status={overall.projection.projectedStatus} />}
    </Card>
  );
}

function LineRow({ line, first }: { line: BudgetLine; first: boolean }) {
  const meta = STATUS_META[line.status];
  const pct = Math.min(line.usedBasisPoints / 100, 100);
  return (
    <div className={`px-5 py-4 sm:px-6 ${first ? "" : "border-t border-line-subtle"}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-pill"
            style={{ background: categoryColor(line.category) }}
          />
          <span className="truncate text-body text-ink">{line.displayName}</span>
        </span>
        <StatusPill status={line.status} />
      </div>

      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="tabular text-amount text-ink">
          {formatMoney(line.spentCents)}{" "}
          <span className="text-ink-tertiary">of {formatMoney(line.limitCents)}</span>
        </span>
        <span className="text-meta" style={{ color: meta.color }}>
          {line.status === "over"
            ? `${formatMoney(line.overBudgetCents)} over`
            : `${formatMoney(line.remainingCents)} left`}
        </span>
      </div>

      <Bar pct={pct} color={meta.color} />

      {line.projection && (
        <ProjectionNote projected={line.projection.projectedSpendCents} status={line.projection.projectedStatus} />
      )}
    </div>
  );
}

/** The pace estimate for a partial month. Clearly marked an estimate (~), never
 *  used as the headline status (D-B3) — it warns early without crying wolf. */
function ProjectionNote({ projected, status }: { projected: number; status: BudgetStatus }) {
  return (
    <p className="mt-2 text-meta text-ink-tertiary">
      On pace for {formatMoney(projected, { estimated: true })} by month end
      {status === "over" && (
        <span className="ml-1" style={{ color: STATUS_META.over.color }}>
          — over cap
        </span>
      )}
    </p>
  );
}

function StatusPill({ status }: { status: BudgetStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="shrink-0 rounded-pill px-2 py-0.5 text-meta"
      style={{ color: meta.color, background: meta.soft }}
    >
      {meta.label}
    </span>
  );
}

function MoneyInput({
  value,
  onChange,
  placeholder,
  className = "",
  id,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-body text-ink-tertiary"
      >
        $
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className="input pl-6"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="skeleton h-[92px] rounded-lg" />
      <div className="skeleton h-[220px] rounded-lg" />
      <div className="skeleton h-[260px] rounded-lg" />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Category → human label, gathered from every source that carries one (the
 *  month's progress lines and the spend picker). Config budgets store only ids. */
function labelMap(view: ReadyView): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of view.categories) map.set(c.category, c.displayName);
  for (const line of view.progress.lines) map.set(line.category, line.displayName);
  return map;
}

function summarizeCounts(over: number, near: number, under: number): string {
  const parts: string[] = [];
  if (over > 0) parts.push(`${over} over`);
  if (near > 0) parts.push(`${near} near`);
  if (under > 0) parts.push(`${under} on track`);
  return parts.join(" · ");
}
