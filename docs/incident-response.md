# Incident Response Runbook

Status: Living
Last updated: 2026-08-09
Owner: `Lemuel Mutah — Owner & Maintainer (sole developer)`
Companion to: [Information Security Policy](information-security-policy.md) §6

The step-by-step procedure for a suspected or confirmed security incident. Keep
it short enough to actually follow under pressure. Keep the contacts below
current as the deployment changes.

## Contacts

| Role | Name | Reach |
| --- | --- | --- |
| Security owner (incident lead) | `Lemuel Mutah` | `lemuelmutah@gmail.com` |
| Engineering on-call | `Lemuel Mutah` | `lemuelmutah@gmail.com` |
| Plaid support / incident reporting | Plaid | Plaid Dashboard → Support; per your Plaid agreement's incident-reporting terms |
| Anthropic support | Anthropic | account/support channel |

Primary reporting channel for anyone who spots something: `email (lemuelmutah@gmail.com)`.

## What counts as an incident

Any suspected: unauthorized access to user financial data; exposure or theft of
a secret (Plaid access token, Plaid/Anthropic API key, password-hash store);
account takeover; datastore loss or corruption; or a dependency vulnerability
being actively exploited. **When in doubt, treat it as an incident and triage.**

## Procedure

### 1. Detect & report (minutes)
- Anyone who suspects an incident notifies the security owner immediately via
  `email (lemuelmutah@gmail.com)`. Do not investigate silently — report first.
- The security owner becomes incident lead and opens a timestamped log
  (what, when noticed, by whom).

### 2. Triage & classify (first 30–60 min)
- Determine scope: **what** data, **whose**, and whether **third-party secrets**
  (Plaid/Anthropic) are implicated.
- Assign a severity:
  - **SEV-1** — confirmed exposure of user financial data or a live secret.
  - **SEV-2** — credible risk, not yet confirmed (e.g. anomalous auth failures).
  - **SEV-3** — contained/low-impact (e.g. a patched dependency CVE, no evidence
    of exploitation).

### 3. Contain
- **Sessions:** force-revoke affected users' sessions — a password reset or
  account disable revokes *all* sessions for that user (`auth/service.ts`).
- **Secrets:** rotate any exposed API key/secret immediately in the provider
  dashboard, then update the deployment's environment.
- **Plaid tokens:** if a Plaid access token is implicated, remove the affected
  Item and require the user to re-link; rotate the Plaid secret if the client
  credentials themselves are in question.
- **Network:** if the host is compromised, isolate it (pull it off the network)
  before further analysis.

### 4. Eradicate & recover
- Fix the root cause (patch, config change, credential rotation).
- If data was corrupted or lost, restore from the operator's latest good backup
  (policy §11) and verify integrity before returning to service.
- Confirm the vulnerability is closed before reconnecting.

### 5. Notify
- **Users:** notify affected users of what happened, what data was involved, and
  what they should do, within the applicable timeframe.
- **Plaid:** report per Plaid's incident-reporting requirements (a security
  incident affecting Plaid-sourced data is reportable — check your Plaid
  agreement for the required window and channel).
- **Others:** notify any additional parties required by contract or law.
- Route all external notifications through the incident lead so messaging is
  consistent and accurate — do not over- or under-state scope.

### 6. Post-incident review (within 1 week of closure)
- Write a short post-mortem: timeline, root cause, what worked, what didn't,
  and dated preventive follow-ups.
- File follow-ups into the [Risk Register](risk-register.md) and, if a control
  or policy changes as a result, add an entry to [decisions.md](decisions.md).

## Quick reference — containment actions

| Situation | First action |
| --- | --- |
| Account takeover suspected | Disable the account → revokes all its sessions |
| API key / secret leaked | Rotate in provider dashboard → update env → redeploy |
| Plaid token exposed | Remove Item, force re-link; rotate Plaid secret if credentials implicated |
| Host compromised | Isolate host from network before analysis |
| Datastore corrupted | Restore from last good backup, verify, then serve |

---

*This runbook must be reviewed and approved by an accountable owner and drilled
at least annually (policy §7). It is not legal advice; regulatory notification
obligations should be confirmed with counsel.*
