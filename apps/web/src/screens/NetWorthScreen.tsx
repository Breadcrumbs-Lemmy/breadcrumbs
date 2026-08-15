/**
 * Net worth — the balance-sheet direction over time (`docs/net-worth.md`).
 *
 * "Cash net worth" is what you have minus what you owe on cards and loans, month
 * by month. Investments are excluded (D-N2): a brokerage balance moves with the
 * market, not with recorded transactions, so back-casting one would draw a false
 * line. The current point equals the Accounts headline exactly — same accounts,
 * same sign rule.
 *
 * Honesty is the whole design here. Recent points are *recorded* from real
 * balances; older ones are *reconstructed* from the transaction record and can
 * drift where a balance changed without a transaction (loan interest, a manual
 * edit). The chart reserves the solid line for recorded points and draws the
 * reconstructed portion dashed and muted, with a plain note saying so (D-N6).
 *
 * The browser formats and nothing else (`CD-011`): every cent — the level, the
 * change, cash vs debt — is computed in core and read straight off the response.
 * Word-first (`D-006`): direction is carried by a word and an arrow; colour is a
 * restrained accent and never the only signal (D-N9).
 */
import { useEffect, useState } from "react";
import type { NetWorthPoint, NetWorthTrend } from "@ai-fin-os/core";
import { fetchNetWorthTrend, type ApiOutcome } from "../services/api";
import { formatMoney } from "../format/money";
import { Card, CountUpMoney, SectionLabel } from "../components/ui";

const W = 720;
const H = 220;
const PAD = { top: 18, right: 16, bottom: 30, left: 66 };

