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

/** Options applied once at mpv init and never changed at runtime. */
export const BASE_MPV_OPTIONS: Record<string, string | boolean | number> = {
  // ---- Diagnostics FIRST ------------------------------------------------
  // Options are applied in order. If a later option is rejected, mpv init
  // fails — and if logging were configured after it, there would be no log
  // explaining why. Keep these at the top so failures are always recorded.
  // Replaced with an absolute path in app data by `mpv.ts` before init; this
  // relative fallback is used only if that path cannot be resolved.
  'log-file': 'mpv.log',
  'msg-level': 'all=v',

  // ---- Rendering path ---------------------------------------------------
  // gpu-next is the modern renderer (libplacebo). d3d11 + d3d11va is the
  // vendor-neutral Windows path: NVIDIA, AMD and Intel all use it.
  vo: 'gpu-next',
  'gpu-api': 'd3d11',
  hwdec: 'd3d11va',

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
  // One configuration covers both display types, because mpv only tone maps
  // when the source exceeds what the target can show:
  //   HDR display  -> colorspace hint lets Windows switch, signal passes
  //                   through untouched. Creator's intent preserved exactly.
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

/**
 * "Potato PC" fallback — the one escape hatch.
 *
 * Not a quality preference, an emergency valve for hardware that cannot keep
 * up. Drops to bilinear and disables the correctness passes, which are the
 * expensive parts. Everything else, including HDR tone mapping, is untouched:
 * a slow machine should still not be shown a wrong image.
 */
export const POTATO_MODE_OPTIONS: Record<string, string | boolean | number> = {
  scale: 'bilinear',
  cscale: 'bilinear',
  dscale: 'bilinear',
  'correct-downscaling': false,
  'linear-downscaling': false,
  'sigmoid-upscaling': false,
  'hdr-compute-peak': false,
};

/** Restores the creator's-intent rendering settings after potato mode. */
export const CREATOR_INTENT_OPTIONS: Record<string, string | boolean | number> = {
  scale: 'spline36',
  cscale: 'spline36',
  dscale: 'mitchell',
  'correct-downscaling': true,
  'linear-downscaling': true,
  'sigmoid-upscaling': true,
  'hdr-compute-peak': true,
};
