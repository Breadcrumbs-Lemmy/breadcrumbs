# Plaid Security Questionnaire — Answer Sheet

Status: Living
Last updated: 2026-08-09
Owner: `Lemuel Mutah — Owner & Maintainer (sole developer)`
Companion to: [Information Security Policy](information-security-policy.md), [Risk Register](risk-register.md), [Incident Response Runbook](incident-response.md)

> **Purpose.** Ready-to-paste answers for Plaid's production-access security
> questionnaire, each mapped to the real control in the codebase. Every answer
> carries an honest status so nothing is attested that is not true:
>
> - **Implemented** — in place and verifiable in the code (source referenced).
> - **Operator** — enforced by whoever self-hosts the deployment, not by app code.
> - **Planned** — a committed gap, not yet in place. Answer these truthfully; do
>   not claim a control you have not built.
>
> **Context Plaid should know up front.** Breadcrumbz is a **read-only** personal
> finance app (no payments, transfers, or money movement) that can run **hosted**
> or **self-hosted** by the end user. Where a control depends on the deployment
> environment, that is called out as **Operator** and covered by the
> shared-responsibility model in the InfoSec policy §2 and §11.

---

## A. Data handling & storage

**Q. Do you store data received from the Plaid API? If so, what?**
Yes — the minimum needed for the product: account metadata (names, types,
balances), transactions, institution names, and the Plaid **access token** and
item id per connection. We do **not** store Plaid credentials/PINs (those never
reach us — Plaid Link handles them), and we do not store data for products we
don't use. **Status: Implemented.** Source: `plaid/token-store.ts`,
`local/store.ts`.

**Q. Do you encrypt Plaid data at rest?**
Yes. Both the Plaid **access tokens** and the persisted **account/transaction
store** are encrypted at rest with **AES-256-GCM** (256-bit key from
`BREADCRUMBZ_ENCRYPTION_KEY`, random 96-bit IV per record, GCM auth tag,
domain-separating additional-authenticated-data), decrypted only in memory at
use time. The key lives in the environment, never in the datastore. **Status:
Implemented.** Source: `crypto/field-cipher.ts`, `plaid/token-store.ts`,
`local/store.ts`. Underlying disk/volume encryption of the host is an
**Operator** control (policy §11).

**Q. What is your data retention and deletion policy?**
Data is retained while the account is active and erased on account deletion.
Three deletion paths exist in-app: a user can **remove a single Plaid connection**
(`DELETE /api/plaid/connections/:connectionId`, deletes its stored access token); a user can
**delete their whole account** (`DELETE /api/v1/auth/me`, re-authenticated with
the current password); and an admin can **delete any account**
(`DELETE /api/v1/admin/users/:id`) or **disable** one (revokes all sessions,
reversible). Account deletion removes the user's identity **and** erases
everything the user id owns — Plaid tokens, the per-user transaction store, and
assistant memory — with last-admin and single-user-owner guards so a deployment
can't be bricked. The formal per-data-class schedule is
[data-retention-schedule.md](data-retention-schedule.md). **Status: Implemented.**
Source: `auth/service.ts`, `http/auth-routes.ts`, `http/server.ts`,
`http/plaid-routes.ts`; tests `tests/account-deletion.test.ts`.

**Q. Do you share Plaid data with any third parties / subprocessors?**
Only the AI assistant provider (Anthropic) may receive user financial data that
is within the scope of a question the user asks the assistant, to answer it. A
**local (on-box) model option** exists to avoid sending data off the machine at
all. No other subprocessors (no analytics, error-tracking, ad, or email vendors).
The full inventory is maintained in [subprocessors.md](subprocessors.md).
**Status: Implemented.** Source: policy §9; [subprocessors.md](subprocessors.md).

---

## B. Encryption in transit

**Q. Do you encrypt data in transit between clients and servers using TLS 1.2 or
better? (Item 6)**
Yes — **TLS 1.2+** is required for all client↔server traffic; browser origins
are further restricted by a CORS allowlist and loopback origins are not
blanket-trusted in production. TLS termination in front of the API is an
**Operator** responsibility for self-hosted deployments (and the Company's
responsibility for any hosted instance). **Status: Operator (TLS) / Implemented
(CORS + production origin hardening).** Source: policy §4.3, §11;
`http/server.ts`; `docs/running-breadcrumbz.md`.

**Q. Do you use TLS for connections to Plaid and other third parties?**
Yes — the Plaid SDK/API and Anthropic API are reached over HTTPS/TLS by default.
**Status: Implemented.**

---

## C. Access control & authentication

**Q. What access controls limit access to production assets and sensitive data?
(Item 3)**
Role-based access with least privilege, enforced in application code:
- **Deny-by-default authorization** — a single `onRequest` hook authenticates
  every `/api` route; routes are private unless explicitly allowlisted
  (fail-safe direction). Source: `auth/middleware.ts`.
