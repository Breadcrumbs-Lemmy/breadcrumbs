# Information Security Policy

| | |
| --- | --- |
| **Document owner** | `{SECURITY OWNER — name / role}` |
| **Organization** | `{LEGAL ORG NAME}` ("the Company"), operator of Breadcrumbs |
| **Version** | 0.1 (draft) |
| **Effective date** | 2026-08-09 |
| **Next review** | 2027-02-09 (reviewed at least every 6 months and after any material change) |
| **Status** | Draft — pending review and sign-off by an accountable owner before use as a formal attestation. |

> **How to read this document.** Every control below carries an explicit status:
> **Implemented** (in place and verifiable in the codebase, with a source
> reference), **Operator** (enforced by whoever deploys the self-hosted system,
> not by application code), or **Planned** (a committed gap, not yet in place).
> This honesty is deliberate: the value of a policy on a vendor questionnaire is
> that it can be trusted, so nothing here is marked done unless it is.

---

## 1. Purpose and scope

This policy documents how the Company identifies, mitigates, and monitors
information security risks relevant to Breadcrumbs — a personal-finance
application that connects to users' financial accounts (via Plaid) or ingests
their statements, and provides spending analysis and an AI assistant scoped to
each user's own data.

**In scope:** the Breadcrumbs application (`packages/core`, `packages/server`,
`apps/web`), the data it processes, the credentials and third-party API secrets
it holds, the environments it runs in, and the people who develop and operate it.

**Sensitive data handled:**

| Class | Examples | Sensitivity |
| --- | --- | --- |
| Financial account data | balances, transactions, institution names | High |
| Third-party secrets | Plaid access tokens, Plaid/Anthropic API keys | Critical |
| Authentication data | password hashes (scrypt), session tokens | Critical |
| User identity | email, display name | Moderate |

Breadcrumbs is **read-only** with respect to financial accounts: it never
initiates payments, transfers, or any movement of funds. This materially narrows
the risk surface and is a deliberate product boundary.

---

## 2. Roles and responsibilities

- **Security owner** (`{NAME}`) — owns this policy, approves changes, runs the
  periodic risk review, and coordinates incident response.
- **Engineering** — implements and maintains technical controls, reviews code
  before merge, and keeps dependencies patched.
- **Operator / deployer** — for self-hosted deployments, the party running the
  system is responsible for the **Operator** controls named throughout (TLS
  termination, host/OS hardening, disk encryption, backups, network exposure).
  Where the Company runs a hosted instance, the Company is the operator.

Because Breadcrumbs is self-hostable, security is a **shared responsibility**:
the application ships secure defaults; the operator is responsible for the
environment it runs in. Section 11 lists the operator's obligations explicitly.

---

## 3. Risk management (Identify)

The Company maintains a lightweight, living risk assessment covering at minimum:

- **Unauthorized data access** — another user's or an outsider's access to a
  user's financial data.
- **Credential / secret compromise** — theft of password hashes, session
  tokens, or third-party API secrets (Plaid, Anthropic).
- **Third-party / subprocessor risk** — data shared with Plaid and with the AI
  model provider (see §9).
- **Dependency and supply-chain vulnerabilities** — flaws in npm packages.
- **Data loss / corruption** — loss of the JSON-file datastore that is the
  system of record.

Each risk is rated (likelihood × impact), mapped to the mitigations in §4, and
reviewed on the cadence in §7. New risks are added when features, data flows, or
third parties change. **Status: Planned** — the risk register is to be
maintained as a living document alongside this policy (`docs/risk-register.md`).

---

## 4. Security controls (Mitigate)

### 4.1 Authentication and access control

