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
 * player's controls can be driven keyboard-only in an ordinary browser,
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
import type { Episode, Studio, Title, TitleDetail } from '../ui/api';

// The setup this is ultimately for: a 4K HDR TV behind a receiver that takes
// everything, next to this dev machine's SDR monitor and onboard sound — plus a
// TV seen once and unplugged since. The receiver's answers are remembered, as
// they are when it is busy at launch; the monitor is new. Shaped exactly like
// equipment.rs's EquipmentView.
const SEEN_BEFORE = { connected: true, first_seen: 1789000000, last_seen: 1790270000, new: false };
const SEEN_NOW = { connected: true, first_seen: 1790270000, last_seen: 1790270000 };

function mockEquipment() {
  return {
    gpus: ['Mock GPU'],
    displays: [
      {
        ...SEEN_BEFORE,
        connected: false,
        last_seen: 1789500000,
        id: 'mock-old-tv',
        name: 'Mock old TV',
        gdi_name: '',
        connection: 'HDMI',
        width: 1920,
        height: 1080,
        refresh_num: 60,
        refresh_den: 1,
        hdr: 'unsupported',
        peak_nits: null,
        full_frame_nits: null,
        min_nits: null,
        bits_per_color: 8,
        modes: [],
        notes: [],
      },
      {
        ...SEEN_BEFORE,
        id: 'mock-tv',
        name: 'Mock 4K HDR TV',
        gdi_name: String.raw`\\.\DISPLAY1`,
        connection: 'HDMI',
        width: 3840,
        height: 2160,
        refresh_num: 60,
        refresh_den: 1,
        hdr: 'off',
        peak_nits: 800,
        full_frame_nits: 350,
        min_nits: 0.05,
        bits_per_color: 10,
        modes: [
          { width: 3840, height: 2160, hz: 60, rate: 60 },
          { width: 3840, height: 2160, hz: 23, rate: 23.976 },
          { width: 3840, height: 2160, hz: 24, rate: 24 },
        ],
        notes: [
          'Supports HDR, but Windows has it switched off, so HDR videos are converted to SDR on this screen until it is on.',
          'Can show movies without judder: 23.976 / 24 Hz at 3840×2160.',
        ],
      },
      {
        ...SEEN_NOW,
        new: true,
        id: 'mock-monitor',
        name: 'Mock SDR monitor',
        gdi_name: String.raw`\\.\DISPLAY2`,
        connection: 'DisplayPort',
        width: 2560,
        height: 1600,
        refresh_num: 59972,
        refresh_den: 1000,
        hdr: 'unsupported',
        peak_nits: null,
        full_frame_nits: null,
        min_nits: null,
        bits_per_color: 10,
        modes: [{ width: 2560, height: 1600, hz: 60, rate: 60 }],
        notes: [
          'SDR screen: HDR videos are converted to SDR.',
          'No 24 Hz mode: movies play with 3:2 judder on this screen, whatever the setting.',
        ],
      },
    ],
    audio: [
      {
        ...SEEN_BEFORE,
        name: 'Mock AV receiver (HDMI)',
        id: 'mock-avr',
        is_default: true,
        connection: 'HDMI',
        mix_channels: 2,
        mix_layout: 'stereo',
        mix_rate: 48000,
        max_pcm_channels: 8,
        spatial_objects: null,
        bitstream: [
          { codec: 'ac3', label: 'Dolby Digital', result: 'yes', detail: null, remembered: true },
          { codec: 'eac3', label: 'Dolby Digital Plus (incl. Atmos)', result: 'yes', detail: null, remembered: true },
          { codec: 'dts', label: 'DTS', result: 'yes', detail: null, remembered: true },
          { codec: 'dts-hd', label: 'DTS-HD Master Audio (incl. DTS:X)', result: 'yes', detail: null, remembered: true },
          { codec: 'truehd', label: 'Dolby TrueHD (incl. Atmos)', result: 'yes', detail: null, remembered: true },
        ],
        notes: [
          'Windows is set to stereo for this device, though it takes 8 channels directly. Anything mixed by Windows is folded down to stereo.',
        ],
      },
      {
        ...SEEN_BEFORE,
        name: 'Mock onboard speakers',
        id: 'mock-onboard',
        is_default: false,
        connection: 'speakers',
        mix_channels: 2,
        mix_layout: 'stereo',
        mix_rate: 48000,
        max_pcm_channels: 8,
        spatial_objects: null,
        bitstream: [
          ['ac3', 'Dolby Digital'],
          ['eac3', 'Dolby Digital Plus (incl. Atmos)'],
          ['dts', 'DTS'],
          ['dts-hd', 'DTS-HD Master Audio (incl. DTS:X)'],
          ['truehd', 'Dolby TrueHD (incl. Atmos)'],
        ].map(([codec, label]) => ({ codec, label, result: 'no', detail: null, remembered: false })),
        notes: ['Takes no compressed surround formats: everything has to be decoded.'],
      },
    ],
    problems: [],
    checked_at: 1790270000,
  };
}

