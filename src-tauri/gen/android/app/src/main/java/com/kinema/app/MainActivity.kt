package com.kinema.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
