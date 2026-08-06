/**
 * Detail page: backdrop hero, metadata, and for series the full episode list.
 *
 * Episodes the provider knows about but the library does not hold are shown
 * greyed out rather than hidden — a season with gaps should look like a season
 * with gaps, not like a shorter season.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import Art from './Art';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
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
 */
const DETAIL_FOCUS_KEY = 'detail-root';
const DETAIL_PLAY_KEY = 'detail-play';
const DETAIL_FIRST_EPISODE_KEY = 'detail-first-episode';

function runtimeLabel(mins: number | null): string {
  if (!mins) return '';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function TitleDetailView({ title, onPlayFile, onBack }: Props) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [trailerPath, setTrailerPath] = useState<string | null>(null);

  // A movie opens on its Play button, a series on the first episode it actually
  // holds. Landing on Back instead — the first control in the markup — would be
  // technically navigable and useless.
  const { ref, focusKey } = useFocusable({
    focusKey: DETAIL_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: detail?.movie_path ? DETAIL_PLAY_KEY : DETAIL_FIRST_EPISODE_KEY,
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

  const ownedCount = detail?.episodes.filter((e) => e.file_path).length ?? 0;

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
                  parseGenres(title.genres).join(', ') || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {title.overview && <p className="detail-overview">{title.overview}</p>}

              <div className="detail-actions">
                {detail?.movie_path && (
                  <FocusButton
                    focusKey={DETAIL_PLAY_KEY}
                    className="btn-primary"
                    keepInView="page-top"
                    onSelect={() =>
                      onPlayFile(detail.movie_path as string, title.title, detail.movie_file_id)
                    }
                  >
                    ▶ Play
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

function EpisodeRow({
  episode,
  onPlay,
  focusKey,
}: {
  episode: Episode;
  onPlay: () => void;
  focusKey?: string;
}) {
  const available = Boolean(episode.file_path);
  const { ref, focused } = useFocusable({
    focusKey,
    focusable: available,
    onEnterPress: onPlay,
  });

  const element = useRef<HTMLDivElement | null>(null);

  // A season is the one list here long enough to run off the bottom of the
  // screen, and more so at TV scale, where a third as many rows fit. Without
  // this, arrowing down past the fold moves focus to a row you cannot see.
  useEffect(() => {
    if (focused) {
      element.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [focused]);

  return (
    <div
      ref={(node) => {
        ref.current = node;
        element.current = node;
      }}
      className={`episode-row ${focused ? 'focused' : ''} ${available ? '' : 'missing'}`}
      onClick={available ? onPlay : undefined}
    >
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
          {!available && <span className="episode-missing-tag">not in library</span>}
        </div>
        {episode.overview && <p className="episode-overview">{episode.overview}</p>}
      </div>
      <div className="episode-runtime">{runtimeLabel(episode.runtime_mins)}</div>
    </div>
  );
}
