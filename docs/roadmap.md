# Roadmap

Status: Living  
Last updated: 2026-08-04

> Resequenced 2026-08-04 for `D-011`. Cross-account spending visibility is now
> the product; affordability is a supporting tool. The practical effect is that
> **transactions, categorisation, and multi-institution aggregation move onto the
> critical path**, and the Plaid work previously scheduled for MVP 2 now gates
> the product's main screen rather than enhancing it.
>
> MVP 0 is complete and remains valid. Nothing already built is discarded.

## Sequencing After D-011

| Phase | Was | Now |
| --- | --- | --- |
| MVP 0 | Deterministic affordability foundation | **Complete.** Unchanged and still correct. Its output becomes a supporting surface rather than the home screen. |
| MVP 1 | Local product prototype | **Spending visibility on imported data.** Transactions, categorisation, merchant normalisation, cross-account rollups, and the spending home screen. Affordability rides along, already built. |
| MVP 2 | Read-only Plaid beta | **Multi-institution aggregation.** Now delivers the core product rather than enhancing it. The product's highest risk concentrates here. |
| MVP 3 | AI explanation layer | Scope unchanged. Now explains spending patterns as well as affordability results. |

The single biggest consequence: the product previously had a demoable main screen with zero transactions. It no longer does. Transaction data is now a prerequisite for the product existing at all, not an input to one of its features.

## MVP 0: Deterministic Affordability Foundation

Status: Complete. Retained as the affordability capability.

Goal: validate the core product model before live bank-data integration or AI chat.

Scope:

- Documentation workspace and product charter.
- Initial target user: individual salaried user paid bi-weekly, with monthly spending summaries and day-level forecast timing.
- Manual or seeded financial inputs for accounts, income, bills, recurring expenses, goals, and planned purchases.
- Deterministic forecast engine for near-term cash flow and obligation coverage.
- Decision engine that answers "Can I afford this?" using projected balance, timing, required buffer, upcoming obligations, and goal impact.
- Transparent explanation of assumptions and contributing factors.
- Initial pattern-detection model using manual or sample transactions for subscriptions, rising categories, duplicate services, frequent small purchases, and goal conflicts.
- Non-judgmental savings impact language.
- Clear read-only and non-advice product boundaries.

Exit criteria:

- A user can model a purchase and see an affordability answer with supporting cash-flow reasoning.
- Forecast and decision outputs are deterministic and testable.
- Pattern insights explain potential savings impact without judgment.
- Product boundaries are visible in copy and behavior.

## MVP 1: Local Product Prototype

Goal: turn the deterministic foundation into a usable local product experience.

Scope:

- Local persistence for accounts, income, expenses, goals, categories, and transactions.
- CSV or file-based transaction import.
- Realistic multi-account, multi-institution transaction fixtures before live Plaid data is required.
- Category normalization and recurring-transaction detection.
- Cross-account pattern detection across imported data.
- Cross-institution spending rollups, period comparisons, and per-account attribution for the spending home.
- Scenario modeling for planned purchases, bill timing, savings goals, and recurring-expense changes.
- User-facing views for affordability, cash-flow forecast, pattern insights, and assumptions.
- Test coverage for forecast logic, categorization, pattern detection, and decision output.

Exit criteria:

- A user can use imported or manually entered data across accounts.
- The product produces repeatable affordability answers and insight summaries.
- The user can inspect why a recommendation or warning appeared.

## MVP 2: Read-Only Plaid Beta

Goal: connect real financial data while preserving read-only decision support.

Scope:

- Plaid Link integration for read-only account, balance, and transaction access.
- Multi-institution account aggregation.
- Server-side aggregation over multiple Plaid connections using canonical account and transaction mappings.
- Consent, connection status, sync health, and disconnection flows.
- Secure token handling and data-retention controls.
- Forecast and pattern detection using real transaction data.
- Error handling for stale balances, missing transactions, duplicate accounts, and disconnected institutions.
- Privacy and non-advice copy reviewed against the product boundaries.

Exit criteria:

- A beta user can connect accounts through Plaid and receive read-only affordability and pattern insights.
- Data freshness, assumptions, and limitations are visible.
- No product flow writes to or modifies financial accounts.

## MVP 3: AI Explanation and Exploration Layer

Goal: add AI only after deterministic financial reasoning is stable.

Scope:

- AI chat over computed financial facts, forecasts, and pattern insights.
- Answers grounded in deterministic engine outputs and user-visible assumptions.
- Conversational exploration of tradeoffs, scenarios, savings impact, and goal conflicts.
- Guardrails against personalized investment, tax, legal, or fiduciary advice.
- Generated summaries, digests, and "what changed?" explanations.
- Evaluation set for affordability questions, advice-boundary handling, and explanation quality.

Exit criteria:

- AI can explain deterministic results without replacing the forecast or decision engine.
- Chat responses cite or reference the relevant computed facts.
- Advice boundaries are enforced and tested.
