/**
 * Two-factor (TOTP) UI, shared by the two places it appears.
 *
 *   • `MfaSetupCard`  — in Settings: enroll, show status, or turn it off. This is
 *                       where a user first adds an authenticator app.
 *   • `MfaGateDialog` — a modal the Accounts screen raises when connecting a bank
 *                       is blocked: it either walks the user through first-time
 *                       enrollment (`MFA_ENROLLMENT_REQUIRED`) or asks for a
 *                       current code to clear the step-up (`MFA_REQUIRED`), then
 *                       calls back so the original action can retry.
 *
 * Secrets are minted and verified server-side; this module only ever handles the
 * one-time base32 string the server returns for manual entry and the 6-digit code
 * the user reads from their app. No QR image is rendered (that would need a new
 * dependency) — the secret is shown grouped for the "enter a setup key" path every
 * authenticator app supports.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  beginMfaEnrollment,
  disableMfa,
  verifyMfaChallenge,
  verifyMfaEnrollment,
} from "../services/api";
import { useSession } from "../services/session";
import { Card, SectionLabel } from "./ui";

/** Space a base32 secret into groups of four so it's readable to type in. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** A labelled 6-digit code field + submit, with an inline error line. Kept
 *  generic so enrollment, challenge, and disable all share the same input. */
