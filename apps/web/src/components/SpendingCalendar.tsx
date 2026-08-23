/**
 * SpendingCalendar — one calendar object for the Spending page.
 *
 * A single calendar that does NOT change shape with the Week/Month/Year page
 * filter. It stays retracted into a button; clicking the button opens a popover
 * with the full picker. Inside the popover a **zoom control (Years · Months ·
 * Days)** lets the user pick the granularity that suits the selection:
 *   • Years  → a grid of years; select a contiguous span of whole years.
 *   • Months → a 12-month grid for one year (‹ 2026 › to page); select whole
 *              months.
 *   • Days   → the Sun–Sat day grid for one month (‹ Aug 2026 › to page); pick
 *              exact days.
 * The header title zooms out (Aug 2026 → months of 2026 → years). Whatever the
 * zoom, selection is two-click contiguous (anchor, then the other end) and
 * resolves to a single {from, to} range.
 *
 * Coverage: cells with synced data carry a small accent pip; cells within
 * Plaid's ~2-year reach but not yet pulled read as muted "ghost" cells. When
 * the selected range includes unsynced days AND a bank is connected, a
 * "Pull … from your bank" backfill CTA appears inside the popover.
 *
 * The control owns its own view + draft selection and reports the resolved
 * {from, to} up to the screen on Apply — it never fetches or aggregates.
 * Contiguous ranges only, by design.
 */
import { useEffect, useRef, useState } from "react";
import {
  formatRange,
  isCovered,
  monthCells,
  monthGrid,
  monthTitle,
  presetRanges,
  rangeHasUnsynced,
  yearCells,
  type Cell,
  type DayCell,
} from "../model/calendar";
import type { PlaidCoverage } from "../services/api";

export type DateRange = { from: string; to: string };
type Zoom = "years" | "months" | "days";

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
const ZOOMS: { key: Zoom; label: string }[] = [
  { key: "years", label: "Years" },
  { key: "months", label: "Months" },
  { key: "days", label: "Days" },
];

