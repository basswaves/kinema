/**
 * Settings — the user-facing half of what used to be the Library dev tab.
 *
 * The split is by audience, not by subject. Anything someone who just wants to
 * watch something might need is here: where the files are, whether the library
 * is current, the provider keys, the two playback switches, and the review
 * queue for matches that were refused. The stage-by-stage controls and the raw
 * file table are still available, one click away under Developer tools, because
 * re-parsing without re-scanning genuinely matters when iterating on rules
 * against a NAS — but they are no longer the front door.
 *
 * Every control here is a `FocusButton` or `FocusInput`. This screen has to be
 * operable from the sofa: it is where TV mode itself is turned on, and a
 * settings screen you can only reach with a mouse is the one screen guaranteed
 * to be needed when no mouse is present.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { useClaimFocus } from './focus';
import { setTvMode, useTvMode } from './tv';
import {
  addLibraryRoot,
  listLibraryRoots,
  listMediaFiles,
  removeLibraryRoot,
  type LibraryKind,
  type LibraryRoot,
  type MediaFile,
} from '../library/api';
import {
  getLastScanSummary,
  runScanPipeline,
  useScanStatus,
  type ScanSummary,
} from '../library/pipeline';
import {
  artworkStats,
  cacheArtwork,
  clearArtworkCache,
  getSetting,
  setSetting,
  type ArtworkStats,
} from '../metadata/api';
import { buildNfoExports, writeNfo } from '../metadata/nfo';
import FixMatch from '../library/FixMatch';
import LibraryView from '../library/LibraryView';

const SETTINGS_FOCUS_KEY = 'settings-root';

/** Statuses that mean the matcher did not resolve a file. Matches FixMatch. */
const NEEDS_REVIEW = new Set(['parsed', 'unmatched']);

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function summaryLine(s: ScanSummary): string {
  const parts = [
    `${s.filesAdded} new file(s)`,
    `${s.matched} matched`,
    `${s.unmatched} left for review`,
  ];
  if (s.artworkStored) parts.push(`${s.artworkStored} image(s) cached`);
  if (s.trailersFound) parts.push(`${s.trailersFound} trailer(s)`);
  return parts.join(' · ');
}

