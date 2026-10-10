package com.kinema.app

import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.util.Log
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes

/**
 * A Dolby Vision profile 7 film — most UHD Blu-ray remuxes — on a device with
 * no decoder for profile 7. Media3 refuses it outright: it falls back to the
 * plain HEVC decoder for profiles 4 and 8 only, as profile 7's base layer is
 * not usable alone everywhere. On a Blu-ray it is — an HDR10 picture, with
 * the Dolby Vision layer and its metadata beside it in units an HEVC decoder
 * passes over — so such a track is handed to Media3 as the HEVC it is
 * underneath, and the details panel says so (owner's decision, 2026-10-10:
 * the HDR10 picture rather than no film, said as what it is).
 *
 * Only where the device says it has no decoder for profile 7; one that has
 * keeps the film as Dolby Vision.
 */
internal object DolbyVision {
  /** The film now playing came as profile 7 and plays as its HDR10 base layer. */
  @Volatile var baseLayerOnly = false

  private val decodesProfile7: Boolean by lazy {
    val found = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
      !info.isEncoder && info.supportedTypes.any { it.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true) } &&
        runCatching {
          info.getCapabilitiesForType(MimeTypes.VIDEO_DOLBY_VISION).profileLevels
            .any { it.profile == CodecProfileLevel.DolbyVisionProfileDvheDtb }
        }.getOrDefault(false)
    }
    Log.i("Kinema", "media3: a decoder for Dolby Vision profile 7: ${if (found) "yes" else "none"}")
    found
  }

  /** The format Media3 is given for a video track: as it is, or its HDR10 base layer. */
  fun playable(format: Format): Format {
    if (format.sampleMimeType != MimeTypes.VIDEO_DOLBY_VISION) return format
    if (format.codecs?.startsWith("dvhe.07") != true || decodesProfile7) return format
    baseLayerOnly = true
    // Without the Dolby Vision codecs string: Media3 would read it as the
    // HEVC profile and level the decoder must take, which it is not.
    return format.buildUpon().setSampleMimeType(MimeTypes.VIDEO_H265).setCodecs(null).build()
  }
}
