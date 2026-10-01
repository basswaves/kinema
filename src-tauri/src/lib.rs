mod analyse;
mod applog;
mod aspect;
mod audio_reserve;
mod capabilities;
mod artwork;
mod backup;
mod db;
mod detect;
mod display;
mod equipment;
mod ffmpeg;
mod history;
mod imdb;
mod introdb;
mod introdb_app;
mod jobs;
mod library;
mod lifecycle;
mod metadata;
mod nfo;
mod overlay;
mod omdb;
mod opensubtitles;
mod playback;
mod power;
mod probe;
mod scanner;
mod selftest;
mod settings;
mod simkl;
mod skip;
mod skiptro;
mod tracking;
mod trakt;
mod trailer;
mod updates;
mod util;

use library::{Db, ScanDb};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Where the library, its backups, the artwork cache and the logs live.
///
/// App data, always — except under a self-test, which works on a copy in the
/// plan's own folder so it can never write to the real library. Every caller
/// goes through here; asking Tauri directly would quietly bypass that.
pub fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match selftest::plan_path() {
        Some(plan) => Ok(selftest::data_dir_for(&plan)),
        None => app.path().app_data_dir().map_err(|e| e.to_string()),
    }
}

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
    let dir = data_dir(app)
        .map_err(|e| format!("Kinema could not work out where to keep its library.\n\n{e}"))?;

    if selftest::plan_path().is_some() {
        let real = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("library.db");
        selftest::seed(&real, &dir)
            .map_err(|e| format!("Self-test could not copy the library.\n\n{e}"))?;
        // The asset scope in tauri.conf.json names the real app data folder,
        // so a self-test's own artwork cache was refused and every poster fell
        // back to the network. Allowing the copy's folder lets a run show the
        // library the way the real app does.
        let _ = app
            .asset_protocol_scope()
            .allow_directory(dir.join("artwork"), false);
    }

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
    log!("capabilities: {:?}", capabilities::current());
    if let Err(e) = util::keep_private(&dir) {
        log!("could not make {} private to this account: {e}", dir.display());
    }

    // Before anything opens the library: a restore asked for in Settings is
    // carried out here, as Kinema starts again. Its outcome is said in a dialog,
    // since the webview does not exist yet and a restore nobody hears about is
    // one nobody can tell from one that did nothing.
    if selftest::plan_path().is_none() {
        match backup::apply_pending_restore(&dir) {
            Ok(Some(done)) => {
                log!("backup: restored the copy made at {}", done.made_at);
                app.dialog()
                    .message("Your library was put back from the safety copy you chose.")
                    .title("Kinema")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            }
            Ok(None) => {}
            Err(reason) => {
                log!("backup: restore failed: {reason}");
                app.dialog()
                    .message(format!(
                        "Your library was not changed.

{reason}"
                    ))
                    .title("The safety copy could not be put back")
                    .kind(MessageDialogKind::Warning)
                    .blocking_show();
            }
        }
    }

    let path = dir.join("library.db");

    let primary = db::open(&path).map_err(|e| {
        // A library from a newer Kinema is not damaged, and its message says
        // what to do. Anything else might be, and the weekly copies are the
        // way back: nobody should have to find that out from a bug report.
        let copies = if matches!(e, db::DbError::TooNew { .. }) {
            String::new()
        } else {
            format!(
                "\n\nIf the file is damaged, earlier copies of it are kept in {}. \
                 Close Kinema, replace library.db with the newest copy there (renamed), \
                 and start it again.",
                dir.join(db::BACKUP_DIR).display()
            )
        };
        format!(
            "Kinema could not open its library database.\n\n{}\n\n{e}{copies}",
            path.display()
        )
    })?;
    // A library brought from another system (a restored safety copy).
    match artwork::use_this_systems_separator(&primary) {
        Ok(0) => {}
        Ok(n) => log!("artwork: {n} cached paths rewritten for this system"),
        Err(e) => log!("artwork: could not check cached paths: {e}"),
    }
    // Not under a self-test, whose library is a throwaway copy.
    if selftest::plan_path().is_none() {
        match db::periodic_backup(&primary, &dir.join(db::BACKUP_DIR)) {
            Ok(Some(copy)) => log!("library: weekly safety copy made: {}", copy.display()),
            Ok(None) => {}
            Err(e) => log!("library: could not make the weekly safety copy: {e}"),
        }
    }
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
    app.manage(jobs::Jobs::default());
    app.manage(equipment::EquipmentState::default());
    app.manage(audio_reserve::Reserved::default());
    app.manage(simkl::SimklState::default());
    app.manage(trakt::TraktState::default());
    Ok(())
}

