# Monthly Report (export)

Status: Draft (autonomous session 2026-08-14) — **design decisions D-R1..D-R10 below await the
owner's re-approval.** Nothing here is settled; each decision is logged so it can be confirmed or
changed on return.

Feature #5 from `coordination/FEATURE-IDEAS.md`. A deterministic, shareable **"where did my money
go" report** for a single month — a printable summary plus a CSV data export. Read-only, no new
math: it is a *composition* of the two engines that already answer the question on screen.

## What it is, and what it is not

It is a **composition of the spending summary and the insights that already exist**. For one month
it lays out `summarizeSpending` (month totals + per-category breakdown, with `netCents` and
`shareBasisPoints` already backend-computed) next to `detectInsights` (the narrative copy and the
recurring-commitments list). Nothing on the report is calculated a second way.

It is **not** a new money classifier, a new store, or a new source of truth. It introduces no
persisted state and no new financial arithmetic. It never moves money and never tells the user what
they *should* do with it — it reports what the month's cash flow was and stops there (charter:
read-only decision support, not personalized advice, `D-002`, `D-006`).

Two export shapes come out of the one report:

1. **A printable page** — the in-app screen, styled for print, so the user saves a PDF through the
   browser's own Print dialog. No PDF engine ships with the app.
2. **A CSV** — a clean, single-table spreadsheet export of the per-category breakdown, generated
   from the same report the page renders.

## The one question it answers

**"Where did my money go last month?"** — a single month's total spent, net (inflow − outflow), the
per-category breakdown sorted largest-first with each category's share of the month, and the
plain-word insights already surfaced on the Insights screen, all on one shareable page.

## Design decisions (await re-approval)

### D-R1 — Composition, not computation
The report performs **zero new financial arithmetic.** `buildMonthlyReport` calls `summarizeSpending`
and `detectInsights` for one month and returns both, unaltered. Rationale: single source of truth
(`CD-003`). Every figure on the report is a figure the Spending or Insights screen would show for the
same month; a second math path would inevitably drift from them and the report would quietly
contradict the app it summarises.

### D-R2 — Default month is the latest **complete** calendar month
With no `key`, the report covers the latest **complete** month relative to `asOfDate` — i.e. the
previous month while the current one is still partial, and the current month only on its final day.
An explicit `key` (`YYYY-MM`) overrides to any month. Rationale: a "where did my money go" report is
retrospective; defaulting to a month that is only a few days old would understate every total and
read as a false "you barely spent anything". The Spending *screen* defaults to the current (partial)
period because it is a live dashboard; the report is a closed-book document, so it defaults one step
back to the last whole month.

### D-R3 — The anchor is the latest posted date, never the wall clock
"Now" for the report is `asOfDate` = the latest posted transaction date, exactly as every other
endpoint derives it. Rationale: determinism (`CD-011`) — the same imported history must always
produce the same report and the same CSV bytes, or the tests are not reproducible and two exports of
"the same month" could differ. Consequence the UI states honestly: the report is captioned with the
month it covers and the as-of date, so a user whose newest transaction is three weeks old sees which
month "latest complete" resolved to.

### D-R4 — Read-only, factual, and it reuses the on-screen words verbatim
The report is a **factual observation of the user's own cash flow** — totals, category shares, and
the insight copy already shown in-app. It never prescribes a budget, never ranks a month "good" or
"bad", and never suggests what to cut (`D-002` no personalized advice, `D-006` word-first and
non-judgmental). The insight `headline`/`detail` strings are backend-authored and reused **verbatim**
(the documented `CD-006` exception); the browser does not re-summarise or re-word them, so the report
cannot introduce a claim the app never made.

### D-R5 — "PDF" is the browser's own print-to-PDF, with no new dependency
The printable artefact is the in-app report screen with a dedicated `@media print` stylesheet; the
user produces a PDF through the browser's native Print dialog. Rationale: it adds **no** rendering
dependency, no server-side document engine, and no headless-browser attack surface; and because the
printout *is* the screen, the PDF can never diverge from what the user reviewed (WYSIWYG). The print
stylesheet hides the app chrome (nav, buttons) and lays the report out for paper.

### D-R6 — The CSV is a clean, single RFC-4180 table
Columns: `Category,Spent,Refunds,Net,Share %,Transactions`. One row per spending category in the
backend's sort order (largest net first), then a final `Total` row. **No** preamble or metadata rows
— a "Month: July" banner row above the header is exactly what breaks a spreadsheet's column
detection. The month and currency ride in the filename (`monthly-report-YYYY-MM.csv`) and in the JSON
payload, not in the table body, so the CSV imports cleanly into any spreadsheet.

