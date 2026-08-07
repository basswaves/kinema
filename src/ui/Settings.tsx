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
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { useClaimFocus } from './focus';
import { setTvMode, useTvMode } from './tv';
import {
  addLibraryRoot,
  analysisBacklog,
  detectIntros,
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
  type DetectProgress,
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

/**
 * How long the Skiptro command fields wait after the last keystroke before
 * saving themselves. Long enough not to write on every character, short enough
 * that reaching for Detect immediately afterwards is still safe — and Detect
 * flushes them first anyway, so this bound is a courtesy rather than a race.
 */
const SKIPTRO_SAVE_DEBOUNCE_MS = 600;

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
  if (s.detailsFilled) parts.push(`${s.detailsFilled} title(s) enriched`);
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
   * Whether the Skiptro fields have finished loading from the database.
   *
   * They save themselves as they are edited (see below), and without this the
   * first render would write the hard-coded defaults back over the stored
   * values before the read that loads them had returned.
   */
  const [skiptroLoaded, setSkiptroLoaded] = useState(false);
  // Unset means on. Only an explicit 'off' stops the lookups.
  const [introDb, setIntroDb] = useState(true);

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
      setDetectLine('');
      setDetecting(root.path);
      try {
        // Flush the command fields before reading them in Rust. The debounce
        // above would almost always have fired by now, and "almost always" is
        // how you get a detect run that silently used the previous command.
        await saveSkiptroFields();
        const report = await detectIntros(root.path);
        if (report.ok) {
          // No longer "sidecars written": the detections go into Skiptro's own
          // database and are read from there. Nothing is written beside the
          // videos unless an export command has been typed back in.
          setNote(`Intro detection finished for ${root.path}.`);
        } else {
          const failed = report.steps[report.steps.length - 1];
          setError(
            `Skiptro "${failed?.step}" exited with ${failed?.exit_code ?? 'no code'}: ` +
              (failed?.tail.slice(-3).join(' · ') || 'no output')
          );
        }
      } catch (e) {
        setError(String(e));
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
      setNote('Keys saved. They apply to matches run from now on — re-match to redo existing ones.');
    } catch (e) {
      setError(String(e));
    }
  }, [tmdbKey, omdbKey]);

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
              Applies to the credits too. Needs a marker from somewhere — Skiptro, TheIntroDB or
              a sidecar; without one, nothing changes either way.
            </span>
          </div>
          <div className="settings-toggle-row">
            <FocusButton
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
              Assume credits: {creditsTail > 0 ? `last ${creditsTail}s` : 'off'}
            </FocusButton>
            <span className="muted">
              The last resort, when nothing knows where the credits are: no marker from
              TheIntroDB, and no chapter named for them. Offer the next episode this far before
              the end. A real marker and a named end-credits chapter both win, and
              this never applies to a film or to the last episode of a run — there is nothing to
              move on to. Off means the offer waits for the file to finish.
            </span>
          </div>
          {/* The one rendering switch in the app, and it exists only because
              the right answer depends on hardware this code cannot see: the
              display's true refresh rate, and whether audio is being sent to a
              receiver as an untouched bitstream. Everything else the app
              decides for itself. */}
          <div className="settings-toggle-row">
            <FocusButton
              className={displaySync ? 'btn-primary' : 'btn-secondary'}
              onSelect={() => {
                const next = !displaySync;
                setDisplaySync(next);
                void setSetting(VIDEO_SYNC_KEY, next ? 'display' : 'audio').catch((e) =>
                  setError(String(e))
                );
              }}
            >
              Frame timing: {displaySync ? 'display clock' : 'audio clock'}
            </FocusButton>
            <span className="muted">
              Times frames to the display's real refresh rate instead of the audio clock,
              removing drift and the odd dropped frame. It does <strong>not</strong> fix 24p
              judder on a 60&nbsp;Hz screen — that is an uneven 3:2 cadence no timing strategy
              can even out, and only a 24, 48 or 120&nbsp;Hz display mode removes it.{' '}
              <strong>
                It works by resampling audio slightly, so it is incompatible with bitstream
                passthrough
              </strong>{' '}
              — a TrueHD or DTS:X stream sent untouched to an AVR cannot be resampled, because
              nothing has decoded it. This app does not currently do passthrough (it decodes to
              PCM), so nothing breaks today; turn this off first if passthrough is ever added.
              Press <kbd>i</kbd> during playback to see the cadence you are actually getting.
            </span>
          </div>
        </section>

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
            One <strong>Detect</strong> button at the bottom of this section runs everything that
            is configured, per TV folder. Markers found by more than one source are ranked, and{' '}
            <code>app.log</code> names the winner for every file played.
          </p>

          <h3>This app&rsquo;s own detection</h3>
          <p className="muted">
            Fingerprints the audio of every episode in a season and finds the stretch they have
            in common — near the start that is the intro, near the end it is the closing theme.{' '}
            <strong>The only source here that finds credits by measuring them</strong>, and the
            only one that works on files with no metadata match at all. Needs{' '}
            <strong>ffmpeg</strong>, which is not bundled: it reads about six minutes of audio
            per episode, so a season takes a few minutes.
          </p>
          <label className="settings-field">
            <span>
              ffmpeg <span className="muted">leave empty to use the one on PATH</span>
            </span>
            <FocusInput
              className="settings-input"
              value={ffmpegPath}
              onChange={setFfmpegPath}
              placeholder="ffmpeg"
            />
          </label>
          <p className="muted">
            ffprobe is taken from the same folder. Without a working ffmpeg this source is simply
            skipped and the others carry on.
          </p>

          <h3>TheIntroDB</h3>
          <p className="muted">
            A free community database of intro and credits times, looked up by the same TMDB id
            used to match the title. It answers instantly and without reading the file, which is
            why it is worth having even alongside the detection above — but coverage is patchy on
            less-watched shows. Nothing is sent but the id, season and episode; no account and no
            key.
          </p>
          <div className="settings-toggle-row">
            <FocusButton
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
            <span className="muted">
              Asked once per episode when you play it, never for the library in bulk, and the
              answer is kept for a month. Off means markers come only from what is detected here.
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
            Optional, and detects intros only. It ranks <em>above</em> this app&rsquo;s own
            detection for the intro — both measure the same file, and Skiptro has years of tuning
            behind it, so putting it first means adding the detection above cannot spoil an intro
            skip that already works. <strong>Skiptro is not bundled and never will be</strong> —
            no third-party binary goes into this app. Point this at a copy you have installed
            yourself and it can be run from here instead of in another window.
          </p>
          <div className="settings-row">
            <FocusButton
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
              Detect command <span className="muted">{'{dir}'} is the folder</span>
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
              Export command <span className="muted">leave empty — see below</span>
            </span>
            <FocusInput
              className="settings-input"
              value={exportArgs}
              onChange={setExportArgs}
              placeholder="not run"
            />
          </label>
          <p className="muted">
            The app reads Skiptro&rsquo;s own database directly, so exporting is off. It used to
            write a <code>.skiptro.json</code> next to every episode for information that was
            already in the database — one extra file per episode, forever. Type{' '}
            <code>export {'{dir}'}</code> here if you want them anyway, to feed another player
            from the same scan.
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
              Runs Skiptro if it is configured, then this app&rsquo;s own analysis of anything
              not already done. Minutes per season the first time; afterwards only new or
              changed episodes are read again.
            </p>
          )}
          {roots
            .filter((root) => root.kind === 'tv')
            .map((root) => (
              <div className="settings-toggle-row" key={root.id}>
                <FocusButton
                  className="btn-secondary"
                  disabled={detecting !== null}
                  onSelect={() => void runDetect(root)}
                >
                  {detecting === root.path ? 'Detecting…' : 'Detect'}
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
                </span>
              </div>
            ))}
          <p className="muted">
            This takes minutes per season — it decodes audio and runs a model over it. Everything
            it finds is written next to your video files, so the results stay readable by Kodi and
            anything else that understands the format, and they survive this app entirely.
          </p>
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
