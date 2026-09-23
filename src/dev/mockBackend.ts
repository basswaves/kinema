/**
 * A stand-in backend, so the whole UI runs in an ordinary browser.
 *
 * **Development only.** `main.tsx` imports this solely when the dev server is
 * started with `VITE_KINEMA_MOCK=1` (`npm run dev:mock`); the condition is a
 * compile-time constant in a production build, so none of it ships.
 *
 * Why it exists: nearly every bug in this codebase's history was invisible
 * until someone sat in front of the real app — above all the D-pad ones, which
 * only show with the mouse untouched. With this, the browsing UI and the
 * player's controls can be driven keyboard-only in the Claude browser pane,
 * against a small fixed library, with `fakeMpv.ts` standing in for the player.
 *
 * It is a **fixture**, not a second implementation. The rules it answers with
 * are the simple, documented ones; the real rules are tested in Rust. If this
 * and `playback.rs` ever disagree on an edge case, Rust is right and this is
 * only as good as the check it is being used for.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import * as fakeMpv from './fakeMpv';
import type { ContinueItem, EpisodeRef, Progress, SkipMarkers, TitlePrefs } from '../player/api';
import type { Episode, Title, TitleDetail } from '../ui/api';

// ---- the library -------------------------------------------------------

interface FixtureFile {
  id: number;
  titleId: number;
  path: string;
  season: number | null;
  episode: number | null;
  duration: number;
  markers: SkipMarkers | null;
}

const SERIES_ID = 1;
const FILM_ID = 2;

const titles: Title[] = [
  {
    id: SERIES_ID,
    kind: 'series',
    provider: 'tmdb',
    title: 'Example Show',
    year: 2001,
    overview: 'A fixture series: four episodes, each with a different kind of intro.',
    genres: JSON.stringify(['Comedy']),
    runtime_mins: 25,
    poster_url: null,
    backdrop_url: null,
    poster_path: null,
    backdrop_path: null,
    logo_url: null,
    logo_path: null,
    trailer_key: null,
    trailer_site: null,
    rating: 7.9,
    file_count: 4,
    added_at: 2,
  },
  {
    id: FILM_ID,
    kind: 'movie',
    provider: 'tmdb',
    title: 'Example Film',
    year: 2017,
    overview: 'A fixture film.',
    genres: JSON.stringify(['Drama']),
    runtime_mins: 100,
    poster_url: null,
    backdrop_url: null,
    poster_path: null,
    backdrop_path: null,
    logo_url: null,
    logo_path: null,
    trailer_key: null,
    trailer_site: null,
    rating: 8.1,
    file_count: 1,
    added_at: 1,
  },
];

const intro = (start: number, end: number, source: string) => ({
  intro: { start, end },
  intro_source: source,
});

/** Episodes chosen to cover the intro cases the player has to handle. */
const files: FixtureFile[] = [
  // The ordinary case: the intro is the first thing in the file.
  {
    id: 101,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E01.mkv',
    season: 1,
    episode: 1,
    duration: 1500,
    markers: { ...intro(0.2, 45.6, 'skiptro-db'), credits: { start: 1430, end: null }, credits_source: 'analysis' },
  },
  // A cold open: ten seconds of story before the intro.
  {
    id: 102,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E02.mkv',
    season: 1,
    episode: 2,
    duration: 1500,
    markers: { ...intro(10.0, 46.0, 'analysis'), credits: { start: 1428, end: null }, credits_source: 'analysis' },
  },
  // Long credits: they start before the 94% "watched" line, and
  // there is a next episode to move on to.
  {
    id: 103,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E03.mkv',
    season: 1,
    episode: 3,
    duration: 1440,
    markers: { ...intro(0, 44, 'analysis'), credits: { start: 1330, end: null }, credits_source: 'analysis' },
  },
  // No markers from any source. Last in the season, so nothing follows it.
  {
    id: 104,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E04.mkv',
    season: 1,
    episode: 4,
    duration: 1500,
    markers: null,
  },
  {
    id: 201,
    titleId: FILM_ID,
    path: 'C:\\fixture\\Example Film (2017)\\Example.Film.2017.mkv',
    season: null,
    episode: null,
    duration: 6000,
    markers: null,
  },
];

const playback = new Map<number, { position: number; duration: number | null; completed: boolean; updated: number }>();
const prefs = new Map<number, TitlePrefs>();
const settings = new Map<string, string>([['tmdb_api_key', 'fixture']]);
let clock = 1000;

const fileById = (id: number) => files.find((f) => f.id === id) ?? null;
const titleById = (id: number) => titles.find((t) => t.id === id) ?? null;

function episodeRef(file: FixtureFile): EpisodeRef {
  return {
    file_id: file.id,
    path: file.path,
    season: file.season ?? 0,
    episode: file.episode ?? 0,
    name: `Episode ${file.episode}`,
    title: titleById(file.titleId)?.title ?? '',
  };
}

function episodesOf(titleId: number): FixtureFile[] {
  return files
    .filter((f) => f.titleId === titleId && f.season !== null)
    .sort((a, b) => (a.season! - b.season!) * 1000 + (a.episode! - b.episode!));
}

