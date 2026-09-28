import { getSetting, setSetting } from './api';

/**
 * Kinema's own TMDB key, so a library works without anyone registering for one.
 *
 * Baked in when the app is built, from `VITE_TMDB_API_KEY`: a GitHub Actions
 * secret in release.yml, or a git-ignored `.env.local` for a local build. It is
 * kept out of the source because bots harvest keys from public repositories,
 * and a key TMDB blocks for abuse stops working in every copy at once. It is
 * still readable inside the built app, as any key a program sends is; TMDB's
 * answer on keys in distributed apps is "allowed, discouraged, and a blocked
 * one gets replaced", which is why a rejected key is handled rather than
 * assumed away.
 *
 * A key entered in Settings always wins. A build without this one — anyone
 * building from source — behaves as Kinema always did: TMDB with a key from
 * Settings, TVmaze for TV without one.
 */
export const BUILTIN_TMDB_KEY: string | null =
  (import.meta.env.VITE_TMDB_API_KEY as string | undefined)?.trim() || null;

/**
 * Which built-in key is in effect, as a fingerprint ('' for none). Stored so
 * that a new one — the first release with a key, a new key in an update —
 * counts as a provider key changing, which re-opens refused matches for the
 * next scan (`PROVIDER_KEYS` in settings.rs). One going away re-opens nothing,
 * just as clearing a key in Settings does not; files that failed while it was
 * being refused are provider failures, which the next scan retries anyway.
 */
export const BUILTIN_STATE_KEY = 'tmdb_builtin_key';
/** The fingerprint of a built-in key TMDB refused. A new release's key is not it. */
export const BUILTIN_REJECTED_KEY = 'tmdb_builtin_rejected';

/** FNV-1a, as hex: enough to tell keys apart, and not the key itself. */
export function fingerprint(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The built-in key, unless TMDB has refused that very key. */
export function usableBuiltinKey(builtin: string | null, rejected: string | null): string | null {
  return builtin && fingerprint(builtin) !== rejected ? builtin : null;
}

/** Whether the built-in key exists and TMDB has refused it. */
export async function builtinKeyRejected(): Promise<boolean> {
  if (!BUILTIN_TMDB_KEY) return false;
  const rejected = await getSetting(BUILTIN_REJECTED_KEY);
  return usableBuiltinKey(BUILTIN_TMDB_KEY, rejected) === null;
}

/** Refused, and no key of the user's own to stand in: worth saying on Home. */
export async function needsOwnTmdbKey(): Promise<boolean> {
  if (!(await builtinKeyRejected())) return false;
  return !(await getSetting('tmdb_api_key'))?.trim();
}

/**
 * Record which built-in key is in effect, if that has changed. Called before
 * a scan lists what to match, so files refused for want of a key are in that
 * very list once one arrives.
 */
export async function syncBuiltinKey(): Promise<void> {
  const usable = usableBuiltinKey(BUILTIN_TMDB_KEY, await getSetting(BUILTIN_REJECTED_KEY));
  const now = usable ? fingerprint(usable) : '';
  // An empty setting reads back as null.
  if (((await getSetting(BUILTIN_STATE_KEY)) ?? '') !== now) {
    await setSetting(BUILTIN_STATE_KEY, now);
  }
}

/**
 * TMDB answered 401 to `key`. When that is the built-in key, it is not used
 * again: matching carries on with what works without it, and Home says so.
 * A key of the user's own that is refused is theirs to correct, and is left
 * to the error it produces.
 */
export async function noteTmdbRejection(key: string): Promise<void> {
  if (key !== BUILTIN_TMDB_KEY) return;
  console.warn('TMDB refused the built-in key; carrying on without it');
  await setSetting(BUILTIN_REJECTED_KEY, fingerprint(key));
  await syncBuiltinKey();
}

export type TmdbKeySource = 'own' | 'builtin';

/** The key to use, and whose it is: the user's own first, then the built-in one. */
export function chooseTmdbKey(
  own: string | null | undefined,
  builtin: string | null
): { key: string; source: TmdbKeySource } | null {
  const mine = own?.trim();
  if (mine) return { key: mine, source: 'own' };
  if (builtin) return { key: builtin, source: 'builtin' };
  return null;
}
