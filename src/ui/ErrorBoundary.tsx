/**
 * What is on screen when the screen itself fails.
 *
 * A drawing error in React unmounts the whole tree. Kinema's window is
 * transparent so mpv can render behind it, which means an empty tree is not a
 * blank window but the desktop showing through, with nothing to say what
 * happened or how to leave. This catches the error, writes it to `app.log`, and
 * puts an opaque screen up in its place with three ways out.
 *
 * The buttons here are deliberately plain `<button>`s, the one place in the app
 * where that is right. The spatial navigation that `FocusButton` depends on
 * lives inside the tree that has just failed; a control that needed it could be
 * dead for exactly the reason this screen exists. Native focus, Enter, and the
 * arrow keys handled below work whatever went wrong above.
 */
import { Component, Fragment, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { openLogFolder } from '../metadata/api';
import { powerAction } from './api';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
  /** Bumped by Try again, so the children are built from scratch. */
  attempt: number;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // console.error is forwarded to app.log by devlog.ts.
    console.error('the screen failed to draw:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    return (
      <CrashScreen
        onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
      />
    );
  }
}

function CrashScreen({ onRetry }: { onRetry: () => void }) {
  const row = useRef<HTMLDivElement>(null);

  // Arrow keys step between the buttons, so a remote can use them.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const buttons = Array.from(row.current?.querySelectorAll('button') ?? []);
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0;
      if (step === 0 || buttons.length === 0) return;
      e.preventDefault();
      buttons[(at + step + buttons.length) % buttons.length].focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="crash-screen" role="alert">
      <h1>Something went wrong</h1>
      <p>
        Kinema could not draw this screen. Nothing in your library was changed, and what went wrong
        is written to the log.
      </p>
      <div className="crash-actions" ref={row}>
        <button type="button" className="btn-primary" autoFocus onClick={onRetry}>
          Try again
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void openLogFolder().catch(() => undefined)}
        >
          Open the log folder
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void powerAction('close').catch(() => undefined)}
        >
          Close Kinema
        </button>
      </div>
    </div>
  );
}
