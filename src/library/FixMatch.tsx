/**
 * Manual fix-match: the safety net the strict matching threshold assumes exists.
 *
 * Refusing to guess is only defensible if correcting the refusal is easy, so
 * this is the other half of "a wrong match is worse than no match". Everything
 * the matcher declined to decide ends up here with the reason it gave, next to
 * a search box for deciding it by hand.
 *
 * Works on *groups*, not files, for the same reason matching does: a season
 * fails as a unit, and fixing twelve episodes one at a time would be enough
 * friction that nobody would do it.
 *
 * Provider keys are never held in state here — they are read from the database
 * at the moment of each search and each link. See `loadProviderKeys`.
 */
import { useCallback, useMemo, useState } from 'react';
import type { MediaFile } from './api';
import {
  applyMatch,
  groupFiles,
  ignoreFiles,
  loadProviderKeys,
  providerForKind,
  searchProvider,
  returnFilesToReview,
  type FileGroup,
  type Provider,
} from '../metadata/match';
import type { Candidate } from '../metadata/score';

interface Props {
  /** Every file in the library; this component picks out what needs review. */
  files: MediaFile[];
  /**
   * Reload library data after anything is written, and report what happened.
   * Reporting upward rather than keeping a status line here means there is
   * exactly one message on screen — two independent ones drift apart and end
   * up contradicting each other.
   */
  onChanged: (message: string) => Promise<void>;
}

/** Statuses that mean "the matcher did not resolve this". */
const NEEDS_REVIEW = new Set(['parsed', 'unmatched']);

