/**
 * Ambient background.
 *
 * A single fixed layer behind the entire app: two soft corner glows, a third
 * that turns the dark theme into a slow aurora, and a fine paper grain over the
 * top. It is what stops the warm base colour reading as flat "basic" fill — the
 * screen now has depth and a little life without anything moving in the user's
 * way.
 *
 * Purely decorative: aria-hidden, pointer-events-none, and pinned behind
 * content at a negative z-index. All motion is confined to the dark aurora and
 * is switched off by the global prefers-reduced-motion rule. The look is driven
 * entirely by the --ambient-* and --grain-* tokens, so it re-themes for free.
 */
export function Ambient() {
  return (
    <div className="app-ambient" aria-hidden="true">
      <div className="app-ambient__glow" />
      <div className="app-ambient__grain" />
    </div>
  );
}
