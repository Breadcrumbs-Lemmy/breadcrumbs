# UI Design System

Status: Living  
Owner: `[UI: Claude]`  
Last updated: 2026-08-03

## Purpose

This document defines the visual and interaction foundation for the AI Finance Operating System interface. It covers design tokens, the affordability result visual language, how certainty and uncertainty are distinguished, the component inventory, and how product boundaries appear in the interface.

It does not define screen layouts. Those are in `ui-mvp0-screens.md`. It does not define wording. That is in `ui-copy-map.md`.

## Design Principles

These translate the charter principles in `product-charter.md` into interface rules.

### 1. One screen, one number

Every screen has a single job and a single dominant figure. On the spending home that figure is money out, shown against money in. On an affordability result it is the verdict. Everything else on the screen is supporting evidence arranged beneath, and nothing may compete with it for primary attention.

This principle was learned the hard way. The first affordability result screen presented a verdict, three reasons, an assumptions panel, a boundary notice, a forecast chart, an event timeline, and a metrics grid simultaneously, with no size relationship between them. It was rejected on sight, correctly: there was nowhere for the eye to land. The failure was not decoration, it was the absence of hierarchy.

The practical test: if you cannot say in one sentence what a screen is for, and point at the one element that answers it, the screen is not finished.

> Amended 2026-08-04 for `D-011`. This principle previously read "the answer is
> the interface" and named the affordability result as the product's dominant
> element. Affordability is now a supporting capability; the spending home is
> the product's primary surface. The underlying rule about hierarchy is
> unchanged and applies to both.

### 2. Confidence must be visually honest

An interface can imply precision that the underlying data does not support. A crisp number in a bold typeface reads as a fact. The same number rendered from a stale balance is a guess. These must not look identical.

Every displayed figure carries an implicit confidence level, and the interface encodes it. See `Uncertainty Treatment`.

### 3. Explanations are primary, not progressive disclosure

The charter requires a user to see why an answer was produced. Reasons and assumptions are not hidden behind a "details" toggle. The primary reason is always visible alongside the result. Secondary reasons and full assumptions may collapse, but the collapse must show a count so nothing feels concealed.

### 4. Neutral by default, urgent only when warranted

`RISKY` is the only state permitted to use alarm styling, and even then it describes a cash-flow outcome, not a judgment of the user. Red is reserved exclusively for `RISKY` and for critical freshness failures. It is never used for spending amounts, categories, or merchants, because a red grocery total implies a verdict the product does not make.

### 5. Read-only is a visible property

The absence of transfer, pay, and edit affordances is a feature. The interface states its boundaries in place rather than in a footer nobody reads.

## Design Tokens

Tokens are defined independently of Tailwind so the system survives a styling change. Implementation maps them to CSS custom properties, which Tailwind then references.

### Color: Foundation

Neutral scale carries the interface. It is warm-shifted rather than pure gray, because a cold neutral reads clinical and this product handles anxious subject matter.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--surface-base` | `#FBFAF9` | `#141413` | Page background |
| `--surface-raised` | `#FFFFFF` | `#1E1E1C` | Cards, panels |
| `--surface-sunken` | `#F2F0ED` | `#0F0F0E` | Inset areas, table headers |
| `--border-subtle` | `#E5E1DC` | `#2E2E2B` | Dividers, card edges |
| `--border-strong` | `#CBC5BD` | `#43433F` | Input borders, focus rings |
| `--text-primary` | `#1A1917` | `#F5F3F0` | Headings, figures |
| `--text-secondary` | `#5C574F` | `#A8A29A` | Labels, supporting text |
| `--text-tertiary` | `#8A837A` | `#78726A` | Timestamps, metadata |

### Color: Affordability Levels

Each level owns a hue, a surface tint, a border, and a text color. The hue is never reused for anything else in the interface.

| Level | Hue | `--level-*-fg` | `--level-*-bg` | `--level-*-border` |
| --- | --- | --- | --- | --- |
| `AFFORDABLE` | Green | `#1F6B45` | `#EDF7F1` | `#B8DFC9` |
| `TIGHT` | Amber | `#8A5A0B` | `#FDF5E7` | `#F0D9A8` |
| `RISKY` | Red | `#9B2C2C` | `#FCF0EF` | `#EFC4C0` |
| `UNKNOWN` | Slate | `#4A5568` | `#F4F5F7` | `#D3D8DF` |

