/**
 * Application shell.
 *
 * Web first. At desktop this is a fixed sidebar plus a wide content column —
 * a 560px centred strip on a 1440px display reads as a phone screenshot, not a
 * web app. Below `lg` the sidebar becomes a horizontal bar and the content
 * collapses to a single column, which is also the layout an eventual iOS build
 * would start from.
 *
 * Breakpoints:
 *   < 768px   single column, top nav          (phone)
 *   768–1023  single column, wider gutters    (tablet)
 *   ≥ 1024px  sidebar + two-column content    (desktop, primary target)
 */
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { Logo } from "./Logo";

/** Persist the desktop sidebar's collapsed state across reloads. */
const SIDEBAR_KEY = "bc:sidebar-collapsed";

export type NavItem<T extends string> = {
  id: T;
  label: string;
  hint?: string;
  disabled?: boolean;
};

/** Minimal shape of the signed-in user exposed to the shell. */
export type ShellUser = {
  displayName?: string;
  email: string;
  role: "user" | "admin";
};

export function AppShell<T extends string>({
  nav,
  current,
  onNavigate,
  onHome,
  onOpenSettings,
  settingsActive,
  footer,
  aside,
  user,
  onLogout,
  onChangePassword,
  children,
}: {
  nav: NavItem<T>[];
  current: T;
  onNavigate: (id: T) => void;
  /** Clicking the brand lockup goes "home" (the accounts overview). When
   *  omitted the logo is inert decoration. */
  onHome?: () => void;
  /** Settings deliberately isn't a nav item (it would spoil the CAPITAL
   *  acrostic). Instead a gear sits at the very bottom of the sidebar and in the
   *  mobile top bar. When omitted, no gear renders. */
  onOpenSettings?: () => void;
  /** Whether Settings is the current route, so the gear reflects the active
   *  page like the nav items do. */
  settingsActive?: boolean;
  footer?: ReactNode;
  /** Rendered inside the sidebar below the nav at desktop only. */
  aside?: ReactNode;
  /** When provided the shell shows the user's name and auth actions. */
  user?: ShellUser | null;
  onLogout?: () => void;
  onChangePassword?: () => void;
  children: ReactNode;
}) {
  // Desktop sidebar retract. Read synchronously from localStorage so the first
  // paint already matches the saved state (this is a client-only SPA, so the
  // window is always present; the guard is belt-and-braces).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* private-mode / storage-disabled: the toggle still works this session */
    }
  }, [collapsed]);

  // "[" toggles the rail — but not while typing or with a modifier held (so it
  // never eats a real bracket in an input or a browser shortcut).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) {
        return;
      }
      e.preventDefault();
      setCollapsed((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-screen lg:flex">
      {/* ---- Desktop sidebar ------------------------------------------- */}
      {/* Retractable: a full 248px column that collapses to a 64px rail. The
          width animates (instant under reduced motion); the state persists. */}
      {/* Pinned to the viewport: `sticky top-0 h-screen self-start` gives the
          column an explicit height so it stops stretching to match the (taller)
          content column in this flex row, and keeps it fixed in place as the
          page scrolls. No `overflow-y-auto` here — it would force overflow-x to
          `auto` and clip the collapsed rail's `left-full` hover flyouts. */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-line-subtle bg-surface-raised transition-[width] duration-300 ease-out motion-reduce:transition-none lg:sticky lg:top-0 lg:flex lg:h-screen lg:self-start ${
          collapsed ? "lg:w-[64px]" : "lg:w-[248px]"
        }`}
      >
        {/* Brand + collapse toggle. Expanded: lockup left, chevron right.
            Collapsed: just the coin mark and the chevron, stacked and centred. */}
        <div
          className={
            collapsed
              ? "flex flex-col items-center gap-3 px-2 py-6"
              : "flex items-center justify-between px-5 py-6"
          }
        >
          {/* The mark spills coins on hover here too — a small moment of life in
              the chrome, without the always-on beacon pulse. Each coin falls on
              its own random path (re-rolled per hover), collapsed rail included.
              `sparkle` also lets this always-visible mark catch a gold glint
              around its rim at random intervals. Clicking the lockup goes home. */}
          <BrandButton onHome={onHome} label="breadcrumbs — go to accounts">
            <Logo variant={collapsed ? "mark" : "full"} size={26} spill spillCount={8} sparkle />
          </BrandButton>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-keyshortcuts="["
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar  (  [  )" : "Collapse sidebar  (  [  )"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-body leading-none text-ink-tertiary transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
          </button>
        </div>

        <nav className={`flex flex-col gap-0.5 ${collapsed ? "px-2" : "px-3"}`} aria-label="Main">
          {nav.map((item) => (
            <SideLink
              key={item.id}
              collapsed={collapsed}
              active={item.id === current}
              disabled={item.disabled}
              onClick={() => onNavigate(item.id)}
              hint={item.hint}
              label={item.label}
            />
          ))}
        </nav>

        {/* Sidebar footer: scenarios switcher + theme toggle + user menu.
            mt-auto pushes the whole block to the bottom of the sidebar. The
            scenario switcher is text-heavy, so it's hidden in the rail. */}
        <div className="mt-auto">
          {!collapsed && aside && <div className="px-6 pt-6">{aside}</div>}
          <div
            className={
              collapsed
                ? "flex flex-col items-center gap-2 border-t border-line-subtle px-2 py-4"
                : "space-y-1 border-t border-line-subtle px-3 py-4"
            }
          >
            {onOpenSettings && (
              <SettingsLink
                collapsed={collapsed}
                active={!!settingsActive}
                onClick={onOpenSettings}
              />
            )}
            <ThemeToggle compact={collapsed} />
            {user &&
              (collapsed ? (
                <CollapsedUser user={user} onExpand={() => setCollapsed(false)} />
              ) : (
                <UserMenu
                  user={user}
                  onLogout={onLogout}
                  onChangePassword={onChangePassword}
                />
              ))}
          </div>
        </div>
      </aside>

      {/* ---- Mobile / tablet top bar ------------------------------------ */}
      <header className="sticky top-0 z-20 border-b border-line-subtle bg-surface-base/85 backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-[880px] items-center justify-between gap-4 px-5 py-3">
          <BrandButton onHome={onHome} label="breadcrumbs — go to accounts">
            <Logo variant="mark" size={26} />
          </BrandButton>
          <nav className="flex gap-0.5 overflow-x-auto" aria-label="Main">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={item.disabled}
                onClick={() => onNavigate(item.id)}
                aria-current={item.id === current ? "page" : undefined}
                className={`min-h-[34px] shrink-0 rounded-pill px-3 text-label transition-colors ${
                  item.id === current
                    ? "bg-accent-soft font-medium text-accent-ink"
                    : "text-ink-tertiary hover:text-ink-secondary"
                } disabled:opacity-30`}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                aria-current={settingsActive ? "page" : undefined}
                aria-label="Settings"
                title="Settings"
                className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                  settingsActive
                    ? "bg-accent-soft text-accent-ink"
                    : "text-ink-tertiary hover:bg-surface-sunken hover:text-ink"
                }`}
              >
                <GearIcon />
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* ---- Content ---------------------------------------------------- */}
      <div className="min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[1080px] px-5 pb-16 pt-6 md:px-8 lg:px-10 lg:pt-10">
          {/* Keyed on the route so each screen settles in with a short rise +
              fade rather than snapping into place. */}
          <div key={current} className="screen-enter">
            {children}
          </div>
        </main>
        {footer && (
          <div className="mx-auto w-full max-w-[1080px] px-5 pb-10 md:px-8 lg:px-10">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** Wraps the brand lockup in a button that goes home. When there's nowhere to
 *  go (no `onHome`) it stays a plain span, so the logo is never a dead button.
 *  The wrapper adds no box of its own — it's `contents`-like inline-flex with a
 *  focus ring — so the coin-spill/beacon animation and layout are untouched. */
function BrandButton({
  onHome,
  label,
  children,
}: {
  onHome?: () => void;
  label: string;
  children: ReactNode;
}) {
  if (!onHome) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={onHome}
      aria-label={label}
      title="Go to accounts"
      className="inline-flex items-center rounded-md outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
    >
      {children}
    </button>
  );
}

function SideLink({
  active,
  disabled,
  collapsed,
  onClick,
  hint,
  label,
}: {
  active: boolean;
  disabled?: boolean;
  collapsed: boolean;
  onClick: () => void;
  hint?: string;
  label: string;
}) {
  // Collapsed rail: a first-letter tile. One letter can't disambiguate a
  // text-only nav on its own (Accounts vs Assistant both "A"), so the full
  // label rides in on a hover flyout, and title/aria-label always carry it.
  if (collapsed) {
    const initial = label.trim().charAt(0).toUpperCase();
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        title={label}
        className={`group relative mx-auto flex h-10 w-10 items-center justify-center rounded-md text-body transition-colors ${
          active
            ? "bg-accent-soft font-medium text-accent-ink"
            : "text-ink-secondary hover:bg-surface-sunken/70 hover:text-ink"
        } disabled:opacity-30`}
      >
        <span aria-hidden="true">{initial}</span>
        <span className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line-subtle bg-surface-raised px-2 py-1 text-label text-ink opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100">
          {label}
          {hint ? ` · ${hint}` : ""}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-[38px] items-center gap-2.5 rounded-md px-3 text-left text-body transition-colors ${
        active
          ? "bg-accent-soft font-medium text-accent-ink"
          : "text-ink-secondary hover:bg-surface-sunken/70 hover:text-ink"
      } disabled:opacity-30`}
    >
      {/* A little beacon that lights up on the current page, echoing the mark. */}
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
          active ? "bg-accent" : "bg-transparent group-hover:bg-line-strong"
        }`}
      />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-meta text-ink-tertiary">{hint}</span>}
    </button>
  );
}

/** The settings gear. A plain currentColor stroke icon so it inherits the
 *  button's text colour (tertiary → ink on hover, accent-ink when active). */
function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** The Settings gear that lives at the bottom of the sidebar. Mirrors SideLink's
 *  two shapes (rail tile with hover flyout vs full row) but leads with the gear
 *  icon instead of the beacon dot, so it reads as a utility control set apart
 *  from the CAPITAL nav above it. */
function SettingsLink({
  active,
  collapsed,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        aria-label="Settings"
        title="Settings"
        className={`group relative mx-auto flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
          active
            ? "bg-accent-soft text-accent-ink"
            : "text-ink-secondary hover:bg-surface-sunken/70 hover:text-ink"
        }`}
      >
        <GearIcon />
        <span className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line-subtle bg-surface-raised px-2 py-1 text-label text-ink opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100">
          Settings
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-[38px] w-full items-center gap-2.5 rounded-md px-3 text-left text-body transition-colors ${
        active
          ? "bg-accent-soft font-medium text-accent-ink"
          : "text-ink-secondary hover:bg-surface-sunken/70 hover:text-ink"
      }`}
    >
      <GearIcon className="shrink-0" />
      <span className="flex-1">Settings</span>
    </button>
  );
}

/** Collapsed-rail stand-in for the user menu: an initial avatar that expands
 *  the sidebar (where Change password / Sign out live). */
function CollapsedUser({
  user,
  onExpand,
}: {
  user: ShellUser;
  onExpand: () => void;
}) {
  const name = user.displayName ?? user.email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <button
      type="button"
      onClick={onExpand}
      title={name}
      aria-label={`Signed in as ${name}. Expand the sidebar for account options.`}
      className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-label font-medium text-accent-ink transition-transform hover:scale-105"
    >
      <span aria-hidden="true">{initial}</span>
    </button>
  );
}

function UserMenu({
  user,
  onLogout,
  onChangePassword,
}: {
  user: ShellUser;
  onLogout?: () => void;
  onChangePassword?: () => void;
}) {
  const name = user.displayName ?? user.email;
  return (
    <div className="rounded-md px-3 py-2">
      <p className="truncate text-label font-medium text-ink" title={user.email}>
        {name}
      </p>
      {user.role === "admin" && (
        <p className="text-meta text-ink-tertiary">Admin</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {onChangePassword && (
          <button
            type="button"
            onClick={onChangePassword}
            className="text-meta text-ink-tertiary underline underline-offset-2 hover:text-ink-secondary"
          >
            Change password
          </button>
        )}
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="text-meta text-ink-tertiary underline underline-offset-2 hover:text-ink-secondary"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