| Control | Detail | Status | Source |
| --- | --- | --- | --- |
| Password hashing | scrypt, memory-hard (16 MiB / hash), per-hash random salt, self-describing cost parameters for zero-migration re-hashing | Implemented | `packages/server/src/auth/password.ts` |
| Constant-time verification | `timingSafeEqual`; login verifies against a dummy hash for unknown emails so "no such account" and "wrong password" are indistinguishable by timing | Implemented | `auth/password.ts`, `auth/service.ts` |
| Brute-force protection | per-account lockout (10 failures / 15 min → 15 min lock) layered beneath a per-IP rate limit (default 300 req/min) | Implemented | `auth/service.ts`, `http/server.ts` |
| Deny-by-default authorization | a single `onRequest` hook authenticates every `/api` request; routes are protected unless explicitly added to a public allowlist (fail-safe direction) | Implemented | `auth/middleware.ts` |
| Per-user data isolation | each user's data lives in an isolated store keyed by user id; enforced and regression-tested | Implemented | `plaid/token-store.ts`, `tests/plaid-isolation.test.ts` |
| Session lifecycle | bearer/cookie sessions with TTL; **all** sessions revoked on password change or account disable | Implemented | `auth/service.ts` |
| Least-privilege admin | role separation (admin/user); the last active admin cannot be demoted or disabled (lockout-proof) | Implemented | `auth/service.ts` |
| Multi-factor authentication | TOTP (RFC 6238, authenticator app) — no SMS/subprocessor. Two-step enrollment (secret issued, then activated on a first verified code, so setup can never lock the owner out). TOTP secrets encrypted at rest with the same AES-256-GCM field cipher, bound per-user by AAD. **Enforced as step-up in front of Plaid Link**: `link-token` and `exchange-public-token` refuse a multi-user session that has not cleared MFA within a 15-minute window (single-user mode has no login and is exempt). | Implemented | `auth/totp.ts`, `auth/service.ts`, `http/plaid-routes.ts`, `tests/totp.test.ts`, `tests/mfa-plaid-gate.test.ts` |

### 4.2 Secret and credential handling

| Control | Detail | Status | Source |
| --- | --- | --- | --- |
| Secrets from environment only | Plaid/Anthropic credentials are read from env, never committed; `.env` is git-ignored | Implemented | `plaid/config.ts`, `.env.example` |
| No secret leakage in logs/errors | config validation maps issues by path without echoing the offending value, so a bad secret cannot land in a log line | Implemented | `plaid/config.ts` |
| Encryption of Plaid tokens at rest | Plaid access tokens are encrypted at rest with AES-256-GCM (key from `BREADCRUMBS_ENCRYPTION_KEY`, bound to the connection id), decrypted only in memory at call time; the key lives in the environment, never in the datastore. Enabled by providing a key. | Implemented | `crypto/field-cipher.ts`, `plaid/token-store.ts` |
| Encryption of persisted transaction data at rest | The per-user statement/transaction store encrypts its entire persisted state (accounts, transactions, import batches) at rest with the same AES-256-GCM field cipher (key from `BREADCRUMBS_ENCRYPTION_KEY`, domain-separated by a state AAD), decrypted only in memory. Legacy plaintext files are read transparently and re-sealed on the next write; an encrypted file with no key fails loudly rather than silently returning empty. Enabled by providing a key. | Implemented | `crypto/field-cipher.ts`, `local/store.ts` |

### 4.3 Data protection

| Control | Detail | Status | Source |
| --- | --- | --- | --- |
| Encryption in transit | HTTPS/TLS terminated in front of the API; browser origins restricted by a CORS allowlist | Operator (TLS) / Implemented (CORS) | `docs/running-breadcrumbs.md`, `http/server.ts` |
| Durable persistence | atomic file writes; write-data-before-references ordering; staged restore — designed to survive crashes without corrupting the datastore | Implemented | `persistence/atomic-file.ts` (atomic writes/ordering), `persistence/backup.ts` (staged restore) |
| Data residency & consent | per-user Private-vs-Synced consent model; no third-party cloud storage of user data exists today (E2EE synced tier deferred) | Implemented (Private) / Planned (Synced) | `docs/data-quality-and-safety.md` |
| Encryption at rest | the datastore is protected by the host's disk/volume encryption | Operator | §11 |
| Backups | operator responsibility; see §11 | Operator | §11 |

