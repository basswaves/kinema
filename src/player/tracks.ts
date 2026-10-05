/**
 * Saying a track in words, and finding one by language. The tracks themselves
 * are read and chosen through the engine (engine.ts), in Kinema's terms.
 */
import type { Track } from './engine';
import { languageName, sameLanguage } from './language';

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
 * A line a person reads: "English · 7.1 · Dolby TrueHD Atmos",
 * "Norwegian · Forced", "English · SDH". It used to print mpv's own
 * spelling — "ENG · truehd", "hdmv_pgs_subtitle" — which nobody but a
 * developer can read.
 */
export function describeTrack(track: Track): string {
  const parts: (string | null)[] = [languageName(track.lang)];
  if (track.type === 'audio') {
    parts.push(channelLayout(track.channels), audioFormat(track));
  } else {
    parts.push(
      track.forced ? 'Forced' : null,
      track.hearingImpaired || /\bsdh\b|\bcc\b/i.test(track.title ?? '') ? 'SDH' : null
    );
  }
  parts.push(informativeTitle(track), track.external ? 'separate file' : null);
  const line = parts.filter((p): p is string => Boolean(p));
  return line.length > 0 ? line.join(' · ') : `Track ${track.id}`;
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
  const candidates = tracks.filter((t) => t.type === type && sameLanguage(t.lang, lang));
  if (candidates.length === 0) return null;
  return candidates.find((t) => !t.forced) ?? candidates[0];
}
