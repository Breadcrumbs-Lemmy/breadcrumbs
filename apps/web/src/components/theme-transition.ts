/**
 * View Transitions helper for the theme toggle.
 *
 * `document.startViewTransition()` returns a transition whose `ready` and
 * `finished` promises REJECT when the transition is skipped or aborted — a
 * rapid second toggle interrupting the first, or an inactive/hidden document
 * (the API refuses to animate a document that isn't visible). The theme still
 * swaps via the update callback in every one of those cases, so the rejection
 * is expected and harmless — but if it isn't caught it surfaces as an uncaught
 * promise rejection that pollutes the console (B9).
 */

export interface ViewTransitionLike {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
}

/**
 * Attach no-op catch handlers so an aborted/skipped transition's rejected
 * promises are handled. Returns the transition so callers can keep chaining.
 */
export function swallowTransitionRejections<T extends ViewTransitionLike>(transition: T): T {
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  return transition;
}
