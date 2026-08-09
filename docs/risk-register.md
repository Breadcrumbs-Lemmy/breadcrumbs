# Risk Register

Status: Living
Last updated: 2026-08-09
Owner: `{SECURITY OWNER — name / role}`
Companion to: [Information Security Policy](information-security-policy.md) §3

This is the living risk assessment referenced by the InfoSec policy. It is the
"Identify" half of identify → mitigate → monitor: each risk is rated, mapped to
the controls that address it, and given a residual rating and an owner. Review
quarterly, and whenever a feature, data flow, or third party changes.

## Scoring

Likelihood and impact are rated **Low / Medium / High**. Residual risk is the
level that remains *after* the listed mitigations are applied.

| Rating | Meaning |
| --- | --- |
| Low | Tolerable; monitor. |
| Medium | Reduce where cost-effective; track to closure. |
| High | Requires a committed mitigation with a date. |

## Register

### R-01 — Unauthorized access to another user's financial data
- **Likelihood:** Low · **Impact:** High · **Inherent:** High
- **Mitigations (in place):** deny-by-default auth gate on every `/api` route
  (`auth/middleware.ts`); per-user store isolation by construction, keyed on
  `principal.userId` (`plaid/token-store.ts`); guessed-id reads return the same
  404 as missing data (no existence leak); regression-tested
  (`tests/plaid-isolation.test.ts`).
- **Residual:** Low
- **Owner:** Engineering · **Review:** Quarterly

### R-02 — Compromise of third-party secrets (Plaid access tokens, API keys)
- **Likelihood:** Medium · **Impact:** Critical · **Inherent:** High
- **Mitigations (in place):** Plaid access tokens **and** the per-user
  transaction store encrypted at rest with AES-256-GCM, key from environment,
  decrypted only in memory (`crypto/field-cipher.ts`, `plaid/token-store.ts`,
  `local/store.ts`); secrets loaded from environment only, never committed
  (`.env` git-ignored); config validation never echoes secret values into
  logs/errors (`plaid/config.ts`).
- **Gaps / planned:** move the encryption key into a secrets manager / KMS rather
  than a plain env var.
- **Residual:** Low–Medium
- **Owner:** Engineering + Operator · **Review:** Quarterly

### R-03 — Credential stuffing / brute-force against user accounts
- **Likelihood:** Medium · **Impact:** High · **Inherent:** High
- **Mitigations (in place):** scrypt memory-hard hashing with per-hash salt
  (`auth/password.ts`); per-account lockout (10 fails / 15 min → 15 min) beneath
  a per-IP rate limit (default 300/min); timing-flat login for unknown emails;
  all sessions revoked on password change/disable.
- **Gaps / planned:** MFA enforcement (scaffolded, not enforced — policy §12.2).
- **Residual:** Low–Medium
- **Owner:** Engineering · **Review:** Quarterly

### R-04 — Subprocessor data exposure (Plaid, Anthropic)
- **Likelihood:** Low · **Impact:** High · **Inherent:** Medium
- **Mitigations (in place):** read-only Plaid scope (no money movement);
  documented data flows (policy §9); local-model option for the assistant to
  avoid sending financial data off-box (loopback-enforced local provider).
- **Gaps / planned:** formal subprocessor list and per-provider agreement review
  on the §7 cadence.
- **Residual:** Medium
- **Owner:** Security owner · **Review:** On subprocessor change

### R-05 — Dependency / supply-chain vulnerability
- **Likelihood:** Medium · **Impact:** Medium · **Inherent:** Medium
- **Mitigations (in place):** code review before merge; minimal, pinned
  dependencies.
- **Gaps / planned:** `pnpm audit` / automated advisory scanning wired into CI
  and the release checklist (policy §12.3).
- **Residual:** Medium
- **Owner:** Engineering · **Review:** Per release

### R-06 — Data loss or corruption of the JSON-file datastore
- **Likelihood:** Low · **Impact:** High · **Inherent:** Medium
- **Mitigations (in place):** atomic writes, write-data-before-references
  ordering, staged restore — designed to survive crashes without corruption
  (`persistence/atomic-file.ts`).
- **Gaps / planned:** operator-owned regular, tested backups (policy §11); no
  application-managed backup exists.
- **Residual:** Medium
- **Owner:** Operator · **Review:** Quarterly

### R-07 — Insecure self-hosted deployment (plaintext exposure, open network)
- **Likelihood:** Medium · **Impact:** High · **Inherent:** High
- **Mitigations (in place):** secure defaults (deny-by-default auth, CORS
  allowlist); explicit operator checklist (policy §11); `single_user` (no-login)
  mode documented as private-box-only.
- **Gaps / planned:** operator hardening (TLS, disk encryption, firewall) is
  outside application control and depends on the deployer following §11.
- **Residual:** Medium (operator-dependent)
- **Owner:** Operator · **Review:** Quarterly

## Change log
- 2026-08-09 — Initial register created alongside the InfoSec policy (R-01…R-07).
