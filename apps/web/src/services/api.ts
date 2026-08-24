/**
 * The single HTTP boundary between the browser and the Breadcrumbz API.
 *
 * Per `CD-011` no browser code calls backend calculation functions. Everything
 * goes through here. This module owns transport and nothing else — it does not
 * sum, classify, compare, or reshape a financial figure.
 *
 * Auth strategy:
 *   • All requests include `credentials: "include"` so the httpOnly `bc_session`
 *     cookie is sent automatically — the primary auth mechanism, and the one that
 *     survives a page reload. Because it is httpOnly, page script (and therefore
 *     any XSS) cannot read it.
 *   • When a bearer token is available (from a login response), it is also sent
 *     in an `Authorization: Bearer` header for this page session. Both methods can
 *     coexist; the server prefers whichever it finds first.
 *   • The bearer token is held ONLY in memory — never written to localStorage.
 *     Persisting it there would hand any XSS a durable copy of the session and
 *     defeat the httpOnly cookie. On reload the cookie re-authenticates and the
 *     session layer restores the user via `/auth/me`, so nothing is lost.
 *     (This assumes the web app and API are served same-site so the SameSite=Lax
 *     cookie rides the request; that is the supported production topology.)
 *   • A 401 from any multi_user endpoint returns `{ kind: "unauthenticated" }`
 *     so the session layer can react without every caller handling raw HTTP codes.
 */
import type {
  AccountsResult,
  AffordabilityRequest,
  AffordabilityRequestValidationIssue,
  AffordabilityResponse,
  Budget,
  BudgetProgress,
  CashFlowCalendar,
  FinancialSnapshot,
  Goal,
  GoalsEvaluation,
  InsightsResult,
  MonthlyReport,
  NetWorthTrend,
  SavingsCapacitySuggestion,
  SavingsGoalInput,
  SpendingSummary,
  TransactionPage,
} from "@ai-fin-os/core";
import type { AffordabilityOutcome } from "./outcome";

// Development fallback only. In a production build with no configured base URL
// we use the page's own origin (see `apiBaseUrl`), so a same-origin / reverse-
// proxied deployment works without baking in a host — and we never ship a build
// that silently points at a developer's loopback.
const DEV_DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";

export type ApiOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "invalid"; issues: unknown[] }
  /** A 422: the request was well-formed and the server refused it on the
   *  merits, returning the same payload shape with the reasons inside. An
   *  import whose rows failed validation lands here, and the body is what the
   *  screen needs to show — collapsing it into "error" would throw away the
   *  row-level diagnostics that make the failure fixable. */
  | { kind: "rejected"; data: T }
  /** A transport or domain error. `code` carries the server's stable machine
   *  code when it sent one (e.g. `MFA_REQUIRED`), so a caller can branch on the
   *  reason without parsing the human message. */
  | { kind: "error"; message: string; code?: string }
  /** A 401: the caller is not (or is no longer) authenticated. Only surfaces
   *  in multi_user mode — single_user mode has no auth layer. */
  | { kind: "unauthenticated" };

// ---- Bearer token management -----------------------------------------------
// The token lives in memory ONLY. It is deliberately not persisted to
// localStorage: the httpOnly cookie already survives reloads and is beyond the
// reach of script, so storing a second, script-readable copy would only give an
// XSS a durable session to steal. On reload the cookie re-authenticates.

let _bearerToken: string | null = null;

export function setBearerToken(token: string | null): void {
  _bearerToken = token;
}

function getBearerToken(): string | null {
  return _bearerToken;
}

// ---- Core transport --------------------------------------------------------

