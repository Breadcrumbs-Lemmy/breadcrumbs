# AI Finance Operating System Documentation

This folder is the product source of truth for AI Finance Operating System. It separates stable product direction from living planning documents so product intent, current work, decisions, and backlog stay easy to find.

## Documents

| Document | Type | Purpose |
| --- | --- | --- |
| [Product Charter](product-charter.md) | Stable | Locked product direction, principles, boundaries, and non-goals. |
| [Roadmap](roadmap.md) | Living | MVP 0 through MVP 3 scope and sequencing. |
| [Current Status](status.md) | Living | Current phase, known progress, next work, and open questions. |
| [Decision Log](decisions.md) | Living | Material product and architecture decisions with rationale. |
| [Product Backlog](backlog.md) | Living | Actionable work items, starting with the MVP 0 backlog. |
| [UI Design System](ui-design-system.md) | Living | `[UI: Claude]` Design tokens, affordability visual language, uncertainty treatment, component inventory, accessibility. |
| [UI Copy Map](ui-copy-map.md) | Living | `[UI: Claude]` Maps backend reason, freshness, and boundary codes to non-judgmental user-facing copy. Source of every user-visible string. |
| [MVP 0 Screen Specs](ui-mvp0-screens.md) | Living | `[UI: Claude]` Annotated screens and states for the affordability flow, with field-level tracing to the backend contract. |
| [Spending Home Spec](ui-spending-home.md) | Living | `[UI: Claude]` The product's primary screen: destinations, hero, categories, transfers, states, and field-level contract tracing. |
| [Running Breadcrumbs](running-breadcrumbs.md) | Living | Docker setup, Plaid credentials needed, the full endpoint list, and known gaps. |
| [UI API Contract](ui-api-contract.md) | Proposal | `[UI: Claude]` Example payloads for every endpoint the designed screens need. Backend is built from this. |
| [Money Flow Taxonomy](money-flow-taxonomy.md) | Living | `[UI: Claude]` How spending, income, transfers, refunds, and fees are classified across multiple accounts and institutions. Prevents double-counting. |
| [Pattern Detection Spec](pattern-detection-spec.md) | Living | Deterministic MVP 0 rules, thresholds, confidence, safeguards, and fixtures for backend pattern detection. |
| [MVP 0 Data Quality And Safety](data-quality-and-safety.md) | Living | Backend validation, freshness, uncertainty, duplicate-protection, and read-only/non-advice safeguards. |
| [Information Security Policy](information-security-policy.md) | Living | Documented InfoSec policy: risk identification, mitigations (mapped to real controls), monitoring, incident response, subprocessors, and operator responsibilities. For vendor/Plaid security questionnaires. |
| [Risk Register](risk-register.md) | Living | The "Identify" companion to the InfoSec policy: rated risks (R-01…R-07) mapped to mitigations, with residual ratings and owners. |
| [Incident Response Runbook](incident-response.md) | Living | Step-by-step incident procedure: detect, triage/severity, contain, recover, notify (incl. Plaid), and post-mortem. |
| [Plaid Security Questionnaire](plaid-security-questionnaire.md) | Living | Ready-to-paste answers for Plaid's production-access security questionnaire, each mapped to a real control with an honest Implemented/Operator/Planned status, plus the open items to disclose truthfully. |
| [MVP 0 Backend Design](mvp0-backend-design.md) | Living | Implementation-ready backend data model, forecast, decision, architecture, and UI-facing contract. |
| [MVP 0 Test Fixtures](mvp0-test-fixtures.md) | Living | Representative deterministic fixture scenarios with expected outcomes. |
| [Plaid Sandbox Scaffold](plaid-sandbox.md) | Living | Server-only read-only Plaid Sandbox setup, endpoints, safety boundaries, and UI Link handoff. |
| [Coordination Workspace](../coordination/README.md) | Living | Shared backend/UI status, handoffs, implementation decisions, and UI/backend contract summary for parallel assistant work. |

## Maintenance Rules

- Update `status.md` whenever the active phase, next work, or key risks change.
- Update `roadmap.md` when MVP scope or sequencing changes.
- Add a new entry to `decisions.md` for material product, architecture, data, or compliance decisions.
- Keep `product-charter.md` stable. Change it only when the core product direction changes by explicit decision.
- Keep `backlog.md` tactical and actionable. Move completed or deferred items out of the active MVP section as work progresses.
- Use `../coordination/` for active backend/UI handoffs so parallel assistant work does not duplicate or conflict.
