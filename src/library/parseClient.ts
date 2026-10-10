/**
 * The page's end of the parse worker (`parse.worker.ts`).
 *
 * One worker, made on the first batch and let go of after a quiet spell so a
 * weak box is not left holding the parser's memory for the rest of a session.
 * Anything that goes wrong — no `Worker` here (a test, an old WebView), a
 * worker script that will not load, a worker that dies — answers `null`, and
 * the caller parses on the page instead, as it did before there was a worker.
 */
import type { LibraryRoot, MediaFile, ParseResultPayload } from './api';
import type { ParseReply, ParseRequest } from './parse.worker';

/** How long an unused worker is kept. */
const IDLE_MS = 30_000;

interface Waiting {
  resolve: (reply: ParseReply) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | null = null;
let unusable = false;
let nextId = 1;
const waiting = new Map<number, Waiting>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** For tests: forget the worker and whether it was found unusable. */
export function resetParseWorker(): void {
  drop('reset', false);
  unusable = false;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function drop(reason: string, permanent: boolean): void {
  if (permanent) unusable = true;
  worker?.terminate();
  worker = null;
  for (const entry of waiting.values()) entry.reject(new Error(reason));
  waiting.clear();
}

function start(): Worker | null {
  if (unusable) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const made = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    made.onmessage = (event: MessageEvent<ParseReply>) => {
      const entry = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      entry?.resolve(event.data);
    };
    // A script that fails to load, or one that throws outside a batch: this
    // WebView cannot run the worker, so the page does the work from now on.
    made.onerror = () => drop('the parse worker failed', true);
    made.onmessageerror = () => drop('the parse worker sent something unreadable', true);
    worker = made;
    return made;
  } catch {
    unusable = true;
    return null;
  }
}

function releaseWhenQuiet(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (waiting.size === 0) drop('the parse worker was let go', false);
  }, IDLE_MS);
}

/**
 * Parse a batch on the worker. `null` means "could not": do it on the page.
 * `parseError` is the parser's own last failure in this batch, if it had one.
 */
export async function parseInWorker(
  files: MediaFile[],
  roots: LibraryRoot[]
): Promise<{ payloads: ParseResultPayload[]; parseError: string | null } | null> {
  const running = start();
  if (!running) return null;
  if (idleTimer) clearTimeout(idleTimer);

  const id = nextId++;
  try {
    const reply = await new Promise<ParseReply>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      const request: ParseRequest = { id, files, roots };
      try {
        running.postMessage(request);
      } catch (e) {
        waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    if ('failure' in reply) return null;
    return { payloads: reply.payloads, parseError: reply.parseError };
  } catch {
    return null;
  } finally {
    releaseWhenQuiet();
  }
}
