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

/// Whether mpv is running. The plugin's own `init` says nothing about that, and
/// a new page has to know (`startMpv` in engine.ts).
#[tauri::command]
#[cfg(desktop)]
pub fn mpv_started(app: tauri::AppHandle) -> bool {
    use tauri_plugin_libmpv::MpvExt;
    app.mpv().instances.lock().map(|i| i.contains_key("main")).unwrap_or(false)
}

/// Android has no mpv.
#[tauri::command]
#[cfg(mobile)]
pub fn mpv_started() -> bool {
    false
}

/// End mpv until the next film, for the memory it holds on to after one
/// (`giveBackEngineSoon` in engine.ts). Linux's allocator keeps what was freed
/// for the program's own later use unless told otherwise.
#[tauri::command]
#[cfg(desktop)]
pub async fn mpv_give_back(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_libmpv::MpvExt;
    crate::jobs::off_main(move || {
        app.mpv().destroy("main").map_err(|e| e.to_string())?;
        // SAFETY: takes a plain number and touches only the allocator's free lists.
        #[cfg(target_os = "linux")]
        unsafe {
            libc::malloc_trim(0);
        }
        Ok(())
    })
    .await
}

/// Android has no mpv.
#[tauri::command]
#[cfg(mobile)]
pub fn mpv_give_back() {}

/// Shut the engine down before the process ends. The plugin does that only
/// when a window's close button is used; Leave, the power actions and a
/// self-test all end with `app.exit`, and left mpv's video thread drawing
/// while the graphics driver was unloaded under it — a crash on every such
/// exit on Linux.
pub fn shut_down<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(desktop)]
    {
        use tauri_plugin_libmpv::MpvExt;
        // mpv's demuxer thread can sit in a read() on a share that has gone
        // silent, and destroy waits for it: the process stayed alive after
        // quit (A5-01). Wait a short while, then go on and leave it.
        let handle = app.clone();
        match within(EXIT_WAIT, move || handle.mpv().destroy("main").map_err(|e| e.to_string())) {
            Some(Ok(())) => {}
            Some(Err(e)) => crate::log!("mpv: could not shut down on exit: {e}"),
            None => crate::log!(
                "mpv: did not shut down within {} s (the film's drive is not answering?); leaving it",
                EXIT_WAIT.as_secs()
            ),
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

/// How long quitting waits on the film's drive or on mpv before leaving them.
#[cfg_attr(mobile, allow(dead_code))]
pub const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The longest the whole exit may take once it has begun; then the process
/// ends whatever is still waiting (a window close the plugin handles itself,
/// a file look on a dead mount).
const EXIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run `f` on its own thread and wait at most `limit` for its answer. `None`
/// if it has not finished: the thread is left behind, to end with the process.
#[cfg_attr(mobile, allow(dead_code))]
pub fn within<T: Send + 'static>(
    limit: std::time::Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit).ok()
}

/// Once the app has begun to quit, end the process after `EXIT_LIMIT` whatever
/// is still waiting. The library saves on its own as each change is made, so
/// nothing of Kinema's own is lost by this; only a wait on a drive is cut.
pub fn arm_exit_limit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    static ARMED: std::sync::Once = std::sync::Once::new();
    ARMED.call_once(|| {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(EXIT_LIMIT);
            crate::log!(
                "exit: still running {} s after quit began; ending the process",
                EXIT_LIMIT.as_secs()
            );
            // A thread stuck on a dead mount keeps even an ended process
            // listed, holding the single-instance name: the next start then
            // waits on it for good (Linux test PC). Give the name back first.
            #[cfg(desktop)]
            within(std::time::Duration::from_secs(1), move || {
                tauri_plugin_single_instance::destroy(&app)
            });
            #[cfg(mobile)]
            let _ = app;
            hard_exit();
        });
    });
}

/// End the process at once, without the exit-time clean-up: `process::exit`
/// runs that clean-up, and on the Linux test PC it waited on the dead mount
/// too (the limit fired, the process stayed). Nothing of Kinema's own is
/// pending here: the library writes each change as it is made.
fn hard_exit() -> ! {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    // SAFETY: `_exit` takes a plain status and never returns.
    unsafe {
        libc::_exit(0)
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        // SAFETY: the pseudo-handle of this process; on success it does not return.
        let _ = unsafe { TerminateProcess(GetCurrentProcess(), 0) };
        std::process::exit(0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
    std::process::exit(0)
}

#[cfg(test)]
mod exit_tests {
    use super::within;
    use std::time::{Duration, Instant};

    #[test]
    fn a_quick_job_gives_its_answer() {
        assert_eq!(within(Duration::from_secs(2), || 7), Some(7));
    }

    #[test]
    fn a_stuck_job_is_left_after_the_limit() {
        let start = Instant::now();
        let r = within(Duration::from_millis(200), || {
            std::thread::sleep(Duration::from_secs(30));
        });
        assert!(r.is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