- **Per-user data isolation by construction** — each request can only reach the
  store for its authenticated `principal.userId`; cross-user reads are impossible
  by design and regression-tested. Source: `plaid/token-store.ts`,
  `local/store-provider.ts`, `tests/plaid-isolation.test.ts`.
- **Least-privilege admin roles** — admin/user separation; the last active admin
  cannot be demoted/disabled (lockout-proof). Source: `auth/service.ts`.
- **Operator-level** access to the host/datastore is limited to personnel who
  need it (policy §8). **Status: Implemented (app) / Operator (host).**

**Q. How are passwords stored?**
**scrypt**, memory-hard (16 MiB/hash), per-hash random salt, self-describing cost
parameters for zero-migration re-hashing. Login verification is constant-time
(`timingSafeEqual`) and verifies against a dummy hash for unknown emails so
"no such account" and "wrong password" are timing-indistinguishable. **Status:
Implemented.** Source: `auth/password.ts`, `auth/service.ts`.

**Q. How are sessions managed?**
Bearer/cookie sessions with a TTL; session tokens are stored **sha256-hashed**
(the raw token is never persisted); **all** sessions are revoked on password
change or account disable. **Status: Implemented.** Source: `auth/service.ts`.

**Q. Do you provide MFA for consumers before Plaid Link is surfaced? (Item 4)**
Yes. Multi-factor is **TOTP** (RFC 6238, authenticator app — no SMS, so no new
subprocessor and no SIM-swap exposure) and is **enforced as a step-up in front of
Plaid Link**: the server refuses to mint a Link token or exchange a public token
for a multi-user session that has not cleared a current TOTP code within a
15-minute window, so bank-linking cannot even be surfaced first. Enrollment is
two-step (a secret is issued, then the factor is only activated after a first
verified code) so setup can never lock a user out, and TOTP secrets are encrypted
at rest with the same AES-256-GCM cipher, bound per-user by AAD. Single-user
(self-hosted, no-login) mode has no second identity to challenge and is exempt.
**Status: Implemented.** Source: `auth/totp.ts`, `auth/service.ts`,
`http/plaid-routes.ts`, `http/auth-routes.ts`; tests `tests/totp.test.ts`,
`tests/mfa-plaid-gate.test.ts`; policy §4.1, risk R-03.

**Q. How do you protect against brute-force / credential stuffing?**
Per-account lockout (10 failures / 15 min → 15-min lock) layered beneath a per-IP
rate limit (default 300 req/min); timing-flat login for unknown emails.
**Status: Implemented.** Source: `auth/service.ts`, `http/server.ts`,
`tests/auth-lockout.test.ts`.

---

## D. Secret management

**Q. How are secrets (Plaid keys, access tokens, API keys) managed?**
Secrets are read from the **environment only**, never committed (`.env` is
git-ignored); config validation maps issues by path **without echoing the
secret value**, so a bad secret cannot land in a log line. Plaid access tokens
are encrypted at rest (see §B). **Status: Implemented.** Source: `plaid/config.ts`,
`.env.example`, `crypto/field-cipher.ts`. **Planned:** move the at-rest
encryption key into a secrets manager / KMS rather than a plain env var
(policy §12, risk R-02).

---

## E. Network & infrastructure security

**Q. How is your network secured (firewalls, segmentation, exposure)?**
Secure application defaults (deny-by-default auth, CORS allowlist, production
origin hardening). Network-level controls — firewall, restricted exposure, not
publishing the API broadly — are **Operator** responsibilities documented in the
operator checklist. **Status: Implemented (app defaults) / Operator (network).**
Source: policy §11; `http/server.ts`.

**Q. Is the datastore encrypted / access-restricted at the host level?**
Application-level field encryption protects tokens and transaction data (§B);
the file datastore is written atomically at mode **0600** (owner-only). Full-disk
/ volume encryption of the host is **Operator** (policy §11). **Status:
Implemented (app) / Operator (host).** Source: `persistence/atomic-file.ts`.

---

## F. Secure development & vulnerability management

**Q. Do you follow a secure SDLC / review code before merge?**
Yes — changes land via pull request with self-review and automated checks (tests,
CI, dependency scan) before merge; as a solo project there is no second human
reviewer. The auth surface is deliberately concentrated in one auditable service;
automated tests cover security-relevant behavior (auth, per-user isolation, Plaid
config secret-scrubbing, at-rest encryption, persistence durability). **Status:
Implemented.** Source: policy §4.4; `packages/server/tests/`.

**Q. Do you run dependency vulnerability scanning?**
Yes — `pnpm audit` (failing on **high/critical** advisories) runs in CI on every
push and pull request, and again on a **weekly schedule** so an advisory disclosed
after a dependency merged still turns the build red. **Status: Implemented.**
Source: `.github/workflows/dependency-audit.yml`, root `audit` script; policy
§4.4, §5; risk R-05.

