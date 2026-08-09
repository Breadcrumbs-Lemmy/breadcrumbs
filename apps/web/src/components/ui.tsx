/**
 * Shared interface pieces for the redesigned surfaces.
 * Presentation only — nothing here reads or derives a financial value.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatMoney } from "../format/money";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- Card -----------------------------------------------------------------

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <section className={`card ${padded ? "p-5" : ""} ${className}`}>{children}</section>;
}

// ---- Segmented control ----------------------------------------------------

/**
 * The period switcher. A sliding indicator rather than four separate buttons,
 * because the options are mutually exclusive views of the same data and should
 * read as one control.
 *
 * The indicator is *measured*, not computed from percentages. The previous
 * version positioned it with `left: calc(index * 25% + 2px)` against a padded
 * container whose tabs actually occupy `100% − 8px`, so the pill drifted off
 * its label — worse at higher indices. Here a ResizeObserver reads the selected
 * tab's real box and the pill is translated to it in pixels, so it lands dead
 * centre at any width, label length, or option count. Arrow keys move between
 * tabs (roving tabindex), which is the expected keyboard behaviour for a
 * tablist and was missing before.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; muted?: boolean }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  const index = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  // Suppress the slide transition for the very first placement, so the pill
  // appears already under the active tab instead of flying in from the left.
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const el = tabRefs.current[index];
    const list = listRef.current;
    if (!el || !list) return;
    setPill({ x: el.offsetLeft, w: el.offsetWidth });
  }, [index]);

  useLayoutEffect(() => {
    measure();
    const raf = requestAnimationFrame(() => setReady(true));
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(raf);
    // Re-measure when the control resizes (font swap, viewport change, sidebar
    // collapse) so the pill never falls out of alignment.
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    for (const t of tabRefs.current) if (t) ro.observe(t);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure]);

  function onKeyDown(e: React.KeyboardEvent) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="segmented relative flex rounded-pill bg-surface-sunken p-1"
    >
      {pill && (
        <span
          aria-hidden="true"
          className="segmented-pill absolute inset-y-1 rounded-pill bg-surface-raised shadow-sm"
          style={{
            width: pill.w,
            transform: `translateX(${pill.x}px)`,
            transition: ready
              ? "transform var(--dur-base) var(--ease-spring), width var(--dur-base) var(--ease-spring)"
              : "none",
          }}
        />
      )}
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            type="button"
            onClick={() => onChange(option.value)}
            className={`relative z-10 min-h-[36px] flex-1 rounded-pill px-2 text-label transition-colors duration-200 ${
              selected ? "text-ink" : "text-ink-tertiary hover:text-ink-secondary"
            }`}
          >
            {option.label}
            {option.muted && !selected && (
              <span className="ml-1 align-super text-[9px] tracking-normal opacity-70">soon</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Chip -----------------------------------------------------------------

export function Chip({
  children,
  onClick,
  active = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[32px] rounded-pill px-3 text-label transition-colors ${
        active
          ? "bg-ink text-ink-inverse"
          : "border border-line-subtle bg-surface-raised text-ink-secondary hover:border-line-strong hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// ---- Bar ------------------------------------------------------------------

/** Rounded, animated proportional bar. Rounded caps read softer than square. */
export function Bar({
  pct,
  color,
  delay = 0,
}: {
  pct: number;
  color: string;
  delay?: number;
}) {
  return (
    <div className="h-[5px] overflow-hidden rounded-pill bg-surface-inset">
      <div
        className="bar-fill bar-sheen h-full rounded-pill"
        style={{
          width: `${Math.min(Math.max(pct, 1.5), 100)}%`,
          background: color,
          animationDelay: `${delay}ms`,
        }}
      />
    </div>
  );
}

// ---- Delta ----------------------------------------------------------------

/**
 * A change indicator. Direction is carried by an arrow and a word, never by
 * red-versus-green — spending more on groceries is information, not a failure.
 */
export function Delta({
  direction,
  children,
}: {
  direction: "up" | "down";
  children: ReactNode;
}) {
  const up = direction === "up";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-meta"
      style={{
        color: up ? "var(--rise)" : "var(--fall)",
        background: up ? "var(--rise-soft)" : "var(--fall-soft)",
      }}
    >
      <span aria-hidden="true" className="text-[9px] leading-none">
        {up ? "▲" : "▼"}
      </span>
      {children}
    </span>
  );
}

// ---- Section heading ------------------------------------------------------

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-label uppercase tracking-[0.06em] text-ink-tertiary">{children}</h2>
  );
}

// ---- Count-up money -------------------------------------------------------

/**
 * A hero money figure that climbs to its value on mount.
 *
 * This is a *display tween* of a figure the backend already owns: it always
 * starts below zero-latency and lands exactly on the real cents, quickly, so no
 * intermediate frame can be mistaken for a different amount. The cents/no-cents
 * decision is locked to the final value for the whole climb, so the string
 * width doesn't jitter as digits fill in. Under `prefers-reduced-motion` it
 * renders the final value immediately — no arithmetic on a backend figure, just
 * animated presentation of one.
 */
export function CountUpMoney({
  cents,
  className = "",
  durationMs = 680,
}: {
  cents: number;
  className?: string;
  durationMs?: number;
}) {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? cents : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(cents);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const from = 0;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start) / durationMs, 1);
      // ease-out cubic — most of the distance is covered early, then it settles
      // gently onto the true figure.
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (cents - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setValue(cents);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cents, durationMs]);

  const alwaysCents = Math.abs(cents) % 100 !== 0;
  return <span className={className}>{formatMoney(value, { alwaysCents })}</span>;
}

// ---- Trail divider --------------------------------------------------------

/**
 * A breadcrumb rule that echoes the logo: a faint line trailing off into three
 * beads that brighten toward a solid accent "you are here" dot. Purely
 * decorative — a small brand beat used to lead the eye toward an action or the
 * evidence behind a claim.
 */
export function TrailDivider({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`flex items-center gap-2 ${className}`}>
      <span className="h-px flex-1" style={{ background: "var(--border-subtle)" }} />
      <span className="flex items-center gap-1">
        <span
          className="h-1 w-1 rounded-pill"
          style={{ background: "var(--border-strong)", opacity: 0.45 }}
        />
        <span
          className="h-1 w-1 rounded-pill"
          style={{ background: "var(--border-strong)", opacity: 0.75 }}
        />
        <span className="h-1.5 w-1.5 rounded-pill" style={{ background: "var(--accent)" }} />
      </span>
    </div>
  );
}
