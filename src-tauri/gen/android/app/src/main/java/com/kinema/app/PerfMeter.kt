package com.kinema.app

import android.os.Debug
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import app.tauri.plugin.JSObject
import java.io.File
import org.json.JSONObject

/** How often a `summary` line is written while a film plays. */
private const val SUMMARY_MS = 10_000L

/**
 * What playing a film costs on this device, measured and never acted on:
 * how long the first picture takes, how often it stops to wait for data,
 * how long a seek takes to show, frames dropped, memory and threads. One
 * line in the system log per event (tag KinemaPerf, key=value, so a script
 * can grep it) and the running totals in `facts` for a self-test to read.
 *
 * Always on, because it only listens: Media3 tells it things as they happen
 * and the plugin's own ticker lets it write a line every ten seconds, so
 * nothing polls and nothing plays differently with it there. Whatever is
 * later changed to play better is judged against these numbers.
 *
 * Every callback comes on the main thread (the player is built there), as
 * do `open`, `tick` and `facts`, so nothing here is locked.
 */
class PerfMeter : AnalyticsListener {
  private var player: ExoPlayer? = null
  private var openedAt = 0L
  private var firstFrameMs = -1L
  /** Playing has begun and not been stopped since: only then is waiting for data a stall. */
  private var ready = false
  private var stalls = 0
  private var stallMs = 0L
  private var stallAt = 0L
  private var stallBuffered = -1L
  private var seeks = 0
  /** The moment of a seek whose picture has not shown yet, or 0. */
  private var seekAt = 0L
  /** A seek is being waited out, which is not a stall (it is its own number). */
  private var seekWait = false
  private var shown = 0
  private var shownMs = 0L
  private var lastShown = -1L
  private var dropped = 0
  private var underruns = 0
  /** Bytes loaded since `windowAt`, and the rate the last window came to. */
  private var bytes = 0L
  private var windowAt = 0L
  private var lastKbps = 0L

  /** A new film: nothing of the last one carries over. */
  fun open() {
    openedAt = SystemClock.elapsedRealtime()
    windowAt = openedAt
    firstFrameMs = -1; ready = false; stalls = 0; stallMs = 0; stallAt = 0; stallBuffered = -1
    seeks = 0; seekAt = 0; seekWait = false; shown = 0; shownMs = 0; lastShown = -1
    dropped = 0; underruns = 0; bytes = 0; lastKbps = 0
    log("open")
  }

  /** A player was built (also after `fallBack`, mid-film: the totals stay). */
  fun attach(p: ExoPlayer) {
    player = p
    ready = false; stallAt = 0; seekAt = 0; seekWait = false
    p.addAnalyticsListener(this)
  }

  /** The player is gone (released with it, along with this listener). */
  fun detach() {
    player = null
  }

  private fun log(event: String, detail: String = "") {
    val t = SystemClock.elapsedRealtime() - openedAt
    Log.i("KinemaPerf", "event=$event t=$t${if (detail.isEmpty()) "" else " $detail"}")
  }

  /** Called by the plugin's ticker: a summary every ten seconds, none while paused or with nothing open. */
  fun tick() {
    val p = player ?: return
    val now = SystemClock.elapsedRealtime()
    if (now - windowAt < SUMMARY_MS) return
    val playing = p.playWhenReady && p.playbackState != Player.STATE_IDLE && p.playbackState != Player.STATE_ENDED
    if (playing) {
      lastKbps = kbps(now)
      log(
        "summary",
        "pos=${p.currentPosition} buffered=${p.totalBufferedDuration} stalls=$stalls stallMs=$stallMs " +
          "dropped=$dropped rendered=${rendered(p)} kbps=$lastKbps heapMb=${heapUsedMb()}/${heapMaxMb()} " +
          "nativeMb=${nativeMb()} threads=${threads()}",
      )
    }
    // A paused stretch is not load time: the next window starts clean.
    windowAt = now
    bytes = 0
  }

  private fun kbps(now: Long) = bytes * 8 / (now - windowAt).coerceAtLeast(1)
  private fun rendered(p: ExoPlayer) = p.videoDecoderCounters?.let { it.ensureUpdated(); it.renderedOutputBufferCount } ?: 0
  private fun heapUsedMb() = (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) shr 20
  private fun heapMaxMb() = Runtime.getRuntime().maxMemory() shr 20
  private fun nativeMb() = Debug.getNativeHeapAllocatedSize() shr 20
  private fun threads() = File("/proc/self/task").list()?.size ?: -1

