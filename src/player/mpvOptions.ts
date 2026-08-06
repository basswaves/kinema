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
