/**
 * mpv configuration — one correct rendering path, chosen for creator's intent.
 *
 * Design principles, in priority order:
 *
 *  1. Do nothing unless necessary. `scaler-resizes-only` means no scaler runs
 *     at all when the video is displayed 1:1. Untouched pixels are the most
 *     faithful pixels.
 *  2. No machine learning, ever. No FSRCNNX, RAVU, Anime4K, RTX VSR or Intel
 *     VSR. Those invent detail that was never in the master. Only classical
 *     resampling is used.
 *  3. Vendor neutral. The d3d11 path works identically on NVIDIA, AMD and
 *     Intel. Nothing here is conditional on a GPU brand.
 *  4. Cheap enough for a GTX 1060 / RX 480 at 4K. spline36 is separable and
 *     far lighter than the EWA/jinc family, while staying neutral.
 *
 * There is deliberately no quality selector. The correct settings do not
 * depend on user taste — they depend on whether the video needs resizing and
 * whether the display can show the source's dynamic range. mpv already knows
 * both, so it decides per file, at runtime.
 */

/** How much of mpv's log is written: all of it, verbose — `mpv.log` is the authority on rendering (docs/GOTCHAS.md). */
export const MSG_LEVEL = 'all=v';

/**
 * The read-ahead policy, sized from the computer's memory (capabilities.rs
 * `memory_bytes`; 0 when unknown).
 *
 * mpv's own default (`cache=auto`) keeps a cache for network streams and not
 * for local files, and it tells them apart by how the file is opened, not by
 * where it lives: a USB drive, a mounted SMB or NFS share or a UNC path is, to
 * mpv, an ordinary file. Whether such a file got one was never checked, so the
 * cache is asked for on every file, and a slow disk or a network stall is
 * absorbed before it reaches the screen.
 *
 *  - `demuxer-max-bytes`: how far ahead it reads, a sixteenth of the memory
 *    between 256 MiB and 1 GiB. A high-bitrate remux is several megabytes a
 *    second, so this is tens of seconds of film to ride out a stall.
 *  - `demuxer-max-back-bytes`: how much already-played film is kept, so a
 *    short skip back is served from memory instead of the disk or the network.
 *    Half the read-ahead, never under 256 MiB.
 *  - `stream-buffer-size`: the size of each read from the file. Larger reads
 *    mean fewer round trips on a network path and cost nothing on a disk.
 *
 * `cache-pause` is left at mpv's default: it stops to refill when the cache
 * runs dry rather than stuttering through it.
 *
 * All four are read as a file opens, so they belong in the init set — set
 * before any file exists — and they have been in mpv for years, so an
 * unknown name is not a risk worth a second code path. Sizes are plain byte
 * counts in strings, which every mpv version parses the same way.
 */
export function cacheOptions(memoryBytes: number): Record<string, string> {
  const MiB = 1024 * 1024;
  const known = Number.isFinite(memoryBytes) && memoryBytes > 0;
  const ahead = known
    ? Math.min(1024 * MiB, Math.max(256 * MiB, Math.floor(memoryBytes / 16)))
    : 256 * MiB;
  const back = Math.max(256 * MiB, Math.floor(ahead / 2));
  return {
    cache: 'yes',
    'demuxer-max-bytes': String(ahead),
    'demuxer-max-back-bytes': String(back),
    'stream-buffer-size': String(4 * MiB),
  };
}

/**
 * Where mpv keeps the shaders it has compiled, so a film does not wait for
 * the graphics driver to build the same shaders again: on Linux mpv's window
 * (and with it the renderer) is made afresh for each film, and on Windows the
 * first film after a launch pays for them. `gpu-shader-cache` is on by
 * default; it is named so this does not depend on a default.
 *
 * Init options, since the renderer reads them as it starts — after it, they
 * would apply from the next launch. Both have been in mpv since well before
 * 0.40, the oldest the README supports. Nothing here depends on a GPU brand:
 * the cache holds whatever the driver produced.
 */
