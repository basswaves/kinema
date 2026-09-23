/**
 * Phase 1 library harness.
 *
 * Purpose is validation, not looks: point it at the real library and find out
 * how the scanner and parser cope with actual filenames before any of the
 * browsing UI gets built on top. The number that matters is not "how many
 * parsed" but "how many parsed *wrongly*" — a wrong title silently poisons the
 * TMDB query in Phase 2, while an unparsed file is merely work to do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  addLibraryRoot,
  libraryStats,
  listLibraryRoots,
  listMediaFiles,
  listUnparsed,
  removeLibraryRoot,
  resetParse,
  saveParseResults,
  scanLibrary,
  type LibraryKind,
  type LibraryRoot,
  type LibraryStats,
  type MediaFile,
  type ScanReport,
} from './api';
import { clearParseError, initParser, lastParseError, selfTest } from './parse';
import { parseForLibrary } from './pipeline';
import {
  artworkStats,
  cacheArtwork,
  getSetting,
  listTitles,
  listUnmatched,
  resetMatches,
  unlinkFiles,
  type ArtworkStats,
  type StoredTitle,
} from '../metadata/api';
import {
  backfillTitleDetails,
  loadProviderKeys,
  matchFiles,
  type MatchProgress,
} from '../metadata/match';
import Art from '../ui/Art';
import './library.css';

const PARSE_BATCH = 500;

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function episodeLabel(file: MediaFile): string {
  if (file.parsed_season === null && file.parsed_episode === null) return '—';
  const s = file.parsed_season !== null ? `S${String(file.parsed_season).padStart(2, '0')}` : '';
  const e = file.parsed_episode !== null ? `E${String(file.parsed_episode).padStart(2, '0')}` : '';
  return `${s}${e}` || '—';
}

export default function LibraryView() {
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [titles, setTitles] = useState<StoredTitle[]>([]);
  const [art, setArt] = useState<ArtworkStats | null>(null);
  const [providers, setProviders] = useState({ tmdb: false, omdb: false });
  const [progress, setProgress] = useState<MatchProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s, f, t, a] = await Promise.all([
        listLibraryRoots(),
        libraryStats(),
        listMediaFiles(2000),
        listTitles(),
        artworkStats(),
      ]);
      setRoots(r);
      setStats(s);
      setFiles(f);
      setTitles(t);
      setArt(a);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // Loading the library on mount is exactly the "subscribe to an external
    // system" case the rule exists to distinguish from render-driven state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Whether a key exists, not the key itself — this screen only reports which
  // provider a match run would use. Editing happens in Settings.
  useEffect(() => {
    void (async () => {
      const [tmdb, omdb] = await Promise.all([
        getSetting('tmdb_api_key'),
        getSetting('omdb_api_key'),
      ]);
      setProviders({ tmdb: !!tmdb?.trim(), omdb: !!omdb?.trim() });
    })();
  }, []);

  const runMatch = useCallback(async () => {
    setBusy('Matching…');
    setError(null);
    try {
      const pending = await listUnmatched(2000);
      if (pending.length === 0) {
        setDiagnosis('Nothing to match — parse files first.');
        return;
      }
      // Keys come from the database, never from component state: state can be
      // stale in a closure and also reflects unsaved edits in the input boxes.
      const outcome = await matchFiles(pending, await loadProviderKeys(), setProgress);

      // Pull the new artwork down straight away: matching is the moment the
      // URLs become known, and browsing should not need the network afterwards.
      setBusy('Caching artwork…');
      const art = await cacheArtwork();

      // Newly matched TMDB titles already carry their trailer key, logo and
      // cast from the detail fetch; this only picks up anything that predates
      // each of those.
      setBusy('Fetching title details…');
      const details = await backfillTitleDetails();

      await refresh();
      setDiagnosis(
        `Matched ${outcome.matched} file(s), ${outcome.unmatched} left for review. ` +
          `Cached ${art.stored} image(s)${art.failed ? `, ${art.failed} failed` : ''}. ` +
          `${details.found} title(s) enriched.` +
          (outcome.errors.length ? ` Errors: ${outcome.errors.slice(0, 3).join('; ')}` : '')
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [refresh]);

  /**
   * Undo a match that is wrong. The files go back to the review queue with
   * their parse data intact, so they can be pointed at the right title by hand.
   * This is the other half of the strict threshold: refusing to guess only
   * helps if a guess that slipped through can be taken back.
   */
  const unlinkTitle = useCallback(
    async (title: StoredTitle) => {
      const owned = files.filter((f) => f.title_id === title.id);
      if (owned.length === 0) return;
      setBusy('Unlinking…');
      setError(null);
      try {
        // Held, so the next launch's matcher does not simply put it back.
        await unlinkFiles(
          owned.map((f) => f.id),
          `unlinked by hand from “${title.title}”`
        );
        await refresh();
        setDiagnosis(
          `Unlinked ${owned.length} file(s) from “${title.title}” — they are back under Needs attention.`
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [files, refresh]
  );

  const runTrailers = useCallback(async () => {
    setBusy('Fetching title details…');
    setError(null);
    try {
      const result = await backfillTitleDetails();
      await refresh();
      setDiagnosis(
        result.found === 0 && result.none === 0
          ? 'Every TMDB title already has its trailer, logo and cast looked up.'
          : `Enriched ${result.found} title(s); ${result.none} had nothing to add.` +
              (result.errors.length ? ` Errors: ${result.errors.slice(0, 3).join('; ')}` : '')
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const runCacheArtwork = useCallback(async () => {
    setBusy('Caching artwork…');
    setError(null);
    try {
      const result = await cacheArtwork();
      await refresh();
      setDiagnosis(
        result.stored === 0 && result.failed === 0
          ? 'Artwork cache is already complete.'
          : `Cached ${result.stored} image(s)${result.failed ? `, ${result.failed} failed` : ''}.`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const pickFolder = useCallback(
    async (kind: LibraryKind) => {
      setError(null);
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected !== 'string') return;
        await addLibraryRoot(selected, kind);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh]
  );

  const runScan = useCallback(async () => {
    setBusy('Scanning…');
    setError(null);
    try {
      setReport(await scanLibrary());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const runParse = useCallback(async () => {
    setBusy('Parsing…');
    setError(null);
    clearParseError();
    try {
      await initParser();
      let total = 0;
      // Batched so a large library reports progress and never builds one
      // enormous IPC payload.
      for (;;) {
        const batch = await listUnparsed(PARSE_BATCH);
        if (batch.length === 0) break;

        const payloads = batch.map((file) => parseForLibrary(file, roots));
        await saveParseResults(payloads);

        total += batch.length;
        setBusy(`Parsing… ${total}`);
        if (batch.length < PARSE_BATCH) break;
      }
      await refresh();
      if (lastParseError) setDiagnosis(`Parser threw — ${lastParseError}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh, roots]);

  const runReparse = useCallback(async () => {
    setBusy('Resetting…');
    try {
      await resetParse();
      await refresh();
      await runParse();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [refresh, runParse]);

  const visible = useMemo(
    () => (onlyProblems ? files.filter((f) => !f.parsed_title) : files),
    [files, onlyProblems]
  );

  const problemCount = useMemo(
    () => files.filter((f) => !f.parsed_title).length,
    [files]
  );

  return (
    <div className="library-root">
      <header className="library-header">
        <h1>Library</h1>
        <div className="library-actions">
          <button onClick={() => void pickFolder('movies')}>Add movies folder</button>
          <button onClick={() => void pickFolder('tv')}>Add TV folder</button>
          <button className="primary" disabled={!!busy} onClick={() => void runScan()}>
            {busy === 'Scanning…' ? 'Scanning…' : 'Scan'}
          </button>
          <button disabled={!!busy || !stats?.unparsed} onClick={() => void runParse()}>
            {busy?.startsWith('Parsing') ? busy : `Parse${stats?.unparsed ? ` (${stats.unparsed})` : ''}`}
          </button>
          <button disabled={!!busy || !stats?.total} onClick={() => void runReparse()}>
            Re-parse all
          </button>
          <button className="primary" disabled={!!busy} onClick={() => void runMatch()}>
            {progress
              ? `Matching ${progress.groupsDone}/${progress.groupsTotal}…`
              : 'Match metadata'}
          </button>
          <button
            disabled={!!busy || titles.length === 0}
            onClick={() =>
              void (async () => {
                await resetMatches();
                await refresh();
                await runMatch();
              })()
            }
          >
            Re-match all
          </button>
          <button
            disabled={!!busy || titles.length === 0}
            title="Download any poster, backdrop or still that is not cached yet"
            onClick={() => void runCacheArtwork()}
          >
            {busy === 'Caching artwork…'
              ? busy
              : `Cache artwork${art?.files ? ` (${art.files})` : ''}`}
          </button>
          <button
            disabled={!!busy || titles.length === 0}
            title="Re-fetch TMDB trailer keys, logos and cast for titles matched before they were stored"
            onClick={() => void runTrailers()}
          >
            {busy === 'Fetching title details…' ? busy : 'Fetch title details'}
          </button>
          <button
            onClick={() => void selfTest().then((r) => setDiagnosis(`Self-test: ${r}`))}
          >
            Self-test parser
          </button>
        </div>
      </header>

      {/* Read-only: which provider a match run will actually use. The keys
          themselves are edited in Settings — this is here because it changes
          what "Match metadata" below will do, and that is worth seeing next to
          the button rather than one screen away. */}
      <div className="provider-status">
        {[
          ['TMDB', providers.tmdb, 'movies + TV, posters/backdrops/stills'],
          ['TVmaze', true, 'TV fallback, keyless'],
          ['OMDb', providers.omdb, 'movie fallback, no backdrops'],
        ].map(([name, active, note]) => (
          <span key={String(name)} className={`provider-pill ${active ? 'on' : 'off'}`}>
            {String(name)} {active ? '✓' : '—'}
            <em>{String(note)}</em>
          </span>
        ))}
      </div>

      {progress && progress.currentTitle && (
        <div className="library-diagnosis">
          Matching “{progress.currentTitle}” — {progress.groupsDone}/{progress.groupsTotal} groups,{' '}
          {progress.matched} matched, {progress.unmatched} for review
        </div>
      )}

      {diagnosis && (
        <div className="library-diagnosis" onClick={() => setDiagnosis(null)}>
          {diagnosis}
        </div>
      )}

      {error && (
        <div className="library-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}


      <section className="library-roots">
        {roots.length === 0 && <p className="muted">No folders yet. Add a movies or TV folder to begin.</p>}
        {roots.map((root) => (
          <div key={root.id} className="root-row">
            <span className={`kind kind-${root.kind}`}>{root.kind}</span>
            <span className="root-path" title={root.path}>
              {root.path}
            </span>
            <span className="muted">{root.file_count} files</span>
            <button
              onClick={async () => {
                await removeLibraryRoot(root.id);
                await refresh();
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      {stats && (
        <section className="library-stats">
          <div><strong>{stats.total}</strong><span>files</span></div>
          <div><strong>{stats.parsed}</strong><span>parsed</span></div>
          <div><strong>{stats.unparsed}</strong><span>unparsed</span></div>
          <div className={problemCount ? 'warn' : ''}><strong>{problemCount}</strong><span>no title</span></div>
          <div className={stats.missing ? 'warn' : ''}><strong>{stats.missing}</strong><span>missing</span></div>
          <div><strong>{formatBytes(stats.total_bytes)}</strong><span>total</span></div>
        </section>
      )}

      {report && (
        <section className="scan-report">
          Scanned {report.roots_scanned} root(s) in {report.duration_ms} ms — {report.files_seen} seen,{' '}
          {report.files_added} added, {report.files_updated} changed, {report.files_unchanged} unchanged,{' '}
          {report.files_missing} missing
          {report.errors.length > 0 && (
            <details>
              <summary>{report.errors.length} error(s)</summary>
              <ul>
                {report.errors.slice(0, 30).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {titles.length > 0 && (
        <section className="titles-strip">
          {titles.map((title) => (
            <div key={title.id} className="title-card" title={title.overview ?? ''}>
              <Art
                local={title.poster_path}
                remote={title.poster_url}
                lazy
                fallback={<div className="poster-placeholder">no poster</div>}
              />
              <div className="title-card-name">{title.title}</div>
              <div className="title-card-meta">
                {title.year ?? '—'} · {title.file_count} file{title.file_count === 1 ? '' : 's'}
                {title.rating ? ` · ★ ${title.rating}` : ''}
              </div>
              {/* Which provider produced this title. Without it, "no backdrop"
                  is ambiguous between "provider has none" and "wrong provider
                  was used". */}
              <div className="title-card-provider">via {title.provider}</div>
              {!title.backdrop_url && <div className="title-card-warn">no backdrop</div>}
              {title.file_count > 0 && (
                <button
                  className="title-card-unlink"
                  disabled={!!busy}
                  onClick={() => void unlinkTitle(title)}
                >
                  Wrong? Unlink
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="library-table-wrap">
        <div className="table-toolbar">
          <label>
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            Show only files with no title ({problemCount})
          </label>
          <span className="muted">{visible.length} shown</span>
        </div>

        <table className="library-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Parsed title</th>
              <th>Year</th>
              <th>Ep</th>
              <th>Source</th>
              <th>Match</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((file) => (
              <tr key={file.id} className={!file.parsed_title ? 'problem' : ''}>
                <td className="file-cell">
                  <div className="file-name" title={file.path}>{file.file_name}</div>
                  <div className="file-dir">{file.parent_dir}</div>
                </td>
                <td>
                  {file.matched_title ? (
                    <>
                      <div>{file.matched_title}</div>
                      {file.episode_name && <div className="episode-name">{file.episode_name}</div>}
                    </>
                  ) : (
                    file.parsed_title ?? <em className="muted">no title</em>
                  )}
                </td>
                <td>{file.parsed_year ?? '—'}</td>
                <td>{episodeLabel(file)}</td>
                <td>
                  {file.parsed_from ? (
                    <span className={`src src-${file.parsed_from}`}>{file.parsed_from}</span>
                  ) : (
                    '—'
                  )}
                </td>
                {/* The reason a match was refused is the whole diagnostic
                    value of this screen — never hide it. */}
                <td className="match-cell">
                  <span className={`match-status match-${file.match_status}`}>
                    {file.match_status}
                    {file.match_confidence !== null
                      ? ` ${(file.match_confidence * 100).toFixed(0)}%`
                      : ''}
                  </span>
                  {file.match_reason && <div className="match-reason">{file.match_reason}</div>}
                </td>
                <td className="muted">{formatBytes(file.size_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {visible.length === 0 && <p className="muted center">Nothing to show yet — scan a folder first.</p>}
      </section>
    </div>
  );
}