**Q. Do you perform penetration testing / vulnerability assessments?**
**Planned** — no third-party pen test has been performed yet. Answer truthfully;
do not claim one. **Status: Planned.**

---

## G. Logging, monitoring & incident response

**Q. What logging and monitoring do you have?**
The app emits boot-time security warnings and `[fatal]` error lines with secrets
excluded by design; the primary brute-force/credential-stuffing signal is
repeated **HTTP `401`/`429`** responses (auth failure and rate-limit/lockout),
visible in the operator's reverse-proxy/access log. A documented **log-review
procedure with alerting thresholds** now covers these signals
([logging-and-monitoring.md](logging-and-monitoring.md)). We are candid that the
app does **not** yet emit a per-request audit log (Fastify `logger: false`) — that
is a committed gap, and capturing access logs / wiring automated alerts is an
**Operator** responsibility. **Status: Implemented (signals + documented
procedure) / Operator (log capture + alerting) / Planned (native request
logging).** Source: policy §5; [logging-and-monitoring.md](logging-and-monitoring.md).

**Q. Do you have an incident response plan, and does it include notifying Plaid?**
Yes — a documented runbook: detect → triage/severity → contain (revoke sessions,
rotate exposed secrets, remove/re-link the affected Plaid Item) → recover →
**notify affected users and Plaid per Plaid's incident-reporting requirements** →
post-mortem. **Status: Implemented (documented).** Source:
[incident-response.md](incident-response.md), policy §6. **Operator action
needed:** confirm Plaid's incident-reporting channel and window per your Plaid
agreement (named contacts are filled in).

---

## H. Business continuity & backups

**Q. Do you keep backups, and are they tested?**
The datastore uses atomic writes, write-data-before-references ordering, and
staged restore to survive crashes without corruption. Regular, **tested backups**
are an **Operator** responsibility; there is no application-managed backup.
**Status: Implemented (crash-durability) / Operator (backups).** Source:
`persistence/atomic-file.ts` (atomic writes, ordering), `persistence/backup.ts`
(staged restore); policy §11; risk R-06.

---

## I. Organizational / governance

**Q. Do you have a documented information security policy?**
Yes — a documented policy operationalized to identify → mitigate → monitor risks,
with a companion living risk register and incident-response runbook; reviewed and
signed off by the accountable owner on 2026-08-09 (policy v1.0). **Status:
Implemented.** Source:
[information-security-policy.md](information-security-policy.md),
[risk-register.md](risk-register.md).

**Q. Employee security (background checks, access reviews, security training)?**
Access review cadence is defined (policy §7, annually for a solo maintainer).
Formal HR-side controls
(background checks, security training) depend on the operating entity and are
**Operator / Planned** — answer per your actual organization; do not overstate.
**Status: Planned / Operator.**

**Q. Vendor / subprocessor management?**
Subprocessors (Plaid, Anthropic) are documented with the data shared and purpose
in a formal, maintained list ([subprocessors.md](subprocessors.md)); adding or
changing one is a recorded material decision and must be reflected there before it
goes live. Per-provider **agreement** review is on the review cadence and depends
on the operating entity. **Status: Implemented (formal list + governance) /
Operator (per-provider agreement review).** Source:
[subprocessors.md](subprocessors.md); policy §9, §7; risk R-04.

---

## Summary of open items to disclose truthfully

These are the honest **"no / in progress"** answers — surface them rather than
overclaim; each is already tracked in the policy §12 and the risk register:

1. **Third-party penetration test** — not yet performed.
2. **Native per-request audit logging** — the app emits no request log today
   (`logger: false`); the brute-force signal lives in HTTP `401`/`429` status
   codes captured by the operator's reverse proxy. A documented review procedure
   and thresholds exist; native app-level logging with redaction is planned.
   *(policy §5, [logging-and-monitoring.md](logging-and-monitoring.md))*
3. **Secrets manager / KMS** for the at-rest key (currently an env var).
   *(risk R-02)*
4. **Operator-dependent controls** — TLS, host disk encryption, firewall,
   tested backups, log capture + automated alerting, HR/background checks — true
   for self-hosted deployments; the Company owns them for any hosted instance.
   *(policy §11)*

*Resolved since the last revision:* MFA enforcement (TOTP step-up before Plaid
Link); **self-serve + admin account deletion** with full per-user data erasure
(`DELETE /api/v1/auth/me`); **dependency scanning in CI** (`pnpm audit`,
high/critical, per-push + weekly); and the formal **data-retention schedule**,
**subprocessor list**, and **log-review procedure** docs.

---

*Answer sheet tailored to the Breadcrumbz codebase as of the date above. Verify
each status against the current code before submitting, and have the accountable
security owner review it. Not legal or compliance advice.*
