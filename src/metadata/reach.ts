/**
 * What to say when a service gave no answer at all.
 *
 * "Couldn't reach the internet" was said for every such failure, and it was
 * wrong for a tester whose internet worked while TMDB did not get through. The
 * webview's `fetch` only says "error sending request", so the Rust side
 * (reach.rs) asks the host once more where the cause can be read, and asks
 * Wikidata as well, to tell "this service" apart from "the internet". Both
 * answers go to the log in full; the screen gets one sentence.
 */
import { invoke } from '@tauri-apps/api/core';
import { userError } from '../ui/errors';
import { Unreachable } from './providers';

interface Reach {
  reached: boolean;
  status: number | null;
  cause: string;
}

const COMPARE_HOST = 'www.wikidata.org';

const CAUSES: Record<string, string> = {
  dns: 'its name could not be looked up',
  tls: 'the secure connection to it failed',
  refused: 'the connection was refused',
  cut: 'the connection was cut off',
  timeout: 'it did not answer in time',
  other: 'the request failed',
};

function checkReach(host: string): Promise<Reach | null> {
  return invoke<Reach>('check_reach', { host }).catch(() => null);
}

/** One sentence about an `Unreachable`, from what the hosts say now. */
export async function explainUnreachable(e: Unreachable): Promise<string> {
  const where = `${e.service} (${e.hosts.join(' or ')})`;
  const checks = await Promise.all(e.hosts.map(checkReach));
  if (checks.some((c) => c?.reached)) {
    return `${where} did not answer, but answers now. Try again.`;
  }
  const known = checks.find((c) => c);
  const why = known ? (CAUSES[known.cause] ?? CAUSES.other) : CAUSES.other;
  const compare = await checkReach(COMPARE_HOST);
  if (compare?.reached) {
    return (
      `The internet works, but ${where} could not be reached: ${why}. ` +
      'Some networks block it; on another network it may get through.'
    );
  }
  return `${where} could not be reached: ${why}, and neither could Wikidata. Check the internet connection.`;
}

/** `userError`, except that a service with no answer is asked why first. */
export async function describeFailure(e: unknown): Promise<string> {
  if (!(e instanceof Unreachable)) return userError(e);
  const sentence = await explainUnreachable(e);
  console.warn('shown to the user:', sentence);
  return sentence;
}
