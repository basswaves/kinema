//! KDE Plasma's screens, through `kscreen-doctor` — the command-line side of
//! Plasma's own screen library (libkscreen), installed with Plasma, and what
//! scripts and streaming tools use to change a Plasma screen's mode. Linux
//! only.
//!
//! Reading: `kscreen-doctor -j`, libkscreen's own description of the
//! configuration as JSON (its `ConfigSerializer`). Changing:
//! `kscreen-doctor output.<name>.mode.<id>` and `output.<name>.hdr.enable` /
//! `.disable` (Plasma 6), several in one call, applied together. Kinema runs
//! the desktop's own program rather than speaking its internal D-Bus
//! interface, which libkscreen does not promise to keep.
//!
//! Plasma may remember a change made this way as the screen's setup; Kinema
//! putting the mode back when the film ends — or at the next launch after a
//! crash — is what undoes it (display.rs).

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::desktop::{Colour, Screen, ScreenMode};

const PROGRAM: &str = "kscreen-doctor";
/// A mode change waits for the screen; reading does not. Both are bounded:
/// this is asked at startup.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const CHANGE_TIMEOUT: Duration = Duration::from_secs(15);

/// A Plasma session, by what the session says it is. Only then is
/// `kscreen-doctor` asked: installed elsewhere (it comes with any program
/// using libkscreen), it would answer for a desktop it cannot change.
pub fn is_plasma() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.split(':').any(|p| p.eq_ignore_ascii_case("KDE")))
}

/// Run `kscreen-doctor` with `args`; its standard output, or why not. Once
/// more if it crashed: Plasma 5.27's was seen to abort on its own heap
/// corruption ("corrupted size vs. prev_size") now and then while a film
/// was starting, and the same call a moment later worked. Asked at startup,
/// one crash would otherwise leave Kinema unable to switch for the whole
/// session. Asking for a change twice is harmless: the same mode or HDR
/// state set again is the same.
fn run(args: &[String], limit: Duration) -> Result<String, String> {
    run_program(PROGRAM, args, limit)
}

fn run_program(program: &str, args: &[String], limit: Duration) -> Result<String, String> {
    match run_once(program, args, limit) {
        Err((true, why)) => {
            crate::log!("display: {why}; asking once more");
            run_once(program, args, limit).map_err(|(_, why)| why)
        }
        other => other.map_err(|(_, why)| why),
    }
}

