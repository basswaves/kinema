/**
 * The file's audio and subtitle tracks: reading them, putting this title's
 * remembered languages on (else the defaults in Settings — trackChoice.ts),
 * forced subtitles from OpenSubtitles where the file has none, and a choice
 * in the track panel, which is remembered for the whole title. Also how big
 * the subtitles are drawn on this screen (subtitleStyle.ts), and a second
 * subtitle track at the top, remembered for the title like the first.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getTitlePrefs, setTitlePrefs, type PlaybackTarget, type TitlePrefs } from './api';
import { getVideoPrefs, setVideoPrefs } from '../library/videos';
import {
  chooseSecondTrack,
  chooseTrack as playTrack,
  hasMpv,
  openPath,
  readTracks,
  showSubtitles,
  subtitlesShown,
  type Track,
} from './engine';
import { canonicalLang, systemLanguage } from './language';
import { forcedSubtitle, loadSubtitle } from './onlineSubtitles';
import { samePath } from './session';
import { screenHere } from './displaySwitch';
import { applySubStyle, DEFAULT_STYLE, readSubStyle, saveSubStyle, type SubStyle } from './subtitleStyle';
import { secondTrackFor } from './tracks';
import { chooseTracks, forcedTrack, readLanguageDefaults, spokenTrack } from './trackChoice';

/**
 * Whose track choices apply: a title's, or for a video its folder's
 * (videos.ts); none for a trailer or a file outside the library.
 */
function prefsOf(titleId: number | null, videoFile: number | null): Promise<TitlePrefs | null> {
  if (videoFile !== null) return getVideoPrefs(videoFile);
  return titleId !== null ? getTitlePrefs(titleId) : Promise.resolve(null);
}

function storePrefs(titleId: number | null, videoFile: number | null, prefs: TitlePrefs) {
  if (videoFile !== null) return setVideoPrefs(videoFile, prefs);
  return titleId !== null ? setTitlePrefs(titleId, prefs) : Promise.resolve();
}

