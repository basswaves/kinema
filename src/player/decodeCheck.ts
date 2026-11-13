/**
 * Whether this system can decode the film's picture and sound — and, where it
 * cannot, saying so instead of a black picture or silence (review A3-01/02).
 *
 * mpv decodes with the codec libraries it was built against. On Windows those
 * come with Kinema; on Linux they are the system's own, and some systems'
 * builds leave out the patented formats (Fedora's `libavcodec-free` has no
 * HEVC or E-AC-3, and decodes H.264 only through OpenH264, which cannot do
 * 10-bit, interlaced or 8K). mpv then plays on without the track and says so
 * only in its log.
 *
 * Gated on what mpv reports, never on the system's name:
 * - **No decoder**: the codec is missing from mpv's `decoder-list`, and mpv
 *   dropped the track ("Failed to initialize a decoder", then "no video" /
 *   "no audio"). Read as a string — mpv prints a list property as JSON, which
 *   crosses the FFI safely where the node format does not (GOTCHAS).
 * - **No frames**: a decoder opened but turns out nothing. The demuxer's
 *   reader then races through the file while no picture arrives: seen on the
 *   Linux test PC, 10-bit H.264 through OpenH264 had read all 40 s of the
 *   file 1.3 s after opening, paused, where a film that decodes had read
 *   0.19 s (the same over an smb:// share and over http with mpv's cache
 *   on: read-ahead moves the cache's end, not the reader). A picture that
 *   has arrived (`video-params/gamma`) always wins.
 *   A working decoder can look the same for a moment: a recording cut
 *   mid-GOP, through a full ffmpeg, skips to its first keyframe, and was
 *   seen with the position at 0 and the reader 6.3 s ahead a few
 *   milliseconds before its picture. So "no frames" counts only once it has
 *   held, with no picture, for `CONFIRM_MS` (`confirmNoFrames`).
 *
 * Anything that cannot be read counts as "fine": an unread list says nothing
 * about a decoder, and the film plays as it would have.
 */
import { mpvGet } from './engine';
import { samePath } from './session';

/** What the check needs to know about one track, as mpv lists it. */
export interface TrackFacts {
  type: string;
  id: number;
  selected: boolean;
  codec: string | null;
  /** A cover picture in a sound file: a picture, but not a film's. */
  albumart: boolean;
  profile: string | null;
}

/** A track this system cannot decode, and how that showed. */
export interface Gap {
  kind: 'video' | 'audio';
  codec: string;
  profile: string | null;
  why: 'no-decoder' | 'no-frames';
}

/** What the open file's picture comes to, as far as mpv has said so far. */
export type PictureVerdict =
  /** A picture has arrived. */
  | { state: 'shown' }
  /** None yet, and one may still come: keep waiting. */
  | { state: 'coming' }
  /** No picture will come: the file has none, or mpv dropped its track. */
  | { state: 'none'; gap: Gap | null };

/**
 * How far the reader may run ahead of the position, with no picture, before
 * the decoder counts as turning out nothing. A decoder that works holds the
 * reader within a fraction of a second while it waits for its first frame
 * (0.19 s measured, paused); one that fails on every frame runs it to the end
 * of the file within a second or two.
 */
export const RUNAWAY_SECS = 5;
/**
 * A file shorter than that shows it as the reader reaching the end with no
 * picture (4 s clips of 10-bit and interlaced H.264, Linux test PC: reader at
 * 3.96 s of 4.02, position 0). Said only past this much of a lead, so a film
 * resumed in its last seconds is not taken for one.
 */
export const END_LEAD_SECS = 1;
/** How near the end the reader must be to count as having reached it. */
const END_SLACK_SECS = 0.5;
/**
 * How long "no frames" must hold, with no picture, before it is believed. A
 * decoder that skips to a keyframe shows it within a fraction of a second of
 * reaching it; one that cannot decode never does.
 */
export const CONFIRM_MS = 3000;

/** Since when, and for which file, "no frames" has been seen without a break. */
export interface Suspicion {
  path: string;
  since: number;
}

/**
 * The verdict to act on, given the one just read: "no frames" only once it
 * has been seen for `CONFIRM_MS` without a break (anything else read in
 * between starts the count again). Everything else is passed on as read.
 */
export function confirmNoFrames(
  verdict: PictureVerdict,
  path: string,
  suspicion: Suspicion | null,
  now: number
): { verdict: PictureVerdict; suspicion: Suspicion | null } {
  if (verdict.state !== 'none' || verdict.gap?.why !== 'no-frames') {
    return { verdict, suspicion: null };
  }
  const since = suspicion && suspicion.path === path ? suspicion.since : now;
  return {
    verdict: now - since >= CONFIRM_MS ? verdict : { state: 'coming' },
    suspicion: { path, since },
  };
}

