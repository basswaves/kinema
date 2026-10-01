fn main() {
    // The Linux packages install the libmpv plugin's wrapper in
    // /usr/lib/kinema. The plugin looks beside the program, then in lib/ beside
    // it (where the folder download keeps it), then by bare name — and a bare
    // name is searched in the program's run path, which this adds. Without it
    // the installed program finds no player at all.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/kinema");
    }
    tauri_build::build()
}