export function apiBaseUrl(): string {
  const env = (import.meta as ImportMeta & { readonly env?: ImportMetaEnv }).env;
  const configured = env?.VITE_BREADCRUMBZ_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // Unconfigured: in development point at the local API; in a production build
  // fall back to the page's own origin so a same-origin / reverse-proxied
  // deployment works, rather than a baked-in loopback that only the developer
  // can reach. ("" ⇒ requests are made relative to the current origin.)
  if (env?.DEV) return DEV_DEFAULT_API_BASE_URL;
  return "";
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { raw401?: boolean },
): Promise<ApiOutcome<T>> {
  try {
    const token = getBearerToken();
    const extraHeaders: Record<string, string> = {};
    if (token) extraHeaders["authorization"] = `Bearer ${token}`;

    const response = await fetch(`${apiBaseUrl()}${path}`, {
      headers: { "content-type": "application/json", ...extraHeaders },
      credentials: "include",
      ...init,
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : null;

    // A 401 on a data route means the session lapsed — the session layer swaps
    // in the login screen. On the login endpoint itself a 401 is instead a
    // domain error ("Email or password is incorrect."), whose body message the
    // form must show; those callers pass raw401 to fall through to the message
    // extraction below rather than collapse to an unreadable "unauthenticated".
    if (response.status === 401 && !opts?.raw401) return { kind: "unauthenticated" };

    if (response.ok) return { kind: "ok", data: body as T };

    // A 400 is a malformed request, which is a different thing from a valid
    // result the user should see. Collapsing them would let a transport
    // problem masquerade as a financial fact. Only a Zod failure carries the
    // field-level `issues` a screen renders; a domain 400 (WEAK_PASSWORD,
    // INVALID_EMAIL) carries only a human message, so fall through and surface
    // it instead of flattening it to an empty "invalid".
    if (response.status === 400 && body && typeof body === "object" && "error" in body) {
      const error = (body as { error?: { issues?: unknown[]; message?: string } }).error;
      if (error?.issues && error.issues.length > 0) {
        return { kind: "invalid", issues: error.issues };
      }
    }
    if (response.status === 422 && body) return { kind: "rejected", data: body as T };
    // A 502 from the agent endpoints, or a 403 from the MFA gate, carries a
    // readable reason and a machine `code`; surface both so callers can branch
    // on the code and still show the message.
    if (body && typeof body === "object" && "error" in body) {
      const error = (body as { error?: { message?: string; code?: string } }).error;
      if (error?.message) return { kind: "error", message: error.message, code: error.code };
    }
    return { kind: "error", message: `Request failed (HTTP ${response.status})` };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error && error.message.includes("fetch")
          ? "Can't reach the API. Is it running?"
          : error instanceof Error
            ? error.message
            : "Unknown failure",
    };
  }
}

/** POST helper for the endpoints that take a body. Same outcome shape as
 *  `request`, so callers handle transport failures one way everywhere. */
export function post<T>(
  path: string,
  body: unknown,
  opts?: { raw401?: boolean },
): Promise<ApiOutcome<T>> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) }, opts);
}

export function patch<T>(path: string, body: unknown): Promise<ApiOutcome<T>> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<ApiOutcome<T>> {
  return request<T>(path, { method: "DELETE" });
}

