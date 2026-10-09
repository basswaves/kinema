/**
 * The parts of the self-test's plan that are plain arithmetic, apart from
 * `selftest.ts` so they can be tested without a window (and without the
 * dozens of commands that module imports).
 */

/** What `expandActions` needs of an action; the plan's own type has more. */
export interface Timed {
  /** Seconds after the test started — or, inside a `repeat`, after its round began. */
  at: number;
  do: string;
  /** For `repeat`: how many rounds, and the seconds from one round's start to the next. */
  times?: number;
  every?: number;
  /** For `repeat`: what each round does, timed from the round's start. */
  actions?: Timed[];
  /** Which round of a `repeat` an action came from, counted from 0. */
  round?: number;
}

/** A plan that nests `repeat` deeper than this is a mistake, not a test. */
const MAX_DEPTH = 3;

/**
 * Flatten `repeat` into the plain, timed actions it stands for, so the runner
 * schedules one list as it always has. A `repeat` at 10 s of 3 rounds every
 * 30 s, holding an action at 5, becomes that action at 15, 45 and 75 s, each
 * marked with its round.
 */
export function expandActions<T extends Timed>(actions: T[], offset = 0, depth = 0): T[] {
  const out: T[] = [];
  for (const action of actions) {
    const at = offset + action.at;
    if (action.do !== 'repeat') {
      out.push({ ...action, at });
      continue;
    }
    if (depth >= MAX_DEPTH) throw new Error(`repeat is nested more than ${MAX_DEPTH} deep`);
    const times = Math.max(0, Math.floor(action.times ?? 1));
    const every = action.every ?? 0;
    for (let round = 0; round < times; round++) {
      for (const inner of expandActions((action.actions ?? []) as T[], at + round * every, depth + 1)) {
        out.push({ ...inner, round: inner.round ?? round });
      }
    }
  }
  return out;
}

/**
 * How many of a window's property names are Tauri's registered callbacks
 * (`_123`): one is made for every event listener and every channel, and one
 * that is never unregistered stays for good — a count that keeps climbing
 * across plays is a listener that is not being let go.
 */
export function countCallbacks(names: string[]): number {
  return names.filter((name) => /^_\d+$/.test(name)).length;
}
