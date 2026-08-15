/**
 * AssistantMascot — a realistic, solid gold "b" coin with a little character
 * living behind it.
 *
 * The coin is a genuine CSS 3D cylinder anchored in the bottom-right corner:
 * two minted faces (radial gold gradient, milled inner ring, an embossed "b",
 * a specular highlight and a warm bounce light) offset along Z, joined by a
 * reeded (knurled) gold RIM built from a ring of segment divs. Because it has
 * real thickness, a spin shows the metal edge instead of collapsing to a flat
 * line — it reads as a solid coin from every angle, in both themes.
 *
 * It is alive in three ways, all driven by a single rAF "director":
 *   - a flick: now and then the coin is "flicked" into a rapid full spin on its
 *     vertical axis that decays under friction and lands face-on;
 *   - a roll: now and then it rolls a short distance left and right and returns,
 *     leaning into the motion — bounded so it never reaches content or the edge;
 *   - a peek: every so often the little teal "b-guy" climbs up from behind,
 *     pops his head over the top rim (hands gripping the edge) and floats a chat
 *     thought-bubble inviting you to ask about the page you're on.
 *
 * Clicking the coin opens a compact, page-aware assistant that greets you about
 * the current screen, pre-seeds a few questions the grounded tools can answer,
 * and talks over the same transport as the full Assistant screen.
 *
 * Motion discipline mirrors the rest of the app:
 *   - one requestAnimationFrame loop owns the coin's transform; peeks are timed;
 *   - it honours `prefers-reduced-motion` live (coin rests face-on, guy hidden);
 *   - it pauses while the tab is hidden and while the panel is open;
 *   - the peek is a CSS transition whose resting state is the plain face-on coin,
 *     so a reduced-motion collapse leaves it calm and neutral.
 *
 * Presentation and transport only — nothing here derives a financial value; the
 * answers come from the server's grounded tools, same as AssistantScreen.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  fetchAgentStatus,
  sendAgentTurn,
  TOOL_LABELS,
  type AgentStatus,
  type AgentToolCallRecord,
} from "../services/agent";
import { useAssistantViewScope, type AssistantScope } from "../services/assistant-scope";
import { useMascotPrefs } from "../mascot-prefs";
import { Chip } from "./ui";

// ---- coin geometry (the 3D cylinder) ---------------------------------------

const RIM_R = 37; // rim radius, px (a hair inside the face so it tucks under)
const HALF_T = 4; // half the coin's thickness, px (→ 8px thick)
const RIM_SEGMENTS = 56; // segment divs forming the cylindrical, reeded edge

// One flat segment per slice of the rim; its width spans the thickness and its
// height spans the chord, positioned tangent to the cylinder about the coin's
// normal (the Z axis): rotate around Z to the slice angle, push out to the rim
// radius, then turn 90° so the face points radially outward.
const RIM_CHORD = (2 * Math.PI * RIM_R) / RIM_SEGMENTS + 1.1; // +overlap, no gaps
const RIM_SEG_STYLES = Array.from({ length: RIM_SEGMENTS }, (_, i) => {
  const phi = (i / RIM_SEGMENTS) * 360;
  return {
    width: HALF_T * 2,
    height: RIM_CHORD,
    marginTop: -RIM_CHORD / 2,
    marginLeft: -HALF_T,
    transform: `rotateZ(${phi}deg) translateX(${RIM_R}px) rotateY(90deg)`,
  } as const;
});

// ---- responsive layout + motion tuning -------------------------------------
// The mascot lives in one of two layouts, chosen by viewport width:
//   • CORNER (roomy screens) — the coin sits in the bottom-right corner and,
//     now and then, rolls a long way LEFT along the bottom of the screen (almost
//     to the content) and back, peeking/flicking as it goes.
//   • DOCKED (phones / cramped screens, where a bottom-right coin would overlap
//     content and has no room to roll) — the coin hangs off the RIGHT edge with
//     ~1/3 tucked off-screen, rolls UP and DOWN the edge (up only to about the
//     screen's middle), and the b-guy peeks out to the SIDE.

const STAGE = 76; // the stage's intrinsic px box (before --coin-scale)
const RIGHT_INSET = 22; // .mascot-root right offset in corner mode (matches CSS)

/** Below this width we dock to the edge. Matches the app's phone break: at this
 *  size a bottom-right coin overlaps the single content column with no room to
 *  roll sideways. Kept just under a round number so 640px itself stays corner. */
const DOCK_MQ = "(max-width: 639.98px)";

