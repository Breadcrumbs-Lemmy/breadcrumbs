/**
 * CoverageRail — the Coverage Calendar control for the Spending page.
 *
 * Renders a horizontal, scrollable strip of time-bucket cells spanning back to
 * Plaid's ~24-month history floor. Each cell is either:
 *   • Filled  — data already synced locally (rendered solid).
 *   • Ghost   — within the Plaid window but not yet pulled (muted, dashed).
 *
 * Selection model (two-click range):
 *   1. Click once  → single-cell selection (drill-in into that bucket).
 *   2. Click again on a DIFFERENT cell → contiguous range between the two.
 *   3. Click a third time → reset to a new single-cell selection.
 *
 * When the selection spans un-synced buckets AND the user has at least one
 * Plaid connection, a primary CTA ("Pull … from your bank") appears. While
 * `backfilling` is true the CTA shows a spinner and is disabled.
 *
 * When no Plaid connections exist (CSV-only users), a muted note replaces the
 * CTA so the ghost state is still honest but there's nothing to pull.
 */
import { useEffect, useRef, useState } from "react";
import type { Bucket, Grain } from "../model/calendar";
import { isCovered } from "../model/calendar";
import type { PlaidCoverage } from "../services/api";

export type CoverageSelection = [number, number]; // [startBucketIdx, endBucketIdx]

export type CoverageRailProps = {
  grain: Grain;
  buckets: Bucket[];
  coverage: PlaidCoverage | null;
  /** Currently selected range as [startIdx, endIdx] (may be [i, i] for single). */
  selection: CoverageSelection | null;
  onSelect: (range: CoverageSelection) => void;
  onBackfill: (targetStartDate: string) => void;
  backfilling: boolean;
};

export function CoverageRail({
  buckets,
  coverage,
  selection,
  onSelect,
  onBackfill,
  backfilling,
}: CoverageRailProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Two-click interaction phase. "idle" = next click is range start.
  const [phase, setPhase] = useState<"idle" | "started">("idle");
  const [pendingIdx, setPendingIdx] = useState<number>(-1);
  const didAutoScroll = useRef(false);

  // Auto-scroll to the rightmost (most-recent) bucket on initial render.
  useEffect(() => {
    if (!scrollRef.current || buckets.length === 0 || didAutoScroll.current) return;
    didAutoScroll.current = true;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
      }
    });
  }, [buckets.length]);

  // Reset click phase when selection changes externally (period switch, backfill).
  useEffect(() => {
    setPhase("idle");
    setPendingIdx(-1);
  }, [selection]);

  if (buckets.length === 0) return null;

  const earliestSynced = coverage?.earliestSynced ?? null;
  const latestSynced = coverage?.latestSynced ?? null;
  const hasConnections = (coverage?.connections.length ?? 0) > 0;

  const selLo = selection ? Math.min(selection[0], selection[1]) : -1;
  const selHi = selection ? Math.max(selection[0], selection[1]) : -1;

  // Backfill CTA: show when any selected bucket is a ghost.
  const selectionHasGhosts = (() => {
    if (selection === null) return false;
    for (let i = selLo; i <= selHi; i++) {
      const b = buckets[i];
      if (b && !isCovered(b, earliestSynced, latestSynced)) return true;
    }
    return false;
  })();

  const showBackfillCta = selectionHasGhosts && hasConnections;
  const showConnectNote = selectionHasGhosts && !hasConnections;

  // Label for the backfill button describes the selected span.
  const ctaRangeLabel = (() => {
    if (selLo < 0) return "";
    const first = buckets[selLo];
    const last = buckets[selHi];
    if (!first || !last) return "";
    return selLo === selHi ? first.label : `${first.label} – ${last.label}`;
  })();

  function handleCellClick(idx: number) {
    if (phase === "idle") {
      // First click: begin range, select single cell.
      setPhase("started");
      setPendingIdx(idx);
      onSelect([idx, idx]);
    } else {
      // Second click: complete range.
      setPhase("idle");
      const lo = Math.min(pendingIdx, idx);
      const hi = Math.max(pendingIdx, idx);
      onSelect([lo, hi]);
    }
  }

  return (
    <div className="space-y-2.5">
      {/* ---- Scrollable bucket strip ---- */}
      <div
        ref={scrollRef}
        role="group"
        aria-label="Coverage calendar"
        className="flex items-stretch gap-1.5 overflow-x-auto pb-1"
        style={{ scrollbarWidth: "thin" }}
      >
        {buckets.map((bucket, idx) => {
          const covered = isCovered(bucket, earliestSynced, latestSynced);
          const inSel = idx >= selLo && idx <= selHi;

          return (
            <BucketCell
              key={bucket.key}
              bucket={bucket}
              covered={covered}
              selected={inSel}
              onClick={() => handleCellClick(idx)}
            />
          );
        })}
      </div>

      {/* ---- Caption ---- */}
      <p className="text-meta text-ink-tertiary">
        Banks share up to ~2 years of history.
      </p>

      {/* ---- Backfill CTA ---- */}
      {showBackfillCta && (
        <button
          type="button"
          disabled={backfilling}
          onClick={() => {
            const firstBucket = buckets[selLo];
            if (firstBucket) onBackfill(firstBucket.startDate);
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
            `Pull ${ctaRangeLabel} from your bank`
          )}
        </button>
      )}

      {/* ---- No-connections note ---- */}
      {showConnectNote && (
        <p className="text-meta text-ink-tertiary">
          Connect a bank to pull older history.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BucketCell
// ---------------------------------------------------------------------------

function BucketCell({
  bucket,
  covered,
  selected,
  onClick,
}: {
  bucket: Bucket;
  covered: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  // Base layout: fixed minimum size so cells are uniformly tappable.
  const base =
    "relative flex-shrink-0 flex flex-col items-center justify-center rounded-md px-2 py-2.5 min-w-[52px] min-h-[52px] text-center cursor-pointer transition-all duration-100 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 select-none";

  let extraClass = "";
  let style: React.CSSProperties = {};

  if (selected) {
    style.background = "var(--ink)";
    extraClass = "text-meta font-medium text-ink-inverse";
  } else if (covered) {
    style.background = "var(--surface-raised)";
    style.border = "1px solid var(--border-subtle)";
    extraClass = "text-meta text-ink hover:opacity-80";
  } else {
    // Ghost: muted, dashed border, reduced opacity.
    style.background = "var(--surface-sunken)";
    style.border = "1px dashed var(--border-strong)";
    style.opacity = 0.55;
    extraClass = "text-meta text-ink-tertiary hover:opacity-75";
  }

  return (
    <button
      type="button"
      className={`${base} ${extraClass}`}
      style={style}
      onClick={onClick}
      aria-pressed={selected}
      title={`${bucket.startDate} – ${bucket.endDate}`}
    >
      <span className="whitespace-nowrap">{bucket.label}</span>
      {/* Accent pip on covered-but-unselected cells to signal synced data. */}
      {covered && !selected && (
        <span
          aria-hidden="true"
          className="mt-1 h-1 w-1 rounded-full"
          style={{ background: "var(--accent)", opacity: 0.6 }}
        />
      )}
    </button>
  );
}