/** The codec names in mpv's `decoder-list`, or null where it was not read. */
export function parseDecoders(text: string | null): Set<string> | null {
  if (!text) return null;
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list) || list.length === 0) return null;
    const codecs = new Set<string>();
    for (const d of list) {
      const codec = (d as { codec?: unknown } | null)?.codec;
      if (typeof codec === 'string') codecs.add(codec);
    }
    return codecs.size > 0 ? codecs : null;
  } catch {
    return null;
  }
}

/** The demuxer reader's position, from `demuxer-cache-state` as a string. */
export function parseReaderPts(text: string | null): number | null {
  if (!text) return null;
  try {
    const pts = (JSON.parse(text) as { 'reader-pts'?: unknown } | null)?.['reader-pts'];
    return typeof pts === 'number' && Number.isFinite(pts) ? pts : null;
  } catch {
    return null;
  }
}

/** Whether a track's codec is one this system has no decoder for. */
function lacks(track: TrackFacts, decoders: Set<string> | null): boolean {
  return decoders !== null && track.codec !== null && !decoders.has(track.codec);
}

/**
 * Whether a picture can still come for the open file. `tracks` empty means the
 * file is not open yet, which is "coming".
 */
export function pictureVerdict(s: {
  tracks: TrackFacts[];
  /** `video-params/gamma`: set once a picture has arrived. */
  gamma: string | null;
  timePos: number | null;
  readerPts: number | null;
  /** The file's length, where known. */
  duration?: number | null;
  decoders: Set<string> | null;
}): PictureVerdict {
  if (s.gamma) return { state: 'shown' };
  if (s.tracks.length === 0) return { state: 'coming' };
  const video = s.tracks.filter((t) => t.type === 'video');
  if (video.length === 0) return { state: 'none', gap: null };
  const film = video.filter((t) => !t.albumart);
  // A cover picture is a picture: switching the screen for it is as before.
  if (film.length === 0) return { state: 'coming' };
  const playing = film.find((t) => t.selected);
  if (!playing) {
    if (video.some((t) => t.selected)) return { state: 'coming' };
    // mpv dropped the film's track. Said only where the reason is known.
    const missing = film.find((t) => lacks(t, s.decoders));
    return {
      state: 'none',
      gap: missing
        ? { kind: 'video', codec: missing.codec!, profile: missing.profile, why: 'no-decoder' }
        : null,
    };
  }
  const lead = s.readerPts !== null && s.timePos !== null ? s.readerPts - s.timePos : null;
  const atEnd =
    s.readerPts !== null && s.duration != null && s.readerPts >= s.duration - END_SLACK_SECS;
  if (
    playing.codec !== null &&
    lead !== null &&
    (lead > RUNAWAY_SECS || (atEnd && lead > END_LEAD_SECS))
  ) {
    return {
      state: 'none',
      gap: { kind: 'video', codec: playing.codec, profile: playing.profile, why: 'no-frames' },
    };
  }
  return { state: 'coming' };
}

/** The sound track `id` as a gap, when this system has no decoder for it. */
export function soundGap(
  tracks: TrackFacts[],
  id: number,
  decoders: Set<string> | null
): Gap | null {
  const track = tracks.find((t) => t.type === 'audio' && t.id === id);
  if (!track || !lacks(track, decoders)) return null;
  return { kind: 'audio', codec: track.codec!, profile: track.profile, why: 'no-decoder' };
}

/** Whether another sound track in the file is one this system can decode. */
export function otherSoundPlays(
  tracks: TrackFacts[],
  id: number,
  decoders: Set<string> | null
): boolean {
  return tracks.some((t) => t.type === 'audio' && t.id !== id && t.codec !== null && !lacks(t, decoders));
}

// ---- words ---------------------------------------------------------------------

const NAMES: Record<string, string> = {
  hevc: 'HEVC',
  h264: 'H.264',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  vc1: 'VC-1',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  eac3: 'E-AC-3',
  ac3: 'AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  flac: 'FLAC',
  vorbis: 'Vorbis',
};

/**
 * The patented formats that systems' own builds leave out — the same list
 * Settings' ffmpeg line names (ffmpegNotice.ts). Only for these is a full
 * build the answer worth pointing to.
 */
const LEFT_OUT = new Set(['hevc', 'h264', 'eac3', 'ac3', 'dts', 'truehd']);

export function codecWords(codec: string): string {
  return NAMES[codec] ?? codec.toUpperCase();
}

