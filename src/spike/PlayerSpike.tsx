/**
 * Phase 0 embedding spike — the go/no-go gate for the whole project.
 *
 * What this has to prove, all at once:
 *  - mpv renders into a child surface *beneath* the transparent WebView2
 *  - React elements composite cleanly on top of live video
 *  - resize / move / fullscreen keep the video surface aligned
 *  - a 4K HDR remux plays with hwdec=d3d11va and reports HDR output
 *  - seeking works, PGS + ASS subtitles render
 *  - the animated element below stays smooth over playback (no stutter)
 *
 * If this fails, the fallback is a separate borderless mpv window driven by a
 * Lua OSC, with React used for browsing only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  init,
  command,
  setProperty,
  getProperty,
  observeProperties,
  listenEvents,
  setVideoMarginRatio,
  type MpvConfig,
  type MpvObservableProperty,
} from 'tauri-plugin-libmpv-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  BASE_MPV_OPTIONS,
  TONE_MAPPING_OPTIONS,
  POTATO_MODE_OPTIONS,
  CREATOR_INTENT_OPTIONS,
} from '../player/mpvOptions';

// NOTE: kept deliberately minimal while bisecting a native crash.
// sid/aid/sub-visibility are read by polling instead of observation.
const OBSERVED = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['filename', 'string', 'none'],
] as const satisfies MpvObservableProperty[];

/** One entry of mpv's `track-list` property. */
interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub' | string;
  title?: string;
  lang?: string;
  codec?: string;
  selected?: boolean;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
}

/** Read-only mpv properties polled for the diagnostics panel. */
const DIAGNOSTICS: Array<{ key: string; label: string; format: 'string' | 'int64' | 'double' }> = [
  { key: 'mpv-version', label: 'mpv', format: 'string' },
  { key: 'hwdec-current', label: 'hwdec active', format: 'string' },
  { key: 'video-codec', label: 'codec', format: 'string' },
  { key: 'video-params/pixelformat', label: 'pixel format', format: 'string' },
  { key: 'video-params/w', label: 'source width', format: 'int64' },
  { key: 'video-params/h', label: 'source height', format: 'int64' },
  { key: 'video-params/primaries', label: 'primaries', format: 'string' },
  { key: 'video-params/gamma', label: 'transfer', format: 'string' },
  { key: 'video-params/sig-peak', label: 'signal peak', format: 'double' },
  { key: 'current-vo', label: 'video out', format: 'string' },
  { key: 'display-fps', label: 'display fps', format: 'double' },
  { key: 'estimated-vf-fps', label: 'render fps', format: 'double' },
  { key: 'frame-drop-count', label: 'dropped (vo)', format: 'int64' },
  { key: 'decoder-frame-drop-count', label: 'dropped (decoder)', format: 'int64' },
];

/**
 * mpv must be initialised exactly once per window, ever.
 *
 * Calling init() a second time against a live instance corrupts native state
 * and takes the process down with STATUS_ACCESS_VIOLATION. Two things in dev
 * cause repeat calls: React StrictMode double-invokes effects on mount, and
 * every HMR update remounts the component. Module scope is not enough to guard
 * this — Vite replaces the module on HMR, resetting module-level state — so the
 * promise is parked on `window`, which survives both.
 */
