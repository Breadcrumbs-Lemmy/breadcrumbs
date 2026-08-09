/**
 * Breadcrumbs logo.
 *
 * The mark is a lowercase "b" — the brand's initial — stamped into a coin, the
 * money the name plays on. One clean letterform (a tall stem with a round bowl
 * that kisses it) centred in a rimmed disc: a confident monogram that holds
 * from a 16px favicon up to the hero and never gets mistaken for a maps app.
 *
 * It mints itself on mount — the coin's face fades up and its rim draws closed,
 * then the stem strokes down and the bowl sweeps shut, and (on the hero only) a
 * crumb the coin dropped pops beside it and pulses like a "you are here" marker,
 * echoing the trailing crumb in the wordmark. On hover the coin spills a few
 * more coins that fall and fade — pure play. `pathLength={1}` normalises every
 * stroke to a unit length so the stroke-dashoffset draw is independent of the
 * actual geometry. Everything collapses to its finished state under
 * `prefers-reduced-motion` via the global rule in tokens.css.
 *
 * Monochrome by design: the whole mark inherits `currentColor` (the accent),
 * so it themes for free and never competes with the data on screen. The
 * chromatic wit — bread in honey, crumbs in teal — lives in the wordmark.
 */

import { useEffect, useState, type CSSProperties } from "react";

type LogoProps = {
  /** "full" = mark + wordmark lockup; "mark" = the glyph alone. */
  variant?: "full" | "mark";
  /** Height of the mark in px. The wordmark scales in proportion. */
  size?: number;
  /** Play the draw-on animation. Off for places the logo re-renders often. */
  animated?: boolean;
  /** Hero/brand moments: adds the always-on "you are here" beacon pulse (and,
   *  unless `spill` says otherwise, the hover coin-spill). */
  beacon?: boolean;
  /** Spill coins on hover. Defaults to `beacon`, but can be set on its own so a
   *  calm placement (e.g. the sidebar) gets the playful spill without the
   *  always-on beacon pulse. */
  spill?: boolean;
  /** Ambient gold glitter: at random intervals a light sweeps once around the
   *  coin's rim, trailing sparkles — as if a lamp moved past a struck coin's
   *  edge. Timer-driven (NOT hover), and skipped under reduced motion. Defaults
   *  to `beacon` (the brand-hero placements); set it on its own for an always-
   *  visible mark (e.g. the sidebar) so the coin catches the light on its own. */
  sparkle?: boolean;
  /** How many coins the hover spill drops (clamped to MAX_SPILL). Each coin
   *  gets its own random trajectory, re-rolled per hover. Fewer reads calmer. */
  spillCount?: number;
  className?: string;
  /** Extra classes on the wordmark text (e.g. a larger hero size). */
  wordmarkClassName?: string;
};

/** Hard cap on coins per spill — enough for a lively shower, not a slot machine. */
const MAX_SPILL = 14;

/**
 * Sparkle points on the coin's rim (r=16 about 20,20), each with the delay at
 * which it twinkles — ordered clockwise from the top so they light in sequence
 * just behind the sweeping comet head, reading as a glitter trail on the edge.
 * See the `logo-glint-comet`/`logo-spark` rules in styles/index.css.
 */
const SPARKS: { x: number; y: number; d: number }[] = [
  { x: 20.0, y: 4.0, d: 0.05 },
  { x: 33.9, y: 12.0, d: 0.28 },
  { x: 33.9, y: 28.0, d: 0.5 },
  { x: 20.0, y: 36.0, d: 0.72 },
  { x: 6.1, y: 28.0, d: 0.9 },
  { x: 6.1, y: 12.0, d: 1.05 },
];

/**
 * The comet that laps the rim. A round, bright head with a tail of dots that
 * shrink and dim behind it, so the light reads as a streak — a bigger front
 * tapering to nothing — rather than a uniform band. `a` is degrees clockwise
 * from 12 o'clock on the rim (r=16 about 20,20); negative angles sit behind the
 * head. The whole set rotates rigidly as one group (`.logo-glint-comet` in
 * styles/index.css), and a soft drop-shadow glow fuses the close-packed head
 * dots into a continuous trail. Colour cools from near-white-gold at the head to
 * dark amber at the tip, so the tail melts back into the coin.
 */
const GLINT_DOTS: { a: number; r: number; opacity: number; color: string }[] = [
  { a: 0, r: 1.7, opacity: 1.0, color: "#fff7db" }, // head — near-white-gold
  { a: -7, r: 1.25, opacity: 0.82, color: "#fff3c4" }, // pale gold
  { a: -16, r: 0.9, opacity: 0.58, color: "#f7dd95" }, // mid gold
  { a: -27, r: 0.62, opacity: 0.36, color: "#f0cc75" }, // warm amber
  { a: -39, r: 0.4, opacity: 0.18, color: "#d9b24e" }, // dark amber
  { a: -52, r: 0.24, opacity: 0.08, color: "#c09020" }, // tail tip — near-gone
];