function adjacent(fileId: number, forward: boolean): EpisodeRef | null {
  const file = fileById(fileId);
  if (!file || file.season === null) return null;
  const list = episodesOf(file.titleId);
  const index = list.findIndex((f) => f.id === fileId);
  const next = list[index + (forward ? 1 : -1)];
  return next ? episodeRef(next) : null;
}

/** Same rule as `save_progress`: 94% counts as finished. */
function saveProgress(fileId: number, position: number, duration: number | null): null {
  const completed = duration !== null && duration > 0 && position / duration >= 0.94;
  playback.set(fileId, { position, duration, completed, updated: ++clock });
  return null;
}

function continueWatching(): ContinueItem[] {
  const item = (file: FixtureFile, nextUp: boolean, updated: number): ContinueItem => {
    const row = playback.get(file.id);
    return {
      file_id: file.id,
      path: file.path,
      title_id: file.titleId,
      title: titleById(file.titleId)?.title ?? '',
      kind: titleById(file.titleId)?.kind ?? 'movie',
      season: file.season,
      episode: file.episode,
      episode_name: file.episode === null ? null : `Episode ${file.episode}`,
      position_secs: nextUp ? 0 : (row?.position ?? 0),
      duration_secs: nextUp ? null : (row?.duration ?? null),
      image_url: null,
      image_path: null,
      updated_at: updated,
      is_next_up: nextUp,
    };
  };

  const items: ContinueItem[] = [];
  const seen = new Set<number>();
  const byRecent = [...playback.entries()].sort((a, b) => b[1].updated - a[1].updated);

  for (const [fileId, row] of byRecent) {
    const file = fileById(fileId);
    if (!file || row.completed || row.position < 30 || seen.has(file.titleId)) continue;
    seen.add(file.titleId);
    items.push(item(file, false, row.updated));
  }
  for (const [fileId, row] of byRecent) {
    const file = fileById(fileId);
    if (!file || !row.completed || file.season === null || seen.has(file.titleId)) continue;
    const next = episodesOf(file.titleId).find(
      (f) => (f.season! > file.season! || (f.season === file.season && f.episode! > file.episode!)) &&
        !playback.get(f.id)?.completed
    );
    if (!next) continue;
    seen.add(file.titleId);
    items.push(item(next, true, row.updated));
  }
  return items.sort((a, b) => b.updated_at - a.updated_at);
}

function titleDetail(titleId: number): TitleDetail {
  const title = titleById(titleId);
  if (!title) throw new Error(`no title ${titleId}`);
  const episodes: Episode[] = episodesOf(titleId).map((f) => ({
    id: f.id * 10,
    season: f.season!,
    episode: f.episode!,
    name: `Episode ${f.episode}`,
    overview: 'A fixture episode.',
    air_date: null,
    runtime_mins: Math.round(f.duration / 60),
    still_url: null,
    still_path: null,
    file_path: f.path,
    file_id: f.id,
    watched: playback.get(f.id)?.completed ?? false,
    position_secs: playback.get(f.id)?.position ?? null,
    duration_secs: playback.get(f.id)?.duration ?? null,
  }));
  const movie = title.kind === 'movie' ? files.find((f) => f.titleId === titleId) : undefined;
  return {
    title,
    episodes,
    cast: [],
    movie_path: movie?.path ?? null,
    movie_file_id: movie?.id ?? null,
    movie_watched: movie ? (playback.get(movie.id)?.completed ?? false) : false,
  };
}

// ---- events ---------------------------------------------------------------

/**
 * Event delivery, done here rather than by `mockIPC`'s `shouldMockEvents`.
 *
 * Tauri's own mock never removes a listener: `unlisten` sends `eventId`, and
 * the mock's removal looks for `id` (@tauri-apps/api 2.11, mocks.js). Every
 * listener ever registered therefore kept receiving events, each delivery to a
 * callback the page had already discarded printed "Couldn't find callback id",
 * and a test counting listeners or those warnings was measuring the mock.
 */
const eventListeners = new Map<string, number[]>();

type Internals = { runCallback: (id: number, data: unknown) => void };

function listen(event: string, handler: number): number {
  const list = eventListeners.get(event) ?? [];
  list.push(handler);
  eventListeners.set(event, list);
  return handler;
}

function unlisten(event: string, id: number): null {
  const list = eventListeners.get(event) ?? [];
  eventListeners.set(
    event,
    list.filter((handler) => handler !== id)
  );
  return null;
}

function emitEvent(event: string, payload: unknown): null {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  for (const handler of [...(eventListeners.get(event) ?? [])]) {
    internals.runCallback(handler, { event, id: handler, payload });
  }
  return null;
}

/** How many listeners each event has — for checking that nothing leaks. */
export function listenerCounts(): Record<string, number> {
  return Object.fromEntries([...eventListeners].map(([event, list]) => [event, list.length]));
}

// ---- the command table ----------------------------------------------------

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

const num = (args: Args, key: string) => Number(args[key]);