function and(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What the player says about the tracks it cannot decode. `system` is the
 * operating system's name, from the capabilities; the pointer to a full
 * build is said only where the codec libraries are the system's own (Linux)
 * and the format is one such builds leave out.
 */
export function cannotDecodeNotice(
  gaps: Gap[],
  system: string,
  otherSound = false
): string | null {
  const picture = gaps.find((g) => g.kind === 'video') ?? null;
  const sound = gaps.find((g) => g.kind === 'audio') ?? null;
  if (!picture && !sound) return null;
  const parts: string[] = [];
  if (picture) {
    const name = codecWords(picture.codec);
    parts.push(
      picture.why === 'no-decoder'
        ? `This system cannot decode ${name} video, so there is no picture.`
        : `This system could not decode this ${name} video${
            picture.profile ? ` (${picture.profile})` : ''
          }, so there is no picture.`
    );
  }
  if (sound) {
    const name = codecWords(sound.codec);
    parts.push(
      picture
        ? `It cannot decode the ${name} sound either.`
        : `This system cannot decode ${name} sound, so this track plays silent.`
    );
    if (otherSound) parts.push('Another sound track is in Audio & subtitles.');
  }
  // Only for formats such builds are known to leave out or cut down, and
  // only where the codec libraries are the system's own.
  const missing = [picture, sound].filter(
    (g): g is Gap => g !== null && g.why === 'no-decoder' && LEFT_OUT.has(g.codec)
  );
  const partial = picture?.why === 'no-frames' && LEFT_OUT.has(picture.codec) ? picture : null;
  if (system === 'Linux' && (missing.length > 0 || partial)) {
    const clauses = [
      ...(missing.length > 0
        ? [`leave ${and([...new Set(missing.map((g) => codecWords(g.codec)))])} out`]
        : []),
      ...(partial ? [`decode ${codecWords(partial.codec)} only in part`] : []),
    ];
    parts.push(
      `Some Linux systems’ own codec libraries ${clauses.join(' and ')}, Fedora’s among ` +
        'them; a full build decodes them all (on Fedora, from RPM Fusion).'
    );
  }
  return parts.join(' ');
}

/** The notices that stand for as long as the film is shown with no picture. */
export function isNoPictureNotice(notice: string): boolean {
  return / video(?: \([^)]*\))?, so there is no picture\./.test(notice);
}

// ---- reading mpv ---------------------------------------------------------------

let decodersRead: Promise<Set<string> | null> | null = null;

/**
 * mpv's decoders, read once: they are fixed for the life of the library. A
 * failed read is tried again next time rather than kept.
 */
export function readDecoders(): Promise<Set<string> | null> {
  decodersRead ??= mpvGet<string>('decoder-list', 'string')
    .then(parseDecoders)
    .catch(() => null)
    .then((set) => {
      if (set === null) decodersRead = null;
      return set;
    });
  return decodersRead;
}

/** Every track of the open file, as the check needs it. Scalars only (GOTCHAS). */
export async function readTrackFacts(): Promise<TrackFacts[]> {
  const count = (await mpvGet<number>('track-list/count', 'int64').catch(() => null)) ?? 0;
  const read = async (i: number): Promise<TrackFacts | null> => {
    const at = (field: string) => `track-list/${i}/${field}`;
    const get = <T>(field: string, format: 'string' | 'int64' | 'flag') =>
      mpvGet<T>(at(field), format).catch(() => null);
    const [type, id, selected, codec, albumart, profile] = await Promise.all([
      get<string>('type', 'string'),
      get<number>('id', 'int64'),
      get<boolean>('selected', 'flag'),
      get<string>('codec', 'string'),
      get<boolean>('albumart', 'flag'),
      get<string>('codec-profile', 'string'),
    ]);
    if (!type || id === null) return null;
    return {
      type,
      id,
      selected: selected === true,
      codec: codec || null,
      albumart: albumart === true,
      profile: profile || null,
    };
  };
  const all = await Promise.all(Array.from({ length: count }, (_, i) => read(i)));
  return all.filter((t): t is TrackFacts => t !== null);
}

/**
 * The open file's picture verdict, read from mpv. `path` is the file the
 * caller is waiting for: until mpv has it open, the tracks are another
 * file's and nothing is concluded.
 */
let suspicion: Suspicion | null = null;

export async function readPictureVerdict(path: string): Promise<PictureVerdict> {
  const read = await readRawVerdict(path);
  const confirmed = confirmNoFrames(read, path, suspicion, Date.now());
  suspicion = confirmed.suspicion;
  return confirmed.verdict;
}

async function readRawVerdict(path: string): Promise<PictureVerdict> {
  const open = await mpvGet<string>('path', 'string').catch(() => null);
  if (!open || !samePath(open, path)) return { state: 'coming' };
  const [tracks, gamma, timePos, duration, cache, decoders] = await Promise.all([
    readTrackFacts(),
    mpvGet<string>('video-params/gamma', 'string').catch(() => null),
    mpvGet<number>('time-pos', 'double').catch(() => null),
    mpvGet<number>('duration', 'double').catch(() => null),
    mpvGet<string>('demuxer-cache-state', 'string').catch(() => null),
    readDecoders(),
  ]);
  return pictureVerdict({
    tracks,
    gamma,
    timePos,
    duration,
    readerPts: parseReaderPts(cache),
    decoders,
  });
}
