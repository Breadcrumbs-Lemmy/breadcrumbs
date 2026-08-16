/**
 * Theme toggle button — cycles Light → Dark → System.
 *
 * Shown in both the desktop sidebar and the mobile top bar, so the size is
 * small enough to fit the compact mobile bar without wrapping. The current
 * mode is always labelled, not just implied by the icon, so a first-time
 * user doesn't have to guess what clicking it does.
 *
 * The switch is a signature moment: where the browser supports the View
 * Transitions API, the new theme is revealed with a circular wipe out from the
 * point the user clicked (see the ::view-transition rules in index.css). It is
 * pure progressive enhancement — browsers without the API, and anyone who
 * prefers reduced motion, get an instant swap with identical end state.
 *
 * Icons are plain Unicode characters — no emoji that renders differently
 * across platforms, no SVG import.
 */
import { useTheme, type Theme } from "../theme";
import { swallowTransitionRejections, type ViewTransitionLike } from "./theme-transition";

const CYCLE: readonly Theme[] = ["light", "dark", "system"] as const;

const LABELS: Record<Theme, string> = {
  light: "Light",
  dark:  "Dark",
  system: "System",
};

const ICONS: Record<Theme, string> = {
  light:  "○",  // open circle — "on"
  dark:   "●",  // filled circle — "off"
  system: "◑",  // half circle — "following OS"
};

type StartViewTransition = (cb: () => void) => ViewTransitionLike;

export function ThemeToggle({ compact = false }: { compact?: boolean } = {}) {
  const { theme, setTheme } = useTheme();
  const idx = CYCLE.indexOf(theme);
  // noUncheckedIndexedAccess: CYCLE has exactly 3 elements and idx is always
  // 0–2 after indexOf, so the fallback "system" is a safety net only.
  const next = CYCLE[(idx + 1) % CYCLE.length] ?? "system";

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    const doc = document as Document & { startViewTransition?: StartViewTransition };
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Fallback: no API support or reduced motion → swap instantly.
    if (!doc.startViewTransition || reduce) {
      setTheme(next);
      return;
    }

    // Anchor the reveal circle at the click so the new theme appears to wipe
    // out from the toggle itself.
    const root = document.documentElement;
    root.style.setProperty("--vt-x", `${e.clientX}px`);
    root.style.setProperty("--vt-y", `${e.clientY}px`);
    // Capture the transition and swallow its expected `ready`/`finished`
    // rejections (skipped/aborted transition, or a hidden document) so they
    // don't surface as uncaught promise rejections — the swap still happens
    // via the update callback (B9).
    swallowTransitionRejections(doc.startViewTransition(() => setTheme(next)));
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Theme: ${LABELS[theme]} — click for ${LABELS[next]}`}
      aria-label={`Switch from ${LABELS[theme]} to ${LABELS[next]} theme`}
      className={`flex min-h-[34px] items-center rounded-md text-label text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink ${
        compact ? "w-full justify-center px-0" : "gap-1.5 px-2.5"
      }`}
    >
      <span aria-hidden="true" className="text-[11px] leading-none text-accent">
        {ICONS[theme]}
      </span>
      {/* The label is hidden in the collapsed rail; the title still explains it. */}
      {!compact && <span>{LABELS[theme]}</span>}
    </button>
  );
}
