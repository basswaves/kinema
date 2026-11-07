package com.kinema.app

import android.content.Context
import android.content.Intent
import android.os.Process
import android.util.Log
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File

/**
 * The WebView's process ended. Android's rule: a client that does not answer
 * has the whole app killed with it, and one that does must throw that WebView
 * away, which Tauri cannot do while running. So Kinema starts anew, with a note
 * for the new page to say what happened (`page_life.rs`, the same file). Called
 * from `RustWebViewClient`, into which `src-tauri/.cargo/config.toml` adds the
 * call: that class is generated, and nothing can subclass it.
 *
 * A note still there means the last new Kinema never got as far as reading it.
 * Then starting yet another would only go round in circles, and it just ends.
 */
object PageGone {
  fun handle(view: WebView, crashed: Boolean): Boolean {
    val context = view.context
    val note = File(context.dataDir, "page-ended.txt")
    val first = !note.exists()
    Log.e("Kinema", "the page's process ended (crashed: $crashed)")
    runCatching { note.writeText("ended") }
    if (first && onScreen()) restart(context)
    Process.killProcess(Process.myPid())
    return true
  }

  private fun onScreen() =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  private fun restart(context: Context) {
    val packages = context.packageManager
    val intent = packages.getLeanbackLaunchIntentForPackage(context.packageName)
      ?: packages.getLaunchIntentForPackage(context.packageName)
      ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    context.startActivity(intent)
  }
}
