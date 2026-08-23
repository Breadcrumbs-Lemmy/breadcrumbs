/**
 * SpendingCalendar — the Coverage Calendar control for the Spending page.
 *
 * One fixed, navigable calendar grid that ZOOMS with the Week/Month/Year
 * toggle instead of a long scrolling list of buckets:
 *   • Year  → a grid of years.
 *   • Month → a 12-month grid for one year (‹ year › to page).
 *   • Week  → the Sun–Sat day grid of one month (‹ month › to page); each
 *             week-row is the selectable unit.
 *
 * Zoom in / out without touching the toggle:
 *   • In the Month grid, each month has a "weeks" affordance that drills into
 *     that month's week grid (this is the "open a month, pick some weeks" flow).
 *   • The header title zooms OUT — the month title → year's months, the year
 *     title → all years.
 *
 * Selection (two-click contiguous range within the current grid):
 *   1. Click a cell        → single-cell selection.
 *   2. Click another cell  → contiguous range between the two.
 *   3. Click again         → reset to a new single-cell selection.
 *
 * Coverage: cells with synced data render solid (a small accent pip); cells
 * within Plaid's reach but not yet pulled render as muted "ghost" cells. When
 * the selection includes ghosts AND a bank is connected, a "Pull … from your
 * bank" backfill CTA appears; with no connection a muted note replaces it.
 *
 * The control owns its own view (focus month/year) and selection, and reports
 * the resolved {from, to} span up to the screen — it never fetches or
 * aggregates. Contiguous spans only, by design.
 */
import { useCallback, useEffect, useState } from "react";
import type { Cell, Grain, WeekRow } from "../model/calendar";
import {
  defaultCellIndex,
  isCovered,
  monthCells,
  monthTitle,
  shortMonth,
  spanFromCells,
  weekRows,
  yearCells,
} from "../model/calendar";
import type { PlaidCoverage } from "../services/api";

export type CalendarSpan = {
  from: string;
  to: string;
  unit: Grain;
  multi: boolean;
  label: string;
};

/** Seeds the calendar's focused year/month when the unit changes via a drill or
 *  zoom (rather than the most-recent-data default). */
export type FocusSeed = { year: number; month?: number };

export type SpendingCalendarProps = {
  unit: Grain;
  coverage: PlaidCoverage | null;
  /** Seeds focus when zooming/drilling; null → default to most-recent data. */
  focusSeed?: FocusSeed | null;
  onSelect: (span: CalendarSpan) => void;
  onDrillToWeeks: (year: number, month: number) => void;
  onZoomToMonths: (year: number) => void;
  onZoomToYears: () => void;
  onBackfill: (targetStartDate: string) => void;
  backfilling: boolean;
};

