//! The screens of Sway, Hyprland and the other desktops built like them
//! (river, Wayfire, labwc, niri…), through the Wayland protocol they share
//! for it: wlr-output-management. Linux only.
//!
//! Reading: bind `zwlr_output_manager_v1`, collect each head (output) with
//! its modes, current mode, position, rotation and scale until `done`.
//! Changing: one configuration naming every head — the protocol requires it,
//! and does not promise to keep a property left unset — with each enabled
//! head restated as it is and only the asked-for mode different, then
//! `apply` and wait for the answer. The same protocol `wlr-randr` and
//! `kanshi` use, spoken directly: nothing to install, and stable for years,
//! unlike each desktop's own command syntax (Hyprland moved its
//! configuration to Lua in 0.55).
//!
//! HDR is not in the protocol. Sway (1.12 and later) switches it through its
//! own IPC — `output <name> hdr on|off`, state in `get_outputs` — which is
//! used when Sway reports it. Hyprland switches HDR by itself for an HDR
//! video in full screen (`cm_auto_hdr`) and does not report it here, so
//! Kinema leaves HDR to it there (`hdr_unreported`).
//!
//! Each call opens its own connection and runs on its own thread with a time
//! limit: a desktop that never answers must not hold up Kinema's start.

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use wayland_client::backend::ObjectId;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_output::Transform;
use wayland_client::protocol::wl_registry;
use wayland_client::{event_created_child, Connection, Dispatch, Proxy, QueueHandle, WEnum};
use wayland_protocols_wlr::output_management::v1::client::{
    zwlr_output_configuration_head_v1::ZwlrOutputConfigurationHeadV1,
    zwlr_output_configuration_v1::{self, ZwlrOutputConfigurationV1},
    zwlr_output_head_v1::{self, ZwlrOutputHeadV1},
    zwlr_output_manager_v1::{self, ZwlrOutputManagerV1},
    zwlr_output_mode_v1::{self, ZwlrOutputModeV1},
};

use crate::desktop::{Colour, Screen, ScreenMode};

const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// A mode change waits for the screen to come back.
const CHANGE_TIMEOUT: Duration = Duration::from_secs(15);

// ---- reading ---------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct Mode {
    width: i32,
    height: i32,
    /// mHz, as the protocol gives it; 0 when the desktop does not say.
    refresh: i32,
}

#[derive(Debug, Default)]
struct Head {
    proxy: Option<ZwlrOutputHeadV1>,
    name: String,
    description: String,
    make: String,
    model: String,
    enabled: bool,
    /// In the order the desktop listed them.
    modes: Vec<ObjectId>,
    current: Option<ObjectId>,
    position: (i32, i32),
    transform: Option<Transform>,
    scale: f64,
}

#[derive(Default)]
struct State {
    heads: Vec<Head>,
    modes: HashMap<ObjectId, (ZwlrOutputModeV1, Mode)>,
    serial: Option<u32>,
    outcome: Option<Result<(), String>>,
}

impl State {
    fn head(&mut self, id: &ObjectId) -> Option<&mut Head> {
        self.heads.iter_mut().find(|h| h.proxy.as_ref().is_some_and(|p| &p.id() == id))
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ZwlrOutputManagerV1, ()> for State {
    fn event(state: &mut Self, _: &ZwlrOutputManagerV1, event: zwlr_output_manager_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            zwlr_output_manager_v1::Event::Head { head } => {
                state.heads.push(Head { proxy: Some(head), scale: 1.0, ..Default::default() })
            }
            zwlr_output_manager_v1::Event::Done { serial } => state.serial = Some(serial),
            _ => {}
        }
    }

    event_created_child!(State, ZwlrOutputManagerV1, [
        zwlr_output_manager_v1::EVT_HEAD_OPCODE => (ZwlrOutputHeadV1, ()),
    ]);
}

impl Dispatch<ZwlrOutputHeadV1, ()> for State {
    fn event(state: &mut Self, head: &ZwlrOutputHeadV1, event: zwlr_output_head_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use zwlr_output_head_v1::Event as E;
        if let E::Mode { mode } = &event {
            let id = mode.id();
            state.modes.insert(id.clone(), (mode.clone(), Mode::default()));
            if let Some(h) = state.head(&head.id()) {
                h.modes.push(id);
            }
            return;
        }
        if let E::Finished = event {
            let id = head.id();
            state.heads.retain(|h| h.proxy.as_ref().is_none_or(|p| p.id() != id));
            return;
        }
        let Some(h) = state.head(&head.id()) else { return };
        match event {
            E::Name { name } => h.name = name,
            E::Description { description } => h.description = description,
            E::Make { make } => h.make = make,
            E::Model { model } => h.model = model,
            E::Enabled { enabled } => h.enabled = enabled != 0,
            E::CurrentMode { mode } => h.current = Some(mode.id()),
            E::Position { x, y } => h.position = (x, y),
            E::Transform { transform: WEnum::Value(t) } => h.transform = Some(t),
            E::Scale { scale } => h.scale = scale,
            _ => {}
        }
    }