/// How long the page gets to show the window itself before the backend does.
const REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_secs(4);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so a panic anywhere after this, on any thread, is written down.
    applog::install_panic_hook();
    applog::forward_library_logs();
    // The page is photographed for mpv while mpv's window covers it
    // (overlay.rs), and a covered WebKitGTK window stops producing snapshots
    // after about a second unless it draws without the DMA-BUF renderer.
    // Before any window exists; left alone if set already.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let mut builder = tauri::Builder::default();
    // One Kinema at a time. Two would each switch the display and take the
    // sound device, and the second player would either fail or fight the
    // first for the screen. Starting it again brings the running one forward.
    //
    // Not in a development build, or it would refuse to start beside the
    // release build in use, and not under a self-test, which works on its own
    // copy of the library and must be able to run while Kinema is open. Both
    // are decided here rather than in the plugin because it registers itself
    // for the whole process. It has to come before the other plugins.
    if !cfg!(debug_assertions) && selftest::plan_path().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log!("a second Kinema was started; bringing this one forward");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
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

            // What this machine is connected to: checked, saved beside what
            // was seen before, and written to app.log, so a log from any
            // machine answers "what screen, what receiver" by itself.
            equipment::check_at_startup(app.handle().clone());
            // A screen a crashed session switched and never put back.
            display::restore_after_crash(app.handle());
            // Anything finished while SIMKL could not be reached goes now.
            tracking::send_soon(app.handle());

            // The window starts hidden and the page shows it once it has
            // something to paint (App.tsx). If that never happens — a script
            // error before the first render — an app that never appears is a
            // far worse failure than a white flash, so show it anyway.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(REVEAL_FALLBACK);
                    if !window.is_visible().unwrap_or(true) {
                        log!("window: the page never showed it; showing it anyway");
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::latest_release,
            capabilities::capabilities,
            overlay::overlay_frame,
            overlay::overlay_reset,
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
            settings::append_log,
            settings::log_paths,
            settings::open_log_folder,
            settings::open_backup_folder,
            simkl::simkl_status,
            simkl::simkl_start_connect,
            simkl::simkl_poll_connect,
            simkl::simkl_cancel_connect,
            simkl::simkl_disconnect,
            trakt::trakt_status,
            trakt::trakt_start_connect,
            trakt::trakt_poll_connect,
            trakt::trakt_cancel_connect,
            trakt::trakt_disconnect,
            opensubtitles::opensubtitles_status,
            opensubtitles::opensubtitles_sign_in,
            opensubtitles::opensubtitles_sign_out,
            opensubtitles::find_subtitles,
            opensubtitles::fetch_subtitle,
            opensubtitles::forced_subtitle,
            backup::list_backups,
            backup::restore_backup,
            selftest::selftest_plan,
            selftest::selftest_finish,
            metadata::save_title,
            metadata::save_episodes,
            lifecycle::record_match,
            lifecycle::record_refusal,
            lifecycle::record_provider_failure,
            lifecycle::ignore_files,
            lifecycle::return_to_review,
            lifecycle::unlink_files,
            metadata::list_titles,
            metadata::get_title_detail,
            metadata::list_unmatched,
            metadata::list_needs_review,
            metadata::count_needs_review,
            metadata::reset_matches,
            metadata::list_titles_needing_detail,
            metadata::list_stale_titles,
            metadata::list_wikidata_films,
            metadata::adopt_provider,
            artwork::cache_artwork,
            artwork::artwork_stats,
            artwork::clear_artwork_cache,
            playback::save_progress,
            playback::get_progress,
            playback::set_watched,
            playback::continue_watching,
            playback::dismiss_continue,
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
            probe::probe_library,
            imdb::refresh_imdb_ratings,
            omdb::list_titles_needing_scores,
            omdb::save_omdb_scores,
            probe::file_facts,
            probe::season_facts,
            aspect::measure_pictures,
            equipment::get_equipment,
            equipment::check_equipment,
            equipment::window_display,
            audio_reserve::reserve_audio_device,
            audio_reserve::release_audio_device,
            display::screen_now,
            display::switch_screen,
            display::restore_screen,
            trailer::find_local_trailer,
            nfo::read_nfo,
            nfo::read_show_nfo,
            nfo::write_nfo,
            nfo::nfo_targets,
            jobs::stop_detection,
            power::power_action,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Windows does not end a child with its parent: without this a
            // Skiptro started by the scan goes on scanning after the window
            // has closed, where nobody can see it or stop it.
            if let tauri::RunEvent::Exit = event {
                // mpv is shut down before the process ends. The plugin does
                // that only when a window's close button is used; Leave, the
                // power actions and a self-test all end with `app.exit`, and
                // left mpv's video thread drawing while the graphics driver
                // was unloaded under it — a crash on every such exit on Linux.
                {
                    use tauri_plugin_libmpv::MpvExt;
                    if let Err(e) = app.mpv().destroy("main") {
                        log!("mpv: could not shut down on exit: {e}");
                    }
                }
                app.state::<jobs::Jobs>().stop_detection();
                // The screen goes back to the desktop's own mode however the
                // app is closed; a crash is caught at the next launch instead.
                if let Err(e) = display::restore(app) {
                    log!("display: could not restore on exit: {e}");
                }
            }
        });
}
