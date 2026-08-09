# Product Charter

Status: Stable  
Last updated: 2026-08-04

> Amended 2026-08-04 by explicit user decision. See `D-011`. The central product
> is now cross-account spending visibility. Affordability remains a core
> capability but is no longer the organising question. `D-001` is superseded.

## Product Identity

AI Finance Operating System is an AI Financial Operating System focused on financial understanding and budgeting. Its central product question is:

> Where is my money going?

The product connects every account the user holds, across every institution, and turns the combined transaction history into a clear, continuous picture of their spending.

Its second question, reachable from anywhere in the product, is:

> Can I afford this?

Affordability is answered against the same aggregated picture. Understanding spending is what makes an affordability answer trustworthy, and the deterministic engine that produces it remains unchanged.

## Locked Product Direction

- The product's primary surface is aggregated spending across all connected accounts and institutions.
- A user must be able to see, without configuration, what they spent, where it went, and how that compares to their recent normal.
- Affordability is a supporting capability invoked against a planned purchase. It is not the product's home.
- The initial product is read-only and decision-supportive.
- It must not provide personalized investment, tax, legal, or fiduciary advice.
- The product must help users answer "Can I afford this?" before, during, or after a spending decision.
- The product must find cross-account spending patterns, including:
  - subscriptions,
  - rising categories,
  - duplicate services,
  - frequent small purchases,
  - behaviors that conflict with user goals.
- Pattern explanations must be non-judgmental and focus on potential savings impact, tradeoffs, and user goals.
- Plaid is planned as a read-only bank-data integration.
- A deterministic forecast and decision engine must come before AI chat.
- AI should explain, summarize, and help users explore deterministic results. It should not be the first system responsible for financial calculations.

## Product Principles

- Show the whole picture. A single-institution view is not the product.
- Be useful before being conversational.
- One screen, one job. A surface that answers three questions at once answers none of them.
- Prefer deterministic financial calculations over opaque model output.
- Show assumptions, inputs, and uncertainty clearly.
- Treat spending behavior without shame or moral judgment.
- Give users decision support, not financial authority transfer.
- Start read-only. Do not move money, initiate payments, or make account changes.
- Make the product understandable enough that a user can see why an affordability answer was produced.

## Initial Boundaries

The initial product is not:

- a brokerage or investment advisor,
- a tax advisor,
- a legal advisor,
- a fiduciary,
- a payment initiator,
- a debt settlement product,
- a system that writes changes to bank or financial accounts.

## Charter Change Policy

This document is intentionally stable. Changes should be made only when product direction changes materially, and each material change should be recorded in `decisions.md`.
