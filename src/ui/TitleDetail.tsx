/**
 * Detail page: backdrop hero, metadata, and for series the full episode list.
 *
 * Episodes the provider knows about but the library does not hold are shown
 * greyed out rather than hidden — a season with gaps should look like a season
 * with gaps, not like a shorter season.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useMemo, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import Art from './Art';
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

  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

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

        <button className="back-button" onClick={onBack}>
          ← Back
        </button>

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
                  <PlayButton
                    label="▶ Play"
                    onPlay={() =>
                      onPlayFile(detail.movie_path as string, title.title, detail.movie_file_id)
                    }
                  />
                )}

                {/* A local file always wins: no ads, no network, and it plays
                    through the same mpv pipeline as everything else. */}
                {trailerPath && (
                  <PlayButton
                    label="▶ Trailer"
                    secondary
                    onPlay={() =>
                      // fileId and titleId are both null on purpose. A trailer
                      // is ephemeral: no resume point, no Continue Watching
                      // row, and no writing this file's audio/subtitle choice
                      // into the show's remembered languages.
                      onPlayFile(trailerPath, `${title.title} — Trailer`, null, null)
                    }
                  />
                )}

                {/* Falls back to the browser rather than an in-app embed:
                    whatever ad blocking the user already runs applies there,
                    and this app ships nothing to maintain. */}
                {!trailerPath && shown.trailer_key && (
                  <PlayButton
                    label="Trailer on YouTube ↗"
                    secondary
                    onPlay={() =>
                      void openUrl(
                        `https://www.youtube.com/watch?v=${shown.trailer_key as string}`
                      ).catch((e) => setError(String(e)))
                    }
                  />
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
                    <button
                      key={s}
                      className={season === s ? 'active' : ''}
                      onClick={() => setSeason(s)}
                    >
                      {s === 0 ? 'Specials' : `Season ${s}`}
                    </button>
                  ))}
                </div>
              )}

              <div className="episode-list">
                {visibleEpisodes.map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
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

function PlayButton({
  label,
  onPlay,
  secondary,
}: {
  label: string;
  onPlay: () => void;
  secondary?: boolean;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onPlay });
  return (
    <button
      ref={ref}
      className={`${secondary ? 'btn-secondary' : 'btn-primary'} ${focused ? 'focused' : ''}`}
      onClick={onPlay}
    >
      {label}
    </button>
  );
}

function EpisodeRow({ episode, onPlay }: { episode: Episode; onPlay: () => void }) {
  const available = Boolean(episode.file_path);
  const { ref, focused } = useFocusable({
    focusable: available,
    onEnterPress: onPlay,
  });

  return (
    <div
      ref={ref}
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