export function NetWorthScreen({ onBack }: { onBack?: () => void }) {
  const [outcome, setOutcome] = useState<ApiOutcome<NetWorthTrend> | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchNetWorthTrend().then((next) => {
      if (alive) setOutcome(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-[760px]">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex items-center gap-1.5 text-label text-ink-secondary hover:text-ink"
        >
          <span aria-hidden="true">←</span> Accounts
        </button>
      )}

      {outcome === null ? (
        <div className="h-[420px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />
      ) : outcome.kind !== "ok" ? (
        <Card className="max-w-[560px]">
          <p className="text-body">Couldn't load your net-worth trend.</p>
          <p className="mt-1 text-meta text-ink-tertiary">
            {outcome.kind === "error" ? outcome.message : "The request was rejected."}
          </p>
        </Card>
      ) : (
        <TrendBody trend={outcome.data} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TrendBody({ trend }: { trend: NetWorthTrend }) {
  if (!trend.hasData || trend.points.length === 0) {
    return (
      <div>
        <Header />
        <Card className="mt-6 text-center">
          <p className="text-body">No net worth to trend yet.</p>
          <p className="mx-auto mt-1 max-w-[44ch] text-body text-ink-secondary">
            Connect a bank or import a statement, and your cash net worth — what you have, minus
            what you owe — will start plotting here.
          </p>
        </Card>
      </div>
    );
  }

  const last = trend.points[trend.points.length - 1]!;
  const startMonth = trend.coverageStartMonth;
  const singleMonth = trend.monthsCovered <= 1;

  return (
    <div>
      <Header />

      {/* Word-first headline: the level, then the direction over the window. */}
      <div className="mt-1">
        <CountUpMoney cents={trend.currentNetWorthCents} className="numeral text-hero text-ink" />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {!singleMonth && startMonth && (
            <ChangeBadge changeCents={trend.changeCents} sinceMonth={startMonth} />
          )}
          <p className="text-meta text-ink-tertiary">
            cash {formatMoney(last.cashCents)} · owed {formatMoney(last.debtCents)}
          </p>
        </div>
        {singleMonth && (
          <p className="mt-2 max-w-[52ch] text-meta text-ink-tertiary">
            One month of history so far. The line grows as you import more or check back — each
            visit records that day's figure.
          </p>
        )}
      </div>

      <div className="mt-7">
        <SectionLabel>Cash net worth over time</SectionLabel>
        <Card padded={false} className="overflow-hidden">
          <div className="overflow-x-auto p-5 sm:p-6">
            <TrendChart points={trend.points} />
          </div>
        </Card>
      </div>

      <HonestyNotes points={trend.points} />

      <TrendTable points={trend.points} />

      <p className="mt-8 text-center text-meta text-ink-tertiary">
        Read-only. A level and a direction — facts about your own balances, not advice.
      </p>
    </div>
  );
}

function Header() {
  return (
    <div>
      <p className="text-label text-ink-tertiary">Net worth</p>
      <p className="mt-0.5 max-w-[52ch] text-meta text-ink-tertiary">
        Cash net worth — what you have, minus what you owe on cards and loans. Investments are left
        out, since their value moves with the market rather than your transactions.
      </p>
    </div>
  );
}

/**
 * The change over the covered window. Direction is a word and an arrow first;
 * the accent (up) / alert (down) colour is a quiet reinforcement, never the sole
 * signal (D-N9, D-006).
 */
function ChangeBadge({ changeCents, sinceMonth }: { changeCents: number; sinceMonth: string }) {
  const direction = changeCents > 0 ? "up" : changeCents < 0 ? "down" : "steady";
  const color =
    direction === "up"
      ? "var(--accent)"
      : direction === "down"
        ? "var(--alert)"
        : "var(--text-secondary)";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "•";
  const word = direction === "up" ? "Up" : direction === "down" ? "Down" : "Steady";
  const since = `since ${formatMonth(sinceMonth, true)}`;

  return (
    <span className="inline-flex items-center gap-1.5 text-body" style={{ color }}>
      <span aria-hidden="true" className="text-[10px] leading-none">
        {arrow}
      </span>
      <span className="font-medium">
        {word}
        {direction !== "steady" && <> {formatMoney(Math.abs(changeCents))}</>}
      </span>
      <span className="text-ink-tertiary">{since}</span>
    </span>
  );
}

/**
 * The trend line. Recorded segments are solid accent; reconstructed segments are
 * dashed and muted — the visual half of the recorded-vs-inferred honesty. Scale
 * arithmetic (cents → pixels) is presentation, not a financial calculation.
 */
function TrendChart({ points }: { points: NetWorthPoint[] }) {
  const values = points.map((p) => p.netWorthCents);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  // Include zero whenever the line crosses (or nearly reaches) it, so a swing
  // from positive to negative net worth reads honestly rather than being cropped.
  const includeZero = rawMin <= 0 || rawMax <= 0;
  const min = includeZero ? Math.min(rawMin, 0) : rawMin;
  const max = includeZero ? Math.max(rawMax, 0) : rawMax;
  const span = max - min || 1;

  const n = points.length;
  const x = (i: number) => PAD.left + (i / Math.max(n - 1, 1)) * (W - PAD.left - PAD.right);
  const y = (cents: number) => PAD.top + (1 - (cents - min) / span) * (H - PAD.top - PAD.bottom);

  const first = points[0]!;
  const last = points[n - 1]!;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[220px] w-full min-w-[520px]"
      role="img"
      aria-label={`Cash net worth from ${formatMonth(first.month, true)} to ${formatMonth(
        last.month,
        true,
      )}, currently ${formatMoney(last.netWorthCents)}`}
    >
      {/* Zero line, only when the axis includes it. A neutral structural
          reference (`--border-strong`), not the alert red — crossing zero is a
          fact to mark quietly, not an alarm to raise. */}
      {includeZero && (
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
      )}

      {/* One segment per adjacent pair. A segment reads as recorded only when both
          of its endpoints are recorded, so a single recorded point does not turn a
          reconstructed span solid. */}
      {points.slice(1).map((point, i) => {
        const prev = points[i]!;
        const recorded = prev.basis === "recorded" && point.basis === "recorded";
        return (
          <line
            key={point.month}
            x1={x(i)}
            y1={y(prev.netWorthCents)}
            x2={x(i + 1)}
            y2={y(point.netWorthCents)}
            stroke={recorded ? "var(--accent)" : "var(--text-tertiary)"}
            strokeWidth={recorded ? 2.25 : 1.5}
            strokeDasharray={recorded ? undefined : "5 4"}
            strokeLinecap="round"
          />
        );
      })}

      {/* Point markers: recorded points are filled (measured); reconstructed points
          are hollow (inferred). */}
      {points.map((point, i) => {
        const recorded = point.basis === "recorded";
        return (
          <circle
            key={point.month}
            cx={x(i)}
            cy={y(point.netWorthCents)}
            r={recorded ? 3.5 : 2.5}
            fill={recorded ? "var(--accent)" : "var(--surface-raised)"}
            stroke={recorded ? "var(--accent)" : "var(--text-tertiary)"}
            strokeWidth={recorded ? 0 : 1.25}
          />
        );
      })}

      {/* Y-axis: the high and low of the window. */}
      <text x={PAD.left - 8} y={y(max) + 4} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
        {formatMoney(max)}
      </text>
      <text x={PAD.left - 8} y={y(min) + 4} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
        {formatMoney(min)}
      </text>

      {/* X-axis: the first and last covered month. */}
      <text x={PAD.left} y={H - 8} fontSize="11" fill="var(--text-tertiary)">
        {formatMonth(first.month, true)}
      </text>
      <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
        {formatMonth(last.month, true)}
      </text>
    </svg>
  );
}

/** Plain-language honesty for the two kinds of point, shown only when each kind
 *  is actually present. Mirrors the chart's solid/dashed treatment (D-N6). */
function HonestyNotes({ points }: { points: NetWorthPoint[] }) {
  const hasRecorded = points.some((p) => p.basis === "recorded");
  const hasReconstructed = points.some((p) => p.basis === "reconstructed");

  return (
    <ul className="mt-4 space-y-2">
      {hasRecorded && (
        <li className="flex items-start gap-2.5 text-meta text-ink-secondary">
          <svg width="20" height="10" aria-hidden="true" className="mt-1 shrink-0">
            <line x1="1" y1="5" x2="19" y2="5" stroke="var(--accent)" strokeWidth={2.25} strokeLinecap="round" />
            <circle cx="10" cy="5" r="3.5" fill="var(--accent)" />
          </svg>
          <span>
            <span className="text-ink">Recorded</span> — measured from your real balances the day you
            viewed this. These points are exact.
          </span>
        </li>
      )}
      {hasReconstructed && (
        <li className="flex items-start gap-2.5 text-meta text-ink-secondary">
          <svg width="20" height="10" aria-hidden="true" className="mt-1 shrink-0">
            <line x1="1" y1="5" x2="19" y2="5" stroke="var(--text-tertiary)" strokeWidth={1.5} strokeDasharray="5 4" />
            <circle cx="10" cy="5" r="2.5" fill="var(--surface-raised)" stroke="var(--text-tertiary)" strokeWidth={1.25} />
          </svg>
          <span>
            <span className="text-ink">Reconstructed</span> — worked backward from your transactions.
            Close, but it can drift where a balance changed without one (loan interest, a manual
            edit).
          </span>
        </li>
      )}
    </ul>
  );
}

/** The chart's data as a table, for assistive technology and anyone who wants
 *  the exact figures behind the line. */
function TrendTable({ points }: { points: NetWorthPoint[] }) {
  return (
    <details className="mt-5">
      <summary className="min-h-[44px] cursor-pointer text-label text-ink-secondary">
        View as table
      </summary>
      <table className="mt-2 w-full text-meta">
        <thead>
          <tr className="text-left text-ink-secondary">
            <th className="py-1 pr-4 font-medium">Month</th>
            <th className="py-1 pr-4 font-medium">Net worth</th>
            <th className="py-1 pr-4 font-medium">Cash</th>
            <th className="py-1 pr-4 font-medium">Owed</th>
            <th className="py-1 font-medium">Basis</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {points.map((point) => (
            <tr key={point.month} className="border-t border-line-subtle">
              <td className="py-1 pr-4">{formatMonth(point.month, true)}</td>
              <td className="py-1 pr-4">{formatMoney(point.netWorthCents)}</td>
              <td className="py-1 pr-4">{formatMoney(point.cashCents)}</td>
              <td className="py-1 pr-4">{formatMoney(point.debtCents)}</td>
              <td className="py-1 text-ink-tertiary">
                {point.basis === "recorded" ? "Recorded" : "Reconstructed"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** "Mar" or "Mar 2022" from a `YYYY-MM` key. Parsed as UTC so the month never
 *  shifts by locale. Formatting only — no arithmetic on a backend figure. */
function formatMonth(month: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}
