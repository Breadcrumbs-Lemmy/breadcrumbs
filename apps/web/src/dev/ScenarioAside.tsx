/**
 * Development-only scenario switcher.
 *
 * This module — and the backend fixtures it pulls in — must never reach a
 * production bundle. It is loaded exclusively through a `React.lazy` dynamic
 * import that App.tsx gates behind `import.meta.env.DEV`, so Rollup drops the
 * whole chunk (this file plus the six `packages/core/fixtures` JSON files it
 * transitively imports) from a production build. Keeping the `SCENARIOS` import
 * here rather than in App.tsx is what makes that elimination possible: a static
 * import in the always-live app module would pin the fake-money fixtures into
 * production, beside a user's real accounts.
 */
import type { AffordabilityRequest } from "@ai-fin-os/core";

import { SCENARIOS, type ScenarioKey } from "../fixtures/scenarios";

/** One pill per fixture scenario. Clicking builds that scenario's request and
 *  hands it up; App.tsx runs it through the real affordability engine. */
export default function ScenarioAside({ onPick }: { onPick: (request: AffordabilityRequest) => void }) {
  return (
    <div>
      <p className="mb-2 text-meta uppercase tracking-[0.06em] text-ink-tertiary">Scenarios</p>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(SCENARIOS[key].build())}
            className="min-h-[26px] rounded-pill border border-line-subtle px-2 text-meta text-ink-tertiary hover:border-line-strong hover:text-ink-secondary"
          >
            {SCENARIOS[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}
