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
import { availableUpdate, UPDATE_CHECK_KEY, type Release } from './updates';
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import FocusButton from './FocusButton';
import { count, formatBytes } from './format';
import FocusInput from './FocusInput';
import BackupSection from './BackupSection';
import AccountSection, { AccountAppFields } from './AccountSection';
import { ForcedSubtitleRows, OpenSubtitlesSection } from './SubtitlesSettings';
import ConfirmButton from './ConfirmButton';
import EquipmentSection from './EquipmentSection';
import SoundSection from './SoundSection';
import ScreenSection from './ScreenSection';
import { useCapabilities } from '../capabilities';
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
  INTRODB_APP_ENABLED_KEY,
  INTRODB_ENABLED_KEY,
  SKIPTRO_DB_PATH_KEY,
  SKIPTRO_EXPORT_ARGS_KEY,
  SKIPTRO_PATH_KEY,
  SKIPTRO_SCAN_ARGS_KEY,
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
import { BUILTIN_TMDB_KEY, builtinKeyRejected } from '../metadata/builtinKey';
import {
  CREDITS_TAIL_CHOICES,
  CREDITS_TAIL_KEY,
  DEFAULT_CREDITS_TAIL_SECS,
} from '../player/skip';
import { VIDEO_SYNC_KEY } from '../player/mpvOptions';
import { buildNfoExports, writeNfo } from '../metadata/nfo';
import { detectLines } from '../library/detectReport';
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
const FFMPEG_URL = 'https://ffmpeg.org/download.html';

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

/** The Review button, where focus lands when Settings opens on the queue. */
const REVIEW_BUTTON_KEY = 'settings-review-button';
const TMDB_KEY_INPUT_KEY = 'settings-tmdb-key';
const FFMPEG_INPUT_KEY = 'settings-ffmpeg';

/** Where Home's notices can open Settings: the review queue, the TMDB key or ffmpeg. */
export type SettingsTarget = 'review' | 'tmdb-key' | 'ffmpeg';

type SectionId = 'library' | 'playback' | 'picture' | 'intros' | 'accounts' | 'advanced';

/** The list down the side, in the order someone setting up would need them. */
const SECTIONS: [SectionId, string][] = [
  ['library', 'Library'],
  ['playback', 'Playback'],
  ['picture', 'Picture & sound'],
  ['intros', 'Intro & credits'],
  // Services signed into with the user's own account. Keys that identify
  // films stay in Library; the keyless skip databases in Intro & credits.
  ['accounts', 'Accounts'],
  ['advanced', 'Advanced'],
];

/** Coming back to Settings opens the section you were last in. */
let lastSection: SectionId = 'library';