### 4.4 Secure development

- Changes are code-reviewed before merge; the auth surface is deliberately
  concentrated in one auditable service so identity rules are easy to review.
- Automated tests cover security-relevant behavior (auth, per-user isolation,
  Plaid config secret-scrubbing, persistence durability). **Status: Implemented.**
- Dependency vulnerability scanning (`pnpm audit`, failing on high/critical
  advisories) runs in CI on every push and pull request, and again on a weekly
  schedule so an advisory disclosed after merge still turns the build red.
  **Status: Implemented** — `.github/workflows/dependency-audit.yml`, root `audit`
  script.

---

## 5. Monitoring and logging (Monitor)

- **Application logging** — the app emits boot-time security warnings and
  `[fatal]` error lines to the process log, with **secrets excluded by design**
  (§4.2). It does **not** emit a per-request audit log today (Fastify runs with
  `logger: false`); native request logging with redaction is a committed gap
  (§12, [logging-and-monitoring.md](logging-and-monitoring.md) §5).
- **Rate-limit and auth-failure signals** — repeated authentication failures and
  rate-limit trips surface as **HTTP `401`/`429`** responses, visible in the
  operator's reverse-proxy/access log, and are the primary indicator of
  credential-stuffing or brute-force attempts. A documented review procedure and
  alerting thresholds for these signals now exist. **Status: Implemented**
  (signals + documented procedure — [logging-and-monitoring.md](logging-and-monitoring.md));
  **Operator** (capturing access logs and wiring automated alerts).
- **Dependency monitoring** — `pnpm audit` runs in CI on every push/PR and weekly
  on a schedule, failing on high/critical advisories (§4.4). **Status:
  Implemented** — `.github/workflows/dependency-audit.yml`.
- **Access review** — periodic review of user accounts and admin roles.
  **Status: Planned** (cadence in §7).

---

## 6. Incident response

1. **Detect & report** — anyone who suspects an incident notifies the security
   owner immediately via `{CONTACT CHANNEL}`.
2. **Triage** — the security owner assesses scope: what data, whose, and whether
   third-party secrets (Plaid/Anthropic) are implicated.
3. **Contain** — revoke affected sessions (password change / disable revokes all
   sessions for a user), rotate any exposed API keys/secrets, and if a Plaid
   access token is implicated, remove the affected Item and re-link.
