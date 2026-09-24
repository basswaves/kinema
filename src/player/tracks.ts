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
    const [type, id, title, lang, codec, selected, forced, external, isDefault] =
      await Promise.all([
        readProperty<string>(at('type'), 'string'),
        readProperty<number>(at('id'), 'int64'),
        readProperty<string>(at('title'), 'string'),
        readProperty<string>(at('lang'), 'string'),
        readProperty<string>(at('codec'), 'string'),
        readProperty<boolean>(at('selected'), 'flag'),
        readProperty<boolean>(at('forced'), 'flag'),
        readProperty<boolean>(at('external'), 'flag'),
        readProperty<boolean>(at('default'), 'flag'),
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

export function describeTrack(track: MpvTrack): string {
  const parts = [
    track.lang ? track.lang.toUpperCase() : null,
    track.title,
    track.codec,
    track.forced ? 'forced' : null,
    track.external ? 'external' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `Track ${track.id}`;
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
  const wanted = lang.toLowerCase();
  const candidates = tracks.filter((t) => t.type === type && t.lang?.toLowerCase() === wanted);
  if (candidates.length === 0) return null;
  return candidates.find((t) => !t.forced) ?? candidates[0];
}
