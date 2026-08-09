/**
 * Login screen — shown in multi_user mode when no valid session exists.
 *
 * Deliberately quiet: a finance app people open when anxious shouldn't greet
 * them with a loud marketing hero. The form is centred, the words are plain,
 * and the one accent colour is on the primary action.
 *
 * Does NOT implement MFA. A clearly-commented placeholder marks the spot where
 * SMS or TOTP verification would be inserted if the backend adds it.
 */
import { useState } from "react";
import { useSession } from "../services/session";
import { register as apiRegister, setBearerToken } from "../services/api";
import { Logo } from "../components/Logo";

export function LoginScreen({
  registrationOpen,
  onRegistered,
}: {
  registrationOpen: boolean;
  onRegistered?: () => void;
}) {
  const [view, setView] = useState<"login" | "register">("login");

  if (view === "register" && registrationOpen) {
    return (
      <RegisterForm
        onSuccess={onRegistered}
        onBack={() => setView("login")}
      />
    );
  }

  return (
    <SignInForm
      onShowRegister={registrationOpen ? () => setView("register") : undefined}
    />
  );
}

// ---- Sign-in form ----------------------------------------------------------

function SignInForm({ onShowRegister }: { onShowRegister?: () => void }) {
  const { login } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await login(email, password);
    setBusy(false);
    if (err) setError(err);

    // TODO: MFA placeholder — if the backend returns a `requiresMfa` flag in
    // the 401 body, render an OTP/SMS challenge step here before completing
    // the session handoff. The session provider's login() would need to expose
    // that signal; today it doesn't because MFA is not implemented.
  }

  return (
    <AuthShell title="Sign in to Breadcrumbs">
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <Field label="Email">
          <input
            type="email"
            className="input"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            className="input"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        {error && <p className="text-body text-alert">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] w-full rounded-md bg-accent text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {onShowRegister && (
        <p className="mt-5 text-center text-body text-ink-secondary">
          New here?{" "}
          <button
            type="button"
            onClick={onShowRegister}
            className="text-accent underline underline-offset-2"
          >
            Create an account
          </button>
        </p>
      )}
    </AuthShell>
  );
}

// ---- Register form ---------------------------------------------------------

function RegisterForm({
  onSuccess,
  onBack,
}: {
  onSuccess?: () => void;
  onBack: () => void;
}) {
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiRegister(email, password, displayName || undefined);
    setBusy(false);
    if (result.kind === "ok") {
      setBearerToken(result.data.token);
      await refresh();
      onSuccess?.();
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setError("Registration failed.");
    }
  }

  return (
    <AuthShell title="Create your account">
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <Field label="Name (optional)">
          <input
            type="text"
            className="input"
            value={displayName}
            autoComplete="name"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            className="input"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            className="input"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </Field>

        {error && <p className="text-body text-alert">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] w-full rounded-md bg-accent text-body font-medium text-ink-inverse shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-5 text-center text-body text-ink-secondary">
        Already have an account?{" "}
        <button
          type="button"
          onClick={onBack}
          className="text-accent underline underline-offset-2"
        >
          Sign in
        </button>
      </p>
    </AuthShell>
  );
}

// ---- shared layout ---------------------------------------------------------

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // Transparent so the ambient background (grain + glows) shows through; the
    // brand hero sits directly on the trail.
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-[400px]">
        {/* Brand hero: the mark draws itself in, the beacon pulses, and a plain
            one-line promise sets the non-judgemental tone before any form. */}
        <div className="mb-9">
          <Logo size={30} beacon wordmarkClassName="text-[1.45rem]" />
          <p className="mt-3 max-w-[32ch] text-body text-ink-secondary">
            Follow the trail your money left — see where it goes, no judgement.
          </p>
        </div>
        <h1 className="mb-6 font-display text-[1.5rem] font-medium tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-label text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}