export function get<T>(path: string): Promise<ApiOutcome<T>> {
  return request<T>(path);
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

// ---- Auth ------------------------------------------------------------------

/** `GET /api/v1/auth/context` — public, no credentials required.
 *  Returns the deployment mode so the UI knows whether to show a login wall. */
export function fetchAuthContext(): Promise<
  ApiOutcome<{ mode: "single_user" | "multi_user"; registrationOpen: boolean; assistantConfigured: boolean }>
> {
  return request("/api/v1/auth/context");
}

/** `GET /api/v1/auth/me` — returns the signed-in user or null. */
export function fetchMe(): Promise<ApiOutcome<{ user: PublicUser | null; mode: string }>> {
  return request("/api/v1/auth/me");
}

/** `POST /api/v1/auth/login`. Uses raw401 so a wrong-credentials 401 surfaces
 *  as a readable `error` the form can show, not a bare `unauthenticated`. */
export function login(email: string, password: string): Promise<ApiOutcome<{ user: PublicUser; token: string }>> {
  return post("/api/v1/auth/login", { email, password }, { raw401: true });
}

/** `POST /api/v1/auth/register`. `acceptedPolicies` carries the user's
 *  affirmative agreement to the Privacy Policy and Terms; the server refuses to
 *  create an account (CONSENT_REQUIRED) without it and records it on success. */
export function register(
  email: string,
  password: string,
  displayName?: string,
  acceptedPolicies?: boolean,
): Promise<ApiOutcome<{ user: PublicUser; token: string }>> {
  return post("/api/v1/auth/register", { email, password, displayName, acceptedPolicies });
}

/** `POST /api/v1/auth/logout` */
export function logout(): Promise<ApiOutcome<null>> {
  return post("/api/v1/auth/logout", {});
}

/** `POST /api/v1/auth/change-password` */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ApiOutcome<null>> {
  return post("/api/v1/auth/change-password", { currentPassword, newPassword });
}

/** Canonical shape of a user returned by the auth endpoints. */
export type PublicUser = {
  id: string;
  email: string;
  displayName?: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
  /** `pending` = enrollment started but no code verified yet. */
  mfa: { enabled: boolean; method: "totp" | null; pending: boolean };
  /** The recorded Privacy Policy / Terms agreement, or `null` if the account
   *  never went through the consent step. */
  consent?: { policyVersion: string; agreedAt: string } | null;
};

// ---- Multi-factor (TOTP) ---------------------------------------------------

/** `POST /api/v1/auth/mfa/enroll` — mint a secret + otpauth URI for the QR code.
 *  The secret is returned once, here, so it can be shown for manual entry. */
export function beginMfaEnrollment(): Promise<ApiOutcome<{ secret: string; otpauthUri: string }>> {
  return post("/api/v1/auth/mfa/enroll", {});
}

/** `POST /api/v1/auth/mfa/enroll/verify` — confirm the first code; turns MFA on
 *  and clears the challenge for the current session. */
export function verifyMfaEnrollment(code: string): Promise<ApiOutcome<{ user: PublicUser }>> {
  return post("/api/v1/auth/mfa/enroll/verify", { code });
}

/** `POST /api/v1/auth/mfa/challenge` — step-up: clear MFA for this session
 *  (e.g. right before connecting a bank) without a full re-login. */
export function verifyMfaChallenge(code: string): Promise<ApiOutcome<{ ok: boolean }>> {
  return post("/api/v1/auth/mfa/challenge", { code });
}

/** `POST /api/v1/auth/mfa/disable` — turn MFA off (requires a current code). */
export function disableMfa(code: string): Promise<ApiOutcome<{ user: PublicUser }>> {
  return post("/api/v1/auth/mfa/disable", { code });
}

// ---- Admin -----------------------------------------------------------------

/** `GET /api/v1/admin/users` — admin only. */
export function adminListUsers(): Promise<ApiOutcome<{ users: PublicUser[] }>> {
  return request("/api/v1/admin/users");
}

/** `POST /api/v1/admin/users` — create a user. */
export function adminCreateUser(params: {
  email: string;
  password: string;
  displayName?: string;
  role?: "user" | "admin";
}): Promise<ApiOutcome<{ user: PublicUser }>> {
  return post("/api/v1/admin/users", params);
}

/** `PATCH /api/v1/admin/users/:id/role` */
export function adminSetRole(
  id: string,
  role: "user" | "admin",
): Promise<ApiOutcome<{ user: PublicUser }>> {
  return patch(`/api/v1/admin/users/${id}/role`, { role });
}

/** `PATCH /api/v1/admin/users/:id/status` */
export function adminSetStatus(
  id: string,
  status: "active" | "disabled",
): Promise<ApiOutcome<{ user: PublicUser }>> {
  return patch(`/api/v1/admin/users/${id}/status`, { status });
}

/** `POST /api/v1/admin/users/:id/reset-password` */
export function adminResetPassword(
  id: string,
  newPassword: string,
): Promise<ApiOutcome<null>> {
  return post(`/api/v1/admin/users/${id}/reset-password`, { newPassword });
}

/** `GET /api/v1/admin/config` */
export function adminGetConfig(): Promise<ApiOutcome<Record<string, unknown>>> {
  return request("/api/v1/admin/config");
}

// ---- Spending -------------------------------------------------------------

export function fetchSpendingSummary(params: {
  period: string;
  key?: string;
  accountId?: string;
  currency?: string;
  /** Optional date-range span. When both are sent the summary is aggregated
   *  over that contiguous window; `period.key` in the response will start with
   *  "span:" and `comparison.comparable` will be false. */
  from?: string;
  to?: string;
}): Promise<ApiOutcome<SpendingSummary>> {
  return request(`/api/v1/spending/summary${qs({ currency: "USD", ...params })}`);
}

export function fetchSpendingSeries(params: {
  period?: string;
  count?: number;
  currency?: string;
}): Promise<ApiOutcome<unknown>> {
  return request(`/api/v1/spending/series${qs({ currency: "USD", ...params })}`);
}

// ---- Budgets --------------------------------------------------------------

/** A user's configured budget set: per-category caps (each governing a week or a
 *  month) plus an optional overall cap per window. Mirrors the server's
 *  `BudgetState`; the browser never computes from it — it edits it and hands it
 *  back. A monthly cap carries no `period` field; a weekly cap has
 *  `period: "week"`. */
export type BudgetConfig = {
  currency: string;
  overallLimitCents: number | null;
  overallWeeklyLimitCents: number | null;
  budgets: Budget[];
};

/** `GET /api/v1/budgets` — the raw configured caps (no progress). */
export function fetchBudgets(): Promise<ApiOutcome<BudgetConfig>> {
  return request("/api/v1/budgets");
}

/** `POST /api/v1/budgets` — replace the whole set. Returns the saved (sorted) set.
 *  Whole-set replace is deliberate: the screen edits a small set as one object,
 *  so there is no partial-merge ambiguity. POST (not PUT) keeps this on the same
 *  verb set every other mutation uses (the server's CORS allowlist is scoped to
 *  exactly those verbs). */
export function saveBudgets(config: BudgetConfig): Promise<ApiOutcome<BudgetConfig>> {
  return post("/api/v1/budgets", config);
}

/** `GET /api/v1/budgets/progress` — spent-vs-limit for one window, computed
 *  server-side by core `evaluateBudgets` (`CD-011` — no browser arithmetic).
 *  `period` picks the window (`week` | `month`, default month); `key` picks which
 *  one — a month key (`2026-08`) or an ISO week key (`2026-W32`) — and omitted
 *  means the window containing the latest data. */
export function fetchBudgetProgress(params: {
  period?: "week" | "month";
  key?: string;
}): Promise<ApiOutcome<BudgetProgress>> {
  return request(`/api/v1/budgets/progress${qs({ currency: "USD", ...params })}`);
}

// ---- Goals ----------------------------------------------------------------

/** A user's declared savings goals. Mirrors the server's `GoalState`: the store
 *  holds the canonical `Goal` shape core `buildSavingsGoals` produced from the
 *  user's reduced input. The browser edits *input* and reads back canonical
 *  goals; it never computes progress from them — that's `fetchGoalProgress`. */
export type GoalConfig = {
  currency: string;
  goals: Goal[];
};

/** The reduced shape a user declares (the POST body). The server shapes each into
 *  a canonical `Goal` via core `buildSavingsGoals` (`CD-003`), so the browser
 *  never fills in cadence, next-contribution, freshness, or confidence itself. */
export type GoalInput = SavingsGoalInput;

/** `GET /api/v1/goals` — the raw declared goals (canonical shape, no progress). */
export function fetchGoals(): Promise<ApiOutcome<GoalConfig>> {
  return request("/api/v1/goals");
}

/** `POST /api/v1/goals` — replace the whole set. Body is the reduced *input*; the
 *  server shapes and returns the canonical set (sorted by id). Whole-set replace is
 *  deliberate (the screen edits a small set as one object), and POST (not PUT) keeps
 *  this on the server's CORS-allowlisted verb set that every other mutation uses. */
export function saveGoals(params: {
  currency?: string;
  goals: GoalInput[];
}): Promise<ApiOutcome<GoalConfig>> {
  return post("/api/v1/goals", { currency: "USD", ...params });
}

/** `GET /api/v1/goals/progress` — per-goal progress, status and pace plus a
 *  rollup, computed server-side by core `evaluateGoals` (`CD-011` — no browser
 *  arithmetic) at the latest-data "now". */
export function fetchGoalProgress(): Promise<ApiOutcome<GoalsEvaluation>> {
  return request(`/api/v1/goals/progress${qs({ currency: "USD" })}`);
}

/** `GET /api/v1/goals/suggestion` — a *factual observation* of the user's own
 *  cash flow (median monthly surplus + income-above-essentials over recent
 *  complete months), computed server-side by core `suggestSavingsCapacity`. Used
 *  to pre-fill a monthly target; it is never advice (`D-G11`). */
export function fetchSavingsSuggestion(): Promise<ApiOutcome<SavingsCapacitySuggestion>> {
  return request(`/api/v1/goals/suggestion${qs({ currency: "USD" })}`);
}

// ---- Cash-flow calendar ----------------------------------------------------

/** `GET /api/v1/cashflow/upcoming` — the forward-looking calendar of expected
 *  income and recurring obligations with a projected running balance, computed
 *  server-side (`CD-011` — no browser arithmetic) and never stored (`D-C1`).
 *  `horizon` is the forward window in days; omitted defaults to 45 (`D-C3`). A
 *  404 (`NO_IMPORTED_HISTORY`) surfaces as `{ kind: "error", code }`, which the
 *  cashflow service maps to its import-first empty state. */
export function fetchCashflow(params?: {
  horizon?: number;
}): Promise<ApiOutcome<CashFlowCalendar>> {
  return request(`/api/v1/cashflow/upcoming${qs({ currency: "USD", horizon: params?.horizon })}`);
}

// ---- Transactions ---------------------------------------------------------

export function fetchTransactions(params: {
  from?: string;
  to?: string;
  accountId?: string;
  category?: string;
  flowType?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}): Promise<ApiOutcome<TransactionPage>> {
  return request(`/api/v1/transactions${qs({ currency: "USD", ...params })}`);
}

// ---- Insights -------------------------------------------------------------

export function fetchInsights(params: {
  period?: string;
  key?: string;
}): Promise<ApiOutcome<InsightsResult>> {
  return request(`/api/v1/insights${qs({ currency: "USD", period: "month", ...params })}`);
}

// ---- Monthly report -------------------------------------------------------

/** `GET /api/v1/reports/monthly` — the composed "where did my money go" report
 *  for one month. Omit `key` for the latest COMPLETE month (the server steps
 *  back from a still-filling current month). A missing history is a 404 with
 *  `code: "NO_IMPORTED_HISTORY"`, which the report service maps to its empty
 *  state rather than an error. */
export function fetchMonthlyReport(
  params: { key?: string } = {},
): Promise<ApiOutcome<MonthlyReport>> {
  return request(`/api/v1/reports/monthly${qs({ currency: "USD", ...params })}`);
}

/**
 * Trigger a browser download of the month's CSV.
 *
 * The report endpoints are credentialed, so a plain `<a download>` to the API
 * would arrive without the session and 401. Instead we fetch the bytes with the
 * same auth `request` uses (httpOnly cookie + any in-memory bearer), wrap them
 * in a Blob, and click a synthetic anchor. The filename is the server's own
 * `content-disposition` (named for the month), so the browser and the CSV agree.
 *
 * This does no arithmetic and reshapes nothing (`CD-011`); it moves opaque bytes.
 */
export async function downloadMonthlyReportCsv(
  params: { key?: string } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const token = getBearerToken();
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;

    const response = await fetch(
      `${apiBaseUrl()}/api/v1/reports/monthly.csv${qs({ currency: "USD", ...params })}`,
      { headers, credentials: "include" },
    );
    if (!response.ok) {
      // The one expected failure is an empty store; keep the message generic and
      // let the screen's own empty/error state carry the detail.
      return { ok: false, message: "Couldn't generate the CSV to download." };
    }

    const blob = await response.blob();
    const filename =
      filenameFromDisposition(response.headers.get("content-disposition")) ??
      "monthly-report.csv";

    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Can't reach the API to download the CSV." };
  }
}

