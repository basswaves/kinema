/**
 * The file's audio and subtitle tracks: reading them, putting this title's
 * remembered languages on (else the defaults in Settings — trackChoice.ts),
 * forced subtitles from OpenSubtitles where the file has none, and a choice
 * in the track panel, which is remembered for the whole title.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getTitlePrefs, setTitlePrefs, type PlaybackTarget } from './api';
import { openPath } from './engine';
import { canonicalLang, systemLanguage } from './language';
import { forcedSubtitle, loadSubtitle } from './onlineSubtitles';
import { samePath } from './session';
import { chooseTracks, forcedTrack, readLanguageDefaults, spokenTrack } from './trackChoice';
import {
  readSubVisibility,
  readTracks,
  selectTrack,
  setSubtitleVisibility,
  type MpvTrack,
} from './tracks';

export function useTracks({
  target,
  fail,
}: {
  target: PlaybackTarget;
  fail: (e: unknown) => void;
}) {
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  /** The subtitle language from Settings, or Windows' when subtitles are off. */
  const [wantedSubLang, setWantedSubLang] = useState<string | null>(null);
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);
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
    const list = await readTracks();
    setTracks(list);

    // This title's own choice if there is one, else the defaults in Settings
    // — see trackChoice.ts. A trailer (no title) takes the defaults too.
    let showForced = true;
    try {
      const [prefs, defaults] = await Promise.all([
        target.titleId !== null ? getTitlePrefs(target.titleId) : Promise.resolve(null),
        readLanguageDefaults(),
      ]);
      showForced = defaults.forced;
      const [mode, lang] = defaults.subs.split(':');
      setWantedSubLang(mode !== 'off' && lang ? lang : systemLanguage());
      const choice = chooseTracks(list, prefs, defaults);
      if (choice.aid !== null) await selectTrack('aid', choice.aid);
      if (choice.sid !== null) await selectTrack('sid', choice.sid);
      if (choice.subVisible !== null) await setSubtitleVisibility(choice.subVisible);
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

    const visible = await readSubVisibility();
    setSubVisible(visible);

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
  }, [target.titleId, target.fileId, target.path]);

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
    async (kind: 'sid' | 'aid', track: MpvTrack | null) => {
      try {
        if (kind === 'sid' && track === null) {
          await setSubtitleVisibility(false);
          setSubVisible(false);
        } else if (track) {
          await selectTrack(kind, track.id);
          if (kind === 'sid') {
            await setSubtitleVisibility(true);
            setSubVisible(true);
            setSid(track.id);
          } else {
            setAid(track.id);
          }
        }

        if (target.titleId !== null) {
          const current = await getTitlePrefs(target.titleId);
          await setTitlePrefs(target.titleId, {
            audio_lang: kind === 'aid' ? (track?.lang ?? null) : current.audio_lang,
            sub_lang: kind === 'sid' ? (track?.lang ?? null) : current.sub_lang,
            sub_enabled: kind === 'sid' ? track !== null : current.sub_enabled,
          });
        }
      } catch (e) {
        fail(e);
      }
    },
    [target.titleId, fail]
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
  };
}