// Corner-mode roll: a believable rolling speed (viewport px/s) with a clamped
// duration, and how far along the free left room a single excursion travels.
const ROLL_SPEED = 320;
const ROLL_MIN_DUR = 0.9;
const ROLL_MAX_DUR = 3.4;
const CORNER_SAFE_LEFT_GAP = 24; // stop this far short of the sidebar / content
// Keep the roll modest: the coin stays in the right portion of the screen so it
// never wanders across the (often full-width) content column and covers it. The
// travel envelope is the SMALLER of the room to the sidebar/content and a capped
// fraction of the viewport width, and a single excursion is a fraction of that.
const CORNER_MAX_TRAVEL_VW = 0.26; // never roll more than ~1/4 of the viewport left
// A viewport fraction alone grows without bound on wide screens: 0.26 * 2056px is
// ~534px, which walks the coin's leading edge deep into the centered content
// column. Clamp the roll to an absolute distance too so a wide monitor doesn't
// widen the wander — the coin stays in the right gutter regardless of screen size.
const CORNER_MAX_TRAVEL_PX = 260;
const CORNER_ROLL_MIN_FRAC = 0.35;
const CORNER_ROLL_MAX_FRAC = 1.0;
// Content-aware stop: never let the coin's leading edge cross this far past the
// right edge of any card sitting in its (bottom) roll band. On a wide, dense page
// (e.g. Transactions) this pins the coin to the right gutter; on a page whose
// bottom band is empty it lets the coin take the full capped roll.
const CORNER_CONTENT_CLEAR_GAP = 16;
// When content reaches into the coin's home corner (a full-height right-column
// card, e.g. Pulse → Year → all accounts) there's no gutter beside it and no room
// below, so the coin would rest ON the content. Instead we tuck the RESTING coin
// rightward — partly off the edge — until its leading edge clears the content,
// keeping at least this many px of coin visible, and route its peek out to the
// SIDE (like docked) so the guy stays discoverable against the thin sliver.
const CORNER_MIN_VISIBLE = 26;

// Docked-mode vertical roll: home sits in the lower half; the coin may roll UP
// only to about the screen's middle, and dip a little below home.
const DOCK_HOME_VH = 0.64; // .mascot-root top (fraction of viewport height)
const DOCK_TOP_LIMIT_VH = 0.5; // highest the coin travels (≈ screen middle)
const DOCK_DOWN_VH = 0.09; // how far below home it may dip
const DOCK_UP_MIN_FRAC = 0.4; // shortest upward roll (fraction of the up room)

/** How long to let the guy climb back DOWN (a real reverse of the climb up)
 *  before the mascot is freed for its next move — long enough that the descent
 *  animation completes and he tucks fully behind the coin, never blinking out.
 *  Must cover the CSS climb-down transform duration (see .coin-guy). */
const PEEK_DOWN_MS = 780;

// ---- copy ------------------------------------------------------------------

/** The nudge in the b-guy's thought bubble. Page-aware and low-pressure: "this"
 *  silently anchors to whatever screen you're on (the panel it opens is keyed on
 *  the same route), and the rising question reads as a friendly lean-over rather
 *  than a command — reinforcing the mascot's whole point instead of a generic
 *  "ask me anything" that would throw the page-awareness away. */
const BUBBLE_TEXT = "Questions about this?";

/** What the mascot knows about each screen: a friendly name, a one-line "you're
 *  here" blurb, and a few starter questions the grounded tools can answer. */
type PageContext = { label: string; blurb: string; suggestions: string[] };

const PAGE_CONTEXT: Record<string, PageContext> = {
  spending: {
    label: "Pulse",
    blurb: "your spending this month",
    suggestions: [
      "Where did my money go this month?",
      "What's my biggest category?",
      "How am I trending vs last month?",
    ],
  },
  transactions: {
    label: "Transactions",
    blurb: "your transactions",
    suggestions: [
      "Summarise my recent transactions",
      "Any duplicate or surprise charges?",
      "How much did I spend on dining?",
    ],
  },
  insights: {
    label: "Insights",
    blurb: "the patterns in your spending",
    suggestions: [
      "What patterns stand out?",
      "Which recurring charges do I have?",
      "Where could I cut back?",
    ],
  },
  accounts: {
    label: "Accounts",
    blurb: "your accounts",
    suggestions: [
      "How much is across all my accounts?",
      "Which account do I spend from most?",
      "What are my recurring bills?",
    ],
  },
  networth: {
    label: "Net worth",
    blurb: "how your cash net worth is trending",
    suggestions: [
      "Is my net worth going up or down?",
      "How much have I moved since the start?",
      "What's cash versus what I owe?",
    ],
  },
  import: {
    label: "Import",
    blurb: "bringing in a statement",
    suggestions: [
      "What can you read once I import?",
      "How much did I spend last month?",
      "Is my data kept private?",
    ],
  },
  check: {
    label: "the affordability check",
    blurb: "whether you can afford something",
    suggestions: [
      "How much do I have left this month?",
      "What are my required monthly bills?",
      "What's my typical monthly spend?",
    ],
  },
  result: {
    label: "your latest check",
    blurb: "the result you just got",
    suggestions: [
      "What would make this affordable?",
      "What are my biggest expenses?",
      "How much do I usually spend a month?",
    ],
  },
  admin: {
    label: "the admin area",
    blurb: "your finances",
    suggestions: ["What can you help me with?", "Summarise my spending"],
  },
};

const FALLBACK_CONTEXT: PageContext = {
  label: "this page",
  blurb: "your finances",
  suggestions: ["What can you help me with?", "Summarise my spending"],
};

