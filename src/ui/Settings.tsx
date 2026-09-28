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
import { userError } from './errors';
import LanguageSection from './LanguageSection';
import ChoiceRow from './ChoiceRow';
import MoreAbout from './MoreAbout';
import { availableUpdate, UPDATE_CHECK_KEY, type Release } from './updates';
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import FocusButton from './FocusButton';
import { count, formatBytes } from './format';
import FocusInput from './FocusInput';
import ConfirmButton from './ConfirmButton';
import EquipmentSection from './EquipmentSection';
import SoundSection from './SoundSection';
import ScreenSection from './ScreenSection';
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
    `${count(s.filesAdded, 'new file')}`,
    `${s.matched} matched`,
    `${s.unmatched} left for review`,
  ];
  if (s.artworkStored) parts.push(`${count(s.artworkStored, 'image')} cached`);
  if (s.detailsFilled) parts.push(`${count(s.detailsFilled, 'title')} enriched`);
  // The scan collected these all along and nothing ever rendered them, so an
  // unreachable share reported a perfectly cheerful "0 new files".
  if (s.errors.length) parts.push(count(s.errors.length, 'problem'));
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

/** The Review button, where focus lands when Settings opens on the queue. */
const REVIEW_BUTTON_KEY = 'settings-review-button';

type SectionId = 'library' | 'playback' | 'picture' | 'intros' | 'advanced';

/** The list down the side, in the order someone setting up would need them. */
const SECTIONS: [SectionId, string][] = [
  ['library', 'Library'],
  ['playback', 'Playback'],
  ['picture', 'Picture & sound'],
  ['intros', 'Intro & credits'],
  ['advanced', 'Advanced'],
];

/** Coming back to Settings opens the section you were last in. */
let lastSection: SectionId = 'library';

