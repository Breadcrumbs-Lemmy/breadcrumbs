/**
 * Goals — declare savings targets and see how each is pacing.
 *
 * Reached from the Check (affordability) screen, never a nav tab (D-G9: a tab
 * would add a letter and spoil the C·A·P·I·T·A·L acrostic). A goal is a
 * *declaration* — nothing in a statement says "I mean to save $400 a month"
 * (D-G2) — so this screen both reads progress and edits the underlying intent.
 * Two halves:
 *
 *   1. "Where you stand" — read-only progress. Every bar, status word, remaining
 *      figure and pace projection is computed server-side by core `evaluateGoals`
 *      and rendered verbatim. The browser does no arithmetic on a financial value
 *      (`CD-011`); it formats cents and draws a bar whose width is a backend
 *      basis-point share.
 *   2. "Your goals" — the editor. The browser only holds the *numbers the user
 *      types* and hands them back; the server shapes each into a canonical goal
 *      via core `buildSavingsGoals`, so cadence, next-contribution and confidence
 *      are never invented here.
 *
 * Status is word-first (D-G9): the word ("Reached" / "On track" / "Behind") and
 * the bar carry the meaning; the hue is a restrained accent — `--accent` for the
 * good states, `--alert` for behind — never the sole signal.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  GoalProgress,
  GoalPriority,
  GoalProtection,
  GoalStatus,
  SavingsCapacitySuggestion,
} from "@ai-fin-os/core";
import { loadGoals, saveGoals, type GoalInput, type GoalsOutcome } from "../services/goals";
import { centsToDollars, dollarsToCents } from "../model/snapshot";
import { formatMoney } from "../format/money";
import { Bar, Card, SectionLabel } from "../components/ui";
import { LogoMark } from "../components/Logo";

type ReadyView = Extract<GoalsOutcome, { kind: "ready" }>;

/** One editable goal row (dollars as typed). `id` is preserved from a loaded goal
 *  so a rename keeps its stable id; a new row has none and the server slugs one. */
type Draft = {
  id?: string;
  label: string;
  target: string;
  saved: string;
  monthly: string;
  targetDate: string;
  priority: GoalPriority;
  protection: GoalProtection;
};

/** Word + restrained accent per status (D-G9). The word is always present; the
 *  colour is decoration on top of it, never the only signal. `on_track` and
 *  `reached` are the good states (`--accent`); `behind` is the one to act on. */
const STATUS_META: Record<GoalStatus, { label: string; color: string; soft: string }> = {
  reached: { label: "Reached", color: "var(--accent)", soft: "var(--accent-soft)" },
  on_track: { label: "On track", color: "var(--accent)", soft: "var(--accent-soft)" },
  behind: { label: "Behind", color: "var(--alert)", soft: "var(--alert-soft)" },
};

const PRIORITIES: GoalPriority[] = ["high", "medium", "low"];

/** A blank row. `monthly` may be pre-filled from the observed savings-room floor
 *  (D-G11) so a new goal starts at a figure the user's own cash flow supports —
 *  a convenience, freely overwritten, never a prescription. */
function emptyDraft(monthly = ""): Draft {
  return { label: "", target: "", saved: "", monthly, targetDate: "", priority: "medium", protection: "flexible" };
}

