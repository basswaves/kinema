mod analyse;
mod applog;
mod artwork;
mod db;
mod detect;
mod ffmpeg;
mod introdb;
mod library;
mod metadata;
mod nfo;
mod playback;
mod scanner;
mod settings;
mod skip;
mod skiptro;
mod trailer;

use library::{Db, ScanDb};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Open the library, or say what went wrong in a sentence a user can act on.
///
/// Split out of `setup` so every failure has somewhere to be *reported* rather
/// than propagated. The three things that can go wrong here — no app data
/// directory, a directory that cannot be written to, a database that is corrupt
/// or from a newer build — are all conditions a person can do something about,
/// and none of them used to produce a single visible character.
fn open_library(app: &tauri::AppHandle) -> Result<(), String> {
    // The library database lives in app data, never next to the media —
    // network shares stay read-only as far as this app is concerned.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kinema could not work out where to keep its library.\n\n{e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Kinema could not create its data folder.\n\n{}\n\n{e}",
            dir.display()
        )
    })?;

    // Before the database, so a failure opening it is itself logged.
    if let Err(e) = applog::init(&dir.join(applog::DIR)) {
        // Not fatal: the app works without a log, it is just harder to help.
        eprintln!("could not start the log in {}: {e}", dir.display());
    }
    log!("--- Kinema {} started ---", env!("CARGO_PKG_VERSION"));

    let path = dir.join("library.db");

    let primary = db::open(&path).map_err(|e| {
        format!(
            "Kinema could not open its library database.\n\n{}\n\n{e}",
            path.display()
        )
    })?;
    // Opened second, and only after the first has migrated: the scanner's
    // connection must never be the one that defines the schema. See `ScanDb`
    // for why it exists at all.
    let scanner = db::open_secondary(&path).map_err(|e| {
        format!(
            "Kinema opened its library but could not open a second connection \
             for scanning.\n\n{}\n\n{e}",
            path.display()
        )
    })?;

    app.manage(Db(Mutex::new(primary)));
    app.manage(ScanDb(Mutex::new(scanner)));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if let Err(message) = open_library(app.handle()) {
                // Release builds set `windows_subsystem = "windows"`, so there
                // is no console: returning this error would abort the process
                // with no window, no message and nothing in either log — an app
                // that "just doesn't start". A dialog is the only surface left
                // this early, since the webview does not exist yet.
                app.dialog()
                    .message(&message)
                    .title("Kinema could not start")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                // Not a returned error: that path ends in `.expect` below, and
                // panicking after we have already explained ourselves would
                // only add an invisible second failure.
                std::process::exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::add_library_root,
            library::remove_library_root,
            library::list_library_roots,
            library::scan_library,
            library::list_unparsed,
            library::list_media_files,
            library::save_parse_results,
            library::reset_parse,
            library::library_stats,
            settings::get_setting,
            settings::set_setting,
            settings::provider_status,
            settings::append_log,
            settings::log_paths,
            settings::open_log_folder,
            metadata::save_title,
            metadata::save_episodes,
            metadata::link_files_to_title,
            metadata::list_titles,
            metadata::get_title_detail,
            metadata::list_unmatched,
            metadata::list_needs_review,
            metadata::count_needs_review,
            metadata::reset_matches,
            metadata::list_titles_needing_detail,
            metadata::set_title_trailer,
            artwork::cache_artwork,
            artwork::artwork_stats,
            artwork::clear_artwork_cache,
            playback::save_progress,
            playback::get_progress,
            playback::set_watched,
            playback::continue_watching,
            playback::next_episode,
            playback::previous_episode,
            playback::first_unwatched_episode,
            playback::get_title_prefs,
            playback::set_title_prefs,
            skip::get_skip_markers,
            detect::detect_intros,
            detect::auto_detect,
            detect::analysis_backlog,
            ffmpeg::ffmpeg_status,
            trailer::find_local_trailer,
            nfo::read_nfo,
            nfo::read_show_nfo,
            nfo::write_nfo,
            nfo::nfo_targets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
