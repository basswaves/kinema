package com.kinema.app

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.text.SubtitleParser
import kotlin.math.abs

/**
 * The film's frame rate where its file does not state one in a way Media3
 * reports: Matroska keeps a frame duration that Media3 reads and never turns
 * into a rate (2026-10-05, a clip and a real episode alike), so "match the
 * screen" had nothing to match the refresh rate to.
 *
 * Worked out from the frames' own times as Media3 reads the file ahead —
 * which it does while the film is held paused for the screen to switch, so
 * the rate is known before the switch, from the same reading of the file
 * that plays it. Each extractor Media3 makes is wrapped; its video track's
 * sample times go to a [FrameRateMeter], everything else straight through.
 *
 * `rateFor` is asked once per file opened, on the loading thread, for where
 * that file's answer goes.
 */
internal class FrameTimingExtractors(
  private val inner: ExtractorsFactory,
  private val rateFor: () -> (Double?) -> Unit,
) : ExtractorsFactory {
  override fun createExtractors(): Array<Extractor> =
    inner.createExtractors().map { Timed(it) }.toTypedArray()

  override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
    inner.createExtractors(uri, responseHeaders).map { Timed(it) }.toTypedArray()

  // Media3 sets these on the factory it is given; they are the wrapped one's
  // (subtitles inside the file are parsed by it).
  @Deprecated("Media3's own, passed on as it is")
  @Suppress("DEPRECATION")
  override fun experimentalSetTextTrackTranscodingEnabled(enabled: Boolean): ExtractorsFactory {
    inner.experimentalSetTextTrackTranscodingEnabled(enabled)
    return this
  }

  override fun setSubtitleParserFactory(factory: SubtitleParser.Factory): ExtractorsFactory {
    inner.setSubtitleParserFactory(factory)
    return this
  }

  override fun experimentalSetCodecsToParseWithinGopSampleDependencies(codecsToParse: Int): ExtractorsFactory {
    inner.experimentalSetCodecsToParseWithinGopSampleDependencies(codecsToParse)
    return this
  }

  override fun setParseHagcMetadata(parseHagcMetadata: Boolean): ExtractorsFactory {
    inner.setParseHagcMetadata(parseHagcMetadata)
    return this
  }

  private inner class Timed(private val wrapped: Extractor) : Extractor {
    private var meter: FrameRateMeter? = null

    override fun sniff(input: ExtractorInput) = wrapped.sniff(input)
    override fun getSniffFailureDetails() = wrapped.sniffFailureDetails
    override fun getUnderlyingImplementation(): Extractor = wrapped.underlyingImplementation

    override fun init(output: ExtractorOutput) {
      val m = FrameRateMeter(rateFor())
      meter = m
      wrapped.init(object : ExtractorOutput by output {
        override fun track(id: Int, type: Int): TrackOutput {
          val track = output.track(id, type)
          return if (type == C.TRACK_TYPE_VIDEO && m.claim(id)) TimedTrack(track, m) else track
        }
      })
    }

    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
      val result = wrapped.read(input, seekPosition)
      if (result == Extractor.RESULT_END_OF_INPUT) meter?.finish()
      return result
    }

    override fun seek(position: Long, timeUs: Long) {
      meter?.restart()
      wrapped.seek(position, timeUs)
    }

    override fun release() = wrapped.release()
  }

  private class TimedTrack(private val track: TrackOutput, private val meter: FrameRateMeter) : TrackOutput {
    override fun format(format: Format) = track.format(format)
    override fun durationUs(durationUs: Long) = track.durationUs(durationUs)
    override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean) =
      track.sampleData(input, length, allowEndOfInput)
    override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int) =
      track.sampleData(input, length, allowEndOfInput, sampleDataPart)
    override fun sampleData(data: ParsableByteArray, length: Int) = track.sampleData(data, length)
    override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) =
      track.sampleData(data, length, sampleDataPart)

    override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
      meter.add(timeUs)
      track.sampleMetadata(timeUs, flags, size, offset, cryptoData)
    }
  }
}