  /** The running totals, for `facts`; a number that is not known yet is null, not 0. */
  fun facts(p: ExoPlayer): JSObject {
    val now = SystemClock.elapsedRealtime()
    return JSObject().apply {
      put("firstFrameMs", if (firstFrameMs < 0) JSONObject.NULL else firstFrameMs)
      put("stalls", stalls)
      put("stallMs", stallMs)
      put("lastStallBufferedMs", if (stallBuffered < 0) JSONObject.NULL else stallBuffered)
      put("seeks", seeks)
      put("lastSeekShownMs", if (lastShown < 0) JSONObject.NULL else lastShown)
      put("avgSeekShownMs", if (shown == 0) JSONObject.NULL else shownMs / shown)
      put("dropped", dropped)
      put("rendered", rendered(p))
      put("underruns", underruns)
      put("loadKbps", if (now - windowAt >= 2000) kbps(now) else lastKbps)
      put("heapUsedMb", heapUsedMb())
      put("heapMaxMb", heapMaxMb())
      put("nativeMb", nativeMb())
      put("threads", threads())
    }
  }

  override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
    val now = SystemClock.elapsedRealtime()
    when (state) {
      Player.STATE_BUFFERING ->
        // The first wait and a seek's are not stalls. Media3 tells of a seek's
        // discontinuity before the state it causes, so seekWait is already set.
        if (ready && !seekWait && stallAt == 0L) {
          stalls += 1
          stallAt = now
          stallBuffered = eventTime.totalBufferedDurationMs
          log("stall-start", "buffered=$stallBuffered pos=${eventTime.currentPlaybackPositionMs}")
        }
      Player.STATE_READY -> {
        ready = true
        seekWait = false
        if (stallAt != 0L) {
          val ms = now - stallAt
          stallMs += ms
          stallAt = 0
          log("stall-end", "ms=$ms")
        }
      }
      // Stopped (the screen was left) or finished: nothing is being waited for.
      else -> { ready = false; seekWait = false; stallAt = 0; seekAt = 0 }
    }
  }

  override fun onPositionDiscontinuity(
    eventTime: AnalyticsListener.EventTime, oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int,
  ) {
    if (reason != Player.DISCONTINUITY_REASON_SEEK) return
    seeks += 1
    seekAt = SystemClock.elapsedRealtime()
    seekWait = true
    log("seek", "from=${oldPosition.positionMs} target=${newPosition.positionMs}")
  }

  // Media3 says this again after every seek (the renderer starts over), so
  // the first one per film is the start and each later one is a seek's picture.
  override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
    val now = SystemClock.elapsedRealtime()
    if (firstFrameMs < 0) {
      firstFrameMs = now - openedAt
      log("first-frame", "ms=$firstFrameMs")
    }
    if (seekAt != 0L) {
      lastShown = now - seekAt
      shown += 1
      shownMs += lastShown
      seekAt = 0
      log("seek-shown", "ms=$lastShown")
    }
  }

  override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
    dropped += droppedFrames
    log("dropped", "count=$droppedFrames ms=$elapsedMs")
  }

  override fun onAudioUnderrun(
    eventTime: AnalyticsListener.EventTime, bufferSize: Int, bufferSizeMs: Long, elapsedSinceLastFeedMs: Long,
  ) {
    underruns += 1
    log("audio-underrun", "buffer=$bufferSize bufferMs=$bufferSizeMs sinceFeedMs=$elapsedSinceLastFeedMs")
  }

  override fun onLoadCompleted(eventTime: AnalyticsListener.EventTime, info: LoadEventInfo, data: MediaLoadData) {
    bytes += info.bytesLoaded
  }

  override fun onVideoDecoderInitialized(
    eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long,
  ) {
    log("decoder", "kind=video name=$decoderName ms=$initializationDurationMs")
  }

  override fun onAudioDecoderInitialized(
    eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long,
  ) {
    log("decoder", "kind=audio name=$decoderName ms=$initializationDurationMs")
  }
}
