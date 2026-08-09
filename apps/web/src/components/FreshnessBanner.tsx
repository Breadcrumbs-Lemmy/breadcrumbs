/**
 * FreshnessBanner — severity-mapped warning surface.
 * docs/ui-design-system.md "Freshness Indicator".
 */
import type { FreshnessWarning } from "@ai-fin-os/core";
import { FRESHNESS_COPY } from "../copy";

export function FreshnessBanner({ warnings }: { warnings: FreshnessWarning[] }) {
  // `info` renders inline as metadata elsewhere, not as a banner.
  const shown = warnings.filter((w) => w.severity !== "info");
  if (shown.length === 0) return null;

  return (
    <div className="space-y-2">
      {shown.map((warning) => (
        <div
          key={warning.code}
          role={warning.severity === "critical" ? "alert" : "status"}
          className={`flex items-start gap-2.5 rounded-md border px-4 py-2.5 text-body ${
            warning.severity === "critical"
              ? "border-line-strong bg-surface-sunken text-ink"
              : "border-line-subtle bg-surface-sunken text-ink-secondary"
          }`}
        >
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-data-buffer">
            ⚠
          </span>
          <span>{FRESHNESS_COPY[warning.code]}</span>
        </div>
      ))}
    </div>
  );
}