/**
 * The same equipment as the Linux reader reports it (equipment/linux.rs):
 * there is no Windows mixer, so no mix layout, default or spatial sound, and
 * the notes about them are not made.
 */
function mockEquipmentOnLinux() {
  const e = mockEquipment();
  return {
    ...e,
    displays: e.displays.map((d) => ({
      ...d,
      gdi_name: d.id === 'mock-tv' ? 'HDMI-1' : d.gdi_name ? 'DP-1' : '',
      notes: d.notes.map((n) => n.replace('Windows has', 'the desktop has')),
    })),
    audio: e.audio.map((a) => ({
      ...a,
      id: `alsa/hdmi:CARD=Mock,DEV=${a.id === 'mock-avr' ? 0 : 1}`,
      is_default: false,
      mix_channels: 0,
      mix_layout: '',
      mix_rate: 0,
      notes: a.notes.filter((n) => !n.startsWith('Windows')),
    })),
  };
}

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
/** A second show with two seasons and a special the library lacks. */
const SAGA_ID = 3;

/** A title as stored; what watching has done to it is worked out per read. */
type StoredTitle = Omit<Title, 'episodes_owned' | 'episodes_watched' | 'watched' | 'progress' | 'cast'>;

/**
 * A studio logo drawn here rather than fetched — a coloured word on
 * transparency, as TMDB's are — so the badge's white-out can be seen offline.
 */