/**
 * One coin's fall, as the inline CSS custom properties the `logo-coin-fall`
 * keyframe reads. Everything here is rolled fresh — start column, size, drift,
 * spin, distance and timing — so no two coins (and no two hovers) fall alike.
 * `spread` sets how far the start columns fan out: the full wordmark drops coins
 * across all of "breadcrumbs" (3–97%), the lone mark keeps them over the "b".
 */
function makeCoins(count: number, spread: "mark" | "wide"): CSSProperties[] {
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  return Array.from({ length: count }, () => {
    const dir = Math.random() < 0.5 ? -1 : 1; // tip left or right, at random
    return {
      left: `${(spread === "wide" ? rand(3, 97) : rand(28, 72)).toFixed(1)}%`,
      top: `${rand(36, 50).toFixed(1)}%`,
      "--sz": `${rand(16, 34).toFixed(1)}%`,
      "--flip": (dir * rand(1.6, 3.4)).toFixed(2),
      "--dx": rand(-1.3, 1.3).toFixed(2),
      "--spin": `${Math.round(rand(-95, 95))}deg`,
      "--fall": rand(5.5, 9).toFixed(2),
      "--delay": `${rand(0, 0.95).toFixed(2)}s`,
      "--dur": `${rand(0.78, 1.2).toFixed(2)}s`,
    } as CSSProperties;
  });
}

/**
 * The hover spill overlay. Mounted only while the logo is hovered, so a brand
 * new random set is generated on every hover (there's no coin DOM at rest, and
 * the fall never repeats). Pointer-transparent; collapses to nothing under
 * reduced motion via the global rule in tokens.css.
 */
function CoinSpill({ count, spread }: { count: number; spread: "mark" | "wide" }) {
  // One roll per mount. The parent gates mounting on hover, so each hover =
  // a fresh mount = a fresh random spill.
  const [coins] = useState(() => makeCoins(count, spread));
  return (
    <span
      className={`logo-coindrop${spread === "wide" ? " logo-coindrop--wide" : ""}`}
      aria-hidden="true"
    >
      {coins.map((style, i) => (
        <i key={i} className="logo-drop" style={style} />
      ))}
    </span>
  );
}

