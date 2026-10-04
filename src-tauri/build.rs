fn main() {
    // The Linux packages install the libmpv plugin's wrapper in
    // /usr/lib/kinema. The plugin looks beside the program, then in lib/ beside
    // it (where the folder download keeps it), then by bare name — and a bare
    // name is searched in the program's run path, which this adds. Without it
    // the installed program finds no player at all.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/kinema");
    }
    // The Android player's commands (engine.rs, Media3Plugin.kt): a plugin
    // that lives in this app rather than in a crate of its own, so its
    // permissions are declared here. Allowed for Android only, in
    // capabilities/player-media3.json.
    let media3 = tauri_build::InlinedPlugin::new()
        .commands(&[
            "open",
            "stop",
            "set_paused",
            "seek",
            "state",
            "register_listener",
            "remove_listener",
        ])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    // Android's drives and the permission to read them (places.rs,
    // StoragePlugin.kt), on the same footing; capabilities/storage-android.json.
    let storage = tauri_build::InlinedPlugin::new()
        .commands(&["places", "access", "request_access", "allow_all_files"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin("media3", media3)
            .plugin("storage", storage),
    )
        .expect("failed to run tauri-build");
}
