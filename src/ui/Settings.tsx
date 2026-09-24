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
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import FocusButton from './FocusButton';
import { formatBytes } from './format';
import FocusInput from './FocusInput';
import ConfirmButton from './ConfirmButton';
import EquipmentSection from './EquipmentSection';
import { useClaimFocus } from './focus';
import { setTvMode, useTvMode } from './tv';
import {
  addLibraryRoot,
  analysisBacklog,
  AUTO_ANALYSE_KEY,
  detectIntros,
  stopDetection,
  ffmpegStatus,
  listLibraryRoots,
  removeLibraryRoot,
  DEFAULT_SKIPTRO_EXPORT_ARGS,
  DEFAULT_SKIPTRO_SCAN_ARGS,
  FFMPEG_PATH_KEY,
  INTRODB_ENABLED_KEY,
  SKIPTRO_DB_PATH_KEY,
  SKIPTRO_EXPORT_ARGS_KEY,
  SKIPTRO_PATH_KEY,
  SKIPTRO_SCAN_ARGS_KEY,
  type AutoStep,
  type DetectProgress,
  type FfmpegStatus,
  type LibraryKind,
  type LibraryRoot,
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
  openLogFolder,
  countNeedsReview,
  getSetting,
  setSetting,
  type ArtworkStats,
} from '../metadata/api';
import {
  CREDITS_TAIL_CHOICES,
  CREDITS_TAIL_KEY,
  DEFAULT_CREDITS_TAIL_SECS,
} from '../player/skip';
import { VIDEO_SYNC_KEY } from '../player/mpvOptions';
import { buildNfoExports, writeNfo } from '../metadata/nfo';
import FixMatch from '../library/FixMatch';
import LibraryView from '../library/LibraryView';

const SETTINGS_FOCUS_KEY = 'settings-root';

/** Where TMDB hands out a free key. Linked rather than described. */
const TMDB_KEY_URL = 'https://www.themoviedb.org/settings/api';

/**
 * Skiptro's releases. The UI named this program in three places and never once
 * said what it was or where to get it, which is a fair description of how the
 * whole settings screen used to read.
 */
const SKIPTRO_URL = 'https://github.com/MikeSiLVO/skiptro-releases';

/**
 * How long the Skiptro command fields wait after the last keystroke before
 * saving themselves. Long enough not to write on every character, short enough
 * that reaching for Detect immediately afterwards is still safe — and Detect
 * flushes them first anyway, so this bound is a courtesy rather than a race.
 */
const SKIPTRO_SAVE_DEBOUNCE_MS = 600;

function summaryLine(s: ScanSummary): string {
  const parts = [
    `${s.filesAdded} new file(s)`,
    `${s.matched} matched`,
    `${s.unmatched} left for review`,
  ];
  if (s.artworkStored) parts.push(`${s.artworkStored} image(s) cached`);
  if (s.detailsFilled) parts.push(`${s.detailsFilled} title(s) enriched`);
  // The scan collected these all along and nothing ever rendered them, so an
  // unreachable share reported a perfectly cheerful "0 new files".
  if (s.errors.length) parts.push(`${s.errors.length} problem(s)`);
  return parts.join(' · ');
}

/**
 * The non-fatal problems from a scan, as one line.
 *
 * Capped, because one unreachable root fails once per file it should have had
 * and a thousand identical lines say nothing the first three did not.
 */
function problemLine(errors: string[]): string {
  const shown = errors.slice(0, 3).join(' · ');
  return errors.length > 3 ? `${shown} · and ${errors.length - 3} more` : shown;
}

/**
 * What the automatic intro/credits pass had to say, if anything.
 *
 * Shown next to the scan summary rather than in the markers section below,
 * because it is a report on something that has already happened and this is
 * where a user looks after a scan. The section below is where it is configured.
 *
 * Steps that ran and steps that did not are both worth showing: "Skiptro is not
 * where you said it was" is the whole reason this is here, and it is invisible
 * in a display that only reports successes.
 */
function detectLines(steps: AutoStep[]): string[] {
  return steps.map((s) => `${s.ran ? '' : 'skipped — '}${s.note}`);
}