export function LogoMark({
  size = 28,
  animated = true,
  beacon = false,
  spill = beacon,
  spillCount = 6,
  sparkle = beacon,
}: Pick<LogoProps, "size" | "animated" | "beacon" | "spill" | "spillCount" | "sparkle">) {
  const coins = Math.max(0, Math.min(MAX_SPILL, Math.round(spillCount)));
  // Mount the spill only while hovered so each hover re-rolls a fresh random set.
  const [hovered, setHovered] = useState(false);
  const spilling = spill && coins > 0;

  // Ambient gold glitter. At random intervals (7–20s) a light sweeps once around
  // the coin's rim; the group is mounted only for that burst so each one runs
  // fresh (like the hover spill). Timer-driven, never hover — and skipped
  // entirely under reduced motion so it can't become a distraction.
  const [shimmer, setShimmer] = useState(false);
  useEffect(() => {
    if (!sparkle || shimmer) return; // disabled, or a burst is already playing
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const wait = 7000 + Math.random() * 13000;
    const id = window.setTimeout(() => setShimmer(true), wait);
    return () => window.clearTimeout(id);
  }, [sparkle, shimmer]);
  useEffect(() => {
    if (!shimmer) return;
    // One lap (1.5s) + the sparkles' tail + a margin, then retire the burst so
    // the idle effect above schedules the next random wait.
    const id = window.setTimeout(() => setShimmer(false), 1850);
    return () => window.clearTimeout(id);
  }, [shimmer]);
  return (
    <span
      className="logo-holder"
      onMouseEnter={spilling ? () => setHovered(true) : undefined}
      onMouseLeave={spilling ? () => setHovered(false) : undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className={`logo-mark text-accent ${animated ? "logo-animated" : ""}`}
      >
        {/* The coin the "b" is stamped into. A faint face so it reads as a solid
            token rather than a bare ring, and a rim that mints itself closed
            just before the letter lands. */}
        <circle
          className="logo-coin-face"
          cx="20"
          cy="20"
          r="14.8"
          fill="currentColor"
          fillOpacity="0.08"
        />
        <circle
          className="logo-coin-ring"
          cx="20"
          cy="20"
          r="16"
          stroke="currentColor"
          strokeWidth="2.4"
          pathLength={1}
        />
        {/* The lowercase "b", centred in the coin: the ascending stem, drawn
            top-down, and the bowl — the belly where the money settles — that
            kisses it and sweeps closed just after. */}
        <path
          className="logo-stem"
          d="M15 10 V29"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          pathLength={1}
        />
        <circle
          className="logo-bowl"
          cx="19.5"
          cy="24.5"
          r="5"
          stroke="currentColor"
          strokeWidth="2.8"
          pathLength={1}
        />
        {/* Hero only: a crumb the coin dropped, resting just outside the rim —
            it pops, then pulses out like a "you are here" marker, echoing the
            trailing crumb in the wordmark. */}
        {beacon && (
          <circle className="logo-crumb-ping" cx="33.5" cy="33" r="2" fill="currentColor" />
        )}
        {beacon && <circle className="logo-crumb" cx="33.5" cy="33" r="2" fill="currentColor" />}
        {/* Ambient gold glitter: a round, bright head leads a tapering tail once
            around the rim while sparkles twinkle on the edge — a light swept past
            a struck coin. Gold in every theme; mounted only during a burst so each
            one runs fresh, and collapsed to nothing under reduced motion. */}
        {sparkle && shimmer && (
          <g className="logo-shimmer" aria-hidden="true">
            {/* The comet: a fixed constellation of dots whose radius and opacity
                taper from head to tail, rotated as one rigid group about the coin
                centre (the CSS pins the pivot to 20,20). Converts each dot's rim
                angle to an (x, y) on the r=16 circle at render time. */}
            <g className="logo-glint-comet">
              {GLINT_DOTS.map(({ a, r, opacity, color }, i) => {
                const rad = (a * Math.PI) / 180;
                return (
                  <circle
                    key={i}
                    cx={+(20 + 16 * Math.sin(rad)).toFixed(3)}
                    cy={+(20 - 16 * Math.cos(rad)).toFixed(3)}
                    r={r}
                    fill={color}
                    opacity={opacity}
                  />
                );
              })}
            </g>
            {SPARKS.map((s, i) => (
              <circle
                key={i}
                className="logo-spark"
                cx={s.x}
                cy={s.y}
                r="1.4"
                fill="#fff7db"
                style={{ "--sd": `${s.d}s` } as CSSProperties}
              />
            ))}
          </g>
        )}
      </svg>
      {/* Coins spill from the "b" coin on hover, each on its own random path,
          then fade — gated on `spill` (which follows `beacon` unless set on its
          own). Mounted only while hovered so every hover falls differently. */}
      {spilling && hovered && <CoinSpill count={coins} spread="mark" />}
    </span>
  );
}

export function Logo({
  variant = "full",
  size = 28,
  animated = true,
  beacon = false,
  spill = beacon,
  spillCount = 6,
  sparkle = beacon,
  className = "",
  wordmarkClassName = "",
}: LogoProps) {
  // Hover state for the full-lockup spill. Declared unconditionally (before the
  // mark-variant early return) to keep hook order stable; the mark variant lets
  // its inner LogoMark own the spill instead.
  const coins = Math.max(0, Math.min(MAX_SPILL, Math.round(spillCount)));
  const [hovered, setHovered] = useState(false);

  if (variant === "mark") {
    // No wordmark to spill across, so the coins stay on the mark (the "b").
    return (
      <span className={`logo-lockup inline-flex ${className}`}>
        <LogoMark
          size={size}
          animated={animated}
          beacon={beacon}
          spill={spill}
          spillCount={spillCount}
          sparkle={sparkle}
        />
      </span>
    );
  }

  // Full lockup: the mark keeps its beacon crumb, but the hover coin-spill lifts
  // up to the lockup so coins drop from all along "breadcrumbs", not just the
  // "b". Mounted only while hovered so every hover falls in a fresh pattern.
  const spilling = spill && coins > 0;
  return (
    <span
      className={`logo-lockup inline-flex items-center gap-2 ${className}`}
      onMouseEnter={spilling ? () => setHovered(true) : undefined}
      onMouseLeave={spilling ? () => setHovered(false) : undefined}
    >
      <LogoMark
        size={size}
        animated={animated}
        beacon={beacon}
        spill={false}
        spillCount={spillCount}
        sparkle={sparkle}
      />
      <Wordmark className={wordmarkClassName} />
      {spilling && hovered && <CoinSpill count={coins} spread="wide" />}
    </span>
  );
}

/**
 * The wordmark. Fraunces gives it a warm, typeset voice, and the name carries
 * its own pun: "bread" wears the honey brand colour — money, the slang the name
 * plays on — while "crumbs" takes the teal accent. Two tones, one unbroken
 * word. The trailing brand-gradient crumb is the last spot of chromatic colour,
 * echoing the trail in the mark.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-baseline font-display font-medium leading-none tracking-[-0.01em] ${
        className || "text-[1.2rem]"
      }`}
    >
      <span style={{ color: "var(--brand-honey)" }}>bread</span>
      <span className="text-accent">crumbs</span>
      <span
        aria-hidden="true"
        className="ml-[0.12em] h-[0.32em] w-[0.32em] self-end rounded-full bg-brand"
        style={{ marginBottom: "0.12em" }}
      />
    </span>
  );
}
