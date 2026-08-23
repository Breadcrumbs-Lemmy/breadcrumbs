/**
 * SpendingCalendar — one calendar object for the Spending page.
 *
 * A single, consistent calendar that does NOT change shape with the
 * Week/Month/Year filter. It stays retracted into a button; clicking the button
 * opens a popover with the full day-grid where the user can:
 *   • navigate month to month (‹ Aug 2026 ›),
 *   • pick a contiguous day range (two clicks: anchor, then the other end),
 *   • jump to a quick range (Last 30 days · Last 90 days · This year),
 *   • pull older history from their bank when the range reaches unsynced days,
 *   • Apply the range (drives the page) or Clear back to the latest period.
 *
 * Coverage: days with synced data carry a small accent pip; days within Plaid's
 * ~2-year reach but not yet pulled read as muted "ghost" days. When the selected
 * range includes unsynced days AND a bank is connected, a "Pull … from your
 * bank" backfill CTA appears inside the popover.
 *
 * The control owns its own view (focus month) and draft selection, and reports
 * the resolved {from, to} range up to the screen on Apply — it never fetches or
 * aggregates. Contiguous ranges only, by design.
 */
import { useEffect, useRef, useState } from "react";
import {
  formatRange,
  isCovered,
  monthGrid,
  monthTitle,
  presetRanges,
  rangeHasUnsynced,
  type DayCell,
} from "../model/calendar";
import type { PlaidCoverage } from "../services/api";

export type DateRange = { from: string; to: string };

export type SpendingCalendarProps = {
  coverage: PlaidCoverage | null;
  /** The applied custom range, or null when showing the latest period. */
  value: DateRange | null;
  onApply: (range: DateRange) => void;
  onClear: () => void;
  onBackfill: (targetStartDate: string) => void;
  backfilling: boolean;
};

