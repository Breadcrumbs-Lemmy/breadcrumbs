/**
 * DateRangePicker — compact date-range selector.
 *
 * Redesigned from a row of seven always-visible preset chips (which read as
 * clutter on the Transactions screen) into a single trigger that opens a small
 * popover. The popover offers a *curated* four-preset set plus a tucked-away
 * custom range, so the common path is one glance and one click while an
 * arbitrary range is still one disclosure away.
 *
 * The `from`/`to` values are ISO YYYY-MM-DD strings that map directly onto the
 * API's `?from=` and `?to=` parameters, so callers do not transform them.
 *
 * Design decisions:
 *   • Browser <input type="date"> for the custom range. It handles keyboard
 *     navigation and locale display without a custom calendar widget, and it
 *     has no dependency footprint.
 *   • Presets are computed at render time from `new Date()` so they are always
 *     relative to today — no stale "this year" label rolling over in January.
 *   • The component emits a value immediately on every change (preset click or
 *     date input), so the parent can start fetching without a submit step.
 *   • "All time" emits {from: undefined, to: undefined} — the caller passes
 *     nothing to the API and the API returns everything it has.
 */
import { useEffect, useId, useRef, useState } from "react";

export type DateRange = {
  from?: string;
  to?: string;
  label: string;
};

type Props = {
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** Optional earliest bound for the custom date inputs (YYYY-MM-DD).
   *  Falls back to "2000-01-01" so the user is never blocked from picking
   *  dates that pre-date the current dataset. */
  earliest?: string;
};

// ---- preset generation ----------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

type Preset = { label: string; from?: string; to?: string };

/** Deliberately four. The full "last month / last 6 months / last 12 months"
 *  ladder was noise on a screen whose job is the rows, not the date maths. */
function buildPresets(): Preset[] {
  const today = new Date();
  const todayStr = isoDate(today);
  const months3Ago = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1));

  return [
    { label: "This month", from: isoDate(startOfMonth(today)), to: todayStr },
    { label: "Last 3 months", from: isoDate(months3Ago), to: todayStr },
    { label: "This year", from: isoDate(startOfYear(today)), to: todayStr },
    { label: "All time", from: undefined, to: undefined },
  ];
}

// ---- component ------------------------------------------------------------

export function DateRangePicker({ value, onChange, earliest = "2000-01-01" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const presets = buildPresets();
  const isCustom = value.label === "Custom range" || !presets.some((p) => p.label === value.label);

  // Close on outside click or Escape — expected popover behaviour.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function applyPreset(preset: Preset) {
    onChange({ from: preset.from, to: preset.to, label: preset.label });
    setOpen(false);
  }

  function handleCustomFrom(from: string) {
    onChange({ from: from || undefined, to: value.to, label: "Custom range" });
  }

  function handleCustomTo(to: string) {
    onChange({ from: value.from, to: to || undefined, label: "Custom range" });
  }

  return (
    <div ref={rootRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="inline-flex min-h-[38px] items-center gap-2 rounded-pill border border-line-subtle bg-surface-raised pl-3.5 pr-3 text-label text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
      >
        <CalendarGlyph />
        <span className="text-ink">{value.label}</span>
        <span
          aria-hidden="true"
          className={`text-[10px] text-ink-tertiary transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Choose a date range"
          className="pop-in absolute left-0 z-30 mt-2 w-[260px] rounded-lg border border-line-subtle bg-surface-raised p-1.5 shadow-lg"
        >
          {presets.map((preset) => {
            const active = !isCustom && value.label === preset.label;
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-body transition-colors ${
                  active
                    ? "bg-accent-soft text-accent-ink"
                    : "text-ink-secondary hover:bg-surface-sunken hover:text-ink"
                }`}
              >
                {preset.label}
                {active && (
                  <span aria-hidden="true" className="text-accent">
                    ✓
                  </span>
                )}
              </button>
            );
          })}

          {/* Custom range — one disclosure below the presets, not a permanent
              fixture competing with them. */}
          <div className="mt-1.5 border-t border-line-subtle px-3 pb-1 pt-2.5">
            <p className="mb-2 text-meta uppercase tracking-[0.06em] text-ink-tertiary">
              Custom range
            </p>
            <div
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors ${
                isCustom ? "border-accent" : "border-line-subtle"
              }`}
            >
              <input
                type="date"
                aria-label="From date"
                min={earliest}
                max={isoDate(new Date())}
                value={value.from ?? ""}
                onChange={(e) => handleCustomFrom(e.target.value)}
                className="w-full bg-transparent text-label text-ink outline-none"
              />
              <span aria-hidden="true" className="text-meta text-ink-tertiary">
                →
              </span>
              <input
                type="date"
                aria-label="To date"
                min={earliest}
                max={isoDate(new Date())}
                value={value.to ?? ""}
                onChange={(e) => handleCustomTo(e.target.value)}
                className="w-full bg-transparent text-label text-ink outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="text-ink-tertiary">
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3.2v3.4M16 3.2v3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
