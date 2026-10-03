//! The player engine's native side: which engine this build has, how it is
//! started with the app, and how it is shut down at the end.
//!
//! The interface's half of the seam is `src/player/engine.ts`. On Windows and
//! Linux the engine is mpv, through `tauri-plugin-libmpv`. That plugin has no
//! Android side; there the engine is Media3, in Kotlin
//! (`gen/android/…/Media3Plugin.kt`), which the page reaches directly — every
//! `plugin:media3|…` call is handed to it — so this side only registers it.

/// The engine's name, for the capabilities: the interface offers playing only
/// where there is one.
#[cfg(desktop)]
pub const NAME: &str = "mpv";
#[cfg(mobile)]
pub const NAME: &str = "media3";

/// The engine's plugin, added to the app before it starts.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(desktop)]
    return builder.plugin(tauri_plugin_libmpv::init());
    #[cfg(mobile)]
    builder.plugin(media3())
}

/// The Kotlin player, registered under the name the page calls it by.
#[cfg(mobile)]
fn media3<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("media3")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("com.kinema.app", "Media3Plugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

/// Shut the engine down before the process ends. The plugin does that only
/// when a window's close button is used; Leave, the power actions and a
/// self-test all end with `app.exit`, and left mpv's video thread drawing
/// while the graphics driver was unloaded under it — a crash on every such
/// exit on Linux.
pub fn shut_down<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(desktop)]
    {
        use tauri_plugin_libmpv::MpvExt;
        if let Err(e) = app.mpv().destroy("main") {
            crate::log!("mpv: could not shut down on exit: {e}");
        }
    }
    #[cfg(mobile)]
    let _ = app;
}