const logo = (text: string, colour: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${text.length * 34}" height="60"><text x="2" y="46" textLength="${text.length * 34 - 4}" lengthAdjust="spacingAndGlyphs" font-family="Georgia" font-size="46" font-weight="700" fill="${colour}">${text}</text></svg>`
  )}`;

/**
 * Studios per fixture title: the film has two with logos and one without, as
 * TMDB's lists usually go; the saga has a network; the show has none.
 */
const STUDIOS: Record<number, Studio[]> = {
  2: [
    { name: 'Example Pictures', logo_url: logo('EXAMPLE', '#1a4fb5'), logo_path: null },
    { name: 'Fixture Film Partnership', logo_url: null, logo_path: null },
    { name: 'Mock Bros.', logo_url: logo('MOCK', '#b51a1a'), logo_path: null },
  ],
  3: [{ name: 'Example Network', logo_url: logo('XNET', '#2a8f3a'), logo_path: null }],
};

/** Billed cast per fixture title, for searching by actor. */
const CAST: Record<number, string[]> = { 1: ['Pat Fixture', 'Sam Example'], 2: ['Ada Mock'] };

const titles: StoredTitle[] = [
  {
    id: SERIES_ID,
    kind: 'series',
    provider: 'tmdb',
    title: 'Example Show',
    year: 2001,
    overview: 'A fixture series: five episodes, each with a different kind of intro.',
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
    file_count: 5,
    added_at: 2,
  },
  {
    id: FILM_ID,
    kind: 'movie',
    // Found through Wikidata, the keyless fallback: its description carries
    // the Wikipedia credit on the detail page.
    provider: 'wikidata',
    title: 'Example Film',
    certification: 'R',
    imdb_rating: 7.4,
    imdb_votes: 81234,
    tomatometer: 88,
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
  {
    id: SAGA_ID,
    kind: 'series',
    provider: 'tmdb',
    title: 'Example Saga',
    certification: 'TV-MA',
    year: 2019,
    overview: 'A fixture series across two seasons, for the season list.',
    genres: JSON.stringify(['Drama']),
    runtime_mins: 50,
    poster_url: null,
    backdrop_url: null,
    poster_path: null,
    backdrop_path: null,
    logo_url: null,
    logo_path: null,
    trailer_key: null,
    trailer_site: null,
    rating: 8.4,
    file_count: 4,
    added_at: 0,
  },
];

/** Markers with every segment absent except those given. */
const marked = (over: Partial<SkipMarkers>): SkipMarkers => ({
  intro: null,
  intro_source: null,
  recap: null,
  recap_source: null,
  credits: null,
  credits_source: null,
  post_credits: null,
  post_credits_source: null,
  ...over,
});

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
    markers: marked({ ...intro(0.2, 45.6, 'skiptro-db'), credits: { start: 1430, end: null }, credits_source: 'analysis' }),
  },
  // A cold open: ten seconds of story before the intro.
  {
    id: 102,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E02.mkv',
    season: 1,
    episode: 2,
    duration: 1500,
    markers: marked({ ...intro(10.0, 46.0, 'analysis'), credits: { start: 1428, end: null }, credits_source: 'analysis' }),
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
    markers: marked({ ...intro(0, 44, 'analysis'), credits: { start: 1330, end: null }, credits_source: 'analysis' }),
  },
  // No markers from any source, with a next episode: the credits here can only
  // be the tail guess, which may offer but never decide.
  {
    id: 104,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E04.mkv',
    season: 1,
    episode: 4,
    duration: 1500,
    markers: null,
  },
  // Last in the season, so nothing follows it and no guess is made.
  {
    id: 105,
    titleId: SERIES_ID,
    path: 'C:\\fixture\\Example Show\\Season 1\\Example.Show.S01E05.mkv',
    season: 1,
    episode: 5,
    duration: 1500,
    markers: null,
  },
  {
    id: 201,
    titleId: FILM_ID,
    path: 'C:\\fixture\\Example Film (2017)\\Example.Film.2017.IMAX.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-GRP.mkv',
    season: null,
    episode: null,
    duration: 6000,
    // Credits from TheIntroDB and a scene after them from IntroDB.app: the
    // credits skip becomes "Skip to the scene after the credits".
    markers: marked({
      credits: { start: 5600, end: null },
      credits_source: 'introdb',
      post_credits: { start: 5880, end: 5940 },
      post_credits_source: 'introdb-app',
    }),
  },
  ...[
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
  ].map(([season, episode], i) => ({
    id: 301 + i,
    titleId: SAGA_ID,
    // Season 1 a Netflix download, season 2 an Amazon one — a show whose
    // seasons differ, for the season badges.
    path: `C:\\fixture\\Example.Saga.S0${season}.1080p.${season === 1 ? 'NF.WEB-DL' : 'AMZN.WEBRip'}.DDP5.1.Atmos.H.265-GRP\\Season ${season}\\Example.Saga.S0${season}E0${episode}.mkv`,
    season,
    episode,
    duration: 3000,
    // The first episode opens on a recap and then the intro: two presses,
    // "Skip recap" and then "Skip intro".
    markers:
      i === 0
        ? marked({
            recap: { start: 0, end: 40 },
            recap_source: 'introdb',
            ...intro(40, 70, 'introdb-app'),
          })
        : null,
  })),
];

/**
 * What the scan would have read from a fixture file (`probe.rs`, `aspect.rs`),
 * for the detail page's badges: the film as a 4K Dolby Vision profile 7 FEL
 * remux with IMAX scenes, the saga as 1080p web episodes, the show unread —
 * as a library without ffprobe would be.
 */
function mockFileFacts(fileId: number) {
  const file = files.find((f) => f.id === fileId);
  if (!file) return null;
  const cut = file.path.lastIndexOf('\\');
  const names = {
    file_name: file.path.slice(cut + 1),
    parent_dir: file.path.slice(0, cut),
    extension: file.path.split('.').pop() ?? '',
    root_path: 'C:\\fixture',
    folder_shared: false,
  };
  const audio = (codec: string, profile: string | null, layout: string, commentary = false) => ({
    codec,
    profile,
    channels: null,
    layout,
    language: 'eng',
    title: commentary ? 'Commentary' : null,
    default: !commentary,
    commentary,
  });
  const subtitle = (language: string, sdh = false) => ({
    codec: 'hdmv_pgs_subtitle',
    language,
    title: sdh ? 'SDH' : null,
    default: false,
    forced: false,
    hearing_impaired: sdh,
  });
  const video = {
    stream_index: 0,
    codec: 'hevc',
    profile: 'Main 10',
    bit_depth: 10,
    frame_rate: 24000 / 1001,
    interlaced: false,
    hdr10_plus: false,
    max_cll: null,
    max_fall: null,
  };

  if (file.titleId === FILM_ID) {
    return {
      ...names,
      details: {
        container: 'matroska,webm',
        duration_secs: file.duration,
        bit_rate: 58_400_000,
        video: {
          ...video,
          width: 3840,
          height: 2160,
          aspect_ratio: 16 / 9,
          transfer: 'pq',
          dolby_vision: { profile: 7, level: 6, compatibility: 6, enhancement_layer: 'FEL' },
          mastering_peak_nits: 1000,
        },
        audio: [
          audio('truehd', 'Dolby TrueHD + Dolby Atmos', '7.1'),
          audio('dts', 'DTS-HD MA', '7.1'),
          audio('ac3', null, '5.1(side)', true),
        ],
        subtitles: [subtitle('eng', true), subtitle('eng'), subtitle('nor'), subtitle('swe')],
      },
      picture_aspect: 2.39,
      picture_aspect_alt: 1.9,
    };
  }
  if (file.titleId === SAGA_ID) {
    return {
      ...names,
      details: {
        container: 'matroska,webm',
        duration_secs: file.duration,
        bit_rate: file.season === 2 ? 9_400_000 : 6_200_000,
        video: {
          ...video,
          // S02E02 is the one 720p episode of its season.
          width: file.season === 2 && file.episode === 2 ? 1280 : 1920,
          height: file.season === 2 && file.episode === 2 ? 720 : 1080,
          aspect_ratio: 16 / 9,
          transfer: 'sdr',
          dolby_vision: null,
          mastering_peak_nits: null,
        },
        audio: [audio('eac3', 'Dolby Digital Plus + Dolby Atmos', '5.1(side)')],
        subtitles: [subtitle('eng')],
      },
      picture_aspect: 16 / 9,
      picture_aspect_alt: null,
    };
  }
  return { ...names, details: null, picture_aspect: null, picture_aspect_alt: null };
}

/** Episodes the provider lists that the library does not hold. */
const MISSING = [{ titleId: SAGA_ID, season: 0, episode: 1, name: 'Behind the scenes' }];

const playback = new Map<number, { position: number; duration: number | null; completed: boolean; updated: number }>();
const prefs = new Map<number, TitlePrefs>();
const dismissed = new Map<number, number>();
const settings = new Map<string, string>([['tmdb_api_key', 'fixture']]);
let clock = 1000;

const fileById = (id: number) => files.find((f) => f.id === id) ?? null;
const titleById = (id: number) => titles.find((t) => t.id === id) ?? null;

/** Same rules as TITLE_SELECT in metadata.rs. */
function withWatchState(title: StoredTitle): Title {
  const own = files.filter((f) => f.titleId === title.id);
  const done = own.filter((f) => playback.get(f.id)?.completed);
  if (title.kind === 'series') {
    const owned = own.filter((f) => f.season !== null).length;
    const watchedEps = done.filter((f) => f.season !== null).length;
    return {
      ...title,
      episodes_owned: owned,
      episodes_watched: watchedEps,
      watched: owned > 0 && watchedEps >= owned,
      progress: null,
      cast: CAST[title.id] ?? [],
    };
  }
  const started = own
    .map((f) => playback.get(f.id))
    .filter((row) => row && !row.completed && row.duration)
    .sort((a, b) => b!.updated - a!.updated)[0];
  return {
    ...title,
    episodes_owned: 0,
    episodes_watched: 0,
    watched: done.length > 0,
    progress: started ? started.position / (started.duration as number) : null,
    cast: CAST[title.id] ?? [],
  };
}

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

/** Same rule as `is_complete` in playback.rs: 94%, or inside known credits. */
function saveProgress(
  fileId: number,
  position: number,
  duration: number | null,
  creditsStart: number | null
): null {
  const inCredits =
    duration !== null &&
    creditsStart !== null &&
    creditsStart >= duration * 0.5 &&
    creditsStart < duration &&
    position >= creditsStart;
  const completed =
    duration !== null && duration > 0 && (position / duration >= 0.94 || inCredits);
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
  return items
    .filter((item) => !(dismissed.has(item.title_id) && item.updated_at <= dismissed.get(item.title_id)!))
    .sort((a, b) => b.updated_at - a.updated_at);
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
  for (const gap of MISSING.filter((m) => m.titleId === titleId)) {
    episodes.push({
      id: 9000 + gap.season * 100 + gap.episode,
      season: gap.season,
      episode: gap.episode,
      name: gap.name,
      overview: 'Listed by the provider, not in the library.',
      air_date: null,
      runtime_mins: 20,
      still_url: null,
      still_path: null,
      file_path: null,
      file_id: null,
      watched: false,
      position_secs: null,
      duration_secs: null,
    });
  }
  const movie = title.kind === 'movie' ? files.find((f) => f.titleId === titleId) : undefined;
  return {
    title: withWatchState(title),
    episodes,
    cast: [],
    studios: STUDIOS[titleId] ?? [],
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

// ---- switches for a check -------------------------------------------------

/**
 * Read once at load from `localStorage`, so they survive the reload a check
 * needs: `kinemaMockSlowMs` delays the library read (a real first read is not
 * instant), `kinemaMockEmpty` presents an empty library (a first run) until a
 * folder is added and scanned,
 * `kinemaMockSlowDetect` makes the scan's detection pass take 20 seconds,
 * `kinemaMockSystem=linux` answers `capabilities` and the equipment check as
 * the Linux build does on a typical desktop (the check, direct sound, sleep
 * and shut down, but no screen switching), `kinemaMockSystem=android` as the
 * Android build does (no window, none of the equipment features yet; the fake
 * mpv still plays),
 * `kinemaMockNoPower=1` is a system
 * that will not sleep or shut down from Kinema, `kinemaMockScreenHdr=on`
 * reports the screen in HDR (for the output check; the picture itself is the
 * fake mpv's `extra`), `kinemaMockSkiptro=1` has Skiptro's database on this PC.
 */
function flag(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}
const SLOW_MS = Number(flag('kinemaMockSlowMs') ?? 0) || 0;
const EMPTY = flag('kinemaMockEmpty') === '1';
const SLOW_DETECT = flag('kinemaMockSlowDetect') === '1';
const ON_LINUX = flag('kinemaMockSystem') === 'linux';
const ON_ANDROID = flag('kinemaMockSystem') === 'android';
const SCREEN_HDR = flag('kinemaMockScreenHdr') === 'on';
const NO_POWER = flag('kinemaMockNoPower') === '1';
/** `kinemaMockSkiptro=1`: Skiptro's database is on this PC. */
const SKIPTRO = flag('kinemaMockSkiptro') === '1';
/** Under `kinemaMockEmpty`: whether a folder has been added, then scanned,
 * and which (the picker's, or the one chosen in Kinema's own browser). */
const emptyLibrary = { hasRoot: !EMPTY, scanned: false, path: 'C:\\fixture' };

/**
 * Android's drives for Kinema's own folder browser (`kinemaMockSystem=android`):
 * a USB drive with films and a show, and the device's own storage. Android's
 * permission is not yet given, and is given when asked for, unless
 * `kinemaMockStorageRefused=1`; All files access is off until allowed.
 */
const STORAGE_REFUSED = flag('kinemaMockStorageRefused') === '1';
const storage = { read: 'prompt', allFiles: 'off', asked: 0 };
const mockDrives: Record<string, { folders: string[]; videos: number }> = {
  '/storage/1A2B-3C4D': { folders: ['Films', 'Photos', 'TV'], videos: 0 },
  '/storage/1A2B-3C4D/Films': { folders: ['A film (2001)', 'Another film (2003)'], videos: 0 },
  '/storage/1A2B-3C4D/Films/A film (2001)': { folders: [], videos: 1 },
  '/storage/1A2B-3C4D/Films/Another film (2003)': { folders: [], videos: 1 },
  '/storage/1A2B-3C4D/Photos': { folders: [], videos: 0 },
  '/storage/1A2B-3C4D/TV': { folders: ['Example Show'], videos: 0 },
  '/storage/1A2B-3C4D/TV/Example Show': { folders: ['Season 1'], videos: 0 },
  '/storage/1A2B-3C4D/TV/Example Show/Season 1': { folders: [], videos: 3 },
  '/storage/emulated/0': { folders: ['Download', 'Movies'], videos: 0 },
  '/storage/emulated/0/Download': { folders: [], videos: 0 },
  '/storage/emulated/0/Movies': { folders: [], videos: 0 },
};
/** `kinemaMockReview` pretends that many videos wait in the review queue. */
const REVIEW_COUNT = Number(flag('kinemaMockReview') ?? 0) || 0;
/** `kinemaMockUpdate` pretends that version is out on GitHub. */
const UPDATE = flag('kinemaMockUpdate');
/**
 * `kinemaMockDetectSteps`, a JSON list of report steps, stands in for what the
 * scan's detection pass said — three TV folders with nothing new, say.
 */
const DETECT_STEPS: unknown[] = (() => {
  try {
    return JSON.parse(flag('kinemaMockDetectSteps') ?? '[]') as unknown[];
  } catch {
    return [];
  }
})();

const later = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => window.setTimeout(() => resolve(value), SLOW_MS));

/**
 * A detection that takes a while and can be stopped, so the Detect and Stop
 * buttons can be driven: one progress line a second for eight seconds.
 */
const mockDetection = (() => {
  let finish: ((stopped: boolean) => void) | null = null;
  return {
    run(seconds = 8): Promise<{ ok: boolean; stopped: boolean; steps: [] }> {
      return new Promise((resolve) => {
        let n = 0;
        const timer = window.setInterval(() => {
          n += 1;
          emitEvent('skiptro-progress', { step: 'analyse', line: `reading ${n} of ${seconds}` });
          if (n >= seconds) finish?.(false);
        }, 1000);
        finish = (stopped) => {
          window.clearInterval(timer);
          finish = null;
          resolve({ ok: !stopped, stopped, steps: [] });
        };
      });
    },
    stop(): null {
      finish?.(true);
      return null;
    },
  };
})();

// ---- the command table ----------------------------------------------------

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/**
 * Stand-in SIMKL and Trakt: a sign-in is approved on the third poll, as if
 * someone had typed the code on their phone in between. Nothing leaves the
 * page.
 */
const accounts = {
  simkl: { connected: false, polls: 0, pending: false, user: 'example-user', code: 'BDWP-HQPK', page: 'https://simkl.com/pin' },
  trakt: { connected: false, polls: 0, pending: false, user: 'example-trakt', code: '5055CC52', page: 'https://trakt.tv/activate' },
};

/** The stand-in OpenSubtitles account: none, and the free allowance. */
const openSubs: { user: string | null; remaining: number } = { user: null, remaining: 5 };

/** A small checkerboard in place of a QR code; the layout is what is tested. */
const MOCK_QR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#fff"/>' +
  '<path d="M0 0h4v4H0zM4 4h4v4H4z"/></svg>';

const num = (args: Args, key: string) => Number(args[key]);

let mockFullscreen = false;

const handlers: Record<string, Handler> = {
  // library
  // An empty library has no folder until one is added; its first scan then
  // finds the fixture, as a real first run would.
  list_library_roots: () =>
    emptyLibrary.hasRoot
      ? [{ id: 1, path: emptyLibrary.path, kind: 'tv', file_count: files.length }]
      : [],
  scan_library: () => {
    if (emptyLibrary.hasRoot) emptyLibrary.scanned = true;
    return {
      roots_scanned: 1, files_seen: files.length, files_added: 0, files_updated: 0,
      files_unchanged: files.length, files_missing: 0, errors: [], duration_ms: 5,
    };
  },
  list_unparsed: () => [],
  save_parse_results: () => 0,
  library_stats: () => ({ total: files.length, unparsed: 0, parsed: 0, missing: 0, total_bytes: 0 }),
  add_library_root: (a) => {
    emptyLibrary.hasRoot = true;
    emptyLibrary.path = String(a.path ?? emptyLibrary.path);
    return 1;
  },
  remove_library_root: () => null,
  list_media_files: () => [],

  // metadata
  list_titles: () => later(EMPTY && !emptyLibrary.scanned ? [] : titles.map(withWatchState)),
  get_title_detail: (a) => titleDetail(num(a, 'titleId')),
  file_facts: (a) => mockFileFacts(num(a, 'fileId')),
  season_facts: (a) =>
    episodesOf(num(a, 'titleId'))
      .filter((f) => f.season === num(a, 'season'))
      .map((f) => ({ file_id: f.id, ...mockFileFacts(f.id) })),
  list_unmatched: () => [],
  list_needs_review: () => [],
  count_needs_review: () => REVIEW_COUNT,
  latest_release: () =>
    UPDATE ? { version: UPDATE, url: 'https://github.com/Basswaves/kinema/releases' } : null,
  list_titles_needing_detail: () => [],
  list_stale_titles: () => [],
  list_wikidata_films: () => [],
  adopt_provider: () => false,
  cache_artwork: () => ({ stored: 0, failed: 0 }),
  artwork_stats: () => ({ files: 0, bytes: 0, failed: 0 }),
  find_local_trailer: () => null,

  // playback
  get_progress: (a): Progress | null => {
    const row = playback.get(num(a, 'fileId'));
    return row ? { position_secs: row.position, duration_secs: row.duration, completed: row.completed } : null;
  },
  save_progress: (a) =>
    saveProgress(
      num(a, 'fileId'),
      num(a, 'positionSecs'),
      (a.durationSecs as number | null) ?? null,
      (a.creditsStart as number | null) ?? null
    ),
  set_watched: (a) => {
    const id = num(a, 'fileId');
    if (a.watched) playback.set(id, { position: 0, duration: null, completed: true, updated: ++clock });
    else playback.delete(id);
    return null;
  },
  continue_watching: () => continueWatching(),
  dismiss_continue: (a) => {
    dismissed.set(num(a, 'titleId'), ++clock);
    return null;
  },
  next_episode: (a) => adjacent(num(a, 'fileId'), true),
  previous_episode: (a) => adjacent(num(a, 'fileId'), false),
  first_unwatched_episode: (a) => {
    const list = episodesOf(num(a, 'titleId'));
    const first = list.find((f) => !playback.get(f.id)?.completed) ?? list[0];
    return first ? episodeRef(first) : null;
  },
  get_title_prefs: (a) =>
    prefs.get(num(a, 'titleId')) ?? { audio_lang: null, sub_lang: null, sub_enabled: true, chosen: false },
  set_title_prefs: (a) => {
    prefs.set(num(a, 'titleId'), { ...(a.prefs as TitlePrefs), chosen: true });
    return null;
  },
  get_skip_markers: (a) => files.find((f) => f.path === a.path)?.markers ?? null,

  // detection
  // Instant unless `kinemaMockSlowDetect` is set, so the scan's own pass can
  // be caught running and stopped from the Scan button.
  auto_detect: () =>
    SLOW_DETECT
      ? mockDetection.run(20).then((r) =>
          r.stopped
            ? { steps: [{ root_path: '', step: 'detect', ran: false, note: 'you stopped detection; the rest is picked up by the next scan' }] }
            : { steps: DETECT_STEPS }
        )
      : { steps: DETECT_STEPS },
  analysis_backlog: () => [[1, 0]],
  detect_intros: () => mockDetection.run(),
  stop_detection: () => mockDetection.stop(),

  // Windows' answers unless `kinemaMockSystem` is `linux`, which answers as
  // the Linux build does on a typical desktop: the equipment check, direct
  // sound, sleep and shut down (logind), and no screen switching — the mock
  // stands for a desktop Kinema cannot ask. `kinemaMockNoPower` is a system
  // whose logind will not, or is missing (capabilities.rs, power.rs).
  capabilities: () => {
    if (ON_ANDROID) {
      return {
        system: 'Android',
        // The fake mpv stands in for Media3, which the mock does not have.
        engine: 'mpv',
        mpv_video: { gpu_api: 'auto', hwdec: 'auto-safe', own_window: false },
        equipment_detection: false,
        audio_direct: false,
        display_switching: false,
        windowed: false,
        folder_picker: false,
        system_output: true,
        runs_programs: false,
        screen_keyboard: true,
        sleep: false,
        shut_down: false,
      };
    }
    const full = !ON_LINUX;
    return {
      system: full ? 'Windows' : 'Linux',
      engine: 'mpv',
      mpv_video: full
        ? { gpu_api: 'd3d11', hwdec: 'd3d11va', own_window: false }
        : { gpu_api: 'auto', hwdec: 'auto-safe', own_window: true },
      equipment_detection: true,
      audio_direct: true,
      display_switching: full,
      windowed: true,
      folder_picker: true,
      system_output: false,
      runs_programs: true,
      screen_keyboard: false,
      sleep: !NO_POWER,
      shut_down: !NO_POWER,
    };
  },

  // Leaving from the sofa. Recorded, never done: `window.__powerActions` is
  // what a check reads, and `kinemaMockPowerFail` makes Windows refuse.
  power_action: (a) => {
    const w = window as unknown as { __powerActions?: unknown[] };
    (w.__powerActions ??= []).push(a.action);
    if (flag('kinemaMockPowerFail') === '1') throw new Error('Windows would not go to sleep');
    return null;
  },
  ffmpeg_status: () => ({ resolved: 'ffmpeg', available: false }),
  skiptro_found: () => SKIPTRO,
  probe_library: () => ({ read: 0, failed: 0, unavailable: true }),
  measure_pictures: () => ({ measured: 0, unavailable: true }),
  refresh_imdb_ratings: () => ({ fetched: false, rated: 0 }),
  list_titles_needing_scores: () => [],
  save_omdb_scores: () => null,
  // Asking the sound server to let go of a card (Linux, audio_reserve.rs):
  // recorded for a check to read, never more.
  reserve_audio_device: (a) => {
    const w = window as unknown as { __reserved?: unknown[] };
    (w.__reserved ??= []).push(a.device);
    return `${String(a.device)}: the card was free`;
  },
  release_audio_device: () => {
    const w = window as unknown as { __reserved?: unknown[] };
    (w.__reserved ??= []).push('released');
    return null;
  },
  get_equipment: () => (ON_LINUX ? mockEquipmentOnLinux() : mockEquipment()),
  check_equipment: () => (ON_LINUX ? mockEquipmentOnLinux() : mockEquipment()),
  window_display: () => ({ gdi_name: '', hdr: 'unknown' }),
  // The mock TV, by the name its equipment entry carries: the screen the
  // picture is on, as "only these" looks it up.
  screen_now: () => ({
    gdi_name: ON_LINUX ? 'HDMI-1' : String.raw`\\.\DISPLAY1`,
    width: 3840,
    height: 2160,
    hz: 60,
    rate: 60,
    hdr: SCREEN_HDR ? 'on' : 'off',
    modes: [
      { width: 3840, height: 2160, hz: 60, rate: 60 },
      { width: 3840, height: 2160, hz: 23, rate: 23.976 },
    ],
  }),
  switch_screen: () => null,
  restore_screen: () => false,
  player_window: () => null,

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
  open_backup_folder: () => null,
  list_backups: () => [
    { name: 'library-auto-v18-1790600000.db', kind: 'weekly', made_at: 1790600000, bytes: 4200000 },
    { name: 'library-v13-1790000000.db', kind: 'before_upgrade', made_at: 1790000000, bytes: 327680 },
  ],
  restore_backup: () => null,
  selftest_plan: () => null,

  // OpenSubtitles (opensubtitles.rs): a stand-in that finds English and
  // Norwegian subtitles for anything, and nothing forced.
  opensubtitles_status: () => ({
    available: true,
    user: openSubs.user,
    remaining: openSubs.remaining,
    reset: null,
    auto_forced: settings.get('opensubtitles_forced') === 'on',
  }),
  opensubtitles_sign_in: (a) => {
    if (String(a.password) !== 'test') throw new Error('The OpenSubtitles username or password is wrong.');
    openSubs.user = String(a.username);
    openSubs.remaining = 20;
    return null;
  },
  opensubtitles_sign_out: () => {
    openSubs.user = null;
    openSubs.remaining = 5;
    return null;
  },
  find_subtitles: (a) => {
    const lang = String(a.language);
    if (lang !== 'en' && lang !== 'no') return null;
    openSubs.remaining -= 1;
    const offers = [1, 2, 3].map((n) => ({
      file_id: n * 10 + (lang === 'no' ? 1 : 0),
      language: lang,
      release: `Example.Release.${n}.1080p.WEB-DL`,
      downloads: 1000 - n,
      matches_file: n === 1,
      hearing_impaired: n === 3,
      forced: false,
      translated: false,
      trusted: n === 1,
    }));
    return { path: `C:\\fixture\\subs\\${offers[0].file_id}.srt`, chosen: offers[0], offers };
  },
  fetch_subtitle: (a) => {
    openSubs.remaining -= 1;
    return `C:\\fixture\\subs\\${String(a.offerFileId)}.srt`;
  },
  forced_subtitle: () => null,

  // SIMKL and Trakt (simkl.rs, trakt.rs), with the stand-ins above
  ...Object.fromEntries(
    (['simkl', 'trakt'] as const).flatMap((service) => {
      const a = accounts[service];
      return [
        [
          `${service}_status`,
          () => ({
            available: true,
            connected: a.connected,
            needs_reconnect: false,
            user: a.connected ? a.user : null,
            waiting: 0,
            last_sent_at: a.connected ? 1790700000 : null,
          }),
        ],
        [
          `${service}_start_connect`,
          () => {
            a.polls = 0;
            a.pending = true;
            return {
              user_code: a.code,
              verification_uri: a.page,
              verification_uri_complete: a.page,
              expires_in: 900,
              qr_svg: MOCK_QR,
            };
          },
        ],
        [
          `${service}_poll_connect`,
          () => {
            if (!a.pending) return 'expired';
            a.polls += 1;
            if (a.polls < 3) return 'waiting';
            a.pending = false;
            a.connected = true;
            return 'connected';
          },
        ],
        [
          `${service}_cancel_connect`,
          () => {
            a.pending = false;
            return null;
          },
        ],
        [
          `${service}_disconnect`,
          () => {
            a.connected = false;
            return null;
          },
        ],
      ] as [string, Handler][];
    })
  ),

  // plugins
  'plugin:event|listen': (a) => listen(String(a.event), Number(a.handler)),
  'plugin:event|unlisten': (a) => unlisten(String(a.event), Number(a.eventId)),
  'plugin:event|emit': (a) => emitEvent(String(a.event), a.payload),
  'plugin:libmpv|init': () => fakeMpv.init((path) => files.find((f) => f.path === path)?.duration ?? 1500),
  'plugin:libmpv|command': (a) => fakeMpv.command(String(a.name), (a.args as unknown[]) ?? []),
  'plugin:libmpv|get_property': (a) => fakeMpv.getProperty(String(a.name)),
  'plugin:libmpv|set_property': (a) => fakeMpv.setProperty(String(a.name), a.value),
  // Remembered, so a check can ask whether TV mode really filled the screen.
  'plugin:window|is_fullscreen': () => mockFullscreen,
  'plugin:window|set_fullscreen': (a) => {
    mockFullscreen = Boolean(a.value);
    return null;
  },
  'plugin:window|show': () => null,
  // An Android box with nothing that opens web pages: the opener refuses,
  // as Android's does (links.ts shows the address instead).
  'plugin:opener|open_url': () => {
    if (ON_ANDROID) throw new Error('No Activity found to handle Intent');
    return null;
  },
  link_qr: () => MOCK_QR,
  // The folder picker answers at once, with the fixture's folder.
  'plugin:dialog|open': () => 'C:\\fixture',
  // What an Android TV box says its TV and receiver take (Media3Plugin.kt
  // `output`): HDR10 and HLG, two surround formats, and a last film whose
  // sound the box decoded after all, as an operator box was found doing.
  'plugin:media3|output': () => ({
    hdr: ['HDR10', 'HLG'],
    sound: ['Dolby Digital', 'DTS'],
    modes: 4,
    lastSound: { format: 'DTS-HD 5.1', way: 'decoded' },
  }),
  // Kinema's own folder browser, on Android (places.rs, StoragePlugin.kt).
  'plugin:storage|places': () => ({
    places: [
      { path: '/storage/1A2B-3C4D', name: 'USB drive', removable: true },
      { path: '/storage/emulated/0', name: 'Internal shared storage', removable: false },
    ],
  }),
  'plugin:storage|access': () => ({ read: storage.read, allFiles: storage.allFiles }),
  'plugin:storage|request_access': () => {
    storage.asked += 1;
    if (!STORAGE_REFUSED) storage.read = 'granted';
    return { read: storage.read, allFiles: storage.allFiles };
  },
  'plugin:storage|allow_all_files': () => {
    storage.allFiles = 'granted';
    return { read: storage.read, allFiles: storage.allFiles };
  },
  list_folders: (a) => {
    const listing = mockDrives[String(a.path)];
    if (!listing) throw new Error(`could not read ${String(a.path)}`);
    return listing;
  },
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
    storage,
  };
  document.title = 'Kinema (mock backend)';
}