export default function Settings({ openSection }: { openSection?: 'review' }) {
  const { ref, focusKey } = useFocusable({
    focusKey: SETTINGS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  const [section, setSection] = useState<SectionId>(
    openSection === 'review' ? 'library' : lastSection
  );
  const chooseSection = useCallback((id: SectionId) => {
    lastSection = id;
    setSection(id);
  }, []);

  // Land on the open section in the list — or, from Home's notice, straight
  // on the review queue.
  useClaimFocus(openSection === 'review' ? REVIEW_BUTTON_KEY : `settings-nav:${section}`, true);

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
  const [panel, setPanel] = useState<'none' | 'review' | 'developer'>(
    openSection === 'review' ? 'review' : 'none'
  );
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

  /** A newer release, if one is out; and whether looking for one is on. */
  const [update, setUpdate] = useState<Release | null>(null);
  const [checkUpdates, setCheckUpdates] = useState(true);
  useEffect(() => {
    let live = true;
    void availableUpdate().then((r) => live && setUpdate(r));
    void getSetting(UPDATE_CHECK_KEY).then((v) => live && setCheckUpdates(v !== 'off'));
    return () => {
      live = false;
    };
  }, []);

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
      setError(userError(e));
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
      void saveSkiptroFields().catch((e) => setError(userError(e)));
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
          setError(userError(e));
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
        outcome(userError(e), true);
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
        setError(userError(e));
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
      const parts = [`Wrote ${count(report.written, 'NFO file')}`];
      if (report.skipped) parts.push(`${report.skipped} already existed and were left alone`);
      if (report.errors.length) parts.push(`${report.errors.length} failed`);
      setNote(`${parts.join(' · ')}.`);
      // Only the first few: a read-only share fails once per file, and a
      // thousand identical lines say nothing the first three did not.
      if (report.errors.length) setError(report.errors.slice(0, 3).join(' · '));
    } catch (e) {
      setError(userError(e));
    } finally {
      setWritingNfo(false);
    }
  }, []);

  const last = getLastScanSummary();
  const tvRoots = roots.filter((r) => r.kind === 'tv');

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

        <div className="settings-layout">
          {/* The sections, as a list down the side. OK opens one; Right goes
              into it and Left comes back. One section at a time, where there
              used to be one page of eight sections and two thousand words. */}
          <SectionList
            section={section}
            reviewCount={needsReview}
            hasUpdate={update !== null}
            onChoose={chooseSection}
          />

          <div className="settings-content">
            {section === 'library' && (
              <>
                <section className="settings-section">
                  <h2>Folders</h2>
                  {roots.length === 0 ? (
                    <p className="muted">
                      No folders yet. Add one and Kinema will scan it now and at every start.
                    </p>
                  ) : (
                    <ul className="settings-roots">
                      {roots.map((root) => (
                        <li key={root.id}>
                          <span className={`root-kind ${root.kind}`}>
                            {root.kind === 'tv' ? 'TV' : 'Movies'}
                          </span>
                          <span className="root-path">{root.path}</span>
                          <span className="muted">{count(root.file_count, 'file')}</span>
                          <ConfirmButton
                            keepInView="nearest"
                            className="settings-remove"
                            confirmLabel="Remove it"
                            onConfirm={() =>
                              void removeLibraryRoot(root.id)
                                .then(refresh)
                                .catch((e) => setError(userError(e)))
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
                    {/* During the scan's detection pass — minutes of work nobody
                        asked for by name — this same button stops it. The same
                        button, not a second one: a Stop that vanishes when
                        detection ends takes the remote's focus with it. */}
                    <FocusButton
                      keepInView="nearest"
                      className="btn-primary"
                      onSelect={() =>
                        void (scan?.stage === 'detecting' ? stopDetection() : scanNow())
                      }
                    >
                      {scan?.stage === 'detecting'
                        ? 'Stop detection'
                        : scan
                          ? `${scan.stage}…`
                          : 'Scan now'}
                    </FocusButton>
                  </div>

                  {scan && (
                    <p className="settings-progress">
                      {scan.stage}
                      {scan.detail ? ` — ${scan.detail}` : ''}
                    </p>
                  )}

                  {!scan && last && <p className="muted">Last scan: {summaryLine(last)}</p>}
                  {/* The report from the intro/credits pass at the end of the
                      scan. Deliberately rendered even when every line is a
                      "skipped": a Skiptro that is no longer where it was
                      configured is exactly the failure this display exists to
                      stop being silent. */}
                  {!scan &&
                    last &&
                    detectLines(last.detectNotes).map((line) => (
                      <p className="muted" key={line}>
                        Markers: {line}
                      </p>
                    ))}
                  <p className="muted">Checked every time Kinema starts, so the button is rarely needed.</p>
                  <MoreAbout>
                    <p>
                      Kinema only looks at file names, sizes and dates rather than reading the
                      videos themselves, which keeps it quick even over a network. A folder that
                      is switched off or unplugged is left alone until it comes back, not
                      forgotten. When it finds new episodes it goes on to look for their intros
                      and credits, so a season you drop in is ready without pressing anything.
                    </p>
                  </MoreAbout>
                </section>

                {/* Under the folders, because these two are the whole of what a
                    new library needs. */}
                <section className="settings-section">
                  <h2>Needs attention</h2>
                  <p className="muted">
                    Videos Kinema could not identify for certain. Pick the right title for each
                    rather than have it guess.
                  </p>
                  <FocusButton
                    focusKey={REVIEW_BUTTON_KEY}
                    keepInView="nearest"
                    className={needsReview > 0 ? 'btn-primary' : 'btn-secondary'}
                    onSelect={() => setPanel((p) => (p === 'review' ? 'none' : 'review'))}
                  >
                    {needsReview > 0 ? `Review ${count(needsReview, 'item')}` : 'Nothing to review'}
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

                <section className="settings-section">
                  <h2>Posters and descriptions</h2>
                  <p className="muted">
                    TV shows need no key. Movies need a free key from TMDB for posters,
                    descriptions and artwork.
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
                    {/* Masked. This screen is routinely on a television, and a
                        key on a 60-inch panel in a living room is not private. */}
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
                      OMDb <span className="muted">optional — a fallback for movies, poster only</span>
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
                  <MoreAbout>
                    <p>
                      Keys save themselves as you type, and are stored in the local database in
                      app data. A new key applies to matches made from now on; titles already in
                      the library keep what they matched until they are matched again.
                    </p>
                  </MoreAbout>
                  {/* Attribution TMDB require wherever their data is shown, and
                      TVmaze's licence asks for. The logo is TMDB's own unmodified
                      SVG, served from the app rather than hotlinked. */}
                  <div className="settings-attribution">
                    <img src="/tmdb.svg" alt="TMDB" className="tmdb-logo" />
                    <p className="muted">
                      Movie and TV data from TMDB. This product uses the TMDB API but is not
                      endorsed or certified by TMDB. TV data also from <strong>TVmaze</strong>.
                    </p>
                  </div>
                </section>
              </>
            )}

            {section === 'playback' && (
              <section className="settings-section">
                <h2>Playback</h2>
                <ChoiceRow
                  label="Where Kinema is used"
                  choices={[
                    { value: 'desk', label: 'At a desk' },
                    { value: 'tv', label: 'On a TV' },
                  ]}
                  value={tvMode ? 'tv' : 'desk'}
                  onChange={(v) => setTvMode(v === 'tv')}
                  note={
                    <>
                      On a TV, Kinema fills the screen with bigger text and a safe margin. Also on{' '}
                      <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>.
                    </>
                  }
                />
                <LanguageSection onError={setError} />
                <ChoiceRow
                  label="Intros and credits"
                  choices={[
                    { value: 'button', label: 'Show a Skip button' },
                    { value: 'auto', label: 'Skip them' },
                  ]}
                  value={autoSkip ? 'auto' : 'button'}
                  onChange={(v) => {
                    setAutoSkip(v === 'auto');
                    void setSetting('skip_mode', v).catch((e) => setError(userError(e)));
                  }}
                  note="Works wherever their times are known — see Intro & credits."
                />
                <ChoiceRow
                  label="Offer the next episode, when the credits are not known"
                  choices={CREDITS_TAIL_CHOICES.map((n) => ({
                    value: String(n),
                    label: n === 0 ? 'At the end' : `${n}s before`,
                  }))}
                  value={String(creditsTail)}
                  onChange={(v) => {
                    const next = Number(v);
                    setCreditsTail(next);
                    void setSetting(CREDITS_TAIL_KEY, v).catch((e) => setError(userError(e)));
                  }}
                  note="A guess at where the credits start, used only when nothing knows better."
                  more={
                    <p>
                      For episodes where nothing has found the credits, Kinema guesses they are
                      the last stretch and offers the next episode then. Anything that actually
                      knows — a real marker, or a chapter named for the credits — is used
                      instead. Never applies to movies, or to the last episode you have.
                    </p>
                  }
                />
                {/* The one rendering switch in the app, and it exists only
                    because the right answer depends on hardware this code
                    cannot see. Everything else the app decides for itself. */}
                <ChoiceRow
                  label="Frame timing"
                  choices={[
                    { value: 'audio', label: 'Match the sound' },
                    { value: 'display', label: 'Match the screen' },
                  ]}
                  value={displaySync ? 'display' : 'audio'}
                  onChange={(v) => {
                    setDisplaySync(v === 'display');
                    void setSetting(VIDEO_SYNC_KEY, v).catch((e) => setError(userError(e)));
                  }}
                  note="If playback stutters slightly every few seconds, try the other one."
                  more={
                    <p>
                      Two ways of deciding when to show each frame; which is smoother depends on
                      your screen, so keep whichever looks better. It will not fix the regular,
                      rhythmic judder movies show on most monitors — that is the refresh rate not
                      dividing into 24 frames a second, which only matching the refresh rate
                      helps (Picture &amp; sound). Press <kbd>i</kbd> while something plays to
                      see what you are getting.
                    </p>
                  }
                />
              </section>
            )}

            {section === 'picture' && (
              <>
                <ScreenSection onError={setError} />
                <SoundSection onError={setError} />
                <EquipmentSection />
              </>
            )}

            {section === 'intros' && (
              <>
                {/* Three sources, in the order they are trusted: Skiptro and
                    this app's own analysis both measure the exact file on this
                    disk, but only the analysis finds credits; TheIntroDB was
                    timed by people against some copy of the episode, and is the
                    only one that answers without reading the file at all. */}
                <section className="settings-section">
                  <h2>Intro and credits</h2>
                  <p className="muted">
                    Where Kinema finds out when intros and credits start. Nothing here needs
                    setting up: new episodes are looked at by themselves.
                  </p>
                  <MoreAbout>
                    <p>
                      There is more than one source and they are good at different things; if
                      several find the same episode, the most reliable one wins. Every time a
                      scan finds new episodes Kinema looks for their intros and credits straight
                      afterwards. The Detect button below does the same on demand, one TV folder
                      at a time.
                    </p>
                  </MoreAbout>

                  <h3>Built in</h3>
                  <ChoiceRow
                    label="Built-in detection"
                    choices={[
                      { value: 'on', label: 'After each scan' },
                      { value: 'off', label: 'Only when I press Detect' },
                    ]}
                    value={autoAnalyse ? 'on' : 'off'}
                    onChange={(v) => {
                      setAutoAnalyse(v === 'on');
                      void setSetting(AUTO_ANALYSE_KEY, v).catch((e) => setError(userError(e)));
                    }}
                    note="Listens to a season's episodes for the music they share. A few minutes per season, once."
                    more={
                      <p>
                        Near the beginning the shared stretch is the theme tune, near the end the
                        closing music. It is the only source that finds credits by measuring them,
                        and the only one that works on episodes Kinema could not identify. It
                        reads about six minutes of audio per episode. Turning it off loses
                        nothing already found, and the Detect row below says how many episodes
                        are waiting.
                      </p>
                    }
                  />
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
                  {/* Answered here rather than discovered during a detection
                      run. A wrong path used to stay silent for minutes and then
                      surface as somebody else's failure. */}
                  {ffmpeg && (
                    <p className={ffmpeg.available ? 'settings-ok' : 'settings-warn'}>
                      {ffmpeg.available
                        ? `Found ffmpeg at ${ffmpeg.resolved}.`
                        : `Could not find ffmpeg (looked for "${ffmpeg.resolved}"). Install it, ` +
                          `or type the full path to ffmpeg.exe here. Without it, the built-in ` +
                          `detection is skipped — everything else works normally.`}
                    </p>
                  )}
                  <MoreAbout>
                    <p>
                      ffmpeg is a free tool for reading video and audio files. Kinema does not
                      include it: install it yourself and it is found automatically. Without it,
                      this source is skipped and the others carry on.
                    </p>
                  </MoreAbout>

                  <h3>TheIntroDB</h3>
                  <ChoiceRow
                    label="TheIntroDB"
                    choices={[
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' },
                    ]}
                    value={introDb ? 'on' : 'off'}
                    onChange={(v) => {
                      setIntroDb(v === 'on');
                      void setSetting(INTRODB_ENABLED_KEY, v).catch((e) => setError(userError(e)));
                    }}
                    note="Times shared by other viewers, looked up quietly the first time you play an episode."
                    more={
                      <p>
                        It answers straight away without reading your files, but popular shows
                        are covered far better than obscure ones. Kinema keeps each answer for a
                        month, never looks up your whole library at once, and sends only which
                        episode it is — nothing about you or your files. No account or key.
                      </p>
                    }
                  />
                  {/* Attribution they request; it costs one line. */}
                  <p className="muted">
                    Segment data from <strong>TheIntroDB</strong> — <code>https://theintrodb.org</code>.
                  </p>

                  <h3>Skiptro</h3>
                  <p className="muted">
                    Optional: a separate free program that finds intros very well. If you have
                    never heard of it, leave this alone.
                  </p>
                  <div className="settings-row">
                    <FocusButton
                      keepInView="nearest"
                      className="btn-secondary"
                      onSelect={() => void openUrl(SKIPTRO_URL)}
                    >
                      Open the Skiptro page ↗
                    </FocusButton>
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
                            setError(userError(e));
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
                  <MoreAbout>
                    <p>
                      Skiptro finds TV intros — not credits — and after years of tuning, where it
                      and the built-in detection disagree about an intro, Skiptro wins. Kinema
                      does not include it and never will: you install it yourself, and Kinema
                      runs it whenever a scan finds new episodes and reads its results. If it
                      stops being where you pointed, Kinema says so after the scan.
                    </p>
                    {/* Text fields rather than hard-coded, so a change to
                        Skiptro's command line is an edit here and not a new
                        build. They save themselves. */}
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
                        How to export <span className="muted">leave empty</span>
                      </span>
                      <FocusInput
                        className="settings-input"
                        value={exportArgs}
                        onChange={setExportArgs}
                        placeholder="not run"
                      />
                    </label>
                    <p>
                      Exporting writes one small extra file beside every episode, holding what
                      Kinema already reads from Skiptro&rsquo;s database — worth it only if another
                      player should read the same results. Type <code>export {'{dir}'}</code> to
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
                  </MoreAbout>

                  {/* One button per TV root, running every source that is
                      configured. TV roots only: the method is "what do these
                      episodes have in common", which a movies folder cannot
                      answer. */}
                  <h3>Run detection</h3>
                  <p className="muted">
                    {tvRoots.length === 0
                      ? 'Add a TV folder in Library to detect intros and credits in it.'
                      : 'Only needed after changing something here. Nothing is written next to your videos.'}
                  </p>
                  {tvRoots.map((root) => (
                    <div className="settings-toggle-row" key={root.id}>
                      {/* While this folder is detecting, the button stops it —
                          the same button, so focus has nowhere to fall when
                          detection ends. Only one detection runs at a time. */}
                      <FocusButton
                        keepInView="nearest"
                        className="btn-secondary"
                        disabled={
                          (detecting !== null && detecting !== root.path) ||
                          scan?.stage === 'detecting'
                        }
                        onSelect={() =>
                          void (detecting === root.path ? stopDetection() : runDetect(root))
                        }
                      >
                        {detecting === root.path ? 'Stop detecting' : 'Detect'}
                      </FocusButton>

                      <span className="muted">
                        <code>{root.path}</code>
                        {detecting !== root.path && (backlog[root.id] ?? 0) > 0 && (
                          <>
                            {' · '}
                            <strong>{count(backlog[root.id], 'episode')} not analysed yet</strong>
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
                </section>
              </>
            )}

            {section === 'advanced' && (
              <>
                <section className="settings-section">
                  <h2>Updates</h2>
                  {update && (
                    <div className="settings-update">
                      <strong>Kinema {update.version} is available.</strong>
                      <FocusButton
                        keepInView="nearest"
                        className="btn-primary"
                        onSelect={() =>
                          void openUrl(update.url).catch((e) => setError(userError(e)))
                        }
                      >
                        Open the download page ↗
                      </FocusButton>
                    </div>
                  )}
                  <ChoiceRow
                    label="Look for new versions"
                    choices={[
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' },
                    ]}
                    value={checkUpdates ? 'on' : 'off'}
                    onChange={(v) => {
                      setCheckUpdates(v === 'on');
                      void setSetting(UPDATE_CHECK_KEY, v).catch((e) => setError(userError(e)));
                    }}
                    note="Asks GitHub for the latest version number when Kinema starts. Downloads nothing."
                  />
                </section>

                <section className="settings-section">
                  <h2>Storage</h2>
                  <p className="muted">
                    Artwork kept on this PC so browsing works offline:{' '}
                    {art ? `${count(art.files, 'image')}, ${formatBytes(art.bytes)}` : '—'}. Safe to
                    clear; it downloads again.
                  </p>
                  <FocusButton
                    keepInView="nearest"
                    className="btn-secondary"
                    onSelect={() =>
                      void (async () => {
                        try {
                          const removed = await clearArtworkCache();
                          await refresh();
                          setNote(`Removed ${count(removed, 'cached image')}.`);
                        } catch (e) {
                          setError(userError(e));
                        }
                      })()
                    }
                  >
                    Clear artwork cache
                  </FocusButton>
                </section>

                <section className="settings-section">
                  <h2>Sharing with other media apps</h2>
                  <p className="muted">
                    Kinema reads .nfo files beside your videos and believes them. It can also write
                    them, for Kodi and other apps to read.
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
                  <MoreAbout>
                    <p>
                      .nfo files are small text files that sit next to a video and say what it
                      is; Kodi, MediaElch and tinyMediaManager all read and write them. One next
                      to a video wins over Kinema&rsquo;s own guess — often the quickest fix for a
                      stubborn mismatch. Writing leaves existing files alone unless you choose
                      to replace them, and skips folders it cannot write to.
                    </p>
                  </MoreAbout>
                </section>

                <section className="settings-section">
                  <h2>Developer tools</h2>
                  <p className="muted">
                    For working on Kinema itself, and mouse-only. The log folder holds what a bug
                    report needs: <code>app.log</code> and <code>mpv.log</code>.
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
                      onSelect={() => void openLogFolder().catch((e) => setError(userError(e)))}
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
              </>
            )}
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The section list, as a focus container of its own.
 *
 * Left from a setting used to go to whichever list entry happened to be
 * level with it — often not the open section. As one container, the list is
 * a single thing to arrive at, and arriving always lands on the open section.
 */
function SectionList({
  section,
  reviewCount,
  hasUpdate,
  onChoose,
}: {
  section: SectionId;
  reviewCount: number;
  hasUpdate: boolean;
  onChoose: (id: SectionId) => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: 'settings-nav',
    trackChildren: true,
    saveLastFocusedChild: false,
    preferredChildFocusKey: `settings-nav:${section}`,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <nav className="settings-nav" aria-label="Settings sections" ref={ref}>
        {SECTIONS.map(([id, label]) => (
          <FocusButton
            key={id}
            focusKey={`settings-nav:${id}`}
            className={section === id ? 'active' : ''}
            keepInView="page-top"
            onSelect={() => onChoose(id)}
          >
            {label}
            {id === 'library' && reviewCount > 0 && <span className="nav-badge">{reviewCount}</span>}
            {id === 'advanced' && hasUpdate && <span className="nav-dot" />}
          </FocusButton>
        ))}
      </nav>
    </FocusContext.Provider>
  );
}
