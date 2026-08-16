# Coordination Status

Status: Living  
Last updated: 2026-08-16

> **UI validation sweep landed 2026-08-16 (`[UI: Claude]`, `apps/web` only; `H-094`, PR #18).**
> A full pass over the reconciled validation findings: **20 UI bugs fixed, 1 evaluated and
> kept by-design.** Branch `fix/validation-sweep` (22 commits off `main` `cc4f734`), pushed and
> opened as **PR #18**. Per the user's instruction each confirmed bug is a **single, isolated,
> cherry-pickable commit** — fix → tests → live browser validation → commit — in priority order,
> after one `chore` commit adding the vitest harness.
>
> **Fixed:** HIGH `B1` (VerdictPanel duplicate-key collapse); MED `B5` (account-tile mobile
> overflow), `B3` (Budgets blank-slate keyed on global config not the open window), `B10` (Goals
> contradictory empty-state), `B11` (net-worth trend table scroll), `B17` (Monthly Report prints
> light in every theme); LOW-MED `B13` (System-dark `--text-tertiary` synced), `B14` (older date
> headers show the year), `B16` (Insights controls stay mounted — no Skeleton remount flash); LOW
> `B2` (`COVERAGE_INCOMPLETE` verb agreement), `B6`/`B8`/`B12` (pluralization via shared
> `format/counts.ts`), `B7` (zero-spend empty-state row), `B15` (Import error card alert styling),
> `B4` (Admin toggle surfaces rejections instead of silent no-op), `B9` (ThemeToggle swallows
> expected ViewTransition rejections); plausible/defensive `B19` (mascot panel clears the mobile
> sticky header on short phones — `calc(100vh - 232px)`; the finding's suggested 132px clamp would
> **not** have fixed iPhone SE), `B20` (Assistant bubbles break long unbroken tokens), `B21`
> (zero-cent row renders `$0` not `−$0`, via a pure `amountSign` helper).
>
> **`B18` evaluated and deliberately KEPT** — tapping a section tab jumps to the section's first
> page even when already inside it (Goals → Cash-flow). This mirrors the `CollapsedSection` rail
> tile's documented "section home" shortcut, and mobile Row 2 handles within-section moves; rather
> than fragment the pattern, the commit documents the intent at the mobile pill (the rail had the
> note, the pill didn't) and adds a guard locking both nav surfaces to the same behavior. **No
> behavior change.** Four Workflow findings **correctly rejected** (re-verified false, not "fixed"):
> SettingsScreen `opacity-45` (in Tailwind's default scale), InsightsScreen Delta `Math.abs`
> (already normalized), SpendingScreen:431 net (no runtime impact), InsightsScreen:112 `items-center`
> (no visual impact).
>
> **Testing** (given `apps/web` runs vitest in **node with no DOM**): real unit tests where logic
> could be extracted into pure modules (`amount-sign.ts`, `admin-errors.ts`, `theme-transition.ts`,
> `counts.ts`); source-guard tests for render-conditional/layout/CSS bugs; and live browser
> validation for every visible change (fetch-stubbing unreachable states, DOM probes reading
> `getComputedStyle`/`scrollWidth` against the built stylesheet, confirming screenshots). Verified:
> `pnpm --filter @ai-fin-os/web test` **90 pass across 23 files**, web `tsc --noEmit` clean. Scope:
> 49 files, entirely `apps/web` (+ vitest config/lockfile) — **no `packages/*`, no backend.** Detail
> in `HANDOFFS.md` `H-094`. Follow-up: PR #18 review/merge.
>
> **Overnight backend session started 2026-08-08 (`[UI: Claude]`, backend lane).**
> The user is asleep and asked a fresh session to pick up unblocked work without
> colliding with concurrent agents. Two sessions were live in `apps/web` at the
> time (animation library + agent-icon design), so this session **claims the
> backend lane only — `packages/core` and `packages/server` — and will not touch
> `apps/web`.** Baseline captured before any change: `pnpm test` = core 51 +
> server 102 = **153 pass**, `pnpm run build:api` clean. Work is `L-008` taxonomy
> breadth (the audit's named frontier for a real bank export), a `CD-012`
> derived-field audit + test hardening, and an `S-006`/`L-010` feasibility read.
> Tracked in `H-056`. Every change is additive and verified by `pnpm test` +
> `build:api` before it is recorded. `build:web` is deliberately **not** used as a
> gate tonight because the two live sessions are mid-edit in `apps/web`.
>
> **Landed so far (2026-08-08):** (1) `L-008` full Plaid PFC primary coverage —
> the missing `RENT_AND_UTILITIES` primary and pinned detailed codes, so unmapped
> detailed codes degrade to their primary instead of `unknown`; fixture-first (11
> new `merchant-normalization-cases.json` cases + a 4-case `L-008` test block).
> (2) `CD-012` fix — a new exported `annotateTransferPairs` applied at the read
> boundary in `spending-routes.ts` `load()`, so an inter-account transfer pairs on
> the Transactions/Insights screens too, not only inside the Spending summary
> (previously it showed as two orphaned `UNCLASSIFIED` rows). Additive + idempotent;
> the Spending summary is unchanged. (3) `L-008` cont. — 49 common US merchant alias
> rules (fast food, groceries, retail, utilities/telecom, streaming, software,
> fitness, insurance, fuel, airlines/hotels), which matter most on the CSV path that
> carries no category column; ambiguous names (e.g. `SUBWAY`) left to `unknown`.
> Proof: `pnpm test` = **214 pass** (111 core / 103 server), `pnpm run build:api`
> clean. Files touched, all backend-lane:
> `packages/core/src/domain/{normalization.ts,monthly-spending.ts}`,
> `packages/core/src/index.ts`, `packages/server/src/http/spending-routes.ts`, and
> tests/fixtures under `packages/core` + `packages/server`.
> (4) `S-006`/`L-010` feasibility (read-only, no code): traced every goal input path
> and filed the dependency — goal-conflict detection cannot be a self-contained
> backend slice today because `detectInsights` takes no goals and every real read
> flow supplies `goals: []` with no persistence/endpoint behind it; building it now
> would be a fresh `CD-012`. Blocker `L-010` scoped in `HANDOFFS.md` H-056 item 4;
> `docs/backlog.md` `L-008`/`L-010`/`S-006` rows updated accordingly.
>
> **Loop phase 2 (2026-08-08, `H-058`):** after H-056 closed, surveyed core domain
> modules with no dedicated test and added coverage to the two highest-leverage
> read-path ones. (5) `queryTransactions` — new `transactions-query.test.ts` (10
> cases) pins effective-flow filtering, the three unclassified reasons, cursor
> pagination + malformed-cursor handling, date/currency/account/category filters,
> description search, and recurrence; no bug, a regression fence around a
> two-caller function (route + AI tool). (6) **Real bug fixed** — `periods.ts`
> `isoWeekNumber` anchored the ISO week count on 1 Jan instead of 4 Jan, so every
> ISO year opening Fri/Sat/Sun (2021/2022/2023/2027…) was off by one for the whole
> year; hidden because all fixtures are 2026 (1 Jan = Thu). One-line fix +
> `periods.test.ts` (15 cases, cross-checked vs an independent ISO oracle).
> (7) **Second real bug fixed** — `insights.ts` `money()` dropped a trailing zero
> (**$10.50 → "$10.5"**) in the user-visible insight copy the `/insights` detectors
> emit; the repo's two other money formatters were already correct. Fixed + first
> dedicated cover for the S-006 engine (`insights.test.ts`, 6 cases). Proof:
> `pnpm test` = **245 pass** (142 core / 103 server), `build:api` clean. Files, all
> backend-lane: `packages/core/src/domain/{periods,insights}.ts`, new
> `packages/core/tests/{periods,transactions-query,insights}.test.ts`.
>
> **Loop phase 3 (2026-08-08, `H-060`):** kept going down the un-covered-module
> list to its foundation. (8) `domain/dates.ts` — the date-arithmetic floor under
> `periods`/`spending-summary`/statement cycles — had no direct test; added
> `dates.test.ts` (26 cases) targeting exactly the 2026-blind edges (leap Feb,
> century-leap **1900→28 vs 2000→29**, month-end clamp, negative & year-boundary
> `addMonths`), each expected value cross-checked against an independent
> `setUTCMonth` oracle. No bug — the primitives are correct, now fenced against the
> 2027 rollover. (9) Deleted `accounts-view.ts` `inferClosingDay` — dead code
> flagged by `H-024`, zero references repo-wide (incl. `apps/web`), and a heuristic
> that contradicted the file's own "never infer a cycle" rule; removed it and its
> orphaned `addDays` import. Proof: `pnpm test` = **271 pass** (168 core / 103
> server), `build:api` clean (server `tsc` confirms no dangling ref). Files, all
> backend-lane: `packages/core/src/domain/accounts-view.ts`, new
> `packages/core/tests/dates.test.ts`. Still un-covered (next loop, lower-risk —
> both delegate calendar math to the now-tested `periods`/`dates`):
> `spending-summary.ts` and `accounts-view.ts` `buildAccountsView`.
>
> **Loop phase 4 (2026-08-08, `H-062`):** covered the product's core computation.
> (10) `spending-summary.ts` (`summarizeSpending`/`spendingSeries`, the "where is
> my money going" engine for every period kind) had no direct core test — only
> server integration + the separate month-only `summarizeMonthlySpending`. Added
> `spending-summary.test.ts` (7 cases), centred on a **cross-engine parity oracle**:
> for `kind:"month"` the generalised engine is asserted equal to the fixture-trusted
> month engine on every shared figure (totals, per-category/-account/-institution
> outflow, baseline comparison) — they **agree**, no divergence, invariant now
> fenced. Plus non-2026 unit cases only this engine can do (ISO-week bucketing on
> 2021-W24, refund-net + `shareBasisPoints`, transfer-trust downgrade, card-payment
> exclusion, partial-period suppression, `spendingSeries`). No bug — module correct.
> Proof: `pnpm test` = **278 pass** (175 core / 103 server), `build:api` clean; new
> `packages/core/tests/spending-summary.test.ts` only, no source change. The H-058
> read-path modules (`insights`/`transactions-query`/`periods`/`dates`/
> `spending-summary`) now all have direct cover; `accounts-view.ts`
> `buildAccountsView` is the last sizeable un-covered core module.
>
> **Loop phase 5 (2026-08-08, `H-064`):** closed the sweep. (11) `accounts-view.ts`
> `buildAccountsView` — institution grouping + credit-card statement cycle, the last
> un-covered core module — got `accounts-view.test.ts` (9 cases): net position signed
> by **role not raw balance sign**, worst-connection-status aggregation, statement
> spend net of refunds, and `dueDateFor`'s December→next-January rollover. No bug.
> Proof: `pnpm test` = **287 pass** (184 core / 103 server), `build:api` clean.
> **Overnight loop total (phases 2–5):** swept every un-tested core domain module →
> **2 real bugs fixed** (`periods` ISO-week, `insights` `money()`), **1 dead function
> removed** (`inferClosingDay`), **6 new test files** (+70 core tests, 114→184), the
> general-vs-month spending engines pinned equal, and the date floor fenced for 2027.
> Every backlog item still open (`L-008` long-tail, `L-009`, `L-010`) needs real
> import data or an `apps/web`/contract coordination that can't be done solo tonight.

> **Assistant mascot added 2026-08-07, redesigned same day, made responsive
> 2026-08-08 (`[UI: Claude]`, `apps/web` only).** A realistic gold "b" coin with a
> little teal "b-guy" living behind it (`components/AssistantMascot.tsx`), mounted in
> `App.tsx` `AppContent`, hidden on the `assistant` route. It now has **two responsive
> layouts** chosen by viewport width (director-owned `data-mode` on `.mascot-root`,
> set pre-paint via `useLayoutEffect`, re-checked on resize + the `(max-width:
> 639.98px)` media query): **CORNER** (≥640px) anchors bottom-right and rolls a long
> way LEFT along the bottom "almost to the content"; **DOCKED** (≤639.98px, phones)
> tucks the coin ~3/4 off the RIGHT edge (only ~1/4 / ~16px sliver visible), rolls
> UP/DOWN that edge (up only to ~mid-screen), and the b-guy peeks out to the SIDE
> (poking `translateX(-44)` further left so it reads against the thin sliver). The whole assembly also scales with a
> `--coin-scale` CSS var (1 → 0.9 ≤1023px → 0.82 ≤639.98px) that the director reads to
> convert viewport-px roll targets into the roller's own space. The coin is a
> **genuine CSS 3D cylinder**: two minted `CoinFace` SVGs
> offset along Z (`translateZ(±--coin-h)`, 8px thick) joined by a ring of 56 reeded
> segment divs (`.coin-edge-seg`, transform `rotateZ(φ) translateX(RIM_R) rotateY(90°)`)
> so a spin shows a thick knurled gold *edge* instead of collapsing to a flat line.
> Each face reads as metal: radial face gradient (pale gold→bronze), rim band,
> milled inner ring, embossed bevelled "b", specular hotspot + warm bounce light.
> A single rAF "director" drives **physically-correct, mutually-exclusive** motion
> from a `mode` state machine (`idle→flick|roll→land→idle`). The whole assembly
> (guy + coin + hands + bubble) rides a `.coin-roller` wrapper that carries the
> travel (translateX in corner, translateY in docked), so the guy stays **locked
> behind the coin wherever it rolls**; the coin element itself carries only its own
> turn. A **flick** is a rapid full 360° `rotateY` spin (friction decay, lands
> face-on) with *no* travel; a **roll** is now **one-directional** — it eases `pos`
> to a target and the return home is a *separate* roll, so the coin can dwell / flick
> / peek while out before rolling back (a `dwell` counter forces a return after ≤2
> events). Corner excursions travel a random 35–100% of a **content-aware** free
> room: the roll is capped by the SMALLEST of (a) room to the sidebar, (b) ~1/4 of
> the viewport width, and (c) the right edge of the rightmost card actually sitting
> in the coin's bottom roll-band (re-measured each excursion, so it tracks scroll +
> route). Net effect: the coin rolls a long way into empty bottom space but **stops
> just short of content** and barely moves on a dense full-width page (e.g.
> Transactions), so it never covers the content it lives next to. Docked
> excursions roll up to ~mid-screen or dip slightly below home. Travel duration comes
> from distance at a believable rolling speed (`ROLL_SPEED`, clamped), and the coin's
> `rotateZ` is **coupled to travel** (`DEG_PER_PX = 180/(π·R)`) so it reads as a coin
> rolling on its edge. Flick and roll **never** run together, and a **peek** only
> fires while the coin is fully at rest (`peekBlocked` gates on `mode!=="idle"`;
> events gate on `!peeking`). On the peek (also a quick pop on click) the b-guy climbs
> up over the top rim (corner) or out to the left (docked) with hands gripping the
> edge and floats an HTML chat thought-bubble reading **"Questions about this?"**
> (page-aware nudge; `BUBBLE_TEXT`), anchored clear of the coin/guy and, riding the
> roller, following them. Driven by CSS transitions off `data-peek` on `.coin-stage`
> (`up`/`down`), hold ~5.2s, gated to idle. The **climb-down** is a deliberate reverse
> of the climb-up (asymmetric transitions: up springs in; down is a slower ~0.56s
> descent with the guy's opacity fade *delayed* ~0.38s so he visibly climbs down
> behind the coin rather than blinking out — `PEEK_DOWN_MS` covers it). On click it opens a compact, page-aware popover
> keyed on `route`, talking over the *existing* transport — `sendAgentTurn` +
> `conversationId` threading + `TOOL_LABELS` sources — and degrades to the same "not
> set up" state as `AssistantScreen` when `fetchAgentStatus` reports unconfigured
> (verified: this instance has no key). Flick/roll/peek never fire under
> `prefers-reduced-motion` (director parks the coin at home face-on in either mode,
> guy hidden), while the tab is hidden, or while the panel is open. A breakpoint flip
> cleanly resets all motion + peek state so nothing leaks across the two homes. No
> backend touched; `tsc --noEmit` clean; verified live (corner content-aware cap:
> on Transactions the list card ends at x≈1144 so max roll is only ~22px and the coin
> stays in the right gutter, while on the Check form it rolls ~142px and stops just
> right of the necessity buttons at x≈1024 — never over content; guy locked to coin
> dx=0; 375 docked: coin ~1/4 visible / ~16px sliver, guy pokes left at translateX(-44)
> on-screen, "Questions about this?" bubble pulled to right:64px so it stays fully on
> screen; asymmetric climb-down + climb-up transitions confirmed; no console errors).
>
> **Mascot tuning 2026-08-08 (`[UI: Claude]`, `apps/web` only).** Two fixes:
> (A) **Content-aware resting tuck.** The content-aware roll *cap* only prevented the
> coin *rolling* onto content; it did nothing about the coin's *resting* home when a
> full-height right-column card (e.g. Pulse → Year → "show all accounts": the ACCOUNTS
> card, right≈1240 vs coin home left≈1182 → ~58px overlap) fills the corner band, since
> there's no gutter beside it and no room below. `measure()` now computes a rightward
> **resting tuck** (`restTarget`, local px) that slides the coin partly off the right
> edge until its leading edge clears the card by `CORNER_CONTENT_CLEAR_GAP`, keeping ≥
> `CORNER_MIN_VISIBLE` (26px) visible (`tuckCap = coinW − 26 + RIGHT_INSET`); it sets
> `occluded=true` and `leftRoom=0` (no leftward roll). `step()` eases `restX → restTarget`
> each frame (bidirectional: slides back home when content clears); `apply()` adds `restX`
> to the corner `translateX` but drives `rotateZ` from `pos` **only**, so a tucked resting
> coin keeps its "b" upright (no roll angle). When tucked, `root[data-occluded="true"]`
> **reuses the docked side-peek CSS** (guy peeks LEFT, bubble left, hands hidden) so the
> guy stays discoverable against the thin sliver. Docked branch forces `restTarget=0`/
> `occluded=false`; `syncLayout` resets all three; `restStatic()` (reduced motion, incl.
> the reduced-motion mount path) snaps `restX=restTarget` statically so the tuck still
> clears content without the rAF loop.
> (B) **Hands stay planted on the rim.** `.coin-hands` previously `translateY(9px)→0`
> which slid the mittens UP THROUGH the coin face on the pop-up/slide-down. Now
> `.coin-hands` has **no transform** (opacity-only transition), so the mittens stay
> anchored at the top rim (`top:-3px`) and only fade; the body (`.coin-guy`) still does
> the climb. Verified live @1280 on Pulse Year+all-accounts: coin tucks to translateX≈72,
> coin.left 1254 ≥ card.right 1240 (clears), 26px sliver, guy peeks left + bubble left +
> hands hidden, panel still opens fully on-screen, no horizontal scrollbar; and in Month
> (short card) the coin eases back home with hands gripping the top rim (transform:none).
> `tsc --noEmit` clean; no console errors; no backend touched.
>
> **Mascot tuning 2026-08-08b (`[UI: Claude]`, `apps/web` only).** **Wide-screen roll
> cap.** On a 2056×1285 monitor the corner leftward roll wandered onto the centered
> content column: the roll envelope's `cap` was purely `CORNER_MAX_TRAVEL_VW (0.26) * vw`,
> which is ~534px at 2056px wide — the coin's leading edge reached x≈1423 (0.69·vw), deep
> inside the content column (main spans 612–1692; home coin left 1958). Added an absolute
> **`CORNER_MAX_TRAVEL_PX = 260`** and made `cap = min(0.26·vw, 260)`, so the roll no
> longer scales unboundedly with viewport width. At 2056 the max roll is now 260px → coin
> left edge x=1698, 6px into the right gutter past the content edge (1692) — clear of
> content. Narrow screens are unchanged (where `0.26·vw ≤ 260`, or `roomToBound`/content-
> band detection already bind tighter). Verified live @2056×1285 on Pulse (overlay of the
> max-roll coin footprint vs the content-column edge). `tsc --noEmit` clean; no console
> errors; no backend touched.
>
> **Mascot Settings / calm / disable + gear placement 2026-08-08 (`[UI: Claude]`,
> `apps/web` only; `H-072`).** The coin is now user-tunable and can be turned down or
> off. New shared store `mascot-prefs.ts` (`useSyncExternalStore`, localStorage-backed
> so a Settings change reaches the already-mounted coin **in the same tick**) holds
> `{visible, movement, character}` with three presets — **Lively** (default:
> `visible+movement+auto` peeks), **Calm** (`visible`, movement **off**, character
> `always`), **Off** (`visible:false`). `SettingsScreen.tsx` renders an Appearance card
> (theme) + an "Assistant coin" card: the three quick-preset tiles, a "Show the coin"
> switch, an "Idle movement" switch, and a "The little guy" segmented (Peeks now & then /
> Always visible / Hidden), plus an honest note that OS reduced-motion overrides movement.
> The mascot mount is gated `route !== "assistant" && mascotPrefs.visible`, and the
> director reads prefs: `alwaysGuy = character==="always"`, `motionAllowed = movement &&
> !prefersReducedMotion`, `wantAutoPeeks = character==="auto" && motionAllowed`. **Calm's
> contract** (per user): the teal b-guy **and** his "Questions about this?" bubble stay
> **statically visible at all times with no motion**, on phones (docked) as well as
> desktop (corner) — not hidden.
>
> Two bugs found and fixed making Calm hold everywhere:
> (A) **Docked/mobile Calm guy was invisible (CSS specificity).** The guy's side-peek
> pose (docked / occluded) is set at specificity (0,5,0); the `data-guy="static"`
> transition-kill rule was only (0,3,0), so it lost the cascade and the guy still ran a
> transition — which could freeze him mid-slide (off-screen, opacity 0) when the pane was
> backgrounded. Fixed by bumping the static-guy selector to (0,5,0) via the always-"up"
> static pose (`index.css` `.mascot-root[data-guy="static"] .coin-stage[data-peek="up"]
> .coin-guy`), so `transition: none` wins by source order in every mode. Verified live on
> a 375 docked viewport: guy `opacity 1`, `translateX(-44px)`, `transition-duration 0s`.
> (B) **Corner Calm guy got tucked away after a breakpoint flip.** `syncLayout()` (fires
> on resize / the 639.98px media flip) hardcoded `peek="down"` and restarted idle
> scheduling without accounting for `alwaysGuy`, so the always-visible guy was tucked and
> — motion being off — never re-peeked. Unified all resting-state logic into one `settle()`
> helper (`AssistantMascot.tsx`) called from the mount, the motion-pref change, and the
> `syncLayout` tail: if `alwaysGuy` → `peek="up"` + (motion ? start() : restStatic("up"));
> else if motion → `peek="down"` + start() + schedulePeek(); else `restStatic("down")`.
> Verified with a desktop→mobile→desktop flip in Calm: the guy stays visible throughout.
>
> **Placement (per user):** Settings is **not** a top-nav tab — a nav tab would tack an
> "S" onto the collapsed rail's `C·A·P·I·T·A·L` acrostic. Instead a **gear** sits at the
> bottom of the left sidebar (`AppShell.tsx` `GearIcon` + `SettingsLink`: full-width row
> when expanded, a rail tile with hover-flyout when collapsed) and, since phones have no
> persistent sidebar, in the mobile top bar. `App.tsx` drops the Settings nav entry
> (acrostic comment updated) and passes `onHome` / `onOpenSettings` / `settingsActive`;
> the `"settings"` route + `<SettingsScreen/>` render are unchanged. Verified: collapsed
> rail still spells `C·A·P·I·T·A·L` with the gear a separate 40×40 tile below the letters;
> gear renders + navigates in both expanded sidebar and mobile bar. `apps/web` `tsc
> --noEmit` clean; no backend touched. Handoff `H-072`.

> **Production backbone landed 2026-08-06 (session `8c02185c`, orchestrating).**
> The remaining backbone the user asked for is in and verified end to end, keys
> pluggable later:
> - **Auth & isolation.** `single_user` (default, login-free — tests stay green)
>   vs `multi_user` (real accounts + admin), switched by `BREADCRUMBS_AUTH_MODE`.
>   Per-user isolation is by construction (`.forUser(userId)` seams); a guessed id
>   for another user's statement, file, or bank connection returns the same 404 a
>   missing one does — no existence leak. Covered by `tests/auth-routes.test.ts`,
>   `agent-memory-routes.test.ts`, `plaid-isolation.test.ts`.
> - **Offline local assistant.** `BREADCRUMBS_AGENT_PROVIDER=local` runs an
>   OpenAI-compatible model whose base URL **must be loopback** — enforced in code
>   (`assertLoopbackUrl`), not just documented, so "cannot reach the internet" is a
>   guarantee. Per-user memory (facts, short-term note, conversation history,
>   uploaded files) with offline keyword retrieval — no embeddings, no network.
> - **UI refurbish (background agent `a59adbef…`).** Light/dark/system theme,
>   a proper date-range picker, login + admin screens, session gating, and a Plaid
>   connect section — all degrade gracefully when unconfigured.
> - **Assistant memory now reachable in the browser** (this session, `apps/web`):
>   `AssistantScreen` threads `conversationId` so exchanges persist as one thread,
>   surfaces the on-device / remembers-across-chats status, and adds a "Teach the
>   assistant" file-upload panel wired to `/api/v1/agent/memory/files`. This closes
>   the gap where the backend could learn from files but the UI had no way to add
>   them. `services/agent.ts` gained `conversationId` threading + file list/upload/
>   delete.
>
> Full suite green: core 46 + server 78 = 124 tests, all `tsc --noEmit` clean, web
> `vite build` ✓. **Coordination note:** `apps/web` was edited from the
> orchestrating (backend) session because the UI background agent had already
> completed and no other session was live — no concurrent editor on the web tree
> at the time. MFA remains a commented placeholder per the user's "just get things
> running for now".

> **Build break fixed 2026-08-06 by a second Claude session — and a coordination
> gap flagged.** The tree would not build: the `multi_user` auth + per-user
> store-provider refactor was half-applied (6 `tsc` errors in `packages/server`).
> Fixed in `src/auth/password.ts`, `src/http/server.ts`, and `src/main.ts`;
> `tests/auth-routes.test.ts` added. `pnpm test` (core 46 + server 42) and
> `pnpm build` pass; both auth modes smoke-tested against a real server. A
> self-introduced admin-lockout regression (unconditional `ensureOwner` in
> `multi_user`) was caught by runtime testing and fixed. **Coordination note:**
> two Claude Code sessions (`e134f141` and `8c02185c`) were editing
> `packages/server` at the same time; `server.ts` was co-edited and the changes
> converged only by luck. No `STATUS`/`HANDOFFS` update happened between 10:11 and
> 12:53 while the work landed — the exact blind spot the protocol exists to close.
> Per user direction, `[UI: Claude]` has stood down from `packages/server`
> (`[Backend: Codex]`'s area under `CD-002`); the fix is handed off in `H-032` for
> review, with two unaddressed doc-drift items noted there.

> **Integration verified 2026-08-06.** Both tiers were started and driven
> against a generated three-month CSV: import through the API, then every screen
> rendered from it in the browser. `pnpm test` (65 tests) and `pnpm build` pass.
> Four defects were found and fixed — a build break, an ignored week key, a
> subscription detector reading a field nothing wrote, and a UI capability flag
> that hid two working period views. Detail in `H-028`.
>
> **Track A closed 2026-08-06.** `L-003a` (import UI, including PDF statements),
> `L-006` (statement closing day), `L-007` (affordability derived from real
> accounts), and `S-011` (assistant over the deterministic engine) all landed and
> were driven end to end in a browser. `H-019` is closed. Two new decisions
> govern the AI layer: `CD-014` (every figure comes from the deterministic
> engine) and `CD-015` (a model may extract, but only deterministic code may
> import).
>
> The open risk is evidential, not architectural: no real bank export or real PDF
> statement has been through the pipeline yet.

> **Direction changed 2026-08-04.** The product's centre moved from "Can I afford
> this?" to "Where is my money going?", aggregated across all accounts and
> institutions. `docs/product-charter.md` is amended for the first time. See
> `D-011`, `CD-010`, and `H-012`. `[Backend: Codex]` should read `H-012` before
> starting further work. Nothing already built is invalidated.

> **Product intent restated by the user 2026-08-04, with three consequences.**
> The user described the personal problem Breadcrumbs exists to solve: heavy
> credit card spending, then a scramble at month end to work out where it went,
> with the bill still to pay. Wanting to see spending across all accounts,
> categorised like Apple Card, by week, month and year, to find waste — with a
> local agent later for analysis and recommendations, and affordability as the
> secondary feature.
>
> Three gaps this exposes, filed as `H-018` and `H-020`:
>
> 1. **We only produce calendar months.** Week and year are required and have no
>    backend source. The UI cannot fill this without violating `CD-003`.
> 2. **Credit card statement cycles are not modelled, and this is the user's
>    actual problem.** A card closing on the 18th means the August bill is mostly
>    July spending. A calendar-month view can never reconcile to the statement
>    the user pays, at exactly the moment they are trying to reconcile it.
>    Recommended as the highest-value backend item.
> 3. **Wastage detection is two-fifths done.** Subscriptions and duplicate
>    services exist; frequent small purchases, rising categories, and goal
>    conflicts do not. "Things I am spending on that I am not paying attention
>    to" is a description of frequent small purchases.
>
> `S-003` is now built and opens on Spending.

> **`[UI: Claude]` implemented backend services 2026-08-04, on user instruction.**
> `packages/core` and `packages/server` are `[Backend: Codex]`-owned under
> `CD-002`; the user directed direct implementation rather than waiting. All
> changes are additive — no existing module or test was modified. Five new core
> modules (periods, spending-summary, transactions-query, insights,
> accounts-view) and five new HTTP endpoints. Full detail and two self-caught
> bugs in `H-024`, which needs Codex review. Tests are deliberately unwritten
> and left for Codex to place in existing conventions.

## Current Work Board

| Area | Owner | Status | Current notes | Next update |
| --- | --- | --- | --- | --- |
| Backend | `[Backend: Codex]` | All five screen endpoints live and serving imported data; **three fixes landed in Codex-owned code on 2026-08-06 and need review (`H-028`)** | 2026-08-06, `[UI: Claude]` on user instruction: removed an unused parameter in `insights.ts` that was breaking the web build; replaced the local period-key parser in `insights.ts` with the shared `periodFromKey` so a requested week is honoured; added `recurrence-annotation.ts` and applied it in `spending-routes.ts` so `recurrenceSignal` is derived from history rather than being read from a field nothing writes; added `tests/spending-routes.test.ts`, the first coverage for the screen endpoints, driven from real CSV commits. All 65 tests and `pnpm build` pass. Earlier: added the local-first delivery plan to `docs/backlog.md`: (A) immediately buildable local single-user CSV import/API/spending-summary work, (B) required local integration/demo gate, (C) Plaid only after the local import gate, and (D) multi-user/auth/persistence hardening afterward. Implemented `POST /api/v1/affordability/evaluate` in the single Fastify API, backed by server-side `packages/core` evaluation. Implemented preferred `/api/v1/local/statement-imports/preview`, `/api/v1/local/statement-imports/commit`, and `/api/v1/local/spending-summary` paths, with existing `/api/local/...` compatibility aliases; server starts without Plaid credentials; CSV import uses explicit mapping, row-level validation, shared deterministic category/merchant normalization, `UNCLASSIFIED` transfer-like rows, duplicate protection, and local-only persistence under `~/.breadcrumbs/local-data` by default. `S-004` added a core-owned category taxonomy, category display labels, merchant canonicalization/aliases, processor ambiguity metadata, and normalization fixtures/tests. `S-005` added backend/domain `detectRecurringSpending`, likely-subscription detection, duplicate-ish service grouping, confidence factors/caps, assumptions, uncertainties, diagnostics, S-005 fixtures, and focused tests. No Fastify endpoint, UI handoff, Plaid Link, Plaid production access, real auth/JWT, browser-side secrets, backend microservice split, or `S-006` insight work was implemented. | Review `H-028`, `H-024`, and `H-026`. Then `L-006`: accept a statement closing day on the account descriptor so the statement period can be switched on — it is the open half of `H-018` and the highest-value view in the product. `S-006` goal-conflict detection is the one insight rule still unimplemented. |
| UI | `[UI: Claude]` | `S-003` built and running against the API; week/year unblocked and switched on; **no CSV import screen** | 2026-08-06: week and year are served by the backend and are now live in the period switcher — `PERIOD_SUPPORTED` had kept them labelled "soon" long after `H-018` shipped. Statement stays off deliberately: without a card closing day the endpoint falls back to a calendar month, which is the specific confusion that period kind exists to prevent. Earlier: sessions 2 and 3, 2026-08-03 19:35–20:35 CDT. `apps/web` built on React + Vite + TS + Tailwind. Its original in-process affordability integration was superseded by `D-013`; `apps/web/src/services/affordability.ts` now calls `POST /api/v1/affordability/evaluate` through `VITE_BREADCRUMBS_API_BASE_URL`. Screens 1 (setup), 2 (purchase check), and 3 (result) are complete and evaluate through the Fastify API. Screen 4 (spending) was blocked on a fixture containing transactions; `H-015` now provides the canonical fixture and aggregation contract and is accepted. Accepted `H-004`, `H-005`, `H-006`, `H-007`. Opened `H-008` and `H-010`. Added `CD-009` after an id collision, plus a handoff index table in `HANDOFFS.md`. Also cleared stale pending markers from the three UI docs and checked off the completed Product Experience backlog items. Outcome before the HTTP migration: all four affordability levels rendered from real engine output; 10/14 reason codes verified at runtime, 14/14 at compile time; the form path omitted a blank amount rather than sending zero. Session 4: accepted `H-008` and deleted `apps/web/src/types/core.ts` — all contract types now import directly from `@ai-fin-os/core`. Accepted `H-011` and wired the three monthly-savings purchases as scenarios. | **Build `L-003a`, the CSV import screen**, from accepted `H-019`: upload, explicit column mapping, row-level preview, commit. Nothing else in the UI matters as much — every screen works and every screen is empty. Then `L-007`: replace the fixture snapshot behind "Can I afford it?" with the user's real accounts. Plaid Link remains queued to `S-008`. |

**Session 5 — pivot.** The user reviewed the built result screen and rejected it on two counts: the product was organised around the wrong question, and the screen itself was too dense to read. Both criticisms accepted. The screen presented a verdict, three reasons, assumptions, a boundary, a chart, a timeline, and a metrics grid simultaneously, with no dominant element — an inspector rather than a product surface. Amended the charter, added `D-011`, resequenced the roadmap, added `CD-010`, opened `H-012` for `[Backend: Codex]`. UI designed against mock transactions while backend fixture work was pending; `H-015` now gives UI the replacement source and contract. Source audit found no committed UI transaction mock dataset under `apps/web/src`; Claude reports session-only design iterations, but those are not committed React artifacts. | Implement `S-003` from accepted `H-015`. If the spending home needs presentation fields not in `MonthlySpendingSummary`, open a new contract handoff before computing them in UI. Plaid Link remains queued to `S-008`. |
| Shared contracts | `[Shared]` | Spending contract promoted; local CSV API and S-004 normalization fields added; API boundary updated | Contract source is `docs/mvp0-backend-design.md`, summarized in `coordination/UI_BACKEND_CONTRACT.md`. Integration boundary updated 2026-08-04 by `D-013` / `CD-011`: frontend and API deploy separately; `packages/server` is the single backend deployment boundary; `packages/core` is internal backend domain code. Affordability HTTP contract is `POST /api/v1/affordability/evaluate`. Spending-home contract includes `FlowType`, transfer confidence, expanded `MonthlySpendingSummary`, `MonthlySpendingAttribution`, `MonthlySpendingComparison`, `summarizeMonthlySpending`, category display labels/default-required flags, merchant ambiguity counts, and transaction normalization uncertainty codes. Local imported-data HTTP contract now lives in `coordination/UI_BACKEND_CONTRACT.md#local-csv-import-api-boundary`, prefers `/api/v1/local/...`, and is handed to UI in `H-019`; S-004 UI-visible label/ambiguity fields are handed off in `H-021`; API separation details are handed off in `H-023`. | Keep contract docs aligned if UI requests additional fields through `H-019`, `H-021`, `H-023`, or a follow-up handoff. |
| Blockers | `[Shared]` | **None in the code. One in the evidence.** | `L-003a` shipped 2026-08-06; the import UI, statement closing days, real-account affordability, and the assistant are all in. What is missing is not a feature but a fact: **no real bank export or real PDF statement has ever gone through this.** Every CSV tested was generated by us, so the pipeline is only proven against shapes we anticipated. The category taxonomy (`L-008`) is the first thing a real file will strain. | `[User decision]`: run a real export. Until then, treat import robustness as unproven rather than working. |

## Sync Audit

`H-017` is accepted, with an explicit backend closeout addressed to `[UI: Claude]`. Cross-check covered backend code, spending contract docs, canonical fixtures, tests, backlog sequence, and committed UI imports. The verified project-file state is aligned on contract and sequence; remaining gaps are expected `S-003` UI implementation/documentation work.

Claude reports that session-only spending-home design iterations were reviewed and rendered from the backend fixture. Backend cannot independently verify those behaviors from committed project files, so they are recorded as workstream context only.

~~Current committed UI-source gaps for `S-003`~~ **Closed 2026-08-06.** Every item in that list was written before `S-003` landed and none of it is true now. Recorded here because the audit itself was cited elsewhere:

| Then | Now |
| --- | --- |
| `App.tsx` defaults to `route: "check"` | Defaults to `"spending"` |
| No `SpendingScreen` exists | `SpendingScreen`, `TransactionsScreen`, `InsightsScreen`, and `AccountsScreen` all exist |
| `services/affordability.ts` is the only service | Deleted. `services/api.ts` is the single HTTP boundary; `services/spending.ts` sits on top of it |
| No UI file imports the spending contract types | `SpendingSummary`, `TransactionPage`, `InsightsResult`, and `AccountsResult` are all imported as types from `@ai-fin-os/core` |

One gap in that spirit remains, and it is real: `apps/web/src/model/snapshot.ts` imports `packages/core/fixtures/mvp0/affordable-steady-paycheck.json` through a relative path. It is a build-time reach across the `D-013` deploy boundary, and it means "Can I afford it?" answers about fixture balances rather than the accounts the user imported.

Current shared-doc mismatches for UI follow-up owned by `[UI: Claude]`:

- ~~`docs/ui-mvp0-screens.md` still says Check is the default route, Screen 4 is blocked on transaction fixtures, and `src/types/core.ts` is a temporary workaround.~~
- ~~`docs/ui-design-system.md` still says there are no open backend dependencies, while the spending-home work now depends on accepted `H-015`.~~

**Both closed by `[UI: Claude]` 2026-08-04, along with three more the backend audit could not see:**

| Document | Change |
| --- | --- |
| `docs/ui-mvp0-screens.md` | Scope, navigation, and implementation status rewritten for `D-011`. No longer claims Check is the default route, no longer lists Spending as a blocked fourth screen, no longer references `src/types/core.ts`. Now scoped explicitly to the affordability screens. |
| `docs/ui-design-system.md` | Principle 1 rewritten. It read "the answer is the interface" and named the affordability result as the dominant element — invalidated by `D-011`. The hierarchy rule survives; the subject changed. "No open backend dependencies" replaced with an accurate open-items table. |
| `docs/money-flow-taxonomy.md` | **Central evidence was invented data.** It cited a mock dataset showing a 51% overstatement. Recomputed against the canonical fixture through the real `summarizeMonthlySpending`: the true figure is **108%** across three months — `$15,337` naive versus `$7,369` actual. Mock numbers removed. A document arguing for correctness should not rest on fiction. |
| `docs/ui-spending-home.md` | **New.** The approved design existed only as rendered previews. Now a specification with field-level contract tracing, states, visual direction, and a verification checklist, so `S-003` is built from a document rather than from memory. |
| `apps/web/README.md` | Corrected. Claimed there was no setup or purchase-entry screen; both have existed for two sessions. |

Remaining committed-source gaps are unchanged and deliberate: they are `S-003` implementation work, not documentation drift. `App.tsx` in particular keeps its affordability default until the spending home lands, because the route set changes as part of the same edit.

Other sync findings:

- `apps/web/src/types/core.ts` is deleted; stale references are documentation-only.
- `pnpm-workspace.yaml` now includes `apps/*`; dependencies were refreshed with `pnpm install`, and `pnpm --filter @ai-fin-os/web build` passes.
- `H-015` recorded two presentation gaps from UI: raw snake_case category identifiers needed display labels, and committed UI did not yet surface `merchantTotals`. `S-004` now provides category display labels and merchant ambiguity metadata; `H-021` asks UI to consume those fields instead of maintaining a UI cleanup map.

## Seeded MVP 0 Facts

- Initial user: individual salaried user paid bi-weekly.
- Spending summaries: calendar-month summaries generated from normalized transactions.
- After `D-011`, transactions are the primary product data object and spending visibility is the home surface.
- Internal forecast: daily deterministic forecast for a 30-calendar-day horizon.
- Backend ownership: deterministic affordability logic, validation, recurrence expansion, forecast paths, reason codes, assumptions, freshness warnings, and monthly spending summary generation.
- UI ownership: presentation, layout, interaction states, formatted money and dates, and product-language mapping for backend reason codes.
- Current backend stack: TypeScript, Node.js, Zod or comparable runtime validation, Vitest, canonical JSON fixtures, SQLite later when local persistence is needed.

## Latest Decisions For Coordination

- `[Shared]` Use `coordination/` as the shared file-based communication surface for parallel assistant work.
- `[Backend: Codex]` Backend contract summary lives in `coordination/UI_BACKEND_CONTRACT.md` and points back to `docs/mvp0-backend-design.md`.
- `[Shared]` UI should use backend-owned response data for affordability and monthly summaries rather than duplicating calculations in UI code.
- `[UI: Claude]` `CD-004` / `D-009`: UI stack is React, Vite, TypeScript, and Tailwind in a pnpm workspace.
- `[Shared]` `D-013` / `CD-011`: integration boundary is separate frontend/API deployment; `packages/server` is the single backend deployment boundary; `packages/core` is internal backend code.
- `[Shared]` `CD-006`: UI owns all user-facing copy. Backend message strings are diagnostic only.
- `[Shared]` `CD-007`: deferral and shortfall guidance is out of MVP 0 scope.
- `[UI: Claude]` `CD-008`: cash buffer is displayed as a visible assumption but is not editable in MVP 0.
- `[User decision]` / `D-010`: first supported goal is monthly savings (`monthly_savings_target`), with the practical intent of reducing discretionary spending to save more.
- `[User decision]` / `D-011`: cross-account spending visibility is now the product center; affordability remains a supporting tool.
- `[Backend: Codex]` / `D-012`: Plaid Sandbox scaffold is server-only, Sandbox-only, and uses mocked tests; no production Plaid flow or browser secret exposure.
- `[User decision]` Cash buffer remains visible and read-only for MVP 0; future editability should be evaluated later, not implemented now.

## Open Coordination Questions

All three prior open questions are now resolved.

- ~~In-process function or local HTTP adapter?~~ Superseded by `D-013` / `CD-011`: separate frontend/API deployment with one Fastify backend boundary.
- ~~Does the UI need additional presentation-only fields?~~ Resolved: no new computed fields (`H-003`). Two contract *shape* clarifications remain open as `H-004` and `H-005`.
- ~~Should the `$250.00` buffer be a UI setting?~~ Resolved: visible but read-only in MVP 0 (`CD-008`).

Backend-owned coordination clarifications:

- `H-004`: answered and accepted; `Assumption.code` is now a stable union in code and docs.
- `H-005`: answered and accepted for typed reason parameters and malformed-input error shape; reason ordering guarantee is resolved through `H-006`.
- `H-006`: responded by `[Backend: Codex]`; purchase amount/date are optional on the echoed response purchase, and reason ordering is documented and tested. Await UI acceptance if needed.
- `H-007`: historical, superseded by `H-023`; originally notified `[UI: Claude]` that `@ai-fin-os/core` was ready for in-process import.
- `H-008`: responded by `[Backend: Codex]`; snapshot entity/support types are exported from `@ai-fin-os/core`.
- `H-011`: opened by `[Backend: Codex]` to notify `[UI: Claude]` of the monthly-savings goal decision and new discretionary purchase fixture.
- `H-010`: responded by `[Backend: Codex]`; four canonical core fixtures now cover the previously unexercised reason codes. UI runtime copy verification still needs to consume them when UI work resumes.
- `H-012`: accepted; the multi-account, multi-institution transaction fixture and spending aggregation backend foundation are implemented.
- `H-013`: deferred to `S-008`; opened by `[Backend: Codex]` to hand off future Plaid Link UI wiring to the server-only Sandbox scaffold after the spending home contract is consumed.
- `H-014`: accepted by `[UI: Claude]`; money-flow classification and expanded spending summary contract are implemented.
- `H-015`: accepted; UI should consume the canonical spending-home fixture and aggregation contract in `S-003`.
- `H-016`: accepted; untrusted transfers are now downgraded to `UNCLASSIFIED`, and refund-only negative category totals are confirmed/documented.
- `H-017`: accepted; backend added a direct two-way sync closeout with verified alignment, exact remaining UI/doc gaps, owners, and next handoff path.
- `H-019`: open; backend added the local CSV import API contract and requested UI upload/preview/commit wiring for `L-003`.
- `H-021`: open; backend added `S-004` category display labels, shared normalization exports, merchant ambiguity counts, and transaction normalization uncertainty codes, and requested UI consumption without UI-owned normalization logic.
- `H-023`: open; backend implemented the frontend/API separation, versioned affordability endpoint, web API-base configuration, and `/api/v1/local` aliases, and requested UI follow-up against the HTTP boundary.

## Active Handoffs

See `coordination/HANDOFFS.md`.
