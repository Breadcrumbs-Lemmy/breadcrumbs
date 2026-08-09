/**
 * Display primitives — docs/ui-design-system.md.
 * Formatting and presentation only.
 */
import type { AffordabilityLevel, Freshness } from "@ai-fin-os/core";
import { formatMoney, isMoneyAvailable } from "../format/money";
import { formatDate, formatRelativeAge } from "../format/dates";

// ---- Money ----------------------------------------------------------------

export function Money({
  cents,
  estimated = false,
  className = "",
}: {
  cents: number | null | undefined;
  estimated?: boolean;
  className?: string;
}) {
  const available = isMoneyAvailable(cents);
  return (
    <span
      className={`tabular ${available ? "" : "text-ink-tertiary"} ${className}`}
      title={estimated ? "Estimated value" : undefined}
    >
      {formatMoney(cents, { estimated })}
    </span>
  );
}

/** Unavailable figures get a dashed container, never a $0.00. */
export function MoneyOrPlaceholder({
  cents,
  label,
}: {
  cents: number | null | undefined;
  label: string;
}) {
  if (isMoneyAvailable(cents)) return <Money cents={cents} />;
  return (
    <span
      className="tabular inline-flex items-center rounded-sm border border-dashed border-line-strong px-2 text-ink-tertiary"
      aria-label={`${label} not available`}
    >
      —
    </span>
  );
}

// ---- Dates ----------------------------------------------------------------

export function DateDisplay({ iso, reference }: { iso: string | null | undefined; reference?: string }) {
  return <span className="tabular">{formatDate(iso, reference)}</span>;
}

// ---- Level glyph ----------------------------------------------------------

/**
 * Level is encoded three ways at once: color, glyph shape, and word.
 * Shape alone must distinguish the four states in grayscale.
 */
export function LevelGlyph({ level, size = 28 }: { level: AffordabilityLevel; size?: number }) {
  const stroke = "var(--level-fg)";
  const common = { fill: "none", stroke, strokeWidth: 2, strokeLinecap: "round" as const };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      {level === "RISKY" ? (
        // Angular, directional — the only shape that isn't a closed circle.
        <>
          <path d="M12 3.5 22 20.5H2Z" {...common} strokeLinejoin="round" />
          <path d="M12 10v4.5" {...common} />
          <circle cx="12" cy="17.6" r="0.6" fill={stroke} stroke="none" />
        </>
      ) : (
        <>
          <circle
            cx="12"
            cy="12"
            r="9.5"
            {...common}
            // Dashed for UNKNOWN: the absence of a result, not a fifth result.
            strokeDasharray={level === "UNKNOWN" ? "3 3" : undefined}
          />
          {level === "AFFORDABLE" && <path d="M7.6 12.2 10.7 15.3 16.4 9.2" {...common} strokeLinejoin="round" />}
          {level === "TIGHT" && <path d="M7.8 12h8.4" {...common} />}
          {level === "UNKNOWN" && (
            <>
              <path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.6c-.6.2-.9.7-.9 1.3v.5" {...common} />
              <circle cx="12" cy="16.4" r="0.65" fill={stroke} stroke="none" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

// ---- Freshness ------------------------------------------------------------

export function FreshnessDot({ freshness }: { freshness: Freshness }) {
  const base = "inline-block h-2 w-2 rounded-full align-middle";
  const style: Record<Freshness["status"], string> = {
    fresh: `${base} bg-accent`,
    usable: `${base} bg-ink-tertiary`,
    stale: `${base} border-2 border-line-strong`,
    missing: `${base} border-2 border-dashed border-line-strong`,
    estimated: `${base} border border-ink-tertiary`,
  };
  const label: Record<Freshness["status"], string> = {
    fresh: formatRelativeAge(freshness.asOf, freshness.ageHours),
    usable: formatRelativeAge(freshness.asOf, freshness.ageHours),
    stale: formatRelativeAge(freshness.asOf, freshness.ageHours),
    missing: "Not available",
    estimated: "Estimated",
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-meta text-ink-tertiary">
      <span className={style[freshness.status]} />
      {label[freshness.status]}
    </span>
  );
}

// ---- Layout ---------------------------------------------------------------

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-line-subtle bg-surface-raised p-5 shadow-card ${className}`}
    >
      {title && <h2 className="mb-4 text-heading">{title}</h2>}
      {children}
    </section>
  );
}

export function MetricRow({
  label,
  value,
  date,
  reference,
}: {
  label: string;
  value: number | null | undefined;
  date?: string;
  reference?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-label text-ink-secondary">{label}</span>
      <span className="flex items-baseline gap-3">
        <MoneyOrPlaceholder cents={value} label={label} />
        {date && (
          <span className="text-meta text-ink-tertiary">
            <DateDisplay iso={date} reference={reference} />
          </span>
        )}
      </span>
    </div>
  );
}