### D-R7 — CSV numbers are plain decimals — no symbol, no thousands separator
Money cells are cents rendered as `whole.frac` via a **pure integer transform** (never a float, so
`1234` → `12.34` with no `12.340000001`). No currency symbol and no thousands separator in numeric
cells — either would turn a number into text a spreadsheet won't sum. `Share %` is `shareBasisPoints
/ 100` (e.g. `2345` → `23.45`). Any field containing a comma, quote, or newline (a category label
could) is RFC-4180-quoted with internal quotes doubled, and rows terminate with `\r\n`, so the export
round-trips through the same CSV parser the importer uses.

### D-R8 — "Empty" means no imported history at all
A store with **zero** transactions returns `404 NO_IMPORTED_HISTORY`, which the web maps to an
"import a statement first" empty state. A month that simply had *no spending* is **not** empty — it
renders a valid, quiet report ("you spent nothing this month" is a real, honest answer), because
suppressing it would hide a genuine result. Emptiness is a property of the whole dataset, not of the
chosen month.

### D-R9 — Entry is a card on the Spending screen, never a new nav tab
The report is reached from a secondary **"Where did my money go?"** entry card on the Spending
screen, next to "Thinking about a purchase?". Rationale: the primary nav is the fixed `C·A·P·I·T·A·L`
acrostic; new destinations are entry cards on the screen they belong to, not new nav items. Back
returns to Spending. The report is a lens on spending, so it lives one tap from the spending view.

### D-R10 — The route is thin; the CSV serializer lives in core
`toReportCsv` is a **pure `@ai-fin-os/core` function** — deterministic, no I/O, unit-tested — so the
exact exported bytes are covered by the same discipline as the arithmetic. The HTTP layer only
parses the query, loads + annotates the rows once (the same `load` the spending routes use, so the
report can never disagree with them), builds the report, and serialises. No arithmetic and no string
formatting of a financial figure lives in the route (`CD-003`).

## Files (planned)

- `packages/core/src/domain/monthly-report.ts` — `buildMonthlyReport` (composition + month
  resolution) and `toReportCsv` (pure serializer). Exported from `packages/core/src/index.ts`.
- `packages/core/tests/monthly-report.test.ts` — month-default resolution, composition equivalence
  with the two engines, CSV shape/escaping/rounding, empty-month vs. no-history. Fixtures dated
  **2021–2023** (not 2026) so the logic is exercised on real-shaped dates (`CD-012`).
- `packages/server/src/http/report-routes.ts` — `GET /api/v1/reports/monthly` (JSON) and
  `GET /api/v1/reports/monthly.csv` (attachment). Registered in `server.ts` beside the spending
  routes.
- `packages/server/tests/report-routes.test.ts` — JSON payload, CSV headers + body, `key` override,
  invalid `key` → 400, empty store → 404.
- `apps/web/src/services/api.ts` — `fetchMonthlyReport` (+ a credentialed CSV download helper).
- `apps/web/src/services/report.ts` — `loadReport` outcome mapping (mirrors `services/spending.ts`).
- `apps/web/src/screens/MonthlyReportScreen.tsx` — the printable screen + a "Download CSV" action.
- `apps/web/src/screens/SpendingScreen.tsx` — the "Where did my money go?" entry card.
- `apps/web/src/App.tsx` — the `"report"` route and its wiring.
- `apps/web/src/index.css` — the `@media print` rules.

## Boundaries kept

- **No new math.** Every figure comes from `summarizeSpending` / `detectInsights`; the report only
  arranges and serialises them (`CD-003`).
- **No browser arithmetic.** The web renders backend figures and calls one endpoint; the CSV is
  built in core, not assembled in the browser (`CD-011`).
- **No new store, no new source of truth.** The report is computed per request from imported history
  and outlives nothing.
- **Read-only, non-prescriptive, word-first.** Factual observations only; on-screen insight copy
  reused verbatim (`D-002`, `D-006`, `CD-006`).
- **Determinism.** Anchored to `asOfDate`; identical history yields identical JSON and identical CSV
  bytes (`CD-011`, `CD-012`).
- **No new dependency.** "PDF" is the browser's print; the CSV is a hand-written pure serializer.
