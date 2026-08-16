import { describe, expect, it, vi } from "vitest";
import { swallowTransitionRejections, type ViewTransitionLike } from "./theme-transition";

/**
 * B9 — the theme toggle didn't capture the ViewTransition, so a rejected
 * `ready`/`finished` (skipped/aborted transition, or a hidden document) surfaced
 * as an uncaught promise rejection. The helper must attach a catch to both.
 */
describe("swallowTransitionRejections (B9)", () => {
  it("attaches a no-op catch to both ready and finished", () => {
    const readyCatch = vi.fn();
    const finishedCatch = vi.fn();
    const transition = {
      ready: { catch: readyCatch },
      finished: { catch: finishedCatch },
    } as unknown as ViewTransitionLike;

    const returned = swallowTransitionRejections(transition);

    expect(returned).toBe(transition);
    expect(readyCatch).toHaveBeenCalledTimes(1);
    expect(finishedCatch).toHaveBeenCalledTimes(1);
    // The handler is a function that swallows the rejection without throwing.
    const readyHandler = readyCatch.mock.calls[0]?.[0] as (e: unknown) => void;
    const finishedHandler = finishedCatch.mock.calls[0]?.[0] as (e: unknown) => void;
    expect(typeof readyHandler).toBe("function");
    expect(typeof finishedHandler).toBe("function");
    expect(() => readyHandler(new Error("aborted"))).not.toThrow();
    expect(() => finishedHandler(new Error("aborted"))).not.toThrow();
  });

  it("leaves no unhandled rejection when the real promises reject", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    swallowTransitionRejections({
      ready: Promise.reject(new Error("Transition was aborted")),
      finished: Promise.reject(new Error("Transition was aborted")),
    });

    // Flush microtasks + a macrotask tick so any unhandled rejection would fire.
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});
