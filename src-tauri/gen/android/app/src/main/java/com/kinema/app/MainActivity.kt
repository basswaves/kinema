package com.kinema.app

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ProcessLifecycleOwner

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Tauri defines the observer that tells plugins Kinema left the screen
    // or came back (onStop, onResume), and never registers it (2.11), so
    // the player kept playing behind the home screen. Adding it twice is
    // harmless if a later Tauri does it too.
    ProcessLifecycleOwner.get().lifecycle.addObserver(TauriLifecycleObserver)
  }

  // The remote's OK, sent on as Enter. On a text field Android's WebView
  // keeps OK for itself, to bring up the system's keyboard — which a field
  // holding it back until asked (src/ui/typing.ts) then never did — so the
  // page never heard it. Everywhere else the page hears OK as Enter anyway.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode != KeyEvent.KEYCODE_DPAD_CENTER) return super.dispatchKeyEvent(event)
    return super.dispatchKeyEvent(
      KeyEvent(
        event.downTime, event.eventTime, event.action, KeyEvent.KEYCODE_ENTER, event.repeatCount,
        event.metaState, event.deviceId, event.scanCode, event.flags, event.source
      )
    )
  }

  // The page takes the remote's keys from the first press. Android gives the
  // WebView focus only once an arrow key has gone looking for something to
  // focus, so until then OK did nothing at all.
  override fun onWebViewCreate(webView: WebView) {
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.post { webView.requestFocus() }
  }
}