/** Pull the filename out of a `content-disposition` header, tolerating the
 *  quoted and unquoted forms. Returns undefined when absent so the caller can
 *  fall back to a stable default. */
function filenameFromDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match?.[1];
}

// ---- Accounts -------------------------------------------------------------

export function fetchAccounts(): Promise<ApiOutcome<AccountsResult>> {
  return request(`/api/v1/accounts${qs({ currency: "USD" })}`);
}

// ---- Net worth ------------------------------------------------------------

/**
 * `GET /api/v1/net-worth/trend` — the month-by-month cash net-worth line.
 *
 * A `GET`, deliberately: the server records today's figure as an idempotent
 * side effect of the read (D-N4), so no write verb and no CORS change. The
 * browser only formats what comes back; every cent is computed in core.
 */
export function fetchNetWorthTrend(params?: {
  currency?: string;
  months?: number;
}): Promise<ApiOutcome<NetWorthTrend>> {
  return request(`/api/v1/net-worth/trend${qs({ currency: "USD", ...params })}`);
}

// ---- Plaid ----------------------------------------------------------------

/**
 * The browser only ever holds a `link_token` and a `connectionId`.
 * The `public_token` is exchanged server-side; no Plaid secret and no
 * `access_token` ever reaches client code (`D-012`).
 */