export default function Settings() {
  const { ref, focusKey } = useFocusable({
    focusKey: SETTINGS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  useClaimFocus(SETTINGS_FOCUS_KEY, true);

  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [art, setArt] = useState<ArtworkStats | null>(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [omdbKey, setOmdbKey] = useState('');
  const [mdblistKey, setMdblistKey] = useState('');
  const [autoSkip, setAutoSkip] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'review' | 'developer'>('none');
  const [writingNfo, setWritingNfo] = useState(false);

  const tvMode = useTvMode();
  const scan = useScanStatus();

  const refresh = useCallback(async () => {
    try {
      const [r, f, a] = await Promise.all([listLibraryRoots(), listMediaFiles(2000), artworkStats()]);
      setRoots(r);
      setFiles(f);
      setArt(a);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Keys live in the database in app data, never in the repo.
  useEffect(() => {
    void (async () => {
      setTmdbKey((await getSetting('tmdb_api_key')) ?? '');
      setOmdbKey((await getSetting('omdb_api_key')) ?? '');
      setMdblistKey((await getSetting('mdblist_api_key')) ?? '');
      setAutoSkip((await getSetting('skip_mode')) === 'auto');
    })();
  }, []);

  const needsReview = files.filter(
    (f) => NEEDS_REVIEW.has(f.match_status) && !f.missing && f.parsed_title
  ).length;

  const scanNow = useCallback(async () => {
    setError(null);
    setNote(null);
    const outcome = await runScanPipeline();
    if (outcome.status === 'failed') setError(outcome.error);
    else if (outcome.status === 'skipped')
      setNote(
        outcome.reason === 'no-roots'
          ? 'Add a folder first — there is nothing to scan.'
          : 'A scan is already running.'
      );
    else {
      setNote(summaryLine(outcome.summary));
      if (outcome.summary.parseError) setError(`Parser threw — ${outcome.summary.parseError}`);
    }
    await refresh();
  }, [refresh]);

  const pickFolder = useCallback(
    async (kind: LibraryKind) => {
      setError(null);
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected !== 'string') return;
        await addLibraryRoot(selected, kind);
        await refresh();
        setNote(`Added ${selected}. Scan to pick up its files.`);
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh]
  );

  const saveKeys = useCallback(async () => {
    try {
      await setSetting('tmdb_api_key', tmdbKey.trim());
      await setSetting('omdb_api_key', omdbKey.trim());
      await setSetting('mdblist_api_key', mdblistKey.trim());
      setNote('Keys saved. They apply to matches run from now on — re-match to redo existing ones.');
    } catch (e) {
      setError(String(e));
    }
  }, [tmdbKey, omdbKey, mdblistKey]);

  const exportNfo = useCallback(async (overwrite: boolean) => {
    setError(null);
    setNote(null);
    setWritingNfo(true);
    try {
      const report = await writeNfo(await buildNfoExports(), overwrite);
      const parts = [`Wrote ${report.written} NFO file(s)`];
      if (report.skipped) parts.push(`${report.skipped} already existed and were left alone`);
      if (report.errors.length) parts.push(`${report.errors.length} failed`);
      setNote(`${parts.join(' · ')}.`);
      // Only the first few: a read-only share fails once per file, and a
      // thousand identical lines say nothing the first three did not.
      if (report.errors.length) setError(report.errors.slice(0, 3).join(' · '));
    } catch (e) {
      setError(String(e));
    } finally {
      setWritingNfo(false);
    }
  }, []);

  const last = getLastScanSummary();

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="settings" ref={ref}>
        <h1 className="settings-title">Settings</h1>

        {error && (
          <div className="settings-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {note && (
          <div className="settings-note" onClick={() => setNote(null)}>
            {note}
          </div>
        )}

        {/* ---- library ---- */}
        <section className="settings-section">
          <h2>Library</h2>
          {roots.length === 0 ? (
            <p className="muted">
              No folders yet. Add one and the app will scan it now and at every start.
            </p>
          ) : (
            <ul className="settings-roots">
              {roots.map((root) => (
                <li key={root.id}>
                  <span className={`root-kind ${root.kind}`}>{root.kind}</span>
                  <span className="root-path">{root.path}</span>
                  <span className="muted">{root.file_count} file(s)</span>
                  <FocusButton
                    className="settings-remove"
                    onSelect={() =>
                      void removeLibraryRoot(root.id)
                        .then(refresh)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    Remove
                  </FocusButton>
                </li>
              ))}
            </ul>
          )}

          <div className="settings-row">
            <FocusButton className="btn-secondary" onSelect={() => void pickFolder('movies')}>
              Add movies folder
            </FocusButton>
            <FocusButton className="btn-secondary" onSelect={() => void pickFolder('tv')}>
              Add TV folder
            </FocusButton>
            <FocusButton className="btn-primary" onSelect={() => void scanNow()}>
              {scan ? `${scan.stage}…` : 'Scan now'}
            </FocusButton>
          </div>

          {scan && (
            <p className="settings-progress">
              {scan.stage}
              {scan.detail ? ` — ${scan.detail}` : ''}
            </p>
          )}
          {!scan && last && <p className="muted">Last scan: {summaryLine(last)}</p>}
          <p className="muted">
            Scanning runs automatically once at every start. It never reads file contents — a file
            is identified by its path, size and modification time — so a scan over SMB stays cheap
            and an unreachable folder is skipped rather than emptied.
          </p>
        </section>

        {/* ---- review queue ---- */}
        <section className="settings-section">
          <h2>Needs attention</h2>
          <p className="muted">
            Everything the matcher refused to guess at, with the reason it gave. Refusing is only
            defensible because correcting it is easy — a wrong match is worse than no match.
          </p>
          <FocusButton
            className={needsReview > 0 ? 'btn-primary' : 'btn-secondary'}
            onSelect={() => setPanel((p) => (p === 'review' ? 'none' : 'review'))}
          >
            {needsReview > 0 ? `Review ${needsReview} item(s)` : 'Nothing to review'}
          </FocusButton>
          {panel === 'review' && (
            <FixMatch
              files={files}
              onChanged={async (message) => {
                try {
                  await cacheArtwork();
                } catch (e) {
                  console.warn('artwork cache after manual match:', e);
                }
                await refresh();
                setNote(message);
              }}
            />
          )}
        </section>

        {/* ---- playback ---- */}
        <section className="settings-section">
          <h2>Playback</h2>
          <div className="settings-toggle-row">
            <FocusButton
              className={tvMode ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => setTvMode(!tvMode)}
            >
              TV mode: {tvMode ? 'on' : 'off'}
            </FocusButton>
            <span className="muted">
              The 10-foot layout — larger type and artwork, wider margins to clear TV overscan.
              Also on <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>. Leave it off at a desk.
            </span>
          </div>
          <div className="settings-toggle-row">
            <FocusButton
              className={autoSkip ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !autoSkip;
                setAutoSkip(next);
                void setSetting('skip_mode', next ? 'auto' : 'button').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              Skip intros: {autoSkip ? 'automatically' : 'ask'}
            </FocusButton>
            <span className="muted">
              Needs a <code>.skiptro.json</code> sidecar next to the video; without one, nothing
              changes either way.
            </span>
          </div>
        </section>

        {/* ---- providers ---- */}
        <section className="settings-section">
          <h2>Metadata providers</h2>
          <p className="muted">
            Stored in the local database in app data, never in the project folder. TV metadata via
            TVmaze needs no key at all, so the library works without any of these.
          </p>
          <label className="settings-field">
            <span>
              TMDB <span className="muted">preferred — posters, backdrops, episode stills</span>
            </span>
            <FocusInput
              className="settings-input"
              value={tmdbKey}
              onChange={setTmdbKey}
              placeholder="TMDB API key (v3)"
            />
          </label>
          <label className="settings-field">
            <span>
              OMDb <span className="muted">movie fallback — poster only</span>
            </span>
            <FocusInput
              className="settings-input"
              value={omdbKey}
              onChange={setOmdbKey}
              placeholder="OMDb API key"
            />
          </label>
          <label className="settings-field">
            <span>
              MDBList <span className="muted">ratings and ID cross-referencing</span>
            </span>
            <FocusInput
              className="settings-input"
              value={mdblistKey}
              onChange={setMdblistKey}
              placeholder="MDBList API key"
            />
          </label>
          <FocusButton className="btn-primary" onSelect={() => void saveKeys()}>
            Save keys
          </FocusButton>
        </section>

        {/* ---- storage ---- */}
        <section className="settings-section">
          <h2>Storage</h2>
          <p className="muted">
            Artwork cache: {art ? `${art.files} image(s), ${formatBytes(art.bytes)}` : '—'}. Cached
            images are served from app data, so browsing works with no connection. Clearing it is
            safe — the provider URLs stay in the database and the cache refills on the next scan.
          </p>
          <FocusButton
            className="btn-secondary"
            onSelect={() =>
              void (async () => {
                try {
                  const removed = await clearArtworkCache();
                  await refresh();
                  setNote(`Removed ${removed} cached image(s).`);
                } catch (e) {
                  setError(String(e));
                }
              })()
            }
          >
            Clear artwork cache
          </FocusButton>
        </section>

        {/* ---- nfo ---- */}
        <section className="settings-section">
          <h2>NFO files</h2>
          <p className="muted">
            The interop format MediaElch, tinyMediaManager and Kodi all read. An NFO found beside
            a video is treated as <strong>authoritative</strong> during matching: when it carries a
            provider id there is nothing left to guess at, and when it only carries a title, that
            title is what gets searched instead of the one taken off the filename. Nothing needs
            enabling — this happens on every scan.
          </p>
          <p className="muted">
            Exporting writes what this library knows back out, so another tool can read it.
            Existing NFO files are left alone: they were almost certainly written by one of those
            tools and carry fields this app does not model, so replacing them would throw away
            someone else&rsquo;s work. Media folders on read-only shares are reported and skipped.
          </p>
          <div className="settings-row">
            <FocusButton
              className="btn-secondary"
              disabled={writingNfo}
              onSelect={() => void exportNfo(false)}
            >
              {writingNfo ? 'Writing…' : 'Write missing NFO files'}
            </FocusButton>
            <FocusButton
              className="btn-secondary"
              disabled={writingNfo}
              onSelect={() => void exportNfo(true)}
            >
              Overwrite all NFO files
            </FocusButton>
          </div>
        </section>

        {/* ---- developer ---- */}
        <section className="settings-section">
          <h2>Developer tools</h2>
          <p className="muted">
            The stages on their own — scan, parse, re-parse, match, re-match — plus the raw file
            table with what the parser made of each name. Useful when changing parsing or scoring
            rules, since re-matching this way costs no filesystem walk.
          </p>
          <FocusButton
            className="btn-secondary"
            onSelect={() => setPanel((p) => (p === 'developer' ? 'none' : 'developer'))}
          >
            {panel === 'developer' ? 'Hide developer tools' : 'Show developer tools'}
          </FocusButton>
        </section>

        {panel === 'developer' && (
          <div className="settings-developer">
            <LibraryView />
          </div>
        )}
      </div>
    </FocusContext.Provider>
  );
}
