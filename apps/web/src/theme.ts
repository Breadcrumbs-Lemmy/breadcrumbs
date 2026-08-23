/**
 * Theme management for Breadcrumbz.
 *
 * Three user-visible choices:
 *   "light"  — always use light tokens, even when the OS is dark
 *   "dark"   — always use dark tokens, even when the OS is light
 *   "system" — follow the OS preference via @media (prefers-color-scheme)
 *
 * The choice is stored in localStorage under `bc_theme` and applied to
 * `document.documentElement.dataset.theme` before first React paint by an
 * inline <script> in index.html, so there is no flash on reload.
 *
 * CSS reads `data-theme`:
 *   "light"  → :root[data-theme="light"] — just the existing :root light block
 *   "dark"   → :root[data-theme="dark"]  — explicit dark token override
 *   absent   → @media (prefers-color-scheme: dark) decides (System mode)
 */
import { useState, useCallback } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "bc_theme";

/** Apply a theme choice: sets or removes data-theme, then persists. */
export function applyTheme(theme: Theme): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing or storage quota exceeded — proceed without persistence.
  }
}

/** Read the last-stored choice without applying it (used to initialise state). */
export function readStoredTheme(): Theme | null {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") return val;
  } catch {
    // ignore
  }
  return null;
}

/**
 * React hook for the active theme.
 *
 * Initialises from localStorage so the React state matches what the inline
 * script already applied to the DOM. Does NOT call applyTheme on mount
 * because the inline script has already done that — calling it here would
 * be a no-op at best and a flicker at worst.
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? "system");

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  return { theme, setTheme };
}