export function createPlaidLinkToken(): Promise<ApiOutcome<{ linkToken: string }>> {
  return request(`/api/plaid/link-token`, { method: "POST", body: "{}" });
}

export function exchangePlaidPublicToken(
  publicToken: string,
): Promise<ApiOutcome<{ connectionId: string }>> {
  return request(`/api/plaid/exchange-public-token`, {
    method: "POST",
    body: JSON.stringify({ publicToken }),
  });
}

/** Shape of a Plaid connection as returned by `GET /api/plaid/connections`. */
export type PlaidConnection = {
  connectionId: string;
  itemId: string;
  institutionName: string;
  createdAt: string;
  lastSyncedAt?: string;
};

/** `GET /api/plaid/connections` — list all Plaid bank connections. */
export function fetchPlaidConnections(): Promise<ApiOutcome<{ connections: PlaidConnection[] }>> {
  return request("/api/plaid/connections");
}

/** `POST /api/plaid/connections/:id/sync` — pull latest transactions from Plaid. */
export function syncPlaidConnection(
  connectionId: string,
  params?: { startDate?: string; endDate?: string },
): Promise<ApiOutcome<{ synced: number; message?: string }>> {
  return post(`/api/plaid/connections/${connectionId}/sync`, params ?? {});
}

/** `DELETE /api/plaid/connections/:id` — remove a Plaid connection. */
export function deletePlaidConnection(
  connectionId: string,
): Promise<ApiOutcome<null>> {
  return del(`/api/plaid/connections/${connectionId}`);
}

