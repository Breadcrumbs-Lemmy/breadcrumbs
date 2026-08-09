/**
 * ForecastChart — docs/ui-design-system.md "Forecast Chart".
 *
 * Plots `forecast.dailyBalances` exactly as provided. No smoothing, no
 * interpolation, no trend fitting, no aggregation to weeks. Scale arithmetic
 * (mapping cents to pixels) is presentation, not financial calculation.
 *
 * Never rendered for UNKNOWN: charting data the engine rejected would assert
 * precision the engine refused to assert.
 */
import type { AffordabilityResponse } from "@ai-fin-os/core";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";
import { UI_COPY } from "../copy";

const W = 720;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

export function ForecastChart({
  response,
  bufferCents,
}: {
  response: AffordabilityResponse;
  bufferCents: number;
}) {
  const days = response.forecast.dailyBalances;
  if (days.length === 0) return null;

  const series = [
    { key: "requiredPathBalanceCents", color: "var(--data-required)", width: 2, dash: undefined, label: UI_COPY.legend.required },
    { key: "protectedPathBalanceCents", color: "var(--data-protected)", width: 1.5, dash: undefined, label: UI_COPY.legend.protected },
    { key: "allEventsPathBalanceCents", color: "var(--data-all-events)", width: 1.5, dash: undefined, label: UI_COPY.legend.allEvents },
    { key: "expectedReferencePathBalanceCents", color: "var(--data-expected)", width: 1.5, dash: "5 4", label: UI_COPY.legend.expected },
  ] as const;

  const values: number[] = [];
  for (const day of days) {
    for (const s of series) {
      const v = day[s.key];
      if (typeof v === "number") values.push(v);
    }
  }
  values.push(bufferCents);

  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);

  // The axis includes zero whenever any path comes within the buffer of it.
  // Truncating the axis to exaggerate a dip would misrepresent risk.
  const includeZero = rawMin <= bufferCents;
  const min = Math.min(rawMin, includeZero ? 0 : rawMin);
  const max = Math.max(rawMax, 0);
  const span = max - min || 1;

  const x = (i: number) => PAD.left + (i / Math.max(days.length - 1, 1)) * (W - PAD.left - PAD.right);
  const y = (cents: number) => PAD.top + (1 - (cents - min) / span) * (H - PAD.top - PAD.bottom);

  const path = (key: (typeof series)[number]["key"]) => {
    const points: string[] = [];
    days.forEach((day, i) => {
      const v = day[key];
      if (typeof v !== "number") return;
      points.push(`${points.length === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    return points.join(" ");
  };

  const minPoint = days.findIndex(
    (d) => d.requiredPathBalanceCents === response.metrics.requiredPath.minimumBalanceCents,
  );

  return (
    <figure data-level={response.level} className="m-0">
      <figcaption className="mb-3 text-heading">{UI_COPY.chartTitle}</figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-[260px] w-full min-w-[560px]"
          role="img"
          aria-label={`Projected daily cash from ${formatDate(response.horizonStartDate)} to ${formatDate(response.horizonEndDate)}`}
        >
          {/* Zero line, only when a path approaches it. */}
          {includeZero && (
            <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--data-zero)" strokeWidth={1} />
          )}

          {/* Buffer threshold. */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(bufferCents)}
            y2={y(bufferCents)}
            stroke="var(--data-buffer)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <text x={PAD.left} y={y(bufferCents) - 6} fill="var(--data-buffer)" fontSize="11">
            Your {formatMoney(bufferCents)} buffer
          </text>

          {series.map((s) => {
            const d = path(s.key);
            if (!d) return null;
            return (
              <path
                key={s.key}
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeDasharray={s.dash}
                strokeLinejoin="round"
              />
            );
          })}

          {/* Minimum balance annotation on the decision path. */}
          {minPoint >= 0 && (
            <circle
              cx={x(minPoint)}
              cy={y(response.metrics.requiredPath.minimumBalanceCents)}
              r={4}
              fill="var(--surface-raised)"
              stroke="var(--data-required)"
              strokeWidth={2}
            />
          )}

          {/* Axis labels. */}
          <text x={PAD.left - 8} y={y(max)} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
            {formatMoney(max)}
          </text>
          <text x={PAD.left - 8} y={y(min)} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
            {formatMoney(min)}
          </text>
          <text x={PAD.left} y={H - 8} fontSize="11" fill="var(--text-tertiary)">
            {formatDate(days[0]!.date, response.asOfDate)}
          </text>
          <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize="11" fill="var(--text-tertiary)">
            {formatDate(days[days.length - 1]!.date, response.asOfDate)}
          </text>
        </svg>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-meta text-ink-secondary">
            <svg width="18" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="18" y2="4" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>

      {/* Table equivalent for assistive technology and keyboard users. */}
      <details className="mt-4">
        <summary className="min-h-[44px] cursor-pointer text-label text-ink-secondary">
          View as table
        </summary>
        <table className="mt-2 w-full text-meta">
          <thead>
            <tr className="text-left text-ink-secondary">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">{UI_COPY.legend.required}</th>
              <th className="py-1 pr-4 font-medium">{UI_COPY.legend.protected}</th>
              <th className="py-1 font-medium">{UI_COPY.legend.allEvents}</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {days.map((day) => (
              <tr key={day.date} className="border-t border-line-subtle">
                <td className="py-1 pr-4">{formatDate(day.date, response.asOfDate)}</td>
                <td className="py-1 pr-4">{formatMoney(day.requiredPathBalanceCents)}</td>
                <td className="py-1 pr-4">{formatMoney(day.protectedPathBalanceCents)}</td>
                <td className="py-1">{formatMoney(day.allEventsPathBalanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
