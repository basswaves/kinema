/**
 * Playback view.
 *
 * Responsibilities beyond playing a file:
 *  - resume from a stored position, and keep that position current
 *  - remember audio/subtitle language per title and re-apply it per file
 *  - offer the next episode when one finishes
 *
 * The window is transparent and mpv renders behind the webview, so nothing here
 * may paint an opaque background.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  doesFocusableExist,
  FocusContext,
  getCurrentFocusKey,
  pause as pauseSpatial,
  resume as resumeSpatial,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import {
  command,
  getProperty,
  listenEvents,
  observeProperties,
  setProperty,
} from 'tauri-plugin-libmpv-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import FocusButton from '../ui/FocusButton';
import { setShortcutsOpen } from '../ui/shortcutsState';
import { ensureMpvInitialised, OBSERVED_PROPERTIES } from './mpv';
import {
  describeTrack,
  findTrackByLang,
  readTracks,
  selectTrack,
  setSubtitleVisibility,
  type MpvTrack,
} from './tracks';
import {
  episodeLabel,
  getProgress,
  getSkipMarkers,
  getTitlePrefs,
  nextEpisode,
  previousEpisode,
  saveProgress,
  setTitlePrefs,
  type EpisodeRef,
  type SkipMarkers,
} from './api';
import {
  activeSkip,
  withResolvedCredits,
  CREDITS_TAIL_KEY,
  DEFAULT_CREDITS_TAIL_SECS,
} from './skip';
import { readChapters, type Chapter } from './chapters';
import { VIDEO_SYNC_KEY, VIDEO_SYNC_MODES } from './mpvOptions';
import { readPlaybackStats, type StatGroup } from './stats';
import { getSetting } from '../metadata/api';

export interface PlaybackTarget {
  path: string;
  label: string;
  fileId: number | null;
  titleId: number | null;
}

interface Props {
  target: PlaybackTarget;
  onExit: () => void;
  onPlayTarget: (target: PlaybackTarget) => void;
}

const OSD_HIDE_MS = 3200;
const PROGRESS_SAVE_MS = 5000;
/** Don't offer to resume a file that barely started. */
const MIN_RESUME_SECS = 30;
/** Or one that is effectively finished. */
const RESUME_MAX_FRACTION = 0.94;
const NEXT_EPISODE_COUNTDOWN = 12;
/** How long a Skip prompt stays on screen before getting out of the way. */
const SKIP_PROMPT_MS = 10000;
/** Stats refresh. Fast enough to watch a drop counter, slow enough to be free. */
const STATS_REFRESH_MS = 1000;
/** Setting key: 'auto' skips without asking, anything else shows the button. */
const SKIP_MODE_KEY = 'skip_mode';
/**
 * How long the resolved marker sources must hold still before they are
 * logged. Chapters are read a moment after the file opens and can move the
 * credits source from `tail` to `chapter`; one line with the final answer is
 * worth more than two where the first is already wrong.
 */
const MARKER_LOG_SETTLE_MS = 3000;

/**
 * Focus keys for the two places focus is aimed at explicitly: the control the
 * OSD opens on, and the track panel, which should take focus the moment it
 * appears rather than making you arrow back up to it.
 */
const PLAYER_SHELL_KEY = 'player-shell';
const PLAYER_PLAY_KEY = 'player-play';
const PLAYER_TRACKS_KEY = 'player-tracks-button';
const TRACK_PANEL_KEY = 'player-track-panel';

/** The label an episode carries into the player, shared with the browsing UI. */
function labelFor(episode: EpisodeRef): string {
  return episodeLabel(episode.title, episode.season, episode.episode);
}

