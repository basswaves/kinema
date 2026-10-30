/**
 * Saying a track in words, and finding one by language. The tracks themselves
 * are read and chosen through the engine (engine.ts), in Kinema's terms.
 */
import type { Track } from './engine';
import { canonicalLang, languageName, sameLanguage } from './language';

/** Codec names as they are printed on a disc box. */
const AUDIO_CODECS: Record<string, string> = {
  truehd: 'Dolby TrueHD',
  eac3: 'Dolby Digital Plus',
  ac3: 'Dolby Digital',
  dts: 'DTS',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  mp2: 'MP2',
  alac: 'ALAC',
};

/** What FFmpeg's DTS profiles are called on the box. */
const DTS_PROFILES: [RegExp, string][] = [
  [/DTS:X/i, 'DTS:X'],
  [/HD MA/i, 'DTS-HD Master Audio'],
  [/HD HRA/i, 'DTS-HD High Resolution'],
  // Media3 says only "HD", not which (Media3Plugin.kt).
  [/^DTS-HD$/i, 'DTS-HD'],
  [/Express/i, 'DTS Express'],
  [/ES/, 'DTS-ES'],
];

function audioFormat(track: Track): string | null {
  const codec = track.codec?.toLowerCase();
  if (!codec) return null;
  if (codec.startsWith('pcm')) return 'PCM';
  let name = AUDIO_CODECS[codec] ?? codec.toUpperCase();
  if (codec === 'dts' && track.profile) {
    name = DTS_PROFILES.find(([pattern]) => pattern.test(track.profile as string))?.[1] ?? name;
  }
  if (track.profile && /atmos/i.test(track.profile)) name += ' Atmos';
  return name;
}

