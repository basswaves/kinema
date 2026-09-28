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
