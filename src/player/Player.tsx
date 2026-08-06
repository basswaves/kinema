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
  command,
  getProperty,
  listenEvents,
  observeProperties,
  setProperty,
} from 'tauri-plugin-libmpv-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  getProgress,
  getSkipMarkers,
  getTitlePrefs,
  nextEpisode,
  saveProgress,
  setTitlePrefs,
  type NextEpisode,
  type SkipMarkers,
} from './api';
import { activeSkip } from './skip';
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
/** Setting key: 'auto' skips without asking, anything else shows the button. */
const SKIP_MODE_KEY = 'skip_mode';

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
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);
  const [upNext, setUpNext] = useState<NextEpisode | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [markers, setMarkers] = useState<SkipMarkers | null>(null);
  const [autoSkip, setAutoSkip] = useState(false);
  const [hasNext, setHasNext] = useState(false);
  /** Prompt occurrences the user (or the timer) has already dismissed. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  const seekingRef = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  // Live values for the unmount save, which cannot read React state.
  const latest = useRef({ position: 0, duration: null as number | null });
  /** Resume position to apply once the file is actually open. */
  const pendingSeek = useRef<number | null>(null);
  /** Guards against handling the end of the same file twice. */
  const endHandled = useRef(false);
  /** Segments already acted on automatically, so each is skipped once only. */
  const autoHandled = useRef(new Set<string>());

  const showOsd = useCallback(() => {
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setOsdVisible(false), OSD_HIDE_MS);
  }, []);

  // ---- load, resume, and apply remembered tracks --------------------------
  useEffect(() => {
    let cancelled = false;

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
   * End of file. Declared above the listener that calls it — defining it below
   * only worked by accident of effect ordering.
   */
  const handlePlaybackEnded = useCallback(async () => {
    if (target.fileId === null) {
      onExit();
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
        onExit();
      }
    } catch {
      onExit();
    }
  }, [target.fileId, onExit]);

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
          await applyPrefs();
        })();
      }

      // Still handled for completeness: this fires when keep-open is off, or
      // when a file ends for another reason. 'stop' is us tearing down or the
      // user leaving, which must not roll on to the next episode.
      if (event.event === 'end-file') {
        const reason = (event as { reason?: string }).reason;
        if (reason === 'eof' && !endHandled.current) {
          endHandled.current = true;
          void handlePlaybackEnded();
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
        case 'time-pos':
          if (!seekingRef.current) {
            setTimePos(data as number | null);
            latest.current.position = (data as number) ?? 0;
          }
          break;
        case 'duration':
          setDuration(data as number | null);
          latest.current.duration = data as number | null;
          break;
        case 'eof-reached':
          // The real end-of-playback signal while keep-open holds the last
          // frame. Guarded because the property can report true more than once.
          if (data === true && !endHandled.current) {
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
    autoHandled.current.clear();

    void (async () => {
      try {
        const found = await getSkipMarkers(target.path, target.fileId);
        if (cancelled) return;
        setMarkers(found);

        // Only worth knowing when there is a credits marker: it decides whether
        // the credits prompt can offer anything.
        if (found?.credits && target.fileId !== null) {
          const next = await nextEpisode(target.fileId);
          if (!cancelled) setHasNext(next !== null);
        } else if (!cancelled) {
          setHasNext(false);
        }
      } catch (e) {
        // Never fatal — no markers simply means no skip button.
        console.warn('skip markers unavailable', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.path, target.fileId]);

  // Read at playback time rather than held in the shell, so changing the
  // setting takes effect on the next episode without a restart.
  useEffect(() => {
    void getSetting(SKIP_MODE_KEY)
      .then((mode) => setAutoSkip(mode === 'auto'))
      .catch((e) => console.warn('could not read skip mode', e));
  }, []);

  const active = useMemo(() => activeSkip(markers, timePos), [markers, timePos]);
  const activeKey = active?.key ?? null;

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
    if (autoHandled.current.has(active.key)) return;
    autoHandled.current.add(active.key);
    void performSkip();
  }, [autoSkip, active, performSkip]);

  /**
   * Get the prompt out of the way on its own.
   *
   * Keyed on the segment rather than on `active`, which changes identity every
   * second — depending on the object would restart this timer continuously and
   * the prompt would never dismiss.
   */
  useEffect(() => {
    if (!activeKey || autoSkip) return;
    const id = window.setTimeout(() => setDismissed(activeKey), SKIP_PROMPT_MS);
    return () => window.clearTimeout(id);
  }, [activeKey, autoSkip]);

  const skipPrompt =
    active && !autoSkip && !upNext && dismissed !== active.key
      ? // A credits prompt with nothing to move on to would be a button that
        // does nothing useful.
        active.kind === 'intro' || hasNext
        ? active
        : null
      : null;

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
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
          label: `${upNext.title} — S${String(upNext.season).padStart(2, '0')}E${String(
            upNext.episode
          ).padStart(2, '0')}`,
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

  const exit = useCallback(async () => {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) await win.setFullscreen(false);
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
        case 'Escape':
        case 'Backspace':
          e.preventDefault();
          void exit();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void seekRelative(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          void seekRelative(10);
          break;
        default:
          showOsd();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePause, toggleFullscreen, exit, seekRelative, showOsd]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showOsd();
    return () => window.clearTimeout(hideTimer.current);
  }, [showOsd]);

  const progress = duration && timePos !== null ? (timePos / duration) * 100 : 0;
  const subTracks = tracks.filter((t) => t.type === 'sub');
  const audioTracks = tracks.filter((t) => t.type === 'audio');

  return (
    <div
      className={`player ${osdVisible || showTracks ? '' : 'osd-hidden'}`}
      onMouseMove={showOsd}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, .track-panel, .up-next')) return;
        void togglePause();
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, .track-panel, .up-next')) return;
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
        <button className="back-button" onClick={() => void exit()}>
          ← Back
        </button>
        <span className="player-label">{target.label}</span>
      </div>

      {upNext && (
        <div className="up-next">
          <div className="up-next-body">
            <div className="up-next-label">Up next</div>
            <div className="up-next-title">
              S{String(upNext.season).padStart(2, '0')}E{String(upNext.episode).padStart(2, '0')}
              {upNext.name ? ` · ${upNext.name}` : ''}
            </div>
            <div className="up-next-actions">
              <button className="btn-primary" onClick={() => setCountdown(0)}>
                ▶ Play now {countdown !== null ? `(${countdown})` : ''}
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  setCountdown(null);
                  setUpNext(null);
                  void exit();
                }}
              >
                Back to library
              </button>
            </div>
          </div>
        </div>
      )}

      {skipPrompt && (
        <button className="skip-button" onClick={() => void performSkip()}>
          {skipPrompt.kind === 'intro' ? 'Skip intro' : 'Next episode ›'}
        </button>
      )}

      {showTracks && (
        <aside className="track-panel">
          <div className="track-panel-head">
            <span>Audio</span>
            <button onClick={() => setShowTracks(false)}>close</button>
          </div>
          {audioTracks.length === 0 && <div className="track-empty">no audio tracks</div>}
          {audioTracks.map((track) => (
            <button
              key={track.id}
              className={`track-option ${aid === track.id ? 'active' : ''}`}
              onClick={() => void chooseTrack('aid', track)}
            >
              {describeTrack(track)}
            </button>
          ))}

          <div className="track-panel-head">
            <span>Subtitles</span>
          </div>
          <button
            className={`track-option ${!subVisible ? 'active' : ''}`}
            onClick={() => void chooseTrack('sid', null)}
          >
            Off
          </button>
          {subTracks.map((track) => (
            <button
              key={track.id}
              className={`track-option ${subVisible && sid === track.id ? 'active' : ''}`}
              onClick={() => void chooseTrack('sid', track)}
            >
              {describeTrack(track)}
            </button>
          ))}
          <p className="track-note">Remembered for this show.</p>
        </aside>
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
          <button onClick={() => void seekRelative(-10)}>−10s</button>
          <button className="btn-primary" onClick={() => void togglePause()}>
            {paused ? '▶ Play' : '❚❚ Pause'}
          </button>
          <button onClick={() => void seekRelative(10)}>+10s</button>
          <button
            className={showTracks ? 'active' : ''}
            onClick={() => {
              setShowTracks((v) => !v);
              void readTracks().then(setTracks);
            }}
          >
            Audio &amp; subtitles
          </button>
          <button onClick={() => void toggleFullscreen()}>Fullscreen</button>
        </div>
      </div>
    </div>
  );
}
