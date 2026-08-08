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
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import FocusButton from '../ui/FocusButton';
import FocusInput from '../ui/FocusInput';
import { listNeedsReview } from '../metadata/api';
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
import './fixmatch.css';

interface Props {
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

/**
 * Upper bound on the queue.
 *
 * A cap is unavoidable — the alternative is an unbounded IPC payload — but it
 * now applies to *review candidates* rather than to the file table as a whole,
 * so a library of any size has to have this many unresolved files before
 * anything is hidden.
 */
const QUEUE_LIMIT = 2000;

export default function FixMatch({ onChanged }: Props) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded here rather than handed down, because this is the only screen that
  // wants these rows and it wants exactly them.
  const reload = useCallback(async () => {
    try {
      setFiles(await listNeedsReview(QUEUE_LIMIT));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

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
        // Re-read the queue here, then let Settings update the count and show
        // the message. Both have to happen: this component owns the list and
        // Settings owns the number beside the button that opens it.
        await reload();
        await onChanged(message);
        setOpenKey(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, reload]
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
        <div className="fixmatch-error" onClick={() => setError(null)}>
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
          <FocusButton keepInView="nearest" onSelect={() => setShowIgnored((v) => !v)}>
            {showIgnored ? 'Hide' : 'Show'} ignored ({ignored.length})
          </FocusButton>
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
                <FocusButton
                  keepInView="nearest"
                  disabled={busy}
                  onSelect={() =>
                    void run(async () => {
                      await returnFilesToReview(group.files);
                      return `Restored ${group.files.length} file(s) to the review queue.`;
                    })
                  }
                >
                  Un-ignore
                </FocusButton>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

/**
 * One sentence saying what to do about a refusal.
 *
 * Matched on the scorer's own phrasing rather than on a status code, because
 * the reason is assembled from fragments in `score.ts` and `match.ts` and there
 * is no code to match on. That makes this a little fragile — a reworded
 * fragment falls through to the general case — but the general case is still
 * useful, and the alternative is a second vocabulary to keep in step with the
 * first.
 */
function adviceFor(reason: string): string {
  if (/no provider available/.test(reason)) {
    return 'No way to look this up yet — add a TMDB key under Posters and descriptions.';
  }
  if (/no candidates (returned|scored)/.test(reason)) {
    return 'Nothing came back for this name. Search for it below using the real title.';
  }
  if (/ambiguous vs/.test(reason)) {
    return 'Two releases looked equally likely, so Kinema did not choose. Pick the right one below.';
  }
  if (/tie vs/.test(reason)) {
    return 'A close call between two titles. Check the choice below is the one you meant.';
  }
  if (/year off by/.test(reason)) {
    return 'The name matched but the year did not. Often a re-release or a wrong year in the filename.';
  }
  if (/no candidate year/.test(reason)) {
    return 'Found a likely title but no year to confirm it against. Pick it below if it looks right.';
  }
  if (/candidate has no episodes/.test(reason)) {
    return 'Matched a series with no episode list, so the episodes could not be placed.';
  }
  if (/^title \d+%/.test(reason)) {
    return 'The name was too different from anything found. Search below with the real title.';
  }
  return 'Kinema could not identify this. Search for it below.';
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

  // Reasons are the scorer's own words, and they are genuinely diagnostic —
  // "title 78%, year off by 2" tells you exactly what happened. What they do
  // not do is tell a first-time user what to *do*, and the queue only works if
  // people act on it. So each one gets a plain sentence in front of it, and
  // keeps its own wording underneath for anyone who wants it.
  const reason = group.files.find((f) => f.match_reason)?.match_reason ?? 'not matched yet';
  const advice = adviceFor(reason);



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

  // The summary is the row's own control: it expands the group. Focusable in
  // its own right rather than as a button, because it carries the title and the
  // refusal reason and needs to read as a row, not a control strip.
  const { ref: summaryRef, focused: summaryFocused } = useFocusable<object, HTMLDivElement>({
    onEnterPress: onToggle,
  });

  useEffect(() => {
    if (summaryFocused) {
      summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [summaryFocused, summaryRef]);

  return (
    <div className={`fixmatch-row ${open ? 'open' : ''}`}>
      <div
        ref={summaryRef}
        className={`fixmatch-summary ${summaryFocused ? 'focused' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
      >
        <div className="fixmatch-title">
          {group.title}
          {group.year ? ` (${group.year})` : ''}
          <span className="muted">
            {' '}
            · {group.files.length} file{group.files.length === 1 ? '' : 's'} ·{' '}
            {group.isSeries ? 'series' : 'movie'}
          </span>
        </div>
        <div className="fixmatch-advice">{advice}</div>
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
            <FocusInput
              className="fixmatch-input"
              value={query}
              onChange={setQuery}
              onEnter={() => void search()}
              placeholder="Search for the right title…"
            />
            {/* A button showing its state rather than a checkbox: a checkbox is
                a poor target for a remote, and this screen has to work from
                one. */}
            <FocusButton keepInView="nearest" onSelect={() => setIsSeries((v) => !v)}>
              {isSeries ? 'TV series' : 'Movie'}
            </FocusButton>
            <FocusButton
              className="primary"
              keepInView="nearest"
              disabled={searching || !query.trim()}
              onSelect={() => void search()}
            >
              {searching ? 'Searching…' : 'Search'}
            </FocusButton>
            <FocusButton keepInView="nearest" disabled={busy} onSelect={onIgnore}>
              Ignore these
            </FocusButton>
          </div>

          {searchError && <div className="fixmatch-error">{searchError}</div>}

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
                    <FocusButton
                      className="primary"
                      keepInView="nearest"
                      disabled={busy}
                      onSelect={() => onLink(used.provider, candidate, used.isSeries)}
                    >
                      Link {group.files.length} file{group.files.length === 1 ? '' : 's'}
                    </FocusButton>
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
