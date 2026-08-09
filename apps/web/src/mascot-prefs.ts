/**
 * Assistant-coin (mascot) preferences.
 *
 * The bottom-right "b" coin is alive by default — it idly rolls, the little
 * b-guy peeks over the rim, and a thought-bubble invites a question. Delightful
 * for most, distracting for some. These preferences let anyone dial that down
 * from the Settings screen, all the way to hiding the coin entirely.
 *
 * The model is three orthogonal choices:
 *   visible   — is the coin shown at all (App.tsx gates the whole mount on this)
 *   movement  — does the coin idly roll / flick (the rAF director)
 *   character — how the b-guy behaves:
 *                 "auto"   — climbs up to peek every so often (the default)
 *                 "always" — stays visible over the rim all the time, no motion
 *                 "off"    — never appears
 *
 * Three quick presets set all three at once (Lively / Calm / Off); the Settings
 * screen also exposes the individual controls. "Calm" is the user's key ask: a
 * still coin with the b-guy and its thought-bubble on screen the whole time.
 *
 * Unlike `theme.ts` (whose choice is a global DOM side-effect the whole app sees
 * via CSS), a mascot pref must reach the already-mounted mascot's rAF director,
 * which observes no DOM signal on its own. So this is a tiny shared store with a
 * subscription — the Settings screen writes, the mascot re-reads live — surfaced
 * to React through useSyncExternalStore. Persisted in localStorage under
 * `bc:mascot`, guarded like the theme so private-mode / quota errors are silent.
 *
 * OS `prefers-reduced-motion` is a floor the mascot honours separately: it never
 * forces motion on a reduced-motion user regardless of these prefs. That lives
 * in the component, not here — this module only records what the user asked for.
 */
import { useCallback, useSyncExternalStore } from "react";

export type MascotCharacter = "auto" | "always" | "off";

export type MascotPrefs = {
  visible: boolean;
  movement: boolean;
  character: MascotCharacter;
};

export type MascotPreset = "lively" | "calm" | "off";

const STORAGE_KEY = "bc:mascot";

export const MASCOT_DEFAULTS: MascotPrefs = {
  visible: true,
  movement: true,
  character: "auto",
};

/** The three one-tap presets. Each fully specifies every field, so applying one
 *  is a clean reset rather than a partial merge. */
export const MASCOT_PRESETS: Record<MascotPreset, MascotPrefs> = {
  lively: { visible: true, movement: true, character: "auto" },
  // The user's definition of calm: coin still, b-guy AND its bubble on screen
  // all the time (character "always"), nothing moving.
  calm: { visible: true, movement: false, character: "always" },
  off: { visible: false, movement: false, character: "off" },
};

/** Which preset (if any) the current prefs exactly match — for reflecting the
 *  active chip in the UI. Returns null for a custom combination. */
export function mascotPresetOf(prefs: MascotPrefs): MascotPreset | null {
  for (const key of Object.keys(MASCOT_PRESETS) as MascotPreset[]) {
    const p = MASCOT_PRESETS[key];
    if (p.visible === prefs.visible && p.movement === prefs.movement && p.character === prefs.character) {
      return key;
    }
  }
  return null;
}

/** Coerce anything read from storage (or a stale older shape) into a valid,
 *  fully-populated prefs object — missing/garbage fields fall back to defaults. */
function normalize(value: unknown): MascotPrefs {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const character: MascotCharacter =
    o.character === "always" || o.character === "off" || o.character === "auto"
      ? o.character
      : MASCOT_DEFAULTS.character;
  return {
    visible: typeof o.visible === "boolean" ? o.visible : MASCOT_DEFAULTS.visible,
    movement: typeof o.movement === "boolean" ? o.movement : MASCOT_DEFAULTS.movement,
    character,
  };
}

function readStored(): MascotPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    // Private browsing, quota, or malformed JSON — fall through to defaults.
  }
  return { ...MASCOT_DEFAULTS };
}

// ---- the shared store ------------------------------------------------------
// One cached snapshot so useSyncExternalStore sees a stable reference between
// changes (it only ever compares identities), replaced wholesale on each write.

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: MascotPrefs | null = null;

function getSnapshot(): MascotPrefs {
  if (!snapshot) snapshot = readStored();
  return snapshot;
}

/** Replace the current prefs: persist, then notify every subscriber (the mascot
 *  director and any mounted Settings UI) so they re-read immediately. */
export function setMascotPrefs(next: MascotPrefs): void {
  snapshot = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is best-effort; the in-memory snapshot still drives this session.
  }
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook for the mascot prefs. Every consumer shares one store, so a change
 * on the Settings screen re-renders the mounted mascot in the same tick.
 *   - `setPrefs` replaces the whole object (used by preset chips)
 *   - `update`   patches one or more fields (used by the individual controls)
 */
export function useMascotPrefs(): {
  prefs: MascotPrefs;
  setPrefs: (next: MascotPrefs) => void;
  update: (patch: Partial<MascotPrefs>) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setPrefs = useCallback((next: MascotPrefs) => setMascotPrefs(next), []);
  const update = useCallback(
    (patch: Partial<MascotPrefs>) => setMascotPrefs({ ...getSnapshot(), ...patch }),
    [],
  );
  return { prefs, setPrefs, update };
}