    event_created_child!(State, ZwlrOutputHeadV1, [
        zwlr_output_head_v1::EVT_MODE_OPCODE => (ZwlrOutputModeV1, ()),
    ]);
}

impl Dispatch<ZwlrOutputModeV1, ()> for State {
    fn event(state: &mut Self, mode: &ZwlrOutputModeV1, event: zwlr_output_mode_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        let Some((_, m)) = state.modes.get_mut(&mode.id()) else { return };
        match event {
            zwlr_output_mode_v1::Event::Size { width, height } => (m.width, m.height) = (width, height),
            zwlr_output_mode_v1::Event::Refresh { refresh } => m.refresh = refresh,
            _ => {}
        }
    }
}

impl Dispatch<ZwlrOutputConfigurationV1, ()> for State {
    fn event(state: &mut Self, _: &ZwlrOutputConfigurationV1, event: zwlr_output_configuration_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use zwlr_output_configuration_v1::Event as E;
        state.outcome = match event {
            E::Succeeded => Some(Ok(())),
            E::Failed => Some(Err("the desktop refused the change".into())),
            E::Cancelled => Some(Err("the screens changed while asking; try again".into())),
            _ => return,
        };
    }
}

impl Dispatch<ZwlrOutputConfigurationHeadV1, ()> for State {
    fn event(_: &mut Self, _: &ZwlrOutputConfigurationHeadV1, _: <ZwlrOutputConfigurationHeadV1 as Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

/// A mode's id: what a change names, and stable between two connections
/// (the protocol's objects are not).
fn mode_id(m: &Mode) -> String {
    format!("{}x{}@{}", m.width, m.height, m.refresh)
}

/// Connected to the desktop, with every head and mode read.
struct Session {
    conn: Connection,
    queue: wayland_client::EventQueue<State>,
    manager: ZwlrOutputManagerV1,
    state: State,
}

fn connect() -> Result<Session, String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("no Wayland desktop to ask: {e}"))?;
    let (globals, mut queue) = registry_queue_init::<State>(&conn).map_err(|e| e.to_string())?;
    let manager: ZwlrOutputManagerV1 = globals
        .bind(&queue.handle(), 1..=4, ())
        .map_err(|_| "this desktop does not offer wlr-output-management".to_string())?;
    let mut state = State::default();
    // Heads, then their modes, then `done`: a few round trips at most.
    for _ in 0..8 {
        queue.roundtrip(&mut state).map_err(|e| e.to_string())?;
        if state.serial.is_some() {
            break;
        }
    }
    if state.serial.is_none() {
        return Err("the desktop did not describe its screens".into());
    }
    Ok(Session { conn, queue, manager, state })
}

fn to_screens(state: &State) -> Vec<Screen> {
    state
        .heads
        .iter()
        .filter(|h| h.enabled)
        .map(|h| Screen {
            connector: h.name.clone(),
            display_name: if h.make.is_empty() && h.model.is_empty() {
                h.description.clone()
            } else {
                format!("{} {}", h.make, h.model).trim().to_string()
            },
            modes: h
                .modes
                .iter()
                .filter_map(|id| state.modes.get(id).map(|(_, m)| (id, m)))
                .map(|(id, m)| ScreenMode {
                    id: mode_id(m),
                    width: m.width.max(0) as u32,
                    height: m.height.max(0) as u32,
                    refresh: f64::from(m.refresh) / 1000.0,
                    current: h.current.as_ref() == Some(id),
                    interlaced: false,
                })
                .collect(),
            // No such thing here; display::linux picks by mpv's screen name.
            primary: false,
            hdr: None,
            hdr_unreported: true,
            colour_mode: None,
        })
        .collect()
}

/// Run `job` on its own thread, giving up after `limit`.
fn bounded<T: Send + 'static>(limit: Duration, job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(job());
    });
    rx.recv_timeout(limit).map_err(|_| format!("the desktop did not answer within {} s", limit.as_secs()))?
}

/// Whether this desktop speaks wlr-output-management (asked once per launch,
/// through `desktop::which`).
pub fn answers() -> bool {
    screens().is_ok()
}

