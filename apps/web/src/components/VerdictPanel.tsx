/**
 * VerdictPanel + ReasonList + AssumptionsPanel — docs/ui-mvp0-screens.md Screen 3.
 *
 * Displays backend results. Computes nothing.
 */
import { useState } from "react";
import type { AffordabilityResponse, DecisionReason } from "@ai-fin-os/core";
import { LevelGlyph, MetricRow } from "./primitives";
import { TrailDivider } from "./ui";
import { reasonCopy, type ReasonContext } from "../copy/reasons";
import { ASSUMPTION_COPY, BOUNDARY_COPY, LEVEL_WORD, UI_COPY } from "../copy";
import { headlineFor } from "../copy/headline";

type Props = {
  response: AffordabilityResponse;
  bufferCents: number;
  labelFor: (entityId: string) => string;
  onResolve?: (target: "accounts" | "purchase" | "obligations") => void;
};

export function VerdictPanel({ response, bufferCents, labelFor, onResolve }: Props) {
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false);

  const { level, explanation } = response;
  const isUnknown = level === "UNKNOWN";

  const context: ReasonContext = {
    labelFor,
    relatedEntityIds: [],
    referenceDate: response.asOfDate,
    horizonEndDate: response.horizonEndDate,
  };

  // reasons[] order is guaranteed by the backend; the first entry is the
  // determining reason. UI does not implement its own precedence logic.
  const [primary, ...rest] = explanation.reasons;

  return (
    <div
      data-level={level}
      className={`rounded-lg border-2 bg-level-bg p-6 ${
        isUnknown ? "border-dashed border-level-border" : "border-level-border"
      }`}
    >
      <div aria-live="polite" className="flex items-center gap-3">
        <LevelGlyph level={level} size={32} />
        <h1 className="font-display text-hero text-level-fg">{LEVEL_WORD[level]}</h1>
      </div>

      <p className="mt-3 max-w-prose text-body text-ink">
        {headlineFor(response, bufferCents)}
      </p>

      <TrailDivider className="mt-5" />

      {!isUnknown && (
        <div className="mt-5 rounded-lg border border-line-subtle bg-surface-raised px-4 py-2">
          <MetricRow
            label="Lowest projected cash"
            value={response.metrics.requiredPath.minimumIntradayBalanceCents}
            date={response.metrics.requiredPath.minimumIntradayBalanceDate}
            reference={response.asOfDate}
          />
          <MetricRow label="Your buffer" value={bufferCents} />
        </div>
      )}

      {primary && (
        <div className="mt-5">
          <ReasonBody reason={primary} context={context} onResolve={onResolve} />
        </div>
      )}

      {/* UNKNOWN shows every resolution path at once rather than collapsing
          them, because each one is an action the user needs to take. */}
      {isUnknown
        ? rest.map((reason) => (
            <div key={reason.code} className="mt-4">
              <ReasonBody reason={reason} context={context} onResolve={onResolve} />
            </div>
          ))
        : rest.length > 0 && (
            <div className="mt-4">
              <Disclosure
                open={showAllReasons}
                onToggle={() => setShowAllReasons((v) => !v)}
                label={UI_COPY.moreReasons(rest.length)}
              />
              {showAllReasons && (
                <ul className="mt-3 space-y-2 border-l-2 border-line-subtle pl-4">
                  {rest.map((reason) => (
                    <li key={reason.code} className="text-body text-ink-secondary">
                      {reasonCopy(reason, context).primary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

      {/* CD-007: reserved for later deferral/shortfall guidance. Renders
          nothing in MVP 0 and must not be filled by UI inference. */}

      {explanation.assumptions.length > 0 && (
        <div className="mt-3">
          <Disclosure
            open={showAssumptions}
            onToggle={() => setShowAssumptions((v) => !v)}
            label={UI_COPY.assumptionsCount(explanation.assumptions.length)}
          />
          {showAssumptions && (
            <div className="mt-3 rounded-lg border border-line-subtle bg-surface-raised p-4">
              <ul className="space-y-2">
                {explanation.assumptions.map((assumption) => (
                  <li key={assumption.code} className="text-body text-ink-secondary">
                    {ASSUMPTION_COPY[assumption.code]}
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-line-subtle pt-3 text-meta text-ink-tertiary">
                {BOUNDARY_COPY.DETERMINISTIC_CALCULATION}
              </p>
            </div>
          )}
        </div>
      )}

      {explanation.boundaries.includes("NOT_PERSONALIZED_FINANCIAL_ADVICE") && (
        <p className="mt-5 border-t border-level-border pt-4 text-meta text-ink-tertiary">
          {BOUNDARY_COPY.NOT_PERSONALIZED_FINANCIAL_ADVICE}
        </p>
      )}
    </div>
  );
}

function ReasonBody({
  reason,
  context,
  onResolve,
}: {
  reason: DecisionReason;
  context: ReasonContext;
  onResolve?: (target: "accounts" | "purchase" | "obligations") => void;
}) {
  const copy = reasonCopy(reason, context);
  return (
    <div>
      <p className="max-w-prose text-body text-ink">{copy.primary}</p>
      {copy.resolution && (
        <button
          type="button"
          onClick={() => onResolve?.(copy.resolution!.target)}
          className="mt-1.5 min-h-[44px] text-body text-accent underline underline-offset-4"
        >
          {copy.resolution.label}
        </button>
      )}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex min-h-[44px] items-center gap-2 text-label text-ink-secondary"
    >
      <span aria-hidden="true" className="inline-block w-3">
        {open ? "▾" : "▸"}
      </span>
      {label}
    </button>
  );
}