function formatTime(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export default function Player({ target, onExit, onPlayTarget }: Props) {
  const [paused, setPaused] = useState(false);
  const [timePos, setTimePos] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [osdVisible, setOsdVisible] = useState(true);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [showTracks, setShowTracks] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<StatGroup[]>([]);
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);
  const [upNext, setUpNext] = useState<EpisodeRef | null>(null);
  /**
   * Whether the file mpv has open is the one `target` names.
   *
   * False from the moment a new target arrives until mpv reports `file-loaded`.
   * Nothing derived from the playback position may be acted on in that window:
   * `loadfile` is asynchronous, and `time-pos` is an observed property that
   * keeps reporting the *outgoing* file until it completes. Comparing the new
   * episode's markers against the old episode's position is how an Up next card
   * appeared thirty seconds into a fresh episode and never went away.
   */
  const [fileReady, setFileReady] = useState(false);
  /**
   * The same flag, for the mpv event handlers.
   *
   * They are registered once and must not be re-registered whenever this
   * changes — see GOTCHAS on observed properties. An end-of-file that arrives
   * before the new file is open belongs to the *outgoing* one, and acting on it
   * would mark the incoming episode finished and roll straight past it.
   */
  const fileReadyRef = useRef(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [markers, setMarkers] = useState<SkipMarkers | null>(null);
  /**
   * The path the current `markers` were fetched for, once the fetch has
   * finished — including when it found nothing or failed. Until it equals
   * `target.path`, `markers` describe the previous file (or nothing yet).
   */
  const [markersFor, setMarkersFor] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [autoSkip, setAutoSkip] = useState(false);
  const [creditsTailSecs, setCreditsTailSecs] = useState(DEFAULT_CREDITS_TAIL_SECS);
  /** The episodes either side of this file, or null where there is none. */
  const [neighbours, setNeighbours] = useState<{
    prev: EpisodeRef | null;
    next: EpisodeRef | null;
  }>({ prev: null, next: null });
  /** Prompt occurrences the user (or the timer) has already dismissed. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /**
   * Whether the OSD holds focus.
   *
   * This is the switch that decides which of the two live keyboard handlers
   * owns the arrow keys. Off (the default) the spatial system is paused and
   * arrows seek, exactly as a desktop player behaves. On, the spatial system is
   * resumed and arrows move between controls. Exactly one is ever active, which
   * is the whole point: `preventDefault` cannot stop the other listener, so
   * overlapping them would fire both.
   */
  const [osdFocus, setOsdFocus] = useState(false);

  const seekingRef = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  /** Mirror of `osdFocus` for the callbacks that must not be rebuilt on it. */
  const osdFocusRef = useRef(false);

  // Every control in the player hangs off this container, so the OSD has one
  // place to aim focus at and one place to remember where it was.
  const { ref: shellRef, focusKey: shellFocusKey } = useFocusable({
    focusKey: PLAYER_SHELL_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: PLAYER_PLAY_KEY,
  });
  // Live values for the unmount save, which cannot read React state.
  const latest = useRef({ position: 0, duration: null as number | null });
  /** Resume position to apply once the file is actually open. */
  const pendingSeek = useRef<number | null>(null);
  /** Guards against handling the end of the same file twice. */
  const endHandled = useRef(false);
  /** Segments already acted on automatically, so each is skipped once only. */
  const autoHandled = useRef(new Set<string>());
  /**
   * Frame-timing mode, in a ref rather than state because it is applied inside
   * the mpv event listener — reading it from a closure would apply whatever the
   * setting was when that listener was registered.
   */
  const videoSync = useRef<string>(VIDEO_SYNC_MODES.audio);

  const showOsd = useCallback(() => {
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    // Never time out while focus is inside the OSD. Hiding the thing the focus
    // ring is on leaves a remote pressing arrows at an invisible control, which
    // is indistinguishable from a hang — the same silent dead end as focus
    // parked on an unmounted component (docs/GOTCHAS.md).
    if (osdFocusRef.current) return;
    hideTimer.current = window.setTimeout(() => setOsdVisible(false), OSD_HIDE_MS);
  }, []);

  /**
   * Hand the arrow keys to the OSD.
   *
   * `resume()` before `setFocus`: the spatial system ignores navigation while
   * paused, and aiming focus at a control it is not currently listening for
   * would leave the ring nowhere.
   */
  const enterOsdFocus = useCallback(() => {
    osdFocusRef.current = true;
    setOsdFocus(true);
    resumeSpatial();
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    void setFocus(PLAYER_PLAY_KEY);
  }, []);

  /** Give them back to seeking, and let the OSD start timing out again. */
  const leaveOsdFocus = useCallback(() => {
    osdFocusRef.current = false;
    setOsdFocus(false);
    pauseSpatial();
    showOsd();
  }, [showOsd]);

  /**
   * Arrows mean "seek" until asked otherwise, so the spatial system starts
   * paused — and is resumed on the way out, or the browsing UI underneath would
   * be left unable to navigate after the player closes.
   */
  useEffect(() => {
    pauseSpatial();
    return () => resumeSpatial();
  }, []);

  // ---- load, resume, and apply remembered tracks --------------------------
  useEffect(() => {
    let cancelled = false;

    /*
     * Forget where the *previous* file was before loading this one.
     *
     * Everything that decides whether a skip fires is derived from `timePos`
     * and `duration`, and mpv does not update either until the new file is
     * genuinely open. Autoplaying from one episode to the next therefore leaves
     * a window in which the position is near the end, the duration is the old
     * file's, and the credits logic concludes that a file which has not started
     * yet is finishing — flashing the Up next card seconds into the new
     * episode.
     *
     * Nulling these is **not sufficient on its own**, and it took a real
     * credits marker to expose that: `time-pos` is an *observed property*, so
     * mpv pushes the outgoing file's position back in within milliseconds,
     * before `loadfile` has taken effect. `fileReady` is the actual fix — see
     * where it is set — and these stay because they are still what stops the
     * seek bar and the clock showing the previous episode's numbers.
     *
     * Runs after the progress-save cleanup, which is declared later and has
     * already written the outgoing file's position by this point.
     */
    /* eslint-disable react-hooks/set-state-in-effect */
    setTimePos(null);
    setDuration(null);
    setMarkers(null);
    setFileReady(false);
    fileReadyRef.current = false;
    // A card offering the *previous* file's next episode has no business
    // surviving into this one. Nothing else clears these: the countdown path
    // clears them when it advances, and every other route out left them set.
    setUpNext(null);
    setCountdown(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    latest.current = { position: 0, duration: null };

    (async () => {
      try {
        await ensureMpvInitialised();
        if (cancelled) return;

        endHandled.current = false;
        pendingSeek.current = null;

        // Decide the resume point *before* loading, but apply it only once the
        // file is open. Seeking straight after loadfile fails, because loadfile
        // is asynchronous and there is nothing to seek in yet.
        if (target.fileId !== null) {
          const progress = await getProgress(target.fileId);
          if (
            progress &&
            !progress.completed &&
            progress.position_secs >= MIN_RESUME_SECS &&
            (!progress.duration_secs ||
              progress.position_secs / progress.duration_secs < RESUME_MAX_FRACTION)
          ) {
            pendingSeek.current = progress.position_secs;
          }
        }

        await command('loadfile', [target.path]);
        await setProperty('pause', false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.path, target.fileId]);

  /** Apply this title's remembered languages to the freshly loaded file. */
  const applyPrefs = useCallback(async () => {
    const list = await readTracks();
    setTracks(list);

    if (target.titleId !== null) {
      try {
        const prefs = await getTitlePrefs(target.titleId);

        const audio = findTrackByLang(list, 'audio', prefs.audio_lang);
        if (audio) await selectTrack('aid', audio.id);

        if (!prefs.sub_enabled) {
          await setSubtitleVisibility(false);
        } else {
          const sub = findTrackByLang(list, 'sub', prefs.sub_lang);
          if (sub) await selectTrack('sid', sub.id);
          await setSubtitleVisibility(true);
        }
      } catch (e) {
        console.warn('could not apply title preferences', e);
      }
    }

    // Selected track ids come from the track list's own `selected` flags.
    // Reading `sid`/`aid` directly fails with "unsupported format": they are
    // choice properties ("auto" / "no" / an integer), not plain integers.
    const updated = await readTracks();
    setTracks(updated);
    setAid(updated.find((t) => t.type === 'audio' && t.selected)?.id ?? null);
    setSid(updated.find((t) => t.type === 'sub' && t.selected)?.id ?? null);

    try {
      setSubVisible(((await getProperty('sub-visibility', 'flag')) as boolean | null) ?? true);
    } catch {
      setSubVisible(true);
    }
  }, [target.titleId]);

  /**
   * The only way out of the player, and the only place that gives the desktop
   * back. Nothing in the browsing views can leave fullscreen, so landing on a
   * fullscreen Home is a state with no way out of it except starting another
   * video — which is why every exit path goes through here, including the ones
   * nobody pressed a key for.
   *
   * Declared up here with `handlePlaybackEnded` for the same reason that one is:
   * it is called from below, and defining it below only worked by accident of
   * effect ordering.
   */
  const exit = useCallback(async () => {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) await win.setFullscreen(false);
    onExit();
  }, [onExit]);

  /**
   * End of file. Declared above the listener that calls it — defining it below
   * only worked by accident of effect ordering.
   */
  const handlePlaybackEnded = useCallback(async () => {
    if (target.fileId === null) {
      await exit();
      return;
    }

    // Mark it finished so it leaves Continue Watching rather than sitting
    // there at 99%.
    const total = latest.current.duration;
    if (total) await saveProgress(target.fileId, total, total).catch(() => undefined);

    try {
      const next = await nextEpisode(target.fileId);
      if (next) {
        setUpNext(next);
        setCountdown(NEXT_EPISODE_COUNTDOWN);
      } else {
        await exit();
      }
    } catch {
      await exit();
    }
  }, [target.fileId, exit]);

  // ---- react to mpv events ------------------------------------------------
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listenEvents((event) => {
      if (event.event === 'file-loaded') {
        void (async () => {
          // Apply the resume seek now that the file is genuinely open.
          const seekTo = pendingSeek.current;
          pendingSeek.current = null;
          if (seekTo !== null) {
            try {
              await command('seek', [seekTo, 'absolute']);
              setResumedFrom(seekTo);
            } catch (e) {
              console.warn('resume seek failed', e);
            }
          }
          /*
           * Take the position and duration from mpv **by asking**, rather than
           * waiting to be told.
           *
           * `file-loaded` and the property observer are two different Tauri
           * channels, so their order against each other is not guaranteed:
           * waiting for the next push can mean acting on the outgoing file's
           * position for a tick, and *dropping* the pushes risks missing a
           * `duration` that mpv only ever emits once per file. Reading both
           * here is the only version that is neither a race nor a guess — this
           * file is open, so these two values are its own.
           */
          try {
            const [pos, len] = await Promise.all([
              getProperty('time-pos', 'double') as Promise<number | null>,
              getProperty('duration', 'double') as Promise<number | null>,
            ]);
            setTimePos(pos ?? 0);
            setDuration(len);
            latest.current = { position: pos ?? 0, duration: len };
          } catch (e) {
            console.warn('could not read position after load', e);
          }

          // Ready *before* the rest, not after. Everything below is per-file
          // polish — track languages, frame timing, chapters — and any one of
          // them throwing must not leave the file permanently unable to offer a
          // Skip button. Placing this last is exactly how that happened.
          fileReadyRef.current = true;
          setFileReady(true);

          await applyPrefs();

          // Applied per file rather than once at init, so changing it in
          // Settings takes effect on the next thing you play instead of on the
          // next launch. mpv is definitely up by the time a file has loaded.
          await command('set', ['video-sync', videoSync.current]).catch((e) =>
            console.warn('could not set video-sync', e)
          );

          // Chapters only exist once a file is open, and they are one of the
          // sources a credits marker can come from.
          setChapters(await readChapters());
        })();
      }

      // Still handled for completeness: this fires when keep-open is off, or
      // when a file ends for another reason. 'stop' is us tearing down or the
      // user leaving, which must not roll on to the next episode.
      if (event.event === 'end-file') {
        const reason = (event as { reason?: string }).reason;
        if (reason === 'eof' && fileReadyRef.current && !endHandled.current) {
          endHandled.current = true;
          void handlePlaybackEnded();
        }
        // `error` was dropped along with everything that was not `eof`, and it
        // is the one that matters most: `loadfile` resolves as soon as mpv
        // *accepts* the command, so a file that has been deleted, renamed or
        // sits on a share that went away fails here and nowhere else. The
        // result was a black screen reading `--:-- / --:--`, indistinguishable
        // from a hang, with the explanation sitting in mpv.log.
        if (reason === 'error') {
          const detail = (event as { file_error?: string }).file_error;
          setError(
            detail
              ? `Could not play this file: ${detail}`
              : 'Could not play this file. It may have been moved or deleted, ' +
                'or the drive it is on may be unavailable.'
          );
          // Reveal the controls and leave them up. Nothing is playing, so there
          // is nothing for them to cover, and the Back button is the only way
          // out that does not require knowing which key to press. Set directly
          // rather than through `showOsd` so this effect's dependencies stay as
          // they are — the mpv listener is registered once, and re-registering
          // it is the trap in docs/GOTCHAS.md.
          setOsdVisible(true);
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, [applyPrefs, handlePlaybackEnded]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    observeProperties(OBSERVED_PROPERTIES, ({ name, data }) => {
      switch (name) {
        case 'pause':
          setPaused(data as boolean);
          break;
        // Both are dropped until the new file is genuinely open, because until
        // then they describe the *outgoing* one — mpv keeps reporting the file
        // it still has loaded while `loadfile` is in flight. Nulling the state
        // in the load effect cannot achieve this on its own: these pushes
        // arrive milliseconds later and put the old values straight back.
        // `file-loaded` reads both explicitly, so nothing is lost by ignoring
        // them here.
        case 'time-pos':
          if (fileReadyRef.current && !seekingRef.current) {
            setTimePos(data as number | null);
            latest.current.position = (data as number) ?? 0;
          }
          break;
        case 'duration':
          if (fileReadyRef.current) {
            setDuration(data as number | null);
            latest.current.duration = data as number | null;
          }
          break;
        case 'eof-reached':
          // The real end-of-playback signal while keep-open holds the last
          // frame. Guarded because the property can report true more than once,
          // and against the outgoing file — during a change of episode this is
          // still reporting the previous one, which has genuinely ended.
          if (data === true && fileReadyRef.current && !endHandled.current) {
            endHandled.current = true;
            void handlePlaybackEnded();
          }
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [handlePlaybackEnded]);

  /**
   * End-of-file detection by polling.
   *
   * `eof-reached` is also observed, but observed properties are registered when
   * mpv initialises — which happens once per window. Adding one later has no
   * effect until the app restarts, and that silent dependency already cost a
   * debugging round. Polling works regardless of when this code loads.
   */
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (endHandled.current) return;
      try {
        const eof = await getProperty('eof-reached', 'flag');
        if (eof === true) {
          endHandled.current = true;
          void handlePlaybackEnded();
        }
      } catch {
        /* property unavailable while idle — nothing to do */
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [handlePlaybackEnded]);

  // ---- intro / credits skip ------------------------------------------------

  /**
   * Read the sidecar once per file. Deliberately not polled: it sits on the
   * same share as the video, and markers do not change mid-episode.
   */
  useEffect(() => {
    let cancelled = false;

    // A new file means the previous file's prompts are meaningless. Two
    // episodes commonly share an intro start, so these must be cleared by file
    // rather than left to the segment keys to distinguish.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDismissed(null);
    // Chapters belong to the file that is open. Carrying the previous file's
    // over would place a credits marker at a time that means nothing here.
    setChapters([]);
    autoHandled.current.clear();

    void (async () => {
      try {
        const found = await getSkipMarkers(target.path, target.fileId);
        if (!cancelled) setMarkers(found);
      } catch (e) {
        // Never fatal — no markers simply means no skip button.
        console.warn('skip markers unavailable', e);
      } finally {
        if (!cancelled) setMarkersFor(target.path);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.path, target.fileId]);

  /**
   * What is either side of this episode.
   *
   * Fetched once per file rather than on demand, because it decides whether the
   * previous/next buttons are drawn at all — a button that appears and then
   * turns out to lead nowhere is worse than one that was never offered.
   */
  useEffect(() => {
    const fileId = target.fileId;

    // Cleared first: until the answer for *this* file arrives, the previous
    // file's neighbours are wrong, and a button that jumps somewhere unrelated
    // is worse than one that appears a moment late.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setNeighbours({ prev: null, next: null });
    if (fileId === null) return;

    let cancelled = false;
    void Promise.all([previousEpisode(fileId), nextEpisode(fileId)])
      .then(([prev, next]) => {
        if (!cancelled) setNeighbours({ prev, next });
      })
      .catch((e) => console.warn('neighbouring episodes unavailable', e));

    return () => {
      cancelled = true;
    };
  }, [target.fileId]);

  // Read at playback time rather than held in the shell, so changing the
  // setting takes effect on the next episode without a restart.
  useEffect(() => {
    void getSetting(SKIP_MODE_KEY)
      .then((mode) => setAutoSkip(mode === 'auto'))
      .catch((e) => console.warn('could not read skip mode', e));

    void getSetting(CREDITS_TAIL_KEY)
      .then((raw) => {
        const secs = raw === null ? NaN : Number(raw);
        // An unset or unparsable value keeps the default; 0 is a real value
        // meaning "never guess", so it must not be treated as absent.
        if (Number.isFinite(secs) && secs >= 0) setCreditsTailSecs(secs);
      })
      .catch((e) => console.warn('could not read credits tail', e));

    void getSetting(VIDEO_SYNC_KEY)
      .then((mode) => {
        videoSync.current =
          mode === 'display' ? VIDEO_SYNC_MODES.display : VIDEO_SYNC_MODES.audio;
      })
      .catch((e) => console.warn('could not read video sync mode', e));
  }, []);

  /**
   * The markers actually acted on: whatever `skip.rs` ranked highest, with a
   * credits segment folded in from a chapter or from the tail guess when no
   * source supplied one.
   *
   * The guess is gated on there being a next episode. Without one, "skip the
   * credits" can only mean ending the film early, which is not a skip.
   */
  const resolved = useMemo(
    () =>
      withResolvedCredits(markers, {
        chapters,
        duration,
        tailSecs: creditsTailSecs,
        allowTailGuess: neighbours.next !== null,
      }),
    [markers, chapters, duration, creditsTailSecs, neighbours.next]
  );

  /*
   * One line per file in app.log saying which source won each segment — the
   * first thing worth knowing when a skip fires somewhere surprising.
   *
   * Written only once this file is open *and* its own markers have arrived,
   * and only after the answer has held still for a moment. It used to log on
   * every change, keyed on the path: on an episode change the path moved
   * first, so the outgoing episode's markers were logged under the incoming
   * episode's name, followed by a `tail` line from the instant before the real
   * markers landed. The log then contradicted the database, which is the one
   * thing a diagnostic must never do.
   */
  const introSource = resolved.markers?.intro_source ?? null;
  const creditsSource = resolved.creditsSource;
  useEffect(() => {
    if (!fileReady || markersFor !== target.path) return;
    const id = window.setTimeout(() => {
      console.log(
        `markers for ${target.path}: intro from ${introSource ?? 'none'}, ` +
          `credits from ${creditsSource ?? 'none'}`
      );
    }, MARKER_LOG_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [fileReady, markersFor, target.path, introSource, creditsSource]);

  // Gated on `fileReady`, which is the whole defence against acting on the
  // outgoing file's position. One check here covers everything downstream: the
  // Skip button, automatic mode, and the Up next offer all derive from `active`.
  const active = useMemo(
    () => (fileReady ? activeSkip(resolved.markers, timePos) : null),
    [fileReady, resolved.markers, timePos]
  );
  const activeKey = active?.key ?? null;
  const activeKind = active?.kind ?? null;

  const performSkip = useCallback(async () => {
    if (!active) return;
    setDismissed(active.key);
    if (active.kind === 'intro') {
      await command('seek', [active.seekTo, 'absolute']).catch((e) => setError(String(e)));
      showOsd();
    } else if (!endHandled.current) {
      // Credits: end the episode early rather than seeking. That routes into
      // the same up-next flow as a natural end, so there is one path to the
      // next episode instead of two that can disagree.
      endHandled.current = true;
      await handlePlaybackEnded();
    }
  }, [active, handlePlaybackEnded, showOsd]);

  // Automatic mode. The guard set makes this idempotent, which matters because
  // `active` is a fresh object on every position tick.
  useEffect(() => {
    if (!autoSkip || !active) return;
    // Taking a credits segment *ends the file*. With nothing to move on to that
    // is not a skip, it is quitting a film a minute before the end. The prompt
    // path has always refused this; automatic mode did not, and the two new
    // credits sources make it reachable in a way a measured sidecar never was.
    if (active.kind === 'credits' && !neighbours.next) return;
    if (autoHandled.current.has(active.key)) return;
    autoHandled.current.add(active.key);
    void performSkip();
  }, [autoSkip, active, performSkip, neighbours.next]);

  /**
   * Offer the next episode as soon as the credits start, without ending the
   * file.
   *
   * The card sits over the still-running video and carries **no countdown**:
   * the marker behind it may be a guess, and a guess is not entitled to make
   * the decision. A natural end still starts the countdown, as it always did.
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (autoSkip) return;

    // An offer with no countdown is tied to *being in the credits*. When the
    // credits are no longer where we are — the file changed, the user seeked
    // back, or it was raised in error — the offer is stale and comes down.
    //
    // This effect used to only ever raise the card, which made every spurious
    // raise permanent: it sat over the next episode for its whole duration,
    // hiding the Skip intro button behind it. Being able to lower it again is
    // what makes the whole path self-correcting rather than one-way.
    //
    // A countdown means the file has genuinely ended and the next episode is
    // coming regardless, so that card is not an offer and must not be withdrawn.
    if (countdown !== null) return;

    if (activeKind !== 'credits' || !neighbours.next || dismissed === activeKey) {
      if (upNext) setUpNext(null);
      return;
    }
    if (!upNext) setUpNext(neighbours.next);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [autoSkip, activeKind, activeKey, countdown, dismissed, neighbours.next, upNext]);

  /**
   * Get the prompt out of the way on its own.
   *
   * Keyed on the segment rather than on `active`, which changes identity every
   * second — depending on the object would restart this timer continuously and
   * the prompt would never dismiss.
   */
  useEffect(() => {
    if (!activeKey || autoSkip) return;
    // Only the intro prompt gets out of the way on its own. The credits offer
    // is the route on to the next episode and runs to the end of the file, so
    // timing it out would remove the control at exactly the moment it is for.
    if (activeKind !== 'intro') return;
    const id = window.setTimeout(() => setDismissed(activeKey), SKIP_PROMPT_MS);
    return () => window.clearTimeout(id);
  }, [activeKey, activeKind, autoSkip]);

  const skipPrompt =
    active && !autoSkip && !upNext && dismissed !== active.key
      ? // A credits prompt with nothing to move on to would be a button that
        // does nothing useful.
        active.kind === 'intro' || neighbours.next !== null
        ? active
        : null
      : null;

  /** Jump straight to a neighbouring episode, keeping the show's identity. */
  const playNeighbour = useCallback(
    (episode: EpisodeRef) => {
      onPlayTarget({
        path: episode.path,
        label: labelFor(episode),
        fileId: episode.file_id,
        titleId: target.titleId,
      });
    },
    [onPlayTarget, target.titleId]
  );

  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    if (target.fileId === null) return;
    const fileId = target.fileId;

    const id = window.setInterval(() => {
      if (latest.current.position > 0) {
        void saveProgress(fileId, latest.current.position, latest.current.duration).catch(
          () => undefined
        );
      }
    }, PROGRESS_SAVE_MS);

    return () => {
      window.clearInterval(id);
      // Reading the ref's *latest* value at cleanup is the point here: this is
      // a mutable value holder for the current playback position, not a DOM
      // node. Copying it into the effect would save a stale position.
      const { position, duration: total } = latest.current;
      if (position > 0) {
        void saveProgress(fileId, position, total).catch(() => undefined);
      }
    };
  }, [target.fileId]);

  // Stop playback when leaving, so audio does not continue behind the UI.
  useEffect(() => {
    return () => {
      void command('stop').catch(() => undefined);
    };
  }, []);

  // Countdown to the next episode.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      /* Timer-driven state machine, not state derived from render. */
      /* eslint-disable react-hooks/set-state-in-effect */
      if (upNext) {
        onPlayTarget({
          path: upNext.path,
          label: labelFor(upNext),
          fileId: upNext.file_id,
          titleId: target.titleId,
        });
      }
      setCountdown(null);
      setUpNext(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, upNext, onPlayTarget, target.titleId]);

  /**
   * Poll the pipeline while the stats panel is open, and only then.
   *
   * Polling rather than observing, for the reason in GOTCHAS: observed
   * properties are registered when mpv initialises, which happens once per
   * window — a panel that added its own would show nothing until the whole app
   * restarted, and would look exactly like a panel that was simply wrong.
   */
  useEffect(() => {
    if (!showStats) return;

    let cancelled = false;
    const read = () => {
      void readPlaybackStats()
        .then((groups) => {
          if (!cancelled) setStats(groups);
        })
        .catch((e) => console.warn('stats read failed', e));
    };

    read();
    const id = window.setInterval(read, STATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showStats]);

  // ---- controls -----------------------------------------------------------
  const togglePause = useCallback(async () => {
    try {
      const current = await getProperty('pause', 'flag');
      await setProperty('pause', !current);
      showOsd();
    } catch (e) {
      setError(String(e));
    }
  }, [showOsd]);

  const seekRelative = useCallback(
    async (delta: number) => {
      await command('seek', [delta, 'relative']).catch((e) => setError(String(e)));
      showOsd();
    },
    [showOsd]
  );

  const toggleFullscreen = useCallback(async () => {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  }, []);

  /**
   * The last rung of the Back ladder. Fullscreen is a layer in exactly the way
   * the panels are — something a key press put you into — so Back has to undo
   * it before it is allowed to mean anything else. Leaving the player from
   * fullscreen is then two presses, which is what every other video player on
   * this machine does.
   *
   * The window is asked rather than a `useState` mirror because fullscreen can
   * also change from outside this component — the title bar, Windows itself —
   * and a mirror would quietly disagree the first time it did.
   */
  const backOut = useCallback(async () => {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
      return;
    }
    onExit();
  }, [onExit]);

  /** Changing a track also records the language for this whole title. */
  const chooseTrack = useCallback(
    async (kind: 'sid' | 'aid', track: MpvTrack | null) => {
      try {
        if (kind === 'sid' && track === null) {
          await setSubtitleVisibility(false);
          setSubVisible(false);
        } else if (track) {
          await selectTrack(kind, track.id);
          if (kind === 'sid') {
            await setSubtitleVisibility(true);
            setSubVisible(true);
            setSid(track.id);
          } else {
            setAid(track.id);
          }
        }

        if (target.titleId !== null) {
          const current = await getTitlePrefs(target.titleId);
          await setTitlePrefs(target.titleId, {
            audio_lang: kind === 'aid' ? (track?.lang ?? null) : current.audio_lang,
            sub_lang: kind === 'sid' ? (track?.lang ?? null) : current.sub_lang,
            sub_enabled: kind === 'sid' ? track !== null : current.sub_enabled,
          });
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [target.titleId]
  );

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          void togglePause();
          break;
        case 'f':
          void toggleFullscreen();
          break;
        // Back, one layer at a time: close whichever panel is open, then drop
        // out of OSD focus, then leave fullscreen, then leave the player.
        // Anything else would make the only way out of a panel a mouse click.
        //
        // Backspace is deliberately still the same key as Escape here: it is
        // what a remote's Back button sends, and two Back keys that stop at
        // different layers is the sort of split nobody remembers later.
        case 'Escape':
        case 'Backspace':
          e.preventDefault();
          if (showTracks) {
            setShowTracks(false);
          } else if (showStats) {
            setShowStats(false);
          } else if (osdFocus) {
            leaveOsdFocus();
          } else {
            void backOut();
          }
          break;
        // Up is what hands the arrow keys over. Once the OSD has them, every
        // arrow belongs to the spatial system and this handler must not touch
        // them — `preventDefault` cannot stop the other listener, so acting on
        // one here would seek *and* move the focus ring on the same press.
        case 'ArrowUp':
          if (!osdFocus) {
            e.preventDefault();
            enterOsdFocus();
          }
          break;
        case 'ArrowDown':
          if (!osdFocus) showOsd();
          break;
        case 'ArrowLeft':
          if (osdFocus) break;
          e.preventDefault();
          void seekRelative(-10);
          break;
        case 'ArrowRight':
          if (osdFocus) break;
          e.preventDefault();
          void seekRelative(10);
          break;
        // Episode stepping. `n`/`p` for a keyboard; the media-key names are
        // what the transport buttons on a TV remote actually send, and a remote
        // has no letters to press instead.
        case 'n':
        case 'MediaTrackNext':
          if (neighbours.next) {
            e.preventDefault();
            playNeighbour(neighbours.next);
          }
          break;
        case 'p':
        case 'MediaTrackPrevious':
          if (neighbours.prev) {
            e.preventDefault();
            playNeighbour(neighbours.prev);
          }
          break;
        // mpv's own key for its stats overlay, so the reflex transfers.
        case 'i':
          e.preventDefault();
          setShowStats((v) => !v);
          break;
        // OK on a remote. While the OSD holds focus this belongs entirely to
        // the spatial system, which activates whichever control the ring is on
        // — including the Skip and Up next buttons, which are focusable too.
        // Acting here as well would fire both handlers on one press.
        //
        // In seek mode it takes whichever prompt is showing, and otherwise just
        // reveals the OSD: rebinding it to play/pause would change a behaviour
        // nobody asked to change.
        case 'Enter':
          if (osdFocus) break;
          if (skipPrompt) {
            e.preventDefault();
            void performSkip();
          } else if (upNext) {
            e.preventDefault();
            setCountdown(0);
          } else {
            showOsd();
          }
          break;
        default:
          showOsd();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    togglePause,
    toggleFullscreen,
    backOut,
    seekRelative,
    showOsd,
    skipPrompt,
    performSkip,
    upNext,
    neighbours,
    playNeighbour,
    osdFocus,
    enterOsdFocus,
    leaveOsdFocus,
    showTracks,
    showStats,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showOsd();
    return () => window.clearTimeout(hideTimer.current);
  }, [showOsd]);

  /**
   * Follow the track panel with the focus ring.
   *
   * Opening a panel and leaving focus on the button that opened it means the
   * first thing a remote has to do is work out which direction the new panel is
   * in. Closing it and leaving focus on a control that no longer exists is
   * worse: the ring vanishes and no arrow does anything. Only applies once the
   * OSD holds focus — with a mouse, nothing should move on its own.
   */
  useEffect(() => {
    if (!osdFocus) return;
    void setFocus(showTracks ? TRACK_PANEL_KEY : PLAYER_TRACKS_KEY);
  }, [showTracks, osdFocus]);

  /**
   * Catch the ring when a control disappears from under it.
   *
   * Several of these controls come and go on their own: the Skip prompt times
   * out after ten seconds, Up next is dismissed, the previous/next buttons are
   * absent at the ends of a run and are cleared on every file change. Focus left
   * on any of them points at a component that no longer exists — no ring
   * anywhere and no arrow press doing anything, which is indistinguishable from
   * a hang (docs/GOTCHAS.md).
   *
   * Keyed on whether each thing is present rather than on the values, because
   * `skipPrompt` is rebuilt on every position tick and would fire this once a
   * second. The liveness test is the same one the browsing views use.
   */
  const hasSkipPrompt = skipPrompt !== null;
  const hasUpNext = upNext !== null;
  useEffect(() => {
    if (!osdFocus) return;
    if (doesFocusableExist(getCurrentFocusKey())) return;
    void setFocus(PLAYER_SHELL_KEY);
  }, [
    osdFocus,
    hasSkipPrompt,
    hasUpNext,
    showStats,
    showTracks,
    neighbours.prev,
    neighbours.next,
  ]);

  const progress = duration && timePos !== null ? (timePos / duration) * 100 : 0;
  const subTracks = tracks.filter((t) => t.type === 'sub');
  const audioTracks = tracks.filter((t) => t.type === 'audio');

  return (
    <FocusContext.Provider value={shellFocusKey}>
    <div
      ref={shellRef}
      className={`player ${osdFocus ? 'osd-focused' : ''} ${
        osdVisible || showTracks || osdFocus ? '' : 'osd-hidden'
      }`}
      onMouseMove={showOsd}
      onClick={(e) => {
        if (
          (e.target as HTMLElement).closest(
            'button, input, .track-panel, .up-next, .stats-panel'
          )
        )
          return;
        void togglePause();
      }}
      onDoubleClick={(e) => {
        if (
          (e.target as HTMLElement).closest(
            'button, input, .track-panel, .up-next, .stats-panel'
          )
        )
          return;
        void toggleFullscreen();
      }}
    >
      {error && <div className="player-error">{error}</div>}

      {resumedFrom !== null && (
        <div className="resume-toast" onAnimationEnd={() => setResumedFrom(null)}>
          Resumed from {formatTime(resumedFrom)}
        </div>
      )}

      <div className="player-top">
        <FocusButton className="back-button" onSelect={() => void exit()}>
          ← Back
        </FocusButton>
        <span className="player-label">{target.label}</span>
      </div>

      {/* Two states, one card. With a countdown the file has genuinely ended
          and the next episode is coming either way; without one the credits
          have merely started and the video is still running underneath, so the
          card offers rather than announces. */}
      {upNext && (
        <div className="up-next">
          <div className="up-next-body">
            <div className="up-next-label">Up next</div>
            <div className="up-next-title">
              S{String(upNext.season).padStart(2, '0')}E{String(upNext.episode).padStart(2, '0')}
              {upNext.name ? ` · ${upNext.name}` : ''}
            </div>
            <div className="up-next-actions">
              <FocusButton className="btn-primary" onSelect={() => setCountdown(0)}>
                {countdown !== null ? `▶ Play now (${countdown})` : '▶ Play next'}
              </FocusButton>
              {countdown !== null ? (
                <FocusButton
                  className="btn-secondary"
                  onSelect={() => {
                    setCountdown(null);
                    setUpNext(null);
                    void exit();
                  }}
                >
                  Back to library
                </FocusButton>
              ) : (
                <FocusButton
                  className="btn-secondary"
                  onSelect={() => {
                    // Refuse the offer for the rest of this file. Dismissing by
                    // segment rather than by a flag also silences the small
                    // credits prompt, which would otherwise take its place.
                    setUpNext(null);
                    if (activeKey) setDismissed(activeKey);
                  }}
                >
                  Keep watching
                </FocusButton>
              )}
            </div>
          </div>
        </div>
      )}

      {skipPrompt && (
        <FocusButton className="skip-button" onSelect={() => void performSkip()}>
          {skipPrompt.kind === 'intro' ? 'Skip intro' : 'Next episode ›'}
        </FocusButton>
      )}

      {/* Deliberately outside the OSD: the panel is for watching numbers move
          while the video plays, so hiding it with the idle timer would defeat
          the one thing it is for. */}
      {showStats && (
        <aside className="stats-panel">
          <div className="stats-head">
            <span>Stats for nerds</span>
            <FocusButton onSelect={() => setShowStats(false)}>close</FocusButton>
          </div>
          {stats.length === 0 && <div className="stats-empty">reading…</div>}
          {stats.map((group) => (
            <section
              key={group.heading}
              className={`stats-group ${group.wideLabels ? 'wide-labels' : ''}`}
            >
              <h3>{group.heading}</h3>
              {group.rows.map((row) => (
                <div key={row.label} className={`stats-row ${row.warn ? 'warn' : ''}`}>
                  <span className="stats-label">{row.label}</span>
                  <span className="stats-value">
                    {row.value}
                    {row.note && <em className="stats-note">{row.note}</em>}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </aside>
      )}

      {showTracks && (
        <TrackPanel
          audioTracks={audioTracks}
          subTracks={subTracks}
          aid={aid}
          sid={sid}
          subVisible={subVisible}
          onChoose={(kind, track) => void chooseTrack(kind, track)}
          onClose={() => setShowTracks(false)}
        />
      )}

      <div className="player-controls">
        <div className="player-seek-row">
          <span className="player-time">{formatTime(timePos)}</span>
          <input
            className="player-seek"
            type="range"
            min={0}
            max={100}
            step={0.05}
            value={progress}
            onMouseDown={() => (seekingRef.current = true)}
            onChange={(e) => {
              const pct = Number(e.target.value);
              if (duration) setTimePos((pct / 100) * duration);
            }}
            onMouseUp={(e) => {
              seekingRef.current = false;
              const pct = Number((e.target as HTMLInputElement).value);
              if (duration) void command('seek', [(pct / 100) * duration, 'absolute']);
            }}
          />
          <span className="player-time">{formatTime(duration)}</span>
        </div>

        <div className="player-buttons">
          {/* Rendered only for episodes that genuinely have a neighbour, so
              these never appear on a film or at the ends of a run. */}
          {neighbours.prev && (
            <FocusButton
              className="episode-step"
              title={`Previous: ${labelFor(neighbours.prev)}`}
              onSelect={() => playNeighbour(neighbours.prev as EpisodeRef)}
            >
              ⏮ Prev
            </FocusButton>
          )}
          <FocusButton onSelect={() => void seekRelative(-10)}>−10s</FocusButton>
          <FocusButton
            focusKey={PLAYER_PLAY_KEY}
            className="btn-primary"
            onSelect={() => void togglePause()}
          >
            {paused ? '▶ Play' : '❚❚ Pause'}
          </FocusButton>
          <FocusButton onSelect={() => void seekRelative(10)}>+10s</FocusButton>
          {neighbours.next && (
            <FocusButton
              className="episode-step"
              title={`Next: ${labelFor(neighbours.next)}`}
              onSelect={() => playNeighbour(neighbours.next as EpisodeRef)}
            >
              Next ⏭
            </FocusButton>
          )}
          <FocusButton
            focusKey={PLAYER_TRACKS_KEY}
            className={showTracks ? 'active' : ''}
            onSelect={() => {
              setShowTracks((v) => !v);
              void readTracks().then(setTracks);
            }}
          >
            Audio &amp; subtitles
          </FocusButton>
          <FocusButton
            className={showStats ? 'active' : ''}
            title="Playback diagnostics (i)"
            onSelect={() => setShowStats((v) => !v)}
          >
            Stats
          </FocusButton>
          <FocusButton onSelect={() => void toggleFullscreen()}>Fullscreen</FocusButton>
          {/* Here as well as in the nav, because this is where the controls are
              least obvious: the OSD hides itself while you watch, so a remote
              user who does not already know that Up brings it back has nothing
              on screen to tell them. */}
          <FocusButton
            title="Keyboard and remote controls (?)"
            onSelect={() => setShortcutsOpen(true)}
          >
            ?
          </FocusButton>
        </div>
      </div>
    </div>
    </FocusContext.Provider>
  );
}

/**
 * Audio and subtitle selection.
 *
 * A component of its own because `useFocusable` reads the focus context of the
 * component it is *called in*: declaring this container up in `Player` would
 * read `Player`'s own context — the root — and make the panel a **sibling** of
 * the player shell rather than a child of it. The markup would look nested and
 * the focus tree would be flat, which is the trap in docs/GOTCHAS.md that cost a
 * debugging round in the browsing UI.
 *
 * This is the panel that most justifies the whole focus mode: on a library with
 * mixed audio and subtitle languages it is the control reached most often, and
 * until now a remote could not reach it at all.
 */
function TrackPanel({
  audioTracks,
  subTracks,
  aid,
  sid,
  subVisible,
  onChoose,
  onClose,
}: {
  audioTracks: MpvTrack[];
  subTracks: MpvTrack[];
  aid: number | null;
  sid: number | null;
  subVisible: boolean;
  onChoose: (kind: 'sid' | 'aid', track: MpvTrack | null) => void;
  onClose: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: TRACK_PANEL_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <aside className="track-panel" ref={ref}>
        <div className="track-panel-head">
          <span>Audio</span>
          <FocusButton onSelect={onClose}>close</FocusButton>
        </div>
        {audioTracks.length === 0 && <div className="track-empty">no audio tracks</div>}
        {audioTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${aid === track.id ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onChoose('aid', track)}
          >
            {describeTrack(track)}
          </FocusButton>
        ))}

        <div className="track-panel-head">
          <span>Subtitles</span>
        </div>
        <FocusButton
          className={`track-option ${!subVisible ? 'active' : ''}`}
          keepInView="nearest"
          onSelect={() => onChoose('sid', null)}
        >
          Off
        </FocusButton>
        {subTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${subVisible && sid === track.id ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onChoose('sid', track)}
          >
            {describeTrack(track)}
          </FocusButton>
        ))}
        <p className="track-note">Remembered for this show.</p>
      </aside>
    </FocusContext.Provider>
  );
}