/// The switched-on screens, with Sway's HDR state where it reports one.
pub fn screens() -> Result<Vec<Screen>, String> {
    let mut screens = bounded(READ_TIMEOUT, || connect().map(|s| to_screens(&s.state)))?;
    if let Some(hdr) = sway::hdr_states() {
        for s in &mut screens {
            // Sway 1.12+ lists `hdr` for every output; it is on or off, and
            // a screen that cannot is refused when asked.
            if let Some(&on) = hdr.get(&s.connector) {
                s.hdr = Some(on);
                s.hdr_unreported = false;
            }
        }
    }
    Ok(screens)
}

/// `desktop::set` for these desktops: the mode through the protocol, HDR
/// through Sway's IPC when it is Sway.
pub fn set(connector: &str, mode_id: Option<&str>, colour: Option<Colour>) -> Result<(), String> {
    if let Some(id) = mode_id {
        let (connector, id) = (connector.to_string(), id.to_string());
        bounded(CHANGE_TIMEOUT, move || apply_mode(&connector, Some(&id)))?;
    }
    if let Some(c) = colour {
        let on = match c {
            Colour::Hdr(on) => on,
            // GNOME's numbers; elsewhere only HDR or not.
            Colour::Exactly(n) => n == crate::mutter::HDR,
        };
        sway::set_hdr(connector, on)?;
    }
    Ok(())
}

/// Ask for `wanted` (a mode id) on `connector`, every other head and
/// property restated as it is. `None` restates everything unchanged — what
/// a nested desktop, whose outputs have no modes to choose, can check.
fn apply_mode(connector: &str, wanted: Option<&str>) -> Result<(), String> {
    let mut s = connect()?;
    let qh = s.queue.handle();
    let serial = s.state.serial.unwrap_or(0);
    let target = s
        .state
        .heads
        .iter()
        .find(|h| h.enabled && h.name == connector)
        .ok_or_else(|| format!("{connector} is not on"))?;
    let new_mode = match wanted {
        None => None,
        Some(wanted) => Some(
            target
                .modes
                .iter()
                .find(|id| s.state.modes.get(*id).is_some_and(|(_, m)| mode_id(m) == wanted))
                .and_then(|id| s.state.modes.get(id))
                .map(|(proxy, _)| proxy.clone())
                .ok_or_else(|| format!("{connector} has no mode {wanted}"))?,
        ),
    };

    let config = s.manager.create_configuration(serial, &qh, ());
    for h in &s.state.heads {
        let Some(head) = &h.proxy else { continue };
        if !h.enabled {
            config.disable_head(head);
            continue;
        }
        // Every enabled head restated as it is; only the target's mode differs.
        let ch = config.enable_head(head, &qh, ());
        let current = h.current.as_ref().and_then(|id| s.state.modes.get(id)).map(|(p, _)| p.clone());
        let mode = if h.name == connector { new_mode.clone().or(current) } else { current };
        if let Some(m) = &mode {
            ch.set_mode(m);
        }
        ch.set_position(h.position.0, h.position.1);
        if let Some(t) = h.transform {
            ch.set_transform(t);
        }
        if h.scale > 0.0 {
            ch.set_scale(h.scale);
        }
    }
    config.apply();
    let outcome = loop {
        s.queue.blocking_dispatch(&mut s.state).map_err(|e| e.to_string())?;
        if let Some(o) = s.state.outcome.take() {
            break o;
        }
    };
    config.destroy();
    let _ = s.conn.flush();
    outcome
}

// ---- Sway's own HDR switch ---------------------------------------------------------

/// Sway's IPC (the i3 protocol, `$SWAYSOCK`): a message is `i3-ipc`, its
/// length and type as 32-bit little-endian numbers, then JSON.
mod sway {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    const RUN_COMMAND: u32 = 0;
    const GET_OUTPUTS: u32 = 3;
    const MAGIC: &[u8] = b"i3-ipc";

    fn ask(kind: u32, payload: &str) -> Result<String, String> {
        let path = std::env::var("SWAYSOCK").map_err(|_| "not Sway".to_string())?;
        let mut sock = UnixStream::connect(&path).map_err(|e| format!("Sway's IPC: {e}"))?;
        let limit = Some(Duration::from_secs(10));
        sock.set_read_timeout(limit).ok();
        sock.set_write_timeout(limit).ok();
        let mut msg = MAGIC.to_vec();
        msg.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        msg.extend_from_slice(&kind.to_le_bytes());
        msg.extend_from_slice(payload.as_bytes());
        sock.write_all(&msg).map_err(|e| format!("Sway's IPC: {e}"))?;
        let mut head = [0u8; 14];
        sock.read_exact(&mut head).map_err(|e| format!("Sway's IPC: {e}"))?;
        if &head[..6] != MAGIC {
            return Err("Sway's IPC answered in another protocol".into());
        }
        let len = u32::from_le_bytes([head[6], head[7], head[8], head[9]]) as usize;
        let mut body = vec![0u8; len];
        sock.read_exact(&mut body).map_err(|e| format!("Sway's IPC: {e}"))?;
        String::from_utf8(body).map_err(|e| e.to_string())
    }

