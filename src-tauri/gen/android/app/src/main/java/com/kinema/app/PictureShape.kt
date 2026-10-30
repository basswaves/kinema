package com.kinema.app

import kotlin.math.roundToInt

/**
 * The film's picture on the screen in its own shape: as large as fits, with
 * bars above and below or at the sides for the rest (T30). A 2.39:1 film
 * stored without its bars (3840×1600) was stretched to fill a 16:9 screen
 * while the surface simply filled the screen. Kinema never cuts picture
 * away and never stretches it, so there is no zoom or fill choice.
 */
object PictureShape {
  /**
   * The width and height for the picture inside a [boxWidth]×[boxHeight]
   * area, or null while the film's size is not known (the area as it is).
   * [pixelRatio] is the width of one stored pixel against its height, for a
   * film stored squeezed (anamorphic DVD: 720×576 shown at 16:9).
   */
  fun fit(boxWidth: Int, boxHeight: Int, videoWidth: Int, videoHeight: Int, pixelRatio: Float): IntArray? {
    if (boxWidth <= 0 || boxHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null
    val ratio = if (pixelRatio > 0f && pixelRatio.isFinite()) pixelRatio.toDouble() else 1.0
    val shape = videoWidth * ratio / videoHeight
    return if (boxWidth.toDouble() / boxHeight > shape) {
      // Wider area than picture: bars at the sides.
      intArrayOf(minOf(boxWidth, (boxHeight * shape).roundToInt()), boxHeight)
    } else {
      // Taller area than picture: bars above and below.
      intArrayOf(boxWidth, minOf(boxHeight, (boxWidth / shape).roundToInt()))
    }
  }
}
