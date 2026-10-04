package com.kinema.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import android.os.storage.StorageVolume
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The drives Android has mounted, and the permission to read them, for
 * Kinema's own folder browser (`src/ui/FolderBrowser.tsx`, `places.rs`).
 *
 * Android's own folder picker is missing on many TV boxes, and where it is
 * there it answers with an address in Android's document system, not a folder
 * the library can read by path. So Kinema lists the drives itself, here, and
 * reads them by path, as on every other system. Nothing is written to them.
 *
 * Reading by path needs a permission, which differs by Android version:
 *  - up to Android 12, "files" (READ_EXTERNAL_STORAGE) — every file;
 *  - from Android 13, "videos" (READ_MEDIA_VIDEO) — the films, but not the
 *    subtitles, .nfo files and the rest beside them: Android 11 and later
 *    show an app only the kind of media it asked for;
 *  - from Android 11, "All files access", which brings those back. It is
 *    granted in the system's settings, not in a dialog, and some TV boxes
 *    have no such screen; Kinema plays the films without it (owner,
 *    2026-10-04).
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "files"),
    Permission(strings = [Manifest.permission.READ_MEDIA_VIDEO], alias = "videos"),
  ]
)
class StoragePlugin(private val activity: Activity) : Plugin(activity) {

  /** The permission this Android version reads films by. */
  private val readPermission: String
    get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO
    else Manifest.permission.READ_EXTERNAL_STORAGE

  private val readAlias: String
    get() = if (Build.VERSION.SDK_INT >= 33) "videos" else "files"

  private fun allFilesGranted(): Boolean =
    Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()

  /** The settings screen that grants All files access, where this box has one. */
  private fun allFilesScreen(): Intent? {
    if (Build.VERSION.SDK_INT < 30) return null
    val pm = activity.packageManager
    val forKinema = Intent(
      Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
      Uri.parse("package:${activity.packageName}"),
    )
    if (forKinema.resolveActivity(pm) != null) return forKinema
    val list = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
    return if (list.resolveActivity(pm) != null) list else null
  }

  /**
   * What Kinema may read now. `read`: granted, or prompt (not yet, or
   * refused — Android does not say which). `allFiles`: granted, off (the
   * screen exists), unavailable (no screen on this box), or not-needed
   * (Android 10 and older, where `read` covers every file).
   */
  private fun accessState(): JSObject {
    val read = allFilesGranted() ||
      ContextCompat.checkSelfPermission(activity, readPermission) == PackageManager.PERMISSION_GRANTED
    val allFiles = when {
      Build.VERSION.SDK_INT < 30 -> "not-needed"
      allFilesGranted() -> "granted"
      allFilesScreen() != null -> "off"
      else -> "unavailable"
    }
    return JSObject().apply {
      put("read", if (read) "granted" else "prompt")
      put("allFiles", allFiles)
    }
  }

  /** The folder a volume is mounted at, or null if Android will not say. */
  private fun folderOf(volume: StorageVolume): String? {
    if (Build.VERSION.SDK_INT >= 30) return volume.directory?.path
    // Before Android 11 the path is only on a hidden method, which every
    // version from 7 to 10 has.
    return try {
      StorageVolume::class.java.getMethod("getPath").invoke(volume) as? String
    } catch (e: Exception) {
      null
    }
  }

  /** Each mounted drive: its folder, Android's name for it, and whether it can be unplugged. */
  @Command
  fun places(invoke: Invoke) {
    val storage = activity.getSystemService(Context.STORAGE_SERVICE) as StorageManager
    val list = JSArray()
    for (volume in storage.storageVolumes) {
      val state = volume.state
      if (state != Environment.MEDIA_MOUNTED && state != Environment.MEDIA_MOUNTED_READ_ONLY) continue
      val folder = folderOf(volume) ?: continue
      list.put(JSObject().apply {
        put("path", folder)
        put("name", volume.getDescription(activity))
        put("removable", volume.isRemovable)
      })
    }
    invoke.resolve(JSObject().apply { put("places", list) })
  }

  @Command
  fun access(invoke: Invoke) {
    invoke.resolve(accessState())
  }

  /** Android's own question, asked once; answers with the state afterwards. */
  @Command
  fun requestAccess(invoke: Invoke) {
    if (accessState().getString("read") == "granted") {
      invoke.resolve(accessState())
      return
    }
    requestPermissionForAlias(readAlias, invoke, "accessAnswered")
  }

  @PermissionCallback
  private fun accessAnswered(invoke: Invoke) {
    invoke.resolve(accessState())
  }

  /** Opens the system's All files access screen; answers when the person comes back. */
  @Command
  fun allowAllFiles(invoke: Invoke) {
    val screen = allFilesScreen()
    if (screen == null) {
      invoke.reject("This device has no All files access setting.")
      return
    }
    try {
      startActivityForResult(invoke, screen, "allFilesAnswered")
    } catch (e: ActivityNotFoundException) {
      invoke.reject("This device has no All files access setting.")
    }
  }

  @ActivityCallback
  private fun allFilesAnswered(invoke: Invoke, result: ActivityResult) {
    invoke.resolve(accessState())
  }
}
