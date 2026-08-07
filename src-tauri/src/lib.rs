mod artwork;
mod db;
mod detect;
mod library;
mod metadata;
mod nfo;
mod playback;
mod scanner;
mod settings;
mod skip;
mod trailer;

use library::{Db, ScanDb};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // The library database lives in app data, never next to the media —
            // network shares stay read-only as far as this app is concerned.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("library.db");

            app.manage(Db(Mutex::new(db::open(&path)?)));
            // Opened second, and only after the first has migrated: the
            // scanner's connection must never be the one that defines the
            // schema. See `ScanDb` for why it exists at all.
            app.manage(ScanDb(Mutex::new(db::open_secondary(&path)?)));
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
            trailer::find_local_trailer,
            nfo::read_nfo,
            nfo::read_show_nfo,
            nfo::write_nfo,
            nfo::nfo_targets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