    /// Output name → HDR on, for the outputs Sway reports it for (1.12+).
    /// None when this is not Sway or Sway says nothing about HDR.
    pub fn hdr_states() -> Option<HashMap<String, bool>> {
        let json = ask(GET_OUTPUTS, "").ok()?;
        let states = parse_outputs(&json);
        (!states.is_empty()).then_some(states)
    }

    pub(super) fn parse_outputs(json: &str) -> HashMap<String, bool> {
        let outputs: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
        outputs
            .iter()
            .filter_map(|o| Some((o.get("name")?.as_str()?.to_string(), o.get("hdr")?.as_bool()?)))
            .collect()
    }

    pub fn set_hdr(output: &str, on: bool) -> Result<(), String> {
        // Quoted: an output name is the user's to choose in Sway's config.
        let command = format!("output \"{}\" hdr {}", output.replace('"', ""), if on { "on" } else { "off" });
        check_reply(&ask(RUN_COMMAND, &command)?)
    }

    /// `[{"success": true}]`, or `[{"success": false, "error": "…"}]`.
    pub(super) fn check_reply(json: &str) -> Result<(), String> {
        let replies: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| format!("Sway's IPC: {e}"))?;
        for r in &replies {
            if r.get("success").and_then(|s| s.as_bool()) != Some(true) {
                let why = r.get("error").and_then(|e| e.as_str()).unwrap_or("refused");
                return Err(format!("Sway: {why}"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(name: &str, enabled: bool, modes: &[ObjectId], current: Option<ObjectId>) -> Head {
        Head {
            name: name.into(),
            make: "Maker".into(),
            model: "TV".into(),
            enabled,
            modes: modes.to_vec(),
            current,
            scale: 1.0,
            ..Default::default()
        }
    }

    #[test]
    fn mode_ids_name_size_and_rate_in_millihertz() {
        assert_eq!(mode_id(&Mode { width: 3840, height: 2160, refresh: 23976 }), "3840x2160@23976");
    }

    #[test]
    fn sway_reports_hdr_per_output_only_from_1_12() {
        let new = r#"[{"name":"HDMI-A-1","hdr":false,"modes":[]},{"name":"DP-1","hdr":true}]"#;
        let states = sway::parse_outputs(new);
        assert_eq!(states.get("HDMI-A-1"), Some(&false));
        assert_eq!(states.get("DP-1"), Some(&true));
        // Sway 1.11 and before: no `hdr`, so nothing is claimed.
        assert!(sway::parse_outputs(r#"[{"name":"HDMI-A-1","modes":[]}]"#).is_empty());
        assert!(sway::parse_outputs("not json").is_empty());
    }

    #[test]
    fn a_refused_sway_command_is_an_error_in_sways_words() {
        assert!(sway::check_reply(r#"[{"success":true}]"#).is_ok());
        let err = sway::check_reply(r#"[{"success":false,"error":"HDR not supported by output"}]"#).unwrap_err();
        assert_eq!(err, "Sway: HDR not supported by output");
    }

    /// Reading needs a desktop speaking the protocol; checked in a nested Sway
    /// (scripts/nested-selftest.sh). What is checked here is the shape.
    #[test]
    fn screens_are_the_switched_on_heads_with_their_modes() {
        // Object ids cannot be made without a connection; the conversion is
        // exercised through `to_screens` on an empty state instead.
        let state = State { heads: vec![head("HDMI-A-1", false, &[], None)], ..Default::default() };
        assert!(to_screens(&state).is_empty(), "a switched-off head is not a screen");
    }

    /// Needs a wlroots desktop on WAYLAND_DISPLAY (a nested Sway is enough):
    /// recognised as one, read, a configuration restating every screen
    /// applied and accepted, and the current mode asked for (when the
    /// output has modes — a nested one has none), which changes nothing.
    #[test]
    #[ignore]
    fn reads_and_reapplies_through_the_protocol() {
        assert_eq!(crate::desktop::which(), Some(crate::desktop::Desktop::Wlroots));
        let screens = screens().unwrap();
        println!("{screens:#?}");
        let s = screens.first().expect("a screen");
        apply_mode(&s.connector, None).unwrap();
        if let Some(m) = s.current() {
            set(&s.connector, Some(&m.id), None).unwrap();
        }
        assert!(set(&s.connector, Some("1x1@1"), None).unwrap_err().contains("has no mode"));
    }
}