export function GoalsScreen({ onBack, onImport }: { onBack: () => void; onImport?: () => void }) {
  const [outcome, setOutcome] = useState<GoalsOutcome | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setOutcome(null);
    const next = await loadGoals();
    setOutcome(next);
    if (next.kind === "ready") {
      setDraft(
        next.config.goals.map((g) => ({
          id: g.id,
          label: g.label,
          target: centsToDollars(g.targetAmountCents),
          saved: centsToDollars(g.currentAmountCents),
          monthly: centsToDollars(g.monthlyContributionCents),
          targetDate: g.targetDate ?? "",
          priority: g.priority,
          protection: g.protection,
        })),
      );
      setSaveError(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Editing anything invalidates a prior "Saved ✓" so it never lingers over
  // changes it doesn't describe.
  const touch = useCallback(() => setSaved(false), []);

  const ready = outcome?.kind === "ready" ? outcome : null;

  const updateRow = useCallback((index: number, patch: Partial<Draft>) => {
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    touch();
  }, [touch]);

  const addRow = useCallback(() => {
    // Start a new goal at the observed monthly floor (what the user has typically
    // kept), so the primary field is already a realistic figure they can adjust.
    const prefill =
      ready?.suggestion?.hasEnoughData ? centsToDollars(ready.suggestion.floorCents) : "";
    setDraft((rows) => [...rows, emptyDraft(prefill)]);
    touch();
  }, [ready, touch]);

  const removeRow = useCallback((index: number) => {
    setDraft((rows) => rows.filter((_, i) => i !== index));
    touch();
  }, [touch]);

  const handleSave = useCallback(async () => {
    setSaveError(null);

    const goals: GoalInput[] = [];
    for (const row of draft) {
      const label = row.label.trim();
      if (label === "") {
        setSaveError("Give every goal a name, or remove the empty row.");
        return;
      }
      const target = dollarsToCents(row.target);
      if (target === undefined || target <= 0) {
        setSaveError(`Enter a target amount for “${label}”.`);
        return;
      }
      // Saved-so-far and monthly contribution are optional; a blank means zero.
      const savedSoFar = row.saved.trim() === "" ? 0 : dollarsToCents(row.saved);
      const monthly = row.monthly.trim() === "" ? 0 : dollarsToCents(row.monthly);
      if (savedSoFar === undefined) {
        setSaveError(`Enter a valid amount saved for “${label}”, or clear it.`);
        return;
      }
      if (monthly === undefined) {
        setSaveError(`Enter a valid monthly amount for “${label}”, or clear it.`);
        return;
      }

      const goal: GoalInput = {
        label,
        targetAmountCents: target,
        currentAmountCents: savedSoFar,
        monthlyContributionCents: monthly,
        priority: row.priority,
        protection: row.protection,
      };
      if (row.id) goal.id = row.id;
      if (row.targetDate) goal.targetDate = row.targetDate;
      goals.push(goal);
    }

    setSaving(true);
    const result = await saveGoals({ currency: ready?.config.currency ?? "USD", goals });
    setSaving(false);

    if (result.kind === "ok") {
      // Reload so the progress panel reflects the goals just saved (and the
      // server's canonical shape and sort), then confirm.
      await load();
      setSaved(true);
      return;
    }
    setSaveError(
      result.kind === "error"
        ? result.message
        : result.kind === "invalid"
          ? "The server rejected these goals — check the amounts."
          : "Couldn't save your goals.",
    );
  }, [draft, ready, load]);

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="mb-1 text-label text-ink-secondary transition-colors hover:text-ink"
          >
            ‹ Check
          </button>
          <h1 className="font-display text-[1.6rem] font-medium text-ink">Goals</h1>
          <p className="mt-1 max-w-[52ch] text-body text-ink-secondary">
            Set how much you put aside each month toward a target — a deadline is optional. You'll
            see whether the plan reaches the number, and by when. Goals never move money.
          </p>
        </div>
      </div>

      {outcome === null && <Skeleton />}

      {outcome?.kind === "error" && (
        <Card className="max-w-[560px]">
          <p className="text-body">Couldn't load your goals.</p>
          <p className="mt-1 text-meta text-ink-tertiary">{outcome.message}</p>
          <p className="mt-3 text-meta text-ink-tertiary">
            Start the API with <span className="font-mono text-[11px]">pnpm run dev:api</span>
          </p>
        </Card>
      )}

      {ready && (
        <GoalsBody
          view={ready}
          draft={draft}
          saving={saving}
          saved={saved}
          saveError={saveError}
          onImport={onImport}
          onUpdateRow={updateRow}
          onRemoveRow={removeRow}
          onAddRow={addRow}
          onSave={() => void handleSave()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GoalsBody({
  view,
  draft,
  saving,
  saved,
  saveError,
  onImport,
  onUpdateRow,
  onRemoveRow,
  onAddRow,
  onSave,
}: {
  view: ReadyView;
  draft: Draft[];
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  onImport?: () => void;
  onUpdateRow: (index: number, patch: Partial<Draft>) => void;
  onRemoveRow: (index: number) => void;
  onAddRow: () => void;
  onSave: () => void;
}) {
  const { progress } = view;
  const nothingYet = progress.goals.length === 0 && draft.length === 0;

  if (nothingYet) {
    return (
      <Card className="max-w-[560px] text-center">
        <div className="mb-4 flex justify-center">
          <LogoMark size={46} beacon />
        </div>
        <p className="font-display text-[1.35rem] font-medium text-ink">No goals yet</p>
        <p className="mx-auto mt-2 max-w-[42ch] text-body text-ink-secondary">
          Set your first savings target — an emergency fund, a trip, a deposit. Say what you put
          aside each month and you'll see when it lands; it'll factor into the affordability check
          too.
        </p>
        {view.suggestion?.hasEnoughData && (
          <div className="mt-4 text-left">
            <SavingsRoomNote suggestion={view.suggestion} />
          </div>
        )}
        <button
          type="button"
          onClick={onAddRow}
          className="mt-5 min-h-[40px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover"
        >
          Add a goal
        </button>
        {onImport && (
          <p className="mt-4 text-meta text-ink-tertiary">
            No statement imported yet?{" "}
            <button type="button" onClick={onImport} className="text-accent underline underline-offset-4">
              Import one
            </button>{" "}
            so pace is measured from your latest activity.
          </p>
        )}
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {/* ---- Where you stand: computed progress (read-only) ----------------- */}
      {progress.goals.length > 0 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <SectionLabel>Where you stand</SectionLabel>
            <span className="text-meta text-ink-tertiary">
              {summarizeCounts(progress.behindCount, progress.onTrackCount, progress.reachedCount)}
            </span>
          </div>

          <Card padded={false} className="overflow-hidden">
            {progress.goals.map((goal, i) => (
              <GoalRow key={goal.id} goal={goal} first={i === 0} />
            ))}
          </Card>

          <p className="mt-2 text-meta text-ink-tertiary tabular">
            {formatMoney(progress.totalSavedCents)} saved of {formatMoney(progress.totalTargetCents)}{" "}
            across {progress.goals.length} goal{progress.goals.length === 1 ? "" : "s"}.
          </p>
        </section>
      )}

      {/* ---- Your goals: the editor ---------------------------------------- */}
      <section>
        <SectionLabel>Your goals</SectionLabel>

        <Card className="space-y-5">
          <SavingsRoomNote suggestion={view.suggestion} />

          {draft.length > 0 ? (
            <div className="space-y-6">
              {draft.map((row, i) => (
                <GoalEditor
                  key={i}
                  row={row}
                  suggestion={view.suggestion}
                  onChange={(patch) => onUpdateRow(i, patch)}
                  onRemove={() => onRemoveRow(i)}
                />
              ))}
            </div>
          ) : (
            <p className="text-body text-ink-secondary">No goals set. Add one below to start tracking.</p>
          )}

          <div className="border-t border-line-subtle pt-5">
            <button
              type="button"
              onClick={onAddRow}
              className="min-h-[40px] rounded-md border border-line-strong px-4 text-body text-ink transition-colors hover:border-accent hover:text-accent"
            >
              + Add a goal
            </button>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 border-t border-line-subtle pt-5">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="min-h-[40px] rounded-md bg-accent px-5 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save goals"}
            </button>
            {saved && !saveError && <span className="text-meta text-accent">Saved ✓</span>}
            {saveError && <span className="text-meta text-alert">{saveError}</span>}
          </div>
        </Card>

        <p className="mt-3 text-meta text-ink-tertiary">
          Pace is measured from your latest imported transaction, not today's date — the same “now”
          the rest of the app uses. Goals are stored only on your device.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GoalRow({ goal, first }: { goal: GoalProgress; first: boolean }) {
  const meta = STATUS_META[goal.status];
  const pct = goal.progressBasisPoints / 100;
  return (
    <div className={`px-5 py-4 sm:px-6 ${first ? "" : "border-t border-line-subtle"}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="truncate text-body text-ink">{goal.label}</span>
        <StatusPill status={goal.status} />
      </div>

      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="tabular text-amount text-ink">
          {formatMoney(goal.savedCents)}{" "}
          <span className="text-ink-tertiary">of {formatMoney(goal.targetAmountCents)}</span>
        </span>
        <span className="text-meta" style={{ color: meta.color }}>
          {goal.status === "reached" ? "Reached" : `${formatMoney(goal.remainingCents)} to go`}
        </span>
      </div>

      <Bar pct={pct} color={meta.color} />

      <PaceNote goal={goal} />
    </div>
  );
}

/** The pace line under a goal. Every figure here is from the backend evaluation;
 *  the browser only formats it. Marked an estimate (~) because a projection is a
 *  forecast, not a fact. */
function PaceNote({ goal }: { goal: GoalProgress }) {
  if (goal.status === "reached") return null;

  if (!goal.projection) {
    // Unmet and unfunded: there is nothing to project from.
    return (
      <p className="mt-2 text-meta text-ink-tertiary">
        No monthly contribution set — add one to see when this goal lands.
      </p>
    );
  }

  const when = monthYear(goal.projection.projectedCompletionDate);
  return (
    <p className="mt-2 text-meta text-ink-tertiary">
      On pace to finish ~{when}
      {goal.targetDate && !goal.projection.onPace && (
        <span className="ml-1" style={{ color: STATUS_META.behind.color }}>
          — past your {monthYear(goal.targetDate)} deadline
        </span>
      )}
      {goal.targetDate && goal.projection.onPace && (
        <span className="ml-1">— by your {monthYear(goal.targetDate)} deadline</span>
      )}
    </p>
  );
}

function StatusPill({ status }: { status: GoalStatus }) {
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

// ---------------------------------------------------------------------------

function GoalEditor({
  row,
  suggestion,
  onChange,
  onRemove,
}: {
  row: Draft;
  suggestion: SavingsCapacitySuggestion | null;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const name = row.label.trim() || "this goal";
  const canSuggest = suggestion?.hasEnoughData ?? false;
  return (
    <div className="space-y-3 rounded-md border border-line-subtle bg-surface-sunken px-4 py-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Goal name (e.g. Emergency fund)"
          aria-label="Goal name"
          className="input flex-1"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="shrink-0 text-meta text-ink-tertiary hover:text-alert"
        >
          Remove
        </button>
      </div>

      {/* Each month — the primary lever. Pre-filled from the observed savings
          room (D-G11); the chips let the user snap to the floor or ceiling of
          their own range. A deadline and target refine it, but this is enough
          on its own to start pacing a monthly habit. */}
      <div>
        <LabelledMoney
          label="Each month"
          value={row.monthly}
          onChange={(v) => onChange({ monthly: v })}
          placeholder="0"
          ariaLabel={`Monthly contribution for ${name}`}
        />
        {canSuggest && suggestion && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-tertiary">
            <span>From your cash flow:</span>
            <SuggestChip cents={suggestion.floorCents} onPick={(v) => onChange({ monthly: v })} />
            {suggestion.ceilingCents !== suggestion.floorCents && (
              <SuggestChip cents={suggestion.ceilingCents} onPick={(v) => onChange({ monthly: v })} />
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <LabelledMoney
          label="Target"
          value={row.target}
          onChange={(v) => onChange({ target: v })}
          placeholder="0"
          ariaLabel={`Target amount for ${name}`}
        />
        <LabelledMoney
          label="Saved so far"
          value={row.saved}
          onChange={(v) => onChange({ saved: v })}
          placeholder="0"
          ariaLabel={`Amount saved for ${name}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-label text-ink-secondary">Deadline (optional)</label>
          <input
            type="date"
            value={row.targetDate}
            onChange={(e) => onChange({ targetDate: e.target.value })}
            aria-label={`Deadline for ${name}`}
            className="input tabular"
          />
        </div>
        <div>
          <label className="mb-1 block text-label text-ink-secondary">Priority</label>
          <select
            value={row.priority}
            onChange={(e) => onChange({ priority: e.target.value as GoalPriority })}
            aria-label={`Priority for ${name}`}
            className="input"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-label text-ink-secondary">
            <span title="Protected goals are treated as a commitment in the affordability check; flexible ones can flex.">
              Protection
            </span>
          </label>
          <select
            value={row.protection}
            onChange={(e) => onChange({ protection: e.target.value as GoalProtection })}
            aria-label={`Protection for ${name}`}
            className="input"
          >
            <option value="flexible">Flexible</option>
            <option value="protected">Protected</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function LabelledMoney({
  label,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-label text-ink-secondary">{label}</label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-body text-ink-tertiary"
        >
          $
        </span>
        <input
          type="text"
          inputMode="decimal"
          className="input pl-6"
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

/** A one-tap fill for the monthly field: snap it to an observed figure (the
 *  savings-room floor or ceiling). Shows the amount; the parent decides which. */
function SuggestChip({ cents, onPick }: { cents: number; onPick: (dollars: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(centsToDollars(cents))}
      className="rounded-pill border border-line-subtle px-2 py-0.5 tabular text-ink-secondary transition-colors hover:border-accent hover:text-accent"
    >
      {formatMoney(cents)}
    </button>
  );
}

/** A factual read of the user's own recent cash flow (D-G11) — never advice.
 *  States the observed monthly range (median surplus → median income above
 *  essential bills) so a pre-filled monthly contribution has a visible, honest
 *  basis. It describes what the user's transactions already show and leaves the
 *  number to them; it never says what they *should* save. With too little
 *  history it says so plainly rather than inventing a figure. */
function SavingsRoomNote({ suggestion }: { suggestion: SavingsCapacitySuggestion | null }) {
  if (!suggestion || !suggestion.hasEnoughData) {
    return (
      <div className="rounded-md border border-line-subtle bg-surface-sunken px-4 py-3">
        <p className="text-meta text-ink-secondary">
          Import a couple of complete months and this will show how much your own cash flow has left
          each month. Until then, enter whatever monthly amount you have in mind.
        </p>
      </div>
    );
  }

  const { floorCents, ceilingCents, monthsConsidered } = suggestion;
  const months = `${monthsConsidered} complete month${monthsConsidered === 1 ? "" : "s"}`;
  return (
    <div className="rounded-md border border-line-subtle bg-surface-sunken px-4 py-3">
      <p className="text-label text-ink-secondary">Your recent savings room</p>
      {floorCents === ceilingCents ? (
        <p className="mt-1 text-meta text-ink-secondary">
          Across your last {months}, about{" "}
          <span className="tabular text-ink">{formatMoney(floorCents)}</span> a month was left after
          everything you spent. New goals start there — change it to whatever fits.
        </p>
      ) : (
        <p className="mt-1 text-meta text-ink-secondary">
          Across your last {months}, about{" "}
          <span className="tabular text-ink">{formatMoney(floorCents)}</span> a month was left after
          everything you spent, and up to{" "}
          <span className="tabular text-ink">{formatMoney(ceilingCents)}</span> sat above your
          essential bills. New goals start at {formatMoney(floorCents)} a month — change it to
          whatever fits.
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-ink-tertiary">A read of your own transactions, not advice.</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="skeleton h-[200px] rounded-lg" />
      <div className="skeleton h-[280px] rounded-lg" />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "2022-10-01" → "Oct 2022". Formatting a date label is not financial
 *  arithmetic, so it's fine in the browser; the underlying date is backend-set.
 *  Parses the parts directly to avoid a timezone shift from `new Date(iso)`. */
function monthYear(iso: string): string {
  const [year, month] = iso.split("-");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = Number(month);
  const name = m >= 1 && m <= 12 ? MONTHS[m - 1] : month;
  return `${name} ${year}`;
}

function summarizeCounts(behind: number, onTrack: number, reached: number): string {
  const parts: string[] = [];
  if (behind > 0) parts.push(`${behind} behind`);
  if (onTrack > 0) parts.push(`${onTrack} on track`);
  if (reached > 0) parts.push(`${reached} reached`);
  return parts.join(" · ");
}
