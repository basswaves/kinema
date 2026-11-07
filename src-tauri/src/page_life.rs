//! The page's process ending while Kinema goes on.
//!
//! The whole interface lives in one process of the system's web engine:
//! WebKitWebProcess, WebView2's renderer, Android's WebView renderer. When that
//! process ends — the kernel killed it short of memory, it crashed — nothing
//! tells the page, because the page is gone. Left alone, Kinema stayed running
//! with the last picture on the window, as if frozen, for as long as anyone
//! cared to wait. So each system's own signal is heard here, the page is started
//! again, and the new page says what happened (`page_recovery`,
//! `src/player/pageRecovery.ts`).
//!
//! What was seen on what stands in docs/GOTCHAS.md. The player is not in that
//! process: on a computer a film goes on playing meanwhile.
//!
//! A marker file carries the news to the new page, whichever way it is started:
//! a reload here; a new Kinema where the web engine cannot be brought back
//! without one (WebView2's browser process; Android, by `PageGone.kt`, which
//! writes the same file).

use std::path::PathBuf;

/// In the data folder; holds why, as one word of `PageEnded`'s.
const MARKER: &str = "page-ended.txt";

/// Why the page ended, as far as the system says.
#[derive(Clone, Copy, PartialEq, Debug)]
#[allow(dead_code)] // Only WebKit tells the two apart; Android has no use for it.
pub enum Why {
    /// The web engine says it went over a memory limit of its own.
    Memory,
    /// It ended by itself. The kernel's out-of-memory killer looks like this too.
    Ended,
}

impl Why {
    #[cfg_attr(not(desktop), allow(dead_code))]
    fn word(self) -> &'static str {
        match self {
            Why::Memory => "memory",
            Why::Ended => "ended",
        }
    }
}

/// Where the marker is. On Android the Kotlin side writes it into the app's
/// own folder, which is also what a plain `app_data_dir` says.
fn marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    #[cfg(desktop)]
    let dir = crate::data_dir(app).ok()?;
    #[cfg(mobile)]
    let dir = {
        use tauri::Manager;
        app.path().app_data_dir().ok()?
    };
    Some(dir.join(MARKER))
}

/// Why the last page ended, once, for the new page to say. `None` on an
/// ordinary start.
#[tauri::command]
pub fn page_recovery(app: tauri::AppHandle) -> Option<String> {
    let path = marker(&app)?;
    let why = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let why = why.trim().to_string();
    crate::log!("page: started again after the last one ended ({why})");
    Some(why)
}

#[cfg(desktop)]
pub use desktop::watch;

#[cfg(desktop)]
mod desktop {
    use super::{marker, Why};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    /// More than this many endings in `TOO_OFTEN` and reloading is doing harm:
    /// on a computer out of memory, each new page is one more round of the whole
    /// machine crawling. Kinema says so and closes.
    const TRIES: usize = 3;
    const TOO_OFTEN: Duration = Duration::from_secs(300);

    /// When the page last ended.
    static ENDINGS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

    /// Whether to try again, by what `ENDINGS` holds after this one.
    fn try_again(endings: &mut Vec<Instant>, now: Instant) -> bool {
        endings.retain(|t| now.duration_since(*t) < TOO_OFTEN);
        endings.push(now);
        endings.len() <= TRIES
    }

    /// The page has ended: note it, and say whether it should be started again.
    /// When not, this has already begun closing Kinema.
    pub(super) fn ended(app: &tauri::AppHandle, why: Why, what: &str) -> bool {
        crate::log!("page: {what}");
        if let Some(path) = marker(app) {
            if let Err(e) = std::fs::write(&path, why.word()) {
                crate::log!("page: could not leave a note for the next page: {e}");
            }
        }
        let again = match ENDINGS.lock() {
            Ok(mut endings) => try_again(&mut endings, Instant::now()),
            Err(_) => true,
        };
        if !again {
            crate::log!("page: ended {TRIES} times in {} s; closing", TOO_OFTEN.as_secs());
            let app = app.clone();
            std::thread::spawn(move || {
                app.dialog()
                    .message(
                        "The part of Kinema that draws its window keeps stopping, so Kinema \
                         will close now. This computer may be short of memory; closing other \
                         programs can help.",
                    )
                    .title("Kinema has to close")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                app.exit(1);
            });
        }
        again
    }

