package com.kinema.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The film's own shape on screen, bars around it (PictureShape.kt, T30). */
class PictureShapeTest {

  @Test fun wideFilmWithoutBarsGetsBarsAboveAndBelow() {
    // 2.39:1 stored as 3840×1600 on a 16:9 screen: full width, 1600 of 2160 high.
    assertArrayEquals(intArrayOf(3840, 1600), PictureShape.fit(3840, 2160, 3840, 1600, 1f))
    assertArrayEquals(intArrayOf(1920, 800), PictureShape.fit(1920, 1080, 3840, 1600, 1f))
  }

  @Test fun narrowFilmGetsBarsAtTheSides() {
    // 4:3 on a 16:9 screen: full height, 1440 of 1920 wide.
    assertArrayEquals(intArrayOf(1440, 1080), PictureShape.fit(1920, 1080, 640, 480, 1f))
  }

  @Test fun sameShapeFillsTheScreen() {
    assertArrayEquals(intArrayOf(1920, 1080), PictureShape.fit(1920, 1080, 3840, 2160, 1f))
  }

  @Test fun squeezedPixelsAreWidened() {
    // A 16:9 DVD: 720×576 with pixels 64:45 wide fills a 16:9 screen.
    assertArrayEquals(intArrayOf(1920, 1080), PictureShape.fit(1920, 1080, 720, 576, 64f / 45f))
    // The same pixels taken as square would be 5:4, bars at the sides.
    assertArrayEquals(intArrayOf(1350, 1080), PictureShape.fit(1920, 1080, 720, 576, 1f))
  }

  @Test fun anUnknownSizeLeavesTheAreaAsItIs() {
    assertNull(PictureShape.fit(1920, 1080, 0, 0, 1f))
    assertNull(PictureShape.fit(0, 0, 1920, 1080, 1f))
    // A missing pixel ratio counts as square.
    assertArrayEquals(intArrayOf(1920, 800), PictureShape.fit(1920, 1080, 1920, 800, 0f))
  }
}
