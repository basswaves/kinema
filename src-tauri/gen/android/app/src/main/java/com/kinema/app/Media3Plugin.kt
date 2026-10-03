package com.kinema.app

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
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
  private val main = Handler(Looper.getMainLooper())

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
    val p = ExoPlayer.Builder(activity).build()
    p.setVideoSurfaceView(s)
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

      override fun onPlayerError(error: PlaybackException) {
        emit("ended") {
          put("reason", "error")
          put("detail", error.errorCodeName + (error.message?.let { ": $it" } ?: ""))
        }
      }
    })
    player = p
    return p
  }

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(OpenArgs::class.java)
    main.post {
      try {
        val p = ensurePlayer()
        path = args.path
        started = false
        seeking = false
        val uri = if (args.path.contains("://")) Uri.parse(args.path) else Uri.fromFile(File(args.path))
        val start = args.start
        if (start != null) p.setMediaItem(MediaItem.fromUri(uri), (start * 1000).toLong())
        else p.setMediaItem(MediaItem.fromUri(uri))
        p.prepare()
        p.playWhenReady = true
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
      player?.playWhenReady = !args.paused
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
      })
    }
  }
}
