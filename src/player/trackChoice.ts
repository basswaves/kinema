/**
 * Which audio and subtitle track a file opens with.
 *
 * Two layers. A choice made in a title — changing the audio or subtitles
 * while watching it — is remembered for that title and wins. Before any such
 * choice, the defaults in Settings apply, which is what saves every new show
 * from starting over:
 *
 *  - Audio: as the file sets it (the original, nearly always) or a language.
 *  - Subtitles: off, a language always, or a language only when the audio is
 *    in another one. The last is the default, in Windows' language — the way
 *    most of the world watches: English audio, local subtitles; local audio,
 *    none, except a forced track for the lines in another language.
 *  - Forced subtitles — the few lines for what is said in another language —
 *    show whenever full subtitles do not, **subtitles off included**, in the
 *    language being spoken, as on a disc or a streaming service. Off means no
 *    full subtitles; it has never meant missing the scene in another language.
 *    A switch turns this off (`FORCED_KEY`).
 *
 * Pure, so the rules are tested without mpv.
 */
import { getSetting } from '../metadata/api';
import type { TitlePrefs } from './api';
import { sameLanguage, systemLanguage } from './language';
import type { Track } from './engine';
import { findTrackByLang, isAudioDescription, isHearingImpaired } from './tracks';

export const AUDIO_DEFAULT_KEY = 'lang_audio';
export const SUBS_DEFAULT_KEY = 'lang_subs';
/** Setting key: `'off'` stops forced subtitles showing on their own. */
export const FORCED_KEY = 'forced_subs';
/**
 * Setting keys, `'on'` or off (the default): audio description chosen where
 * a file has it, subtitles for the deaf and hard of hearing preferred. Needs
 * of the person watching, applied to every title like the languages.
 */
export const DESCRIPTION_KEY = 'audio_description';
export const SDH_KEY = 'subtitles_sdh';

export interface LanguageDefaults {
  /** `original`, or a language code. */
  audio: string;
  /** `off`, `always:<code>` or `foreign:<code>`. */
  subs: string;
  /** Show a forced track when full subtitles are not showing. */
  forced: boolean;
  /** Audio description where the file has it in the language chosen; else avoided. */
  description?: boolean;
  /** Subtitles for the deaf and hard of hearing first; else the plain ones. */
  sdh?: boolean;
}

export function defaultSubs(): string {
  return `foreign:${systemLanguage()}`;
}

export async function readLanguageDefaults(): Promise<LanguageDefaults> {
  const [audio, subs, forced, description, sdh] = await Promise.all([
    getSetting(AUDIO_DEFAULT_KEY).catch(() => null),
    getSetting(SUBS_DEFAULT_KEY).catch(() => null),
    getSetting(FORCED_KEY).catch(() => null),
    getSetting(DESCRIPTION_KEY).catch(() => null),
    getSetting(SDH_KEY).catch(() => null),
  ]);
  return {
    audio: audio || 'original',
    subs: subs || defaultSubs(),
    forced: forced !== 'off',
    description: description === 'on',
    sdh: sdh === 'on',
  };
}

export interface TrackChoice {
  /** The audio track to select, or null to leave the file's own choice. */
  aid: number | null;
  /** The subtitle track to select, or null to leave the file's own choice. */
  sid: number | null;
  /** Whether subtitles show, or null to leave it as it is. */
  subVisible: boolean | null;
}

export function forcedTrack(tracks: Track[], lang: string | null | undefined): Track | null {
  return tracks.find((t) => t.type === 'sub' && t.forced && sameLanguage(t.lang, lang)) ?? null;
}

/**
 * No full subtitles: the forced track for the language being spoken, if the
 * file has one and forced subtitles are on; otherwise none.
 */
function forcedOrNone(
  tracks: Track[],
  aid: number | null,
  spoken: Track | null,
  show: boolean
): TrackChoice {
  const forced = show ? forcedTrack(tracks, spoken?.lang) : null;
  if (forced) return { aid, sid: forced.id, subVisible: true };
  return { aid, sid: null, subVisible: false };
}

/** The audio track that will play: the one chosen, or the file's own. */
export function spokenTrack(tracks: Track[], chosen: Track | null): Track | null {
  return chosen ?? tracks.find((t) => t.type === 'audio' && t.selected) ?? null;
}

/**
 * "As the file sets it", with the audio description need applied: the
 * file's own track when it fits, else one in its language that does; null
 * leaves the file's choice.
 */
function siblingFor(tracks: Track[], want: (t: Track) => boolean): Track | null {
  const own = tracks.find((t) => t.type === 'audio' && t.selected);
  if (!own || want(own)) return null;
  return (
    tracks.find((t) => t.type === 'audio' && t !== own && sameLanguage(t.lang, own.lang) && want(t)) ??
    null
  );
}

export function chooseTracks(
  tracks: Track[],
  prefs: TitlePrefs | null,
  defaults: LanguageDefaults
): TrackChoice {
  // Audio description and SDH, as the person needs them: among a
  // language's tracks, the one that matches, else the first.
  const wantAudio = (t: Track) => isAudioDescription(t) === !!defaults.description;
  const wantSub = (t: Track) => isHearingImpaired(t) === !!defaults.sdh;

  // A choice made in this title: as before, it decides both.
  if (prefs?.chosen) {
    const audio = findTrackByLang(tracks, 'audio', prefs.audio_lang, wantAudio);
    if (!prefs.sub_enabled) {
      return forcedOrNone(tracks, audio?.id ?? null, spokenTrack(tracks, audio), defaults.forced);
    }
    const sub = findTrackByLang(tracks, 'sub', prefs.sub_lang, wantSub);
    return { aid: audio?.id ?? null, sid: sub?.id ?? null, subVisible: true };
  }

  const audio =
    defaults.audio === 'original'
      ? siblingFor(tracks, wantAudio)
      : findTrackByLang(tracks, 'audio', defaults.audio, wantAudio);
  const playing = spokenTrack(tracks, audio);

  const [mode, lang] = defaults.subs.split(':');
  if (mode === 'off' || !lang) {
    return forcedOrNone(tracks, audio?.id ?? null, playing, defaults.forced);
  }

  // Untagged audio counts as another language: showing subtitles someone did
  // not need is a smaller mistake than hiding ones they did.
  const foreignAudio = !sameLanguage(playing?.lang, lang);
  if (mode === 'always' || foreignAudio) {
    const sub = findTrackByLang(tracks, 'sub', lang, wantSub);
    // No track in that language: leave whatever the file chose.
    if (!sub) return { aid: audio?.id ?? null, sid: null, subVisible: null };
    return { aid: audio?.id ?? null, sid: sub.id, subVisible: true };
  }

  // Audio already in the viewer's language: only the forced lines, if any.
  return forcedOrNone(tracks, audio?.id ?? null, playing, defaults.forced);
}
