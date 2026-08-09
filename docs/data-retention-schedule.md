# Data Retention & Disposal Schedule

Status: Living
Last updated: 2026-08-09
Owner: `Lemuel Mutah — Owner & Maintainer (sole developer)`
Companion to: [Information Security Policy](information-security-policy.md) §10, [Plaid Security Questionnaire](plaid-security-questionnaire.md) §A, [Risk Register](risk-register.md)

> **Purpose.** The formal retention schedule referenced by policy §10. It states,
> per data class, *how long* Breadcrumbs keeps data, *what triggers* its deletion,
> and *how* it is disposed of — so the "we delete on account deletion" claim on a
> vendor questionnaire maps to a specific, code-backed mechanism.
>
> Status legend matches the rest of the security docs: **Implemented** (in code,
> source referenced), **Operator** (the self-hoster's responsibility), **Planned**
> (a committed gap).

---

## 1. Retention principle

Breadcrumbs retains the **minimum** data needed to provide the product, for **as
long as the account is active**, and disposes of it when the account (or a
specific connection) is deleted. It is a **read-only** finance app — it never
moves money — so there are no transaction-execution records that a financial
regulation would compel it to retain. Retention is therefore driven by product
need and user control, not by a statutory hold.

The operator of a given deployment may be subject to their own legal retention
or deletion obligations (e.g. a data-subject erasure request under GDPR/CCPA);
those are an **Operator** responsibility layered on top of this schedule.

---

## 2. Schedule by data class

| Data class | Store | Retention | Deletion trigger | Disposal mechanism | Status |
| --- | --- | --- | --- | --- | --- |
| Plaid access token + item id | `plaid/token-store.ts` (access token encrypted; item id is a non-secret identifier) | While the connection is linked | Connection removed, **or** account deleted | Token record deleted from the store (`DELETE /api/plaid/connections/:connectionId`; full wipe via account deletion) | Implemented |
| Account & transaction data | per-user `local/store.ts` (encrypted) | While the account is active | Account deleted | Per-user data directory removed | Implemented |
| Assistant memory (conversations, facts, uploads) | `agent/memory/*` (per-user dir) | While the account is active | Account deleted | Per-user `agent-memory/` directory removed | Implemented |
| User identity (email, display name, password hash) | auth user store | While the account exists | Account deleted | User record deleted | Implemented |
| Session tokens (sha256-hashed) | auth session store | Until TTL expiry, password change, disable, or deletion | Any of those events | All sessions revoked for the user | Implemented |
| TOTP MFA secret (encrypted) | auth user store | While MFA is enrolled | MFA disabled, or account deleted | Secret cleared with the user record | Implemented |
| Application logs (request/error, no secrets) | operator's log sink | Operator-defined window (recommend ≤ 90 days) | Log rotation / retention window | Operator log rotation | Operator |
| Host backups of the datastore | operator's backup system | Operator-defined | Operator schedule | Operator backup rotation | Operator |

Secrets excluded from logs by design (policy §4.2), so log retention never
extends the life of a token or password.

---

## 3. Deletion paths (how erasure actually happens)

Three mechanisms, from narrowest to broadest:

1. **Unlink one connection** — `DELETE /api/plaid/connections/:connectionId` deletes that
   connection's stored Plaid access token. The rest of the account is untouched.
   *Implemented.*
2. **Disable an account** (admin) — `PATCH /api/v1/admin/users/:id/status` →
   `disabled` immediately revokes every session. Data is retained (a disable is
   reversible), so this is suspension, not erasure. *Implemented.*
3. **Delete an account** (self-serve or admin) — removes the user's **identity**
   (user record + all sessions) **and** erases everything the user id owns: Plaid
   tokens, the per-user transaction store, and assistant memory.
   - Self-serve: `DELETE /api/v1/auth/me`, re-authenticated with the current
     password. *Implemented* (`auth/service.ts` `deleteOwnAccount`,
     `http/auth-routes.ts`).
   - Admin-initiated (offboarding / erasure request):
     `DELETE /api/v1/admin/users/:id`. *Implemented.*
   - Guards: the **last active admin** cannot be deleted (deployment must retain
     an administrator), and the **single-user owner** cannot be deleted (it is
     the one account the self-hosted app runs as). *Implemented.*
   - Erasure is best-effort and idempotent across the three data stores
     (`eraseUserData` in `http/server.ts`); a user who never imported or linked
     anything still deletes cleanly.

Erasure removes data from the **live datastore**. Copies in **operator backups**
age out on the operator's backup rotation (§2) — an operator honoring a hard
erasure request should also purge backups per their own policy. *Operator.*

---

## 4. Third-party data on deletion

- **Plaid** — deleting a connection or account removes our stored access token.
  Whether the linked Item is also removed at Plaid depends on the unlink path;
  operators handling a formal erasure request should confirm the Item is removed
  Plaid-side per Plaid's requirements. *Operator follow-up.*
- **Anthropic** — assistant requests send only data within the scope of the
  user's question and are governed by Anthropic's own retention terms (see
  [subprocessors.md](subprocessors.md)). The **local-model option** avoids
  sending data off-box at all.

---

## 5. Secret rotation (disposal of credentials)

Third-party secrets (Plaid keys, Anthropic key, `BREADCRUMBS_ENCRYPTION_KEY`)
are rotated **on suspected compromise** and **on personnel change**, per policy
§10 and the incident-response runbook. Rotation is an **Operator** action
(secrets live in the environment); moving the at-rest key into a secrets
manager/KMS is **Planned** (risk R-02).

---

## 6. Review

Reviewed on the §7 policy cadence (quarterly with the risk register), and
whenever a new data class, store, or subprocessor is introduced.