export function shaderCacheOptions(dir: string | undefined): Record<string, string> {
  return dir ? { 'gpu-shader-cache': 'yes', 'gpu-shader-cache-dir': dir } : {};
}

/** Options applied once at mpv init and never changed at runtime. */
export const BASE_MPV_OPTIONS: Record<string, string | boolean | number> = {
  // ---- Diagnostics FIRST ------------------------------------------------
  // Options are applied in order. If a later option is rejected, mpv init
  // fails — and if logging were configured after it, there would be no log
  // explaining why. Keep these at the top so failures are always recorded.
  // Replaced with an absolute path in app data by `engine.ts` before init; this
  // relative fallback is used only if that path cannot be resolved.
  'log-file': 'mpv.log',
  'msg-level': MSG_LEVEL,

  // ---- Rendering path ---------------------------------------------------
  // gpu-next is the modern renderer (libplacebo). `gpu-api` and `hwdec` name
  // the system's own graphics interface, so they come from Rust with the
  // capabilities (capabilities.rs) and are added by `engine.ts`: on Windows
  // d3d11 + d3d11va, the vendor-neutral path NVIDIA, AMD and Intel all use.
  vo: 'gpu-next',

  // ---- Scaling: classical resampling only -------------------------------
  // spline36 upscales neutrally — no sharpening halo, low ringing, and much
  // cheaper than the EWA/jinc scalers. ewa_lanczossharp is sharper but that
  // sharpness is added contrast the colourist did not put there.
  scale: 'spline36',
  cscale: 'spline36',
  // mitchell is the standard low-ringing choice for downscaling.
  dscale: 'mitchell',

  // Correctness flags. These do not add anything to the image; they stop the
  // scaler from being wrong. Resampling in linear light and sigmoidised light
  // is what the maths actually calls for.
  'correct-downscaling': true,
  'linear-downscaling': true,
  'sigmoid-upscaling': true,

  // The whole point: if the video is already at display resolution, no scaler
  // touches it.
  'scaler-resizes-only': true,

  // Proper dithering to the display's bit depth — prevents banding introduced
  // by our own output stage, without altering the source.
  'dither-depth': 'auto',

  // Debanding is deliberately OFF. Banding is a source/compression artifact,
  // and debanding removes it by adding dithered noise across the frame — that
  // is a change to the image. It can be enabled per-title later if a specific
  // transfer genuinely needs it.
  deband: false,

  // ---- HDR --------------------------------------------------------------
  // One configuration covers both display types:
  //   HDR display  -> the swap chain is tagged HDR10 and, with the hint mode
  //                   `source` (TONE_MAPPING_OPTIONS below), carries the
  //                   film's own metadata; the display tone maps, as it does
  //                   for a disc player.
  //   SDR display  -> mpv tone maps using TONE_MAPPING_OPTIONS below.
  'target-colorspace-hint': 'yes',

  // ---- Player behaviour -------------------------------------------------
  // We draw our own OSD/controls in React — mpv renders video only.
  osc: 'no',
  'osd-level': 0,
  'input-default-bindings': 'no',
  'input-vo-keyboard': 'no',

  'keep-open': 'yes',
  idle: 'yes',
  'force-window': 'yes',
  terminal: 'no',

  // Subtitles: pick up sidecar files with fuzzy name matching
  'sub-auto': 'fuzzy',
  'sub-visibility': 'yes',
};

/**
 * Setting key: how video frames are timed against the display.
 *
 * `'display'` selects mpv's `display-resample`; anything else leaves the
 * default audio clock. See `VIDEO_SYNC_MODES` for why this is a switch at all
 * when nothing else here is.
 */
export const VIDEO_SYNC_KEY = 'video_sync_mode';

