/**
 * The badge rows on a detail page — picture, sound, file — for one file. See
 * `badges.ts` for what each says and where it comes from.
 *
 * Nothing here takes focus: the badges are read, not pressed, and a remote
 * stepping through a dozen tiles on its way from Play to the episode list
 * would be a remote made worse.
 */
import { useEffect, useMemo, useState } from 'react';
import Art from './Art';
import type { Studio } from './api';
import { initParser } from '../library/parse';
import { useFfmpegMissing } from './ffmpegNotice';
import { readRelease, type Release } from '../library/release';
import {
  buildBadges,
  fileFacts,
  releaseNames,
  studioBadge,
  type BadgeRow,
  type FileFacts,
} from './badges';

interface Props {
  /** The file the badges describe: the film, or the episode Play would start. */
  fileId: number | null;
  /** `movie` or `series`: a series' studios are its networks. */
  kind: string;
  /** The title's studios, from TMDB; empty for other providers. */
  studios: Studio[];
}

/** What has been loaded, and for which file — so another file's badges are never shown. */
interface Loaded {
  fileId: number;
  facts: FileFacts;
  release: Release | null;
}

export default function MediaBadges({ fileId, kind, studios }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (fileId === null) return;
    let cancelled = false;
    fileFacts(fileId)
      .then(async (facts) => {
        if (cancelled || !facts) return;
        setLoaded({ fileId, facts, release: null });
        // The file's own facts first; the name needs the parser, which is
        // loaded on demand and may take a moment the first time.
        await initParser();
        if (cancelled) return;
        const release = readRelease(releaseNames(facts), facts.extension);
        setLoaded({ fileId, facts, release });
      })
      .catch((e) => console.warn('badge lookup failed', e));
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const current = loaded !== null && loaded.fileId === fileId ? loaded : null;
  const rows = useMemo(
    () =>
      buildBadges(current?.facts ?? null, current?.release ?? null, studioBadge(kind, studios)),
    [current, kind, studios]
  );
  return <BadgeRows rows={rows} />;
}

/**
 * The rows themselves, for a film's file or a series' season. `heading`
 * names what they describe when it is not obvious — "Season 5 · 8 episodes".
 */
export function BadgeRows({ rows, heading }: { rows: BadgeRow[]; heading?: string }) {
  // Without ffmpeg there may be no rows at all, not merely no picture row.
  const sayNoFfmpeg = useFfmpegMissing() && !rows.some((row) => row.heading === 'Picture');
  if (rows.length === 0 && !sayNoFfmpeg) return null;

  return (
    <div className="media-badges">
      {heading && <div className="media-badges-heading">{heading}</div>}
      {rows.map((row) => (
        <div className="badge-row" key={row.heading}>
          <span className="badge-row-heading">{row.heading}</span>
          <ul className="badge-list">
            {row.badges.map((badge) => (
              <li className="media-badge" key={`${badge.label}|${badge.value}`}>
                <span className="media-badge-label">{badge.label}</span>
                {badge.logos ? (
                  // The names stay, for screen readers and for a logo that
                  // will not load.
                  <span className="media-badge-logos" aria-label={badge.value}>
                    {badge.logos.map((studio) => (
                      <Art
                        key={studio.name}
                        className="media-badge-logo"
                        local={studio.logo_path}
                        remote={studio.logo_url}
                        alt={studio.name}
                        fallback={<span className="media-badge-value">{studio.name}</span>}
                      />
                    ))}
                  </span>
                ) : (
                  <span className="media-badge-value">{badge.value}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {/* Said where the missing rows would be, not only in Settings: nothing
          else on this page hints that they exist. */}
      {sayNoFfmpeg && (
        <p className="media-badges-note">
          The picture and sound details appear here once Kinema can find ffmpeg. Settings, under
          Intro &amp; credits, says how.
        </p>
      )}
    </div>
  );
}
