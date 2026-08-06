/**
 * Frontend → disk logging bridge.
 *
 * The app's UI runs inside WebView2, and its console is only visible in
 * DevTools attached to that window. Anything logged or thrown there is
 * invisible from outside the app — which is why a parser that threw on every
 * single file looked identical to a parser that simply found nothing, and why
 * an mpv option that aborted startup produced only a silent transparent window.
 *
 * Forwarding console output and unhandled errors to a file makes those
 * failures readable after the fact, without needing DevTools open at the
 * moment they happen.
 */
import { invoke } from '@tauri-apps/api/core';

type Level = 'log' | 'warn' | 'error';

function serialise(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function forward(level: Level, args: unknown[]) {
  // Fire and forget: logging must never throw into the caller, and must never
  // recurse back through the patched console on failure.
  void invoke('append_log', { level, message: serialise(args) }).catch(() => undefined);
}

let installed = false;

export function installDevLog() {
  if (installed) return;
  installed = true;

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      forward(level, args);
    };
  }

  window.addEventListener('error', (event) => {
    forward('error', [`uncaught: ${event.message}`, `${event.filename}:${event.lineno}`, event.error]);
  });

  window.addEventListener('unhandledrejection', (event) => {
    forward('error', ['unhandled rejection:', event.reason]);
  });

  forward('log', ['--- devlog started ---', new Date().toISOString()]);
}