export default function Settings({ openSection }: { openSection?: SettingsTarget }) {
  const { ref, focusKey } = useFocusable({
    focusKey: SETTINGS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  const [section, setSection] = useState<SectionId>(
    openSection === 'ffmpeg' ? 'intros' : openSection ? 'library' : lastSection
  );
  const chooseSection = useCallback((id: SectionId) => {
    lastSection = id;
    setSection(id);
  }, []);

  // Land on the open section in the list — or, from Home's notice, straight
  // on the review queue.
  useClaimFocus(
    openSection === 'review'
      ? REVIEW_BUTTON_KEY
      : openSection === 'tmdb-key'
        ? TMDB_KEY_INPUT_KEY
        : openSection === 'ffmpeg'
          ? FFMPEG_INPUT_KEY
          : `settings-nav:${section}`,
    true
  );

  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [needsReview, setNeedsReview] = useState(0);
  const [art, setArt] = useState<ArtworkStats | null>(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [omdbKey, setOmdbKey] = useState('');
  /** TMDB has refused Kinema's own key, so one of the user's own is needed. */
  const [builtinRejected, setBuiltinRejected] = useState(false);
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
   * How the last Detect ended for each folder, shown in that folder's own
   * line. It used to go to the banner under the page title, a screen and a
   * half above the button: the trap GOTCHAS describes, where a working button
   * reads as a dead one.
   */
  const [detectOutcomes, setDetectOutcomes] = useState<
    Record<string, { text: string; failed: boolean }>
  >({});
  /** Set by Stop, so the folders after the current one are not started. */
  const detectStopped = useRef(false);
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
  const [introDbApp, setIntroDbApp] = useState(true);
  // Likewise: the built-in analysis runs after a scan unless it is switched off.
  const [autoAnalyse, setAutoAnalyse] = useState(true);

  const tvMode = useTvMode();
  const can = useCapabilities();
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
      setBuiltinRejected(await builtinKeyRejected());
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
      setIntroDbApp((await getSetting(INTRODB_APP_ENABLED_KEY)) !== 'off');
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

  /**
   * Saves still waiting out their debounce, run when Settings closes instead
   * of being dropped with their timer. Paste a key, press Back at once, and
   * the key used to be gone — which looks exactly like the key being wrong.
   */
  const pendingSaves = useRef(new Map<string, () => Promise<void>>());
  useEffect(() => {
    const pending = pendingSaves.current;
    return () => {
      for (const save of pending.values()) {
        void save().catch((e) => console.warn('settings: saving on the way out failed', e));
      }
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (!skiptroLoaded) return;
    const pending = pendingSaves.current;
    pending.set('skiptro', saveSkiptroFields);
    const id = window.setTimeout(() => {
      pending.delete('skiptro');
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
    const save = async () => {
      await setSetting('tmdb_api_key', tmdbKey.trim());
      await setSetting('omdb_api_key', omdbKey.trim());
    };
    const pending = pendingSaves.current;
    pending.set('keys', save);
    const id = window.setTimeout(() => {
      pending.delete('keys');
      void save()
        .then(() => setKeysSaved(true))
        .catch((e) => setError(userError(e)));
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

  /**
   * Detect in every TV folder, one after another. It used to be one Detect
   * button per folder, which on a library of three folders was three buttons
   * with the same name and no way to tell why there were three.
   */
  const runDetect = useCallback(
    async (folders: LibraryRoot[]) => {
      setError(null);
      setNote(null);
      setDetectOutcomes({});
      detectStopped.current = false;
      try {
        // Flush the command fields before reading them in Rust. The debounce
        // above would almost always have fired by now, and "almost always" is
        // how you get a detect run that silently used the previous command.
        await saveSkiptroFields();
      } catch (e) {
        setError(userError(e));
        return;
      }
      for (const root of folders) {
        if (detectStopped.current) break;
        setDetectLine('');
        setDetecting(root.path);
        const outcome = (text: string, failed = false) =>
          setDetectOutcomes((o) => ({ ...o, [root.path]: { text, failed } }));
        try {
          const report = await detectIntros(root.path);
          if (report.stopped) {
            outcome('Stopped. Seasons it had finished are kept; the rest is picked up next time.');
            break;
          } else if (report.ok) {
            // No longer "sidecars written": the detections go into Skiptro's own
            // database and are read from there. Nothing is written beside the
            // videos unless an export command has been typed back in.
            outcome('Finished.');
          } else {
            // Name the step that actually failed, and name it *correctly*. This
            // used to take the last step and call it Skiptro, but this app's own
            // analysis is always pushed last, under the name `analyse`, so a
            // missing ffmpeg was reported as a Skiptro failure to users who had
            // never installed Skiptro.
            const failed =
              report.steps.find((s) => s.exit_code !== 0) ?? report.steps[report.steps.length - 1];
            const owner = failed?.step === 'analyse' ? 'Detection' : `Skiptro "${failed?.step}"`;
            const code =
              failed?.exit_code === null ? 'did not finish' : `stopped with code ${failed?.exit_code}`;
            const detail = failed?.tail.slice(-3).join(' · ') || 'no output';
            outcome(`${owner} ${code}: ${detail}`, true);
          }
        } catch (e) {
          outcome(userError(e), true);
        }
      }
      setDetecting(null);
      setDetectLine('');
      // The backlog is why the button was pressed; it has to be re-read, or
      // it would still claim the work is outstanding.
      void refresh();
    },
    [saveSkiptroFields, refresh]
  );

  const stopDetecting = useCallback(() => {
    detectStopped.current = true;
    void stopDetection();
  }, []);

  const scanNow = useCallback(async () => {
    setError(null);
    setNote(null);
    const outcome = await runScanPipeline();
    if (outcome.status === 'failed') setError(outcome.error);
    else if (outcome.status === 'skipped')
      setNote(
        outcome.reason === 'no-roots'
          ? 'Add a folder first. There is nothing to scan yet.'
          : 'A scan is already running.'
      );
    else {
      setNote(summaryLine(outcome.summary));
      if (outcome.summary.parseError) setError(`The file name reader failed: ${outcome.summary.parseError}`);
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
                  <p className="settings-intro">
                    Where Kinema finds your movies and TV shows. It checks them every time it
                    starts, so Scan now is only needed for files added while Kinema is open.
                  </p>
                  {roots.length === 0 ? (
                    <p className="muted">No folders yet. Add one and Kinema scans it straight away.</p>
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
                      {scan.detail ? `: ${scan.detail}` : ''}
                    </p>
                  )}

                  {!scan && last && <p className="muted">Last scan: {summaryLine(last)}</p>}
                  {/* The report from the intro/credits pass at the end of the
                      scan, here rather than under Intro & credits because this
                      is where people look after a scan. Problems are always
                      shown: a Skiptro that is no longer where it was set up is
                      exactly the failure this exists to stop being silent. */}
                  {!scan &&
                    last &&
                    detectLines(last.detectNotes).map((line) => (
                      <p className="muted" key={line}>
                        {line}
                      </p>
                    ))}
                  <p className="settings-hint">
                    A scan reads only file names, sizes and dates, so it is quick even over a
                    network. A folder that is switched off or unplugged is left alone until it is
                    back. New episodes are checked for intros and credits straight afterwards.
                  </p>
                </section>

                {/* Under the folders, because these two are the whole of what a
                    new library needs. */}
                <section className="settings-section">
                  <h2>Needs attention</h2>
                  <p className="settings-intro">
                    Videos Kinema could not identify for certain. It asks you instead of guessing,
                    because a wrong title is harder to spot than a missing one.
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
                  <p className="settings-intro">
                    {!BUILTIN_TMDB_KEY
                      ? 'Without a TMDB key, movies are identified through Wikidata: details and ' +
                        'a description, but no posters. A free TMDB key adds posters, ' +
                        'backdrops and cast.'
                      : builtinRejected
                        ? 'TMDB no longer accepts the key Kinema came with. Until an update ' +
                          'brings a new one, new movies are identified through Wikidata, ' +
                          'without posters. A free key of your own brings them back.'
                        : 'Kinema looks up movies and TV shows on TMDB with a key of its own, ' +
                          'so there is nothing to set up. You can use your own free key instead.'}
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
                      {BUILTIN_TMDB_KEY ? 'Your own TMDB key ' : 'TMDB key '}
                      <span className="muted">
                        {BUILTIN_TMDB_KEY && !builtinRejected
                          ? '(optional, used instead of Kinema’s)'
                          : '(posters, backdrops, cast and episode pictures)'}
                      </span>
                    </span>
                    {/* Masked. This screen is routinely on a television, and a
                        key on a 60-inch panel in a living room is not private. */}
                    <FocusInput
                      focusKey={TMDB_KEY_INPUT_KEY}
                      className="settings-input"
                      value={tmdbKey}
                      onChange={(v) => {
                        setTmdbKey(v);
                        setKeysSaved(false);
                      }}
                      type="password"
                      placeholder={
                        BUILTIN_TMDB_KEY && !builtinRejected ? 'Not needed' : 'Paste your TMDB key'
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>
                      OMDb key <span className="muted">(optional)</span>
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
                  <p className="choice-note">
                    An OMDb key adds Rotten Tomatoes scores to a title&rsquo;s page, and helps
                    identify movies. A free key allows 1,000 lookups a day and Kinema uses at most
                    500, so a large library fills in over a few days.
                  </p>
                  <p className="settings-hint">
                    Keys save as you type. A new key is used for titles identified from now on;
                    titles already in the library keep what they have until they are looked up
                    again.
                  </p>
                  {/* Attribution TMDB require wherever their data is shown, and
                      TVmaze's licence asks for. The logo is TMDB's own unmodified
                      SVG, served from the app rather than hotlinked. */}
                  <div className="settings-attribution">
                    <img src="/tmdb.svg" alt="TMDB" className="tmdb-logo" />
                    <p className="muted">
                      Movie and TV data from TMDB. This product uses the TMDB API but is not
                      endorsed or certified by TMDB. TV data also from <strong>TVmaze</strong>.
                      Movies found without a TMDB key: data from <strong>Wikidata</strong>, and
                      descriptions from <strong>Wikipedia</strong> under CC BY-SA 4.0.
                    </p>
                    {/* The exact statement IMDb's terms for its ratings file
                        require. */}
                    <p className="muted">
                      IMDb ratings: Information courtesy of IMDb (https://www.imdb.com). Used with
                      permission.
                    </p>
                    {/* OMDb's data is CC BY-NC 4.0, which asks for a credit. */}
                    <p className="muted">
                      Rotten Tomatoes scores from <strong>OMDb</strong>, with your own key, under
                      CC BY-NC 4.0.
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
                  note="On a TV, Kinema fills the whole screen, with bigger text and a margin that keeps clear of the edges some TVs cut off. At a desk it runs in a window and its text grows with the window."
                  hint={
                    <>
                      Switch between them any time with <kbd>F11</kbd>, or{' '}
                      <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>.
                    </>
                  }
                />
                <LanguageSection onError={setError} />
                <ForcedSubtitleRows onError={setError} />
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
                  note="Show a Skip button lets you choose each time. Skip them jumps straight past intros and end credits."
                  hint="Works for episodes where Kinema knows where they are. Intro & credits says how it finds out."
                />
                <ChoiceRow
                  label="When the end credits are not known, offer the next episode"
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
                  note="For an episode where nothing has found the end credits, Kinema guesses they are the last stretch and offers the next episode this long before the end."
                  hint="Where the credits are known, from detection or a chapter named for them, that is used instead. Never for movies, or for the last episode you have."
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
                  note="Two ways of deciding when each frame is shown. Which is smoother depends on the screen: keep Match the sound unless playback stutters slightly every few seconds, then try Match the screen."
                  hint={
                    <>
                      Neither fixes the steady judder of a 24 frames a second movie on a 60 Hz
                      screen; Match the refresh rate in Picture &amp; sound does. Press{' '}
                      <kbd>I</kbd> while something plays to see what you are getting.
                    </>
                  }
                />
              </section>
            )}

            {section === 'picture' && (
              <>
                {/* Each part only where Kinema can do it (capabilities.ts):
                    a control that does nothing is worse than none. */}
                {can?.display_switching && <ScreenSection onError={setError} />}
                {can?.equipment_detection && <SoundSection onError={setError} />}
                {can?.equipment_detection && <EquipmentSection />}
                {can && !(can.display_switching && can.equipment_detection) && (
                  <section className="settings-section">
                    <h2>Picture &amp; sound</h2>
                    <p className="settings-intro">
                      {can.equipment_detection
                        ? `On ${can.system}, Kinema cannot change the screen's refresh rate, resolution or HDR yet.`
                        : `On ${can.system}, Kinema cannot yet look at your screen and sound equipment${
                            can.display_switching ? '' : " or change the screen's mode"
                          }, so films play with ${can.system}'s own picture and sound settings.`}
                    </p>
                  </section>
                )}
              </>
            )}

            {section === 'intros' && (
              <>
                {/* Four sources, in the order they are trusted: Skiptro and
                    this app's own analysis both measure the exact file on this
                    disk, but only the analysis finds credits; TheIntroDB and
                    IntroDB.app were timed by people against some copy of the
                    episode, answer without reading the file at all, and are
                    the only ones that know recaps and a film's scene after
                    the credits. */}
                <section className="settings-section">
                  <h2>Intro and credits</h2>
                  <p className="settings-intro">
                    How Kinema finds where intros, recaps and end credits are, for the Skip button
                    and for offering the next episode. It works by itself: new episodes are checked
                    after every scan. When more than one source knows an episode, the most
                    reliable one is used.
                  </p>

                  <h3>Built into Kinema</h3>
                  <ChoiceRow
                    label="Detect intros and credits"
                    choices={[
                      { value: 'on', label: 'After each scan' },
                      { value: 'off', label: 'Only when I press Detect' },
                    ]}
                    value={autoAnalyse ? 'on' : 'off'}
                    onChange={(v) => {
                      setAutoAnalyse(v === 'on');
                      void setSetting(AUTO_ANALYSE_KEY, v).catch((e) => setError(userError(e)));
                    }}
                    note="Kinema listens to a season's episodes for the music they share: the theme tune near the start, the closing music near the end. It takes a few minutes per season, once."
                    hint="The only source that measures end credits, and the only one that works on episodes Kinema could not identify. Needs ffmpeg (below). Turning it off keeps everything already found."
                  />
                  <label className="settings-field">
                    <span>
                      Where ffmpeg is{' '}
                      <span className="muted">(leave empty unless Kinema cannot find it)</span>
                    </span>
                    <FocusInput
                      focusKey={FFMPEG_INPUT_KEY}
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
                          `or type the full path to ffmpeg.exe here. Without it, this detection ` +
                          `and the picture and sound details on a title's page are skipped. ` +
                          `Everything else works normally.`}
                    </p>
                  )}
                  <p className="settings-hint">
                    ffmpeg is a free program for reading video and audio. Kinema does not include
                    it: install it yourself and Kinema finds it. It is also used once per file to
                    read the resolution, HDR and sound format shown on a title&rsquo;s page.
                  </p>
                  <div className="settings-row">
                    <FocusButton
                      keepInView="nearest"
                      className="btn-secondary"
                      onSelect={() => void openUrl(FFMPEG_URL)}
                    >
                      Open the ffmpeg download page ↗
                    </FocusButton>
                  </div>

                  <h3>TheIntroDB</h3>
                  <ChoiceRow
                    label="Look up TheIntroDB"
                    choices={[
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' },
                    ]}
                    value={introDb ? 'on' : 'off'}
                    onChange={(v) => {
                      setIntroDb(v === 'on');
                      void setSetting(INTRODB_ENABLED_KEY, v).catch((e) => setError(userError(e)));
                    }}
                    note="Intro and credit times shared by other viewers, looked up the first time you play an episode. It answers straight away, without reading your files."
                    hint="Popular shows are covered far better than rare ones. Kinema sends only which episode it is, keeps each answer for a month and never looks up your whole library at once. No account or key."
                  />
                  {/* Attribution they request; it costs one line. */}
                  <p className="settings-hint">
                    Segment data from <strong>TheIntroDB</strong>, <code>https://theintrodb.org</code>.
                  </p>

                  <h3>IntroDB</h3>
                  <ChoiceRow
                    label="Look up IntroDB"
                    choices={[
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' },
                    ]}
                    value={introDbApp ? 'on' : 'off'}
                    onChange={(v) => {
                      setIntroDbApp(v === 'on');
                      void setSetting(INTRODB_APP_ENABLED_KEY, v).catch((e) =>
                        setError(userError(e))
                      );
                    }}
                    note="A second collection of times shared by viewers, and a separate service from TheIntroDB. It fills what TheIntroDB does not know, and it is the only source that knows where a film has a scene after its credits."
                    hint="Kinema sends only which film or episode it is, by its IMDb number, keeps each answer for a month and never looks up your whole library at once. No account or key."
                  />
                  {/* The attribution they ask for, in their words. */}
                  <p className="settings-hint">
                    Intro data provided by <strong>IntroDB</strong> (<code>introdb.app</code>).
                  </p>

                  <h3>Skiptro</h3>
                  <p className="choice-note">
                    Optional: a separate free program that is very good at finding intros (not
                    credits). Where it and the built-in detection disagree about an intro, Skiptro
                    wins. If you have not heard of it, you can leave this alone.
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
                      {skiptroPath ? 'Change Skiptro location' : 'Choose Skiptro'}
                    </FocusButton>
                  </div>
                  <p className="settings-hint">
                    {skiptroPath ? (
                      <>
                        Using <code>{skiptroPath}</code>. Kinema does not include Skiptro: it runs
                        the copy you installed after every scan that finds new episodes, and says
                        so after the scan if it has gone missing.
                      </>
                    ) : (
                      <>
                        Not set. Choose <code>skiptro.exe</code>, the command-line one, not{' '}
                        <code>Skiptro-Desktop.exe</code>.
                      </>
                    )}
                  </p>
                  {/* Only once Skiptro is set up: until then none of these do
                      anything, and three fields about a program someone has
                      never heard of are the clutter this page was cut down to
                      get rid of. Text fields rather than hard-coded, so a
                      change to Skiptro's command line is an edit here and not a
                      new build. They save themselves. */}
                  {skiptroPath && (
                    <div className="settings-subgroup">
                      <label className="settings-field">
                        <span>
                          How to run it{' '}
                          <span className="muted">
                            (leave it as it is unless Skiptro changes; {'{dir}'} stands for the
                            folder)
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
                          How to export <span className="muted">(leave empty)</span>
                        </span>
                        <FocusInput
                          className="settings-input"
                          value={exportArgs}
                          onChange={setExportArgs}
                          placeholder="not run"
                        />
                      </label>
                      <p className="settings-hint">
                        Exporting writes a small extra file next to every episode with what Kinema
                        already reads from Skiptro&rsquo;s database. Only worth it if another player
                        should read the same results; type <code>export {'{dir}'}</code> to switch
                        it on.
                      </p>
                      <label className="settings-field">
                        <span>
                          Skiptro&rsquo;s database{' '}
                          <span className="muted">(only if you moved it)</span>
                        </span>
                        <FocusInput
                          className="settings-input"
                          value={skiptroDbPath}
                          onChange={setSkiptroDbPath}
                          placeholder="%APPDATA%\Skiptro\skiptro.db"
                        />
                      </label>
                    </div>
                  )}

                  {/* One button for every TV folder, running every source that
                      is set up. TV folders only: the method is "what do these
                      episodes have in common", which a movies folder cannot
                      answer. */}
                  <h3>Detect now</h3>
                  {tvRoots.length === 0 ? (
                    <p className="choice-note">
                      Add a TV folder under Library to detect intros and credits in it.
                    </p>
                  ) : (
                    <>
                      <p className="choice-note">
                        Looks for intros and credits in all your TV folders now. Only needed after
                        changing something above. Nothing is written next to your videos.
                      </p>
                      {/* While detection runs, this same button stops it: a Stop
                          that appeared in its place would take the remote's
                          focus with it when detection ended. */}
                      <div className="settings-row">
                        <FocusButton
                          keepInView="nearest"
                          className="btn-secondary"
                          disabled={detecting === null && scan?.stage === 'detecting'}
                          onSelect={() =>
                            detecting !== null ? stopDetecting() : void runDetect(tvRoots)
                          }
                        >
                          {detecting !== null ? 'Stop detecting' : 'Detect now'}
                        </FocusButton>
                      </div>
                      <ul className="detect-folders">
                        {tvRoots.map((root) => {
                          const waiting = backlog[root.id] ?? 0;
                          const outcome = detectOutcomes[root.path];
                          return (
                            <li key={root.id}>
                              <code>{root.path}</code>
                              <span className="muted">
                                {detecting === root.path
                                  ? ' · detecting'
                                  : waiting > 0
                                    ? ` · ${count(waiting, 'episode')} not analysed yet`
                                    : backlog[root.id] === 0
                                      ? ' · all analysed'
                                      : ''}
                              </span>
                              {detecting === root.path && detectLine && (
                                <span className="settings-progress">{detectLine}</span>
                              )}
                              {detecting !== root.path && outcome && (
                                <span
                                  className={outcome.failed ? 'detect-failed' : 'settings-progress'}
                                >
                                  {outcome.text}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </section>
              </>
            )}

            {section === 'accounts' && (
              <>
                <AccountSection service="simkl" />
                <AccountSection service="trakt" />
                <OpenSubtitlesSection />
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
                    note="When Kinema starts, it asks GitHub for the number of the latest version and says here if there is a newer one. Nothing is downloaded."
                  />
                </section>

                <section className="settings-section">
                  <h2>Storage</h2>
                  <p className="settings-intro">
                    Posters and backgrounds are kept on this PC so browsing works offline
                    {art ? ` (${count(art.files, 'image')}, ${formatBytes(art.bytes)})` : ''}.
                    Clearing them is safe: they download again.
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
                  <p className="settings-intro">
                    .nfo files are small text files next to a video that say what it is. Kodi,
                    MediaElch and tinyMediaManager read and write them. Kinema reads them and
                    trusts them over its own guess, which makes one the quickest fix for a movie
                    it keeps getting wrong. It can also write them for other apps to read.
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
                  <p className="settings-hint">
                    Writing leaves existing .nfo files alone unless you choose Replace every one,
                    and skips folders it cannot write to.
                  </p>
                </section>

                <BackupSection />

                <section className="settings-section">
                  <h2>Developer tools</h2>
                  <p className="settings-intro">
                    For working on Kinema itself, and made for a mouse. The log folder holds what a
                    bug report needs: <code>app.log</code> and <code>mpv.log</code>.
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
                  <AccountAppFields />
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