/** The rates films are made at; a measured rate this close to one is that one. */
private val STANDARD_RATES = doubleArrayOf(
  24000.0 / 1001, 24.0, 25.0, 30000.0 / 1001, 30.0, 48000.0 / 1001, 48.0,
  50.0, 60000.0 / 1001, 60.0, 100.0, 120000.0 / 1001, 120.0,
)

/** Enough film to tell 23.976 from 24 when each time is rounded to a millisecond, as Matroska's are. */
private const val SPAN_US = 4_500_000L
/** The least that can still tell them apart: a millisecond in 2.5 s is 0.04 %, under half the 0.1 % between them. */
private const val LEAST_SPAN_US = 2_500_000L
/**
 * Frames come in the order they are decoded, not shown: one shown at time t
 * may not have arrived until a few frames after one shown later. Times this
 * close to the latest are left out, as their neighbours may still be coming.
 */
private const val REORDER_US = 1_000_000L
/** How far one frame's step may stray from the average and the film still count as evenly timed. */
private const val JITTER_US = 2_000L
private const val MAX_FRAMES = 1200

/**
 * One file's video sample times, to the frame rate they keep — snapped to
 * the standard rate it is, as Matroska's millisecond times can say no more
 * exactly — or to null when the frames are not evenly timed, rather than a
 * guess. Answers once, on the loading thread.
 */
internal class FrameRateMeter(private val answer: (Double?) -> Unit) {
  private var track = -1
  private val times = LongArray(MAX_FRAMES)
  private var count = 0
  private var first = Long.MAX_VALUE
  private var last = Long.MIN_VALUE
  private var done = false

  /** The first video track is the one measured. */
  @Synchronized fun claim(id: Int): Boolean {
    if (track == -1) track = id
    return track == id
  }

  /** Media3 moved in the file: the times so far no longer run on to the next ones. */
  @Synchronized fun restart() {
    if (done) return
    count = 0
    first = Long.MAX_VALUE
    last = Long.MIN_VALUE
  }

  @Synchronized fun add(timeUs: Long) {
    if (done) return
    times[count++] = timeUs
    if (timeUs < first) first = timeUs
    if (timeUs > last) last = timeUs
    if (last - first >= SPAN_US + REORDER_US || count == MAX_FRAMES) conclude(complete = false)
  }

  /** The file ended: every frame is in, however short it was. */
  @Synchronized fun finish() {
    if (!done && count > 1) conclude(complete = true)
  }

  private fun conclude(complete: Boolean) {
    done = true
    val sorted = times.copyOf(count).also { it.sort() }
    val end = if (complete) sorted.last() else sorted.last() - REORDER_US
    val n = sorted.indexOfLast { it <= end } + 1
    val span = if (n > 1) sorted[n - 1] - sorted[0] else 0L
    val rate = if (span < LEAST_SPAN_US) null else rateOf(sorted, n, span)
    Log.i("Kinema", "media3: frame rate from $n frames' times over ${span / 1000} ms: ${rate ?: "not evenly timed or too short"}")
    answer(rate)
  }

  private fun rateOf(sorted: LongArray, n: Int, span: Long): Double? {
    val step = span.toDouble() / (n - 1)
    var uneven = 0
    for (i in 1 until n) if (abs((sorted[i] - sorted[i - 1]) - step) > JITTER_US) uneven++
    // A stray frame or two is a film; more is a video whose frames come when they come.
    if (uneven > (n - 1) / 20) return null
    val fps = 1_000_000.0 / step
    val near = STANDARD_RATES.minByOrNull { abs(it - fps) / it }!!
    if (abs(near - fps) / near < 1000.0 / span) return near
    // Evenly timed at a rate no standard is: said as measured, if measured long enough to mean it.
    return if (span >= SPAN_US) Math.round(fps * 1000) / 1000.0 else null
  }
}
