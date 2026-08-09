/**
 * Neural net.
 *
 * A fixed canvas layer that draws a quiet, drifting network of nodes and lines —
 * and fires little travelling lights *along those lines* in response to the
 * cursor, the way a signal jumps from a neuron and races down an axon. As the
 * mouse moves, a node near the pointer lights up and shoots a pulse down one of
 * its edges in a random direction; when the pulse lands it can, sometimes, fire
 * onward — a short branching cascade that dies out on its own.
 *
 * The network is the background graph itself: the same nodes and edges are both
 * drawn (faintly) and ridden by the pulses, so a spark always travels a line you
 * can actually see rather than empty space. The field drifts and leans toward
 * the cursor so it reads as alive. It sits below all content on its own layer.
 *
 * Restraint, same contract as the rest of the ambient stack:
 *   - Purely decorative: aria-hidden, pointer-events-none, negative z-index.
 *     The listener is bound to `window`, so clicks fall straight through.
 *   - Honours prefers-reduced-motion *live*: start()/stop() react to the setting
 *     changing, not just its value at mount. When stopped, the static Ambient
 *     carries the look — the JS loop is the real motion here.
 *   - Re-themes for free: colours are read from the --net-color / --accent /
 *     --brand-honey tokens at runtime and refreshed when the theme flips;
 *     --net-opacity keeps the drawn network quiet.
 */
import { useEffect, useRef } from "react";

type RGB = [number, number, number];

const TAU = Math.PI * 2;

/** Read a CSS custom property off the document root. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Parse `#rrggbb` (or `#rgb`) into an [r,g,b] triple. */
function hexToRgb(hex: string, fallback: RGB): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A node in the graph. `bx,by` is its home; `x,y` is where it currently sits
 *  after drift + cursor lean. `z0` is its resting depth (0 far … 1 near); each
 *  frame that depth oscillates so the node travels toward and away from the
 *  screen, and `size` (recomputed per frame) grows as it nears — real parallax,
 *  not a fixed plane. */
type GraphNode = {
  bx: number;
  by: number;
  x: number;
  y: number;
  z0: number; // resting depth, 0 (far) … 1 (near)
  zph: number; // phase of this node's depth oscillation
  sizeJit: number; // small per-node size offset so equal-depth nodes still differ
  size: number; // dot radius THIS frame — grows as the node nears the screen
  phx: number;
  phy: number;
  edges: number[];
};

/** A light travelling from one node to another. */
type Pulse = {
  from: number;
  to: number;
  t: number; // progress 0..1
  speed: number; // progress per second
  color: RGB;
  depth: number; // chained fires still allowed from the far end
};

/** A brief ring where a node fires or receives — sells "it came from a node". */
type Flash = { x: number; y: number; t: number; color: RGB };

/** A soft round glow sprite, pre-rendered once per colour (cheaper than
 *  shadowBlur every frame). */
