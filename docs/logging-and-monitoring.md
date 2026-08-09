# Logging, Monitoring & Log-Review Procedure

Status: Living
Last updated: 2026-08-09
Owner: `Lemuel Mutah — Owner & Maintainer (sole developer)`
Companion to: [Information Security Policy](information-security-policy.md) §5, [Plaid Security Questionnaire](plaid-security-questionnaire.md) §G, [Incident Response Runbook](incident-response.md), [Risk Register](risk-register.md) R-03/R-07

> **Purpose.** The documented periodic log-review procedure and alerting
> thresholds referenced by policy §5. It states honestly **what the application
> emits today**, **where the security signals actually appear**, **who reviews
> them and how often**, and **what thresholds trigger action** — so the
> "logging and monitoring" questionnaire answer maps to a real procedure rather
> than an aspiration.
>
> Status legend matches the rest of the security docs: **Implemented**,
> **Operator**, **Planned**.

---

## 1. What the application emits today (be precise)

An honest inventory — the app does **not** ship a request/audit log out of the
box, so this procedure is deliberately built around the signals that *do* exist:

| Signal | Where it appears | Status |
| --- | --- | --- |
| Boot-time security warnings — missing `BREADCRUMBS_ENCRYPTION_KEY`, risky agent config (local chat + hosted extractor) | process stdout/stderr (`console.warn` in `http/server.ts`, `main.ts`) | Implemented |
| Fatal errors — uncaught exception, unhandled rejection, failed data migration, invalid Plaid config | process stderr (`[fatal]` / `[data]` in `main.ts`) | Implemented |
| **Auth failure** (bad password, unknown email, locked account) | **HTTP `401`** (and **`429`** once locked) returned to the client — visible in the operator's **reverse-proxy / access log**, not in an app log | Implemented (as HTTP status) |
| **Rate-limit trip** (per-IP flood) | **HTTP `429`** with a `RATE_LIMITED` body — same: visible in the access log | Implemented (as HTTP status) |
| Per-request structured log (method, path, status, latency) | **Not emitted** — Fastify is constructed with `logger: false` (`http/server.ts`) | **Planned** |

**Key honesty point:** the brute-force / credential-stuffing signal is real, but
today it lives in **HTTP status codes** (401/429) observable to whatever sits in
front of the API (reverse proxy, load balancer), **not** in an application audit
log. Any review procedure that needs per-request history therefore depends on the
**operator** capturing access logs at the proxy. Enabling native app-level
request logging with secret redaction is **Planned** (§5 below).

By design, **secrets are never logged**: config validation maps issues by path
without echoing values (`plaid/config.ts`), and the safe error handler
(`http/errors.ts`) returns generic messages with no internals. So nothing in this
pipeline can leak a token or password. **Status: Implemented.**

---

## 2. Review procedure (who, what, how often)

| Cadence | Reviewer | What to review | Looking for |
| --- | --- | --- | --- |
| **Weekly** | Security owner (or delegate) | Reverse-proxy access log: counts of `401` and `429` by source IP and by target account/route | Spikes vs. baseline; a single IP or a spread hitting `/api/v1/auth/login` |
| **Weekly** | Engineering | Process stderr / container logs for `[fatal]` and `[security]` lines | Any fatal since last review; any deployment still running without an encryption key |
| **Per release** | Engineering | `pnpm audit` result (also enforced in CI — see [dependency-audit workflow](../.github/workflows/dependency-audit.yml)) | New high/critical advisories |
| **Quarterly** | Security owner | User & admin account list; MFA-enrollment coverage | Stale accounts, unexpected admins |

The weekly reviews are lightweight (minutes) and exist so an attack in progress
is noticed in days, not after an incident. Findings that cross a threshold below
escalate into the [incident-response runbook](incident-response.md).

---

## 3. Alerting thresholds (when to act)

These are the concrete trip-wires. They are **operator-tunable** to the
deployment's normal traffic; the numbers below are sane starting defaults.

| Condition | Threshold | Action |
| --- | --- | --- |
| `401`s against one account | ≥ 10 in 15 min | Expected app lockout engages (10 fails → 15-min lock). Confirm lockout fired; if the source persists, block the IP at the proxy. |
| `401`/`429` from one source IP across many accounts | ≥ 50 in 15 min | Credential-stuffing pattern — block the IP at the proxy; verify per-IP rate limit is active; open an incident if widespread. |
| Global `429` rate | Sustained > baseline for 10 min | Possible flood or misconfigured client — investigate source; consider tightening the rate limit. |
| `[fatal]` line in process logs | Any occurrence | Page on-call; the process may have exited — check service health and restart/roll back. |
| `[security]` "encryption key not set" in production | Any occurrence | Misconfiguration — set `BREADCRUMBS_ENCRYPTION_KEY` and restart; treat prior at-rest data as unencrypted. |
| New **high/critical** dependency advisory | Any (CI fails the build) | Patch or mitigate before release; see [risk R-05](risk-register.md). |
| `5xx` (`INTERNAL_SERVER_ERROR`) rate | > baseline | Investigate for an availability or logic fault (not secret leakage — bodies are generic). |

Automated alerting on these thresholds (wiring the access log / metrics into a
pager) is an **Operator** responsibility — the app exposes the signals; the
deployment decides how to be paged. `GET /health` is available for uptime checks.

---

## 4. Retention of logs

Application/access logs contain no secrets (§1) and are retained on the
operator's rotation — **≤ 90 days recommended** (see
[data-retention-schedule.md](data-retention-schedule.md) §2). Logs are not a
system of record and must never be mined to reconstruct financial data.
**Status: Operator.**

---

## 5. Committed gaps

- **Native app request/audit logging** — turn Fastify's logger on (or add an
  audit hook) that records method, path, status, principal id, and latency with
  **secret redaction**, so the auth-failure/rate-limit signals live in an app log
  the operator can ship anywhere, independent of the proxy. **Planned.**
- **Automated alerting** — ship the signals above into a metrics/alerting backend
  with the thresholds pre-wired. **Operator / Planned.**

---

## 6. Review

Reviewed on the policy §7 cadence (quarterly), and whenever logging behavior,
the auth flow, or the thresholds change.