/** Shape returned by `GET /api/plaid/coverage`. Describes the overall data
 *  coverage window across all Plaid connections.
 *
 *  `floor`/`today` are always present (Plaid's ~24-month lookback and the
 *  server's current date). `earliestSynced`/`latestSynced` are null when no
 *  data has been pulled yet. */
export type PlaidCoverage = {
  earliestSynced: string | null;
  latestSynced: string | null;
  floor: string;
  today: string;
  connections: Array<{
    connectionId: string;
    institutionName: string | null;
    coverageStart: string | null;
    coverageEnd: string | null;
    lastSyncedAt: string | null;
  }>;
};

/** `GET /api/plaid/coverage` — overall data-coverage window. */
export function fetchSpendingCoverage(): Promise<ApiOutcome<PlaidCoverage>> {
  return get("/api/plaid/coverage");
}

/** `POST /api/plaid/connections/:id/sync` — pull a historical window from the
 *  bank and merge it into the store (idempotent, dedups). Pass `startDate` to
 *  backfill older data; omitting `endDate` defaults to today. */
export function syncConnection(
  connectionId: string,
  body: { startDate?: string; endDate?: string },
): Promise<ApiOutcome<unknown>> {
  return post(`/api/plaid/connections/${connectionId}/sync`, body);
}

// ---- Affordability --------------------------------------------------------

/**
 * The snapshot to evaluate a purchase against, derived server-side from the
 * user's imported accounts and history.
 *
 * This replaces a fixture the browser used to import from `packages/core`,
 * which meant the verdict was about someone else's balances and crossed the
 * `D-013` deploy boundary at build time. `notes` says which income sources and
 * obligations were inferred, so the screen can show its working.
 */
export function fetchAffordabilitySnapshot(): Promise<
  ApiOutcome<{ snapshot: FinancialSnapshot; notes: SnapshotNotes }>
> {
  return request(`/api/v1/affordability/snapshot${qs({ currency: "USD" })}`);
}

export type SnapshotNotes = {
  incomeSourceCount: number;
  recurringObligationCount: number;
  skippedForInsufficientHistory: string[];
  accountsMissingBalance: string[];
  transactionsFromDate?: string;
};

export async function checkAffordability(
  body: AffordabilityRequest,
): Promise<AffordabilityOutcome> {
  const result = await request<AffordabilityResponse>(`/api/v1/affordability/evaluate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (result.kind === "ok") return { kind: "result", response: result.data };
  if (result.kind === "invalid") {
    return { kind: "invalid", issues: result.issues as AffordabilityRequestValidationIssue[] };
  }
  // This endpoint has no 422 path — a request it accepts always produces a
  // verdict, and UNKNOWN is one of them rather than a rejection.
  if (result.kind === "rejected") {
    return { kind: "error", message: "The request was rejected." };
  }
  if (result.kind === "unauthenticated") {
    return { kind: "error", message: "Authentication required." };
  }
  return { kind: "error", message: result.message };
}