export default function FixMatch({ files, onChanged }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(
    () => groupFiles(files.filter((f) => NEEDS_REVIEW.has(f.match_status) && !f.missing)),
    [files]
  );

  const ignored = useMemo(
    () => groupFiles(files.filter((f) => f.match_status === 'ignored')),
    [files]
  );

  const run = useCallback(
    async (work: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      try {
        const message = await work();
        await onChanged(message);
        setOpenKey(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged]
  );

  if (pending.length === 0 && ignored.length === 0) {
    return (
      <section className="fixmatch">
        <p className="muted">
          Nothing needs attention — every parsed file is matched. Files the matcher refuses to
          guess at appear here, with the reason it gave.
        </p>
      </section>
    );
  }

  return (
    <section className="fixmatch">
      <header className="fixmatch-head">
        <h2>Needs attention</h2>
        <span className="muted">
          {pending.length} group{pending.length === 1 ? '' : 's'} the matcher would not guess at
        </span>
      </header>

      {error && (
        <div className="library-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {pending.map((group) => (
        <GroupRow
          key={group.key}
          group={group}
          busy={busy}
          open={openKey === group.key}
          onToggle={() => setOpenKey(openKey === group.key ? null : group.key)}
          onLink={(provider, candidate, isSeries) =>
            void run(async () => {
              await applyMatch(
                group.files,
                provider,
                candidate.providerId,
                isSeries,
                await loadProviderKeys(),
                // A hand-picked title is authoritative, so there is no score to
                // record. The reason keeps it auditable: a manual link stays
                // distinguishable from one the scorer made.
                1,
                `manual: “${candidate.title}”${
                  candidate.year ? ` (${candidate.year})` : ''
                } via ${provider}`
              );
              return `Linked ${group.files.length} file(s) to “${candidate.title}”.`;
            })
          }
          onIgnore={() =>
            void run(async () => {
              await ignoreFiles(group.files);
              return `Ignored ${group.files.length} file(s).`;
            })
          }
        />
      ))}

      {ignored.length > 0 && (
        <div className="fixmatch-ignored">
          <button onClick={() => setShowIgnored((v) => !v)}>
            {showIgnored ? 'Hide' : 'Show'} ignored ({ignored.length})
          </button>
          {showIgnored &&
            ignored.map((group) => (
              <div key={group.key} className="fixmatch-row ignored">
                <div className="fixmatch-summary">
                  <div className="fixmatch-title">
                    {group.title}
                    {group.year ? ` (${group.year})` : ''}
                    <span className="muted"> · {group.files.length} file(s)</span>
                  </div>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await returnFilesToReview(group.files);
                      return `Restored ${group.files.length} file(s) to the review queue.`;
                    })
                  }
                >
                  Un-ignore
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function GroupRow({
  group,
  busy,
  open,
  onToggle,
  onLink,
  onIgnore,
}: {
  group: FileGroup;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onLink: (provider: Provider, candidate: Candidate, isSeries: boolean) => void;
  onIgnore: () => void;
}) {
  const [query, setQuery] = useState(group.title);
  const [isSeries, setIsSeries] = useState(group.isSeries);
  const [results, setResults] = useState<Candidate[] | null>(null);
  /**
   * The provider and kind that produced `results`. A provider id is only
   * meaningful for the endpoint it came from, so linking must use these rather
   * than the live controls: toggling "TV series" after a search and then
   * linking would otherwise look up a TV id against the movie endpoint and
   * store whatever came back.
   */
  const [used, setUsed] = useState<{ provider: Provider; isSeries: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // The reason is stored per file but decided per group, so any file's copy is
  // the group's reason.
  const reason = group.files.find((f) => f.match_reason)?.match_reason ?? 'not matched yet';

  const search = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const keys = await loadProviderKeys();
      const provider = providerForKind(isSeries, keys);
      if (!provider) {
        setSearchError('No provider for this kind. Add a TMDB key, or an OMDb key for movies.');
        setResults(null);
        return;
      }
      // The year is deliberately not passed. The parsed year is often the very
      // thing that made the automatic match fail, so filtering by it here would
      // hide the entry being searched for.
      const found = await searchProvider(provider, keys, query.trim(), null, isSeries);
      setResults(found);
      setUsed({ provider, isSeries });
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [query, isSeries]);

  return (
    <div className={`fixmatch-row ${open ? 'open' : ''}`}>
      <div className="fixmatch-summary" onClick={onToggle} role="button" tabIndex={0}>
        <div className="fixmatch-title">
          {group.title}
          {group.year ? ` (${group.year})` : ''}
          <span className="muted">
            {' '}
            · {group.files.length} file{group.files.length === 1 ? '' : 's'} ·{' '}
            {group.isSeries ? 'series' : 'movie'}
          </span>
        </div>
        <div className="fixmatch-reason">{reason}</div>
      </div>

      {open && (
        <div className="fixmatch-panel">
          <ul className="fixmatch-files">
            {group.files.slice(0, 8).map((file) => (
              <li key={file.id} title={file.path}>
                {file.file_name}
              </li>
            ))}
            {group.files.length > 8 && <li className="muted">…and {group.files.length - 8} more</li>}
          </ul>

          <div className="fixmatch-search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
              placeholder="Search for the right title…"
            />
            <label className="fixmatch-kind">
              <input
                type="checkbox"
                checked={isSeries}
                onChange={(e) => setIsSeries(e.target.checked)}
              />
              TV series
            </label>
            <button
              className="primary"
              disabled={searching || !query.trim()}
              onClick={() => void search()}
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
            <button disabled={busy} onClick={onIgnore}>
              Ignore these
            </button>
          </div>

          {searchError && <div className="library-error">{searchError}</div>}

          {results && results.length === 0 && (
            <p className="muted">No results. Try a shorter or differently spelled query.</p>
          )}

          {results && results.length > 0 && used && (
            <>
              {/* Which provider answered is load-bearing, not decoration: the
                  same query against TMDB and TVmaze returns different entries,
                  and it explains a missing backdrop or a thin plot. */}
              <div className="fixmatch-source">
                <span className="provider-pill on">{used.provider}</span>
                <span>
                  {results.length} result{results.length === 1 ? '' : 's'}, searched as a{' '}
                  {used.isSeries ? 'TV series' : 'movie'}
                </span>
              </div>
              <div className="fixmatch-results">
                {results.map((candidate) => (
                  <div key={candidate.providerId} className="fixmatch-candidate">
                    {candidate.posterUrl ? (
                      <img src={candidate.posterUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="poster-placeholder">no poster</div>
                    )}
                    <div className="fixmatch-candidate-text">
                      <div className="fixmatch-candidate-name">
                        {candidate.title}
                        {candidate.year ? ` (${candidate.year})` : ''}
                      </div>
                      {candidate.overview && (
                        <p className="fixmatch-candidate-overview">{candidate.overview}</p>
                      )}
                    </div>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => onLink(used.provider, candidate, used.isSeries)}
                    >
                      Link {group.files.length} file{group.files.length === 1 ? '' : 's'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