4. **Notify** — notify affected users and required parties (including **Plaid**,
   per Plaid's incident-reporting requirements) within the applicable timeframe.
5. **Recover & learn** — restore from backup if needed, then record a
   post-incident review capturing cause, fix, and preventive follow-ups.

**Status: Planned** — to be expanded into a standalone runbook
(`docs/incident-response.md`) with named contacts and Plaid's reporting details.

---

## 7. Policy governance and review cadence

| Activity | Cadence |
| --- | --- |
| Policy review & re-approval | Every 6 months, and after any material change |
| Risk register review | Quarterly |
| Dependency vulnerability scan | Per release, and monitored continuously |
| Access / admin-role review | Quarterly |
| Incident-response tabletop | Annually |

Material security and compliance decisions are recorded in
[`decisions.md`](decisions.md) per the docs maintenance rules.

---

## 8. Access control policy (summary)

- Access to production systems and secrets is limited to personnel who require it
  for their role (least privilege).
- Credentials are never shared; each user authenticates individually (except the
  intentional `single_user` self-hosted mode, where the deployment runs as its
  sole owner on the operator's own machine).
- Access is revoked promptly when no longer needed (admin can disable an account,
  which immediately revokes its sessions).

---

## 9. Third parties and subprocessors

| Provider | Data shared | Purpose |
| --- | --- | --- |
| **Plaid** | account-connection credentials/tokens flow through Plaid; the Company receives account & transaction data | Financial account aggregation (read-only) |
| **Anthropic** | user financial data within the assistant's scope may be sent to the model to answer the user's questions | AI assistant |

Each provider is covered by its own agreement and security posture. Users are
informed of these data flows. Adding or changing a subprocessor is a material
decision recorded in [`decisions.md`](decisions.md). A locally-hosted model
option is part of the architecture direction to reduce third-party data sharing.
The formal, maintained inventory — data shared, purpose, and review cadence per
provider — is [subprocessors.md](subprocessors.md).

---

## 10. Data retention and disposal

- User data is retained while the account is active and erased on account
  deletion. Deletion is **self-serve** (`DELETE /api/v1/auth/me`, re-authenticated
  with the current password) or **admin-initiated** (`DELETE /api/v1/admin/users/:id`);
  both remove the user's identity **and** erase everything the user id owns —
  Plaid tokens, the per-user transaction store, and assistant memory
  (`auth/service.ts`, `http/server.ts`). **Status: Implemented.**
- Third-party secrets are rotated on suspected compromise and on personnel change.
- The formal, per-data-class retention and disposal schedule is
  [data-retention-schedule.md](data-retention-schedule.md). **Status:
  Implemented (documented).**

---

## 11. Operator (self-hosting) responsibilities

For self-hosted deployments, the operator MUST:

- Terminate **TLS** in front of the API and never expose it in plaintext.
- Run on a host with **full-disk/volume encryption** (protects the datastore and
  stored tokens at rest).
- Restrict network exposure (firewall; do not expose the API broadly).
- Set `BREADCRUMBS_AUTH_MODE=multi_user` for any shared deployment (never rely on
  `single_user`, which requires no login, outside a private single-operator box).
- Configure `BREADCRUMBS_CORS_ORIGINS` to only trusted browser origins.
- Keep regular, tested **backups** of the datastore.
- Apply OS and dependency **security updates** promptly.

---

## 12. Known gaps (committed roadmap)

Tracked openly so this document stays honest:

1. ~~Application-level encryption of stored Plaid tokens and of the persisted
   transaction store.~~ **Done** — AES-256-GCM at rest for both the Plaid access
   tokens and the per-user transaction store (`crypto/field-cipher.ts`,
   `plaid/token-store.ts`, `local/store.ts`). Remaining: move the encryption key
   from a plain env var into a secrets manager / KMS.
2. ~~**MFA** enforcement.~~ **Done** — TOTP (authenticator app) enforced as a
   step-up in front of Plaid Link for multi-user sessions (`auth/totp.ts`,
   `http/plaid-routes.ts`). Remaining/optional: recovery/backup codes, and
   extending the step-up gate to other sensitive actions beyond bank-linking.
3. ~~**Dependency vulnerability scanning** wired into CI.~~ **Done** — `pnpm audit`
   (high/critical) on every push/PR and weekly (`.github/workflows/dependency-audit.yml`).
4. ~~Documented **log-review / alerting** procedure~~ **Done** —
   [logging-and-monitoring.md](logging-and-monitoring.md). Remaining: native
   app-level request logging with redaction (currently `logger: false`), and an
   **incident-response** runbook with named contacts.
5. ~~Living **risk register** and formal **data-retention** schedule.~~ **Done** —
   [risk-register.md](risk-register.md) and
   [data-retention-schedule.md](data-retention-schedule.md); a formal
   [subprocessor list](subprocessors.md) now exists too. Self-serve
   account-deletion (`DELETE /api/v1/auth/me`) closes the full-erasure gap.
6. **Secrets manager / KMS** for the at-rest encryption key (currently a plain env
   var), and a **third-party penetration test** (not yet performed).

---

*This is a starter policy tailored to the Breadcrumbs codebase as of the
effective date. It must be reviewed and approved by an accountable owner in the
Company before it is submitted as a formal security attestation. It is not legal
or compliance advice.*
