# Privacy Policy

**Effective date: 9 August 2026**
**Last updated: 9 August 2026**

This Privacy Policy explains how **Breadcrumbs** ("Breadcrumbs", "we", "us")
collects, uses, protects, shares, and deletes your information when you use the
Breadcrumbs personal-finance application and related services (the "Service").

Breadcrumbs is a **read-only** personal-finance app: it helps you view and
understand your own financial accounts. **It never moves money** — no payments,
transfers, trades, or withdrawals.

The Service is operated by **Lemuel Mutah** (the "Operator"). You can reach us
about privacy at **lemuelmutah@gmail.com**.

> **Self-hosted deployments.** Breadcrumbs can also be run ("self-hosted") by a
> third party on their own infrastructure. If you are using an instance operated
> by someone other than us, **that operator** is the party responsible for your
> data, and this Policy describes the software's behavior rather than that
> operator's practices. Direct data requests to whoever operates the instance you
> use.

---

## 1. Information we collect

We collect only what the product needs to work.

**a. Account and identity information you give us.**
- Email address, display name, and a password. Your password is never stored in
  readable form — it is stored only as a one-way cryptographic hash.
- If you enable multi-factor authentication (MFA), a secret used to verify your
  authenticator-app codes. It is stored encrypted.

**b. Financial account information, obtained through Plaid.**
When you link a bank or financial account, you do so through **Plaid Inc.**
("Plaid"). You enter your bank credentials **directly into Plaid Link** — **we
never see, receive, or store your bank username, password, or PIN.** Plaid then
provides us, on your behalf, with:
- account metadata (account names, types, and balances),
- transaction history,
- financial-institution names, and
- a per-connection access token that lets us retrieve the above from Plaid.

Your use of Plaid is also governed by **Plaid's End User Privacy Policy**
(https://plaid.com/legal/#end-user-privacy-policy). We encourage you to read it.

**c. Assistant information.**
If you use the optional AI assistant, we process the messages you send it and any
facts, notes, or files you choose to give it, so it can answer your questions.

**d. Technical information.**
Breadcrumbs does **not** use third-party analytics, advertising, tracking, or
marketing tools. The server that runs the Service may keep basic operational logs
(for example, error and request-status records) to keep the Service secure and
working; these logs are designed to **exclude secrets** such as tokens and
passwords.

We do **not** knowingly collect information from anyone under 18. The Service is
not directed to children.

---

## 2. How we use your information

We use your information solely to provide and secure the Service:
- authenticate you and keep your account secure;
- retrieve and display your linked accounts, balances, and transactions;
- categorize transactions and generate spending summaries and informational
  insights;
- answer your questions through the optional AI assistant; and
- detect, prevent, and respond to security incidents, fraud, and abuse.

We do **not** use your information for advertising, and we do **not** sell or rent
your personal or financial information to anyone.

The insights the Service generates are **informational only** and are not
financial, investment, tax, or legal advice.

---

## 3. How we share your information

We share your data only with the service providers ("subprocessors") strictly
necessary to run the Service:

| Who | What they receive | Why | Can you avoid it? |
| --- | --- | --- | --- |
| **Plaid Inc.** | Your bank credentials pass **through** Plaid (never to us); Plaid provides us your account metadata, balances, transactions, and institution names | Read-only financial-account aggregation | No — Plaid is the account-connection provider |
| **Anthropic PBC** | Only the portion of your financial data that is within the scope of a question you ask the AI assistant | To generate the assistant's answer | **Yes** — a local, on-device model option keeps this data on the machine and sends nothing to Anthropic |

We use **no** other subprocessors — no analytics, error-tracking, advertising, or
email-marketing vendors. If we ever add a subprocessor, we will update this Policy
before that change takes effect and disclose it to users whose data flows would
change.

We may also disclose information if required by law, to comply with valid legal
process, or to protect the rights, safety, and security of users, the public, or
the Service.

---

## 4. How we protect your information

We apply layered technical safeguards, including:
- **Encryption in transit** — TLS 1.2 or better for connections between your
  browser, the Service, Plaid, and Anthropic.
- **Encryption at rest** — Plaid access tokens, your account/transaction data, and
  MFA secrets are encrypted with AES-256-GCM; the encryption key is held in the
  server environment, separate from the data it protects.
- **Strong authentication** — passwords hashed with a memory-hard algorithm
  (scrypt); optional TOTP multi-factor authentication, required as a step-up
  before you can link a bank.
- **Access controls** — access is denied by default, and each account's data is
  isolated so one user can never access another's.
- **Abuse protection** — rate limiting and account lockout to resist password
  guessing.

No method of transmission or storage is 100% secure, and we cannot guarantee
absolute security. Where the Service is self-hosted, some protections (for
example, server disk encryption, network firewalls, and backups) are the
responsibility of the operator running that instance.

---

## 5. How long we keep your information

We keep your information only while your account is active, and delete it when you
delete the relevant data or your account:

| Data | Kept | Deleted when |
| --- | --- | --- |
| Linked-account data and Plaid access token | While the connection is linked | You remove the connection, or delete your account |
| Account/transaction data and assistant data | While your account is active | You delete your account |
| Identity (email, name, password hash) | While your account exists | You delete your account |
| Session tokens | Until they expire, you change your password, or you delete/disable the account | Any of those events |
| MFA secret | While MFA is enabled | You disable MFA, or delete your account |

Deletion removes data from the live datastore immediately. Copies in any operator
backups age out on that operator's backup rotation.

---

## 6. Your choices and rights

You can, at any time:
- **Access and review** your linked accounts, transactions, and profile within the
  app.
- **Unlink a connection** — remove a single linked institution and its stored
  access token.
- **Delete your account** — permanently erase your identity and all data your
  account owns (Plaid tokens, transaction data, and assistant data). Account
  deletion is available in-app and requires re-entering your password.
- **Avoid off-device AI processing** — use the local, on-device assistant model so
  no financial data is sent to Anthropic.

Depending on where you live, you may have additional rights — for example, to
access, correct, delete, or receive a copy of your personal data, and to object to
or restrict certain processing (as under the GDPR), or to know what we collect and
request its deletion (as under the CCPA/CPRA). **We do not sell your personal
information.** To exercise any right, contact us at **lemuelmutah@gmail.com**. If
you use a self-hosted instance, direct your request to the operator of that
instance.

---

## 7. Deleting data at Plaid

Deleting a connection or your account removes the access token we hold. If you
want your linked item fully removed at Plaid as well, or you are exercising a
formal erasure request, contact us and we will confirm removal on the Plaid side
in accordance with Plaid's requirements.

---

## 8. Data location and international transfers

Our subprocessors (Plaid and Anthropic) are based in the United States, and your
data may be processed there. If you access the Service from outside the United
States, you understand your information may be transferred to and processed in the
United States.

---

## 9. Changes to this Policy

We may update this Policy from time to time. When we do, we will revise the
"Last updated" date above, and for material changes we will provide a more
prominent notice. Your continued use of the Service after an update means you
accept the revised Policy.

---

## 10. Contact us

Questions, concerns, or requests about this Policy or your data:

**Lemuel Mutah** — **lemuelmutah@gmail.com**