const handlers: Record<string, Handler> = {
  // library
  list_library_roots: () => [{ id: 1, path: 'C:\\fixture', kind: 'tv', file_count: files.length }],
  scan_library: () => ({
    roots_scanned: 1, files_seen: files.length, files_added: 0, files_updated: 0,
    files_unchanged: files.length, files_missing: 0, errors: [], duration_ms: 5,
  }),
  list_unparsed: () => [],
  save_parse_results: () => 0,
  library_stats: () => ({ total: files.length, unparsed: 0, parsed: 0, missing: 0, total_bytes: 0 }),
  add_library_root: () => 1,
  remove_library_root: () => null,
  list_media_files: () => [],

  // metadata
  list_titles: () => titles,
  get_title_detail: (a) => titleDetail(num(a, 'titleId')),
  list_unmatched: () => [],
  list_needs_review: () => [],
  count_needs_review: () => 0,
  list_titles_needing_detail: () => [],
  cache_artwork: () => ({ stored: 0, failed: 0 }),
  artwork_stats: () => ({ files: 0, bytes: 0, failed: 0 }),
  find_local_trailer: () => null,

  // playback
  get_progress: (a): Progress | null => {
    const row = playback.get(num(a, 'fileId'));
    return row ? { position_secs: row.position, duration_secs: row.duration, completed: row.completed } : null;
  },
  save_progress: (a) => saveProgress(num(a, 'fileId'), num(a, 'positionSecs'), (a.durationSecs as number | null) ?? null),
  set_watched: (a) => {
    const id = num(a, 'fileId');
    if (a.watched) playback.set(id, { position: 0, duration: null, completed: true, updated: ++clock });
    else playback.delete(id);
    return null;
  },
  continue_watching: () => continueWatching(),
  next_episode: (a) => adjacent(num(a, 'fileId'), true),
  previous_episode: (a) => adjacent(num(a, 'fileId'), false),
  first_unwatched_episode: (a) => {
    const list = episodesOf(num(a, 'titleId'));
    const first = list.find((f) => !playback.get(f.id)?.completed) ?? list[0];
    return first ? episodeRef(first) : null;
  },
  get_title_prefs: (a) => prefs.get(num(a, 'titleId')) ?? { audio_lang: null, sub_lang: null, sub_enabled: true },
  set_title_prefs: (a) => {
    prefs.set(num(a, 'titleId'), a.prefs as TitlePrefs);
    return null;
  },
  get_skip_markers: (a) => files.find((f) => f.path === a.path)?.markers ?? null,

  // detection
  auto_detect: () => ({ steps: [] }),
  analysis_backlog: () => [[1, 0]],
  detect_intros: () => ({ ok: true, steps: [] }),
  ffmpeg_status: () => ({ resolved: 'ffmpeg', available: false }),

  // settings and logs
  get_setting: (a) => settings.get(String(a.key)) ?? null,
  set_setting: (a) => {
    settings.set(String(a.key), String(a.value));
    return null;
  },
  provider_status: () => [['tvmaze', true], ['omdb', false], ['tmdb', true]],
  // Deliberately silent: devlog forwards console.* here, so logging from this
  // handler would recurse.
  append_log: () => null,
  log_paths: () => ({ dir: 'C:\\fixture\\logs', mpv_log: 'C:\\fixture\\logs\\mpv.log' }),
  open_log_folder: () => null,
  selftest_plan: () => null,

  // plugins
  'plugin:event|listen': (a) => listen(String(a.event), Number(a.handler)),
  'plugin:event|unlisten': (a) => unlisten(String(a.event), Number(a.eventId)),
  'plugin:event|emit': (a) => emitEvent(String(a.event), a.payload),
  'plugin:libmpv|init': () => fakeMpv.init((path) => files.find((f) => f.path === path)?.duration ?? 1500),
  'plugin:libmpv|command': (a) => fakeMpv.command(String(a.name), (a.args as unknown[]) ?? []),
  'plugin:libmpv|get_property': (a) => fakeMpv.getProperty(String(a.name)),
  'plugin:libmpv|set_property': (a) => fakeMpv.setProperty(String(a.name), a.value),
  'plugin:window|is_fullscreen': () => false,
  'plugin:window|set_fullscreen': () => null,
  'plugin:window|show': () => null,
  'plugin:opener|open_url': () => null,
};

/**
 * Install the mock. Must run before anything calls `invoke`, which in
 * practice means before the first render.
 */
export function installMockBackend(): void {
  mockWindows('main');
  mockIPC(
    (cmd, payload) => {
      const handler = handlers[cmd];
      if (!handler) {
        // Loud, because a missing handler is exactly the kind of gap that
        // would otherwise look like the UI simply not doing anything.
        throw new Error(`mock backend: no handler for ${cmd}`);
      }
      return handler((payload ?? {}) as Args);
    },
  );
  fakeMpv.exposeFakeMpv();
  (window as unknown as { __kinemaMock: unknown }).__kinemaMock = {
    playback,
    settings,
    files,
    listenerCounts,
  };
  document.title = 'Kinema (mock backend)';
}
