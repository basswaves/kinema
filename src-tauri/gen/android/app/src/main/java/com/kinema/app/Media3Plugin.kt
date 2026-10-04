package com.kinema.app

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.util.EventLogger
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
  /** Seconds to start at, or null for the beginning. */
  var start: Double? = null
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
 *    and failing that the film plays without it — never not at all.
 */
@TauriPlugin
class Media3Plugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var surface: SurfaceView? = null
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
  /** The film's picture, once Media3 has chosen its video track. */
  private var video: JSObject? = null
  /** The sound that would not play, to be named once the next way is known. */
  private var failedSound: String? = null
  private val main = Handler(Looper.getMainLooper())

  /**
   * Kinema left the screen (Home, the box asleep, another app in front)
   * with a film open: it was paused and its decoder handed back, and is
   * opened again, paused at the same moment, when Kinema returns. A box may
   * have one video decoder, and the app in front is owed it — as every
   * other player does it.
   */
  private var suspended = false

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

  /** The position, a few times a second while something is open: Media3 has no event for it. */
  private val ticker = object : Runnable {
    override fun run() {
      val p = player ?: return
      emit("position") { put("value", p.currentPosition / 1000.0) }
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
    return buildPlayer(s)
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
  }

  private fun buildPlayer(s: SurfaceView): ExoPlayer {
    val selector = DefaultTrackSelector(activity)
    // Past step 0, a sound track Media3 cannot play here is not chosen at
    // all; another one that it can play is, if the film has one.
    if (audioStep > 0) selector.setParameters(selector.buildUponParameters().setExceedRendererCapabilitiesIfNecessary(false))
    val p = ExoPlayer.Builder(activity, renderers(audioStep)).setTrackSelector(selector).build()
    // Media3's own account of what it chose and did (decoder, sound path,
    // dropped frames, stalls), in the system log of a test build only.
    if (BuildConfig.DEBUG) p.addAnalyticsListener(EventLogger("KinemaEvents"))
    p.setVideoSurfaceView(s)
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

      override fun onRenderedFirstFrame() {
        // Media3 says this again after every seek; only the first one is the start.
        if (!started) {
          started = true
          emit("restarted")
        }
      }

      override fun onTracksChanged(tracks: Tracks) {
        announceSound(tracks)
        val group = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_VIDEO && it.isSelected } ?: return
        val index = (0 until group.length).firstOrNull { group.isTrackSelected(it) } ?: return
        val f = group.getTrackFormat(index)
        val transfer = f.colorInfo?.colorTransfer
        video = JSObject().apply {
          put("width", f.width)
          put("height", f.height)
          put("fps", if (f.frameRate > 0) f.frameRate.toDouble() else JSONObject.NULL)
          put("hdr", transfer == C.COLOR_TRANSFER_ST2084 || transfer == C.COLOR_TRANSFER_HLG)
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        if (audioStep < 2 && isAudioFailure(p, error)) {
          fallBack(error)
          return
        }
        emit("ended") {
          put("reason", "error")
          put("detail", error.errorCodeName + (error.message?.let { ": $it" } ?: ""))
        }
      }
    })
    player = p
    return p
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
    val file = path ?: return
    val at = old.currentPosition
    val f = (error as? ExoPlaybackException)?.rendererFormat
    val format = f?.label ?: f?.sampleMimeType ?: ""
    audioStep += 1
    Log.w("Kinema", "media3: the sound would not play (${error.errorCodeName}, $format); step $audioStep")
    old.release()
    player = null
    val p = buildPlayer(s)
    val uri = if (file.contains("://")) Uri.parse(file) else Uri.fromFile(File(file))
    p.setMediaItem(MediaItem.fromUri(uri), at)
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
    announce(1, f.label ?: f.sampleMimeType)
  }

  private fun announce(step: Int, chosen: String?) {
    val format = failedSound ?: ""
    failedSound = null
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
        started = false
        seeking = false
        video = null
        failedSound = null
        val uri = if (args.path.contains("://")) Uri.parse(args.path) else Uri.fromFile(File(args.path))
        val start = args.start
        if (start != null) p.setMediaItem(MediaItem.fromUri(uri), (start * 1000).toLong())
        else p.setMediaItem(MediaItem.fromUri(uri))
        p.prepare()
        p.playWhenReady = wantPlaying
        emit("loaded")
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
      audioStep = 0
      suspended = false
      video = null
      surface?.let { (it.parent as? ViewGroup)?.removeView(it) }
      surface = null
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

  /** What is open and where it is: path, position, duration, paused, ended. */
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
      })
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
   * For Settings → Picture & sound: the HDR kinds the screen shows, the
   * sound formats Android says the HDMI output takes untouched, and the
   * system's own surround setting (`encoded_surround_output`: 0 automatic,
   * 1 never, 2 always, 3 manual; missing on some boxes).
   */
  @Command
  fun output(invoke: Invoke) {
    main.post {
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
      val surround = try {
        Settings.Global.getInt(activity.contentResolver, "encoded_surround_output")
      } catch (e: Settings.SettingNotFoundException) {
        -1
      }
      invoke.resolve(JSObject().apply {
        put("hdr", hdr)
        put("sound", sound)
        put("surround", when (surround) { 0 -> "auto"; 1 -> "never"; 2 -> "always"; 3 -> "manual"; else -> JSONObject.NULL })
        put("modes", display().supportedModes.size)
      })
    }
  }
}
