/**
 * Choosing a title's poster (T20, posters.rs): what there is to choose from
 * — the picture beside the files, and TMDB's posters for the title, asked for
 * when the list is opened — and keeping the choice.
 */
import { invoke } from '@tauri-apps/api/core';
import { cacheArtwork } from '../metadata/api';
import { loadProviderKeys } from '../metadata/match';
import { tmdbPosters, type TmdbPoster } from '../metadata/providers';
import { languageName } from '../player/language';

interface PosterOptions {
  kind: string;
  tmdb_id: string | null;
  poster_url: string | null;
  local_path: string | null;
  chosen: string | null;
}

export interface PosterChoice {
  id: string;
  /** "Beside the file", "TMDB · English". */
  words: string;
  local: string | null;
  remote: string | null;
  /** The one the title shows now. */
  current: boolean;
  choose: () => Promise<void>;
}

const choosePoster = (titleId: number, url: string) =>
  invoke<void>('choose_poster', { titleId, url });

/** Which poster a title shows, by the same rule as TITLE_SELECT. */
export function shownNow(options: PosterOptions): string | null {
  if (options.chosen) return options.chosen;
  if (options.local_path) return '';
  return options.poster_url;
}

/** TMDB's posters in their order, the one stored first; each address once. */
export function tmdbChoices(stored: string | null, posters: TmdbPoster[]): TmdbPoster[] {
  const seen = new Set<string>();
  const list: TmdbPoster[] = [];
  const add = (p: TmdbPoster) => {
    if (seen.has(p.url)) return;
    seen.add(p.url);
    list.push(p);
  };
  const first = posters.find((p) => p.url === stored);
  if (first) add(first);
  else if (stored?.startsWith('https://image.tmdb.org/')) add({ url: stored, language: null });
  posters.forEach(add);
  return list;
}

/** What there is to choose from, and a note when TMDB was not asked or had none. */
export interface PosterChoices {
  choices: PosterChoice[];
  note: string | null;
  /** TMDB's list is still being asked for. */
  asking: boolean;
}

/**
 * Everything to choose from: what is stored at once, then TMDB's posters
 * once they are in. `show` is called once or twice.
 */
export async function posterChoices(titleId: number, show: (found: PosterChoices) => void): Promise<void> {
  const options = await invoke<PosterOptions>('poster_options', { titleId });
  const shown = shownNow(options);
  const keep = (url: string) => async () => {
    await choosePoster(titleId, url);
    // A TMDB poster not fetched before: into the cache, as a scan would —
    // not waited for, since it fetches whatever else is missing too. Until
    // then the page shows TMDB's copy.
    if (url) void cacheArtwork().catch(() => undefined);
  };
  const choices: PosterChoice[] = [];
  if (options.local_path) {
    choices.push({
      id: 'local',
      words: 'Beside the file',
      local: options.local_path,
      remote: null,
      current: shown === '',
      choose: keep(''),
    });
  }
  const tmdb = (posters: TmdbPoster[]) =>
    tmdbChoices(options.poster_url, posters).map((p): PosterChoice => {
      const language = p.language ? languageName(p.language) : null;
      return {
        id: p.url,
        words: language ? `TMDB · ${language}` : 'TMDB',
        local: null,
        remote: p.url,
        current: shown === p.url,
        choose: keep(p.url),
      };
    });
  const asking = Boolean(options.tmdb_id);
  show({ choices: [...choices, ...tmdb([])], note: null, asking });
  if (!asking) return;
  let note: string | null = null;
  let posters: TmdbPoster[] = [];
  {
    try {
      const keys = await loadProviderKeys();
      if (keys.tmdb) {
        posters = await tmdbPosters(
          keys.tmdb,
          options.tmdb_id as string,
          options.kind === 'series' ? 'series' : 'movie'
        );
      }
    } catch (e) {
      console.warn('posters: TMDB not asked', e instanceof Error ? e.message : String(e));
      note = 'TMDB could not be reached, so only what is stored is here.';
    }
  }
  const all = [...choices, ...tmdb(posters)];
  if (all.length <= 1 && !note) note = 'There is no other picture for this title.';
  show({ choices: all, note, asking: false });
}
