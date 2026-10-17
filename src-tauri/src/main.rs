// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The installer's uninstaller, before it deletes the program. Handled here,
    // ahead of everything: a running Kinema must not be handed this as a file.
    if std::env::args_os().nth(1).is_some_and(|a| a == "--uninstall-cleanup") {
        kinema_lib::uninstall_cleanup();
        return;
    }
    kinema_lib::run()
}