function ensureMpvInitialised(config: MpvConfig): Promise<string> {
  const host = window as unknown as { __mpvInit?: Promise<string> };
  if (!host.__mpvInit) {
    host.__mpvInit = init(config);
  }
  return host.__mpvInit;
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

function describeTrack(track: MpvTrack): string {
  const parts = [
    track.lang?.toUpperCase(),
    track.title,
    track.codec,
    track.forced ? 'forced' : null,
    track.external ? 'external' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `Track ${track.id}`;
}

export default function PlayerSpike() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [timePos, setTimePos] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [potatoMode, setPotatoMode] = useState(false);
  const [marginMode, setMarginMode] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);

  const seekingRef = useRef(false);

  /** Any mpv call that fails should say so on screen, not vanish into a
   *  rejected promise. The original spike swallowed these. */
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /**
   * Track list plus current selection, read on demand rather than observed.
   *
   * Deliberately avoids `getProperty('track-list', 'node')`. The node format
   * deserialises a nested array-of-maps across the FFI boundary and reliably
   * crashed the process with STATUS_ACCESS_VIOLATION on file load. mpv exposes
   * every field as an indexed scalar property, which is flat and safe.
   */
  const refreshTracks = useCallback(async () => {
    const safeGet = async <T,>(name: string, format: 'string' | 'int64' | 'flag') => {
      try {
        return (await getProperty(name, format)) as T | null;
      } catch {
        return null;
      }
    };

    const count = (await safeGet<number>('track-list/count', 'int64')) ?? 0;
    const next: MpvTrack[] = [];

    for (let i = 0; i < count; i++) {
      const type = await safeGet<string>(`track-list/${i}/type`, 'string');
      if (!type) continue;
      next.push({
        id: (await safeGet<number>(`track-list/${i}/id`, 'int64')) ?? i,
        type,
        title: (await safeGet<string>(`track-list/${i}/title`, 'string')) ?? undefined,
        lang: (await safeGet<string>(`track-list/${i}/lang`, 'string')) ?? undefined,
        codec: (await safeGet<string>(`track-list/${i}/codec`, 'string')) ?? undefined,
        selected: (await safeGet<boolean>(`track-list/${i}/selected`, 'flag')) ?? false,
        forced: (await safeGet<boolean>(`track-list/${i}/forced`, 'flag')) ?? false,
        external: (await safeGet<boolean>(`track-list/${i}/external`, 'flag')) ?? false,
      });
    }

    setTracks(next);
    setSid(await safeGet<number>('sid', 'int64'));
    setAid(await safeGet<number>('aid', 'int64'));
    setSubVisible((await safeGet<boolean>('sub-visibility', 'flag')) ?? true);
  }, []);

  /**
   * Declared here, above the drag-and-drop effect that uses it. Defining it
   * further down worked only by accident of effects running after render, and
   * hid a real staleness risk behind an eslint-disable.
   */
  const loadFile = useCallback(
    async (path: string) => {
      await run('load', async () => {
        await command('loadfile', [path]);
        await setProperty('pause', false);
      });
      // file-loaded usually beats this, but re-read in case the event was missed
      setTimeout(() => void refreshTracks(), 800);
    },
    [run, refreshTracks]
  );

  /**
   * Potato mode is the only rendering switch. Everything else is decided by
   * mpv per file, so there is nothing else for a user to choose.
   */
  const setPotato = useCallback(async (on: boolean) => {
    const options = on ? POTATO_MODE_OPTIONS : CREATOR_INTENT_OPTIONS;
    const failed: string[] = [];
    for (const [key, value] of Object.entries(options)) {
      try {
        await setProperty(key, value);
      } catch {
        failed.push(key);
      }
    }
    setPotatoMode(on);
    setError(failed.length > 0 ? `could not set ${failed.join(', ')}` : null);
  }, []);

  // ---- init mpv -----------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const mpvConfig: MpvConfig = {
      initialOptions: BASE_MPV_OPTIONS,
      observedProperties: OBSERVED,
    };

    (async () => {
      // A hung init must not leave the badge on "initialising" forever with no
      // explanation — that state tells you nothing.
      const timeout = setTimeout(() => {
        if (!disposed) {
          setError('mpv init did not complete within 8s — see src-tauri/mpv.log');
        }
      }, 8000);

      try {
        await ensureMpvInitialised(mpvConfig);
        clearTimeout(timeout);
        if (disposed) return;
        setReady(true);

        // Applied individually and after startup: if a build rejects one of
        // these option names, we lose that refinement rather than the player.
        for (const [key, value] of Object.entries(TONE_MAPPING_OPTIONS)) {
          try {
            await setProperty(key, value);
          } catch {
            console.warn(`mpv rejected optional setting ${key}=${value}`);
          }
        }
      } catch (e) {
        clearTimeout(timeout);
        setError(`mpv init failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  // ---- observe playback state --------------------------------------------
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    observeProperties(OBSERVED, ({ name, data }) => {
      switch (name) {
        case 'pause':
          setPaused(data as boolean);
          break;
        case 'time-pos':
          if (!seekingRef.current) setTimePos(data as number | null);
          break;
        case 'duration':
          setDuration(data as number | null);
          break;
        case 'filename':
          setFilename(data as string | null);
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // ---- refresh the track list when a file finishes loading ----------------
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenEvents((event) => {
      if (event.event === 'file-loaded') {
        void refreshTracks();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [refreshTracks]);

  // ---- drag & drop a file onto the window --------------------------------
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
          void loadFile(event.payload.paths[0]);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [loadFile]);

  // ---- poll diagnostics ---------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        DIAGNOSTICS.map(async ({ key, label, format }) => {
          try {
            const value = await getProperty(key, format);
            if (value === null || value === undefined) return;
            next[label] =
              typeof value === 'number'
                ? Number(value).toFixed(format === 'int64' ? 0 : 2)
                : String(value);
          } catch {
            /* property not available for this file — skip */
          }
        })
      );
      setDiagnostics(next);
    }, 1000);
    return () => clearInterval(id);
  }, [ready]);

  // ---- actions ------------------------------------------------------------
  /**
   * Reads mpv's live pause state rather than React's copy. Two clicks arrive
   * faster than a re-render, so using local state would make the second click
   * of a double-click re-apply the same value instead of undoing the first.
   * Reading live is what lets double-click-to-fullscreen leave playback alone.
   */
  const togglePause = useCallback(
    () =>
      run('pause', async () => {
        const current = await getProperty('pause', 'flag');
        await setProperty('pause', !current);
      }),
    [run]
  );

  const toggleFullscreen = useCallback(
    () =>
      run('fullscreen', async () => {
        const win = getCurrentWindow();
        await win.setFullscreen(!(await win.isFullscreen()));
      }),
    [run]
  );

  /**
   * Track selection goes through mpv's `set` input command rather than
   * setProperty(). The typed property API returns PROPERTY_ERROR for sid/aid —
   * they are choice-style options ("auto" / "no" / an integer), and the plugin's
   * typed setter cannot express that. `set` takes a plain string and works.
   */
  const selectTrack = useCallback(
    (kind: 'sid' | 'aid', id: number | 'no') =>
      run(`select ${kind}`, async () => {
        await command('set', [kind, String(id)]);
        await refreshTracks();
      }),
    [run, refreshTracks]
  );

  // ---- keyboard ------------------------------------------------------------
  // mpv's own input is disabled (input-default-bindings/input-vo-keyboard), so
  // every binding is ours. The webview has focus, not the video surface.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
          // Also stops Space from re-triggering whichever button has focus.
          e.preventDefault();
          void togglePause();
          break;
        case 'f':
          void toggleFullscreen();
          break;
        case 'Escape':
          void run('fullscreen', async () => {
            const win = getCurrentWindow();
            if (await win.isFullscreen()) await win.setFullscreen(false);
          });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void run('seek', () => command('seek', [-5, 'relative']));
          break;
        case 'ArrowRight':
          e.preventDefault();
          void run('seek', () => command('seek', [5, 'relative']));
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePause, toggleFullscreen, run]);

  const isControl = (e: React.MouseEvent) =>
    Boolean((e.target as HTMLElement).closest('button, input, aside, header, footer'));

  /** Click anywhere that isn't a control toggles playback, as in any player. */
  const onSurfaceClick = useCallback(
    (e: React.MouseEvent) => {
      if (isControl(e)) return;
      void togglePause();
    },
    [togglePause]
  );

  /**
   * Double-click toggles fullscreen. The browser still delivers the two
   * underlying clicks, so playback is toggled twice and lands back where it
   * started — which is the behaviour you want, and why togglePause must read
   * mpv's live state.
   */
  const onSurfaceDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isControl(e)) return;
      void toggleFullscreen();
    },
    [toggleFullscreen]
  );

  const subTracks = tracks.filter((t) => t.type === 'sub');
  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const progress = duration && timePos !== null ? (timePos / duration) * 100 : 0;

  // ---- render -------------------------------------------------------------
  return (
    <div className="spike-root" onClick={onSurfaceClick} onDoubleClick={onSurfaceDoubleClick}>
      {/* Everything here renders ON TOP of the mpv surface. If video is
          visible behind these panels, compositing works. */}

      <header className="spike-header">
        <div className="spike-title">
          Phase 0 — mpv embedding spike
          <span className={`badge ${ready ? 'ok' : error ? 'fail' : 'wait'}`}>
            {ready ? 'mpv ready' : error ? 'failed' : 'initialising'}
          </span>
        </div>
        {/* Continuous CSS animation: if this stutters during playback,
            compositing is fighting the video surface. */}
        <div className="stutter-probe" aria-label="animation smoothness probe">
          <div className="stutter-probe-dot" />
        </div>
      </header>

      {error && (
        <div className="spike-error" onClick={() => setError(null)} title="click to dismiss">
          {error}
        </div>
      )}

      {!filename && (
        <div className="spike-dropzone">
          <p>Drag a video file onto this window, or paste a full path below.</p>
          <div className="spike-path-row">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="D:\Media\Movies\Some Movie (2019)\movie.mkv"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pathInput.trim()) void loadFile(pathInput.trim());
              }}
            />
            <button onClick={() => pathInput.trim() && void loadFile(pathInput.trim())}>Load</button>
          </div>
        </div>
      )}

      {showDiagnostics && (
        <aside className="spike-diagnostics">
          <div className="spike-diagnostics-head">
            <span>Diagnostics</span>
            <button onClick={() => setShowDiagnostics(false)}>hide</button>
          </div>
          <dl>
            {DIAGNOSTICS.map(({ label }) => (
              <div key={label} className="diag-row">
                <dt>{label}</dt>
                <dd>{diagnostics[label] ?? '—'}</dd>
              </div>
            ))}
          </dl>

          {/* Explicit track selection. A blind "cycle" button gives no feedback
              with osd-level=0, which is why subtitles looked broken. */}
          <div className="track-section">
            <div className="track-head">
              Subtitles
              <button
                className={subVisible ? 'active' : ''}
                onClick={() =>
                  void run('sub visibility', async () => {
                    await command('set', ['sub-visibility', subVisible ? 'no' : 'yes']);
                    setSubVisible(!subVisible);
                  })
                }
              >
                {subVisible ? 'shown' : 'hidden'}
              </button>
            </div>
            {subTracks.length === 0 && <div className="track-empty">no subtitle tracks</div>}
            {subTracks.length > 0 && (
              <>
                <button
                  className={`track ${sid === null ? 'active' : ''}`}
                  onClick={() => void selectTrack('sid', 'no')}
                >
                  Off
                </button>
                {subTracks.map((t) => (
                  <button
                    key={t.id}
                    className={`track ${sid === t.id ? 'active' : ''}`}
                    onClick={() => void selectTrack('sid', t.id)}
                    title={describeTrack(t)}
                  >
                    {describeTrack(t)}
                  </button>
                ))}
              </>
            )}

            <div className="track-head">Audio</div>
            {audioTracks.length === 0 && <div className="track-empty">no audio tracks</div>}
            {audioTracks.map((t) => (
              <button
                key={t.id}
                className={`track ${aid === t.id ? 'active' : ''}`}
                onClick={() => void selectTrack('aid', t.id)}
                title={describeTrack(t)}
              >
                {describeTrack(t)}
              </button>
            ))}
          </div>
        </aside>
      )}

      <footer className="spike-controls">
        <div className="seek-row">
          <span className="time">{formatTime(timePos)}</span>
          <input
            className="seek"
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={progress}
            onMouseDown={() => (seekingRef.current = true)}
            onChange={(e) => {
              const pct = Number(e.target.value);
              if (duration) setTimePos((pct / 100) * duration);
            }}
            onMouseUp={(e) => {
              seekingRef.current = false;
              const pct = Number((e.target as HTMLInputElement).value);
              if (duration) void run('seek', () => command('seek', [(pct / 100) * duration, 'absolute']));
            }}
          />
          <span className="time">{formatTime(duration)}</span>
        </div>

        <div className="button-row">
          <button onClick={() => void run('seek', () => command('seek', [-10, 'relative']))}>
            -10s
          </button>
          <button className="primary" onClick={() => void togglePause()}>
            {paused ? 'Play' : 'Pause'}
          </button>
          <button onClick={() => void run('seek', () => command('seek', [10, 'relative']))}>
            +10s
          </button>

          <span className="divider" />

          <button
            className={potatoMode ? 'active' : ''}
            title="Emergency fallback for hardware that cannot keep up. Not a quality preference."
            onClick={() => void setPotato(!potatoMode)}
          >
            Potato mode
          </button>

          <span className="divider" />

          <button
            className={marginMode ? 'active' : ''}
            onClick={() =>
              void run('margin', async () => {
                const next = !marginMode;
                await setVideoMarginRatio(
                  next ? { bottom: 0.16 } : { left: 0, right: 0, top: 0, bottom: 0 }
                );
                setMarginMode(next);
              })
            }
          >
            Margin mode
          </button>
          <button onClick={() => void toggleFullscreen()}>Fullscreen</button>
          {!showDiagnostics && <button onClick={() => setShowDiagnostics(true)}>Diagnostics</button>}
        </div>

        {filename && <div className="now-playing">{filename}</div>}
      </footer>
    </div>
  );
}
