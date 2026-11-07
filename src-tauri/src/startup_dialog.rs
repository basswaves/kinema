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
