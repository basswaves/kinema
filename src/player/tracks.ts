/**
 * Reading mpv's track list.
 *
 * Deliberately avoids `getProperty('track-list', 'node')`. The node format
 * deserialises a nested array-of-maps across the FFI boundary and reliably
 * crashed the process with STATUS_ACCESS_VIOLATION on file load. Every field is
 * available as an indexed scalar property, which is flat and safe.
 */
import { command } from 'tauri-plugin-libmpv-api';
import { readProperty } from './property';
import { languageName, sameLanguage } from './language';

export interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub' | string;
  title?: string;
  lang?: string;
  codec?: string;
  selected: boolean;
  forced: boolean;
  external: boolean;
  default: boolean;
  /** Audio only: channels as the file carries them. */
  channels?: number;
  /** FFmpeg's profile name — where "DTS-HD MA" and "Atmos" are said. */
  profile?: string;
  /** Subtitles for the deaf and hard of hearing (SDH). */
  hearingImpaired?: boolean;
}

/**
 * Every track, read field by field as scalars — **all at once**. Each read is
 * an IPC round trip, and they used to be awaited one after another: nine per
 * track, so a release with twelve audio and subtitle tracks spent over a
 * hundred sequential round trips on it, twice per file (before and after the
 * remembered languages are applied). Order is kept by index.
 */
export async function readTracks(): Promise<MpvTrack[]> {
  const count = (await readProperty<number>('track-list/count', 'int64')) ?? 0;

  const read = async (i: number): Promise<MpvTrack | null> => {
    const at = (field: string) => `track-list/${i}/${field}`;
    const [
      type,
      id,
      title,
      lang,
      codec,
      selected,
      forced,
      external,
      isDefault,
      channels,
      profile,
      hearingImpaired,
    ] = await Promise.all([
        readProperty<string>(at('type'), 'string'),
        readProperty<number>(at('id'), 'int64'),
        readProperty<string>(at('title'), 'string'),
        readProperty<string>(at('lang'), 'string'),
        readProperty<string>(at('codec'), 'string'),
        readProperty<boolean>(at('selected'), 'flag'),
        readProperty<boolean>(at('forced'), 'flag'),
        readProperty<boolean>(at('external'), 'flag'),
        readProperty<boolean>(at('default'), 'flag'),
        readProperty<number>(at('demux-channel-count'), 'int64'),
        readProperty<string>(at('codec-profile'), 'string'),
        readProperty<boolean>(at('hearing-impaired'), 'flag'),
      ]);
    if (!type) return null;
    return {
      id: id ?? i,
      type,
      title: title ?? undefined,
      lang: lang ?? undefined,
      codec: codec ?? undefined,
      selected: selected ?? false,
      forced: forced ?? false,
      external: external ?? false,
      default: isDefault ?? false,
      channels: channels ?? undefined,
      profile: profile ?? undefined,
      hearingImpaired: hearingImpaired ?? false,
    };
  };

  const tracks = await Promise.all(Array.from({ length: count }, (_, i) => read(i)));
  return tracks.filter((t): t is MpvTrack => t !== null);
}

/**
 * Selecting a track uses mpv's `set` input command, not setProperty(). The
 * typed setter sends JS numbers as MPV_FORMAT_DOUBLE, and sid/aid are
 * choice-style properties ("auto" / "no" / an integer) whose handlers do not
 * implement that format — they return M_PROPERTY_NOT_IMPLEMENTED.
 */
export async function selectTrack(kind: 'sid' | 'aid', id: number | 'no'): Promise<void> {
  await command('set', [kind, String(id)]);
}

export async function setSubtitleVisibility(visible: boolean): Promise<void> {
  await command('set', ['sub-visibility', visible ? 'yes' : 'no']);
}

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

function audioFormat(track: MpvTrack): string | null {
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

function informativeTitle(track: MpvTrack): string | null {
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
export function describeTrack(track: MpvTrack): string {
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
  tracks: MpvTrack[],
  type: 'audio' | 'sub',
  lang: string | null
): MpvTrack | null {
  if (!lang) return null;
  const candidates = tracks.filter((t) => t.type === type && sameLanguage(t.lang, lang));
  if (candidates.length === 0) return null;
  return candidates.find((t) => !t.forced) ?? candidates[0];
}