function makeGlow(color: RGB): HTMLCanvasElement {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, gr, b] = color;
  grad.addColorStop(0, `rgba(${r},${gr},${b},0.9)`);
  grad.addColorStop(0.35, `rgba(${r},${gr},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function NeuralPulses() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The JS loop is the real motion here, so reduced motion is honoured live —
    // start()/stop() below react to this query changing, not just its value at
    // mount. When stopped, the static Ambient carries the look.
    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");

    // ---- tunables ---------------------------------------------------------
    const CELL = 140; // grid spacing before jitter
    const LINK = CELL * 1.35; // max edge length — lower ratio = fewer links, a calmer mesh
    const VELOCITY = 340; // px/s a pulse travels
    const TRAIL_PX = 52; // length of the lit streak behind the head
    const MAX_PULSES = 26; // hard cap on live pulses
    const MAX_FLASHES = 40;
    const EMIT_MS = 52; // min gap between cursor-driven fires
    const CURSOR_R = 175; // "around the mouse" radius for picking a node
    const CHAIN_P = 0.62; // chance a landing pulse fires onward
    const CHAIN_DEPTH = 2; // how many hops a cascade may branch
    const DRIFT_AMP = 11; // px of each node's small independent wander (scaled by depth)
    const DRIFT_SPEED = 0.00058; // rad/ms — the resting in-plane wander, ~11s a cycle
    const Z_AMP = 0.35; // how far each node's depth swings from its resting z0 each cycle
    const Z_SPEED = 0.0005; // rad/ms — depth oscillation, ~12.5s toward-and-away
    const BREATH_AMP = 0.013; // fraction of distance-from-centre the field swells at peak
    const BREATH_SPEED = 0.00035; // rad/ms — the shared resting "breath", ~18s in and out
    const LEAN = 0.07; // how far the field leans toward the cursor
    const LEAN_EASE = 0.08; // smoothing on the lean — the graph follows the mouse
    const MAX_LEAN = 70; // px cap on the lean, so it can't run unbounded on a huge display
    const DOT_MIN = 1.2; // smallest node radius (kept above the perceptibility floor)
    const DOT_MAX = 4.6; // largest node radius — a handful of nodes read as clearly bigger

    let colors: RGB[] = [];
    let net: RGB = [31, 107, 90]; // colour of the drawn graph
    let netLineA = 0.16; // edge alpha (from --net-opacity)
    let netDotA = 0.34; // node alpha
    const glows = new Map<RGB, HTMLCanvasElement>();
    const refreshColors = () => {
      const teal = hexToRgb(cssVar("--net-color") || cssVar("--accent"), [31, 107, 90]);
      const honey = hexToRgb(cssVar("--brand-honey"), [192, 122, 64]);
      net = teal;
      // Mostly teal, a little honey — same two-tone as the wordmark.
      colors = [teal, teal, teal, teal, teal, honey];
      const op = parseFloat(cssVar("--net-opacity")) || 0.4;
      netLineA = op * 0.4;
      netDotA = op * 0.85;
      glows.clear();
    };
    const glowFor = (c: RGB) => {
      let g = glows.get(c);
      if (!g) {
        g = makeGlow(c);
        glows.set(c, g);
      }
      return g;
    };

    // ---- graph ------------------------------------------------------------
    let nodes: GraphNode[] = [];
    let edgePairs: Array<[number, number]> = [];
    let dpr = 1;
    let vw = 0;
    let vh = 0;
    let leanX = 0;
    let leanY = 0;

    const buildGraph = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Two extra rings of nodes past every edge so drift + the (capped) cursor
      // lean can never pull the outermost nodes inward far enough to expose a gap
      // at the screen border — the jittered margin node can already sit ~45px in,
      // so one ring alone is not enough headroom once the field leans.
      const cols = Math.ceil(vw / CELL) + 1;
      const rows = Math.ceil(vh / CELL) + 1;
      const pts: GraphNode[] = [];
      for (let j = -2; j <= rows + 1; j++) {
        for (let i = -2; i <= cols + 1; i++) {
          const bx = i * CELL + (Math.random() - 0.5) * CELL * 0.7;
          const by = j * CELL + (Math.random() - 0.5) * CELL * 0.7;
          // One "nearness" per node is its *resting* depth; each frame it
          // oscillates about this (see updatePositions) so the node travels
          // toward and away from the screen, growing and moving more as it nears.
          // Weighted toward the far end, so smaller dots dominate and the larger,
          // nearer ones punctuate.
          const z0 = Math.pow(Math.random(), 1.4);
          const sizeJit = Math.random() * 0.18;
          pts.push({
            bx,
            by,
            x: bx,
            y: by,
            z0,
            zph: Math.random() * TAU,
            sizeJit,
            size: DOT_MIN + (z0 * 0.82 + sizeJit) * (DOT_MAX - DOT_MIN),
            phx: Math.random() * TAU,
            phy: Math.random() * TAU,
            edges: [],
          });
        }
      }
      // Link nearby nodes into a network, recording each edge once for drawing.
      const pairs: Array<[number, number]> = [];
      const linkSq = LINK * LINK;
      for (let a = 0; a < pts.length; a++) {
        const na = pts[a]!;
        for (let b = a + 1; b < pts.length; b++) {
          const nb = pts[b]!;
          const dx = na.bx - nb.bx;
          const dy = na.by - nb.by;
          if (dx * dx + dy * dy <= linkSq) {
            na.edges.push(b);
            nb.edges.push(a);
            pairs.push([a, b]);
          }
        }
      }
      nodes = pts;
      edgePairs = pairs;
    };

    // Breathe the whole field, drift each node around its home, and lean the
    // field toward the cursor. Runs once per frame before anything is drawn so
    // the lines, dots and pulses all read the same positions.
    const updatePositions = (now: number) => {
      // Lean is proportional to cursor distance from centre, but capped: without
      // the cap it would grow with viewport size and, on a wide display, pull the
      // outermost nodes past the border margin and reveal a gap.
      const rawLX = mouseX >= 0 ? (mouseX - vw / 2) * LEAN : 0;
      const rawLY = mouseY >= 0 ? (mouseY - vh / 2) * LEAN : 0;
      const targetLX = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, rawLX));
      const targetLY = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, rawLY));
      leanX += (targetLX - leanX) * LEAN_EASE;
      leanY += (targetLY - leanY) * LEAN_EASE;
      const w = now * DRIFT_SPEED;
      const zt = now * Z_SPEED;
      // The whole field slowly swells about its centre — one shared breath — and
      // on top of that every node rides its own depth toward and away from the
      // screen (`zn`), so it grows as it nears and drifts/leans more (parallax).
      // The field has real depth, not a flat plane. Each node's final position =
      // home + breath + wander + lean, all scaled by its live depth, so lines,
      // dots and pulses all read the same coordinates.
      const breath = Math.sin(now * BREATH_SPEED) * BREATH_AMP;
      const cx = vw / 2;
      const cy = vh / 2;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        // Live depth: resting z0 plus its oscillation, clamped so the nearest
        // pass can't drive the lean past the border margin (see buildGraph).
        const zn = Math.max(0, Math.min(1.25, n.z0 + Math.sin(zt + n.zph) * Z_AMP));
        const depth = 0.55 + zn * 1.15;
        n.size = DOT_MIN + (zn * 0.82 + n.sizeJit) * (DOT_MAX - DOT_MIN);
        n.x = n.bx + (n.bx - cx) * breath + Math.sin(w + n.phx) * DRIFT_AMP * depth + leanX * depth;
        n.y = n.by + (n.by - cy) * breath + Math.cos(w + n.phy) * DRIFT_AMP * depth + leanY * depth;
      }
    };

    // ---- state ------------------------------------------------------------
    const pulses: Pulse[] = [];
    const flashes: Flash[] = [];
    let mouseX = -1;
    let mouseY = -1;
    let lastEmit = 0;
    let movedSinceEmit = false;
    let running = true;

    const addFlash = (x: number, y: number, color: RGB) => {
      if (flashes.length >= MAX_FLASHES) return;
      flashes.push({ x, y, t: 0, color });
    };

    /** Fire a pulse from `origin` down a random edge, avoiding `avoid` if it
     *  can (so a cascade tends to move forward, not bounce straight back). */
    const fireFrom = (origin: number, depth: number, avoid = -1) => {
      if (pulses.length >= MAX_PULSES) return;
      const node = nodes[origin];
      if (!node || node.edges.length === 0) return;
      let choices = node.edges;
      if (avoid !== -1 && node.edges.length > 1) {
        choices = node.edges.filter((e) => e !== avoid);
        if (choices.length === 0) choices = node.edges;
      }
      const to = choices[(Math.random() * choices.length) | 0]!;
      const target = nodes[to];
      if (!target) return;
      const len = Math.hypot(target.x - node.x, target.y - node.y) || 1;
      const color = colors[(Math.random() * colors.length) | 0]!;
      pulses.push({ from: origin, to, t: 0, speed: VELOCITY / len, color, depth });
      // Departure flash matches the pulse leaving it (a honey pulse must not
      // fire from a teal ring).
      addFlash(node.x, node.y, color);
    };

    /** Pick a node around the cursor (weighted toward the nearest) and fire. */
    const emitAtCursor = () => {
      if (mouseX < 0 || nodes.length === 0) return;
      const near: { i: number; d: number }[] = [];
      let nearest = -1;
      let nearestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const dx = n.x - mouseX;
        const dy = n.y - mouseY;
        const d = dx * dx + dy * dy;
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
        if (d <= CURSOR_R * CURSOR_R) near.push({ i, d });
      }
      if (near.length === 0) {
        if (nearest !== -1) fireFrom(nearest, CHAIN_DEPTH);
        return;
      }
      // Weight nearer nodes higher, but keep it random ("a random node around
      // where the mouse is").
      near.sort((p, q) => p.d - q.d);
      const pool = near.slice(0, 4);
      const pick = pool[(Math.random() * pool.length) | 0]!;
      fireFrom(pick.i, CHAIN_DEPTH);
    };

    // Draw the quiet background graph: every edge in one path, every dot in one
    // path — two draw calls total, no per-node allocation.
    const drawNet = () => {
      const [nr, ng, nb] = net;
      ctx.strokeStyle = `rgba(${nr},${ng},${nb},${netLineA})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let e = 0; e < edgePairs.length; e++) {
        const pair = edgePairs[e]!;
        const a = nodes[pair[0]]!;
        const b = nodes[pair[1]]!;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();

      ctx.fillStyle = `rgba(${nr},${ng},${nb},${netDotA})`;
      ctx.beginPath();
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        ctx.moveTo(n.x + n.size, n.y);
        ctx.arc(n.x, n.y, n.size, 0, TAU);
      }
      ctx.fill();
    };

    // ---- loop -------------------------------------------------------------
    let raf = 0;
    let prev = 0;
    const smooth = (p: number) => p * p * (3 - 2 * p); // smoothstep easing

    const frame = (now: number) => {
      if (!running) return;
      const dt = prev ? Math.min((now - prev) / 1000, 0.05) : 0;
      prev = now;

      updatePositions(now);

      // Emission is driven off the frame clock, not the mousemove event rate:
      // one fire per EMIT_MS while the cursor is moving. Browsers batch/coalesce
      // mousemove, so timing it here keeps the spark rate steady and smooth.
      if (movedSinceEmit && now - lastEmit >= EMIT_MS) {
        lastEmit = now;
        movedSinceEmit = false;
        emitAtCursor();
      }

      ctx.clearRect(0, 0, vw, vh);
      ctx.lineCap = "round";

      drawNet();

      // Pulses ride the current node positions, so they sit exactly on the
      // lines drawn above even as the field drifts.
      for (let p = pulses.length - 1; p >= 0; p--) {
        const pulse = pulses[p]!;
        pulse.t += pulse.speed * dt;
        const a = nodes[pulse.from];
        const b = nodes[pulse.to];
        if (!a || !b) {
          pulses.splice(p, 1);
          continue;
        }
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const done = pulse.t >= 1;
        const headP = smooth(Math.min(pulse.t, 1));
        const trailFrac = Math.min(0.92, TRAIL_PX / len);
        const tailP = smooth(Math.max(0, Math.min(pulse.t, 1) - trailFrac));
        const hx = a.x + (b.x - a.x) * headP;
        const hy = a.y + (b.y - a.y) * headP;
        const tx = a.x + (b.x - a.x) * tailP;
        const ty = a.y + (b.y - a.y) * tailP;
        const [r, g, bl] = pulse.color;

        // The line lights up behind the head, then fades. Two flat strokes — a
        // dim full-length trail plus a brighter segment near the head —
        // approximate the fade without allocating a gradient object every frame
        // per pulse (that runs to ~1.5k allocations/s when the pool is full).
        const mx = tx + (hx - tx) * 0.55;
        const my = ty + (hy - ty) * 0.55;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${r},${g},${bl},0.85)`;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        // Soft glowing head.
        const sprite = glowFor(pulse.color);
        const s = 15;
        ctx.globalAlpha = 0.85;
        ctx.drawImage(sprite, hx - s / 2, hy - s / 2, s, s);
        ctx.globalAlpha = 1;

        if (done) {
          addFlash(b.x, b.y, pulse.color);
          // Sometimes the signal fires onward — a short branching cascade.
          if (pulse.depth > 0 && Math.random() < CHAIN_P) {
            fireFrom(pulse.to, pulse.depth - 1, pulse.from);
            if (Math.random() < 0.3) fireFrom(pulse.to, pulse.depth - 1, pulse.from);
          }
          pulses.splice(p, 1);
        }
      }

      // Flash rings on the nodes that fired / received.
      for (let f = flashes.length - 1; f >= 0; f--) {
        const fl = flashes[f]!;
        fl.t += dt / 0.5; // ~0.5s life
        if (fl.t >= 1) {
          flashes.splice(f, 1);
          continue;
        }
        const [r, g, bl] = fl.color;
        const radius = 1.5 + fl.t * 8;
        ctx.strokeStyle = `rgba(${r},${g},${bl},${(1 - fl.t) * 0.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(fl.x, fl.y, radius, 0, TAU);
        ctx.stroke();
      }

      raf = requestAnimationFrame(frame);
    };

    // ---- wiring -----------------------------------------------------------
    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      movedSinceEmit = true;
    };

    // A DPR change (dragging the window to a monitor with a different pixel
    // ratio) fires no resize event, so watch it directly and rebuild — otherwise
    // the canvas keeps the old scale and every sprite draws the wrong size.
    let dprMq: MediaQueryList | null = null;
    const onDprChange = () => {
      buildGraph();
      watchDpr();
      pulses.length = 0;
      flashes.length = 0;
    };
    function watchDpr() {
      dprMq?.removeEventListener("change", onDprChange);
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMq.addEventListener("change", onDprChange);
    }

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        buildGraph();
        // Stale pulses/flashes reference old node indices — clear them.
        pulses.length = 0;
        flashes.length = 0;
      }, 180);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (started && !running) {
        running = true;
        prev = 0;
        raf = requestAnimationFrame(frame);
      }
    };

    // Track the theme like the rest of the ambient stack.
    const themeObserver = new MutationObserver(refreshColors);
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");

    // start()/stop() are the whole footprint: everything is registered on start
    // and torn back down on stop, so reduced-motion (and unmount) leave nothing
    // behind — no stray listener, timer, observer, or rAF.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      refreshColors();
      buildGraph();
      watchDpr();
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      scheme.addEventListener("change", refreshColors);
      window.addEventListener("mousemove", onMove, { passive: true });
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);
      running = true;
      prev = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!started) return;
      started = false;
      running = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      dprMq?.removeEventListener("change", onDprChange);
      dprMq = null;
      themeObserver.disconnect();
      scheme.removeEventListener("change", refreshColors);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      pulses.length = 0;
      flashes.length = 0;
      ctx.clearRect(0, 0, vw, vh);
    };

    const onReduceChange = () => {
      if (reduceMq.matches) stop();
      else start();
    };
    reduceMq.addEventListener("change", onReduceChange);
    if (!reduceMq.matches) start();

    return () => {
      reduceMq.removeEventListener("change", onReduceChange);
      stop();
    };
  }, []);

  return <canvas ref={canvasRef} className="app-pulse" aria-hidden="true" />;
}
