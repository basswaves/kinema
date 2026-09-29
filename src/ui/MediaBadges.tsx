/**
 * The badge rows on a detail page — picture, sound, file — for one file. See
 * `badges.ts` for what each says and where it comes from.
 *
 * Nothing here takes focus: the badges are read, not pressed, and a remote
 * stepping through a dozen tiles on its way from Play to the episode list
 * would be a remote made worse.
 */
import { useEffect, useMemo, useState } from 'react';
import { initParser } from '../library/parse';
import { readRelease, type Release } from '../library/release';
import { buildBadges, fileFacts, releaseNames, type FileFacts } from './badges';

interface Props {
  /** The file the badges describe: the film, or the episode Play would start. */
  fileId: number | null;
}

/** What has been loaded, and for which file — so another file's badges are never shown. */
interface Loaded {
  fileId: number;
  facts: FileFacts;
  release: Release | null;
}

export default function MediaBadges({ fileId }: Props) {
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
    () => (current ? buildBadges(current.facts, current.release) : []),
    [current]
  );
  if (rows.length === 0) return null;

  return (
    <div className="media-badges">
      {rows.map((row) => (
        <div className="badge-row" key={row.heading}>
          <span className="badge-row-heading">{row.heading}</span>
          <ul className="badge-list">
            {row.badges.map((badge) => (
              <li className="media-badge" key={`${badge.label}|${badge.value}`}>
                <span className="media-badge-label">{badge.label}</span>
                <span className="media-badge-value">{badge.value}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
