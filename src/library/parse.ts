/**
 * Filename → structured guess, using guessit-js.
 *
 * The hard case this exists to solve is files that do NOT follow
 * `Show - S01E01.mkv`. A very common real-world shape is a junk filename
 * inside a well-named folder:
 *
 *     Blade Runner 2049 (2017)/1080p.BluRay.x264-GROUP.mkv
 *
 * Parsing the filename alone yields no usable title there, while the parent
 * directory has everything. So we parse both and pick the better result,
 * rather than trusting either blindly.
 *
 * Nothing here talks to TMDB. This stage only extracts what the *file* claims
 * to be; deciding which real title that corresponds to is the matching stage
 * (Phase 2), and keeping them separate means matching can be re-run and
 * improved without touching the filesystem again.
 */
import type { LibraryKind, MediaFile, ParseResultPayload } from './api';

/**
 * guessit-js, loaded on demand.
 *
 * It is ~390 kB of the bundle — the largest single thing in it — and it runs
 * only during a scan. Imported at module scope it was parsed at every launch,
 * on the startup path, for code that a browsing session may never touch.
 *
 * `parseMediaFile` stays **synchronous** so the batch `.map()` in `pipeline.ts`
 * does not have to become a sequence of awaits; callers load the module once up
 * front with `initParser`.
 */
type GuessitFn = typeof import('guessit-js').guessit;
let guessit: GuessitFn | null = null;

/**
 * Load the parser. Idempotent, and cheap after the first call — call it before
 * any batch rather than guarding every file.
 */
export async function initParser(): Promise<void> {
  if (guessit) return;
  guessit = (await import('guessit-js')).guessit;
}

/** Tokens that mean a "title" is really just release metadata. */
const TECHNICAL_TOKENS = new Set([
  'bluray',
  'blu-ray',
  'bdrip',
  'brrip',
  'dvdrip',
  'webrip',
  'web-dl',
  'webdl',
  'hdtv',
  'remux',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'xvid',
  'divx',
  '1080p',
  '720p',
  '2160p',
  '480p',
  '4k',
  'uhd',
  'hdr',
  'sdr',
  'dts',
  'ac3',
  'aac',
  'truehd',
  'atmos',
  'video',
  'movie',
  'film',
  'untitled',
]);

export interface Guess {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  kind: 'movie' | 'episode' | null;
  raw: Record<string, unknown>;
}

function firstOf<T>(value: T | T[] | undefined | null): T | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? (value.length > 0 ? value[0] : null) : value;
}

/** Last parser failure, surfaced in the UI instead of being swallowed. */
export let lastParseError: string | null = null;

export function clearParseError() {
  lastParseError = null;
}

function runGuessit(input: string, kind: LibraryKind): Guess {
  // A programming error, not a bad filename: some caller started parsing
  // without loading the parser. Thrown rather than folded into `lastParseError`
  // so it stops the run loudly instead of quietly recording every file as
  // unparseable, which looks identical to a library of unrecognisable names.
  if (!guessit) {
    throw new Error('parser not loaded — call initParser() before parseMediaFile()');
  }

  let raw: Record<string, unknown>;
  try {
    // The type hint matters: without it "Show 2019" is ambiguous between a
    // movie titled with a year and a series episode.
    raw = guessit(input, { type: kind === 'movies' ? 'movie' : 'episode' }) as Record<
      string,
      unknown
    >;
  } catch (e) {
    // Never swallow this silently — a parser that throws on every file looks
    // exactly like a parser that works and finds nothing.
    lastParseError = `${input}: ${e instanceof Error ? e.message : String(e)}`;
    return { title: null, year: null, season: null, episode: null, kind: null, raw: {} };
  }

  const title = firstOf(raw.title as string | string[] | undefined);
  const type = raw.type as string | undefined;

  return {
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    year: typeof raw.year === 'number' ? raw.year : null,
    season: typeof firstOf(raw.season) === 'number' ? (firstOf(raw.season) as number) : null,
    episode: typeof firstOf(raw.episode) === 'number' ? (firstOf(raw.episode) as number) : null,
    kind: type === 'movie' || type === 'episode' ? type : null,
    raw,
  };
}

/**
 * How much do we trust this guess? Used only to choose between the filename
 * and the parent directory — not as a match confidence.
 */
function scoreGuess(guess: Guess, kind: LibraryKind): number {
  if (!guess.title) return 0;

  const normalised = guess.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalised) return 0;

  // A "title" that is really a codec or resolution is worse than nothing,
  // because it would silently poison the TMDB query later.
  if (TECHNICAL_TOKENS.has(guess.title.toLowerCase().replace(/\s+/g, ''))) return 0;
  if (/^\d+$/.test(normalised)) return 0;

  let score = 1;
  if (guess.title.length >= 3) score += 1;
  if (guess.year) score += 2;

  if (kind === 'tv') {
    if (guess.season !== null) score += 2;
    if (guess.episode !== null) score += 2;
  }

  return score;
}

/** Directory name only, from a full path (handles Windows and UNC paths). */
function baseName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

export interface ParsedFile extends Guess {
  from: 'file' | 'parent';
  /** True when neither source produced anything usable — needs attention. */
  needsAttention: boolean;
}

export function parseMediaFile(file: MediaFile, kind: LibraryKind): ParsedFile {
  const fromFile = runGuessit(file.file_name, kind);
  const fileScore = scoreGuess(fromFile, kind);

  const parentName = baseName(file.parent_dir);
  const fromParent = runGuessit(parentName, kind);
  const parentScore = scoreGuess(fromParent, kind);

  // Prefer the filename on a tie: it is the more specific source, and for TV
  // it is usually the only thing carrying the episode number.
  const useParent = parentScore > fileScore;
  const chosen = useParent ? fromParent : fromFile;

  // Episode numbers live in the filename even when the title lives in the
  // folder, so merge rather than discarding one side entirely.
  const merged: Guess = {
    ...chosen,
    season: chosen.season ?? fromFile.season ?? fromParent.season,
    episode: chosen.episode ?? fromFile.episode ?? fromParent.episode,
    year: chosen.year ?? fromFile.year ?? fromParent.year,
  };

  return {
    ...merged,
    from: useParent ? 'parent' : 'file',
    needsAttention: Math.max(fileScore, parentScore) === 0,
  };
}

/**
 * Runs the parser against a known-good string in the *browser* environment.
 * guessit-js behaving correctly under Node proves nothing about WebView2.
 */
export async function selfTest(): Promise<string> {
  const sample = 'Example Show S01 - S01E01 - E01 GROUP.mp4';
  try {
    // Loading it is now part of what this tests: a dynamic import that fails in
    // WebView2 would look exactly like a parser that throws.
    await initParser();
    const raw = (guessit as GuessitFn)(sample, { type: 'episode' }) as Record<string, unknown>;
    return `OK — ${JSON.stringify(raw)}`;
  } catch (e) {
    return `THREW — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

export function toPayload(file: MediaFile, parsed: ParsedFile): ParseResultPayload {
  return {
    id: file.id,
    title: parsed.title,
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode,
    kind: parsed.kind,
    from: parsed.from,
    raw_json: JSON.stringify(parsed.raw),
  };
}