export const VIDEO_SYNC_MODES = {
  /**
   * mpv's default. Video is timed to the audio clock and frames are dropped or
   * repeated to keep up. Nothing touches the audio, so this is the only mode
   * compatible with bitstream passthrough.
   */
  audio: 'audio',
  /**
   * Video is timed to the display's actual refresh clock, and the audio is
   * resampled by a fraction of a percent to match. Removes the drift and the
   * occasional dropped frame that the audio clock produces on a display whose
   * true refresh rate is not exactly what it claims.
   *
   * It does **not** remove 3:2 pulldown judder — 24p on a 60Hz panel is an
   * uneven cadence no timing strategy can make even. Only a display running at
   * 24, 48 or 120Hz fixes that, and switching display modes is the OS's job.
   *
   * Resampling audio makes this **incompatible with bitstream passthrough**: a
   * TrueHD or DTS:X stream sent untouched to an AVR cannot be resampled,
   * because nothing here has decoded it.
   */
  display: 'display-resample',
} as const;

/**
 * Options that are correct but not essential. They are applied one at a time
 * *after* mpv is already running, so that a version-specific option name being
 * rejected degrades the picture slightly instead of preventing startup.
 *
 * Anything whose availability depends on the libplacebo/mpv build belongs here,
 * not in BASE_MPV_OPTIONS.
 */
export const TONE_MAPPING_OPTIONS: Record<string, string | boolean | number> = {
  // HDR to an HDR display as the disc carries it. mpv's default, `target`,
  // first compresses the picture to the peak Windows reports for the screen —
  // an EDID figure, often generic — and then sends *that* as HDR10: on the owner's
  // test TV it ran a tone curve and a gamut map from the film's range to 1499 nits
  // before the TV applied its own. `source` sends the film's own metadata and
  // leaves the mapping to the display, which is what it is calibrated for.
  // Has no effect on an SDR display, where tone mapping is the only option.
  // Post-init because the option is newer than the rest of this block.
  'target-colorspace-hint-mode': 'source',

  // BT.2390 is the ITU reference EETF — the standards-body answer to "map HDR
  // into a smaller volume without lying about the image". Correct for anyone
  // who cares about intent rather than punch.
  'tone-mapping': 'bt.2390',

  // Measure the actual frame peak instead of trusting static metadata, which
  // is frequently wrong or absent in real remuxes. The percentile ignores a
  // few stray specular pixels that would otherwise crush the whole frame.
  'hdr-compute-peak': true,
  'hdr-peak-percentile': 99.8,

  // Map out-of-gamut colour perceptually rather than clipping it.
  'gamut-mapping-mode': 'perceptual',

  // NOTE: `tone-mapping-mode` is deliberately absent. This libplacebo build
  // returns M_PROPERTY_UNKNOWN (-3) for it — the option was removed upstream.
  // As an *initial* option it aborted mpv init entirely; that is why these
  // settings are applied after startup rather than at init.

  // ---- Interlaced sources -----------------------------------------------
  // The one place where *adding* a processing stage serves creator's intent
  // rather than working against it. Interlaced fields were meant to be woven
  // for display; showing them raw produces combing on every motion, which is
  // an artifact of the playback path and not something anyone shot.
  //
  // `auto` is what makes it safe: it acts only on streams the container
  // actually flags as interlaced, so every progressive file — which is to say
  // everything modern — goes through completely untouched. That is the same
  // "do nothing unless necessary" rule as `scaler-resizes-only`, applied to
  // time instead of space.
  //
  // Here rather than in the init set because the `auto` value is newer than
  // the option: on a build that predates it, a rejected option would abort
  // mpv init entirely and take the whole player with it.
  deinterlace: 'auto',
};

/**
 * What mpv draws when no video frame is up: before the first file, and between
 * files.
 *
 * mpv's idle surface is an **RGBA** image (`mpv.log`: "reconfig to 960x540
 * rgba" at init and after every stop), and this window is transparent so the
 * webview can sit on top of mpv — so the transparent parts of that image let
 * the desktop show straight through the app until a video frame arrives.
 * An opaque black background closes that gap at the source. Applied after
 * init like the options above: option names in this area have moved between
 * mpv versions, and a rejected one must cost this refinement, not the player.
 */
export const IDLE_SURFACE_OPTIONS: Record<string, string | boolean | number> = {
  background: 'color',
  'background-color': '#000000',
};
