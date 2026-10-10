package com.kinema.app

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.hardware.display.DisplayManager
import android.media.MediaCodec
import android.media.MediaCodecList
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Pair
import android.view.Display
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.text.CueGroup
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.text.TextRenderer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.trackselection.MappingTrackSelector.MappedTrackInfo
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.exoplayer.util.EventLogger
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import app.tauri.plugin.JSArray
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import org.json.JSONObject

@InvokeArg
class OpenArgs {
  lateinit var path: String
  /**
   * Where to read it from, when that is not the path: a film on a network
   * share Kinema opens itself comes from the core over this device's own
   * HTTP (stream.rs). The path stays the film's name for everything else.
   */
  var url: String? = null
  /** Seconds to start at, or null for the beginning. */
  var start: Double? = null
  /** Subtitle files of its own beside the film, found by the core (subtitle_files.rs). */
  var subtitles: Array<SubtitleArg> = arrayOf()
}

/** A subtitle file, beside the film or fetched, as `open` and `add_subtitle` take one. */
@InvokeArg
class SubtitleArg {
  /** A path on this device, or an address (a share's, through stream.rs). */
  lateinit var uri: String
  var language: String? = null
  /** The name the track panel gives it, when there is one. */
  var label: String? = null
  var forced: Boolean = false
  var hearingImpaired: Boolean = false
}

@InvokeArg
class PausedArgs {
  var paused: Boolean = false
}

@InvokeArg
class ModeArgs {
  var width: Int = 0
  var height: Int = 0
  var rate: Double = 0.0
}

@InvokeArg
class VolumeArgs {
  /** 0–100, as Kinema's volume control says it. */
  var level: Double = 100.0
}

@InvokeArg
class MutedArgs {
  var muted: Boolean = false
}

@InvokeArg
class TrackArgs {
  /** "audio" or "sub", as engine.ts says it. */
  var kind: String = ""
  /** Kinema's number for it, from `tracks`. */
  var id: Int = 0
}

@InvokeArg
class ShowArgs {
  var visible: Boolean = true
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
  /** Relative to where it is, rather than from the start. */
  var relative: Boolean = false
}

/**
 * The player on Android: Media3, drawing on a surface behind Kinema's page.
 *
 * The page is made see-through and the surface goes beneath it, so the
 * film shows wherever the page draws nothing — the same layering as mpv
 * beneath the transparent window on Windows, and the player's controls are
 * the same page on every system. The other half is `src/player/media3.ts`.
 *
 * What happens is told to the page as one `playback` event in Kinema's own
 * terms (`PlaybackEvent` in engine.ts), never Media3's, so nothing above the
 * seam has to know which engine is playing.
 *
 * Picture and sound on Android (owner, 2026-10-04): HDR is the system's —
 * Android turns the TV's HDR on for an HDR film by itself — and so is
 * sending the sound to a receiver untouched, which Media3 does wherever
 * Android says the HDMI output takes the format. What Kinema adds:
 *  - the screen's mode, matched to the film the way Windows and Linux do it
 *    (`displaySwitch.ts` chooses, `setMode` asks Android for it), with
 *    Media3's own frame-rate matching off so there is one way, not two;
 *  - a way back when the sound will not open: Android can claim a format the
 *    box then refuses (a box set never to pass surround through still said
 *    DTS, and refused it), so the sound is decoded on the device instead,
 *    and failing that the film plays without it — never not at all;
 *  - what the sound actually did, for Settings: sent on untouched or
 *    decoded here, as Media3 opened it — not what any setting claims.
 */
/**
 * How long a track choice waits for Media3 to have made it, before answering
 * anyway: Media3 chooses on its own thread, and the page reads the tracks
 * again straight after choosing.
 */
private const val CHOICE_WAIT_MS = 1500L

/**
 * How long a choice waits for the film's tracks when the player was just
 * built again (`fallBack`) and has not read them yet.
 */
private const val TRACKS_WAIT_MS = 10_000L

/** How long an added subtitle file is given to be read, once the film is opened again. */
private const val ADD_WAIT_MS = 10_000L

/** The start of the id a subtitle file of its own is given, beside the film or fetched. */
private const val EXTERNAL = "kinema-file:"

/** How long a taken video decoder is given before Kinema asks again. */
private const val RETRY_MS = 1500L

/**
 * How long the frames' times are waited for (FrameTiming.kt) where the file
 * states no frame rate, before the film is said to have none: the screen
 * switch waits for it, and a slow share must not hold the film for long.
 */
private const val TIMING_WAIT_MS = 8000L

/** Where the last film's sound is remembered (`lastSound`), across restarts. */
private const val PREFS = "media3"
private const val LAST_SOUND = "last_sound"