export function useTracks({
  target,
  fail,
}: {
  target: PlaybackTarget;
  fail: (e: unknown) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  /** A video's file, whose folder keeps its track choices. */
  const videoFile = target.video ? target.fileId : null;
  /** The subtitle language from Settings, or Windows' when subtitles are off. */
  const [wantedSubLang, setWantedSubLang] = useState<string | null>(null);
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);
  /** The second subtitles, drawn at the top (mpv only); null: none. */
  const [sid2, setSid2] = useState<number | null>(null);
  /** Subtitle size and box for the screen the picture is on (desktop). */
  const [subStyle, setSubStyle] = useState<SubStyle>(DEFAULT_STYLE);
  const styleScreen = useRef<string | null>(null);
  /**
   * The last audio track that was playing. mpv deselects the track when its
   * output fails to open, so this is what the fallback puts back.
   */
  const lastAid = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (aid !== null) lastAid.current = aid;
  }, [aid]);

  /** Apply this title's remembered languages to the freshly loaded file. */
  const applyPrefs = useCallback(async () => {
    // The size first, so the first line is drawn at it. Read per file: the
    // window may have moved to another screen since the last one.
    try {
      if (hasMpv()) {
        styleScreen.current = (await screenHere()).id;
        const style = await readSubStyle(styleScreen.current);
        setSubStyle(style);
        await applySubStyle(style);
      }
    } catch (e) {
      console.warn('could not apply the subtitle size', e);
    }

    const list = await readTracks();
    setTracks(list);

    // This title's own choice if there is one, else the defaults in Settings
    // — see trackChoice.ts. A trailer (no title) takes the defaults too.
    let showForced = true;
    let sub2Lang: string | null = null;
    try {
      const [prefs, defaults] = await Promise.all([
        prefsOf(target.titleId, videoFile),
        readLanguageDefaults(),
      ]);
      showForced = defaults.forced;
      sub2Lang = prefs?.sub2_lang ?? null;
      const [mode, lang] = defaults.subs.split(':');
      setWantedSubLang(mode !== 'off' && lang ? lang : systemLanguage());
      const choice = chooseTracks(list, prefs, defaults);
      if (choice.aid !== null) await playTrack('audio', choice.aid);
      if (choice.sid !== null) await playTrack('sub', choice.sid);
      if (choice.subVisible !== null) await showSubtitles(choice.subVisible);
    } catch (e) {
      console.warn('could not apply track preferences', e);
    }

    // Selected track ids come from the track list's own `selected` flags.
    // Reading `sid`/`aid` directly fails with "unsupported format": they are
    // choice properties ("auto" / "no" / an integer), not plain integers.
    const updated = await readTracks();
    setTracks(updated);
    setAid(updated.find((t) => t.type === 'audio' && t.selected)?.id ?? null);
    setSid(updated.find((t) => t.type === 'sub' && t.selected)?.id ?? null);

    const visible = await subtitlesShown();
    setSubVisible(visible);

    // The second subtitles in the remembered language, or none — set either
    // way, since mpv would keep the last file's number (engine.ts).
    if (hasMpv()) {
      const firstId = updated.find((t) => t.type === 'sub' && t.selected)?.id ?? null;
      const second = secondTrackFor(updated, sub2Lang, firstId);
      try {
        await chooseSecondTrack(second?.id ?? null);
        setSid2(second?.id ?? null);
      } catch (e) {
        console.warn('could not show the second subtitles', e);
        setSid2(null);
      }
    }

    // Forced subtitles from OpenSubtitles, for a file with none of its own —
    // only when switched on (Rust checks), never over full subtitles, and in
    // the language being spoken. After the film has started: nothing waits
    // for it.
    const fileId = target.fileId;
    const spoken = canonicalLang(spokenTrack(updated, null)?.lang);
    const selectedSub = updated.find((t) => t.type === 'sub' && t.selected);
    const fullSubsShowing = visible && selectedSub !== undefined && !selectedSub.forced;
    if (fileId !== null && spoken && showForced && !fullSubsShowing && !forcedTrack(updated, spoken)) {
      void (async () => {
        try {
          const path = await forcedSubtitle(fileId, target.path, spoken);
          if (!path) return;
          // The same file still playing, or the subtitle would land on the next.
          const playing = await openPath();
          if (!playing || !samePath(playing, target.path)) return;
          await loadSubtitle(path, spoken, true);
          const now = await readTracks();
          setTracks(now);
          setSid(now.find((t) => t.type === 'sub' && t.selected)?.id ?? null);
          setSubVisible(true);
          console.log(`forced ${spoken} subtitles from OpenSubtitles for ${target.path}`);
        } catch (e) {
          // Never fatal: the film plays on without them.
          console.warn('forced subtitles unavailable', e);
        }
      })();
    }
  }, [target.titleId, target.fileId, target.path, videoFile]);

  /** Put a fetched subtitle on screen and bring the track list up to date. */
  const showFetched = useCallback(
    async (path: string, language: string, release?: string) => {
      await loadSubtitle(path, language, false, release);
      const now = await readTracks();
      setTracks(now);
      setSid(now.find((t) => t.type === 'sub' && t.selected)?.id ?? null);
      setSubVisible(true);
    },
    []
  );

  /** Changing a track also records the language for this whole title. */
  const chooseTrack = useCallback(
    async (kind: 'audio' | 'sub', track: Track | null) => {
      try {
        // The second subtitles cannot be the first as well: chosen as the
        // first, it stops being the second.
        const clearsSecond = kind === 'sub' && track !== null && track.id === sid2;
        if (clearsSecond) {
          await chooseSecondTrack(null);
          setSid2(null);
        }
        if (kind === 'sub' && track === null) {
          await showSubtitles(false);
          setSubVisible(false);
        } else if (track) {
          await playTrack(kind, track.id);
          if (kind === 'sub') {
            await showSubtitles(true);
            setSubVisible(true);
            setSid(track.id);
          } else {
            setAid(track.id);
          }
        }

        const current = await prefsOf(target.titleId, videoFile);
        if (current) {
          await storePrefs(target.titleId, videoFile, {
            audio_lang: kind === 'audio' ? (track?.lang ?? null) : current.audio_lang,
            sub_lang: kind === 'sub' ? (track?.lang ?? null) : current.sub_lang,
            sub_enabled: kind === 'sub' ? track !== null : current.sub_enabled,
            sub2_lang: clearsSecond ? null : (current.sub2_lang ?? null),
          });
        }
      } catch (e) {
        fail(e);
      }
    },
    [target.titleId, videoFile, fail, sid2]
  );

  /** The second subtitles, or none; remembered for the whole title. */
  const chooseSecond = useCallback(
    async (track: Track | null) => {
      try {
        await chooseSecondTrack(track?.id ?? null);
        setSid2(track?.id ?? null);
        const current = await prefsOf(target.titleId, videoFile);
        if (current) {
          // Nothing chosen here yet: keep what is playing now as the choice,
          // or saving the second would replace the defaults with nothing.
          const langOf = (type: string, id: number | null) =>
            tracks.find((t) => t.type === type && t.id === id)?.lang ?? null;
          const first = current.chosen
            ? current
            : {
                audio_lang: langOf('audio', aid),
                sub_lang: langOf('sub', sid),
                sub_enabled: subVisible,
              };
          await storePrefs(target.titleId, videoFile, {
            audio_lang: first.audio_lang,
            sub_lang: first.sub_lang,
            sub_enabled: first.sub_enabled,
            sub2_lang: track?.lang ?? null,
          });
        }
      } catch (e) {
        fail(e);
      }
    },
    [target.titleId, videoFile, fail, tracks, aid, sid, subVisible]
  );

  /** A new size or box, for this screen from now on. */
  const changeSubStyle = useCallback(
    async (style: SubStyle) => {
      setSubStyle(style);
      try {
        await applySubStyle(style);
        await saveSubStyle(styleScreen.current, style);
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  /** Read the list again, for the track panel as it opens. */
  const refreshTracks = useCallback(() => readTracks().then(setTracks), []);

  return {
    tracks,
    aid,
    sid,
    subVisible,
    wantedSubLang,
    lastAid,
    applyPrefs,
    showFetched,
    chooseTrack,
    refreshTracks,
    subStyle,
    changeSubStyle,
    sid2,
    chooseSecond,
  };
}
