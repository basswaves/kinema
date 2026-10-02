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
//!
//! On Linux both go through logind (`org.freedesktop.login1`), the service
//! systemd distributions have and elogind provides on the rest: the same
//! `Suspend` and `PowerOff` a desktop's own menu uses. Offered only where
//! logind says this session may without a password (`CanSuspend` /
//! `CanPowerOff` answer "yes") — on a sofa there is nothing to type one
//! with — and otherwise Leave offers to close Kinema only, as before.

#[cfg(not(target_os = "linux"))]
use std::path::PathBuf;
#[cfg(not(target_os = "linux"))]
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Close,
    Sleep,
    ShutDown,
}

/// Whether this computer can be put to sleep and shut down from here
/// (`capabilities.rs`, asked once per launch). Where it cannot, Leave offers
/// only to close Kinema.
pub fn can_sleep() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(target_os = "linux")]
    return logind::may("CanSuspend");
    #[cfg(not(any(windows, target_os = "linux")))]
    false
}

pub fn can_shut_down() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(target_os = "linux")]
    return logind::may("CanPowerOff");
    #[cfg(not(any(windows, target_os = "linux")))]
    false
}

fn parse(action: &str) -> Result<Action, String> {
    match action {
        "close" => Ok(Action::Close),
        "sleep" => Ok(Action::Sleep),
        "shutdown" => Ok(Action::ShutDown),
        other => Err(format!("unknown power action: {other}")),
    }
}

/// `shutdown.exe` in System32, or the bare name if Windows' folder is unknown.
#[cfg(not(target_os = "linux"))]
fn shutdown_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("shutdown.exe"))
        .unwrap_or_else(|| PathBuf::from("shutdown.exe"))
}

/// What `shutdown.exe` is given: shut down, now.
#[cfg(not(target_os = "linux"))]
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

#[cfg(target_os = "linux")]
fn sleep() -> Result<(), String> {
    logind::ask("Suspend")
}

#[cfg(not(any(windows, target_os = "linux")))]
fn sleep() -> Result<(), String> {
    Err("sleep is only available on Windows".into())
}

#[cfg(target_os = "linux")]
fn shut_down() -> Result<(), String> {
    logind::ask("PowerOff")
}

#[cfg(not(target_os = "linux"))]
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

/// logind on the system bus. A missing logind, a refusal and a time-out all
/// come out as "cannot", so a system without it simply keeps Leave to closing
/// Kinema.
#[cfg(target_os = "linux")]
mod logind {
    use std::time::Duration;

    use zbus::blocking::{connection, Connection};

    const BUS: &str = "org.freedesktop.login1";
    const PATH: &str = "/org/freedesktop/login1";
    const MANAGER: &str = "org.freedesktop.login1.Manager";

    fn bus() -> Result<Connection, String> {
        connection::Builder::system()
            .and_then(|b| b.method_timeout(Duration::from_secs(5)).build())
            .map_err(|e| format!("logind: {e}"))
    }

    /// `CanSuspend` / `CanPowerOff`: "yes" only. "challenge" means a password
    /// would be asked for, which a remote cannot give.
    pub fn may(question: &str) -> bool {
        let answer = bus()
            .and_then(|c| {
                c.call_method(Some(BUS), PATH, Some(MANAGER), question, &())
                    .map_err(|e| e.to_string())
            })
            .and_then(|reply| reply.body().deserialize::<String>().map_err(|e| e.to_string()));
        crate::log!("power: logind {question} → {}", answer.as_deref().unwrap_or_else(|e| e));
        answer.is_ok_and(|a| allowed(&a))
    }

    /// Only "yes": "challenge" would ask for a password, "no" and "na" refuse.
    pub(super) fn allowed(answer: &str) -> bool {
        answer == "yes"
    }

    /// `Suspend` / `PowerOff`, interactive as a desktop's own menu is.
    pub fn ask(action: &str) -> Result<(), String> {
        bus()?
            .call_method(Some(BUS), PATH, Some(MANAGER), action, &(true,))
            .map(|_| ())
            .map_err(|e| format!("the system would not {}: {e}", if action == "Suspend" { "go to sleep" } else { "shut down" }))
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

    #[cfg(target_os = "linux")]
    #[test]
    fn only_a_plain_yes_from_logind_offers_it() {
        assert!(logind::allowed("yes"));
        // A password prompt is not something a remote can answer.
        for answer in ["challenge", "no", "na", ""] {
            assert!(!logind::allowed(answer), "{answer}");
        }
    }

    #[cfg(not(target_os = "linux"))]
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
