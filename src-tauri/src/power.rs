//! Leaving from the sofa: close Kinema, put the PC to sleep, or shut it down.
//!
//! In TV mode Kinema fills the screen and there is no title bar to close it
//! from, so Back on Home offers these three. Each is only ever the user's own
//! choice from that screen; nothing here runs by itself.
//!
//! All three go through Kinema's normal exit first where they can, so the
//! screen mode is put back (`display::restore`, on `RunEvent::Exit`) and a
//! detection run is stopped rather than left behind.
//!
//! Sleep is Windows' own `SetSuspendState`. Shutting down runs Windows' own
//! `shutdown.exe` from System32, named by its full path so nothing on the PATH
//! can stand in for it, and without `/f`: a program holding unsaved work can
//! still ask the user, as it would from the Start menu.

use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Close,
    Sleep,
    ShutDown,
}

/// Whether this build can put the computer to sleep and shut it down
/// (`capabilities.rs`). Where it cannot, Leave offers only to close Kinema.
pub const CAN_SLEEP: bool = cfg!(windows);
pub const CAN_SHUT_DOWN: bool = cfg!(windows);

fn parse(action: &str) -> Result<Action, String> {
    match action {
        "close" => Ok(Action::Close),
        "sleep" => Ok(Action::Sleep),
        "shutdown" => Ok(Action::ShutDown),
        other => Err(format!("unknown power action: {other}")),
    }
}

/// `shutdown.exe` in System32, or the bare name if Windows' folder is unknown.
fn shutdown_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("shutdown.exe"))
        .unwrap_or_else(|| PathBuf::from("shutdown.exe"))
}

/// What `shutdown.exe` is given: shut down, now.
fn shutdown_args() -> [&'static str; 3] {
    ["/s", "/t", "0"]
}

#[cfg(windows)]
fn sleep() -> Result<(), String> {
    use windows::Win32::System::Power::SetSuspendState;
    // Not hibernate, not forced, wake-up timers left alone.
    // SAFETY: plain Win32 call with value arguments.
    if unsafe { SetSuspendState(false, false, false) } {
        Ok(())
    } else {
        Err(format!(
            "Windows would not go to sleep ({})",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(windows))]
fn sleep() -> Result<(), String> {
    Err("sleep is only available on Windows".into())
}

fn shut_down() -> Result<(), String> {
    let exe = shutdown_exe();
    let mut command = Command::new(&exe);
    command.args(shutdown_args());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command
        .status()
        .map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Windows would not shut down ({status})"))
    }
}

#[tauri::command]
pub fn power_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let action = parse(&action)?;
    crate::log!("power: {action:?} chosen");
    match action {
        Action::Close => {
            app.exit(0);
            Ok(())
        }
        // Kinema stays open: after waking up it is where it was left.
        Action::Sleep => sleep(),
        // Windows is asked first; only once it has agreed does Kinema close,
        // so a refusal leaves the app there to say so.
        Action::ShutDown => {
            shut_down()?;
            app.exit(0);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_actions_are_accepted() {
        assert_eq!(parse("close"), Ok(Action::Close));
        assert_eq!(parse("sleep"), Ok(Action::Sleep));
        assert_eq!(parse("shutdown"), Ok(Action::ShutDown));
        assert!(parse("restart").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn shutdown_is_windows_own_and_never_forced() {
        let exe = shutdown_exe();
        assert!(exe.ends_with("shutdown.exe"));
        #[cfg(windows)]
        assert!(exe.is_absolute(), "{} should be a full path", exe.display());
        let args = shutdown_args();
        assert!(args.contains(&"/s"));
        assert!(!args.contains(&"/f"), "forcing would throw away other programs' unsaved work");
    }
}