const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function SpendingCalendar({
  coverage,
  value,
  onApply,
  onClear,
  onBackfill,
  backfilling,
}: SpendingCalendarProps) {
  const [open, setOpen] = useState(false);
  // Focused month for the day grid.
  const [focus, setFocus] = useState<{ year: number; month: number }>({ year: 0, month: 0 });
  // Draft (uncommitted) selection; "" means no endpoint yet.
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  // Two-click selection state.
  const [anchor, setAnchor] = useState("");
  const [phase, setPhase] = useState<"idle" | "started">("idle");

  const popoverRef = useRef<HTMLDivElement>(null);

  const earliestSynced = coverage?.earliestSynced ?? null;
  const latestSynced = coverage?.latestSynced ?? null;
  const hasConnections = (coverage?.connections.length ?? 0) > 0;

  // Reset the draft/focus to the committed value whenever the popover opens.
  function resetDraft() {
    if (!coverage) return;
    const seedDate = value?.from ?? coverage.latestSynced ?? coverage.today;
    const d = new Date(seedDate + "T00:00:00Z");
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    setDraftFrom(value?.from ?? "");
    setDraftTo(value?.to ?? "");
    setAnchor("");
    setPhase("idle");
  }

  function openPopover() {
    resetDraft();
    setOpen(true);
  }

  // Close on outside click / Escape (discards the uncommitted draft).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!coverage) return null;

  const lo = draftFrom && draftTo ? (draftFrom <= draftTo ? draftFrom : draftTo) : "";
  const hi = draftFrom && draftTo ? (draftFrom >= draftTo ? draftFrom : draftTo) : "";
  const draftLabel = lo && hi ? formatRange(lo, hi) : "";
  const draftHasUnsynced = rangeHasUnsynced(lo, hi, earliestSynced, latestSynced);
  const showBackfillCta = draftHasUnsynced && hasConnections;
  const showConnectNote = draftHasUnsynced && !hasConnections;

  const grid = monthGrid(focus.year, focus.month, coverage.floor, coverage.today);

  function selectDay(date: string) {
    if (phase === "idle") {
      setAnchor(date);
      setDraftFrom(date);
      setDraftTo(date);
      setPhase("started");
    } else {
      setDraftFrom(anchor);
      setDraftTo(date);
      setPhase("idle");
    }
  }

  function applyPreset(from: string, to: string) {
    setDraftFrom(from);
    setDraftTo(to);
    setAnchor("");
    setPhase("idle");
    // Focus the range's start month so the selection is visible.
    const d = new Date(from + "T00:00:00Z");
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }

  function stepMonth(delta: number) {
    const d = new Date(Date.UTC(focus.year, focus.month + delta, 1));
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }

  const focusFirst = `${focus.year}-${String(focus.month + 1).padStart(2, "0")}-01`;
  const canPrev = focusFirst > coverage.floor.slice(0, 7) + "-01";
  const canNext = focusFirst < coverage.today.slice(0, 7) + "-01";

  const presets = presetRanges(coverage.floor, coverage.today);

  return (
    <div className="relative" ref={popoverRef}>
      {/* ---- Retracted button ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPopover())}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="inline-flex min-h-[40px] items-center gap-2 rounded-md border px-3.5 text-body font-medium text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface-raised)" }}
        >
          <CalendarGlyph />
          {value ? formatRange(value.from, value.to) : "Look back — pick dates"}
        </button>
        {value && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-[40px] items-center rounded-md px-2.5 text-meta text-ink-tertiary transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Clear the custom date range"
          >
            Clear
          </button>
        )}
      </div>

      {/* ---- Popover ---- */}
      {open && (
        <div
          role="dialog"
          aria-label="Pick a date range"
          className="absolute left-0 top-[calc(100%+8px)] z-40 w-[320px] rounded-lg border p-3.5 shadow-lg"
          style={{ borderColor: "var(--border-subtle)", background: "var(--surface-raised)" }}
        >
          {/* Presets */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {presets.map((p) => {
              const active = lo === p.from && hi === p.to;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.from, p.to)}
                  aria-pressed={active}
                  className="rounded-pill border px-2.5 py-1 text-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={
                    active
                      ? { background: "var(--ink)", color: "var(--text-inverse)", borderColor: "var(--ink)" }
                      : { borderColor: "var(--border-strong)", color: "var(--text-secondary)" }
                  }
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Month navigation */}
          <div className="mb-1.5 flex items-center justify-between">
            <NavArrow dir="prev" onClick={canPrev ? () => stepMonth(-1) : undefined} />
            <span className="text-body font-medium text-ink">{monthTitle(focus.year, focus.month)}</span>
            <NavArrow dir="next" onClick={canNext ? () => stepMonth(1) : undefined} />
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_HEADERS.map((w) => (
              <span key={w} className="py-1 text-center text-meta text-ink-tertiary">
                {w}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1">
            {grid.flat().map((cell) => (
              <DayButton
                key={cell.date}
                cell={cell}
                inRange={!!lo && cell.date >= lo && cell.date <= hi}
                isEndpoint={cell.date === lo || cell.date === hi}
                covered={isCovered({ startDate: cell.date, endDate: cell.date }, earliestSynced, latestSynced)}
                onClick={() => selectDay(cell.date)}
              />
            ))}
          </div>

          {/* Caption + selected range */}
          <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-meta text-ink-tertiary">Banks share up to ~2 years.</p>
            {draftLabel && (
              <p className="text-meta text-ink-secondary">
                <span className="text-ink">{draftLabel}</span>
              </p>
            )}
          </div>

          {/* Backfill CTA */}
          {showBackfillCta && (
            <button
              type="button"
              disabled={backfilling}
              onClick={() => onBackfill(lo)}
              className="mt-2.5 min-h-[36px] w-full rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {backfilling ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-inverse/30 border-t-ink-inverse"
                  />
                  Pulling data…
                </span>
              ) : (
                `Pull ${draftLabel} from your bank`
              )}
            </button>
          )}
          {showConnectNote && (
            <p className="mt-2.5 text-meta text-ink-tertiary">Connect a bank to pull older history.</p>
          )}

          {/* Footer actions */}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-subtle pt-3">
            <button
              type="button"
              onClick={() => {
                setDraftFrom("");
                setDraftTo("");
                setAnchor("");
                setPhase("idle");
                if (value) onClear();
              }}
              className="rounded-md px-2.5 py-1.5 text-meta text-ink-tertiary transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={!lo || !hi}
              onClick={() => {
                onApply({ from: lo, to: hi });
                setOpen(false);
              }}
              className="rounded-md bg-ink px-4 py-1.5 text-body font-medium text-ink-inverse transition-opacity hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayButton — one day cell in the popover grid
// ---------------------------------------------------------------------------

function DayButton({
  cell,
  inRange,
  isEndpoint,
  covered,
  onClick,
}: {
  cell: DayCell;
  inRange: boolean;
  isEndpoint: boolean;
  covered: boolean;
  onClick: () => void;
}) {
  const base =
    "relative flex h-9 items-center justify-center rounded-md text-meta tabular-nums transition-all duration-100 select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  let className = "";
  let style: React.CSSProperties = {};

  if (!cell.selectable) {
    className = "cursor-not-allowed text-ink-tertiary";
    style = { opacity: cell.inMonth ? 0.35 : 0.18 };
  } else if (isEndpoint) {
    className = "cursor-pointer font-medium text-ink-inverse";
    style = { background: "var(--ink)" };
  } else if (inRange) {
    className = "cursor-pointer text-ink";
    style = { background: "var(--surface-sunken)" };
  } else if (covered) {
    className = "cursor-pointer text-ink hover:bg-surface-sunken";
    style = { border: "1px solid var(--border-subtle)" };
  } else {
    // Ghost: within reach, not yet pulled.
    className = "cursor-pointer text-ink-tertiary hover:bg-surface-sunken";
    style = { border: "1px dashed var(--border-strong)", opacity: 0.8 };
  }

  if (!cell.inMonth && cell.selectable && !inRange && !isEndpoint) {
    style = { ...style, opacity: 0.55 };
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!cell.selectable}
      aria-pressed={inRange || isEndpoint}
      title={cell.selectable ? cell.date : "Outside your bank's history"}
      className={`${base} ${className}`}
      style={style}
    >
      {cell.day}
      {covered && !inRange && !isEndpoint && (
        <span
          aria-hidden="true"
          className="absolute bottom-1 h-1 w-1 rounded-full"
          style={{ background: "var(--accent)", opacity: 0.6 }}
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// NavArrow
// ---------------------------------------------------------------------------

function NavArrow({ dir, onClick }: { dir: "prev" | "next"; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={dir === "prev" ? "Previous month" : "Next month"}
      className="flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-sunken disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CalendarGlyph
// ---------------------------------------------------------------------------

function CalendarGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 2v2.5M10.5 2v2.5" />
    </svg>
  );
}