function CodeForm({
  submitLabel,
  busyLabel,
  onSubmit,
  autoFocus = true,
  children,
}: {
  submitLabel: string;
  busyLabel: string;
  /** Return an error message to show, or null on success. */
  onSubmit: (code: string) => Promise<string | null>;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit(code.trim());
    setBusy(false);
    if (message) {
      setError(message);
      setCode("");
    }
  }

  return (
    <form onSubmit={handle} className="mt-3">
      {children}
      <label className="mt-3 block text-label text-ink-secondary" htmlFor="mfa-code">
        6-digit code
      </label>
      <input
        id="mfa-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
        placeholder="123 456"
        className="numeral mt-1 w-full max-w-[220px] rounded-md border border-line-strong bg-surface-base px-3 py-2 text-figure tracking-[0.2em] text-ink outline-none focus:border-accent"
      />
      {error && <p className="mt-2 text-meta text-alert">{error}</p>}
      <div className="mt-3">
        <button
          type="submit"
          disabled={busy || code.trim().length < 6}
          className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The shared enrollment step: begin (fetch secret) → show it → verify a code.
 *  Reused by both the Settings card and the connect-a-bank gate. */
function EnrollFlow({ onEnrolled }: { onEnrolled: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const begin = useCallback(async () => {
    setStartError(null);
    const result = await beginMfaEnrollment();
    if (result.kind === "ok") setSecret(result.data.secret);
    else setStartError(result.kind === "error" ? result.message : "Couldn't start setup.");
  }, []);

  useEffect(() => {
    void begin();
  }, [begin]);

  if (startError) {
    return (
      <div className="mt-3">
        <p className="text-body text-alert">{startError}</p>
        <button
          type="button"
          onClick={() => void begin()}
          className="mt-2 text-label text-accent underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!secret) {
    return <p className="mt-3 text-body text-ink-tertiary">Preparing your setup key…</p>;
  }

  return (
    <div className="mt-3">
      <p className="text-body text-ink-secondary">
        In your authenticator app (Google Authenticator, 1Password, Authy…), add an account with this
        setup key:
      </p>
      <p className="numeral mt-2 select-all break-all rounded-md bg-surface-sunken px-3 py-2 text-body tracking-[0.15em] text-ink">
        {groupSecret(secret)}
      </p>
      <p className="mt-2 text-meta text-ink-tertiary">
        Then enter the 6-digit code it shows to finish turning on two-factor authentication.
      </p>
      <CodeForm
        submitLabel="Turn on 2FA"
        busyLabel="Verifying…"
        onSubmit={async (code) => {
          const result = await verifyMfaEnrollment(code);
          if (result.kind === "ok") {
            onEnrolled();
            return null;
          }
          if (result.kind === "error") return result.message;
          return "Couldn't verify that code.";
        }}
      />
    </div>
  );
}

// ---- Settings card ---------------------------------------------------------

/**
 * The Settings entry point for two-factor. Only meaningful in multi-user mode
 * with a signed-in user (single-user mode has no login to attach a factor to),
 * so it renders nothing otherwise. Reads and refreshes the session so the on/off
 * state always reflects the server.
 */
export function MfaSetupCard() {
  const { state, refresh } = useSession();
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);

  if (state.status !== "ready" || state.mode !== "multi_user" || !state.user) return null;
  const enabled = state.user.mfa.enabled;

  return (
    <Card>
      <SectionLabel>Two-factor authentication</SectionLabel>
      <p className="mt-1 text-body text-ink-secondary">
        A second factor from an authenticator app is required before connecting a bank, so a stolen
        password alone can&rsquo;t reach your accounts.
      </p>

      {enabled ? (
        <div className="mt-3">
          <p className="text-body text-ink">
            <span
              className="mr-2 inline-block rounded-pill bg-rise-soft px-2 py-0.5 text-meta text-rise"
            >
              On
            </span>
            Authenticator app
          </p>
          {disabling ? (
            <div className="mt-3">
              <p className="text-body text-ink-secondary">
                Enter a current code to turn two-factor off.
              </p>
              <CodeForm
                submitLabel="Turn off 2FA"
                busyLabel="Turning off…"
                onSubmit={async (code) => {
                  const result = await disableMfa(code);
                  if (result.kind === "ok") {
                    await refresh();
                    setDisabling(false);
                    return null;
                  }
                  if (result.kind === "error") return result.message;
                  return "Couldn't turn it off.";
                }}
              />
              <button
                type="button"
                onClick={() => setDisabling(false)}
                className="mt-2 text-label text-ink-tertiary underline underline-offset-2"
              >
                Keep it on
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDisabling(true)}
              className="mt-3 min-h-[34px] rounded-md border border-line-subtle px-3 text-label text-ink-secondary hover:border-line-strong hover:text-ink"
            >
              Turn off
            </button>
          )}
        </div>
      ) : enrolling ? (
        <EnrollFlow
          onEnrolled={() => {
            void refresh();
            setEnrolling(false);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEnrolling(true)}
          className="mt-3 min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse"
          style={{ background: "var(--accent)" }}
        >
          Set up two-factor
        </button>
      )}
    </Card>
  );
}

// ---- Connect-a-bank gate dialog --------------------------------------------

/**
 * A modal the Accounts screen raises when Plaid Link is blocked on MFA. For a
 * user with no factor yet it embeds enrollment; for an enrolled session whose
 * step-up has lapsed it asks for a current code. Either way, `onCleared` fires
 * once the session is verified so the caller can retry connecting.
 */
export function MfaGateDialog({
  reason,
  onCleared,
  onCancel,
}: {
  reason: "enroll" | "challenge";
  onCleared: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Two-factor authentication required"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[460px] rounded-xl bg-surface-raised p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <SectionLabel>Two-factor required to connect a bank</SectionLabel>
        {reason === "enroll" ? (
          <>
            <p className="mt-1 text-body text-ink-secondary">
              Connecting a bank needs a second factor. Set one up with your authenticator app to
              continue.
            </p>
            <EnrollFlow onEnrolled={onCleared} />
          </>
        ) : (
          <>
            <p className="mt-1 text-body text-ink-secondary">
              Enter the current 6-digit code from your authenticator app to continue.
            </p>
            <CodeForm
              submitLabel="Continue"
              busyLabel="Verifying…"
              onSubmit={async (code) => {
                const result = await verifyMfaChallenge(code);
                if (result.kind === "ok") {
                  onCleared();
                  return null;
                }
                if (result.kind === "error") return result.message;
                return "Couldn't verify that code.";
              }}
            />
          </>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="mt-4 text-label text-ink-tertiary underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