    /// Listen to the web engine for as long as the window lasts. A failure costs
    /// this safety net only, and says so in app.log.
    pub fn watch(app: &tauri::AppHandle) {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else { return };
        if let Err(e) = super::platform::listen(&window) {
            crate::log!("page: cannot hear the web engine: {e}");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_fourth_ending_in_five_minutes_stops_the_tries_and_old_ones_do_not_count() {
            let start = Instant::now();
            let mut endings = Vec::new();
            assert!(try_again(&mut endings, start));
            assert!(try_again(&mut endings, start + Duration::from_secs(10)));
            assert!(try_again(&mut endings, start + Duration::from_secs(20)));
            assert!(!try_again(&mut endings, start + Duration::from_secs(30)));
            let later = start + Duration::from_secs(1000);
            assert!(try_again(&mut endings, later));
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{desktop::ended, Why};
    use tauri::Manager;
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    pub fn listen(window: &tauri::WebviewWindow) -> Result<(), String> {
        let app = window.app_handle().clone();
        window
            .with_webview(move |webview| {
                let view = webview.inner();
                view.connect_web_process_terminated(move |view, reason| {
                    let why = match reason {
                        WebProcessTerminationReason::ExceededMemoryLimit => Why::Memory,
                        _ => Why::Ended,
                    };
                    if ended(&app, why, &format!("the web process ended: {reason:?}; starting the page again")) {
                        view.reload();
                    }
                });
                // No action: a line in the log for the next freeze report.
                view.connect_is_web_process_responsive_notify(|view| {
                    let answers = view.is_web_process_responsive();
                    crate::log!("page: the web process {}", if answers { "answers again" } else { "stopped answering" });
                });
            })
            .map_err(crate::util::to_string_err)
    }
}

#[cfg(windows)]
mod platform {
    use super::{desktop::ended, marker, Why};
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;

    /// What to do about one kind of failure.
    enum Then {
        Nothing,
        Reload,
        NewKinema,
    }

    fn what_to_do(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> (&'static str, Then) {
        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
                ("the page's process ended; starting the page again", Then::Reload)
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                ("WebView2's browser process ended; starting Kinema again", Then::NewKinema)
            }
            // The next two are not the end of the page: WebView2 says the first
            // may pass, and brings its graphics process back by itself. In the
            // log for the next freeze report.
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                ("the page's process stopped answering", Then::Nothing)
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => {
                ("WebView2's graphics process ended; it comes back by itself", Then::Nothing)
            }
            _ => ("another WebView2 process ended", Then::Nothing),
        }
    }

    pub fn listen(window: &tauri::WebviewWindow) -> Result<(), String> {
        let app = window.app_handle().clone();
        let again = window.clone();
        window
            .with_webview(move |webview| {
                let hear = move || -> windows::core::Result<()> {
                    // SAFETY: on the main thread, where the WebView2 lives.
                    unsafe {
                        let core = webview.controller().CoreWebView2()?;
                        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
                            if let Some(args) = args {
                                args.ProcessFailedKind(&mut kind)?;
                            }
                            let (what, then) = what_to_do(kind);
                            match then {
                                Then::Nothing => crate::log!("page: {what}"),
                                Then::Reload => {
                                    if ended(&app, Why::Ended, what) {
                                        reload_soon(again.clone());
                                    }
                                }
                                Then::NewKinema => {
                                    if ended(&app, Why::Ended, what) {
                                        app.restart();
                                    } else if let Some(path) = marker(&app) {
                                        let _ = std::fs::remove_file(path);
                                    }
                                }
                            }
                            Ok(())
                        }));
                        let mut token = 0;
                        core.add_ProcessFailed(&handler, &mut token)
                    }
                };
                if let Err(e) = hear() {
                    crate::log!("page: cannot hear WebView2: {e}");
                }
            })
            .map_err(crate::util::to_string_err)
    }

    /// Outside the event: Microsoft's sample also leaves its handler before
    /// reloading. `with_webview` from another thread comes back on the main one.
    fn reload_soon(window: tauri::WebviewWindow) {
        std::thread::spawn(move || {
            let _ = window.with_webview(|webview| {
                // SAFETY: on the main thread, where the WebView2 lives.
                let reloaded = unsafe { webview.controller().CoreWebView2().and_then(|core| core.Reload()) };
                if let Err(e) = reloaded {
                    crate::log!("page: could not start the page again: {e}");
                }
            });
        });
    }
}