function channelLayout(channels: number | undefined): string | null {
  if (!channels) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} channels`;
}

/**
 * Words a track title often repeats from what is already on the line — the
 * language, the codec, the channels. A title made only of these adds nothing;
 * one with anything else ("Commentary with the director", "Signs & songs") is
 * the most useful thing on the line and is kept.
 */
const REDUNDANT = new Set(
  (
    'audio track sub subs subtitle subtitles full dolby digital plus truehd atmos dts hd ma ' +
    'master hra x es aac ac3 eac3 dd ddp flac opus pcm lpcm mp3 stereo mono surround channel ' +
    'channels ch kbps khz bit 1 2 0 5 6 7 8 1 51 71 20 srt ass ssa pgs sup vobsub default original ' +
    'forced sdh cc'
  ).split(' ')
);

function informativeTitle(track: Track): string | null {
  const title = track.title?.trim();
  if (!title) return null;
  const language = languageName(track.lang)?.toLowerCase() ?? '';
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9æøåäöüéèáàíóúñç]+/)
    .filter((w) => w.length > 0);
  const extra = words.filter((w) => !REDUNDANT.has(w) && !language.split(' ').includes(w));
  return extra.length > 0 ? title : null;
}

/**
 * A subtitle's format, the short word a release names it by (round 5, T28):
 * from the file, as the badges are. The same names on Android, where
 * Media3Plugin.kt turns its MIME types into FFmpeg's.
 */
const SUBTITLE_FORMATS: Record<string, string> = {
  subrip: 'SRT',
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  mov_text: 'MP4 text',
  ttml: 'TTML',
};

export function subtitleFormat(track: Track): string | null {
  const codec = track.codec?.toLowerCase();
  return codec ? (SUBTITLE_FORMATS[codec] ?? null) : null;
}

/** The file a separate subtitle came from, without its folder. */
function externalName(track: Track): string | null {
  const path = track.externalFilename;
  return path ? (path.split(/[\\/]/).pop() ?? path) : null;
}

/** Tags in a subtitle's name that are not its language. */
// Not `hi`: that is Hindi, as subtitle_files.rs reads it.
const NAME_FLAGS = new Set(['forced', 'sdh', 'cc', 'default', 'full', 'sub', 'subs']);

let namedLanguages: Map<string, string> | null = null;

/**
 * A language as a name spells it out — `English`, `Norsk`, `Deutsch` — to
 * its code: every two-letter language, by its English name and its own.
 * Built once, the first time a name is not a code.
 */
function languageFromName(word: string): string | null {
  if (!namedLanguages) {
    const found = new Map<string, string>();
    try {
      const english = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (const a of letters) {
        for (const b of letters) {
          const code = a + b;
          const name = english.of(code);
          if (!name) continue;
          found.set(name.toLowerCase(), code);
          try {
            const own = new Intl.DisplayNames([code], { type: 'language', fallback: 'none' }).of(code);
            if (own && !found.has(own.toLowerCase())) found.set(own.toLowerCase(), code);
          } catch {
            // No name of its own in this engine.
          }
        }
      }
    } catch {
      // No language names at all: only codes are read.
    }
    namedLanguages = found;
  }
  return namedLanguages.get(word.toLowerCase()) ?? null;
}

/**
 * The language a subtitle file's own name gives — `Film.en.srt`,
 * `Film.no.forced.srt`, `Film.English.srt`, `Film.pt-BR.srt` — or null.
 * Only the last tag set off by dots counts, once the flags (`forced`, `sdh`)
 * are passed: a word further in is the film's title, not a language. Never
 * guessed from anything else (Kinema never lies).
 */
export function languageFromFileName(name: string): string | null {
  for (const part of name.split('.').slice(1, -1).reverse()) {
    const word = part.trim().toLowerCase();
    if (NAME_FLAGS.has(word)) continue;
    if (/^[a-z]{2,3}(-[a-z]{2})?$/.test(word)) {
      const code = canonicalLang(word);
      return code && languageName(code) !== code.toUpperCase() ? word : null;
    }
    return /^\p{L}{4,}$/u.test(word) ? languageFromName(word) : null;
  }
  return null;
}

/**
 * The track's language: as the engine says it, or, for a separate file with
 * none, as the file's name tags it (round 5, T29) — mpv reads only short
 * codes from a name, so `Film.English.srt` came through with none.
 */
export function trackLanguage(track: Track): string | undefined {
  if (track.lang) return track.lang;
  const name = track.external ? externalName(track) : null;
  return (name && languageFromFileName(name)) || undefined;
}

/**
 * A line a person reads: "English · 7.1 · Dolby TrueHD Atmos",
 * "Norwegian · Forced · PGS", "English · SDH · SRT". It used to print mpv's
 * own spelling — "ENG · truehd", "hdmv_pgs_subtitle" — which nobody but a
 * developer can read. A separate file with no language says its name.
 */
export function describeTrack(track: Track): string {
  const language = languageName(trackLanguage(track));
  const parts: (string | null)[] = [language];
  if (track.type === 'audio') {
    parts.push(channelLayout(track.channels), audioFormat(track));
  } else {
    parts.push(
      track.forced ? 'Forced' : null,
      track.hearingImpaired || /\bsdh\b|\bcc\b/i.test(track.title ?? '') ? 'SDH' : null
    );
  }
  const fileName = track.external ? externalName(track) : null;
  // mpv titles a separate file by its name: said once, and only when there
  // is no language to say instead.
  const title = fileName && track.title === fileName ? null : informativeTitle(track);
  parts.push(
    title,
    fileName && !language && !title ? fileName : null,
    track.external ? 'separate file' : null,
    track.type === 'sub' ? subtitleFormat(track) : null
  );
  const line = parts.filter((p): p is string => Boolean(p));
  return line.length > 0 ? line.join(' · ') : `Track ${track.id}`;
}

/** What kind of subtitle a codec is, said plainly: drawn pictures or text. */
function subtitleKind(codec: string | undefined): string | null {
  const c = codec?.toLowerCase();
  if (!c) return null;
  if (/pgs|dvd_sub|dvb_sub|vobsub|xsub/.test(c)) return 'picture subtitles';
  if (/subrip|srt|ass|ssa|webvtt|mov_text|text|ttml/.test(c)) return 'text subtitles';
  return null;
}

/**
 * Every track's line, where two that would read the same are told apart.
 *
 * Files often name several tracks alike — two "German", two "Italian" — and
 * a list of identical rows gives nothing to choose by. Those get what the file
 * itself says about them: for subtitles, whether they are pictures or text,
 * and, when that is the same too, the track's number in the file. Rows that
 * are already different are left as they are.
 */
export function describeTracks(tracks: Track[]): Map<number, string> {
  const lines = new Map(tracks.map((t) => [t.id, describeTrack(t)] as const));
  const alike = (id: number) =>
    tracks.filter((t) => lines.get(t.id) === lines.get(id)).length > 1;

  const withKind = new Map(lines);
  for (const t of tracks) {
    // The format word already says it, where there is one.
    const kind = t.type === 'sub' && !subtitleFormat(t) ? subtitleKind(t.codec) : null;
    if (alike(t.id) && kind) withKind.set(t.id, `${lines.get(t.id)} · ${kind}`);
  }
  const result = new Map(withKind);
  for (const t of tracks) {
    const line = withKind.get(t.id);
    if (tracks.filter((o) => withKind.get(o.id) === line).length > 1) {
      result.set(t.id, `${line} · track ${t.id}`);
    }
  }
  return result;
}

/**
 * Pick the track matching a remembered language.
 *
 * Preferences are stored by language rather than track index because track
 * numbering differs between releases — remembering "index 3" would select the
 * wrong track on the next episode, while "da" survives.
 *
 * Forced subtitle tracks are skipped when choosing a full subtitle track: a
 * forced track only covers foreign dialogue and is not what someone selecting
 * a language wants.
 */
export function findTrackByLang(
  tracks: Track[],
  type: 'audio' | 'sub',
  lang: string | null
): Track | null {
  if (!lang) return null;
  const candidates = tracks.filter((t) => t.type === type && sameLanguage(trackLanguage(t), lang));
  if (candidates.length === 0) return null;
  return candidates.find((t) => !t.forced) ?? candidates[0];
}

/** Drawn pictures (Blu-ray PGS, DVD): mpv can scale them, nothing more. */
export const isPictureSubtitle = (track: Track) =>
  subtitleKind(track.codec) === 'picture subtitles';

/**
 * The tracks that can be the second subtitles, drawn at the top: text only,
 * since mpv draws picture subtitles as the first track alone, and never the
 * track that is already the first.
 */
export function secondChoices(tracks: Track[], sid: number | null): Track[] {
  return tracks.filter((t) => t.type === 'sub' && t.id !== sid && !isPictureSubtitle(t));
}

/** The second track for a remembered language, if this file has one. */
export function secondTrackFor(
  tracks: Track[],
  lang: string | null | undefined,
  sid: number | null
): Track | null {
  return findTrackByLang(secondChoices(tracks, sid), 'sub', lang ?? null);
}
