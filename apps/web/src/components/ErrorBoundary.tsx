/**
 * Top-level error boundary.
 *
 * A render-time exception anywhere in the tree would otherwise unmount the whole
 * app and leave a blank white page — the worst possible failure for a tool
 * someone is trusting with their money, because it looks like the data is gone.
 * This catches that, keeps the frame, and offers a reload.
 *
 * The raw error message is shown only in development. In production it is
 * withheld: a stack or message can leak internals, and it means nothing to the
 * person using the app.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced to the console for local debugging and for whatever error
    // reporting a deployment wires up. Never rendered to the user in production.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private handleReload = (): void => {
    // Full reload rather than clearing state: the tree is in an unknown state,
    // and a fresh load re-runs session bootstrap from a clean slate.
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <h1 className="text-heading text-ink">Something went wrong</h1>
        <p className="max-w-[420px] text-body text-ink-secondary">
          The screen hit an unexpected error. Your data is safe — reloading
          usually fixes it.
        </p>
        {import.meta.env.DEV && (
          <pre className="max-w-[560px] overflow-auto rounded-md bg-surface-sunken p-3 text-left text-meta text-alert">
            {this.state.error.message}
          </pre>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          className="min-h-[40px] rounded-md bg-accent px-5 text-body font-medium text-ink-inverse transition-colors hover:bg-accent-hover"
        >
          Reload
        </button>
      </div>
    );
  }
}
