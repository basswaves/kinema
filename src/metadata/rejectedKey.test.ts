/**
 * What happens when TMDB refuses the key Kinema came with.
 *
 * The HTTP plugin and the Rust commands are replaced with stand-ins: every
 * TMDB request is answered 401, and settings live in a map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaFile } from '../library/api';

const BUILTIN = 'builtin-test-key';
vi.stubEnv('VITE_TMDB_API_KEY', BUILTIN);

const requests: string[] = [];
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (url: string) => {
    requests.push(url);
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
  }),
}));

const settings = new Map<string, string>();
const recorded: Array<{ command: string; reason?: string }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'get_setting') return settings.get(String(args.key))?.trim() || null;
    if (command === 'set_setting') {
      settings.set(String(args.key), String(args.value));
      return null;
    }
    if (command === 'record_refusal' || command === 'record_provider_failure') {
      recorded.push({ command, reason: String(args.reason) });
      return 1;
    }
    return null;
  }),
}));

const { tmdbSearch, TmdbKeyRejected } = await import('./providers');
const { fingerprint, needsOwnTmdbKey, BUILTIN_REJECTED_KEY } = await import('./builtinKey');
const { loadProviderKeys, matchFiles } = await import('./match');

function movie(id: number, title: string): MediaFile {
  return {
    id,
    path: `D:/Movies/${title}.mkv`,
    parent_dir: 'D:/Movies',
    file_name: `${title}.mkv`,
    size_bytes: 1,
    missing: false,
    match_status: 'parsed',
    parsed_title: title,
    parsed_year: 2001,
    parsed_season: null,
    parsed_episode: null,
    parsed_kind: 'movie',
    parsed_from: null,
    title_id: null,
    match_confidence: null,
    match_reason: null,
    matched_title: null,
    episode_name: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  recorded.length = 0;
  settings.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('a refused built-in key', () => {
  it('is set aside, and Home is told a key of your own is needed', async () => {
    await expect(settle(tmdbSearch(BUILTIN, 'A Film', 2001, 'movie'))).rejects.toBeInstanceOf(
      TmdbKeyRejected
    );
    expect(settings.get(BUILTIN_REJECTED_KEY)).toBe(fingerprint(BUILTIN));
    expect((await loadProviderKeys()).tmdb).toBeNull();
    expect(await needsOwnTmdbKey()).toBe(true);
  });

  it('is not held against a key of your own', async () => {
    settings.set('tmdb_api_key', 'mine');
    await expect(settle(tmdbSearch('mine', 'A Film', 2001, 'movie'))).rejects.toBeInstanceOf(
      TmdbKeyRejected
    );
    expect(settings.has(BUILTIN_REJECTED_KEY)).toBe(false);
    expect(await needsOwnTmdbKey()).toBe(false);
  });

  it('is asked once per run, not once per title', async () => {
    const keys = await loadProviderKeys();
    expect(keys.tmdbSource).toBe('builtin');

    const outcome = await settle(
      matchFiles([movie(1, 'First Film'), movie(2, 'Second Film')], keys, () => undefined)
    );

    expect(requests).toHaveLength(1);
    expect(outcome.unmatched).toBe(2);
    // The one that met the refusal is retried by the next scan; the other was
    // never asked, for want of a source.
    expect(recorded.map((r) => r.command)).toEqual(['record_provider_failure', 'record_refusal']);
  });
});