Dark mode inverts to a low-chroma tinted surface with a lightened foreground; exact values are set at implementation, holding contrast ratios below.

Contrast requirement: every `--level-*-fg` on its `--level-*-bg` meets WCAG AA at 4.5:1 for body text and 3:1 for large text. `UNKNOWN` slate is deliberately the lowest-chroma pairing so it reads as absence of a verdict rather than as a fifth verdict.

### Color: Semantic Non-Verdict

Kept separate from level colors so a chart line or an info badge never reads as an affordability verdict.

| Token | Value | Use |
| --- | --- | --- |
| `--accent-primary` | `#2A6F97` | Interactive elements, links, focus |
| `--data-required` | `#2A6F97` | Required forecast path |
| `--data-protected` | `#6B4E9E` | Protected forecast path |
| `--data-all-events` | `#8A837A` | All-events forecast path |
| `--data-expected` | `#B8B1A8` | Expected-reference path, always dashed |
| `--data-buffer` | `#8A5A0B` | Cash buffer threshold line |
| `--data-zero` | `#9B2C2C` | Zero line on forecast chart |

### Typography

Two families. A humanist sans for interface text, and a tabular-figure family for money and dates.

| Token | Value |
| --- | --- |
| `--font-sans` | `Inter, ui-sans-serif, system-ui, sans-serif` |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, monospace` |

Money and dates always use `font-variant-numeric: tabular-nums`. Columns of figures must align on the decimal. A balance that shifts horizontally as it updates undermines trust in the number.

| Token | Size / Line height | Weight | Use |
| --- | --- | --- | --- |
| `--type-verdict` | 44 / 48 | 600 | The affordability result word |
| `--type-figure-lg` | 32 / 36 | 600 | Primary money figure |
| `--type-figure-md` | 22 / 28 | 550 | Secondary money figures |
| `--type-heading` | 18 / 26 | 600 | Section headings |
| `--type-body` | 15 / 24 | 400 | Reasons, explanations |
| `--type-label` | 13 / 18 | 500 | Field labels, axis labels |
| `--type-meta` | 12 / 16 | 400 | Timestamps, source attributions |

Body text sets at 15px rather than 14px. This product asks users to read explanations carefully, and explanation text is not fine print.

### Spacing, Radius, Elevation

Spacing scale is a 4px base: `4, 8, 12, 16, 24, 32, 48, 64`.

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `6px` | Badges, chips |
| `--radius-md` | `10px` | Cards, inputs |
| `--radius-lg` | `16px` | The verdict panel |
| `--shadow-card` | `0 1px 2px rgba(26,25,23,0.06)` | Resting cards |
| `--shadow-raised` | `0 4px 12px rgba(26,25,23,0.08)` | Popovers, the assumptions panel |

Elevation is used sparingly. A flat interface with clear borders reads as more trustworthy for financial data than a heavily shadowed one.

## Affordability Visual Language

The four levels must be distinguishable instantly, and distinguishable without color. Each level is encoded three ways simultaneously: color, glyph shape, and verdict word. This satisfies the accessibility requirement and also survives grayscale printing and screenshots.

| Level | Glyph | Shape rationale | Border treatment |
| --- | --- | --- | --- |
| `AFFORDABLE` | Circle with check | Closed, complete, resolved | Solid, 1px |
| `TIGHT` | Circle with horizontal bar | Closed but constrained; a narrowing | Solid, 2px |
| `RISKY` | Triangle with exclamation | Angular, directional, demands attention | Solid, 2px |
| `UNKNOWN` | Circle with question | Open, unresolved, awaiting input | **Dashed, 2px** |

The dashed border on `UNKNOWN` is the single most important token in this system. `UNKNOWN` is not a bad result, it is the absence of a result, and dashing is how the interface says "this is incomplete" everywhere it appears. The same dashed treatment applies to any figure the engine could not determine.

### The Verdict Panel

The verdict panel is the primary element of the affordability screen.

```
┌──────────────────────────────────────────────────┐
│  ●  TIGHT                                        │   <- glyph + --type-verdict
│                                                  │
│  Buying this leaves $118 above $0 on Aug 14,     │   <- headline, --type-body
│  which is below your $250 buffer.                │      UI-composed (CD-006)
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Lowest projected cash    $118  Aug 14      │  │   <- primary metric row
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ▸ 2 more reasons    ▸ 3 assumptions             │   <- collapsed, with counts
└──────────────────────────────────────────────────┘
```

Rules:

- The verdict word is never rendered without its glyph.
- The headline sits directly under the verdict with no intervening element.
- The primary reason is always expanded. Additional reasons collapse behind a count.
- The panel uses `--level-*-bg` as its surface and `--level-*-border` as its edge. It does not use a saturated fill, because a full-bleed red or green panel reads as a moral verdict rather than a cash-flow statement.

### What the levels must never do

- No progress bars, gauges, or "financial health scores." The product answers a question; it does not grade the user.
- No emoji or facial iconography.
- No animation on level transition beyond a 120ms opacity fade. A number that counts up or a panel that bounces trivializes the content.

## Uncertainty Treatment

Distinguishing computed facts from estimates is a charter requirement. Three levels of certainty, three visual treatments.

| Certainty | Source | Treatment |
| --- | --- | --- |
| **Computed** | Backend calculated from complete, fresh data | Solid text, `--text-primary`, no adornment |
| **Estimated** | `Uncertainty.isEstimated = true`, or freshness `estimated` / `usable` | `--text-secondary`, preceded by a `~` prefix, dotted underline on hover revealing method |
| **Unavailable** | Missing, stale, or `UNKNOWN` | Em-dash placeholder in a dashed-border container, never a `$0.00` |

The third rule is non-negotiable. Rendering an unknown balance as `$0.00` is a correctness bug, not a styling choice, and would let the interface assert something the engine explicitly refused to assert.

### Freshness Indicator

Every surface displaying account-derived figures carries a freshness indicator anchored to `Freshness.status`.

| Status | Dot | Label |
| --- | --- | --- |
| `fresh` | Solid `--data-required` | Relative time, `--type-meta` |
| `usable` | Solid `--text-tertiary` | Relative time |
| `stale` | Ring, amber | Relative time + warning affordance |
| `missing` | Dashed ring | "Not available" |
| `estimated` | Hollow dot | "Estimated" |

Severity mapping for `FreshnessWarning`: `info` renders inline as metadata, `warning` renders as a dismissible-but-persistent banner within the affected card, `critical` renders as a blocking state that replaces the figure entirely.

## Forecast Chart

The chart visualizes `forecast.dailyBalances` over the 30-day horizon. It presents backend-computed values only and performs no smoothing, interpolation, or trend fitting.

Encoding:

- Required path: solid, 2px, `--data-required`. The decision path, most prominent.
- Protected path: solid, 1.5px, `--data-protected`.
- All-events path: solid, 1.5px, `--data-all-events`.
- Expected-reference path: **dashed**, 1.5px, `--data-expected`. Dashed because it is explanatory and by contract cannot rescue the decision.
- Cash buffer: horizontal dashed rule, `--data-buffer`, labeled with the amount.
- Zero: horizontal solid rule, `--data-zero`, only rendered when a path approaches or crosses it.
- Purchase date: vertical marker with the purchase label.
- Minimum balance point: annotated dot on the required path at `minimumIntradayBalanceDate`.

Rules:

- The y-axis includes zero whenever any path comes within the buffer amount of it. Truncating the axis to exaggerate a dip would misrepresent risk.
- Area fill below the buffer line uses a 6% tint of the active level color, not a saturated fill.
- Day granularity is preserved; the chart never aggregates to weeks.
- Values come from `dailyBalances` as provided. The UI does not compute intermediate points.

## Component Inventory

Components owned by the UI layer for MVP 0.

**Result and explanation**

- `VerdictPanel` — level glyph, verdict word, headline, primary metric
- `ReasonList` — primary reason expanded, remainder collapsed with count
- `ReasonItem` — severity glyph, composed copy, related entity chips
- `AssumptionsPanel` — grouped assumptions, always reachable in one interaction
- `FreshnessBanner` — severity-mapped warning surface
- `BoundaryNotice` — product boundary statement

**Financial display**

- `Money` — formats minor units, tabular figures, handles estimated and unavailable states
- `DateDisplay` — ISO to human, timezone-aware, relative and absolute variants
- `MetricRow` — label, value, optional comparison to buffer
- `FreshnessDot` — status indicator
- `ForecastChart` — multi-path daily balance chart
- `EventTimeline` — `forecast.events` as a chronological list
- `SpendingSummary` — monthly category and merchant breakdown

**Input and structure**

- `PurchaseForm` — amount, date, category, necessity, deferrable
- `SnapshotSummary` — accounts, income, obligations, goals under evaluation
- `EmptyState` / `IncompleteState` — missing-input surfaces
- `AppShell` — navigation and persistent boundary notice

## Product Boundary Treatment

`explanation.boundaries` returns up to four `ProductBoundary` values. Each maps to a placement, not merely to text. Per `CD-006`, the UI composes the wording; see `ui-copy-map.md`.

| Boundary | Placement |
| --- | --- |
| `READ_ONLY_DECISION_SUPPORT` | Persistent, low-emphasis, in `AppShell` |
| `NOT_PERSONALIZED_FINANCIAL_ADVICE` | Footer of every verdict panel |
| `NO_ACCOUNT_WRITES` | Adjacent to any account listing |
| `DETERMINISTIC_CALCULATION` | Within the assumptions panel |

The interface must contain no control that suggests money movement. No "Pay now," no "Transfer," no "Buy," no disabled-but-present versions of those controls. A disabled Transfer button still communicates that transfers are a product capability.

The primary action on the affordability screen is `Check affordability`. Never `Approve`, `Confirm purchase`, or `Buy`.

## Accessibility

- All text meets WCAG AA. Verdict text at `--type-verdict` meets AA Large at minimum, AA where achievable.
- Level is never communicated by color alone; glyph and word always accompany it.
- The verdict panel is an `aria-live="polite"` region so screen readers announce a result change.
- Focus order follows visual order: verdict, headline, primary reason, remaining reasons, assumptions, chart.
- The forecast chart has a table equivalent exposing the same `dailyBalances`, reachable by keyboard and not hidden from assistive technology.
- Chart series are distinguishable without color through the solid and dashed weight system above.
- Minimum touch target 44×44px.
- `prefers-reduced-motion` disables the level transition fade.

## Implementation Status

Implemented in `apps/web`. Tokens live in `src/styles/tokens.css` as CSS custom properties; `tailwind.config.js` references them rather than defining them, so the token layer survives a change of styling library.

Level colours resolve through a scoped `[data-level]` attribute that sets `--level-fg`, `--level-bg`, and `--level-border`. Components never branch on level to pick a colour — they set `data-level` once and use the variables. Adding a fifth level would mean one CSS block, not a change in every component.

Built: `Money`, `MoneyOrPlaceholder`, `DateDisplay`, `LevelGlyph`, `FreshnessDot`, `MetricRow`, `Card`, `VerdictPanel`, `ReasonList`, `AssumptionsPanel`, `FreshnessBanner`, `ForecastChart`, `EventTimeline`.

Not yet built: `PurchaseForm`, `SnapshotSummary`, `SpendingSummary`, `EmptyState`, `IncompleteState`, `AppShell` navigation.

Backend dependencies for the affordability surfaces are resolved: `H-004`, `H-005`, `H-006`, and `H-008` are all accepted, and `src/types/core.ts` has been deleted now that every contract type is exported directly.

Open items affecting this system:

| Item | Handoff | Effect |
| --- | --- | --- |
| Category display labels | `H-015` | Identifiers arrive as raw keys (`coffee_snacks`, `cloud_storage`). UI holds a stopgap label map; may move to `S-004`. |
| UI runtime coverage for 4 reason codes | `H-010` | Backend fixtures now exist; UI verification still needs to consume them when UI work resumes |

Tokens and treatments added for the spending home — the equal-weight in/out hero, the dashed container for unresolvable movement, and the negative-category rule — are specified in `ui-spending-home.md` and reuse the tokens defined here without introducing new ones.
