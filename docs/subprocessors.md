# Subprocessor List

Status: Living
Last updated: 2026-08-09
Owner: `Lemuel Mutah — Owner & Maintainer (sole developer)`
Companion to: [Information Security Policy](information-security-policy.md) §9, [Plaid Security Questionnaire](plaid-security-questionnaire.md) §A/§I, [Risk Register](risk-register.md) R-04

> **Purpose.** The formal, standalone subprocessor inventory referenced by policy
> §9. It names every third party that may process user data, exactly what data
> each receives, why, and how the relationship is reviewed — so the "who do you
> share data with?" questionnaire answer maps to a maintained list rather than a
> sentence.

---

## 1. Current subprocessors

| # | Subprocessor | Data shared | Purpose | Trigger for sharing | Avoidable? |
| --- | --- | --- | --- | --- | --- |
| 1 | **Plaid Inc.** | Bank-login credentials flow **through Plaid** (never to us); we receive account metadata, balances, transactions, institution names, and a per-connection access token | Read-only financial-account aggregation | User links a bank via Plaid Link | No — Plaid is the aggregation provider |
| 2 | **Anthropic PBC** | User financial data **within the scope of a question** the user asks the assistant | AI assistant answers | User sends an assistant message (hosted model configured) | **Yes** — a local (on-box) model option keeps data on the machine |

No other third party receives user data. Analytics, error-tracking, ad, or
email-marketing subprocessors are **not** used. If one is ever added, it is a
material decision recorded in [`decisions.md`](decisions.md) and added here
**before** it goes live.

---

## 2. Data-minimization notes

- **Plaid** — we request only the products we use and store only what the product
  needs (policy §9, questionnaire §A). We never store bank credentials/PINs; those
  are handled by Plaid Link and never reach us.
- **Anthropic** — the assistant is scoped to the asking user's own data, and only
  the data relevant to the current question is sent. Operators who must avoid any
  off-box data flow can configure the **local model provider**, which is
  loopback-enforced so financial data does not leave the host. See
  [data-quality-and-safety.md](data-quality-and-safety.md).

---

## 3. Governance

- **Agreements** — each subprocessor is covered by its own agreement/terms and
  security posture; the operating Company is responsible for having the
  appropriate data-processing terms in place with each. *Operator / Company.*
- **Adding or changing a subprocessor** — a material decision, recorded in
  [`decisions.md`](decisions.md), reflected here, and disclosed to users whose
  data flows change.
- **Review cadence** — this list and each provider's agreement/security posture
  are reviewed on the policy §7 cadence (quarterly with the risk register) and on
  any subprocessor change. *Review of the formal per-provider agreements is
  **Planned / Operator** — it depends on the operating entity.*
- **User transparency** — users are informed of these data flows; the local-model
  option is offered as the privacy-preserving default path for the assistant.

---

## 4. Change log

- 2026-08-09 — Initial formal list extracted from policy §9 (Plaid, Anthropic).