/// One run: its output, or (whether it crashed, why not).
fn run_once(program: &str, args: &[String], limit: Duration) -> Result<String, (bool, String)> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| (false, format!("{program}: {e}")))?;
    // Read while it runs: a full pipe would otherwise stop it before it ends.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut text);
            }
            text
        })
    };
    let out_reader = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err_reader = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| (false, e.to_string()))? {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err((false, format!("{program} did not answer within {} s", limit.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let said = if err.trim().is_empty() { out.trim() } else { err.trim() };
        // No exit code: ended by a signal — it crashed (Unix).
        let crashed = status.code().is_none();
        return Err((crashed, format!("{program} failed ({status}): {}", said.lines().last().unwrap_or(""))));
    }
    Ok(out)
}

#[derive(Deserialize)]
struct Config {
    outputs: Vec<Output>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    name: String,
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    current_mode_id: String,
    #[serde(default)]
    priority: u32,
    #[serde(default)]
    modes: Vec<Mode>,
    /// Present only on a screen Plasma can show HDR on (Plasma 6).
    hdr: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mode {
    id: String,
    refresh_rate: f64,
    size: Size,
}

#[derive(Deserialize)]
struct Size {
    width: i64,
    height: i64,
}

/// `kscreen-doctor -j` → the connected, switched-on screens.
pub(crate) fn parse(json: &str) -> Result<Vec<Screen>, String> {
    // The JSON is all it prints; anything before the first brace (a Qt
    // warning on standard output) is skipped rather than failed on.
    let start = json.find('{').ok_or_else(|| format!("{PROGRAM} printed no configuration"))?;
    let config: Config = serde_json::from_str(&json[start..]).map_err(|e| format!("{PROGRAM}: {e}"))?;
    Ok(config
        .outputs
        .into_iter()
        .filter(|o| o.connected && o.enabled)
        .map(|o| Screen {
            display_name: String::new(),
            primary: o.priority == 1,
            hdr: o.hdr,
            colour_mode: None,
            modes: o
                .modes
                .into_iter()
                .map(|m| ScreenMode {
                    current: m.id == o.current_mode_id,
                    id: m.id,
                    width: m.size.width.max(0) as u32,
                    height: m.size.height.max(0) as u32,
                    refresh: m.refresh_rate,
                    interlaced: false,
                })
                .collect(),
            connector: o.name,
        })
        .collect())
}

pub fn screens() -> Result<Vec<Screen>, String> {
    parse(&run(&["-j".into()], READ_TIMEOUT)?)
}

/// The arguments for one change: mode and HDR in one call, so Plasma
/// applies them together.
pub(crate) fn change_args(connector: &str, mode_id: Option<&str>, colour: Option<Colour>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(id) = mode_id {
        args.push(format!("output.{connector}.mode.{id}"));
    }
    let hdr = colour.map(|c| match c {
        Colour::Hdr(on) => on,
        // GNOME's numbers; on Plasma only HDR or not.
        Colour::Exactly(n) => n == crate::mutter::HDR,
    });
    if let Some(on) = hdr {
        args.push(format!("output.{connector}.hdr.{}", if on { "enable" } else { "disable" }));
    }
    args
}

/// `desktop::set` for KDE Plasma.
pub fn set(connector: &str, mode_id: Option<&str>, colour: Option<Colour>) -> Result<(), String> {
    let args = change_args(connector, mode_id, colour);
    if args.is_empty() {
        return Ok(());
    }
    let said = run(&args, CHANGE_TIMEOUT)?;
    // A mode it cannot find is said, not failed on.
    if said.contains("not found") {
        return Err(format!("{PROGRAM}: {}", said.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped as Plasma 6's `kscreen-doctor -j` prints it (libkscreen's
    /// ConfigSerializer; the WSL test desktop's 5.27 prints the same, minus
    /// `hdr`): a TV that can do HDR, a monitor that cannot, and a screen
    /// that is connected but switched off.
    const PLASMA: &str = r#"{
      "features": 247,
      "outputs": [
        {"id": 1, "name": "HDMI-A-1", "connected": true, "enabled": true, "priority": 1,
         "currentModeId": "2", "hdr": false, "wcg": false, "sdr-brightness": 200,
         "modes": [
           {"id": "1", "name": "3840x2160@60", "refreshRate": 60.0, "size": {"width": 3840, "height": 2160}},
           {"id": "2", "name": "1920x1080@60", "refreshRate": 60.0, "size": {"width": 1920, "height": 1080}},
           {"id": "3", "name": "3840x2160@24", "refreshRate": 23.976000785827637, "size": {"width": 3840, "height": 2160}}
         ]},
        {"id": 2, "name": "DP-1", "connected": true, "enabled": true, "priority": 2,
         "currentModeId": "7",
         "modes": [{"id": "7", "name": "2560x1440@60", "refreshRate": 59.951, "size": {"width": 2560, "height": 1440}}]},
        {"id": 3, "name": "DP-2", "connected": true, "enabled": false, "priority": 0,
         "currentModeId": "", "modes": []}
      ],
      "screen": {"id": 0},
      "tabletModeAvailable": false
    }"#;

    #[test]
    fn reads_plasmas_screens() {
        let s = parse(PLASMA).unwrap();
        assert_eq!(s.len(), 2, "the switched-off screen is left out");
        let tv = &s[0];
        assert_eq!((tv.connector.as_str(), tv.primary, tv.hdr), ("HDMI-A-1", true, Some(false)));
        let cur = tv.current().unwrap();
        assert_eq!((cur.id.as_str(), cur.width, cur.height), ("2", 1920, 1080));
        assert!(tv.modes.iter().any(|m| (m.refresh - 23.976).abs() < 0.001));
        let desk = &s[1];
        assert_eq!((desk.primary, desk.hdr), (false, None));
    }

    #[test]
    fn skips_a_warning_printed_before_the_json() {
        let noisy = format!("qt.qpa.wayland: some warning\n{PLASMA}");
        assert_eq!(parse(&noisy).unwrap().len(), 2);
        assert!(parse("").is_err());
    }

    /// Against a real Plasma (a nested KWin does): reads the screens, then
    /// sets the first one's current mode by id — the whole change path,
    /// `kscreen-doctor` included, without blanking anything. Ignored: needs
    /// a Plasma session (XDG_CURRENT_DESKTOP=KDE) and kscreen-doctor.
    #[test]
    #[ignore]
    fn reads_and_applies_through_kscreen_doctor() {
        assert!(is_plasma(), "XDG_CURRENT_DESKTOP should name KDE");
        let found = screens().unwrap();
        println!("{found:#?}");
        let s = &found[0];
        let current = s.current().unwrap().id.clone();
        set(&s.connector, Some(&current), None).unwrap();
        assert_eq!(screens().unwrap()[0].current().unwrap().id, current);
        // A mode that does not exist is refused, not silently ignored.
        assert!(set(&s.connector, Some("no-such-mode"), None).is_err());
    }

    #[test]
    fn a_change_is_one_call_naming_mode_and_hdr() {
        assert_eq!(
            change_args("HDMI-A-1", Some("3"), Some(Colour::Hdr(true))),
            ["output.HDMI-A-1.mode.3", "output.HDMI-A-1.hdr.enable"]
        );
        assert_eq!(change_args("HDMI-A-1", None, Some(Colour::Exactly(0))), ["output.HDMI-A-1.hdr.disable"]);
        assert!(change_args("HDMI-A-1", None, None).is_empty());
    }

    /// A stand-in for kscreen-doctor run through `sh`: it counts its runs in
    /// `dir`/runs, then does what `script` says with `$n`, the run's number.
    #[cfg(unix)]
    fn stand_in(name: &str, script: &str) -> (std::path::PathBuf, Vec<String>) {
        let dir = std::env::temp_dir().join(format!("kinema-kscreen-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let runs = dir.join("runs");
        let body = format!("echo x >> '{}'; n=$(wc -l < '{}'); {script}", runs.display(), runs.display());
        (runs, vec!["-c".into(), body])
    }

    #[cfg(unix)]
    #[test]
    fn asks_once_more_when_it_crashed() {
        // Aborts (as the heap corruption did) the first time, answers the second.
        let (runs, args) = stand_in("crash", r#"[ "$n" = 1 ] && kill -ABRT $$; echo '{"outputs": []}'"#);
        let said = run_program("sh", &args, Duration::from_secs(5)).unwrap();
        assert!(said.contains("outputs"));
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn an_ordinary_failure_is_not_asked_twice() {
        let (runs, args) = stand_in("fails", "echo 'no such output' >&2; exit 1");
        let err = run_program("sh", &args, Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("no such output"), "{err}");
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_second_crash_is_reported() {
        let (runs, args) = stand_in("crash-twice", "kill -ABRT $$");
        assert!(run_program("sh", &args, Duration::from_secs(5)).is_err());
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 2);
    }
}
