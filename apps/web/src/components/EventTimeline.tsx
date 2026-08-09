/**
 * EventTimeline — renders `forecast.events` chronologically.
 * Backend-provided order and values; no re-sorting by amount, no totals.
 */
import type { AffordabilityResponse } from "@ai-fin-os/core";
import { Money, DateDisplay, Card } from "./primitives";
import { UI_COPY } from "../copy";

export function EventTimeline({ response }: { response: AffordabilityResponse }) {
  // Only the all-events path is shown, so the timeline matches what a user
  // would actually experience. Path filtering is display selection, not
  // calculation.
  const events = response.forecast.events.filter((e) => e.path !== "expected_reference");
  if (events.length === 0) return null;

  return (
    <Card title={UI_COPY.timelineTitle}>
      <ul className="divide-y divide-line-subtle">
        {events.map((event) => (
          <li key={event.id} className="flex items-baseline justify-between gap-4 py-2">
            <span className="flex items-baseline gap-3">
              <span className="w-16 shrink-0 text-meta text-ink-tertiary">
                <DateDisplay iso={event.date} reference={response.asOfDate} />
              </span>
              <span className="text-body">{event.label}</span>
              {event.sourceType === "planned_purchase" && (
                <span className="rounded-sm bg-surface-sunken px-1.5 py-0.5 text-meta text-ink-secondary">
                  This purchase
                </span>
              )}
            </span>
            <Money
              cents={event.amountCents}
              className={event.amountCents > 0 ? "text-ink" : "text-ink-secondary"}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
