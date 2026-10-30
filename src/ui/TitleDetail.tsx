/**
 * Detail page: backdrop hero, metadata, and for series the full episode list.
 *
 * Episodes the provider knows about but the library does not hold are shown
 * greyed out rather than hidden — a season with gaps should look like a season
 * with gaps, not like a shorter season.
 */
import { userError } from './errors';
import {
  useFocusable,
  FocusContext,
  setFocus,
  type FocusableComponent,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openLink } from './links';
import Art from './Art';
import DrawnPoster from './DrawnPoster';
import { drawnStyle } from './drawnColour';
import { sizedPoster } from './poster';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { findMatchForLocal, renameLocalTitle } from '../metadata/api';
import { readLocalName } from '../library/localTitle';
import FocusGroup from './FocusGroup';
import MediaBadges, { BadgeRows } from './MediaBadges';
import HeavyFileNotice from './HeavyFileNotice';
import VersionDialog from './VersionDialog';
import WrongTitle from '../library/WrongTitle';
import { useChosenVersion, useTitleVersions } from './useVersions';
import { chooseVersion, pickVersion, readVersions, type Version } from '../library/versions';
import { PlaylistDialog } from './PlaylistPicker';
import type { NewItem } from '../library/playlists';
import { useSeasonBadges } from './seasonBadges';
import { keepOnScreen, useClaimFocus } from './focus';
import {
  episodeLabel,
  firstUnwatchedEpisode,
  getProgress,
  setWatched,
  traktResumeSync,
  type EpisodeRef,
} from '../player/api';
import { resumePoint, resumeShare } from '../player/resume';
import { formatTime } from './format';
import { isMyListKey, toggleMyList, useOnMyList } from '../library/myList';
import {
  findLocalTrailer,
  getTitleDetail,
  parseGenres,
  type Episode,
  type Studio,
  type Title,
  type TitleDetail,
} from './api';

/** What a Play press on this page asks for. */
export interface PlayRequest {
  path: string;
  label: string;
  fileId: number | null;
  /** Omitted means this title; null means on behalf of no title (a trailer). */
  titleId?: number | null;
  episodeName?: string | null;
  fromStart?: boolean;
}

interface Props {
  title: Title;
  onPlayFile: (request: PlayRequest) => void;
  onBack: () => void;
  /**
   * A title kept without a match was sent back to Needs attention; the page
   * it was on no longer exists. Opens the review queue in its place.
   */
  onFindMatch?: () => void;
  /** "Wrong title?" linked the files to another title (its id) or unlinked them (null). */
  onRelinked?: (titleId: number | null) => void;
}

/**
 * Stable keys, so focus can be aimed at this page and land somewhere useful.
 * The container is the target; it forwards to whichever of the two landing
 * spots actually exists on this title.
 *
 * `DETAIL_FIRST_EPISODE_KEY` now names the episode **row**, which is itself a
 * container of two focusables rather than a leaf. That is fine — resolving a
 * preferred child recurses, so aiming at the page descends through the row to
 * its play area. It does mean the key must stay on a row that has a focusable
 * child: a row for an episode the library lacks would end the descent on
 * something that cannot be actioned, which is why `firstOwnedId` below picks a
 * playable one.
 */
const DETAIL_FOCUS_KEY = 'detail-root';
const DETAIL_PLAY_KEY = 'detail-play';
const DETAIL_LIST_KEY = 'detail-my-list';
const DETAIL_VERSION_KEY = 'detail-version';
const DETAIL_FIRST_EPISODE_KEY = 'detail-first-episode';

/**
 * The page's four areas, top to bottom, each a focus group of its own
 * (focusGroups.ts): Back, the buttons under the title (a row landing on Play),
 * the season row (a row landing on the season shown, with "Mark season
 * watched" at its end), and the episode list.
 */
const DETAIL_BACK_KEY = 'detail-back';
const DETAIL_ACTIONS_KEY = 'detail-actions';
const RENAME_INPUT_KEY = 'detail-rename-input';
const RENAME_BUTTON_KEY = 'detail-rename-button';
const DETAIL_SEASONS_KEY = 'detail-seasons';
const DETAIL_EPISODES_KEY = 'detail-episodes';
const DETAIL_AREAS = [DETAIL_BACK_KEY, DETAIL_ACTIONS_KEY, DETAIL_SEASONS_KEY, DETAIL_EPISODES_KEY];

const seasonKey = (s: number) => `detail-season:${s}`;

/**
 * Up and Down between the page's areas, in that fixed order rather than by
 * distance (NAV-MAP, agreed 2026-10-11): Down from Back is Play, never the
 * season nearest below it; Up from the first episode is the season shown,
 * never "Mark season watched" because it happens to sit closer. With one
 * season the row holds only "Mark season watched", and Down from Play goes
 * past it straight to the episodes — it is reached by Up from the first one.
 * Left and Right between areas are nothing (the page holds them).
 */