function contextFor(route: string): PageContext {
  return PAGE_CONTEXT[route] ?? FALLBACK_CONTEXT;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- component -------------------------------------------------------------

export function AssistantMascot({
  route,
  onOpenAssistant,
}: {
  route: string;
  onOpenAssistant: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);

  // User's mascot preferences. `visible` is enforced by App (it decides whether
  // to mount this at all); `movement` and `character` are read by the director
  // below. Changing any of them re-runs the director effect (they're in its
  // deps), which cleanly rebuilds the loop/peeks in the newly-chosen state.
  const { prefs } = useMascotPrefs();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const coinRef = useRef<HTMLSpanElement | null>(null);
  const rollerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  // Set by the director so a click can make the guy pop up to say hi.
  const peekRef = useRef<(hold?: number) => void>(() => {});

  // Unique gradient ids for this instance's coin faces + the guy. React's useId
  // can contain ":" which is invalid inside url(#…), so strip it.
  const uid = useId().replace(/:/g, "");

  // Keep the director's view of "is the panel open" in a ref so the effect can
  // read it without re-subscribing (the loop must not restart on open).
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Set the corner/docked layout on the root before first paint, so a phone
  // never flashes the bottom-right corner coin before jumping to the edge. The
  // director owns `data-mode` at runtime (React never re-renders it, since it's
  // not a JSX prop), keeping it in sync on resize / breakpoint changes.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const docked =
      typeof window.matchMedia === "function" && window.matchMedia(DOCK_MQ).matches;
    root.dataset.mode = docked ? "docked" : "corner";
  }, []);

  // Status is fetched once; the panel uses it to decide between the chat input
  // and a graceful "not set up yet" note. A miss just leaves the input hidden.
  useEffect(() => {
    let alive = true;
    void fetchAgentStatus().then((res) => {
      if (alive && res.kind === "ok") setStatus(res.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  // --- the director: corner big-roll · docked edge-roll · peeks ------------
  useEffect(() => {
    const root = rootRef.current;
    const coin = coinRef.current;
    const roller = rollerRef.current;
    const stage = stageRef.current;
    if (!root || !coin || !roller || !stage) return;

    // Degrees the coin turns per px travelled for a slip-free roll: arc = R·θ.
    const DEG_PER_PX = 180 / (Math.PI * RIM_R); // ≈1.55 deg/px

    const dockMq =
      typeof window.matchMedia === "function" ? window.matchMedia(DOCK_MQ) : null;

    // Two homes, one motion vocabulary. In CORNER mode `pos` is horizontal
    // travel (−left) along the bottom; in DOCKED mode it is vertical travel
    // (−up) along the right edge. Either way the roller carries `pos` and the
    // coin couples its rotateZ to it, so the whole assembly rolls as one and the
    // guy stays locked behind the coin. Events are mutually exclusive:
    //   • FLICK — a rapid rotateY spin (no travel), decays and lands face-on.
    //   • ROLL  — eases `pos` to a target; the return home is a *separate* roll,
    //     so between them the coin can dwell, flick, or let the guy peek.
    // A peek only fires at rest (peekBlocked → mode!=="idle"); no event starts
    // while the guy is up (!peeking) — the two are never simultaneous.
    let layout: "corner" | "docked" = dockMq?.matches ? "docked" : "corner";
    let mode: "idle" | "flick" | "land" | "roll" = "idle";

    let rotY = 0; // flick spin (deg); resets to 0 on each face-on landing
    let velY = 0; // flick angular velocity (deg/s)
    let landTo = 0; // the face-on multiple of 360° a flick settles on

    let pos = 0; // travel on the active axis (px, before --coin-scale)
    let posFrom = 0; // roll start
    let posTo = 0; // roll target
    let rollT = 0; // elapsed roll time (s)
    let rollDur = 1; // this roll's duration (s)
    let dwell = 0; // events spent away from home (forces an eventual return)

    // Recomputed on resize: the CSS scale and the travel envelope, measured from
    // the real layout so a corner roll reaches "almost to the content" at any
    // width and a docked roll respects the viewport height.
    let scale = 1;
    let leftRoom = 0; // corner: max leftward travel (local px)
    let upRoom = 0; // docked: max upward travel (local px)
    let downRoom = 0; // docked: max downward dip (local px)

    // Corner "home tuck": a rightward resting offset (local px) applied to the
    // roller — NOT coupled to the coin's spin — that slides the coin partly off
    // the right edge when content fills its corner, so it never rests on a card.
    // restX eases toward restTarget each frame; `occluded` routes the peek out to
    // the side (data-occluded) while tucked.
    let restX = 0;
    let restTarget = 0;
    let occluded = false;

    let nextEventAt = 2.4; // clock time (s) of the next flick/roll
    let clock = 0;
    let prev: number | null = null;
    let raf = 0;

    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // ---- effective behaviour from prefs (OS reduced-motion is a hard floor) --
    // "always" keeps the b-guy over the rim statically (the calm preset's core).
    const alwaysGuy = prefs.character === "always";
    // Never force motion on a reduced-motion user, whatever the pref asks for.
    const motionAllowed = () => prefs.movement && !prefersReducedMotion();
    // Occasional peeks only in "auto", and only when motion is allowed — a peek
    // is itself an animation, so a still coin (movement off / reduced) stays still.
    const wantAutoPeeks = () => prefs.character === "auto" && motionAllowed();

    const measure = () => {
      scale = parseFloat(getComputedStyle(root).getPropertyValue("--coin-scale")) || 1;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const halfCoin = (STAGE * scale) / 2;
      if (layout === "corner") {
        // Stop just short of the sidebar (or, without one, the content column):
        // stable layout elements, so the bound is right on any page or scroll.
        let leftBound = CORNER_SAFE_LEFT_GAP;
        const aside = document.querySelector("aside");
        if (aside && aside.getBoundingClientRect().width > 1 &&
            getComputedStyle(aside).display !== "none") {
          leftBound = aside.getBoundingClientRect().right + CORNER_SAFE_LEFT_GAP;
        } else {
          const main = document.querySelector("main");
          if (main) leftBound = main.getBoundingClientRect().left + CORNER_SAFE_LEFT_GAP;
        }
        const homeCenterX = vw - RIGHT_INSET - halfCoin;
        const homeCoinLeft = homeCenterX - halfCoin;
        const roomToBound = homeCenterX - halfCoin - leftBound;
        const cap = Math.min(CORNER_MAX_TRAVEL_VW * vw, CORNER_MAX_TRAVEL_PX); // stay in the right portion

        // Don't roll the coin over content that sits in its horizontal band. The
        // band is the coin's vertical extent (bottom-anchored, so stable across
        // the roll); find the right edge of the rightmost card crossing it that
        // starts left of the coin's home, and stop the leading edge just past it.
        let contentRight = 0;
        const main = document.querySelector("main");
        if (main) {
          let bandTop = vh - STAGE * scale;
          let bandBottom = vh;
          if (coin) {
            const cr = coin.getBoundingClientRect();
            bandTop = cr.top;
            bandBottom = cr.bottom;
          }
          const nodes = main.querySelectorAll("*");
          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 160 || r.height < 24) continue; // real cards/rows only
            if (r.bottom <= bandTop || r.top >= bandBottom) continue; // not in band
            if (r.right <= contentRight || r.left >= homeCoinLeft) continue;
            const bg = getComputedStyle(el).backgroundColor;
            if (bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
            contentRight = r.right;
          }
        }
        // If content reaches into the coin's home corner there's no gutter beside
        // it (and no room below) — the coin would rest ON the card. Tuck it right,
        // partly off the edge, until its leading edge clears the content, keeping a
        // visible sliver. A tucked coin has no room to roll left and peeks sideways.
        const coinW = STAGE * scale;
        const clearedLeft = contentRight + CORNER_CONTENT_CLEAR_GAP;
        let tuckVisual =
          contentRight > 0 && clearedLeft > homeCoinLeft ? clearedLeft - homeCoinLeft : 0;
        const tuckCap = Math.max(0, coinW - CORNER_MIN_VISIBLE + RIGHT_INSET);
        tuckVisual = Math.min(tuckVisual, tuckCap);
        occluded = tuckVisual > 0.5;
        restTarget = tuckVisual / scale;
        if (occluded) {
          leftRoom = 0; // no clear room — stay tucked, don't roll onto the card
        } else {
          const contentTravel =
            contentRight > 0 ? Math.max(0, homeCoinLeft - clearedLeft) : Infinity;
          leftRoom = Math.max(0, Math.min(roomToBound, cap, contentTravel)) / scale;
        }
        root.dataset.occluded = occluded ? "true" : "false";
      } else {
        upRoom = Math.max(0, (DOCK_HOME_VH - DOCK_TOP_LIMIT_VH) * vh) / scale;
        downRoom = Math.max(0, DOCK_DOWN_VH * vh) / scale;
        restTarget = 0; // docked owns its own tuck via CSS; no corner home-tuck
        occluded = false;
        root.dataset.occluded = "false";
      }
    };

    const apply = () => {
      // Corner adds the resting home-tuck (restX) to the roll (pos). The tuck is a
      // pure slide: only `pos` drives the coin's spin, so a tucked-at-rest coin
      // keeps its "b" upright instead of landing on a rolled angle.
      roller.style.transform =
        layout === "docked"
          ? `translateY(${pos.toFixed(2)}px)`
          : `translateX(${(restX + pos).toFixed(2)}px)`;
      coin.style.transform =
        `rotateY(${rotY.toFixed(2)}deg) rotateZ(${(pos * DEG_PER_PX).toFixed(2)}deg)`;
    };

    const scheduleEvent = () => {
      nextEventAt = clock + 2.8 + Math.random() * 4.6;
    };

    const startFlick = () => {
      mode = "flick";
      const dir = Math.random() < 0.5 ? -1 : 1;
      velY = dir * (820 + Math.random() * 720); // deg/s — a brisk finger-flick
    };

    const startRoll = (target: number) => {
      mode = "roll";
      rollT = 0;
      posFrom = pos;
      posTo = target;
      // Duration from distance at a believable rolling speed, so long corner
      // excursions read as an actual roll rather than a teleport.
      const distVp = Math.abs(target - pos) * scale;
      rollDur = clamp(distVp / ROLL_SPEED, ROLL_MIN_DUR, ROLL_MAX_DUR);
    };

    // Choose the next move from rest. Away from home, bias toward coming back
    // (and force it after a couple of events) so it never wanders off and stays.
    const nextExcursion = () => {
      if (Math.abs(pos) >= 4) {
        dwell += 1;
        if (dwell < 2 && Math.random() < 0.45) startFlick();
        else {
          startRoll(0);
          dwell = 0;
        }
        return;
      }
      dwell = 0;
      if (Math.random() < 0.3) {
        startFlick();
      } else if (layout === "corner") {
        measure(); // re-read the content bound; it shifts with scroll and route
        startRoll(-rand(CORNER_ROLL_MIN_FRAC, CORNER_ROLL_MAX_FRAC) * leftRoom);
      } else if (Math.random() < 0.8) {
        startRoll(-rand(DOCK_UP_MIN_FRAC, 1) * upRoom); // roll up toward middle
      } else {
        startRoll(rand(0.5, 1) * downRoom); // an occasional dip below home
      }
    };

    const step = (t: number) => {
      if (prev === null) prev = t;
      const dt = Math.min(0.05, (t - prev) / 1000);
      prev = t;
      clock += dt;

      if (openRef.current) {
        // Beside the panel: settle face-on and home, run no events.
        mode = "idle";
        const k = 1 - Math.pow(0.02, dt);
        rotY += (Math.round(rotY / 360) * 360 - rotY) * k;
        pos += (0 - pos) * k;
        velY = 0;
        dwell = 0;
      } else if (mode === "flick") {
        velY *= Math.pow(0.13, dt); // friction
        rotY += velY * dt;
        if (Math.abs(velY) < 150) {
          mode = "land";
          landTo = Math.round(rotY / 360) * 360; // nearest face-on
        }
      } else if (mode === "land") {
        rotY += (landTo - rotY) * (1 - Math.pow(0.0009, dt));
        if (Math.abs(landTo - rotY) < 0.4) {
          rotY = 0; // multiple of 360° ⇒ face-on; reset the accumulator
          mode = "idle";
          scheduleEvent();
        }
      } else if (mode === "roll") {
        rollT += dt;
        const p = Math.min(1, rollT / rollDur);
        pos = posFrom + (posTo - posFrom) * easeInOutCubic(p);
        if (p >= 1) {
          pos = posTo; // rests wherever it rolled to (home, or dwelling out)
          mode = "idle";
          scheduleEvent();
        }
      } else if (clock >= nextEventAt && !peeking) {
        nextExcursion(); // idle & the guy is down → one move (never both)
      }

      // Ease the resting home-tuck toward its target so the coin slides out of a
      // card's way (or back) smoothly when content or the viewport changes.
      restX += (restTarget - restX) * (1 - Math.pow(0.005, dt));

      apply();
      raf = requestAnimationFrame(step);
    };

    // --- peeks ---------------------------------------------------------------
    let peekTimer = 0;
    let downTimer = 0;
    let clearTimer = 0;
    let peeking = false;

    const peekBlocked = () =>
      peeking ||
      openRef.current ||
      document.hidden ||
      mode !== "idle" ||
      prefersReducedMotion() ||
      // Only "auto" runs the climb-up/climb-down peek. "always" already holds the
      // guy up statically (a triggered peek would start a hide timer and drop
      // him); "off" keeps him tucked away entirely.
      prefs.character !== "auto";

    const peek = (hold = 5200) => {
      if (peekBlocked()) return;
      peeking = true;
      stage.dataset.peek = "up";
      window.clearTimeout(downTimer);
      window.clearTimeout(clearTimer);
      downTimer = window.setTimeout(() => {
        // Begin the climb *down* — the CSS reverses the climb-up so he visibly
        // descends behind the coin. Only free the mascot once that finishes, so
        // he is never cut off mid-descent or blinked away.
        stage.dataset.peek = "down";
        clearTimer = window.setTimeout(() => {
          peeking = false;
          scheduleEvent();
        }, PEEK_DOWN_MS);
      }, hold);
    };
    peekRef.current = peek;

    const schedulePeek = () => {
      window.clearTimeout(peekTimer);
      peekTimer = window.setTimeout(
        () => {
          peek();
          schedulePeek();
        },
        8000 + Math.random() * 11000,
      );
    };

    // --- lifecycle -----------------------------------------------------------
    const start = () => {
      if (!raf) {
        prev = null;
        raf = requestAnimationFrame(step);
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    // Park the coin with no rAF loop running. `pose` chooses the guy's resting
    // state: "down" tucks him behind the coin (the usual still coin); "up" holds
    // him statically over the rim for the "always visible" preference.
    const restStatic = (pose: "up" | "down" = "down") => {
      stop();
      window.clearTimeout(peekTimer);
      window.clearTimeout(downTimer);
      window.clearTimeout(clearTimer);
      peeking = false;
      rotY = 0;
      velY = 0;
      pos = 0;
      mode = "idle";
      // Still respect the content boundary at rest — the tuck is a position, not
      // motion — but snap to it (no easing loop runs while static).
      measure();
      restX = restTarget;
      apply();
      stage.dataset.peek = pose;
    };

    const applyLayout = () => {
      root.dataset.mode = layout;
      measure();
      apply();
    };

    // Settle the coin into the resting state its prefs imply. Shared by mount, a
    // reduced-motion change, and a corner⇄docked breakpoint flip so all three
    // land on the same behaviour: "always" holds the guy up statically; idle
    // motion (roll + auto peeks) runs only when motion is allowed; otherwise the
    // coin parks with the guy tucked away. Missing this on a layout flip is what
    // dropped the always-visible guy when the viewport crossed the breakpoint.
    const settle = () => {
      if (alwaysGuy) {
        stage.dataset.peek = "up";
        if (motionAllowed()) start();
        else restStatic("up");
      } else if (motionAllowed()) {
        stage.dataset.peek = "down";
        start();
        if (wantAutoPeeks()) schedulePeek();
      } else {
        restStatic("down");
      }
    };

    const syncLayout = () => {
      const next: "corner" | "docked" = dockMq?.matches ? "docked" : "corner";
      if (next === layout) return false;
      layout = next;
      // Clean reset so no motion or peek state leaks across the two homes.
      window.clearTimeout(downTimer);
      window.clearTimeout(clearTimer);
      peeking = false;
      stage.dataset.peek = "down";
      mode = "idle";
      pos = 0;
      posFrom = 0;
      posTo = 0;
      rotY = 0;
      velY = 0;
      dwell = 0;
      restX = 0; // ease the new home's tuck in fresh (applyLayout re-measures it)
      restTarget = 0;
      occluded = false;
      applyLayout();
      // Push the next idle event out so the coin doesn't lurch right after the
      // flip, then settle into the resting state prefs imply for the new home —
      // crucially re-raising the "always" guy, which the old reset dropped.
      scheduleEvent();
      settle();
      return true;
    };

    // Re-check the breakpoint on every resize as well as on the media-query
    // change event: some environments fire one but not the other, and this keeps
    // the mode correct either way. A same-mode resize just re-measures.
    const onResize = () => {
      if (!syncLayout()) measure();
    };
    const onDockChange = () => {
      syncLayout();
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        window.clearTimeout(peekTimer);
      } else if (motionAllowed()) {
        // Resume the idle loop (and peeks, in "auto"). "always" needs no resume —
        // the guy's static pose is CSS, not the loop; movement-off stays parked.
        start();
        if (wantAutoPeeks()) schedulePeek();
      }
    };

    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const onMotionPref = () => {
      // Reduced-motion changed live. Re-derive the resting state from prefs:
      // "always" still shows the guy (statically); motion resumes only if now
      // allowed; otherwise the coin parks.
      settle();
    };

    applyLayout();
    // data-guy="static" (CSS) disables the guy's climb transitions so the
    // "always visible" pose is simply present, not animating into place.
    root.dataset.guy = alwaysGuy ? "static" : "auto";
    // Settle into the resting state prefs imply (same path as a later
    // reduced-motion change or breakpoint flip): "always" holds the guy up,
    // motion runs only when allowed, otherwise the coin parks tucked.
    settle();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    mq?.addEventListener?.("change", onMotionPref);
    dockMq?.addEventListener?.("change", onDockChange);

    return () => {
      stop();
      window.clearTimeout(peekTimer);
      window.clearTimeout(downTimer);
      window.clearTimeout(clearTimer);
      peekRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      mq?.removeEventListener?.("change", onMotionPref);
      dockMq?.removeEventListener?.("change", onDockChange);
    };
    // Re-run when the user changes movement/character so the director rebuilds
    // cleanly in the new state (start/stop the loop, hold or drop the peek).
  }, [prefs.movement, prefs.character]);

  // --- interaction ---------------------------------------------------------
  const handleActivate = () => {
    setOpen((wasOpen) => {
      const nextOpen = !wasOpen;
      if (nextOpen) peekRef.current(2400); // a quick "hi!" pop as it opens
      return nextOpen;
    });
  };

  const ctx = contextFor(route);

  // The full scope sent with each turn: the route/screen the mascot knows, plus
  // whatever the current screen published about its selection (period, account).
  // Composed fresh each render so it always reflects the live selection behind
  // the panel.
  const view = useAssistantViewScope();
  const scope: AssistantScope = { route, screen: ctx.label, ...(view ?? {}) };

  return (
    <>
      <div ref={rootRef} className="mascot-root" aria-hidden={false}>
        <div ref={stageRef} className="coin-stage" data-peek="down">
          {/* The roller carries the whole assembly — guy, coin, hands and
              bubble — as one rigid unit. The director translates THIS on X for a
              roll, so the guy always stays locked behind the coin wherever it
              goes; only the coin element inside spins on its own axis. */}
          <div ref={rollerRef} className="coin-roller">
            {/* the guy's head — sits behind the coin, climbs up to peek over it */}
            <div className="coin-guy" aria-hidden="true">
              <GuyHead id={`${uid}h`} />
            </div>

            {/* the coin — the only interactive part */}
            <button
              type="button"
              className="mascot-hit"
              onClick={handleActivate}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={`Ask the assistant about ${ctx.label}`}
              title="Ask about this page"
            >
              <span className="coin-persp">
                <span ref={coinRef} className="coin-spin">
                  <span className="coin-face coin-face--front">
                    <CoinFace id={`${uid}f`} />
                  </span>
                  <span className="coin-face coin-face--back">
                    <CoinFace id={`${uid}b`} />
                  </span>
                  {/* the reeded metal rim that gives the coin real thickness */}
                  <span className="coin-edge" aria-hidden="true">
                    {RIM_SEG_STYLES.map((s, i) => (
                      <span key={i} className="coin-edge-seg" style={s} />
                    ))}
                  </span>
                </span>
              </span>
            </button>

            {/* little hands gripping the top rim, and the chat thought-bubble —
                both ride the roller and appear only on a peek (coin at rest) */}
            <div className="coin-hands" aria-hidden="true">
              <GuyHands />
            </div>
            <div className="coin-bubble" aria-hidden="true">
              <ChatBubble text={BUBBLE_TEXT} />
            </div>
          </div>
        </div>
      </div>

      {open && (
        <MascotPanel
          ctx={ctx}
          scope={scope}
          status={status}
          onClose={() => setOpen(false)}
          onOpenAssistant={() => {
            setOpen(false);
            onOpenAssistant();
          }}
        />
      )}
    </>
  );
}

// ---- the glyphs ------------------------------------------------------------

/** Evenly-spaced reeding (the milled ticks around a coin's edge) drawn flat on
 *  the face — a subtle texture that reads at rest; the 3D rim carries the rest. */
function reeding(rIn: number, rOut: number, n: number, color: string, w: number) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    lines.push(
      <line
        key={i}
        x1={(50 + c * rIn).toFixed(2)}
        y1={(50 + s * rIn).toFixed(2)}
        x2={(50 + c * rOut).toFixed(2)}
        y2={(50 + s * rOut).toFixed(2)}
        stroke={color}
        strokeWidth={w}
      />,
    );
  }
  return lines;
}

/**
 * One face of the gold coin, in a 0–100 viewBox. Gradients do the metal:
 *   - a radial "face" gradient lit from the upper-left (pale gold → deep bronze);
 *   - a vertical "rim" gradient with a bright band, so the edge reads beveled;
 *   - a milled inner ring, an embossed lowercase-b (a bevelled device: dark drop,
 *     light lift, mid body), a soft specular hotspot and a warm bounce light.
 * `id` must be unique per rendered instance: two coins sharing a gradient id
 * would collide in the DOM (both would resolve to the first).
 */
function CoinFace({ id }: { id: string }) {
  return (
    <svg className="coin-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-f`} cx="37%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#fff7d2" />
          <stop offset="19%" stopColor="#f6d477" />
          <stop offset="47%" stopColor="#e0a832" />
          <stop offset="74%" stopColor="#a96c16" />
          <stop offset="100%" stopColor="#6f420e" />
        </radialGradient>
        <linearGradient id={`${id}-r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#59380b" />
          <stop offset="14%" stopColor="#eabf57" />
          <stop offset="47%" stopColor="#fff2b2" />
          <stop offset="85%" stopColor="#9a6215" />
          <stop offset="100%" stopColor="#452d08" />
        </linearGradient>
        <radialGradient id={`${id}-s`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,.82)" />
          <stop offset="55%" stopColor="rgba(255,255,255,.16)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <radialGradient id={`${id}-l`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,231,160,.55)" />
          <stop offset="100%" stopColor="rgba(255,231,160,0)" />
        </radialGradient>
        <radialGradient id={`${id}-v`} cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(70,38,0,.5)" />
        </radialGradient>
      </defs>

      {/* rim band + a whisper of flat reeding right at the edge */}
      <circle cx="50" cy="50" r="48.5" fill={`url(#${id}-r)`} />
      {reeding(46.2, 48.4, 90, "#6a4310", 0.7)}

      {/* face + vignette */}
      <circle cx="50" cy="50" r="45.6" fill={`url(#${id}-f)`} />
      <circle cx="50" cy="50" r="45.6" fill={`url(#${id}-v)`} />

      {/* milled inner ring (raised border) */}
      <circle cx="50" cy="50" r="39.6" fill="none" stroke="#7c4e11" strokeWidth="1.5" opacity="0.65" />
      <circle cx="50" cy="50" r="38.3" fill="none" stroke="#ffe9a6" strokeWidth="1" opacity="0.5" />

      {/* the embossed lowercase-b: dark drop, light lift, mid body */}
      <g strokeLinecap="round" fill="none">
        <g transform="translate(1.1,1.6)" stroke="#6b400a" strokeWidth="7.6">
          <path d="M41 29 V72" />
          <circle cx="52" cy="60.5" r="12.2" />
        </g>
        <g transform="translate(-0.7,-1)" stroke="#ffeeb0" strokeWidth="6.2">
          <path d="M41 29 V72" />
          <circle cx="52" cy="60.5" r="12.2" />
        </g>
        <g stroke="#cf9526" strokeWidth="6.4">
          <path d="M41 29 V72" />
          <circle cx="52" cy="60.5" r="12.2" />
        </g>
      </g>

      {/* specular hotspot + warm bounce light */}
      <ellipse cx="38" cy="32" rx="17" ry="10.5" fill={`url(#${id}-s)`} />
      <ellipse cx="66" cy="72" rx="15" ry="9" fill={`url(#${id}-l)`} />
    </svg>
  );
}

/** The little teal "b-guy" head — brand accent, white-b device, two eyes. */
function GuyHead({ id }: { id: string }) {
  return (
    <svg className="guy-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-h`} cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#86dcc1" />
          <stop offset="55%" stopColor="#1d6b5a" />
          <stop offset="100%" stopColor="#0e463a" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="34" fill={`url(#${id}-h)`} />
      <circle cx="50" cy="50" r="34" fill="none" stroke="#0e463a" strokeWidth="1.4" opacity="0.5" />
      <ellipse cx="40" cy="34" rx="12" ry="7" fill="rgba(255,255,255,.28)" />
      <g stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round">
        <path d="M43 36 V66" />
        <circle cx="51" cy="57" r="9" />
      </g>
      <g className="guy-eyes">
        <circle cx="36" cy="46" r="5.2" fill="#fff" />
        <circle cx="64" cy="46" r="5.2" fill="#fff" />
        <circle cx="37.8" cy="47.4" r="2.5" fill="#0d1f1b" />
        <circle cx="65.8" cy="47.4" r="2.5" fill="#0d1f1b" />
      </g>
    </svg>
  );
}

/** Two little hands curling over the coin's top rim. */
function GuyHands() {
  return (
    <svg className="hands-svg" viewBox="0 0 120 40" aria-hidden="true" focusable="false">
      <g fill="#1d6b5a" stroke="#0e463a" strokeWidth="1">
        <path d="M20 24 q-2 -12 10 -12 q10 0 8 12 z" />
        <path d="M100 24 q2 -12 -10 -12 q-10 0 -8 12 z" />
      </g>
    </svg>
  );
}

/** The chat thought-bubble the guy floats when he peeks: a rounded card with a
 *  small chat glyph and a short nudge, trailed by two thought dots. */
function ChatBubble({ text }: { text: string }) {
  return (
    <>
      <div className="bubble-card">
        <svg className="bubble-chat" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1 -1.5 1.5h-8l-4.5 3.2v-3.2h-3.5a1.5 1.5 0 0 1 -1.5 -1.5v-8a1.5 1.5 0 0 1 1.5 -1.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        <span className="bubble-text">{text}</span>
      </div>
      <span className="bubble-dot bubble-dot--1" />
      <span className="bubble-dot bubble-dot--2" />
    </>
  );
}

// ---- the popover -----------------------------------------------------------

type PanelMsg = {
  role: "user" | "assistant";
  content: string;
  sources?: string | null;
  tone?: "normal" | "declined" | "error";
};

/** Turn the tool-call record into the same plain-language "how it knows" line
 *  the full Assistant screen shows. */
function sourcesLine(toolCalls: AgentToolCallRecord[]): string | null {
  const labels = Array.from(
    new Set(toolCalls.filter((t) => t.ok).map((t) => TOOL_LABELS[t.tool] ?? t.tool)),
  );
  return labels.length ? `Read from ${labels.join(", ")}` : null;
}

function MascotPanel({
  ctx,
  scope,
  status,
  onClose,
  onOpenAssistant,
}: {
  ctx: PageContext;
  scope: AssistantScope;
  status: AgentStatus | null;
  onClose: () => void;
  onOpenAssistant: () => void;
}) {
  const badgeId = useId().replace(/:/g, "");
  const [messages, setMessages] = useState<PanelMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const configured = status?.configured ?? true; // optimistic until known

  // Focus the input when the panel opens, and close on Escape.
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the newest message in view.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const nextMessages: PanelMsg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);

    const wire = nextMessages.map((m) => ({ role: m.role, content: m.content }));
    // `send` is a fresh closure each render, so it captures the latest `scope`
    // prop — the reply is scoped to whatever the user is looking at right now.
    const res = await sendAgentTurn(wire, conversationId.current, scope);

    // Resolve the reply to a single message here — narrowing the discriminated
    // union outside the deferred setMessages closure, where TS would widen it.
    let reply: PanelMsg;
    if (res.kind !== "ok") {
      reply = {
        role: "assistant",
        content: "I couldn't reach the assistant just now. Try again in a moment.",
        tone: "error",
      };
    } else if (res.data.kind === "reply") {
      if (res.data.conversationId) conversationId.current = res.data.conversationId;
      reply = {
        role: "assistant",
        content: res.data.text,
        sources: sourcesLine(res.data.toolCalls),
      };
    } else {
      reply = { role: "assistant", content: res.data.message, tone: "declined" };
    }
    setMessages((prev) => [...prev, reply]);
    setBusy(false);
  };

  return (
    <div
      role="dialog"
      aria-label={`Ask the assistant about ${ctx.label}`}
      className="mascot-panel card"
    >
      <header className="mascot-panel__head">
        <span className="mascot-panel__badge" aria-hidden="true">
          <CoinFace id={badgeId} />
        </span>
        <div className="min-w-0">
          <p className="text-label text-ink">Ask about {ctx.label}</p>
          <p className="truncate text-meta text-ink-tertiary">You're looking at {ctx.blurb}.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="mascot-panel__close"
        >
          ✕
        </button>
      </header>

      {!configured ? (
        <div className="mascot-panel__body">
          <p className="text-body text-ink-secondary">
            The assistant isn't set up on this instance yet, so I can't answer
            questions here.
          </p>
          <button type="button" onClick={onOpenAssistant} className="mascot-panel__link">
            See what the assistant does →
          </button>
        </div>
      ) : (
        <>
          <div ref={threadRef} className="mascot-panel__thread">
            {messages.length === 0 ? (
              <div className="mascot-panel__intro">
                <p className="text-meta text-ink-tertiary">Try asking</p>
                <div className="flex flex-wrap gap-1.5">
                  {ctx.suggestions.map((q) => (
                    <Chip key={q} onClick={() => void send(q)}>
                      {q}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={`mascot-msg mascot-msg--${m.role}${
                    m.tone && m.tone !== "normal" ? ` mascot-msg--${m.tone}` : ""
                  }`}
                >
                  <p className="whitespace-pre-wrap text-body">{m.content}</p>
                  {m.sources && <p className="mt-1 text-meta text-ink-tertiary">{m.sources}</p>}
                </div>
              ))
            )}
            {busy && (
              <div className="mascot-msg mascot-msg--assistant">
                <span className="mascot-typing" aria-label="Thinking">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            )}
          </div>

          <form
            className="mascot-panel__form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              ref={inputRef}
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about ${ctx.label}…`}
              aria-label="Ask the assistant"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="mascot-panel__send"
              aria-label="Send"
            >
              ↑
            </button>
          </form>
        </>
      )}

      {configured && (
        <button type="button" onClick={onOpenAssistant} className="mascot-panel__full">
          Open full assistant →
        </button>
      )}
    </div>
  );
}
