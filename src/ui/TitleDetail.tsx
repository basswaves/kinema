/**
 * Detail page: backdrop hero, metadata, and for series the full episode list.
 *
 * Episodes the provider knows about but the library does not hold are shown
 * greyed out rather than hidden — a season with gaps should look like a season
 * with gaps, not like a shorter season.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import Art from './Art';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
import {
  episodeLabel,
  firstUnwatchedEpisode,
  setWatched,
  type EpisodeRef,
} from '../player/api';
import {
  findLocalTrailer,
  getTitleDetail,
  parseGenres,
  type Episode,
  type Title,
  type TitleDetail,
} from './api';

interface Props {
  title: Title;
  onPlayFile: (
    path: string,
    label: string,
    fileId: number | null,
    titleId?: number | null
  ) => void;
  onBack: () => void;
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
const DETAIL_FIRST_EPISODE_KEY = 'detail-first-episode';

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

export default function TitleDetailView({ title, onPlayFile, onBack }: Props) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [trailerPath, setTrailerPath] = useState<string | null>(null);
  /** For a series: the episode the Play button will actually start. */
  const [nextUp, setNextUp] = useState<EpisodeRef | null>(null);

  // Land on the primary action. That is Play for a film, and Play for a series
  // too now that it names the episode it will start; only a series with nothing
  // to continue falls back to the episode list. Landing on Back instead — the
  // first control in the markup — would be technically navigable and useless.
  //
  // The old test was `detail?.movie_path`, which is set for a *series* as well
  // (it is the largest file), so the series branch was unreachable.
  const { ref, focusKey } = useFocusable({
    focusKey: DETAIL_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey:
      title.kind === 'series' && !nextUp ? DETAIL_FIRST_EPISODE_KEY : DETAIL_PLAY_KEY,
  });

  // Waits for the load: claiming earlier would land on Back, the only control
  // that exists before the episodes arrive, and then stay there.
  useClaimFocus(DETAIL_FOCUS_KEY, Boolean(detail));

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
      .catch((e) => !cancelled && setError(String(e)));
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
      .catch((e) => console.warn('next episode lookup failed', e));
    return () => {
      cancelled = true;
    };
  }, [title.id, title.kind, detail]);

  const seasons = useMemo(() => {
    if (!detail) return [];
    return [...new Set(detail.episodes.map((e) => e.season))].sort((a, b) => a - b);
  }, [detail]);

  const visibleEpisodes = useMemo(
    () => detail?.episodes.filter((e) => e.season === season) ?? [],
    [detail, season]
  );

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
        setError(String(e));
      }
    },
    [title.id]
  );

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

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="detail" ref={ref}>
        <Art
          className="detail-backdrop"
          local={shown.backdrop_path}
          remote={shown.backdrop_url}
        />
        <div className="detail-scrim" />

        <FocusButton className="back-button" keepInView="page-top" onSelect={onBack}>
          ← Back
        </FocusButton>

        <div className="detail-body">
          <div className="detail-head">
            <Art
              className="detail-poster"
              local={shown.poster_path}
              remote={shown.poster_url}
            />
            <div className="detail-info">
              <h1>{title.title}</h1>
              <div className="detail-meta">
                {[
                  title.year,
                  title.rating ? `★ ${title.rating.toFixed(1)}` : null,
                  runtimeLabel(title.runtime_mins),
                  title.kind === 'series' ? `${ownedCount} episodes in library` : null,
                  title.kind === 'series' && watchedCount > 0
                    ? `${watchedCount} watched`
                    : null,
                  parseGenres(title.genres).join(', ') || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {title.overview && <p className="detail-overview">{title.overview}</p>}

              <div className="detail-actions">
                {/* A series and a film need different questions asked.
                    `detail.movie_path` is the largest file by size, which for a
                    series is whichever episode happens to be biggest — often a
                    feature-length finale. Play has to mean "carry on with this
                    show", and it says which episode so a press is never a
                    surprise. */}
                {title.kind === 'series'
                  ? nextUp && (
                      <FocusButton
                        focusKey={DETAIL_PLAY_KEY}
                        className="btn-primary"
                        keepInView="page-top"
                        onSelect={() =>
                          onPlayFile(
                            nextUp.path,
                            episodeLabel(title.title, nextUp.season, nextUp.episode),
                            nextUp.file_id
                          )
                        }
                      >
                        {`▶ Play S${String(nextUp.season).padStart(2, '0')}E${String(
                          nextUp.episode
                        ).padStart(2, '0')}`}
                      </FocusButton>
                    )
                  : detail?.movie_path && (
                      <FocusButton
                        focusKey={DETAIL_PLAY_KEY}
                        className="btn-primary"
                        keepInView="page-top"
                        onSelect={() =>
                          onPlayFile(
                            detail.movie_path as string,
                            title.title,
                            detail.movie_file_id
                          )
                        }
                      >
                        ▶ Play
                      </FocusButton>
                    )}

                {/* Series get their watched toggle per episode, on the rows.
                    A film is a single file, so this is the only place it can
                    go — and it is what makes "watched" correctable when a
                    stopped playback never reached the completion threshold. */}
                {title.kind !== 'series' && detail?.movie_file_id != null && (
                  <FocusButton
                    className={`btn-secondary ${detail.movie_watched ? 'watched-on' : ''}`}
                    keepInView="page-top"
                    onSelect={() =>
                      void toggleWatched(
                        detail.movie_file_id as number,
                        !detail.movie_watched
                      )
                    }
                  >
                    {detail.movie_watched ? '✓ Watched' : 'Mark watched'}
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
                      onPlayFile(trailerPath, `${title.title} — Trailer`, null, null)
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
                      void openUrl(
                        `https://www.youtube.com/watch?v=${shown.trailer_key as string}`
                      ).catch((e) => setError(String(e)))
                    }
                  >
                    Trailer on YouTube ↗
                  </FocusButton>
                )}
              </div>
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
              {seasons.length > 1 && (
                <div className="season-tabs">
                  {seasons.map((s) => (
                    <FocusButton
                      key={s}
                      className={season === s ? 'active' : ''}
                      keepInView="nearest"
                      onSelect={() => setSeason(s)}
                    >
                      {s === 0 ? 'Specials' : `Season ${s}`}
                    </FocusButton>
                  ))}
                </div>
              )}

              <div className="episode-list">
                {visibleEpisodes.map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
                    focusKey={episode.id === firstOwnedId ? DETAIL_FIRST_EPISODE_KEY : undefined}
                    onToggleWatched={() =>
                      void toggleWatched(episode.file_id as number, !episode.watched)
                    }
                    onPlay={() =>
                      episode.file_path &&
                      onPlayFile(
                        episode.file_path,
                        `${title.title} — S${String(episode.season).padStart(2, '0')}E${String(
                          episode.episode
                        ).padStart(2, '0')}`,
                        episode.file_id
                      )
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

interface EpisodeRowProps {
  episode: Episode;
  onPlay: () => void;
  onToggleWatched: () => void;
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
 * ever satisfy. Same shape as the overlay-nav problem in GOTCHAS.md.
 *
 * Both children are declared in components of their own, because `useFocusable`
 * reads the focus context of the component it is called in: calling them here
 * would parent them to the episode list and leave this container childless.
 */
function PlayableEpisodeRow({ episode, onPlay, onToggleWatched, focusKey }: EpisodeRowProps) {
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
        <EpisodePlayArea episode={episode} onPlay={onPlay} />
        <FocusButton
          className={`watched-toggle ${episode.watched ? 'on' : ''}`}
          keepInView="nearest"
          onSelect={onToggleWatched}
        >
          {episode.watched ? '✓ Watched' : 'Mark watched'}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

/** The part of the row that plays the episode: still, title, overview, runtime. */
function EpisodePlayArea({ episode, onPlay }: { episode: Episode; onPlay: () => void }) {
  const { ref, focused } = useFocusable<object, HTMLDivElement>({ onEnterPress: onPlay });

  // A season is the one list here long enough to run off the bottom of the
  // screen, and more so at TV scale, where a third as many rows fit. Without
  // this, arrowing down past the fold moves focus to a row you cannot see.
  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        <div className="episode-name">{episode.name ?? `Episode ${episode.episode}`}</div>
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