export default function Settings() {
  const { ref, focusKey } = useFocusable({
    focusKey: SETTINGS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  useClaimFocus(SETTINGS_FOCUS_KEY, true);

  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [needsReview, setNeedsReview] = useState(0);
  const [art, setArt] = useState<ArtworkStats | null>(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [omdbKey, setOmdbKey] = useState('');
  const [autoSkip, setAutoSkip] = useState(false);
  const [creditsTail, setCreditsTail] = useState(DEFAULT_CREDITS_TAIL_SECS);
  const [displaySync, setDisplaySync] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'review' | 'developer'>('none');
  const [writingNfo, setWritingNfo] = useState(false);

  // Intro detection. `detecting` holds the root currently being worked on, so
  // one root's button can show progress while the others simply disable.
  const [skiptroPath, setSkiptroPath] = useState('');
  const [skiptroDbPath, setSkiptroDbPath] = useState('');
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [scanArgs, setScanArgs] = useState(DEFAULT_SKIPTRO_SCAN_ARGS);
  const [exportArgs, setExportArgs] = useState(DEFAULT_SKIPTRO_EXPORT_ARGS);
  const [detecting, setDetecting] = useState<string | null>(null);
  /**
   * Episodes per TV root with no analysis yet, keyed by root id.
   *
   * Shown beside Detect because the failure it prevents is invisible: a season
   * added later falls back to the last-resort credits guess, and the only clue
   * is an Up next card arriving late.
   */
  const [backlog, setBacklog] = useState<Record<number, number>>({});
  const [detectLine, setDetectLine] = useState('');
  /**
   * How the last Detect ended, shown in that folder's own row. It used to go
   * to the banner under the page title, a screen and a half above the button —
   * the trap GOTCHAS describes, where a working button reads as a dead one.
   */
  const [detectOutcome, setDetectOutcome] = useState<{
    path: string;
    text: string;
    failed: boolean;
  } | null>(null);
  /**
   * Whether the Skiptro fields have finished loading from the database.
   *
   * They save themselves as they are edited (see below), and without this the
   * first render would write the hard-coded defaults back over the stored
   * values before the read that loads them had returned.
   */
  const [skiptroLoaded, setSkiptroLoaded] = useState(false);
  /** Whether the configured ffmpeg runs. Null until the first check answers. */
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  /** The same guard for the provider keys, which now save themselves too. */
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [keysSaved, setKeysSaved] = useState(false);
  // Unset means on. Only an explicit 'off' stops the lookups.
  const [introDb, setIntroDb] = useState(true);
  // Likewise: the built-in analysis runs after a scan unless it is switched off.
  const [autoAnalyse, setAutoAnalyse] = useState(true);

  const tvMode = useTvMode();
  const scan = useScanStatus();

  const refresh = useCallback(async () => {
    try {
      // A count, not the file table. This used to pull 2,000 rows of eighteen
      // columns across the IPC boundary so it could call `.length` on a filter
      // of them — and silently under-reported on any library larger than that.
      const [r, n, a, pending] = await Promise.all([
        listLibraryRoots(),
        countNeedsReview(),
        artworkStats(),
        analysisBacklog(),
      ]);
      setRoots(r);
      setNeedsReview(n);
      setArt(a);
      setBacklog(Object.fromEntries(pending));
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
      setKeysLoaded(true);
      setAutoSkip((await getSetting('skip_mode')) === 'auto');

      // Unset keeps the default; 0 is a real value meaning "never guess", so it
      // must not be mistaken for absent.
      const raw = await getSetting(CREDITS_TAIL_KEY);
      const secs = raw === null ? NaN : Number(raw);
      if (Number.isFinite(secs) && secs >= 0) setCreditsTail(secs);

      setDisplaySync((await getSetting(VIDEO_SYNC_KEY)) === 'display');

      setSkiptroPath((await getSetting(SKIPTRO_PATH_KEY)) ?? '');
      setSkiptroDbPath((await getSetting(SKIPTRO_DB_PATH_KEY)) ?? '');
      setFfmpegPath((await getSetting(FFMPEG_PATH_KEY)) ?? '');
      setScanArgs((await getSetting(SKIPTRO_SCAN_ARGS_KEY)) || DEFAULT_SKIPTRO_SCAN_ARGS);
      // `??` not `||`: an empty export command is the default and means "do not
      // export". `||` would silently put the old sidecar-writing command back.
      setExportArgs((await getSetting(SKIPTRO_EXPORT_ARGS_KEY)) ?? DEFAULT_SKIPTRO_EXPORT_ARGS);
      setSkiptroLoaded(true);

      setIntroDb((await getSetting(INTRODB_ENABLED_KEY)) !== 'off');
      setAutoAnalyse((await getSetting(AUTO_ANALYSE_KEY)) !== 'off');
    })();
  }, []);

  /**
   * Write the detection text fields as they are edited.
   *
   * Every other control on this page applies the moment it changes; these were
   * the exception, behind a **Save commands** button. That button was a trap in
   * both directions — typing a command and pressing Detect without saving ran
   * the *old* one, silently — and its confirmation rendered in the banner at
   * the top of a page far longer than a screen, so it read as doing nothing.
   *
   * Debounced rather than written per keystroke: these are four database
   * writes, and the values are only ever read when something else starts.
   */
  const saveSkiptroFields = useCallback(async () => {
    await setSetting(SKIPTRO_SCAN_ARGS_KEY, scanArgs.trim());
    await setSetting(SKIPTRO_EXPORT_ARGS_KEY, exportArgs.trim());
    await setSetting(SKIPTRO_DB_PATH_KEY, skiptroDbPath.trim());
    await setSetting(FFMPEG_PATH_KEY, ffmpegPath.trim());
  }, [scanArgs, exportArgs, skiptroDbPath, ffmpegPath]);

  useEffect(() => {
    if (!skiptroLoaded) return;
    const id = window.setTimeout(() => {
      void saveSkiptroFields().catch((e) => setError(String(e)));
    }, SKIPTRO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [skiptroLoaded, saveSkiptroFields]);

  // Re-check ffmpeg whenever the field settles. One `-version` call, so the
  // debounce is about not running it per keystroke rather than about cost.
  useEffect(() => {
    if (!skiptroLoaded) return;
    const id = window.setTimeout(() => {
      void ffmpegStatus(ffmpegPath.trim())
        .then(setFfmpeg)
        .catch(() => setFfmpeg(null));
    }, SKIPTRO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [skiptroLoaded, ffmpegPath]);

  /**
   * The provider keys, on the same terms as the fields above.
   *
   * These used to be the one place on this page with a **Save keys** button,
   * which meant typing a key and walking away lost it — and losing an API key
   * silently looks exactly like the key being wrong. Now they behave like every
   * other control here: change it and it is stored.
   */
  useEffect(() => {
    if (!keysLoaded) return;
    const id = window.setTimeout(() => {
      void (async () => {
        try {
          await setSetting('tmdb_api_key', tmdbKey.trim());
          await setSetting('omdb_api_key', omdbKey.trim());
          setKeysSaved(true);
        } catch (e) {
          setError(String(e));
        }
      })();
    }, SKIPTRO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [keysLoaded, tmdbKey, omdbKey]);

  /**
   * Skiptro's output, streamed a line at a time.
   *
   * A scan of a season runs for minutes, so a progress display that only
   * appeared at the end would be the same as no progress display.
   */
  useEffect(() => {
    const unlisten = listen<DetectProgress>('skiptro-progress', (event) => {
      setDetectLine(event.payload.line);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const runDetect = useCallback(
    async (root: LibraryRoot) => {
      setError(null);
      setNote(null);
      setDetectOutcome(null);
      setDetectLine('');
      setDetecting(root.path);
      const outcome = (text: string, failed = false) =>
        setDetectOutcome({ path: root.path, text, failed });
      try {
        // Flush the command fields before reading them in Rust. The debounce
        // above would almost always have fired by now, and "almost always" is
        // how you get a detect run that silently used the previous command.
        await saveSkiptroFields();
        const report = await detectIntros(root.path);
        if (report.stopped) {
          outcome('Stopped. Seasons it had finished are kept; the rest is picked up next time.');
        } else if (report.ok) {
          // No longer "sidecars written": the detections go into Skiptro's own
          // database and are read from there. Nothing is written beside the
          // videos unless an export command has been typed back in.
          outcome('Finished.');
        } else {
          // Name the step that actually failed, and name it *correctly*. This
          // used to take the last step and call it Skiptro — but this app's own
          // analysis is always pushed last, under the name `analyse`, so a
          // missing ffmpeg was reported as a Skiptro failure to users who had
          // never installed Skiptro. The Rust messages were fine all along;
          // only this line was wrong.
          const failed =
            report.steps.find((s) => s.exit_code !== 0) ?? report.steps[report.steps.length - 1];
          const owner = failed?.step === 'analyse' ? 'Detection' : `Skiptro "${failed?.step}"`;
          const code = failed?.exit_code === null ? 'did not finish' : `exited with ${failed?.exit_code}`;
          const detail = failed?.tail.slice(-3).join(' · ') || 'no output';
          outcome(`${owner} ${code}: ${detail}`, true);
        }
      } catch (e) {
        outcome(String(e), true);
      } finally {
        setDetecting(null);
        setDetectLine('');
        // The backlog is why the button was pressed; it has to be re-read, or
        // it would still claim the work is outstanding.
        void refresh();
      }
    },
    [saveSkiptroFields, refresh]
  );

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
      else if (outcome.summary.errors.length) setError(problemLine(outcome.summary.errors));
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
                  <ConfirmButton
                    keepInView="nearest"
                    className="settings-remove"
                    confirmLabel="Remove it"
                    onConfirm={() =>
                      void removeLibraryRoot(root.id)
                        .then(refresh)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    Remove
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}

          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => void pickFolder('movies')}
            >
              Add movies folder
            </FocusButton>
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => void pickFolder('tv')}
            >
              Add TV folder
            </FocusButton>
            {/* During the scan's detection pass — minutes of work nobody asked
                for by name — this same button stops it. The same button, not
                a second one: a Stop that vanishes when detection ends takes
                the remote's focus with it. */}
            <FocusButton
              keepInView="nearest"
              className="btn-primary"
              onSelect={() => void (scan?.stage === 'detecting' ? stopDetection() : scanNow())}
            >
              {scan?.stage === 'detecting' ? 'Stop detection' : scan ? `${scan.stage}…` : 'Scan now'}
            </FocusButton>
          </div>

          {scan && (
            <p className="settings-progress">
              {scan.stage}
              {scan.detail ? ` — ${scan.detail}` : ''}
            </p>
          )}

          {!scan && last && <p className="muted">Last scan: {summaryLine(last)}</p>}
          {/* The report from the intro/credits pass at the end of the scan.
              Deliberately rendered even when every line is a "skipped": a
              Skiptro that is no longer where it was configured is exactly the
              failure this whole display exists to stop being silent. */}
          {!scan &&
            last &&
            detectLines(last.detectNotes).map((line) => (
              <p className="muted" key={line}>
                Markers: {line}
              </p>
            ))}
          <p className="muted">
            Kinema checks these folders once every time it starts, so you rarely need the button.
            It only looks at file names, sizes and dates rather than reading the videos
            themselves, which keeps it quick even over a network. A folder that is switched off
            or unplugged is left alone until it comes back, not forgotten. When it finds new
            episodes it goes on to look for their intros and credits, so a season you drop in is
            ready to watch without pressing anything.
          </p>
        </section>

        {/* ---- providers ----
            Second, directly under Library, because these two sections are the
            whole of what a new library needs. This used to be sixth of eight,
            below three sections of intro-detection detail, which put the one
            thing standing between a user and a shelf of posters behind the one
            thing they would never look for. */}
        <section className="settings-section">
          <h2>Posters and descriptions</h2>
          <p className="muted">
            TV shows work with no key at all, through TVmaze. Films need a key from TMDB —
            it is free, and it is what fetches posters, backdrops, cast and episode stills.
            Keys are stored in the local database in app data, never in the project folder,
            and they save themselves as you type.
          </p>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => void openUrl(TMDB_KEY_URL)}
            >
              Get a free TMDB key ↗
            </FocusButton>
            {keysSaved && <span className="muted">Saved.</span>}
          </div>
          <label className="settings-field">
            <span>
              TMDB <span className="muted">posters, backdrops, cast, episode stills</span>
            </span>
            {/* Masked. This screen is routinely on a television, and a key on a
                60-inch panel in a living room is not a private thing. */}
            <FocusInput
              className="settings-input"
              value={tmdbKey}
              onChange={(v) => {
                setTmdbKey(v);
                setKeysSaved(false);
              }}
              type="password"
              placeholder="Paste your TMDB key"
            />
          </label>
          <label className="settings-field">
            <span>
              OMDb <span className="muted">optional — a fallback for films, poster only</span>
            </span>
            <FocusInput
              className="settings-input"
              value={omdbKey}
              onChange={(v) => {
                setOmdbKey(v);
                setKeysSaved(false);
              }}
              type="password"
              placeholder="Paste your OMDb key"
            />
          </label>
          <p className="muted">
            A new key applies to matches made from now on. Titles already in the library keep
            whatever they matched against until they are matched again.
          </p>
          {/* Attribution. Unlike TheIntroDB's, this one is *required* rather
              than requested: TMDB ask for their logo and this disclaimer
              wherever their data is shown, and TVmaze's licence asks for credit.
              This is the page a user looks at to find out where the data came
              from, so it belongs here rather than in a separate About screen.

              The logo is TMDB's own unmodified SVG, served from the app rather
              than hotlinked — attribution that disappears when the network does
              is not attribution. */}
          <div className="settings-attribution">
            <img src="/tmdb.svg" alt="TMDB" className="tmdb-logo" />
            <p className="muted">
              Film and TV data from TMDB. This product uses the TMDB API but is not endorsed or
              certified by TMDB. TV data also from <strong>TVmaze</strong>.
            </p>
          </div>
        </section>

        {/* ---- review queue ---- */}
        <section className="settings-section">
          <h2>Needs attention</h2>
          <p className="muted">
            Films and episodes Kinema could not identify with confidence. Rather than attach the
            wrong film to your file, it puts them here for you to pick from a list — which takes
            a few seconds each. If this is empty, everything found a match.
          </p>
          <FocusButton
            keepInView="nearest"
            className={needsReview > 0 ? 'btn-primary' : 'btn-secondary'}
            onSelect={() => setPanel((p) => (p === 'review' ? 'none' : 'review'))}
          >
            {needsReview > 0 ? `Review ${needsReview} item(s)` : 'Nothing to review'}
          </FocusButton>
          {panel === 'review' && (
            <FixMatch
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
              keepInView="nearest"
              className={tvMode ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => setTvMode(!tvMode)}
            >
              TV mode: {tvMode ? 'on' : 'off'}
            </FocusButton>
            <span className="muted">
              Bigger text and artwork, for reading from across a room. Also leaves a wider margin
              around the edges, because many televisions crop a little off every side. Turn it on
              if this is on a TV, off if it is on a desk. Also on{' '}
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>.
            </span>
          </div>
          <div className="settings-toggle-row">
            <FocusButton
              keepInView="nearest"
              className={autoSkip ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !autoSkip;
                setAutoSkip(next);
                void setSetting('skip_mode', next ? 'auto' : 'button').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              Skip intros and credits: {autoSkip ? 'automatically' : 'ask first'}
            </FocusButton>
            <span className="muted">
              Whether to jump the intro and the closing credits on its own, or show a Skip button
              and wait for you. Either way it needs to know where they are — see{' '}
              <strong>Intro and credits markers</strong> below. Until something has found them,
              this setting changes nothing.
            </span>
          </div>
          <div className="settings-toggle-row">
            <FocusButton
              keepInView="nearest"
              className={creditsTail > 0 ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const index = CREDITS_TAIL_CHOICES.indexOf(creditsTail);
                const next =
                  CREDITS_TAIL_CHOICES[(index + 1) % CREDITS_TAIL_CHOICES.length] ??
                  DEFAULT_CREDITS_TAIL_SECS;
                setCreditsTail(next);
                void setSetting(CREDITS_TAIL_KEY, String(next)).catch((e) => setError(String(e)));
              }}
            >
              Offer the next episode: {creditsTail > 0 ? `${creditsTail}s early` : 'at the end'}
            </FocusButton>
            <span className="muted">
              For episodes where nothing has found the credits, guess that they are the last{' '}
              {creditsTail > 0 ? `${creditsTail} seconds` : 'stretch'} and offer the next episode
              then. Anything that actually knows better — a real marker, or a chapter named for
              the credits — is used instead. Never applies to films, or to the last episode you
              have.{' '}
              <span className="muted">
                Press it to cycle: {CREDITS_TAIL_CHOICES.map((n) => (n === 0 ? 'off' : `${n}s`)).join(', ')}.
              </span>
            </span>
          </div>
          {/* The one rendering switch in the app, and it exists only because
              the right answer depends on hardware this code cannot see: the
              display's true refresh rate, and whether audio is being sent to a
              receiver as an untouched bitstream. Everything else the app
              decides for itself. */}
          <div className="settings-toggle-row">
            <FocusButton
              keepInView="nearest"
              className={displaySync ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !displaySync;
                setDisplaySync(next);
                void setSetting(VIDEO_SYNC_KEY, next ? 'display' : 'audio').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              Frame timing: {displaySync ? 'match the screen' : 'match the sound'}
            </FocusButton>
            <span className="muted">
              If playback stutters slightly every few seconds, try switching this. It is a
              choice between two ways of deciding when to show each frame, and which one is
              smoother depends on your screen — so it is worth trying both and keeping whichever
              looks better. Nothing else changes.{' '}
              <span className="muted">
                It will not fix the regular, rhythmic stutter that films show on most computer
                monitors — that comes from the screen&rsquo;s refresh rate not dividing evenly
                into 24 frames a second, and only changing the screen&rsquo;s refresh rate helps.
                Press <kbd>i</kbd> while something is playing to see what you are getting.
              </span>
            </span>
          </div>
        </section>

        <EquipmentSection />

        {/* ---- where markers come from ----

            Three sources, listed in the order they are trusted, because they
            are good at different things and the difference is the whole design:
            Skiptro and this app's own analysis both measure the exact file on
            this disk, but only the analysis finds credits; TheIntroDB was timed
            by people against some copy of the episode, and is the only one that
            answers without reading the file at all. */}
        <section className="settings-section">
          <h2>Intro and credits markers</h2>
          <p className="muted">
            Where Kinema looks to find out when an intro or the closing credits start, so it can
            offer to skip them. There is more than one source and they are good at different
            things; if several find the same episode, the most reliable one wins. Nothing here
            needs setting up to get started — leave it all alone and you still get markers from
            TheIntroDB.
          </p>
          <p className="muted">
            Kinema does this by itself. Every time it finds new episodes it goes looking for
            their intros and credits straight afterwards, so a season you drop into a watched
            folder is ready before you sit down. The <strong>Detect</strong> button at the bottom
            does the same thing on demand, one TV folder at a time — useful after changing
            something here, and otherwise not needed.
          </p>

          <h3>Built in</h3>
          <p className="muted">
            Listens to every episode of a season and finds the stretch of audio they all share —
            near the beginning that is the theme tune, near the end the closing music. It is the
            only source that finds <em>credits</em> by actually measuring them, and the only one
            that works on episodes Kinema could not identify. It reads about six minutes of audio
            per episode, so a season takes a few minutes the first time.
          </p>
          {/* The one part of the automatic pass that is a switch, and the reason
              is the cost rather than the quality: this is minutes of ffmpeg per
              season. Skiptro is quick and simply always runs. */}
          <div className="settings-toggle-row">
            <FocusButton
              keepInView="nearest"
              className={autoAnalyse ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !autoAnalyse;
                setAutoAnalyse(next);
                void setSetting(AUTO_ANALYSE_KEY, next ? 'on' : 'off').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              Run this automatically: {autoAnalyse ? 'on' : 'off'}
            </FocusButton>
            <span className="muted">
              Whether it runs by itself after a scan finds new episodes, or waits for the
              Detect button. It is the slow one — a few minutes per season, once — so turn it
              off if you would rather choose when that happens. Turning it off does not lose
              anything already found, and Kinema will tell you here how many episodes are
              waiting.
            </span>
          </div>
          <p className="muted">
            This one needs <strong>ffmpeg</strong> — a free tool for reading video and audio
            files. Kinema does not include it: install it yourself and it will be found
            automatically, or type where it is below. Without it, this source is skipped and the
            others carry on.
          </p>
          <label className="settings-field">
            <span>
              Where ffmpeg is{' '}
              <span className="muted">leave this empty unless Kinema cannot find it</span>
            </span>
            <FocusInput
              className="settings-input"
              value={ffmpegPath}
              onChange={setFfmpegPath}
              placeholder="ffmpeg"
            />
          </label>
          {/* Answered here rather than discovered during a detection run. A
              wrong path used to stay silent for minutes and then surface as
              somebody else's failure. */}
          {ffmpeg && (
            <p className={ffmpeg.available ? 'settings-ok' : 'settings-warn'}>
              {ffmpeg.available
                ? `Found ffmpeg at ${ffmpeg.resolved}.`
                : `Could not find ffmpeg (looked for "${ffmpeg.resolved}"). Install it, or type ` +
                  `the full path to ffmpeg.exe here. Without it, Kinema cannot find intros and ` +
                  `credits itself — everything else works normally.`}
            </p>
          )}

          <h3>TheIntroDB</h3>
          <p className="muted">
            A free database of intro and credits times, contributed by other people watching the
            same shows. It answers straight away without reading your files, which is why it is
            worth having even alongside the detection above — but popular shows are covered far
            better than obscure ones. No account and no key needed.
          </p>
          <div className="settings-toggle-row">
            <FocusButton
              keepInView="nearest"
              className={introDb ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !introDb;
                setIntroDb(next);
                void setSetting(INTRODB_ENABLED_KEY, next ? 'on' : 'off').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              TheIntroDB: {introDb ? 'on' : 'off'}
            </FocusButton>
            {/* This used to say "asked once per episode", which a user
                reasonably read as Kinema asking *them* something and then
                waited for a box that was never going to appear. It is a
                background lookup and nothing about it is ever visible. */}
            <span className="muted">
              Kinema looks this up quietly in the background the first time you play an episode,
              and keeps the answer for a month. It never asks you anything and never looks up
              your whole library at once. All that is sent is which episode it is: nothing about
              you, and nothing about your files. Off means markers come only from what is
              detected on this machine.
            </span>
          </div>
          {/* Attribution. They request it rather than require it, and it costs
              one line; this is the page a user would look at to find out where
              the timings came from. */}
          <p className="muted">
            Segment data from <strong>TheIntroDB</strong> —{' '}
            <code>https://theintrodb.org</code>. Community-contributed, so accuracy varies and
            coverage is patchy on less-watched shows.
          </p>

          <h3>Skiptro</h3>
          <p className="muted">
            <strong>Optional, and most people will not need it.</strong> Skiptro is a separate
            free program that finds TV intros — not credits — and it does that one job very well
            after years of tuning, so where it and the built-in detection disagree about an
            intro, Skiptro wins. If you already use it with Kodi, Kinema can run it for you and
            read its results. If you have never heard of it, skip this whole section: the
            built-in detection covers the same ground.
          </p>
          <p className="muted">
            Kinema does not include Skiptro and never will — no other program&rsquo;s software
            ships inside this one. You install it yourself, from{' '}
            <code>github.com/MikeSiLVO/skiptro-releases</code>, and point Kinema at it below.
          </p>
          {/* No switch for this one, unlike the built-in analysis above: it is
              quick, it keeps its own record of what it has already looked at,
              and its intro beats every other source — so there is no version of
              "later" that produces a better answer than now. */}
          <p className="muted">
            Once it is set up here, Kinema runs it by itself whenever a scan finds new episodes,
            and only then. There is nothing to switch on and no button to remember. If Skiptro
            is not installed, or the path below stops being right, Kinema says so after the scan
            and carries on with everything else.
          </p>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => void openUrl(SKIPTRO_URL)}
            >
              Open the Skiptro page ↗
            </FocusButton>
          </div>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() =>
                void (async () => {
                  try {
                    const chosen = await open({
                      multiple: false,
                      filters: [{ name: 'Skiptro', extensions: ['exe'] }],
                    });
                    if (typeof chosen !== 'string') return;
                    setSkiptroPath(chosen);
                    await setSetting(SKIPTRO_PATH_KEY, chosen);
                    setNote('Skiptro location saved.');
                  } catch (e) {
                    setError(String(e));
                  }
                })()
              }
            >
              {skiptroPath ? 'Change Skiptro location' : 'Choose Skiptro executable'}
            </FocusButton>
          </div>
          <p className="muted">
            {skiptroPath ? (
              <code>{skiptroPath}</code>
            ) : (
              <>
                Not set. Use <code>skiptro.exe</code> — the command-line one, not{' '}
                <code>Skiptro-Desktop.exe</code>.
              </>
            )}
          </p>

          {/* Text fields rather than hard-coded so that a change to Skiptro's
              command line is an edit here and not a new build — the same
              reasoning that keeps anything needing upkeep out. They save
              themselves; see SKIPTRO_SAVE_DEBOUNCE_MS for why there is no
              button. */}
          <label className="settings-field">
            <span>
              How to run it{' '}
              <span className="muted">
                leave as it is unless Skiptro changes; {'{dir}'} stands for the folder
              </span>
            </span>
            <FocusInput
              className="settings-input"
              value={scanArgs}
              onChange={setScanArgs}
              placeholder={DEFAULT_SKIPTRO_SCAN_ARGS}
            />
          </label>
          <label className="settings-field">
            <span>
              How to export <span className="muted">leave empty — see below</span>
            </span>
            <FocusInput
              className="settings-input"
              value={exportArgs}
              onChange={setExportArgs}
              placeholder="not run"
            />
          </label>
          <p className="muted">
            Exporting is off, and normally should stay off: Kinema reads Skiptro&rsquo;s results
            from its database directly. Turning it on writes one small extra file beside every
            episode, forever, holding what the database already knows — worth it only if you
            want another player to read the same results. Type <code>export {'{dir}'}</code> to
            switch it on.
          </p>
          <label className="settings-field">
            <span>
              Skiptro database <span className="muted">only if you moved it</span>
            </span>
            <FocusInput
              className="settings-input"
              value={skiptroDbPath}
              onChange={setSkiptroDbPath}
              placeholder="%APPDATA%\Skiptro\skiptro.db"
            />
          </label>

          {/* One button per TV root, running every source that is configured.
              No longer gated on a Skiptro path: this app's own detection needs
              only ffmpeg, so hiding the button without Skiptro would hide the
              detector from anyone who never installs it.

              TV roots only. Intros are a television thing, and a films folder
              would be a button that runs for a long time and finds nothing —
              the whole method is "what do these episodes have in common". */}
          <h3>Run detection</h3>
          {roots.filter((r) => r.kind === 'tv').length === 0 ? (
            <p className="muted">Add a TV folder above to detect intros and credits in it.</p>
          ) : (
            <p className="muted">
              Go through a TV folder and work out where the intros and credits are. You only
              need to do this once per folder; new episodes are picked up next time.
            </p>
          )}
          {roots
            .filter((root) => root.kind === 'tv')
            .map((root) => (
              <div className="settings-toggle-row" key={root.id}>
                {/* While this folder is detecting, the button stops it — the
                    same button rather than a Stop beside it, so focus has
                    nowhere to fall when detection ends. Disabled for the other
                    folders and during the scan's own pass: only one detection
                    runs at a time, and the backend would refuse. */}
                <FocusButton
                  keepInView="nearest"
                  className="btn-secondary"
                  disabled={
                    (detecting !== null && detecting !== root.path) || scan?.stage === 'detecting'
                  }
                  onSelect={() => void (detecting === root.path ? stopDetection() : runDetect(root))}
                >
                  {detecting === root.path ? 'Stop detecting' : 'Detect'}
                </FocusButton>

                <span className="muted">
                  <code>{root.path}</code>
                  {/* The whole point of the count. Without it, a season added
                      after the last run quietly falls back to the tail guess
                      and the only symptom is an Up next card arriving late. */}
                  {detecting !== root.path && (backlog[root.id] ?? 0) > 0 && (
                    <>
                      {' · '}
                      <strong>{backlog[root.id]} episode(s) not analysed yet</strong>
                    </>
                  )}
                  {detecting !== root.path && backlog[root.id] === 0 && ' · all analysed'}
                  {detecting === root.path && detectLine && (
                    <>
                      <br />
                      <span className="settings-progress">{detectLine}</span>
                    </>
                  )}
                  {detecting === null && detectOutcome?.path === root.path && (
                    <>
                      <br />
                      {detectOutcome.failed ? (
                        <strong>{detectOutcome.text}</strong>
                      ) : (
                        <span className="settings-progress">{detectOutcome.text}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
            ))}
          {/* This paragraph used to end "everything it finds is written next
              to your video files". That stopped being true when sidecar export
              was turned off — the results go in Kinema's own database — and it
              is exactly the wrong thing to be wrong about, since the people
              most likely to read it are the ones watching what lands on their
              NAS. */}
          <p className="muted">
            Minutes per season the first time, because it has to listen to every episode.
            Afterwards only new or changed episodes are read again. Results are kept inside
            Kinema; <strong>nothing is written next to your video files</strong> unless you
            asked for it above.
          </p>
        </section>

        {/* ---- storage ---- */}
        <section className="settings-section">
          <h2>Storage</h2>
          <p className="muted">
            Posters and artwork are kept on this machine —{' '}
            {art ? `${art.files} image(s), ${formatBytes(art.bytes)}` : '—'} — so browsing works
            with the internet off. Clearing them is safe: nothing is lost from your library, and
            they download again on the next scan.
          </p>
          <FocusButton
            keepInView="nearest"
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
          <h2>Sharing with other media apps</h2>
          <p className="muted">
            <strong>.nfo files</strong> are small text files that sit next to a video and say
            what it is. Kodi, MediaElch and tinyMediaManager all read and write them, so they are
            how these programs agree with each other.
          </p>
          <p className="muted">
            <strong>Reading them needs no setting up.</strong> If one is already next to a video,
            Kinema believes it over its own guess — which is usually the fastest way to fix a
            stubborn mismatch: identify it in another program, and Kinema will agree next scan.
          </p>
          <p className="muted">
            Writing them is the other direction, so another program can use what Kinema knows.
            Files that already exist are left alone, because they were probably written by one of
            those other programs and contain more than Kinema tracks. Folders you cannot write to
            are skipped and reported.
          </p>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              disabled={writingNfo}
              onSelect={() => void exportNfo(false)}
            >
              {writingNfo ? 'Writing…' : 'Write the missing ones'}
            </FocusButton>
            <ConfirmButton
              keepInView="nearest"
              className="btn-secondary"
              disabled={writingNfo}
              confirmLabel="Yes, replace them all"
              onConfirm={() => void exportNfo(true)}
            >
              Replace every one
            </ConfirmButton>
          </div>
        </section>

        {/* ---- developer ---- */}
        <section className="settings-section">
          <h2>Developer tools</h2>
          <p className="muted">
            <strong>Not needed to use Kinema.</strong> Runs each stage of the library scan by
            hand and shows the raw table of every file with what was made of its name. It exists
            for working on Kinema itself, and it is the one part of this screen a remote cannot
            drive — use a mouse.
          </p>
          <p className="muted">
            If something goes wrong, the two log files in the log folder — <code>app.log</code>{' '}
            and <code>mpv.log</code> — are what a bug report needs.
          </p>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => setPanel((p) => (p === 'developer' ? 'none' : 'developer'))}
            >
              {panel === 'developer' ? 'Hide developer tools' : 'Show developer tools'}
            </FocusButton>
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => void openLogFolder().catch((e) => setError(String(e)))}
            >
              Open log folder
            </FocusButton>
          </div>
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
