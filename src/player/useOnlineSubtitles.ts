/**
 * "Find subtitles online" in the track panel (onlineSubtitles.ts): whether
 * this copy of Kinema can search, in which language, the search itself and
 * "Choose another" — and what the panel shows for it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { userError } from '../ui/errors';
import type { PlaybackTarget } from './api';
import { languageName } from './language';
import {
  fetchSubtitle,
  findSubtitles,
  searchLanguages,
  subtitleStatus,
  type Offer,
} from './onlineSubtitles';
import { spokenTrack } from './trackChoice';
import type { Track } from './engine';
import type { OnlineSubtitles } from './TrackPanel';

/**
 * "Find subtitles online": search, show the best, and say what was shown —
 * or why nothing was. Kept out of the hook; see `findOnline`.
 */
async function onlineSearch(
  fileId: number,
  path: string,
  language: string,
  show: (path: string, language: string, release?: string) => Promise<void>
): Promise<{ message: string; offers: Offer[] }> {
  const name = languageName(language) ?? language;
  try {
    const found = await findSubtitles(fileId, path, language);
    if (!found) return { message: `OpenSubtitles has no ${name} subtitles for this.`, offers: [] };
    await show(found.path, language, found.chosen.release);
    return {
      message: found.chosen.matches_file
        ? `Showing ${name} subtitles timed for this file.`
        : `Showing the most used ${name} subtitles. If they are out of step, choose another.`,
      offers: found.offers.filter((x) => x.file_id !== found.chosen.file_id),
    };
  } catch (e) {
    return { message: userError(e), offers: [] };
  }
}

/** "Choose another": fetch and show one, and say so. */
async function onlineChoice(
  fileId: number,
  offer: Offer,
  language: string,
  show: (path: string, language: string, release?: string) => Promise<void>
): Promise<string> {
  try {
    await show(await fetchSubtitle(fileId, offer.file_id, language), language, offer.release);
    return `Showing: ${offer.release || 'the one chosen'}.`;
  } catch (e) {
    return userError(e);
  }
}

export function useOnlineSubtitles({
  target,
  tracks,
  aid,
  wantedSubLang,
  showTracks,
  showFetched,
}: {
  target: PlaybackTarget;
  tracks: Track[];
  /** The audio track playing, whose language is the second choice. */
  aid: number | null;
  /** The subtitle language from Settings, the first choice (useTracks). */
  wantedSubLang: string | null;
  /** The track panel is open: the moment to ask whether a search can be made. */
  showTracks: boolean;
  /** Put a fetched subtitle on screen (useTracks). */
  showFetched: (path: string, language: string, release?: string) => Promise<void>;
}): OnlineSubtitles | null {
  /**
   * Whether this copy can, which of the offered languages is picked, and what
   * the last search found.
   */
  const [online, setOnline] = useState<{
    available: boolean;
    langIndex: number;
    finding: boolean;
    message: string | null;
    offers: Offer[];
  }>({ available: false, langIndex: 0, finding: false, message: null, offers: [] });

  // What was found online belongs to the file it was found for.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline((o) => ({ ...o, langIndex: 0, finding: false, message: null, offers: [] }));
  }, [target.path, target.fileId]);

  /** The languages "Find subtitles online" can search in, first choice first. */
  const onlineLanguages = useMemo(
    () =>
      searchLanguages(
        wantedSubLang,
        spokenTrack(
          tracks,
          tracks.find((t) => t.type === 'audio' && t.id === aid) ?? null
        )?.lang ?? null
      ),
    [wantedSubLang, tracks, aid]
  );
  const onlineLanguage = onlineLanguages[online.langIndex % Math.max(1, onlineLanguages.length)];

  // Whether this copy can search at all: asked when the panel opens, since a
  // key can be entered in Settings while Kinema runs.
  useEffect(() => {
    if (!showTracks) return;
    let live = true;
    subtitleStatus()
      .then((s) => live && setOnline((o) => ({ ...o, available: s.available })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [showTracks]);

  // No try/catch here: the React Compiler behind the react-hooks rules cannot
  // follow a condition (?:, ||, ??) inside a try block, and gives up on the
  // whole component without a word — every other rule in this file went
  // quiet (GOTCHAS). The work is in `onlineSearch` / `onlineChoice` above,
  // outside the hook, which return what to show.
  const findOnline = useCallback(async () => {
    const fileId = target.fileId;
    const language = onlineLanguage;
    if (fileId === null || !language) return;
    setOnline((o) => ({ ...o, finding: true, message: null, offers: [] }));
    const shown = await onlineSearch(fileId, target.path, language, showFetched);
    setOnline((o) => ({ ...o, finding: false, ...shown }));
  }, [target.fileId, target.path, onlineLanguage, showFetched]);

  const chooseOffer = useCallback(
    async (offer: Offer) => {
      const fileId = target.fileId;
      const language = onlineLanguage;
      if (fileId === null || !language) return;
      setOnline((o) => ({ ...o, finding: true, message: null }));
      const message = await onlineChoice(fileId, offer, language, showFetched);
      setOnline((o) => ({
        ...o,
        finding: false,
        message,
        offers: o.offers.filter((x) => x.file_id !== offer.file_id),
      }));
    },
    [target.fileId, onlineLanguage, showFetched]
  );

  // What the track panel offers, or nothing when there is nothing to offer.
  return online.available && target.fileId !== null && onlineLanguage
    ? {
        language: onlineLanguage,
        canChangeLanguage: onlineLanguages.length > 1,
        onChangeLanguage: () =>
          setOnline((o) => ({
            ...o,
            langIndex: (o.langIndex + 1) % onlineLanguages.length,
            message: null,
            offers: [],
          })),
        onFind: () => void findOnline(),
        finding: online.finding,
        message: online.message,
        offers: online.offers,
        onOffer: (offer) => void chooseOffer(offer),
      }
    : null;
}