export function SpendingCalendar({
  coverage,
  value,
  onApply,
  onClear,
  onBackfill,
  backfilling,
}: SpendingCalendarProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("days");
  // Focused year/month for the month and day grids.
  const [focus, setFocus] = useState<{ year: number; month: number }>({ year: 0, month: 0 });
  // Draft (uncommitted) selection bounds; "" means no endpoint yet.
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  // Two-click selection: the first-clicked cell's bounds.
  const [anchor, setAnchor] = useState<{ start: string; end: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "started">("idle");

  const popoverRef = useRef<HTMLDivElement>(null);

  const earliestSynced = coverage?.earliestSynced ?? null;
  const latestSynced = coverage?.latestSynced ?? null;
  const hasConnections = (coverage?.connections.length ?? 0) > 0;

  // Reset the draft/focus/zoom to the committed value whenever the popover opens.
  function resetDraft() {
    if (!coverage) return;
    const seedDate = value?.from ?? coverage.latestSynced ?? coverage.today;
    const d = new Date(seedDate + "T00:00:00Z");
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    setDraftFrom(value?.from ?? "");
    setDraftTo(value?.to ?? "");
    setAnchor(null);
    setPhase("idle");
    setZoom("days");
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

  // Two-click contiguous selection at the current granularity. A cell carries
  // its own [start, end] bounds, so months and years resolve to full-span dates.
  function selectCell(start: string, end: string) {
    if (phase === "idle") {
      setAnchor({ start, end });
      setDraftFrom(start);
      setDraftTo(end);
      setPhase("started");
    } else {
      const a = anchor ?? { start, end };
      setDraftFrom(a.start < start ? a.start : start);
      setDraftTo(a.end > end ? a.end : end);
      setPhase("idle");
    }
  }

  function applyPreset(from: string, to: string) {
    setDraftFrom(from);
    setDraftTo(to);
    setAnchor(null);
    setPhase("idle");
    setZoom("days");
    const d = new Date(from + "T00:00:00Z");
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }

  // Switch zoom, keeping the view centered on the current selection when there
  // is one — so zooming in from a picked month lands on that month's days.
  function switchZoom(next: Zoom) {
    setPhase("idle");
    setAnchor(null);
    if (draftFrom) {
      const d = new Date(draftFrom + "T00:00:00Z");
      if (next === "days") setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
      else if (next === "months") setFocus((f) => ({ year: d.getUTCFullYear(), month: f.month }));
    }
    setZoom(next);
  }

  function stepMonth(delta: number) {
    const d = new Date(Date.UTC(focus.year, focus.month + delta, 1));
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }
  function stepYear(delta: number) {
    setFocus((f) => ({ year: f.year + delta, month: f.month }));
  }

  const floorYear = Number(coverage.floor.slice(0, 4));
  const todayYear = Number(coverage.today.slice(0, 4));
  const focusFirst = `${focus.year}-${String(focus.month + 1).padStart(2, "0")}-01`;
  const canPrevMonth = focusFirst > coverage.floor.slice(0, 7) + "-01";
  const canNextMonth = focusFirst < coverage.today.slice(0, 7) + "-01";

  const presets = presetRanges(coverage.floor, coverage.today);

  // Highlight helpers shared across grids.
  const inRange = (start: string, end: string) => !!lo && start >= lo && end <= hi;
  const isEndpoint = (start: string, end: string) => start === lo || end === hi;

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
          {/* Zoom control */}
          <div
            role="group"
            aria-label="Zoom level"
            className="mb-3 flex rounded-md border p-0.5"
            style={{ borderColor: "var(--border-subtle)", background: "var(--surface-sunken)" }}
          >
            {ZOOMS.map((z) => {
              const active = zoom === z.key;
              return (
                <button
                  key={z.key}
                  type="button"
                  onClick={() => switchZoom(z.key)}
                  aria-pressed={active}
                  className="flex-1 rounded px-2 py-1 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={
                    active
                      ? { background: "var(--surface-raised)", color: "var(--text-primary)", boxShadow: "var(--shadow-sm)" }
                      : { color: "var(--text-tertiary)" }
                  }
                >
                  {z.label}
                </button>
              );
            })}
          </div>

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

          {/* Navigation header — title zooms out, arrows page the coarser unit */}
          <div className="mb-1.5 flex items-center justify-between">
            <NavArrow
              dir="prev"
              onClick={
                zoom === "days"
                  ? canPrevMonth
                    ? () => stepMonth(-1)
                    : undefined
                  : zoom === "months"
                    ? focus.year > floorYear
                      ? () => stepYear(-1)
                      : undefined
                    : undefined
              }
              hidden={zoom === "years"}
            />
            <ZoomTitle zoom={zoom} focus={focus} onZoomOut={switchZoom} />
            <NavArrow
              dir="next"
              onClick={
                zoom === "days"
                  ? canNextMonth
                    ? () => stepMonth(1)
                    : undefined
                  : zoom === "months"
                    ? focus.year < todayYear
                      ? () => stepYear(1)
                      : undefined
                    : undefined
              }
              hidden={zoom === "years"}
            />
          </div>

          {/* Grid */}
          {zoom === "years" && (
            <div className="grid grid-cols-4 gap-1.5">
              {yearCells(coverage.floor, coverage.today).map((cell) => (
                <RangeCell
                  key={cell.key}
                  cell={cell}
                  inRange={inRange(cell.startDate, cell.endDate)}
                  isEndpoint={isEndpoint(cell.startDate, cell.endDate)}
                  covered={isCovered(cell, earliestSynced, latestSynced)}
                  onClick={() => selectCell(cell.startDate, cell.endDate)}
                />
              ))}
            </div>
          )}

          {zoom === "months" && (
            <div className="grid grid-cols-4 gap-1.5">
              {monthCells(focus.year, coverage.floor, coverage.today).map((cell) => (
                <RangeCell
                  key={cell.key}
                  cell={cell}
                  inRange={inRange(cell.startDate, cell.endDate)}
                  isEndpoint={isEndpoint(cell.startDate, cell.endDate)}
                  covered={isCovered(cell, earliestSynced, latestSynced)}
                  onClick={() => selectCell(cell.startDate, cell.endDate)}
                />
              ))}
            </div>
          )}

          {zoom === "days" && (
            <>
              <div className="grid grid-cols-7 gap-1">
                {WEEKDAY_HEADERS.map((w) => (
                  <span key={w} className="py-1 text-center text-meta text-ink-tertiary">
                    {w}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {monthGrid(focus.year, focus.month, coverage.floor, coverage.today)
                  .flat()
                  .map((cell) => (
                    <DayButton
                      key={cell.date}
                      cell={cell}
                      inRange={!!lo && cell.date >= lo && cell.date <= hi}
                      isEndpoint={cell.date === lo || cell.date === hi}
                      covered={isCovered(
                        { startDate: cell.date, endDate: cell.date },
                        earliestSynced,
                        latestSynced,
                      )}
                      onClick={() => selectCell(cell.date, cell.date)}
                    />
                  ))}
              </div>
            </>
          )}

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
                setAnchor(null);
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
// ZoomTitle — the header label; clicking zooms out one level
// ---------------------------------------------------------------------------

function ZoomTitle({
  zoom,
  focus,
  onZoomOut,
}: {
  zoom: Zoom;
  focus: { year: number; month: number };
  onZoomOut: (next: Zoom) => void;
}) {
  if (zoom === "years") {
    return <span className="px-2 py-1 text-body font-medium text-ink">Pick a year range</span>;
  }
  const title = zoom === "days" ? monthTitle(focus.year, focus.month) : String(focus.year);
  const next: Zoom = zoom === "days" ? "months" : "years";
  return (
    <button
      type="button"
      onClick={() => onZoomOut(next)}
      title={`Zoom out to ${next}`}
      className="rounded-md px-2 py-1 text-body font-medium text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {title}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RangeCell — a whole year or month cell in the zoomed-out grids
// ---------------------------------------------------------------------------

function RangeCell({
  cell,
  inRange,
  isEndpoint,
  covered,
  onClick,
}: {
  cell: Cell;
  inRange: boolean;
  isEndpoint: boolean;
  covered: boolean;
  onClick: () => void;
}) {
  const base =
    "relative flex min-h-[48px] items-center justify-center rounded-md text-meta font-medium transition-all duration-100 select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  let className = "";
  let style: React.CSSProperties = {};

  if (!cell.selectable) {
    className = "cursor-not-allowed text-ink-tertiary";
    style = { background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", opacity: 0.4 };
  } else if (isEndpoint || inRange) {
    className = isEndpoint ? "cursor-pointer text-ink-inverse" : "cursor-pointer text-ink";
    style = isEndpoint ? { background: "var(--ink)" } : { background: "var(--surface-sunken)" };
  } else if (covered) {
    className = "cursor-pointer text-ink hover:bg-surface-sunken";
    style = { background: "var(--surface-raised)", border: "1px solid var(--border-subtle)" };
  } else {
    className = "cursor-pointer text-ink-tertiary hover:bg-surface-sunken";
    style = { border: "1px dashed var(--border-strong)", opacity: 0.8 };
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!cell.selectable}
      aria-pressed={inRange || isEndpoint}
      title={cell.selectable ? `${cell.startDate} – ${cell.endDate}` : "Outside your bank's history"}
      className={`${base} ${className}`}
      style={style}
    >
      {cell.label}
      {covered && !inRange && !isEndpoint && (
        <span
          aria-hidden="true"
          className="absolute bottom-1.5 h-1 w-1 rounded-full"
          style={{ background: "var(--accent)", opacity: 0.6 }}
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DayButton — one day cell in the day grid
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

function NavArrow({
  dir,
  onClick,
  hidden = false,
}: {
  dir: "prev" | "next";
  onClick?: () => void;
  hidden?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={dir === "prev" ? "Previous" : "Next"}
      className="flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-sunken disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ visibility: hidden ? "hidden" : "visible" }}
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