@TauriPlugin
class Media3Plugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var surface: SurfaceView? = null
  /**
   * The subtitles, between the film and the page: Media3's own layer
   * (owner, 2026-10-05), drawn the way mpv draws them on the desktop.
   */
  private var subtitleView: SubtitleView? = null
  /**
   * What is open, with its subtitle files: kept so the film can be opened
   * again as it is — after a sound fallback, or with a subtitle added.
   */
  private var item: MediaItem? = null
  /** How many subtitle files have been handed to Media3, for their ids. */
  private var subtitleCount = 0
  private var player: ExoPlayer? = null
  private var path: String? = null
  /** The first frame of this file has been shown; until then a frame is the start. */
  private var started = false
  /** A seek was asked for: the next time the player is ready, playback has restarted. */
  private var seeking = false
  /**
   * Whether to play, kept across files as mpv keeps `pause`: the player
   * pauses before a file opens so the screen can switch first (engine.ts).
   */
  private var wantPlaying = true
  /**
   * How the sound is played for this file: 0 as Android says it can (passed
   * through where the HDMI output takes it), 1 decoded on the device, 2 not
   * at all. Each refusal moves one step on.
   */
  private var audioStep = 0
  /** The film's picture, once Media3 has chosen its video track and its frame rate is known or given up on. */
  private var video: JSObject? = null
  /** The chosen video track's format, for `video`. */
  private var videoFormat: Format? = null
  /** Which file a frame rate worked out from the frames' times belongs to (`rateSink`). */
  @Volatile private var timingFile = 0
  /** The frame rate worked out from the frames' times, where the file states none Media3 reports. */
  private var timedFps: Double? = null
  /** The frames' times have answered for this file, or were waited for long enough. */
  private var timingDone = false
  /** The sound that would not play, to be named once the next way is known. */
  private var failedSound: String? = null
  /**
   * Kinema's volume, 0–100, and mute: the player's own, kept across the
   * player being built again (`fallBack`, `open`) as mpv keeps its own.
   */
  private var volume = 100.0
  private var muted = false
  /**
   * This film's sound leaves untouched, for the receiver to decode: Kinema's
   * volume does nothing to it then, and the page says the receiver's is the
   * one (engine.ts `soundGoesUntouched`).
   */
  private var untouched = false
  /**
   * `loaded` has been said for this file. Said once its tracks are known —
   * Kinema's meaning of it (engine.ts) — not as it is handed to Media3,
   * when there are none yet to put the remembered languages on.
   */
  private var loadedSaid = false
  /**
   * Whether subtitles show, as mpv's `sub-visibility`: hiding them keeps the
   * subtitle track chosen. Kept across files, as mpv keeps it.
   */
  private var subtitlesShown = true
  /** The decoders Media3 opened for this file, by name, for the details panel. */
  private var videoDecoder: String? = null
  private var audioDecoder: String? = null
  private val main = Handler(Looper.getMainLooper())
  /** What playing this film costs, measured and logged (PerfMeter.kt); it changes nothing. */
  private val perf = PerfMeter()

  /**
   * Kinema left the screen (Home, the box asleep, another app in front)
   * with a film open: it was paused and its decoder handed back, and is
   * opened again, paused at the same moment, when Kinema returns. A box may
   * have one video decoder, and the app in front is owed it — as every
   * other player does it.
   */
  private var suspended = false
  /** A taken decoder was asked for once more for this file (`decoderTaken`). */
  private var retried = false

  override fun onStop() {
    main.post {
      val p = player ?: return@post
      if (path == null || suspended) return@post
      suspended = true
      wantPlaying = false
      // Said to the page by the listener, as any other pause.
      p.playWhenReady = false
      // Keeps the file and the moment; lets go of the decoder and the sound.
      p.stop()
      // Nobody is watching the position now; onResume starts it again.
      main.removeCallbacks(ticker)
      Log.i("Kinema", "media3: left the screen at ${p.currentPosition} ms; decoder handed back")
    }
  }

  override fun onResume() {
    main.post {
      if (!suspended) return@post
      suspended = false
      val p = player ?: return@post
      if (path == null) return@post
      p.prepare()
      lastPosition = -1
      main.removeCallbacks(ticker)
      main.post(ticker)
      Log.i("Kinema", "media3: back on screen; reopened paused at ${p.currentPosition} ms")
    }
  }

  override fun load(webView: WebView) {
    this.webView = webView
    // See-through wherever the page itself draws nothing.
    webView.setBackgroundColor(Color.TRANSPARENT)
  }

  private fun emit(type: String, fill: JSObject.() -> Unit = {}) {
    trigger("playback", JSObject().apply { put("type", type); fill() })
  }

  /** The position last said to the page (ms), so a film that has not moved says nothing. */
  private var lastPosition = -1L

  /** The position, a few times a second while something is open: Media3 has no event for it. */
  private val ticker = object : Runnable {
    override fun run() {
      val p = player ?: return
      // Only when it moved: a paused film says nothing.
      val at = p.currentPosition
      if (at != lastPosition) {
        lastPosition = at
        emit("position") { put("value", at / 1000.0) }
      }
      perf.tick()
      main.postDelayed(this, 250)
    }
  }

  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }
    val view = webView ?: throw IllegalStateException("the page is not there yet")
    val parent = view.parent as ViewGroup
    val s = SurfaceView(activity)
    // Beneath the page: the first child of the page's own parent.
    parent.addView(s, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    surface = s
    val subs = SubtitleView(activity)
    // mpv's look on the desktop: white letters with a black outline, no box,
    // 38 of 720 lines high and 22 above the bottom edge (mpv's defaults).
    subs.setStyle(
      CaptionStyleCompat(
        Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT,
        CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, Typeface.SANS_SERIF,
      )
    )
    subs.setFractionalTextSize(38f / 720f)
    subs.setBottomPaddingFraction(22f / 720f)
    // Above the film, beneath the page.
    parent.addView(subs, 1, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    subtitleView = subs
    showOrHideSubtitles()
    return try {
      buildPlayer(s)
    } catch (e: Exception) {
      // The next open would add a second pair beneath the page.
      parent.removeView(s)
      parent.removeView(subs)
      surface = null
      subtitleView = null
      throw e
    }
  }

  /** The subtitle layer shows or not; the chosen track stays chosen either way. */
  private fun showOrHideSubtitles() {
    subtitleView?.visibility = if (subtitlesShown) View.VISIBLE else View.INVISIBLE
  }

  /** A subtitle file as Media3 takes one, with an id that says it is a file of its own. */
  private fun subtitleConfiguration(arg: SubtitleArg): MediaItem.SubtitleConfiguration {
    subtitleCount += 1
    val uri = if (arg.uri.contains("://")) Uri.parse(arg.uri) else Uri.fromFile(File(arg.uri))
    val mime = when (arg.uri.substringAfterLast('.').substringBefore('?').lowercase()) {
      "ass", "ssa" -> MimeTypes.TEXT_SSA
      "vtt" -> MimeTypes.TEXT_VTT
      else -> MimeTypes.APPLICATION_SUBRIP
    }
    return MediaItem.SubtitleConfiguration.Builder(uri)
      .setId("$EXTERNAL$subtitleCount")
      .setMimeType(mime)
      .setLanguage(arg.language)
      .setLabel(arg.label)
      .setSelectionFlags(if (arg.forced) C.SELECTION_FLAG_FORCED else 0)
      .setRoleFlags(if (arg.hearingImpaired) C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND else 0)
      .build()
  }

  /**
   * Media3's renderers, with the sound passed through only at step 0. Past
   * it, the output says it takes nothing but decoded sound, so Media3
   * decodes on the device or picks a track it can decode. Telling the sink
   * the HDMI output's capabilities are plain (setAudioCapabilities) is not
   * enough: Media3 1.11 works them out again itself and passed DTS through
   * anyway (seen on a box, 2026-10-04).
   */
  private fun renderers(step: Int) = object : DefaultRenderersFactory(activity) {
    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink? {
      val sink = super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams) ?: return null
      if (step == 0) return sink
      return object : ForwardingAudioSink(sink) {
        override fun supportsFormat(format: Format) =
          format.sampleMimeType == MimeTypes.AUDIO_RAW && super.supportsFormat(format)

        override fun getFormatSupport(format: Format) =
          if (format.sampleMimeType == MimeTypes.AUDIO_RAW) super.getFormatSupport(format)
          else AudioSink.SINK_FORMAT_UNSUPPORTED
      }
    }

    // Subtitles are turned into pictures and text as they are shown, by the
    // renderer, only for the track that is on (see buildPlayer).
    override fun buildTextRenderers(
      context: Context, output: TextOutput, outputLooper: Looper, extensionRendererMode: Int, out: ArrayList<Renderer>,
    ) {
      super.buildTextRenderers(context, output, outputLooper, extensionRendererMode, out)
      out.filterIsInstance<TextRenderer>().forEach { it.experimentalSetLegacyDecodingEnabled(true) }
    }
  }

  /**
   * Past step 0 (`strict`), a sound track Media3 cannot play here is not
   * chosen at all; another one that it can play is, if the film has one.
   * The sound only: a box's decoder may say a film's picture is beyond it
   * and play it all the same (a 4K HEVC of a higher level than the box
   * lists, 2026-10-09), so the picture keeps Media3's own leeway — set for
   * every track, the film opened again as sound alone.
   */
  private fun soundOnlySelector(strict: Boolean) = object : DefaultTrackSelector(activity) {
    override fun selectAudioTrack(
      info: MappedTrackInfo,
      support: Array<Array<IntArray>>,
      mixed: IntArray,
      params: Parameters,
    ): Pair<ExoTrackSelection.Definition, Int>? =
      super.selectAudioTrack(
        info, support, mixed,
        if (strict) params.buildUpon().setExceedRendererCapabilitiesIfNecessary(false).build() else params,
      )
  }

  private fun buildPlayer(s: SurfaceView): ExoPlayer {
    val selector = soundOnlySelector(audioStep > 0)
    // Not every subtitle track turned into pictures while the file is read:
    // Media3 does that by default on the one thread that reads the film, and
    // a Blu-ray remux with 18–42 picture-subtitle tracks starved it — the
    // film stalled with the share waiting on the player (seen on a box,
    // 2026-10-10). The renderer decodes the chosen track instead.
    val sources = DefaultMediaSourceFactory(activity, FrameTimingExtractors(DefaultExtractorsFactory()) { rateSink() })
      .experimentalParseSubtitlesDuringExtraction(false)
    val p = ExoPlayer.Builder(activity, renderers(audioStep))
      .setTrackSelector(selector)
      .setMediaSourceFactory(sources)
      .build()
    // Media3's own account of what it chose and did (decoder, sound path,
    // dropped frames, stalls), in the system log of a test build only.
    if (BuildConfig.DEBUG) p.addAnalyticsListener(EventLogger("KinemaEvents"))
    p.addAnalyticsListener(object : AnalyticsListener {
      override fun onAudioTrackInitialized(eventTime: AnalyticsListener.EventTime, config: AudioSink.AudioTrackConfig) {
        p.audioFormat?.let { rememberSound(it, config) }
      }

      override fun onVideoDecoderInitialized(
        eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long,
      ) {
        videoDecoder = decoderName
      }

      override fun onAudioDecoderInitialized(
        eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long,
      ) {
        audioDecoder = decoderName
      }
    })
    perf.attach(p)
    p.setVideoSurfaceView(s)
    applyVolume(p)
    // Kinema matches the screen itself (setMode); Media3's own matching
    // would be a second hand on the same switch.
    p.videoChangeFrameRateStrategy = C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF
    if (audioStep >= 2) {
      p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build()
    }
    p.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        when (state) {
          Player.STATE_READY -> {
            val d = p.duration
            emit("duration") { put("value", if (d > 0) d / 1000.0 else JSONObject.NULL) }
            if (seeking) {
              seeking = false
              emit("restarted")
            }
          }
          Player.STATE_ENDED -> {
            emit("reached-end")
            emit("ended") { put("reason", "eof") }
          }
          else -> {}
        }
      }

      // Paused is whether it means to play, not whether it is playing this
      // instant: waiting for data is not a pause.
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        emit("paused") { put("value", !playWhenReady) }
      }

      override fun onCues(cueGroup: CueGroup) {
        subtitleView?.setCues(cueGroup.cues)
        // What reached the subtitle layer, words or pictures (PGS), in a test build's log.
        if (BuildConfig.DEBUG && cueGroup.cues.isNotEmpty()) {
          val pictures = cueGroup.cues.count { it.bitmap != null }
          Log.d("Kinema", "media3: cues at ${player?.currentPosition} ms: ${cueGroup.cues.size} (pictures $pictures)")
        }
      }

      override fun onRenderedFirstFrame() {
        // Media3 says this again after every seek; only the first one is the start.
        if (!started) {
          started = true
          emit("restarted")
        }
      }

      override fun onTracksChanged(tracks: Tracks) {
        announceSound(tracks)
        rememberVideo(tracks)
        if (!loadedSaid && !tracks.isEmpty) {
          loadedSaid = true
          emit("loaded")
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        if (audioStep < 2 && isAudioFailure(p, error)) {
          fallBack(error)
          return
        }
        // The decoder in use elsewhere: often for a moment only (the app
        // Kinema came from letting go of it), so once more before saying so.
        if (decoderTaken(error) && !retried) {
          retried = true
          Log.w("Kinema", "media3: the video decoder is in use (${error.errorCodeName}); trying again")
          main.postDelayed({ if (player === p && path != null) p.prepare() }, RETRY_MS)
          return
        }
        Log.w("Kinema", "media3: could not play: ${error.errorCodeName}: ${error.message}")
        emit("ended") {
          put("reason", "error")
          put("detail", inWords(error))
        }
      }
    })
    player = p
    return p
  }

  /** The film's picture, once Media3 has chosen its video track. */
  private fun rememberVideo(tracks: Tracks) {
    val group = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_VIDEO && it.isSelected } ?: return
    val index = (0 until group.length).firstOrNull { group.isTrackSelected(it) } ?: return
    val f = group.getTrackFormat(index)
    val first = videoFormat == null
    videoFormat = f
    if (first && f.frameRate <= 0 && !timingDone) main.postDelayed(timingTimeout, TIMING_WAIT_MS)
    publishVideo()
  }

  /**
   * `video` for the page, which matches the screen to it: held back while
   * the frame rate is still being worked out, so the match has it.
   */
  private fun publishVideo() {
    val f = videoFormat ?: return
    val fps = frameRate(f)
    if (fps == null && !timingDone) return
    val transfer = f.colorInfo?.colorTransfer
    video = JSObject().apply {
      put("width", f.width)
      put("height", f.height)
      put("fps", fps ?: JSONObject.NULL)
      put("hdr", transfer == C.COLOR_TRANSFER_ST2084 || transfer == C.COLOR_TRANSFER_HLG)
    }
  }

  /** The file's own frame rate as Media3 reports it, else the one its frames' times keep. */
  private fun frameRate(f: Format): Double? = if (f.frameRate > 0) f.frameRate.toDouble() else timedFps

  /** Where this file's frame rate goes when its frames' times have given one (FrameTiming.kt). */
  private fun rateSink(): (Double?) -> Unit {
    val file = timingFile
    return { fps -> main.post { if (file == timingFile) rateKnown(fps) } }
  }

  private fun rateKnown(fps: Double?) {
    // A file opened again (a subtitle added) is timed again; a second answer
    // of nothing does not undo the first.
    if (fps != null) timedFps = fps
    timingDone = true
    main.removeCallbacks(timingTimeout)
    publishVideo()
  }

  private val timingTimeout = Runnable {
    if (!timingDone) {
      Log.i("Kinema", "media3: no frame rate from the frames' times within $TIMING_WAIT_MS ms")
      timingDone = true
      publishVideo()
    }
  }

  /**
   * Kinema's volume to Media3's gain, on the same curve as mpv's (cubed), so
   * a step on the control sounds the same on every system. Mute is no gain.
   */
  private fun applyVolume(p: ExoPlayer) {
    p.volume = if (muted) 0f else Math.pow(volume.coerceIn(0.0, 100.0) / 100.0, 3.0).toFloat()
  }

  /**
   * The video decoder is someone else's: a box may have only one, and the
   * system says "no memory" (-12) when it is in use, or takes it back from
   * a player behind the app in front.
   */
  private fun decoderTaken(error: PlaybackException): Boolean {
    if (error.errorCode == PlaybackException.ERROR_CODE_DECODING_RESOURCES_RECLAIMED) return true
    if (error.errorCode != PlaybackException.ERROR_CODE_DECODER_INIT_FAILED) return false
    var cause: Throwable? = error.cause
    while (cause != null) {
      // The code itself on most systems; Android 9 on one box gave only
      // its message ("…, error 0xfffffff4").
      if (cause is MediaCodec.CodecException &&
        (cause.errorCode == -12 || cause.message?.contains("0xfffffff4") == true)
      ) return true
      cause = cause.cause
    }
    return false
  }

  /**
   * Why the film could not play, in words for the person holding the
   * remote: the page shows "Could not play this file: " and this. The
   * technical name goes to the log.
   */
  private fun inWords(error: PlaybackException): String {
    val format = (error as? ExoPlaybackException)?.rendererFormat
    return when {
      decoderTaken(error) ->
        "the video decoder on this device is in use by something else. Close other video apps and try again."
      error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ->
        "Android's player cannot open this kind of file" + (path?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() && it.length <= 5 }?.let { " (.$it)" } ?: "") + "."
      error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
        error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES ||
        error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ||
        error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED ->
        "this device could not decode its picture" + (format?.let { " (${describe(it)})" } ?: "") + "."
      error.errorCode == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND ->
        "the file is not there any more. It may have been moved, or its drive may be unplugged."
      error.errorCode == PlaybackException.ERROR_CODE_IO_NO_PERMISSION ->
        "Kinema is not allowed to read it. Check Kinema's permissions in the system's settings."
      else -> error.errorCodeName + (error.message?.let { ": $it" } ?: "")
    }
  }

  /** "HEVC, 3840×2160, 10-bit HDR" — what the picture asks of a decoder. */
  private fun describe(f: Format): String {
    val codec = when (f.sampleMimeType) {
      MimeTypes.VIDEO_H265 -> "HEVC"
      MimeTypes.VIDEO_H264 -> "H.264"
      MimeTypes.VIDEO_AV1 -> "AV1"
      MimeTypes.VIDEO_VP9 -> "VP9"
      MimeTypes.VIDEO_DOLBY_VISION -> "Dolby Vision"
      MimeTypes.VIDEO_MPEG2 -> "MPEG-2"
      else -> f.sampleMimeType ?: "video"
    }
    val size = if (f.width > 0 && f.height > 0) ", ${f.width}×${f.height}" else ""
    val bits = if ((f.colorInfo?.lumaBitdepth ?: 8) > 8) ", ${f.colorInfo?.lumaBitdepth}-bit" else ""
    val transfer = f.colorInfo?.colorTransfer
    val hdr = if (transfer == C.COLOR_TRANSFER_ST2084 || transfer == C.COLOR_TRANSFER_HLG) " HDR" else ""
    return codec + size + bits + hdr
  }

  /** "Dolby Digital Plus with Atmos 5.1" — the sound's format, as a person says it. */
  private fun soundName(f: Format): String {
    val codec = when (f.sampleMimeType) {
      MimeTypes.AUDIO_AC3 -> "Dolby Digital"
      MimeTypes.AUDIO_E_AC3 -> "Dolby Digital Plus"
      MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Digital Plus with Atmos"
      MimeTypes.AUDIO_AC4 -> "Dolby AC-4"
      MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
      MimeTypes.AUDIO_DTS -> "DTS"
      MimeTypes.AUDIO_DTS_EXPRESS -> "DTS Express"
      MimeTypes.AUDIO_DTS_HD -> "DTS-HD"
      MimeTypes.AUDIO_AAC -> "AAC"
      MimeTypes.AUDIO_FLAC -> "FLAC"
      MimeTypes.AUDIO_OPUS -> "Opus"
      MimeTypes.AUDIO_VORBIS -> "Vorbis"
      MimeTypes.AUDIO_MPEG -> "MP3"
      MimeTypes.AUDIO_RAW -> "PCM"
      else -> when {
        // DTS:X, under the name Media3 now gives it (audio/vnd.dts.uhd).
        f.sampleMimeType?.startsWith("audio/vnd.dts.uhd") == true -> "DTS:X"
        else -> f.sampleMimeType?.substringAfter('/')?.uppercase() ?: "unknown"
      }
    }
    val channels = when (f.channelCount) {
      Format.NO_VALUE -> ""
      1 -> " mono"
      2 -> " stereo"
      6 -> " 5.1"
      8 -> " 7.1"
      else -> ", ${f.channelCount} channels"
    }
    return codec + channels
  }

  /**
   * The sound has opened: what it was and whether it left untouched. A
   * compressed encoding at the output is passed through, unless it is
   * offloaded — then the device's own sound chip decodes it.
   */
  private fun rememberSound(f: Format, config: AudioSink.AudioTrackConfig) {
    val untouched = !config.offload && config.encoding != C.ENCODING_INVALID &&
      !(config.encoding == C.ENCODING_PCM_8BIT || config.encoding == C.ENCODING_PCM_16BIT ||
        config.encoding == C.ENCODING_PCM_24BIT || config.encoding == C.ENCODING_PCM_32BIT ||
        config.encoding == C.ENCODING_PCM_FLOAT)
    Log.i("Kinema", "media3: sound opened: ${soundName(f)}, encoding ${config.encoding}, offload ${config.offload} -> ${if (untouched) "untouched" else "decoded here"}")
    this.untouched = untouched
    keepSound(soundName(f), if (untouched) "untouched" else "decoded")
  }

  /**
   * What became of this film's sound — "untouched", "decoded" or "none" —
   * kept so Settings can say it, after Kinema starts again too. Null
   * forgets it, as a new film opens.
   */
  private fun keepSound(format: String?, way: String?) {
    val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    if (format == null || way == null) prefs.remove(LAST_SOUND)
    else prefs.putString(LAST_SOUND, JSObject().apply { put("format", format); put("way", way) }.toString())
    prefs.apply()
  }

  /** The sound failed: its output would not open, or its decoder would not. */
  private fun isAudioFailure(p: ExoPlayer, error: PlaybackException): Boolean {
    if (error.errorCode == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED ||
      error.errorCode == PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED
    ) return true
    val e = error as? ExoPlaybackException ?: return false
    return e.type == ExoPlaybackException.TYPE_RENDERER &&
      e.rendererIndex in 0 until p.rendererCount &&
      p.getRendererType(e.rendererIndex) == C.TRACK_TYPE_AUDIO
  }

  /**
   * One step down the sound's ways (`audioStep`), from where the film was:
   * a new player on the same surface, the film reopened at the same moment,
   * playing or paused as it was. The page is told, in Kinema's terms.
   */
  private fun fallBack(error: PlaybackException) {
    val old = player ?: return
    val s = surface ?: return
    val media = item ?: return
    val at = old.currentPosition
    // The subtitles chosen stay chosen; the sound is the fallback's to choose.
    val subtitles = old.trackSelectionParameters.overrides.values.filter { it.type == C.TRACK_TYPE_TEXT }
    val f = (error as? ExoPlaybackException)?.rendererFormat
    val format = f?.let { soundName(it) } ?: ""
    audioStep += 1
    untouched = false
    audioDecoder = null
    Log.w("Kinema", "media3: the sound would not play (${error.errorCodeName}, $format); step $audioStep")
    old.release()
    player = null
    val p = buildPlayer(s)
    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
      .apply { subtitles.forEach { addOverride(it) } }
      .build()
    // As it was opened — a share's address, its subtitle files — not
    // from its name.
    p.setMediaItem(media, at)
    p.prepare()
    p.playWhenReady = wantPlaying
    // Said once Media3 has chosen the sound it can play (announceSound),
    // or now, when there is none to choose.
    failedSound = format
    if (audioStep >= 2) announce(2, null)
  }

  /** Once the tracks are chosen after a fallback: which sound plays now, if any. */
  private fun announceSound(tracks: Tracks) {
    if (failedSound == null || audioStep != 1) return
    // Not yet known: Media3 says so again once the file's tracks are read.
    if (tracks.groups.none { it.type == C.TRACK_TYPE_AUDIO }) return
    val group = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_AUDIO && it.isSelected }
    val index = group?.let { g -> (0 until g.length).firstOrNull { g.isTrackSelected(it) } }
    if (group == null || index == null) {
      // Nothing this device can decode: the film goes on without sound.
      announce(2, null)
      return
    }
    val f = group.getTrackFormat(index)
    announce(1, soundName(f))
  }

  private fun announce(step: Int, chosen: String?) {
    val format = failedSound ?: ""
    failedSound = null
    if (step >= 2) keepSound(format.ifEmpty { "unknown" }, "none")
    emit("audio-fallback") {
      put("step", step)
      put("format", format)
      put("chosen", chosen ?: JSONObject.NULL)
    }
  }

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(OpenArgs::class.java)
    main.post {
      try {
        // Each file starts with the sound played as Android says it can.
        if (audioStep != 0) {
          audioStep = 0
          player?.release()
          player = null
          surface?.let { buildPlayer(it) }
        }
        val p = ensurePlayer()
        path = args.path
        suspended = false
        retried = false
        started = false
        seeking = false
        video = null
        videoFormat = null
        timingFile++
        timedFps = null
        timingDone = false
        main.removeCallbacks(timingTimeout)
        failedSound = null
        untouched = false
        loadedSaid = false
        videoDecoder = null
        audioDecoder = null
        keepSound(null, null)
        // The last film's track choices are not this one's: Kinema puts the
        // remembered languages on once its tracks are known (`loaded`).
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().clearOverrides().build()
        val uri = args.url?.let { Uri.parse(it) }
          ?: if (args.path.contains("://")) Uri.parse(args.path) else Uri.fromFile(File(args.path))
        subtitleCount = 0
        val media = MediaItem.Builder()
          .setUri(uri)
          .setSubtitleConfigurations(args.subtitles.map { subtitleConfiguration(it) })
          .build()
        item = media
        subtitleView?.setCues(emptyList())
        val start = args.start
        if (start != null) p.setMediaItem(media, (start * 1000).toLong())
        else p.setMediaItem(media)
        perf.open()
        p.prepare()
        p.playWhenReady = wantPlaying
        lastPosition = -1
        main.removeCallbacks(ticker)
        main.post(ticker)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    main.post {
      main.removeCallbacks(ticker)
      val wasOpen = path != null
      path = null
      player?.release()
      player = null
      perf.detach()
      audioStep = 0
      suspended = false
      video = null
      videoFormat = null
      timingFile++
      main.removeCallbacks(timingTimeout)
      surface?.let { (it.parent as? ViewGroup)?.removeView(it) }
      surface = null
      subtitleView?.let { (it.parent as? ViewGroup)?.removeView(it) }
      subtitleView = null
      item = null
      if (wasOpen) emit("ended") { put("reason", "other") }
      invoke.resolve()
    }
  }

  @Command
  fun setPaused(invoke: Invoke) {
    val args = invoke.parseArgs(PausedArgs::class.java)
    main.post {
      // Said by the listener (onPlayWhenReadyChanged), as for any other cause.
      // Kept for the next file too, as mpv keeps its `pause`. Off the screen
      // nothing starts: the page may still be on its way to "play" (it was
      // matching the screen when Home was pressed), and the film waits,
      // paused, for whoever comes back to it.
      if (suspended && !args.paused) {
        emit("paused") { put("value", true) }
      } else {
        wantPlaying = !args.paused
        player?.playWhenReady = !args.paused
      }
      invoke.resolve()
    }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    main.post {
      val p = player
      if (p == null) {
        invoke.reject("nothing is open")
      } else {
        val target = if (args.relative) p.currentPosition + (args.seconds * 1000).toLong() else (args.seconds * 1000).toLong()
        seeking = true
        p.seekTo(target.coerceAtLeast(0))
        invoke.resolve()
      }
    }
  }

  /** What is open and where it is: path, position, duration, paused, ended, and the sound untouched. */
  @Command
  fun state(invoke: Invoke) {
    main.post {
      val p = player
      invoke.resolve(JSObject().apply {
        put("path", path ?: JSONObject.NULL)
        put("position", p?.let { it.currentPosition / 1000.0 } ?: JSONObject.NULL)
        put("duration", p?.duration?.takeIf { it > 0 }?.let { it / 1000.0 } ?: JSONObject.NULL)
        put("paused", p?.playWhenReady?.not() ?: true)
        put("ended", p?.playbackState == Player.STATE_ENDED)
        put("video", video ?: JSONObject.NULL)
        put("untouched", untouched)
        put("subtitlesShown", subtitlesShown)
      })
    }
  }

  // ---- tracks -----------------------------------------------------------------

  /** One track in Kinema's terms, and where Media3 keeps it. */
  private class Found(val group: Tracks.Group, val index: Int, val kind: String, val id: Int)

  /**
   * The open file's video, audio and subtitle tracks, numbered from 1 within
   * each kind in Media3's order — the numbers `select_track` takes back.
   */
  private fun found(p: ExoPlayer): List<Found> {
    val out = mutableListOf<Found>()
    val count = mutableMapOf<String, Int>()
    for (g in p.currentTracks.groups) {
      val kind = when (g.type) {
        C.TRACK_TYPE_VIDEO -> "video"
        C.TRACK_TYPE_AUDIO -> "audio"
        C.TRACK_TYPE_TEXT -> "sub"
        else -> continue
      }
      for (i in 0 until g.length) {
        val id = (count[kind] ?: 0) + 1
        count[kind] = id
        out.add(Found(g, i, kind, id))
      }
    }
    return out
  }

  /**
   * A format's name as FFmpeg says it — Kinema's vocabulary for formats
   * (engine.ts `Track`). A film's own subtitles are turned into Media3's
   * cues as they are read; what they were is then in `codecs`.
   */
  private fun ffmpegName(f: Format): String? {
    val mime = (if (f.sampleMimeType == MimeTypes.APPLICATION_MEDIA3_CUES) f.codecs else f.sampleMimeType) ?: return null
    if (mime.startsWith("audio/vnd.dts")) return "dts"
    return when (mime) {
      MimeTypes.AUDIO_TRUEHD -> "truehd"
      MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "eac3"
      MimeTypes.AUDIO_AC3 -> "ac3"
      MimeTypes.AUDIO_AC4 -> "ac4"
      MimeTypes.AUDIO_AAC -> "aac"
      MimeTypes.AUDIO_FLAC -> "flac"
      MimeTypes.AUDIO_OPUS -> "opus"
      MimeTypes.AUDIO_VORBIS -> "vorbis"
      MimeTypes.AUDIO_MPEG -> "mp3"
      MimeTypes.AUDIO_MPEG_L2 -> "mp2"
      MimeTypes.AUDIO_ALAC -> "alac"
      MimeTypes.AUDIO_RAW -> "pcm"
      MimeTypes.APPLICATION_SUBRIP -> "subrip"
      MimeTypes.TEXT_SSA -> "ass"
      MimeTypes.TEXT_VTT -> "webvtt"
      MimeTypes.APPLICATION_TTML -> "ttml"
      MimeTypes.APPLICATION_PGS -> "hdmv_pgs_subtitle"
      MimeTypes.APPLICATION_VOBSUB -> "dvd_subtitle"
      MimeTypes.APPLICATION_DVBSUBS -> "dvb_subtitle"
      MimeTypes.APPLICATION_TX3G -> "mov_text"
      MimeTypes.VIDEO_H265, MimeTypes.VIDEO_DOLBY_VISION -> "hevc"
      MimeTypes.VIDEO_H264 -> "h264"
      MimeTypes.VIDEO_AV1 -> "av1"
      MimeTypes.VIDEO_VP9 -> "vp9"
      MimeTypes.VIDEO_MPEG2 -> "mpeg2video"
      MimeTypes.VIDEO_VC1 -> "vc1"
      else -> mime.substringAfter('/')
    }
  }

  /** FFmpeg's profile name, where Media3's format says one: Atmos, the DTS kinds. */
  private fun ffmpegProfile(f: Format): String? = when {
    f.sampleMimeType == MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Digital Plus + Dolby Atmos"
    f.sampleMimeType == MimeTypes.AUDIO_DTS_EXPRESS -> "DTS Express"
    f.sampleMimeType == MimeTypes.AUDIO_DTS_HD -> "DTS-HD"
    f.sampleMimeType?.startsWith("audio/vnd.dts.uhd") == true -> "DTS:X"
    else -> null
  }

  private fun trackObject(t: Found) = JSObject().apply {
    val f = t.group.getTrackFormat(t.index)
    put("id", t.id)
    put("type", t.kind)
    put("title", f.label ?: JSONObject.NULL)
    put("lang", f.language ?: JSONObject.NULL)
    put("codec", ffmpegName(f) ?: JSONObject.NULL)
    put("selected", t.group.isTrackSelected(t.index))
    put("forced", f.selectionFlags and C.SELECTION_FLAG_FORCED != 0)
    put("external", f.id?.contains(EXTERNAL) == true)
    put("default", f.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0)
    if (f.channelCount != Format.NO_VALUE) put("channels", f.channelCount)
    ffmpegProfile(f)?.let { put("profile", it) }
    put("hearingImpaired", f.roleFlags and C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND != 0)
  }

  /** The open file's tracks as engine.ts's `Track`s; none while nothing is open. */
  @Command
  fun tracks(invoke: Invoke) {
    main.post {
      val list = JSArray()
      player?.takeIf { path != null }?.let { p -> found(p).forEach { list.put(trackObject(it)) } }
      invoke.resolve(JSObject().apply { put("tracks", list) })
    }
  }

  /**
   * Play this audio track, or show this subtitle track. Answers once Media3
   * has made the choice (or after `CHOICE_WAIT_MS`), so the tracks read
   * straight after say what is playing.
   */
  @Command
  fun selectTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)
    main.post { choose(args, System.currentTimeMillis() + TRACKS_WAIT_MS, invoke) }
  }

  /**
   * The choice, once the player knows the film's tracks. A sound that would
   * not play builds the player again (`fallBack`), and a choice made from
   * the tracks the old one read can arrive before the new one has read them
   * — the same film, so the same tracks: it waits for them rather than
   * being lost (seen on a box, 2026-10-09: the remembered subtitles did not
   * come on).
   */
  private fun choose(args: TrackArgs, until: Long, invoke: Invoke) {
    val p = player
    val t = p?.let { found(it) }?.firstOrNull { it.kind == args.kind && it.id == args.id }
    when {
      p != null && t == null && p.currentTracks.isEmpty && System.currentTimeMillis() < until ->
        main.postDelayed({ choose(args, until, invoke) }, 50)
      p == null || t == null -> invoke.reject("there is no ${args.kind} track ${args.id}")
      args.kind == "audio" && audioStep >= 2 -> invoke.reject("no sound will play on this device")
      else -> {
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
          .setOverrideForType(TrackSelectionOverride(t.group.mediaTrackGroup, t.index))
          .setTrackTypeDisabled(t.group.type, false)
          .build()
        whenChosen(args.kind, args.id, System.currentTimeMillis() + CHOICE_WAIT_MS, invoke)
      }
    }
  }

  private fun whenChosen(kind: String, id: Int, until: Long, invoke: Invoke) {
    val p = player
    val chosen = p != null && found(p).any { it.kind == kind && it.id == id && it.group.isTrackSelected(it.index) }
    if (chosen || p == null || System.currentTimeMillis() >= until) {
      invoke.resolve()
      return
    }
    main.postDelayed({ whenChosen(kind, id, until, invoke) }, 50)
  }

  /** Show or hide the subtitles, keeping the track chosen. */
  @Command
  fun showSubtitles(invoke: Invoke) {
    val args = invoke.parseArgs(ShowArgs::class.java)
    main.post {
      subtitlesShown = args.visible
      showOrHideSubtitles()
      invoke.resolve()
    }
  }

  /**
   * A subtitle file for the film that is open, chosen and shown — fetched
   * from OpenSubtitles while it plays. Media3 takes a film's subtitle files
   * only as it opens, so the film is opened again with it, at the same
   * moment (owner, 2026-10-05: a short pause), keeping the sound track that
   * was playing. Answers once the new track is chosen.
   */
  @Command
  fun addSubtitle(invoke: Invoke) {
    val args = invoke.parseArgs(SubtitleArg::class.java)
    main.post {
      val p = player
      val media = item
      if (p == null || media == null || suspended) {
        invoke.reject("nothing is open")
        return@post
      }
      val audio = found(p).firstOrNull { it.kind == "audio" && it.group.isTrackSelected(it.index) }?.id
      val added = subtitleConfiguration(args)
      val reopened = media.buildUpon()
        .setSubtitleConfigurations(media.localConfiguration?.subtitleConfigurations.orEmpty() + added)
        .build()
      item = reopened
      val at = p.currentPosition
      p.setMediaItem(reopened, at)
      p.prepare()
      Log.i("Kinema", "media3: reopened at $at ms with a subtitle file added")
      whenAdded(added.id, audio, System.currentTimeMillis() + ADD_WAIT_MS, invoke)
    }
  }

  /**
   * Whether a track is the subtitle file given this id. Media3 puts the
   * number of the file's source in front of it ("1:kinema-file:1").
   */
  private fun isFile(f: Format, id: String?) = id != null && (f.id == id || f.id?.endsWith(":$id") == true)

  /** Once the added file's track is there: chose it (and the sound that was playing) and show it. */
  private fun whenAdded(id: String?, audio: Int?, until: Long, invoke: Invoke) {
    val p = player ?: return invoke.reject("the film was closed")
    val tracks = found(p)
    val sub = tracks.firstOrNull { it.kind == "sub" && isFile(it.group.getTrackFormat(it.index), id) }
    if (sub == null) {
      if (System.currentTimeMillis() >= until) invoke.reject("the subtitle file could not be read")
      else main.postDelayed({ whenAdded(id, audio, until, invoke) }, 100)
      return
    }
    val params = p.trackSelectionParameters.buildUpon()
      .setOverrideForType(TrackSelectionOverride(sub.group.mediaTrackGroup, sub.index))
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
    tracks.firstOrNull { it.kind == "audio" && it.id == audio }?.let {
      params.setOverrideForType(TrackSelectionOverride(it.group.mediaTrackGroup, it.index))
    }
    p.trackSelectionParameters = params.build()
    subtitlesShown = true
    showOrHideSubtitles()
    whenChosen("sub", sub.id, System.currentTimeMillis() + CHOICE_WAIT_MS, invoke)
  }

  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeArgs::class.java)
    main.post {
      volume = args.level
      player?.let { applyVolume(it) }
      invoke.resolve()
    }
  }

  @Command
  fun setMuted(invoke: Invoke) {
    val args = invoke.parseArgs(MutedArgs::class.java)
    main.post {
      muted = args.muted
      player?.let { applyVolume(it) }
      invoke.resolve()
    }
  }

  // ---- the details panel ------------------------------------------------------

  /** What `inHardware` has already answered, by decoder name. */
  private val hardwareDecoders = HashMap<String, Boolean>()

  /**
   * Whether a decoder is the device's own hardware: Android says so from 10
   * on; before, its software decoders are the ones named for Google or
   * Android itself.
   */
  private fun inHardware(name: String): Boolean? {
    if (Build.VERSION.SDK_INT >= 29) {
      // The panel asks every second, and listing every codec is not cheap;
      // a device's decoders do not change while it runs.
      hardwareDecoders[name]?.let { return it }
      val info = MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos.firstOrNull { it.name == name } ?: return null
      hardwareDecoders[name] = info.isHardwareAccelerated
      return info.isHardwareAccelerated
    }
    val lower = name.lowercase()
    return !(lower.startsWith("omx.google.") || lower.startsWith("c2.android."))
  }

  private fun transferName(f: Format): Any = when (f.colorInfo?.colorTransfer) {
    C.COLOR_TRANSFER_ST2084 -> "pq"
    C.COLOR_TRANSFER_HLG -> "hlg"
    C.COLOR_TRANSFER_SDR -> "sdr"
    else -> JSONObject.NULL
  }

  /**
   * What the details panel (`i`) shows where Media3 plays, in Media3's own
   * facts — the decoder it opened, the frames it dropped, what became of the
   * sound — never dressed as mpv's (statsMedia3.ts).
   */
  @Command
  fun facts(invoke: Invoke) {
    main.post {
      val out = JSObject()
      val p = player?.takeIf { path != null }
      if (p != null) {
        p.videoFormat?.let { f ->
          out.put("video", JSObject().apply {
            put("codec", ffmpegName(f) ?: JSONObject.NULL)
            put("described", describe(f))
            put("codecs", f.codecs ?: JSONObject.NULL)
            put("width", f.width)
            put("height", f.height)
            put("fps", frameRate(f) ?: JSONObject.NULL)
            // Worked out from the frames' times rather than stated by the file.
            put("fpsMeasured", f.frameRate <= 0 && timedFps != null)
            put("bitrate", (if (f.bitrate > 0) f.bitrate else f.averageBitrate).takeIf { it > 0 } ?: JSONObject.NULL)
            put("transfer", transferName(f))
            put("dolbyVision", f.sampleMimeType == MimeTypes.VIDEO_DOLBY_VISION)
            put("decoder", videoDecoder ?: JSONObject.NULL)
            put("hardware", videoDecoder?.let { inHardware(it) } ?: JSONObject.NULL)
          })
        }
        p.videoDecoderCounters?.let { c ->
          c.ensureUpdated()
          out.put("frames", JSObject().apply {
            put("rendered", c.renderedOutputBufferCount)
            put("dropped", c.droppedBufferCount)
            put("skipped", c.skippedOutputBufferCount)
          })
        }
        p.audioFormat?.let { f ->
          out.put("audio", JSObject().apply {
            put("name", soundName(f))
            put("channels", f.channelCount.takeIf { it != Format.NO_VALUE } ?: JSONObject.NULL)
            put("sampleRate", f.sampleRate.takeIf { it != Format.NO_VALUE } ?: JSONObject.NULL)
            put("way", if (untouched) "untouched" else "decoded")
            put("decoder", audioDecoder ?: JSONObject.NULL)
          })
        }
        out.put("bufferedSeconds", p.totalBufferedDuration / 1000.0)
        // What playing has cost so far (PerfMeter.kt), for a self-test to read.
        out.put("perf", perf.facts(p))
      }
      // With the HDR kinds Android says it takes: a box that says none turns
      // an HDR film into ordinary colour, whatever the TV could show.
      // And how many modes Android is given: with one, the device decides
      // what the TV gets, which can be more than this mode (the old box
      // sent 3840x2160 while Android was told 1920x1080).
      out.put("screen", modeObject(display().mode).apply {
        put("hdr", hdrKinds())
        put("modes", display().supportedModes.size)
      })
      invoke.resolve(out)
    }
  }

  // ---- the screen ---------------------------------------------------------

  private fun display(): Display =
    if (Build.VERSION.SDK_INT >= 30) activity.display!!
    else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay

  /** A whole number for a rate, as Windows lists them: 23 for 23.976. */
  private fun hzOf(rate: Float) = Math.floor(rate + 0.001).toInt()

  private fun modeObject(m: Display.Mode) = JSObject().apply {
    put("width", m.physicalWidth)
    put("height", m.physicalHeight)
    put("hz", hzOf(m.refreshRate))
    put("rate", m.refreshRate.toDouble())
  }

  /**
   * The screen as `displayMode.ts` reads one: its mode now and every mode
   * Android offers. Many boxes offer only the one they are set to, and then
   * nothing is ever switched. HDR is the system's on Android, so it is not
   * Kinema's to know.
   */
  @Command
  fun screen(invoke: Invoke) {
    main.post {
      val d = display()
      val modes = JSArray()
      for (mode in d.supportedModes) modes.put(modeObject(mode))
      invoke.resolve(modeObject(d.mode).apply {
        put("gdi_name", "display ${d.displayId}")
        put("hdr", "unknown")
        put("modes", modes)
      })
    }
  }

  /** The mode Kinema asked for, so `restoreMode` knows whether there is anything to undo. */
  private var asked = 0

  /**
   * Ask Android for the mode with this size and rate, for Kinema's window,
   * and answer once the screen is in it — or after six seconds, as it is.
   * Android puts the screen back by itself when Kinema is left.
   */
  @Command
  fun setMode(invoke: Invoke) {
    val args = invoke.parseArgs(ModeArgs::class.java)
    main.post {
      val mode = display().supportedModes.firstOrNull {
        it.physicalWidth == args.width && it.physicalHeight == args.height &&
          Math.abs(it.refreshRate - args.rate) < 0.01
      }
      if (mode == null) {
        invoke.reject("no ${args.width}x${args.height} at ${args.rate} Hz on this screen")
        return@post
      }
      whenModeIs(mode.modeId, invoke)
      asked = mode.modeId
      activity.window.attributes = activity.window.attributes.also { it.preferredDisplayModeId = mode.modeId }
    }
  }

  /** Back to the mode the system chose, if Kinema asked for another. */
  @Command
  fun restoreMode(invoke: Invoke) {
    main.post {
      val had = asked != 0
      if (had) {
        asked = 0
        activity.window.attributes = activity.window.attributes.also { it.preferredDisplayModeId = 0 }
      }
      invoke.resolve(JSObject().apply { put("restored", had) })
    }
  }

  /** Answer `invoke` with the screen's mode once it is `modeId`, or after six seconds. */
  private fun whenModeIs(modeId: Int, invoke: Invoke) {
    val manager = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    var done = false
    var listener: DisplayManager.DisplayListener? = null
    val finish = Runnable {
      if (!done) {
        done = true
        listener?.let { manager.unregisterDisplayListener(it) }
        invoke.resolve(modeObject(display().mode))
      }
    }
    listener = object : DisplayManager.DisplayListener {
      override fun onDisplayChanged(displayId: Int) {
        if (display().mode.modeId == modeId) main.post(finish)
      }
      override fun onDisplayAdded(displayId: Int) {}
      override fun onDisplayRemoved(displayId: Int) {}
    }
    manager.registerDisplayListener(listener, main)
    if (display().mode.modeId == modeId) main.post(finish)
    main.postDelayed(finish, 6000)
  }

  // ---- what the TV and the receiver take -------------------------------------

  /**
   * The HDR kinds Android says the screen takes, by Kinema's names. Android's
   * word, not the TV's: an operator's box that read the TV while it was off
   * said none, and drew HDR films in ordinary colour until it was restarted
   * (2026-10-05).
   */
  private fun hdrKinds(): JSArray {
    val hdr = JSArray()
    for (t in display().hdrCapabilities?.supportedHdrTypes ?: IntArray(0)) {
      hdr.put(
        when (t) {
          Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION -> "Dolby Vision"
          Display.HdrCapabilities.HDR_TYPE_HDR10 -> "HDR10"
          Display.HdrCapabilities.HDR_TYPE_HLG -> "HLG"
          4 -> "HDR10+"
          else -> "HDR ($t)"
        }
      )
    }
    return hdr
  }

  /**
   * For Settings → Picture & sound: the HDR kinds the screen shows, the
   * sound formats Android says the HDMI output takes untouched, and what
   * the last film's sound did (`rememberSound`).
   *
   * Android's own surround setting (`encoded_surround_output`) is not read:
   * on an operator's box it said "never" one night and "always" the next
   * while the box's own menu decided (2026-10-04), so it proved nothing.
   */
  @Command
  fun output(invoke: Invoke) {
    main.post {
      val hdr = hdrKinds()
      val caps = AudioCapabilities.getCapabilities(activity)
      val sound = JSArray()
      for ((name, encoding) in listOf(
        "Dolby Digital" to C.ENCODING_AC3,
        "Dolby Digital Plus" to C.ENCODING_E_AC3,
        "Dolby Atmos in Dolby Digital Plus" to C.ENCODING_E_AC3_JOC,
        "Dolby TrueHD" to C.ENCODING_DOLBY_TRUEHD,
        "DTS" to C.ENCODING_DTS,
        "DTS-HD" to C.ENCODING_DTS_HD,
      )) if (caps.supportsEncoding(encoding)) sound.put(name)
      val last = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LAST_SOUND, null)
        ?.let { try { JSObject(it) } catch (e: Exception) { null } }
      invoke.resolve(JSObject().apply {
        put("hdr", hdr)
        put("sound", sound)
        put("modes", display().supportedModes.size)
        put("lastSound", last ?: JSONObject.NULL)
      })
    }
  }
}