function resolveDetailArea(
  oneSeason: boolean,
  direction: string,
  from: string,
  siblings: FocusableComponent[]
): FocusableComponent | null {
  if (direction !== 'up' && direction !== 'down') return null;
  const present = DETAIL_AREAS.filter((k) => siblings.some((s) => s.focusKey === k));
  const at = present.indexOf(from);
  if (at < 0) return null;
  let next = direction === 'down' ? at + 1 : at - 1;
  if (direction === 'down' && oneSeason && from === DETAIL_ACTIONS_KEY && present[next] === DETAIL_SEASONS_KEY) {
    next++;
  }
  // Up from Back leaves the page for the top bar, through the page's parent.
  if (next < 0 || next >= present.length) return null;
  return siblings.find((s) => s.focusKey === present[next]) ?? null;
}

const PAGE_STOPS: ('left' | 'right' | 'down')[] = ['left', 'right', 'down'];

/** Stable while the detail loads, so the badges do not rebuild for nothing. */
const NO_STUDIOS: Studio[] = [];

function runtimeLabel(mins: number | null): string {
  if (!mins) return '';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * How far into an episode the resume point sits, as a percentage — or null when
 * there is nothing worth drawing.
 *
 * A watched episode never shows a bar: the tick already says so, and a finished
 * file can hold any position at all (marking one watched by hand leaves whatever
 * position it had). Under 1% is a stray press rather than progress.
 */
function progressPercent(episode: Episode): number | null {
  if (episode.watched) return null;
  const { position_secs: position, duration_secs: total } = episode;
  if (!position || !total || total <= 0) return null;
  const pct = (position / total) * 100;
  return pct >= 1 ? Math.min(pct, 100) : null;
}

export default function TitleDetailView({
  title,
  onPlayFile,
  onBack,
  onFindMatch,
  onRelinked,
}: Props) {
  /**
   * A title kept without a match (`provider = 'local'`, local_title.rs): its
   * name and year are the person's, so they can change them here, and send it
   * back to Needs attention to be matched after all.
   */
  const isLocal = title.provider === 'local';
  /** The name and year as renamed on this page, until the list is read again. */
  const [named, setNamed] = useState<{ title: string; year: number | null } | null>(null);
  const name = named?.title ?? title.title;
  const year = named ? named.year : title.year;
  const [renaming, setRenaming] = useState<{ name: string; year: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [trailerPath, setTrailerPath] = useState<string | null>(null);
  /** For a series: the episode the Play button will actually start. */
  const [nextUp, setNextUp] = useState<EpisodeRef | null>(null);
  /** For a series: whether that has been asked yet — see the landing below. */
  const [nextUpAsked, setNextUpAsked] = useState(false);

  // Land on the primary action. That is Play for a film, and Play for a series
  // too now that it names the episode it will start; only a series with nothing
  // to continue falls back to the episode list. Landing on Back instead — the
  // first control in the markup — would be technically navigable and useless.
  //
  // The old test was `detail?.movie_path`, which is set for a *series* as well
  // (it is the largest file), so the series branch was unreachable.
  const oneSeason = new Set(detail?.episodes.map((e) => e.season)).size <= 1;
  const resolveArea = useCallback(
    (direction: string, from: string, siblings: FocusableComponent[]) =>
      resolveDetailArea(oneSeason, direction, from, siblings),
    [oneSeason]
  );
  const { ref, focusKey } = useFocusable({
    focusKey: DETAIL_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey:
      title.kind === 'series' && !nextUp ? DETAIL_EPISODES_KEY : DETAIL_ACTIONS_KEY,
    nextFocusResolver: resolveArea,
    // Only Up leaves the page (from Back, to the top bar).
    isFocusBoundary: true,
    focusBoundaryDirections: PAGE_STOPS,
  });

  // Waits for the load: claiming earlier would land on Back, the only control
  // that exists before the episodes arrive, and then stay there. For a series
  // it waits for the next episode too: Play only exists once that is known,
  // and on a slow box it came after the episode list, so the page had already
  // landed on the first episode (owner, 2026-10-09). A page: see useClaimFocus.
  useClaimFocus(
    DETAIL_FOCUS_KEY,
    Boolean(detail) && (title.kind !== 'series' || nextUpAsked),
    true
  );

  useEffect(() => {
    let cancelled = false;
    getTitleDetail(title.id)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        // Default to the first season that actually has files.
        const owned = result.episodes.filter((e) => e.file_path);
        setSeason((owned[0] ?? result.episodes[0])?.season ?? null);
      })
      .catch((e) => !cancelled && setError(userError(e)));
    return () => {
      cancelled = true;
    };
  }, [title.id]);

  /**
   * Which episode Play means, for a series.
   *
   * Asked of the database rather than derived from `detail.episodes`, because
   * that list comes from the metadata provider: a title matched with no episode
   * data would leave it empty while the files sit on disk perfectly playable.
   * Re-read after a watched toggle, since marking an episode seen changes the
   * answer.
   */
  useEffect(() => {
    if (title.kind !== 'series') return;
    let cancelled = false;
    firstUnwatchedEpisode(title.id)
      .then((found) => !cancelled && setNextUp(found))
      .catch((e) => console.warn('next episode lookup failed', e))
      // Failed or not, the page lands: on the episode list if there is no Play.
      .finally(() => !cancelled && setNextUpAsked(true));
    return () => {
      cancelled = true;
    };
  }, [title.id, title.kind, detail]);

  /**
   * What Play starts: the next episode for a series, the file for a film. The
   * label names the episode so a press is never a surprise.
   */
  const versionsHere = useTitleVersions(title.id, detail);
  const { versions, chosen } = useChosenVersion(
    title.kind === 'series'
      ? nextUp
        ? versionsHere.groups.get(`${nextUp.season}:${nextUp.episode}`)
        : undefined
      : versionsHere.groups.get('film'),
    versionsHere.choice,
    versionsHere.screen
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** The "Wrong title?" search is up (WrongTitle.tsx). */
  const [wrongOpen, setWrongOpen] = useState(false);
  const { setChoice } = versionsHere;
  const pickedVersion = useCallback(
    (v: Version) => {
      setChoice({ path: v.path, key: v.key });
      void chooseVersion(title.id, v.path, v.key).catch((e) =>
        console.warn('version choice not kept', e)
      );
    },
    [title.id, setChoice]
  );

  const primary = useMemo((): (PlayRequest & { what: string }) | null => {
    // A film or episode here more than once: the version picked (versions.ts).
    const file = chosen ? { path: chosen.path, fileId: chosen.file_id } : null;
    if (title.kind === 'series') {
      if (!nextUp) return null;
      const code = `S${String(nextUp.season).padStart(2, '0')}E${String(nextUp.episode).padStart(2, '0')}`;
      return {
        path: file?.path ?? nextUp.path,
        label: episodeLabel(name, nextUp.season, nextUp.episode),
        fileId: file?.fileId ?? nextUp.file_id,
        episodeName: nextUp.name,
        what: ` ${code}`,
      };
    }
    if (!detail?.movie_path) return null;
    return {
      path: file?.path ?? detail.movie_path,
      label: name,
      fileId: file?.fileId ?? detail.movie_file_id,
      what: '',
    };
  }, [title.kind, name, nextUp, detail, chosen]);

  /**
   * An episode row's Play: where that episode is here more than once, the
   * version with the words picked last time, else the one that fits the screen.
   */
  const playEpisode = useCallback(
    async (request: PlayRequest, season: number, episode: number) => {
      const files = versionsHere.groups.get(`${season}:${episode}`);
      if (files) {
        const v = pickVersion(await readVersions(files), versionsHere.choice, versionsHere.screen);
        if (v) {
          onPlayFile({ ...request, path: v.path, fileId: v.file_id });
          return;
        }
      }
      onPlayFile(request);
    },
    [versionsHere, onPlayFile]
  );

  /**
   * Where that would resume, by the player's own rule — so "Resume 1:02:14"
   * is what the player then does, and "Play from start" is only offered when
   * there is something to start over from.
   */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  /** Or the share of the file, when only Trakt's percentage is known here. */
  const [resumeAtShare, setResumeAtShare] = useState<number | null>(null);
  const primaryFileId = primary?.fileId ?? null;
  useEffect(() => {
    if (primaryFileId === null) return;
    let cancelled = false;
    const read = () =>
      getProgress(primaryFileId)
        .then((progress) => {
          if (cancelled) return;
          setResumeAt(resumePoint(progress));
          setResumeAtShare(resumeShare(progress));
        })
        .catch((e) => console.warn('resume lookup failed', e));
    void read();
    // Where another device stopped, from Trakt — read again if it changed.
    traktResumeSync()
      .then((changed) => {
        if (changed > 0) void read();
      })
      .catch((e) => console.warn('trakt: resume points not read', e));
    return () => {
      cancelled = true;
    };
  }, [primaryFileId]);

  const seasons = useMemo(() => {
    if (!detail) return [];
    // Specials (season 0) last: they are extras, and first in the row they
    // were the first thing a remote landed on.
    return [...new Set(detail.episodes.map((e) => e.season))].sort(
      (a, b) => Number(a === 0) - Number(b === 0) || a - b
    );
  }, [detail]);

  /**
   * Open on the season Play would continue in. The list used to open on the
   * first season whatever you were watching, so Play said S04E05 above a list
   * of season one. Only on arrival: marking a season watched moves the next
   * episode on, and the list must not jump to another season under the
   * remote because of it — nor after a season tab has been pressed.
   */
  const seasonPicked = useRef(false);
  const nextUpSeason = nextUp?.season ?? null;
  useEffect(() => {
    if (nextUpSeason === null || seasonPicked.current) return;
    seasonPicked.current = true;
    setSeason(nextUpSeason);
  }, [nextUpSeason]);

  const visibleEpisodes = useMemo(
    () => detail?.episodes.filter((e) => e.season === season) ?? [],
    [detail, season]
  );

  /**
   * What + Playlist adds (LOCAL-MEDIA.md phase 5): the film, or the episodes
   * of the season shown that are here, in order. A single episode is added
   * by the "+" on its row, or from the player.
   */
  const playlistItems = useMemo((): NewItem[] => {
    if (title.kind === 'series') {
      return visibleEpisodes.flatMap((e) =>
        e.file_id !== null && e.file_path ? [{ path: e.file_path, file_id: e.file_id }] : []
      );
    }
    return detail?.movie_path ? [{ path: detail.movie_path, file_id: detail.movie_file_id }] : [];
  }, [title.kind, visibleEpisodes, detail]);
  /** The playlist dialog, open for these items: the page's, or one episode's. */
  const [playlistFor, setPlaylistFor] = useState<{ items: NewItem[]; what: string } | null>(null);
  const seasonWords = season === 0 ? 'specials' : `season ${season ?? ''}`;
  const [playlistNote, setPlaylistNote] = useState<string | null>(null);

  /**
   * Look for a trailer file on disk, anchored on any video we hold for this
   * title — trailers live beside the media, so without a file there is nowhere
   * to look.
   */
  useEffect(() => {
    const anchor = detail?.movie_path ?? detail?.episodes.find((e) => e.file_path)?.file_path;
    if (!anchor) return;

    let cancelled = false;
    findLocalTrailer(anchor)
      .then((found) => !cancelled && setTrailerPath(found))
      .catch((e) => console.warn('local trailer lookup failed', e));

    return () => {
      cancelled = true;
    };
  }, [detail]);

  /**
   * Flip the watched flag, then re-read the whole detail rather than patching
   * the row in place. One file can back both an episode row and the movie
   * entry, so a local patch would update one of them and leave the other
   * disagreeing with the database.
   */
  const toggleWatched = useCallback(
    async (fileId: number, watched: boolean) => {
      try {
        await setWatched(fileId, watched);
        const fresh = await getTitleDetail(title.id);
        setDetail(fresh);
        // Home re-reads Continue Watching whenever it is shown, so there is
        // nothing to notify here — see the effect in Browse.tsx.
      } catch (e) {
        setError(userError(e));
      }
    },
    [title.id]
  );

  /**
   * Mark every episode of the season on screen, one way or the other. A
   * season caught up on elsewhere used to take a press per episode.
   */
  const ownedInSeason = visibleEpisodes.filter((e) => e.file_path && e.file_id !== null);
  const seasonWatched = ownedInSeason.length > 0 && ownedInSeason.every((e) => e.watched);
  const markSeason = useCallback(async () => {
    try {
      for (const episode of ownedInSeason) {
        if (episode.watched !== !seasonWatched) {
          await setWatched(episode.file_id as number, !seasonWatched);
        }
      }
      setDetail(await getTitleDetail(title.id));
    } catch (e) {
      setError(userError(e));
    }
  }, [ownedInSeason, seasonWatched, title.id]);

  // A film's badges describe its file; a series' describe the season on
  // screen, which opens on the one Play continues in (see seasonBadges.ts).
  const studios = detail?.studios ?? NO_STUDIOS;
  const seasonBadges = useSeasonBadges(title.id, title.kind === 'series' ? season : null, studios);
  const seasonHeading = (() => {
    if (!seasonBadges || !detail) return undefined;
    const owned = detail.episodes.filter(
      (e) => e.season === seasonBadges.season && e.file_path
    ).length;
    const name = seasonBadges.season === 0 ? 'Specials' : `Season ${seasonBadges.season}`;
    return `${name} · ${owned === 1 ? '1 episode' : `${owned} episodes`}`;
  })();

  const ownedCount = detail?.episodes.filter((e) => e.file_path).length ?? 0;
  const watchedCount = detail?.episodes.filter((e) => e.file_path && e.watched).length ?? 0;

  // The landing spot for a series: the first episode in the visible season that
  // is actually playable. Missing episodes are rendered but not focusable, so
  // aiming at one would leave focus nowhere.
  const firstOwnedId = visibleEpisodes.find((e) => e.file_path)?.id ?? null;

  // Artwork comes from the freshly fetched row once it arrives: the title in
  // props is a snapshot from the rail, and may predate the artwork cache
  // filling in.
  const shown = detail?.title ?? title;

  const startRename = useCallback(() => {
    setRenameError(null);
    setRenaming({ name, year: year ? String(year) : '' });
  }, [name, year]);
  // Into the name field once it is drawn, the way a remote would expect.
  // Only when the form opens, not at every keystroke in it.
  const renamingOpen = renaming !== null;
  useEffect(() => {
    if (!renamingOpen) return;
    // A frame later: the field has to be laid out before the focus library
    // can measure it, and the Rename button it replaces has just gone.
    const frame = requestAnimationFrame(() => setFocus(RENAME_INPUT_KEY));
    return () => cancelAnimationFrame(frame);
  }, [renamingOpen]);
  const endRename = useCallback(() => {
    setRenaming(null);
    setRenameError(null);
    requestAnimationFrame(() => setFocus(RENAME_BUTTON_KEY));
  }, []);
  const saveRename = useCallback(async () => {
    if (!renaming) return;
    const read = readLocalName(renaming.name, renaming.year);
    if (typeof read === 'string') {
      setRenameError(read);
      return;
    }
    try {
      await renameLocalTitle(title.id, read.name, read.year);
      setNamed({ title: read.name, year: read.year });
      endRename();
    } catch (e) {
      setRenameError(userError(e));
    }
  }, [renaming, title.id, endRename]);
  const sendToFindMatch = useCallback(async () => {
    try {
      await findMatchForLocal(title.id);
      onFindMatch?.();
    } catch (e) {
      setError(userError(e));
    }
  }, [title.id, onFindMatch]);

  // The row under the title always has My list, so it always has somewhere
  // to land; Play is the current item once it exists.
  const listed = useOnMyList(title.id);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isMyListKey(e)) return;
      e.preventDefault();
      void toggleMyList(title.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [title.id]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="detail" ref={ref}>
        <Art
          className="detail-backdrop"
          local={shown.backdrop_path}
          remote={shown.backdrop_url}
          fallback={<div className="detail-backdrop drawn-backdrop" style={drawnStyle(shown.title, shown.year)} />}
        />
        <div className="detail-scrim" />

        <FocusButton
          focusKey={DETAIL_BACK_KEY}
          className="back-button"
          keepInView="page-top"
          onSelect={onBack}
        >
          ← Back
        </FocusButton>

        <div className="detail-body">
          <div className="detail-head">
            <Art
              className="detail-poster"
              local={shown.poster_path}
              remote={sizedPoster(shown.poster_url, 'w780')}
              fallback={<DrawnPoster className="detail-poster" title={shown.title} year={shown.year} />}
            />
            <div className="detail-info">
              <h1>{name}</h1>
              <div className="detail-meta">
                {/* The age rating boxed, as a disc case or a TV guide shows
                    it, so it reads as a rating rather than one more word. */}
                {shown.certification && (
                  <span className="detail-cert" aria-label={`Rated ${shown.certification}`}>
                    {shown.certification}
                  </span>
                )}
                {[
                  year,
                  runtimeLabel(title.runtime_mins),
                  title.kind === 'series' ? `${ownedCount} episodes in library` : null,
                  title.kind === 'series' && watchedCount > 0
                    ? `${watchedCount} watched`
                    : null,
                  parseGenres(title.genres).join(', ') || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                {/* Scores, each named by where it comes from: IMDb's from
                    its own ratings file, TMDB's from its users. */}
                {shown.imdb_rating ? (
                  <span className="detail-score">
                    <span className="detail-score-source imdb">IMDb</span>
                    {shown.imdb_rating.toFixed(1)}
                  </span>
                ) : null}
                {shown.tomatometer !== null && shown.tomatometer !== undefined ? (
                  <span className="detail-score">
                    <span className="detail-score-source rt">Rotten Tomatoes</span>
                    {shown.tomatometer}%
                  </span>
                ) : null}
                {title.rating ? (
                  <span className="detail-score">
                    <span className="detail-score-source tmdb">TMDB</span>
                    {title.rating.toFixed(1)}
                  </span>
                ) : null}
              </div>
              {title.overview && <p className="detail-overview">{title.overview}</p>}
              {/* Wikipedia's text is CC BY-SA, which asks for a credit where
                  it is used; the rest of a Wikidata title is CC0. */}
              {title.overview && title.provider === 'wikidata' && (
                <p className="detail-credit muted">From Wikipedia · CC BY-SA 4.0</p>
              )}

              <FocusGroup
                kind="row"
                focusKey={DETAIL_ACTIONS_KEY}
                current={primary ? DETAIL_PLAY_KEY : DETAIL_LIST_KEY}
                className="detail-actions"
              >
                {renaming ? (
                  <>
                    <FocusInput
                      focusKey={RENAME_INPUT_KEY}
                      className="detail-rename-input"
                      value={renaming.name}
                      onChange={(v) => setRenaming({ ...renaming, name: v })}
                      onEnter={() => void saveRename()}
                      placeholder="Name"
                    />
                    <FocusInput
                      className="detail-rename-input detail-rename-year"
                      value={renaming.year}
                      onChange={(v) => setRenaming({ ...renaming, year: v })}
                      onEnter={() => void saveRename()}
                      placeholder="Year"
                    />
                    <FocusButton
                      className="btn-primary"
                      keepInView="page-top"
                      onSelect={() => void saveRename()}
                    >
                      Save
                    </FocusButton>
                    <FocusButton className="btn-secondary" keepInView="page-top" onSelect={endRename}>
                      Cancel
                    </FocusButton>
                  </>
                ) : (
                  <>
                {/* A series and a film need different questions asked.
                    `detail.movie_path` is the largest file by size, which for a
                    series is whichever episode happens to be biggest — often a
                    feature-length finale. Play has to mean "carry on with this
                    show", and it says which episode so a press is never a
                    surprise. */}
                {primary && (
                  <FocusButton
                    focusKey={DETAIL_PLAY_KEY}
                    className="btn-primary"
                    keepInView="page-top"
                    onSelect={() => onPlayFile(primary)}
                  >
                    {resumeAt !== null
                      ? `▶ Resume${primary.what} from ${formatTime(resumeAt)}`
                      : resumeAtShare !== null
                        ? `▶ Resume${primary.what} at ${Math.round(resumeAtShare * 100)} %`
                        : `▶ Play${primary.what}`}
                  </FocusButton>
                )}
                {primary && (resumeAt !== null || resumeAtShare !== null) && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() => onPlayFile({ ...primary, fromStart: true })}
                  >
                    Play from start
                  </FocusButton>
                )}
                {/* The same film or episode in more than one file: which one
                    Play uses, by its words, and the list to pick another. */}
                {primary && chosen && versions.length > 1 && (
                  <FocusButton
                    focusKey={DETAIL_VERSION_KEY}
                    className="btn-secondary"
                    keepInView="page-top"
                    label={`Version: ${chosen.words}. Choose another`}
                    onSelect={() => setVersionsOpen(true)}
                  >
                    Version · {chosen.key}
                  </FocusButton>
                )}

                {/* Beside Play: keeping it for later is decided on the same
                    look as playing it now. L does the same from anywhere on
                    the page. */}
                <FocusButton
                  focusKey={DETAIL_LIST_KEY}
                  className={`btn-secondary ${listed ? 'on-list' : ''}`}
                  keepInView="page-top"
                  onSelect={() => void toggleMyList(title.id)}
                >
                  {listed ? '✓ On My list' : '+ My list'}
                </FocusButton>

                {/* Series get their watched toggle per episode, on the rows.
                    A film is a single file, so this is the only place it can
                    go — and it is what makes "watched" correctable when a
                    stopped playback never reached the completion threshold. */}
                {title.kind !== 'series' && primary?.fileId != null && (
                  <FocusButton
                    className={`btn-secondary ${detail?.movie_watched ? 'watched-on' : ''}`}
                    keepInView="page-top"
                    onSelect={() =>
                      void toggleWatched(primary.fileId as number, !detail?.movie_watched)
                    }
                  >
                    {detail?.movie_watched ? '✓ Watched' : 'Mark watched'}
                  </FocusButton>
                )}

                {/* A local file always wins: no ads, no network, and it plays
                    through the same mpv pipeline as everything else. */}
                {trailerPath && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() =>
                      // fileId and titleId are both null on purpose. A trailer
                      // is ephemeral: no resume point, no Continue Watching
                      // row, and no writing this file's audio/subtitle choice
                      // into the show's remembered languages.
                      onPlayFile({ path: trailerPath, label: `${title.title} · Trailer`, fileId: null, titleId: null })
                    }
                  >
                    ▶ Trailer
                  </FocusButton>
                )}

                {/* Falls back to the browser rather than an in-app embed:
                    whatever ad blocking the user already runs applies there,
                    and this app ships nothing to maintain. */}
                {!trailerPath && shown.trailer_key && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() =>
                      void openLink(
                        `https://www.youtube.com/watch?v=${shown.trailer_key as string}`
                      )
                    }
                  >
                    Trailer · opens in your browser ↗
                  </FocusButton>
                )}

                {/* Kept without a match: the name is the person's to change,
                    and the match can still be found (LOCAL-MEDIA.md phase 3). */}
                {isLocal && (
                  <FocusButton
                    focusKey={RENAME_BUTTON_KEY}
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={startRename}
                  >
                    Rename
                  </FocusButton>
                )}
                {isLocal && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() => void sendToFindMatch()}
                  >
                    Find a match
                  </FocusButton>
                )}

                {playlistItems.length > 0 && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() =>
                      setPlaylistFor({
                        items: playlistItems,
                        what:
                          title.kind !== 'series'
                            ? 'the film'
                            : season === 0
                              ? 'the specials'
                              : seasonWords,
                      })
                    }
                  >
                    {title.kind !== 'series'
                      ? '+ Playlist'
                      : `+ Playlist (${seasonWords})`}
                  </FocusButton>
                )}

                {/* Matched by Kinema or by hand, and wrong: fixed here, with the
                    same search as Needs attention (T19). Last in the row: the
                    rarest thing anyone comes to a title's page for. */}
                {!isLocal && onRelinked && (
                  <FocusButton
                    className="btn-secondary"
                    keepInView="page-top"
                    onSelect={() => setWrongOpen(true)}
                  >
                    Wrong title?
                  </FocusButton>
                )}
                  </>
                )}
              </FocusGroup>
              {renameError && <div className="detail-error">{renameError}</div>}
              {playlistNote && <div className="detail-note">{playlistNote}</div>}
              {wrongOpen && onRelinked && (
                <WrongTitle
                  titleId={title.id}
                  name={name}
                  year={year ?? null}
                  isSeries={title.kind === 'series'}
                  onClose={() => setWrongOpen(false)}
                  onDone={onRelinked}
                />
              )}
              {versionsOpen && chosen && (
                <VersionDialog
                  what={primary?.what ? `${name}${primary.what}` : name}
                  versions={versions}
                  current={chosen.file_id}
                  onChoose={pickedVersion}
                  onClose={() => {
                    setVersionsOpen(false);
                    // Back on the button once the page has drawn the new
                    // choice: in the real app the row's own current (Play)
                    // took the ring otherwise.
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => setFocus(DETAIL_VERSION_KEY))
                    );
                  }}
                />
              )}
              {playlistFor && (
                <PlaylistDialog
                  items={playlistFor.items}
                  what={playlistFor.what}
                  onClose={(message) => {
                    setPlaylistFor(null);
                    setPlaylistNote(message);
                  }}
                />
              )}
              {/* Under Play, about the file it would play; only on Android, and
                  only when that file is far above what Android says the
                  device's video chip is made for (heavyFile.ts). */}
              <HeavyFileNotice
                fileId={primary?.fileId ?? null}
                runtimeMins={
                  (title.kind === 'series'
                    ? detail?.episodes.find((e) => e.file_id === primary?.fileId)?.runtime_mins
                    : null) ?? title.runtime_mins
                }
                what={title.kind === 'series' ? 'episode' : 'film'}
              />
              {/* Below the buttons, not above them: three rows of tiles above
                  Play pushed it off a TV screen under a long description, and
                  Play is where a remote lands. */}
              {title.kind === 'series' ? (
                seasonBadges && <BadgeRows rows={seasonBadges.rows} heading={seasonHeading} />
              ) : (
                <MediaBadges
                  fileId={primary?.fileId ?? detail?.movie_file_id ?? null}
                  kind={title.kind}
                  studios={studios}
                />
              )}
            </div>
          </div>

          {error && <div className="detail-error">{error}</div>}

          {/* Not focusable. Nothing here is actionable — this app has no
              "more from this person" to navigate to — and a row of dead
              landing spots between the buttons and the episode list would put
              ten presses in the way of the thing you came for. */}
          {detail && detail.cast.length > 0 && (
            <section className="cast">
              <h2 className="cast-heading">Cast</h2>
              <div className="cast-track">
                {detail.cast.map((person) => (
                  <div className="cast-member" key={`${person.name}-${person.character ?? ''}`}>
                    <div className="cast-photo">
                      <Art
                        local={person.profile_path}
                        remote={person.profile_url}
                        lazy
                        fallback={
                          <div className="cast-photo-empty">
                            {person.name.slice(0, 1).toUpperCase()}
                          </div>
                        }
                      />
                    </div>
                    <div className="cast-name">{person.name}</div>
                    {person.character && <div className="cast-role">{person.character}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {seasons.length > 0 && (
            <>
              <FocusGroup
                kind="row"
                focusKey={DETAIL_SEASONS_KEY}
                current={seasons.length > 1 && season !== null ? seasonKey(season) : undefined}
                focusable={seasons.length > 1 || ownedInSeason.length > 1}
                className="season-bar"
              >
              {seasons.length > 1 && (
                <div className="season-tabs">
                  {seasons.map((s) => (
                    <FocusButton
                      key={s}
                      focusKey={seasonKey(s)}
                      className={season === s ? 'active' : ''}
                      keepInView="nearest"
                      onSelect={() => {
                        seasonPicked.current = true;
                        setSeason(s);
                      }}
                    >
                      {s === 0 ? 'Specials' : `Season ${s}`}
                    </FocusButton>
                  ))}
                </div>
              )}
              {ownedInSeason.length > 1 && (
                <FocusButton
                  className="season-watched"
                  keepInView="nearest"
                  onSelect={() => void markSeason()}
                >
                  {seasonWatched ? 'Mark season as not watched' : '✓ Mark season watched'}
                </FocusButton>
              )}
              </FocusGroup>

              <FocusGroup
                kind="list"
                focusKey={DETAIL_EPISODES_KEY}
                current={firstOwnedId !== null ? DETAIL_FIRST_EPISODE_KEY : undefined}
                focusable={firstOwnedId !== null}
                className="episode-list"
              >
                {visibleEpisodes.map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
                    differences={
                      episode.file_id !== null
                        ? seasonBadges?.exceptions.get(episode.file_id)
                        : undefined
                    }
                    focusKey={episode.id === firstOwnedId ? DETAIL_FIRST_EPISODE_KEY : undefined}
                    onToggleWatched={() =>
                      void toggleWatched(episode.file_id as number, !episode.watched)
                    }
                    onAddToPlaylist={() =>
                      episode.file_path &&
                      setPlaylistFor({
                        items: [{ path: episode.file_path, file_id: episode.file_id }],
                        what:
                          season === 0
                            ? `special ${episode.episode}`
                            : `season ${season ?? ''}, episode ${episode.episode}`,
                      })
                    }
                    onPlay={() =>
                      episode.file_path &&
                      void playEpisode(
                        {
                          path: episode.file_path,
                          label: episodeLabel(name, episode.season, episode.episode),
                          fileId: episode.file_id,
                          episodeName: episode.name,
                        },
                        episode.season,
                        episode.episode
                      )
                    }
                  />
                ))}
              </FocusGroup>
            </>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

interface EpisodeRowProps {
  episode: Episode;
  /** What this episode has that its season mostly does not: `720p`, `SDR`. */
  differences?: string[];
  onPlay: () => void;
  onToggleWatched: () => void;
  onAddToPlaylist: () => void;
  focusKey?: string;
}

function EpisodeRow(props: EpisodeRowProps) {
  // An episode the library does not hold has nothing to play and nothing to
  // mark, so it is not a focus container at all — only a rendered gap. Giving
  // it one would put a landing spot in the focus tree with no reachable child
  // inside it: focus arrives and every further press does nothing, which is the
  // same silent dead end as focus parked on an unmounted component.
  return props.episode.file_path ? (
    <PlayableEpisodeRow {...props} />
  ) : (
    <MissingEpisodeRow episode={props.episode} />
  );
}

/**
 * A row the library actually holds.
 *
 * The row is a focus *container* with two children, not a single focusable:
 * left/right moves between playing the episode and marking it watched, up/down
 * still moves between rows. A focusable nested inside another focusable cannot
 * be reached geometrically — going right requires the candidate's left edge to
 * be past the current element's right edge, which nothing drawn *inside* it can
 * ever satisfy. Same shape as the overlay-nav problem in docs/GOTCHAS.md.
 *
 * Both children are declared in components of their own, because `useFocusable`
 * reads the focus context of the component it is called in: calling them here
 * would parent them to the episode list and leave this container childless.
 */
function PlayableEpisodeRow({
  episode,
  differences,
  onPlay,
  onToggleWatched,
  onAddToPlaylist,
  focusKey,
}: EpisodeRowProps) {
  const { ref, focusKey: rowKey, hasFocusedChild } = useFocusable({
    focusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  return (
    <FocusContext.Provider value={rowKey}>
      <div
        ref={ref}
        className={`episode-row ${hasFocusedChild ? 'row-active' : ''} ${
          episode.watched ? 'watched' : ''
        }`}
      >
        <EpisodePlayArea episode={episode} differences={differences} onPlay={onPlay} />
        {/* A tick that stays out of the way until its row has the ring or
            the pointer — ten identical bright buttons down a season competed
            with the episodes themselves. The word appears with the ring. */}
        <FocusButton
          className={`watched-toggle ${episode.watched ? 'on' : ''}`}
          keepInView="nearest"
          label={episode.watched ? 'Watched. Press to mark as not watched' : 'Mark watched'}
          title={episode.watched ? 'Watched. Press to mark as not watched' : 'Mark watched'}
          onSelect={onToggleWatched}
        >
          <span className="watched-tick" aria-hidden="true">
            ✓
          </span>
          <span className="watched-text">{episode.watched ? 'Watched' : 'Mark watched'}</span>
        </FocusButton>
        {/* Just this episode into a playlist (owner, 2026-10-18): a "+" only,
            as words on every row would look busy, and as quiet as the tick. */}
        <FocusButton
          className="episode-add"
          keepInView="nearest"
          label="Add to a playlist"
          title="Add to a playlist"
          onSelect={onAddToPlaylist}
        >
          +
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

/** The part of the row that plays the episode: still, title, overview, runtime. */
function EpisodePlayArea({
  episode,
  differences,
  onPlay,
}: {
  episode: Episode;
  differences?: string[];
  onPlay: () => void;
}) {
  const { ref, focused } = useFocusable<object, HTMLDivElement>({
    focusKey: `episode:${episode.id}`,
    onEnterPress: onPlay,
  });

  // A season is the one list here long enough to run off the bottom of the
  // screen, and more so at TV scale, where a third as many rows fit. Without
  // this, arrowing down past the fold moves focus to a row you cannot see.
  useEffect(() => {
    if (focused) {
      keepOnScreen(ref.current, 'nearest');
    }
  }, [focused, ref]);

  const percent = progressPercent(episode);

  return (
    <div
      ref={ref}
      className={`episode-main ${focused ? 'focused' : ''}`}
      onClick={onPlay}
    >
      <div className="episode-still">
        <Art
          local={episode.still_path}
          remote={episode.still_url}
          lazy
          fallback={<div className="episode-still-empty" />}
        />
        <span className="episode-number">{episode.episode}</span>
        {episode.watched && (
          <span className="episode-watched-badge" aria-label="watched">
            ✓
          </span>
        )}
        {percent !== null && (
          <span className="episode-progress">
            <span className="episode-progress-fill" style={{ width: `${percent}%` }} />
          </span>
        )}
      </div>
      <div className="episode-text">
        <div className="episode-name">
          {episode.name ?? `Episode ${episode.episode}`}
          {/* Only where this episode is not like its season; a season all
              alike shows none. */}
          {differences?.map((difference) => (
            <span className="episode-difference" key={difference}>
              {difference}
            </span>
          ))}
        </div>
        {episode.overview && <p className="episode-overview">{episode.overview}</p>}
      </div>
      <div className="episode-runtime">{runtimeLabel(episode.runtime_mins)}</div>
    </div>
  );
}

/** A gap in the season: shown, greyed, and out of the focus tree entirely. */
function MissingEpisodeRow({ episode }: { episode: Episode }) {
  return (
    <div className="episode-row missing">
      <div className="episode-main">
        <div className="episode-still">
          <Art
            local={episode.still_path}
            remote={episode.still_url}
            lazy
            fallback={<div className="episode-still-empty" />}
          />
          <span className="episode-number">{episode.episode}</span>
        </div>
        <div className="episode-text">
          <div className="episode-name">
            {episode.name ?? `Episode ${episode.episode}`}
            <span className="episode-missing-tag">not in library</span>
          </div>
          {episode.overview && <p className="episode-overview">{episode.overview}</p>}
        </div>
        <div className="episode-runtime">{runtimeLabel(episode.runtime_mins)}</div>
      </div>
    </div>
  );
}
