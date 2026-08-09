# Coordination Workspace

Status: Living  
Last updated: 2026-08-06

## Purpose

This folder is the lightweight shared operating surface for parallel backend and UI work on AI Finance Operating System.

Use it for coordination between:

- `[Backend: Codex]` backend implementation, contracts, fixtures, deterministic financial logic, tests.
- `[UI: Claude]` UI design, screen flows, presentation logic, interaction states, copy mapping.
- `[Shared]` integration contracts, handoffs, unresolved assumptions, cross-team sequencing.
- `[User decision]` product or priority choices that require the user.

This folder does not replace the product source of truth in `docs/`. It makes active collaboration easier without modifying stable product direction.

## Authoritative Sources

- `docs/product-charter.md`: stable product direction. Do not modify unless the user explicitly changes the product charter.
- `docs/decisions.md`: material product, architecture, data, and compliance decisions.
- `docs/mvp0-backend-design.md`: backend-owned MVP 0 data model, forecast rules, decision rules, and UI-facing contract.
- `coordination/DECISIONS.md`: cross-team implementation and coordination decisions only.
- `coordination/UI_BACKEND_CONTRACT.md`: integration summary for UI work. It points back to the backend design and should be kept aligned with it.

## Rules

- Read `coordination/README.md`, `coordination/STATUS.md`, `coordination/HANDOFFS.md`, and `coordination/UI_BACKEND_CONTRACT.md` at the start of each work session.
- Update `coordination/STATUS.md` when starting or finishing a meaningful chunk of work, when a blocker appears, or when an integration assumption changes.
- Use `coordination/HANDOFFS.md` for requests between backend and UI. Include owner, status, dependencies, acceptance criteria, and response.
- Use `coordination/DECISIONS.md` only for cross-cutting implementation decisions that affect more than one workstream.
- Keep backend financial calculations in backend-owned code and contracts. UI may format and present results, but should not recalculate affordability levels, timing reserve, buffer outcomes, forecast paths, or monthly spending summaries.
- Do not claim access to another assistant's unpublished work. If Claude's UI work is not present in this workspace, mark its status as unknown until Claude or the user updates these files.
- Prefer appending dated notes over rewriting another owner's active entry.
- **Do not carry a stale audit forward as current state.** An audit describes the tree on the day it ran. `STATUS.md` carried a list of "current committed UI-source gaps" for two days after every item in it had shipped, and it was cited elsewhere as if it were live. Date every audit, and strike it through when it stops being true rather than leaving it to be re-read as fact.
- **A capability claim needs the command that proved it.** "Typechecks clean" was recorded while `pnpm build:web` could not build at all, because each package had been checked alone and only the web build type-checks `packages/core` under the stricter flags. State what was run, not what was believed.

## Verification Baseline

Before claiming the tree is healthy, run both — neither is sufficient alone:

```bash
pnpm test && pnpm build
```

`pnpm build` is the only path that type-checks `packages/core` through `apps/web`'s stricter `tsconfig` (`noUnusedLocals`, `noUnusedParameters`). Core and server can both pass on their own while the web bundle and its Docker image cannot be built.

Read-path behaviour is verified from a real CSV import, not from a fixture. See `CD-012` for why.

## Update Cadence

- Start of session: read the coordination files and update the owned status line if work is starting.
- During work: update handoffs immediately when another owner is blocked or needed.
- End of session: update `STATUS.md` with outcome, next step, and any blocker.
- Contract change: update `UI_BACKEND_CONTRACT.md`, add or update a handoff, and record a coordination decision if the change affects both UI and backend.

## Conflict Resolution

1. Stable product docs in `docs/` override coordination notes.
2. `docs/mvp0-backend-design.md` is authoritative for deterministic backend behavior and the UI-facing contract.
3. `[Backend: Codex]` owns financial logic, schemas, fixtures, and deterministic tests.
4. `[UI: Claude]` owns UI layout, interaction design, presentation states, and visual treatment.
5. If two entries conflict, mark the conflict in `HANDOFFS.md`, leave both facts visible, and assign an owner to resolve it.
6. If a conflict changes product scope, compliance boundaries, or MVP priority, mark it `[User decision]` in `STATUS.md`.