const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function SpendingCalendar({
  unit,
  coverage,
  focusSeed,
  onSelect,
  onDrillToWeeks,
  onZoomToMonths,
  onZoomToYears,
  onBackfill,
  backfilling,
}: SpendingCalendarProps) {
  // Focused year/month for the month/week grids (ignored for the year grid).
  const [focus, setFocus] = useState<{ year: number; month: number }>({ year: 0, month: 0 });
  // Two-click selection into the current grid's cells.
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [phase, setPhase] = useState<"idle" | "started">("idle");
  const [pendingIdx, setPendingIdx] = useState<number>(-1);

  const earliestSynced = coverage?.earliestSynced ?? null;
  const latestSynced = coverage?.latestSynced ?? null;
  const hasConnections = (coverage?.connections.length ?? 0) > 0;

  // --- Focus initialization (on unit / coverage / drill seed change) ---------
  useEffect(() => {
    if (!coverage) return;
    const base = coverage.latestSynced ?? coverage.today;
    const bd = new Date(base + "T00:00:00Z");
    const year = focusSeed?.year ?? bd.getUTCFullYear();
    const month = focusSeed?.month ?? bd.getUTCMonth();
    setFocus({ year, month });
  }, [unit, coverage, focusSeed]);

  // --- Current grid ----------------------------------------------------------
  // Built inline (not memoized) — cheap, and keeps the effect deps honest.
  const cells: Cell[] = coverage
    ? unit === "year"
      ? yearCells(coverage.floor, coverage.today)
      : unit === "month"
        ? monthCells(focus.year, coverage.floor, coverage.today)
        : weekRows(focus.year, focus.month, coverage.floor, coverage.today)
    : [];

  // Signature that changes only when the grid's identity changes, so the
  // default-selection effect doesn't re-run on every render.
  const gridKey = `${unit}|${focus.year}|${focus.month}|${cells.length}|${coverage?.floor ?? ""}|${coverage?.today ?? ""}|${earliestSynced ?? ""}|${latestSynced ?? ""}`;

  const emitSpan = useCallback(
    (lo: number, hi: number, cellsForSpan: Cell[], focusForSpan: { year: number; month: number }) => {
      if (!cellsForSpan[lo] || !cellsForSpan[hi]) return;
      const { from, to } = spanFromCells(cellsForSpan, lo, hi);
      if (!from || !to) return;
      onSelect({
        from,
        to,
        unit,
        multi: lo !== hi,
        label: buildSpanLabel(unit, cellsForSpan, lo, hi, focusForSpan),
      });
    },
    [unit, onSelect],
  );

  // --- Default selection whenever the grid changes ---------------------------
  useEffect(() => {
    if (cells.length === 0) {
      setSelection(null);
      return;
    }
    const idx = defaultCellIndex(cells, earliestSynced, latestSynced);
    setSelection([idx, idx]);
    setPhase("idle");
    setPendingIdx(-1);
    emitSpan(idx, idx, cells, focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);

  if (!coverage || cells.length === 0) return null;

  const selLo = selection ? Math.min(selection[0], selection[1]) : -1;
  const selHi = selection ? Math.max(selection[0], selection[1]) : -1;

  function handleCellClick(idx: number) {
    if (!cells[idx]?.selectable) return;
    if (phase === "idle") {
      setPhase("started");
      setPendingIdx(idx);
      setSelection([idx, idx]);
      emitSpan(idx, idx, cells, focus);
    } else {
      setPhase("idle");
      const lo = Math.min(pendingIdx, idx);
      const hi = Math.max(pendingIdx, idx);
      setSelection([lo, hi]);
      emitSpan(lo, hi, cells, focus);
    }
  }

  // --- Backfill CTA state ----------------------------------------------------
  const selectionHasGhosts = (() => {
    if (selLo < 0) return false;
    for (let i = selLo; i <= selHi; i++) {
      const c = cells[i];
      if (c && c.selectable && !isCovered(c, earliestSynced, latestSynced)) return true;
    }
    return false;
  })();
  const showBackfillCta = selectionHasGhosts && hasConnections;
  const showConnectNote = selectionHasGhosts && !hasConnections;

  const selectedLabel = (() => {
    if (selLo < 0 || !cells[selLo] || !cells[selHi]) return "";
    return buildSpanLabel(unit, cells, selLo, selHi, focus);
  })();

  // --- Month navigation (week grid) ------------------------------------------
  function stepMonth(delta: number) {
    if (!coverage) return;
    const d = new Date(Date.UTC(focus.year, focus.month, 1));
    d.setUTCMonth(d.getUTCMonth() + delta);
    const first = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    // Don't page past the floor month or into the future month.
    if (delta < 0 && first < coverage.floor.slice(0, 7) + "-01") return;
    if (delta > 0 && first > coverage.today.slice(0, 7) + "-01") return;
    setFocus({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }

  function stepYear(delta: number) {
    if (!coverage) return;
    const floorYear = Number(coverage.floor.slice(0, 4));
    const todayYear = Number(coverage.today.slice(0, 4));
    const next = focus.year + delta;
    if (next < floorYear || next > todayYear) return;
    setFocus({ year: next, month: focus.month });
  }

  const floorYear = Number(coverage.floor.slice(0, 4));
  const todayYear = Number(coverage.today.slice(0, 4));
  const focusMonthFirst = `${focus.year}-${String(focus.month + 1).padStart(2, "0")}-01`;
  const canPrevMonth = focusMonthFirst > coverage.floor.slice(0, 7) + "-01";
  const canNextMonth = focusMonthFirst < coverage.today.slice(0, 7) + "-01";

  return (
    <div className="space-y-2.5">
      {/* ---- Header / navigation ---- */}
      {unit === "month" && (
        <NavHeader
          title={String(focus.year)}
          onTitle={onZoomToYears}
          titleHint="Zoom out to years"
          onPrev={focus.year > floorYear ? () => stepYear(-1) : undefined}
          onNext={focus.year < todayYear ? () => stepYear(1) : undefined}
        />
      )}
      {unit === "week" && (
        <NavHeader
          title={monthTitle(focus.year, focus.month)}
          onTitle={() => onZoomToMonths(focus.year)}
          titleHint="Zoom out to months"
          onPrev={canPrevMonth ? () => stepMonth(-1) : undefined}
          onNext={canNextMonth ? () => stepMonth(1) : undefined}
        />
      )}

      {/* ---- Grid ---- */}
      {unit === "year" && (
        <div role="group" aria-label="Coverage calendar — years" className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {cells.map((cell, idx) => (
            <GridCell
              key={cell.key}
              cell={cell}
              covered={isCovered(cell, earliestSynced, latestSynced)}
              selected={idx >= selLo && idx <= selHi}
              onClick={() => handleCellClick(idx)}
            />
          ))}
        </div>
      )}

      {unit === "month" && (
        <div role="group" aria-label="Coverage calendar — months" className="grid grid-cols-4 gap-1.5">
          {cells.map((cell, idx) => (
            <GridCell
              key={cell.key}
              cell={cell}
              covered={isCovered(cell, earliestSynced, latestSynced)}
              selected={idx >= selLo && idx <= selHi}
              onClick={() => handleCellClick(idx)}
              onDrill={cell.selectable ? () => onDrillToWeeks(focus.year, idx) : undefined}
            />
          ))}
        </div>
      )}

      {unit === "week" && (
        <div role="group" aria-label="Coverage calendar — weeks">
          <div className="mb-1 grid grid-cols-7 gap-1.5 px-1">
            {WEEKDAY_HEADERS.map((w) => (
              <span key={w} className="text-center text-meta text-ink-tertiary">
                {w}
              </span>
            ))}
          </div>
          <div className="space-y-1.5">
            {(cells as WeekRow[]).map((row, idx) => (
              <WeekRowCell
                key={row.key}
                row={row}
                covered={isCovered(row, earliestSynced, latestSynced)}
                selected={idx >= selLo && idx <= selHi}
                onClick={() => handleCellClick(idx)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---- Caption + selected label ---- */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-meta text-ink-tertiary">Banks share up to ~2 years of history.</p>
        {selectedLabel && (
          <p className="text-meta text-ink-secondary">
            Selected: <span className="text-ink">{selectedLabel}</span>
          </p>
        )}
      </div>

      {/* ---- Backfill CTA ---- */}
      {showBackfillCta && (
        <button
          type="button"
          disabled={backfilling}
          onClick={() => {
            const first = cells[selLo];
            if (first) onBackfill(first.startDate);
          }}
          className="min-h-[36px] rounded-md bg-accent px-4 text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
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
            `Pull ${selectedLabel} from your bank`
          )}
        </button>
      )}

      {/* ---- No-connections note ---- */}
      {showConnectNote && (
        <p className="text-meta text-ink-tertiary">Connect a bank to pull older history.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Span label
// ---------------------------------------------------------------------------

function dayOf(dateStr: string): number {
  return Number(dateStr.slice(8, 10));
}

function buildSpanLabel(
  unit: Grain,
  cells: Cell[],
  lo: number,
  hi: number,
  focus: { year: number; month: number },
): string {
  const first = cells[lo];
  const last = cells[hi];
  if (!first || !last) return "";

  if (unit === "year") {
    return lo === hi ? first.label : `${first.label}–${last.label}`;
  }
  if (unit === "month") {
    return lo === hi
      ? `${first.label} ${focus.year}`
      : `${first.label}–${last.label} ${focus.year}`;
  }
  // week: label by clamped day range within the focused month.
  const mon = shortMonth(focus.month);
  const startDay = dayOf(first.startDate);
  const endDay = dayOf(last.endDate);
  return startDay === endDay ? `${mon} ${startDay}` : `${mon} ${startDay}–${endDay}`;
}

// ---------------------------------------------------------------------------
// NavHeader
// ---------------------------------------------------------------------------

function NavHeader({
  title,
  onTitle,
  titleHint,
  onPrev,
  onNext,
}: {
  title: string;
  onTitle: () => void;
  titleHint: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <NavArrow dir="prev" onClick={onPrev} />
      <button
        type="button"
        onClick={onTitle}
        title={titleHint}
        className="rounded-md px-2 py-1 text-body font-medium text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {title}
      </button>
      <NavArrow dir="next" onClick={onNext} />
    </div>
  );
}

function NavArrow({ dir, onClick }: { dir: "prev" | "next"; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={dir === "prev" ? "Previous" : "Next"}
      className="flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-sunken disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// GridCell — a year or month cell
// ---------------------------------------------------------------------------

function GridCell({
  cell,
  covered,
  selected,
  onClick,
  onDrill,
}: {
  cell: Cell;
  covered: boolean;
  selected: boolean;
  onClick: () => void;
  onDrill?: () => void;
}) {
  const base =
    "relative flex min-h-[52px] flex-col items-center justify-center rounded-md px-2 py-2.5 text-center transition-all duration-100 select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";

  const { className, style } = cellVisual(cell.selectable, covered, selected);

  return (
    <div className="relative">
      <button
        type="button"
        className={`${base} w-full ${className} ${cell.selectable ? "cursor-pointer" : "cursor-not-allowed"}`}
        style={style}
        onClick={onClick}
        disabled={!cell.selectable}
        aria-pressed={selected}
        title={cell.selectable ? `${cell.startDate} – ${cell.endDate}` : "Outside your bank's history"}
      >
        <span className="whitespace-nowrap">{cell.label}</span>
        {covered && !selected && (
          <span
            aria-hidden="true"
            className="mt-1 h-1 w-1 rounded-full"
            style={{ background: "var(--accent)", opacity: 0.6 }}
          />
        )}
      </button>
      {onDrill && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDrill();
          }}
          aria-label={`Open ${cell.label} by week`}
          title="Pick weeks in this month"
          className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded text-[10px] leading-none text-ink-tertiary transition-colors hover:bg-surface-raised hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ⤢
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WeekRowCell — a Sun–Sat week row in the month grid
// ---------------------------------------------------------------------------

function WeekRowCell({
  row,
  covered,
  selected,
  onClick,
}: {
  row: WeekRow;
  covered: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const { className, style } = cellVisual(row.selectable, covered, selected);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!row.selectable}
      aria-pressed={selected}
      title={row.selectable ? `${row.startDate} – ${row.endDate}` : "Outside your bank's history"}
      className={`grid w-full grid-cols-7 gap-1.5 rounded-md p-1 transition-all duration-100 select-none ${className} ${
        row.selectable ? "cursor-pointer" : "cursor-not-allowed"
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1`}
      style={style}
    >
      {row.days.map((d) => (
        <span
          key={d.date}
          className="flex h-7 items-center justify-center text-center text-meta tabular-nums"
          style={{
            opacity: d.inMonth ? (d.selectable ? 1 : 0.4) : 0.28,
            fontWeight: d.inMonth ? 500 : 400,
          }}
        >
          {d.day}
        </span>
      ))}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared cell visual styling
// ---------------------------------------------------------------------------

function cellVisual(
  selectable: boolean,
  covered: boolean,
  selected: boolean,
): { className: string; style: React.CSSProperties } {
  if (!selectable) {
    return {
      className: "text-meta text-ink-tertiary",
      style: {
        background: "var(--surface-sunken)",
        border: "1px solid var(--border-subtle)",
        opacity: 0.4,
      },
    };
  }
  if (selected) {
    return {
      className: "text-meta font-medium text-ink-inverse",
      style: { background: "var(--ink)" },
    };
  }
  if (covered) {
    return {
      className: "text-meta text-ink hover:opacity-80",
      style: { background: "var(--surface-raised)", border: "1px solid var(--border-subtle)" },
    };
  }
  // Ghost: within reach, not yet pulled.
  return {
    className: "text-meta text-ink-tertiary hover:opacity-75",
    style: { background: "var(--surface-sunken)", border: "1px dashed var(--border-strong)", opacity: 0.7 },
  };
}
