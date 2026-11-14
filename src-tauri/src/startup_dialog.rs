//! The few things Kinema must say before its window exists: a restore's
//! outcome, a library that will not open, a start that failed.
//!
//! They are said on the main thread, inside `setup`, and wait for an answer. On
//! Linux the dialog plugin cannot do that: its dialog is drawn by the GTK loop
//! that this very thread runs, which is blocked waiting for it, so nothing ever
//! appears and Kinema hangs with no window (seen under a headless X server,
//! 2026-11). There a GTK dialog is run directly; `run` turns the loop itself.
//! Elsewhere the plugin's own dialog waits in its own loop.

/// How a message looks.
#[derive(Clone, Copy)]
pub enum Kind {
    Info,
    Warning,
    Error,
}

/// Whether anything was said this start.
static SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether a dialog was shown during this start. On Linux the GTK loop a dialog
/// turns also runs the page, which then starts before the library is open and
/// shows the errors of every call it made (seen on the Linux test PC,
/// 2026-11-08); on Android the page stayed black. `setup` starts the page again
/// when this is true.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn any_shown() -> bool {
    SHOWN.load(std::sync::atomic::Ordering::Relaxed)
}

/// Where the page is parked while a start that cannot go on is explained.
const HELD_PAGE: &str = "about:blank";

/// Park the page on a blank one. For a start that is about to end: the
/// library is not open, nothing is managed, and a page that loaded while the
/// dialog's loop ran would call commands that panic for want of state.
pub fn hold_page(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = HELD_PAGE.parse() {
            if let Err(e) = window.navigate(url) {
                crate::log!("window: could not hold the page: {e}");
            }
        }
    }
}

/// Say something, and wait until it has been read.
pub fn tell(app: &tauri::AppHandle, title: &str, message: &str, kind: Kind) {
    ask(app, title, message, kind, "OK", None);
}

/// Ask, with `ok` and, if given, `cancel` as the buttons. True for `ok`; closing
/// the dialog any other way is `cancel`.
pub fn ask(
    app: &tauri::AppHandle,
    title: &str,
    message: &str,
    kind: Kind,
    ok: &str,
    cancel: Option<&str>,
) -> bool {
    SHOWN.store(true, std::sync::atomic::Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        gtk_dialog(title, message, kind, ok, cancel)
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let kind = match kind {
            Kind::Info => MessageDialogKind::Info,
            Kind::Warning => MessageDialogKind::Warning,
            Kind::Error => MessageDialogKind::Error,
        };
        let dialog = app.dialog().message(message).title(title).kind(kind);
        let dialog = match cancel {
            Some(cancel) => {
                dialog.buttons(MessageDialogButtons::OkCancelCustom(ok.to_string(), cancel.to_string()))
            }
            None => dialog,
        };
        dialog.blocking_show()
    }
}

#[cfg(target_os = "linux")]
fn gtk_dialog(title: &str, message: &str, kind: Kind, ok: &str, cancel: Option<&str>) -> bool {
    use gtk::prelude::*;
    let message_type = match kind {
        Kind::Info => gtk::MessageType::Info,
        Kind::Warning => gtk::MessageType::Warning,
        Kind::Error => gtk::MessageType::Error,
    };
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        message_type,
        gtk::ButtonsType::None,
        title,
    );
    dialog.set_title("Kinema");
    dialog.set_secondary_text(Some(message));
    if let Some(cancel) = cancel {
        dialog.add_button(cancel, gtk::ResponseType::Reject);
    }
    dialog.add_button(ok, gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);
    let answer = dialog.run();
    dialog.close();
    // Let it leave the screen before whatever comes next.
    while gtk::events_pending() {
        gtk::main_iteration();
    }
    answer == gtk::ResponseType::Accept
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_held_page_is_a_url() {
        assert!(super::HELD_PAGE.parse::<tauri::Url>().is_ok());
    }
}
