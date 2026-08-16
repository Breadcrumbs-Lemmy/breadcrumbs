/**
 * Admin screen — user management for deployment admins.
 *
 * Only rendered when the signed-in user has role="admin". A non-admin who
 * reaches this screen (e.g. via URL hacking) would get 403s from every API
 * call, but the nav item is also hidden so the path is never accidentally
 * offered.
 *
 * Actions available:
 *   • List all users (email, name, role, status, last login)
 *   • Create a new user
 *   • Toggle role user ↔ admin
 *   • Enable / disable a user
 *   • Reset a user's password (admin sets it directly)
 */
import { useCallback, useEffect, useState } from "react";
import {
  adminListUsers,
  adminCreateUser,
  adminSetRole,
  adminSetStatus,
  adminResetPassword,
  type PublicUser,
} from "../services/api";
import { Card, SectionLabel } from "../components/ui";
import { formatDate } from "../format/dates";
import { pluralize } from "../format/counts";
import { toggleErrorMessage } from "./admin-errors";

export function AdminScreen() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  /** The user whose password is being reset, driving the reset modal. A modal is
   *  used instead of `prompt()` so the field is a real password input (masked,
   *  not echoed in a system dialog) and failures surface inline. */
  const [resetTarget, setResetTarget] = useState<PublicUser | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await adminListUsers();
    setLoading(false);
    if (result.kind === "ok") {
      setUsers(result.data.users);
    } else if (result.kind === "error") {
      setError(result.message);
    } else if (result.kind === "unauthenticated") {
      setError("Access denied. Admin role required.");
    } else {
      setError("Couldn't load users.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleRoleToggle(user: PublicUser) {
    const newRole = user.role === "admin" ? "user" : "admin";
    setError(null);
    const result = await adminSetRole(user.id, newRole);
    if (result.kind === "ok") {
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? result.data.user : u)),
      );
    } else {
      // Without this the click was a silent no-op — e.g. the server rejects
      // demoting the last admin, and the row simply didn't change (B4).
      setError(toggleErrorMessage(result, "change this user's role"));
    }
  }

  async function handleStatusToggle(user: PublicUser) {
    const newStatus = user.status === "active" ? "disabled" : "active";
    setError(null);
    const result = await adminSetStatus(user.id, newStatus);
    if (result.kind === "ok") {
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? result.data.user : u)),
      );
    } else {
      setError(toggleErrorMessage(result, "change this user's status"));
    }
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      )}

      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-heading text-ink">User management</h1>
          <p className="mt-0.5 text-body text-ink-secondary">
            {/* Hold a dash until the fetch settles so the count never flashes
                "0 accounts" before the real number arrives (B12). */}
            {loading || error ? "—" : pluralize(users.length, "account")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse"
          style={{ background: "var(--accent)" }}
        >
          {showCreate ? "Cancel" : "Add user"}
        </button>
      </div>

      {showCreate && (
        <div className="mb-6">
          <CreateUserForm
            onCreated={() => {
              setShowCreate(false);
              void reload();
            }}
          />
        </div>
      )}

      {error && (
        <Card className="mb-5">
          <p className="text-body text-alert">{error}</p>
        </Card>
      )}

      {loading && <div className="h-[320px] animate-pulse rounded-lg bg-surface-sunken" aria-hidden="true" />}

      {!loading && users.length === 0 && !error && (
        <Card>
          <p className="text-body text-ink-secondary">No users yet.</p>
        </Card>
      )}

      {!loading && users.length > 0 && (
        <>
          <SectionLabel>All accounts</SectionLabel>
          <Card padded={false} className="overflow-hidden">
            {users.map((user, i) => (
              <UserRow
                key={user.id}
                user={user}
                first={i === 0}
                onRoleToggle={() => void handleRoleToggle(user)}
                onStatusToggle={() => void handleStatusToggle(user)}
                onResetPassword={() => setResetTarget(user)}
              />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

// ---- Reset password modal --------------------------------------------------

function ResetPasswordModal({ user, onClose }: { user: PublicUser; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await adminResetPassword(user.id, password);
    setBusy(false);
    if (result.kind === "ok") {
      setDone(true);
      setTimeout(onClose, 1200);
    } else if (result.kind === "error") {
      setError(result.message);
    } else if (result.kind === "unauthenticated") {
      setError("Access denied. Admin role required.");
    } else {
      setError("Password reset failed.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Reset password for ${user.email}`}
    >
      <Card className="w-full max-w-[400px]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-heading text-ink">Reset password</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-tertiary hover:text-ink">
            ✕
          </button>
        </div>
        {done ? (
          <p className="text-body text-accent">Password reset for {user.email}.</p>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <p className="text-meta text-ink-tertiary">
              Setting a new password for <span className="text-ink-secondary">{user.email}</span>. Every existing
              session for this account is signed out.
            </p>
            <label className="block">
              <span className="mb-1 block text-label text-ink-secondary">New password</span>
              <input
                type="password"
                className="input"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
              />
            </label>
            {error && <p className="text-body text-alert">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="min-h-[40px] w-full rounded-md bg-accent text-body font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

// ---- User row --------------------------------------------------------------

function UserRow({
  user,
  first,
  onRoleToggle,
  onStatusToggle,
  onResetPassword,
}: {
  user: PublicUser;
  first: boolean;
  onRoleToggle: () => void;
  onStatusToggle: () => void;
  onResetPassword: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${
        first ? "" : "border-t border-line-subtle"
      } ${user.status === "disabled" ? "opacity-60" : ""}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium text-ink">
            {user.displayName ?? user.email}
          </span>
          <RoleBadge role={user.role} />
          {user.status === "disabled" && (
            <span className="rounded-pill bg-surface-sunken px-2 py-0.5 text-meta text-ink-tertiary">
              disabled
            </span>
          )}
        </div>
        {user.displayName && (
          <span className="block text-meta text-ink-tertiary">{user.email}</span>
        )}
        <span className="block text-meta text-ink-tertiary">
          {user.lastLoginAt
            ? `Last login ${formatDate(user.lastLoginAt.slice(0, 10))}`
            : "Never logged in"
          }
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <ActionButton onClick={onRoleToggle}>
          {user.role === "admin" ? "Remove admin" : "Make admin"}
        </ActionButton>
        <ActionButton onClick={onStatusToggle}>
          {user.status === "active" ? "Disable" : "Enable"}
        </ActionButton>
        <ActionButton onClick={onResetPassword}>Reset password</ActionButton>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: PublicUser["role"] }) {
  if (role !== "admin") return null;
  return (
    <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-meta text-accent">
      Admin
    </span>
  );
}

function ActionButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[30px] rounded-md border border-line-subtle px-3 text-label text-ink-secondary hover:border-line-strong hover:text-ink"
    >
      {children}
    </button>
  );
}

// ---- Create user form ------------------------------------------------------

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await adminCreateUser({
      email,
      password,
      displayName: displayName || undefined,
      role,
    });
    setBusy(false);
    if (result.kind === "ok") {
      onCreated();
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setError("Couldn't create user.");
    }
  }

  return (
    <Card>
      <SectionLabel>New account</SectionLabel>
      <form onSubmit={(e) => void handleSubmit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-label text-ink-secondary">Email</span>
          <input
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-label text-ink-secondary">Name (optional)</span>
          <input
            type="text"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-label text-ink-secondary">Password</span>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-label text-ink-secondary">Role</span>
          <select
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>

        {error && <p className="col-span-full text-body text-alert">{error}</p>}

        <div className="col-span-full flex gap-3">
          <button
            type="submit"
            disabled={busy}
            className="min-h-[38px] rounded-md px-4 text-body font-medium text-ink-inverse disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {busy ? "Creating…" : "Create account"}
          </button>
        </div>
      </form>
    </Card>
  );
}
