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
import { count } from '../ui/format';
import { describeFailure } from '../metadata/reach';
import { userError, withoutQueries } from '../ui/errors';
import { setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FocusButton from '../ui/FocusButton';
import FocusInput from '../ui/FocusInput';
import { keepOnScreen } from '../ui/focus';
import { openLink } from '../ui/links';
import { addWithoutMatch, findLocalPictures, listNeedsReview } from '../metadata/api';
import { readLocalName, shelfOf } from './localTitle';
import { plainReason } from './plainReason';
import type { MediaFile } from './api';
import {
  applyMatch,
  groupFiles,
  ignoreFiles,
  loadProviderKeys,
  providerForKind,
  searchProvider,
  returnFilesToReview,
  searchableName,
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

/**
 * Upper bound on the queue.
 *
 * A cap is unavoidable — the alternative is an unbounded IPC payload — but it
 * now applies to *review candidates* rather than to the file table as a whole,
 * so a library of any size has to have this many unresolved files before
 * anything is hidden.
 */
const QUEUE_LIMIT = 2000;

/**
 * The website's guide to the names Kinema understands. Most refusals are a
 * name the parser could not read, and renaming is often quicker than a search.
 */
const FILE_NAMES_GUIDE = 'https://basswaves.github.io/kinema/file-names.html';

function GuideLink() {
  return (
    <FocusButton
      className="fixmatch-guide"
      keepInView="nearest"
      onSelect={() => void openLink(FILE_NAMES_GUIDE)}
    >
      How Kinema reads file names ↗
    </FocusButton>
  );
}

/** A group's row, so the ring can be put on it. */
const rowKey = (group: FileGroup) => `fixmatch-row:${group.key}`;

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
      setError(userError(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const pending = useMemo(
    () =>
      groupFiles(
        // The queue's rows are exactly the work plus the ignored files — the
        // backend decides what counts as work (lifecycle::NEEDS_ATTENTION),
        // so this only separates the two.
        files.filter((f) => f.match_status !== 'ignored'),
        { includeUntitled: true }
      ),
    [files]
  );

  const ignored = useMemo(
    () => groupFiles(files.filter((f) => f.match_status === 'ignored')),
    [files]
  );

  /**
   * Set when a group was dealt with: its row goes, and the ring with it, to
   * wherever the focus library falls back to — a control far up the page.
   * By remote the next group is what comes next, so the ring goes there.
   */
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (pending.length > 0) setFocus(rowKey(pending[0]));
  }, [pending]);

  const run = useCallback(
    async (work: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      try {
        const message = await work();
        refocus.current = true;
        // Re-read the queue here, then let Settings update the count and show
        // the message. Both have to happen: this component owns the list and
        // Settings owns the number beside the button that opens it.
        await reload();
        await onChanged(message);
        setOpenKey(null);
      } catch (e) {
        // Nothing left the queue, or it is unknown what did: the ring stays.
        refocus.current = false;
        setError(await describeFailure(e));
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
          Nothing needs attention: every file found has its title. Files Kinema will not guess
          at appear here, with the reason.
        </p>
        <GuideLink />
      </section>
    );
  }

  return (
    <section className="fixmatch">
      <header className="fixmatch-head">
        <h2>Needs attention</h2>
        <span className="muted">
          {pending.length} title{pending.length === 1 ? '' : 's'} Kinema would not guess at
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
              return `Linked ${count(group.files.length, 'file')} to “${candidate.title}”.`;
            })
          }
          onIgnore={() =>
            void run(async () => {
              await ignoreFiles(group.files);
              return `Ignored ${count(group.files.length, 'file')}.`;
            })
          }
          onKeep={(name, year, isSeries) =>
            void run(async () => {
              await addWithoutMatch(
                group.files.map((f) => f.id),
                isSeries,
                name,
                year
              );
              // Its picture: one beside the files, else a frame from the file.
              // In the background; the next visit to the shelf shows it.
              void findLocalPictures().catch((e: unknown) => console.warn('local pictures:', e));
              return `Added “${name}” to ${shelfOf(isSeries)} without a match.`;
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
                    <span className="muted"> · {count(group.files.length, 'file')}</span>
                  </div>
                </div>
                <FocusButton
                  keepInView="nearest"
                  disabled={busy}
                  onSelect={() =>
                    void run(async () => {
                      await returnFilesToReview(group.files);
                      return `Restored ${count(group.files.length, 'file')} to Needs attention.`;
                    })
                  }
                >
                  Un-ignore
                </FocusButton>
              </div>
            ))}
        </div>
      )}

      {/* Last, so Down from the Review button still lands on the first group. */}
      <GuideLink />
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
  if (/^added without a match, then sent back/.test(reason)) {
    return 'You sent this back from its own title to find a match. Search for it below, or add it without one again.';
  }
  if (/^unlinked by hand/.test(reason)) {
    return 'You unlinked this from a wrong title. It waits here until you pick the right one below.';
  }
  // Refused by a version of Kinema that had nothing to look movies up with.
  if (/no provider available/.test(reason)) {
    return 'Kinema had no way to look this up when it was scanned. Search for it below.';
  }
  // A lookup that got no answer decided nothing: it is not "could not identify".
  if (/could not be reached|did not answer, but answers now|error sending request/.test(reason)) {
    return 'Kinema could not reach the service it looks titles up with when this was scanned. The next scan asks again, or search below.';
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
  onKeep,
}: {
  group: FileGroup;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onLink: (provider: Provider, candidate: Candidate, isSeries: boolean) => void;
  onIgnore: () => void;
  /** Keep the group as a title of its own, under this name, year and kind. */
  onKeep: (name: string, year: number | null, isSeries: boolean) => void;
}) {
  // An untitled group is named after its file; searched as it is, "F1 [2025]"
  // sent its brackets and year to the provider as words (T13).
  const [query, setQuery] = useState(group.untitled ? searchableName(group.title) : group.title);
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
  // Named from the file to start with (the parsed title, or the file name when
  // there was none) — editable, since a file name is rarely what anyone calls
  // a home video.
  const [localName, setLocalName] = useState(group.title);
  const [localYear, setLocalYear] = useState(group.year ? String(group.year) : '');
  const [localError, setLocalError] = useState<string | null>(null);
  const keep = useCallback(() => {
    const read = readLocalName(localName, localYear);
    if (typeof read === 'string') {
      setLocalError(read);
      return;
    }
    setLocalError(null);
    onKeep(read.name, read.year, isSeries);
  }, [localName, localYear, isSeries, onKeep]);

  // Reasons are genuinely diagnostic — "title 78%, year off by 2" tells you
  // exactly what happened. What they do not do is tell a first-time user what
  // to *do*, and the queue only works if people act on it. So each one gets a
  // plain sentence in front of it, and its facts underneath in plain words
  // (`plainReason`; the advice still matches on the scorer's own wording).
  const reason = group.untitled
    ? 'no title in the file name or its folders'
    : withoutQueries(group.files.find((f) => f.match_reason)?.match_reason ?? 'not matched yet');
  const advice = group.untitled
    ? 'Kinema could not read a title from this file or the folders around it. Search for what it is below.'
    : adviceFor(reason);



  const search = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const keys = await loadProviderKeys();
      const provider = providerForKind(isSeries, keys);
      // The year is deliberately not passed. The parsed year is often the very
      // thing that made the automatic match fail, so filtering by it here would
      // hide the entry being searched for.
      const found = await searchProvider(provider, keys, query.trim(), null, isSeries);
      setResults(found);
      setUsed({ provider, isSeries });
    } catch (e) {
      setSearchError(await describeFailure(e));
    } finally {
      setSearching(false);
    }
  }, [query, isSeries]);

  // The summary is the row's own control: it expands the group. Focusable in
  // its own right rather than as a button, because it carries the title and the
  // refusal reason and needs to read as a row, not a control strip.
  const { ref: summaryRef, focused: summaryFocused } = useFocusable<object, HTMLDivElement>({
    focusKey: rowKey(group),
    onEnterPress: onToggle,
  });

  useEffect(() => {
    if (summaryFocused) {
      summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [summaryFocused, summaryRef]);

  // Opened by remote, what opened is below the row and was left off screen
  // (TV-FEEL N8): bring the opened row on screen, from its title down as far
  // as fits, once it has been drawn.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => keepOnScreen(rowRef.current, 'nearest'));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div ref={rowRef} className={`fixmatch-row ${open ? 'open' : ''}`}>
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
        <div className="fixmatch-reason">{plainReason(reason)}</div>
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

          {/* For what no database will ever list — a home video, a fan edit.
              Nothing is looked up or guessed: the name is the person's, so the
              matching rule is untouched (LOCAL-MEDIA.md phase 3). Kind follows
              the Movie / TV series button above. */}
          <div className="fixmatch-local">
            <p className="muted">
              Not in any database? Keep it under its own name, with no picture or description.
              Find a match stays on its page.
            </p>
            <div className="fixmatch-search">
              <FocusInput
                className="fixmatch-input"
                value={localName}
                onChange={setLocalName}
                onEnter={keep}
                placeholder="Name"
              />
              <FocusInput
                className="fixmatch-input fixmatch-year"
                value={localYear}
                onChange={setLocalYear}
                onEnter={keep}
                placeholder="Year"
              />
              <FocusButton keepInView="nearest" disabled={busy} onSelect={keep}>
                Add without a match
              </FocusButton>
            </div>
            {localError && <div className="fixmatch-error">{localError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
