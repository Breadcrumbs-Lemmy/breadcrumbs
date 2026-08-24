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
import { useEffect, useRef, useState, type ReactNode } from "react";
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

/**
 * A titled group of nav items. Sections are the unit of the sidebar's structure:
 * each renders as a labelled cluster when the rail is expanded, and collapses to
 * a single letter — its header's initial — in the rail. Ordering the sections so
 * those initials read top-to-bottom is what lets the retracted rail spell a word
 * (here P·L·A·N: Pulse · Ledger · Ahead · Next), a small wink that costs nothing
 * because every feature keeps a plainly-named home inside its section.
 */
export type NavSection<T extends string> = {
  header: string;
  items: NavItem<T>[];
};

/** Minimal shape of the signed-in user exposed to the shell. */
export type ShellUser = {
  displayName?: string;
  email: string;
  role: "user" | "admin";
};

export function AppShell<T extends string>({
  sections,
  trailing,
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
  /** The grouped nav. Section order sets the collapsed-rail acrostic. */
  sections: NavSection<T>[];
  /** Utility items shown after the sections — outside the acrostic, so adding
   *  one (e.g. Admin) never disturbs the word. In the rail they render as plain
   *  letter tiles below a divider; on mobile as trailing pills. */
  trailing?: NavItem<T>[];
  current: T;
  onNavigate: (id: T) => void;
  /** Clicking the brand lockup goes "home" (the accounts overview). When
   *  omitted the logo is inert decoration. */
  onHome?: () => void;
  /** Settings deliberately isn't a nav item (it would tack an odd letter onto
   *  the PLAN acrostic). Instead a gear sits at the very bottom of the sidebar
   *  and in the mobile top bar. When omitted, no gear renders. */
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

  // The mobile bar is two rows: row 1 keeps all four section names on screen,
  // row 2 shows the pages of whichever section owns the current route. Settings
  // sits outside the sections, so there `activeSection` is undefined and row 2
  // simply doesn't render.
  const activeSection = sections.find((s) =>
    s.items.some((item) => item.id === current),
  );

  // Both mobile rows normally fit without scrolling (four short section pills;
  // a section's two-to-four pages). These refs are a defensive net: if a row
  // ever overflows, keep its active pill centred in view when the route changes.
  const sectionNavRef = useRef<HTMLElement | null>(null);
  const pageNavRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    for (const el of [sectionNavRef.current, pageNavRef.current]) {
      el?.querySelector<HTMLElement>("[aria-current]")?.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: "smooth",
      });
    }
  }, [current]);

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
          <BrandButton onHome={onHome} label="breadcrumbs — go to spending">
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

        {/* Grouped nav. Expanded: each section is a labelled cluster. Collapsed:
            each section is one letter (the acrostic), its pages tucked into a
            hover/focus flyout so the rail stays a clean four-letter word. */}
        <nav
          className={`flex flex-col ${collapsed ? "gap-1.5 px-2" : "gap-5 px-3"}`}
          aria-label="Main"
        >
          {sections.map((section) =>
            collapsed ? (
              <CollapsedSection
                key={section.header}
                section={section}
                current={current}
                onNavigate={onNavigate}
              />
            ) : (
              <div key={section.header} className="flex flex-col gap-0.5">
                <SectionHeader>{section.header}</SectionHeader>
                {section.items.map((item) => (
                  <SideLink
                    key={item.id}
                    collapsed={false}
                    active={item.id === current}
                    disabled={item.disabled}
                    onClick={() => onNavigate(item.id)}
                    hint={item.hint}
                    label={item.label}
                  />
                ))}
              </div>
            ),
          )}

          {/* Trailing utilities (Admin) sit apart from the acrostic. */}
          {trailing && trailing.length > 0 && (
            <div
              className={`flex flex-col gap-0.5 border-t border-line-subtle ${
                collapsed ? "mx-auto w-10 pt-1.5" : "pt-3"
              }`}
            >
              {trailing.map((item) => (
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
            </div>
          )}
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

      {/* ---- Mobile / tablet top bar (two-tier) ------------------------- */}
      {/* No rail to spell a word here, and ten pages won't fit one row. So the
          nav splits: row 1 keeps all four PLAN section names on screen at once
          (the grouping stays legible without scrolling), and row 2 shows only
          the pages of the active section — never a horizontal scroll of ten,
          never an active page hidden off-screen. Section pills read as tabs
          (label + accent underline); page pills reuse the filled MobilePill,
          so the two levels are visually distinct. */}
      <header className="sticky top-0 z-20 border-b border-line-subtle bg-surface-base/85 backdrop-blur-md lg:hidden">
        {/* Row 1 — brand · section tabs · utilities */}
        <div className="mx-auto flex max-w-[880px] items-center gap-2 px-4 py-2.5">
          <BrandButton onHome={onHome} label="breadcrumbs — go to spending">
            <Logo variant="mark" size={26} />
          </BrandButton>
          <nav
            ref={sectionNavRef}
            className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto"
            aria-label="Sections"
          >
            {sections.map((section) => {
              // A section pill navigates to the section's first page — the same
              // "section home" one-tap shortcut the collapsed rail tile uses
              // (see CollapsedSection). Tapping the section you're already in
              // therefore moves you to its first page (e.g. Goals → Cash-flow);
              // that is deliberate, not a stray jump. Moving between the pages
              // of the active section is Row 2's job below, and aria-current
              // here marks the active *section*, not this specific page.
              const primary = section.items[0];
              const activeInSection = section.items.some((item) => item.id === current);
              return (
                <button
                  key={section.header}
                  type="button"
                  onClick={() => primary && onNavigate(primary.id)}
                  aria-current={activeInSection ? "true" : undefined}
                  title={`${section.header}: ${section.items.map((i) => i.label).join(", ")}`}
                  className={`flex shrink-0 flex-col items-center rounded-md px-1.5 py-1 text-label transition-colors ${
                    activeInSection
                      ? "font-medium text-accent-ink"
                      : "text-ink-tertiary hover:text-ink-secondary"
                  }`}
                >
                  <span>{section.header}</span>
                  {/* Active-tab underline — echoes the expanded sidebar's beacon
                      dot without needing an icon. */}
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 h-0.5 w-5 rounded-full transition-colors ${
                      activeInSection ? "bg-accent" : "bg-transparent"
                    }`}
                  />
                </button>
              );
            })}
          </nav>
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Admin (trailing) sits with the utilities, outside the acrostic,
                so it's reachable from every section rather than tucked into one
                section's page row. */}
            {trailing?.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={item.id === current ? "page" : undefined}
                className={`rounded-md px-2 py-1.5 text-meta transition-colors ${
                  item.id === current
                    ? "text-accent-ink"
                    : "text-ink-tertiary hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
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
            {/* Icon-only here (its label would crowd out the section tabs); the
                gear beside it is icon-only too, so they read as a matched pair. */}
            <span className="flex h-9 w-9 shrink-0 items-center">
              <ThemeToggle compact />
            </span>
          </div>
        </div>

        {/* Row 2 — the active section's pages. Absent on Settings (which lives
            outside the sections); the gear already shows its own active state. */}
        {activeSection && (
          <nav
            ref={pageNavRef}
            aria-label={`${activeSection.header} pages`}
            className="mx-auto flex max-w-[880px] items-center gap-1 overflow-x-auto border-t border-line-subtle/60 px-4 py-1.5"
          >
            {activeSection.items.map((item) => (
              <MobilePill
                key={item.id}
                item={item}
                active={item.id === current}
                onClick={() => onNavigate(item.id)}
              />
            ))}
          </nav>
        )}
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

/** Expanded-rail section label. Quiet, uppercase, set above its item cluster. */
function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-1 text-[0.68rem] font-medium uppercase tracking-[0.14em] text-ink-tertiary">
      {children}
    </p>
  );
}

/**
 * A section in the retracted rail: one letter tile — the header's initial, the
 * character that spells the acrostic — with the section's pages tucked into a
 * flyout revealed on hover or keyboard focus. Clicking the tile itself is a
 * shortcut to the section's first page, so the rail keeps one-click navigation
 * while the flyout adds precision. The tile lights up when the current page
 * lives anywhere in the section.
 */
function CollapsedSection<T extends string>({
  section,
  current,
  onNavigate,
}: {
  section: NavSection<T>;
  current: T;
  onNavigate: (id: T) => void;
}) {
  const initial = section.header.trim().charAt(0).toUpperCase();
  const primary = section.items[0];
  const activeInSection = section.items.some((item) => item.id === current);

  return (
    <div className="group relative mx-auto">
      <button
        type="button"
        onClick={() => primary && onNavigate(primary.id)}
        aria-current={activeInSection ? "true" : undefined}
        aria-label={`${section.header}: ${section.items.map((i) => i.label).join(", ")}`}
        title={section.header}
        className={`flex h-10 w-10 items-center justify-center rounded-md text-body transition-colors ${
          activeInSection
            ? "bg-accent-soft font-medium text-accent-ink"
            : "text-ink-secondary hover:bg-surface-sunken/70 hover:text-ink"
        }`}
      >
        <span aria-hidden="true">{initial}</span>
      </button>

      {/* Flyout. `invisible` (not just opacity-0) keeps the buttons out of the
          tab order and un-clickable until the group is hovered or focused. */}
      <div className="invisible absolute left-full top-0 z-30 ml-2 w-52 rounded-md border border-line-subtle bg-surface-raised p-1 opacity-0 shadow-md transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <p className="px-2 pb-1 pt-1 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-ink-tertiary">
          {section.header}
        </p>
        {section.items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => onNavigate(item.id)}
            aria-current={item.id === current ? "page" : undefined}
            className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-label transition-colors ${
              item.id === current
                ? "bg-accent-soft font-medium text-accent-ink"
                : "text-ink-secondary hover:bg-surface-sunken hover:text-ink"
            } disabled:opacity-30`}
          >
            <span>{item.label}</span>
            {item.hint && <span className="shrink-0 text-meta text-ink-tertiary">{item.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One pill in the mobile top bar. */
function MobilePill<T extends string>({
  item,
  active,
  onClick,
}: {
  item: NavItem<T>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={item.disabled}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={item.hint ? `${item.label} · ${item.hint}` : item.label}
      className={`min-h-[34px] shrink-0 rounded-pill px-3 text-label transition-colors ${
        active
          ? "bg-accent-soft font-medium text-accent-ink"
          : "text-ink-tertiary hover:text-ink-secondary"
      } disabled:opacity-30`}
    >
      {item.label}
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
 *  from the PLAN nav above it. */
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
