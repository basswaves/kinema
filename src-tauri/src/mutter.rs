//! GNOME's screens, through Mutter's `org.gnome.Mutter.DisplayConfig` on the
//! session bus: reading them (the equipment check) and changing one (display
//! switching). Linux only.
//!
//! On Wayland the compositor owns the screens: no program may set a mode by
//! itself, only ask the desktop to. This is GNOME's way of being asked — the
//! same one its own Settings → Displays uses. KDE Plasma and the wlroots
//! desktops have their own (notes: PORTING, "other desktops"); each gets a
//! module like this one when it is added.

use std::collections::HashMap;
use std::time::Duration;

use zbus::blocking::{connection, Connection};
use zbus::zvariant::{OwnedValue, Value};

const BUS: &str = "org.gnome.Mutter.DisplayConfig";
const PATH: &str = "/org/gnome/Mutter/DisplayConfig";

/// Mutter's colour mode for HDR: BT.2100. GNOME 50 also lists 2, "sdr-native"
/// (wide-gamut SDR) — not HDR (GOTCHAS → "GNOME's colour mode 2 is not HDR").
pub const HDR: u32 = 1;
pub const DEFAULT_COLOUR: u32 = 0;

#[derive(Debug, Clone)]
pub struct State {
    /// Must be handed back with a change: Mutter refuses one made against a
    /// state that has moved on since.
    pub serial: u32,
    pub monitors: Vec<Monitor>,
    pub logical: Vec<Logical>,
}

#[derive(Debug, Clone, Default)]
pub struct Monitor {
    /// "HDMI-1", "DP-2" — the name mpv reports as `display-names`.
    pub connector: String,
    pub display_name: String,
    pub modes: Vec<MonitorMode>,
    pub color_mode: Option<u32>,
    pub supported_color_modes: Vec<u32>,
    /// Handed back as they are with every change, so that a change of mode
    /// can never also reset the user's RGB range or underscan.
    pub rgb_range: Option<u32>,
    pub underscanning: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct MonitorMode {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub refresh: f64,
    pub scales: Vec<f64>,
    pub current: bool,
    pub interlaced: bool,
}

impl Monitor {
    pub fn current(&self) -> Option<&MonitorMode> {
        self.modes.iter().find(|m| m.current)
    }
}

#[derive(Debug, Clone)]
pub struct Logical {
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub transform: u32,
    pub primary: bool,
    /// The connectors shown in this logical monitor (more than one when
    /// mirrored).
    pub connectors: Vec<String>,
}

type ModeT = (String, i32, i32, f64, f64, Vec<f64>, HashMap<String, OwnedValue>);
type MonitorT = ((String, String, String, String), Vec<ModeT>, HashMap<String, OwnedValue>);
type LogicalT =
    (i32, i32, f64, u32, bool, Vec<(String, String, String, String)>, HashMap<String, OwnedValue>);
type StateT = (u32, Vec<MonitorT>, Vec<LogicalT>, HashMap<String, OwnedValue>);

fn prop<T: TryFrom<OwnedValue>>(props: &HashMap<String, OwnedValue>, key: &str) -> Option<T> {
    props.get(key).and_then(|v| v.try_clone().ok()).and_then(|v| T::try_from(v).ok())
}

/// The session bus, with a short timeout: this is asked at startup, and a
/// desktop that does not answer must not hold Kinema up.
fn bus() -> Result<Connection, String> {
    connection::Builder::session()
        .and_then(|b| b.method_timeout(Duration::from_secs(2)).build())
        .map_err(|e| e.to_string())
}

pub fn state() -> Result<State, String> {
    let reply = bus()?
        .call_method(Some(BUS), PATH, Some(BUS), "GetCurrentState", &())
        .map_err(|e| e.to_string())?;
    let (serial, monitors, logical, _): StateT =
        reply.body().deserialize().map_err(|e| e.to_string())?;
    Ok(State {
        serial,
        monitors: monitors
            .into_iter()
            .map(|((connector, _, _, _), modes, props)| Monitor {
                connector,
                display_name: prop::<String>(&props, "display-name").unwrap_or_default(),
                modes: modes
                    .into_iter()
                    .map(|(id, w, h, refresh, _, scales, p)| MonitorMode {
                        id,
                        width: w.max(0) as u32,
                        height: h.max(0) as u32,
                        refresh,
                        scales,
                        current: prop::<bool>(&p, "is-current").unwrap_or(false),
                        interlaced: prop::<bool>(&p, "is-interlaced").unwrap_or(false),
                    })
                    .collect(),
                color_mode: prop::<u32>(&props, "color-mode"),
                supported_color_modes: prop::<Vec<u32>>(&props, "supported-color-modes")
                    .unwrap_or_default(),
                rgb_range: prop::<u32>(&props, "rgb-range"),
                underscanning: prop::<bool>(&props, "is-underscanning"),
            })
            .collect(),
        logical: logical
            .into_iter()
            .map(|(x, y, scale, transform, primary, monitors, _)| Logical {
                x,
                y,
                scale,
                transform,
                primary,
                connectors: monitors.into_iter().map(|(c, ..)| c).collect(),
            })
            .collect(),
    })
}

/// GNOME's screens in the shape the rest of Kinema reads (`desktop.rs`).
pub fn screens() -> Result<Vec<crate::desktop::Screen>, String> {
    Ok(to_screens(&state()?))
}

pub(crate) fn to_screens(state: &State) -> Vec<crate::desktop::Screen> {
    let primary = state.logical.iter().find(|l| l.primary).map(|l| l.connectors.clone()).unwrap_or_default();
    state
        .monitors
        .iter()
        .map(|m| crate::desktop::Screen {
            connector: m.connector.clone(),
            display_name: m.display_name.clone(),
            modes: m
                .modes
                .iter()
                .map(|x| crate::desktop::ScreenMode {
                    id: x.id.clone(),
                    width: x.width,
                    height: x.height,
                    refresh: x.refresh,
                    current: x.current,
                    interlaced: x.interlaced,
                })
                .collect(),
            primary: primary.contains(&m.connector),
            hdr: if m.supported_color_modes.contains(&HDR) {
                Some(m.color_mode == Some(HDR))
            } else {
                None
            },
            colour_mode: m.color_mode,
        })
        .collect()
}

/// `desktop::set` for GNOME.
pub fn set(connector: &str, mode_id: Option<&str>, colour: Option<crate::desktop::Colour>) -> Result<(), String> {
    use crate::desktop::Colour;
    let state = state()?;
    let color_mode = colour.map(|c| match c {
        Colour::Hdr(true) => HDR,
        Colour::Hdr(false) => DEFAULT_COLOUR,
        Colour::Exactly(n) => n,
    });
    apply(&state, &Change { connector: connector.into(), mode_id: mode_id.map(str::to_string), color_mode })
}

/// One screen's new mode and/or colour mode; everything else stays.
#[derive(Debug, Clone)]
pub struct Change {
    pub connector: String,
    pub mode_id: Option<String>,
    pub color_mode: Option<u32>,
}

type MonitorConfig = (String, String, HashMap<String, Value<'static>>);
type LogicalConfig = (i32, i32, f64, u32, bool, Vec<MonitorConfig>);

/// The whole layout as it is, with `change` applied — Mutter takes nothing
/// less than every logical monitor.
pub fn config_for(state: &State, change: &Change) -> Result<Vec<LogicalConfig>, String> {
    let mut out = Vec::new();
    for lm in &state.logical {
        let mut scale = lm.scale;
        let mut monitors = Vec::new();
        for connector in &lm.connectors {
            let m = state
                .monitors
                .iter()
                .find(|m| &m.connector == connector)
                .ok_or_else(|| format!("{connector} is in the layout but not among the monitors"))?;
            let current = m.current().ok_or_else(|| format!("{connector} has no current mode"))?;
            let ours = connector == &change.connector;
            let mode = match (&change.mode_id, ours) {
                (Some(id), true) => m
                    .modes
                    .iter()
                    .find(|x| &x.id == id)
                    .ok_or_else(|| format!("{connector} has no mode {id}"))?,
                _ => current,
            };
            // A scale the new mode does not offer is refused; 1 always is.
            if ours && !mode.scales.iter().any(|s| (s - scale).abs() < 0.001) {
                scale = 1.0;
            }
            let mut props: HashMap<String, Value<'static>> = HashMap::new();
            let colour = if ours { change.color_mode.or(m.color_mode) } else { m.color_mode };
            if let Some(c) = colour.filter(|_| !m.supported_color_modes.is_empty()) {
                props.insert("color-mode".into(), Value::from(c));
            }
            if let Some(r) = m.rgb_range {
                props.insert("rgb-range".into(), Value::from(r));
            }
            if let Some(u) = m.underscanning {
                props.insert("enable_underscanning".into(), Value::from(u));
            }
            monitors.push((connector.clone(), mode.id.clone(), props));
        }
        out.push((lm.x, lm.y, scale, lm.transform, lm.primary, monitors));
    }
    Ok(out)
}

/// Apply `change`, temporarily: Mutter does not write it to `monitors.xml`,
/// so the desktop's own configuration is never touched and comes back at the
/// next login whatever happens to Kinema.
pub fn apply(state: &State, change: &Change) -> Result<(), String> {
    const TEMPORARY: u32 = 1;
    let layout = config_for(state, change)?;
    let props: HashMap<String, Value<'static>> = HashMap::new();
    bus()?
        .call_method(
            Some(BUS),
            PATH,
            Some(BUS),
            "ApplyMonitorsConfig",
            &(state.serial, TEMPORARY, layout, props),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn mode(id: &str, w: u32, h: u32, refresh: f64, current: bool) -> MonitorMode {
        MonitorMode {
            id: id.into(),
            width: w,
            height: h,
            refresh,
            scales: vec![1.0, 2.0],
            current,
            interlaced: false,
        }
    }

    /// A TV at 1080p60 beside a monitor, as GNOME would describe them.
    pub(crate) fn two_screens() -> State {
        State {
            serial: 7,
            monitors: vec![
                Monitor {
                    connector: "HDMI-1".into(),
                    display_name: "Maker TV".into(),
                    modes: vec![
                        mode("3840x2160@60.000", 3840, 2160, 60.0, false),
                        mode("3840x2160@23.976", 3840, 2160, 23.976023, false),
                        mode("1920x1080@60.000", 1920, 1080, 60.0, true),
                    ],
                    color_mode: Some(0),
                    supported_color_modes: vec![0, 2, 1],
                    rgb_range: Some(1),
                    underscanning: None,
                },
                Monitor {
                    connector: "DP-1".into(),
                    display_name: "Desk".into(),
                    modes: vec![mode("2560x1440@59.951", 2560, 1440, 59.951, true)],
                    color_mode: None,
                    supported_color_modes: vec![],
                    rgb_range: None,
                    underscanning: Some(false),
                },
            ],
            logical: vec![
                Logical { x: 0, y: 0, scale: 1.0, transform: 0, primary: true, connectors: vec!["HDMI-1".into()] },
                Logical { x: 1920, y: 0, scale: 1.0, transform: 0, primary: false, connectors: vec!["DP-1".into()] },
            ],
        }
    }

    #[test]
    fn a_change_touches_one_screen_and_keeps_the_rest() {
        let s = two_screens();
        let change = Change {
            connector: "HDMI-1".into(),
            mode_id: Some("3840x2160@23.976".into()),
            color_mode: Some(HDR),
        };
        let layout = config_for(&s, &change).unwrap();
        assert_eq!(layout.len(), 2);
        let (_, _, _, _, primary, tv) = &layout[0];
        assert!(primary);
        assert_eq!(tv[0].1, "3840x2160@23.976");
        assert_eq!(tv[0].2.get("color-mode"), Some(&Value::from(HDR)));
        // Handed back as it was.
        assert_eq!(tv[0].2.get("rgb-range"), Some(&Value::from(1u32)));
        let desk = &layout[1].5[0];
        assert_eq!(desk.1, "2560x1440@59.951");
        assert_eq!(desk.2.get("enable_underscanning"), Some(&Value::from(false)));
        // A screen that lists no colour modes is not given one.
        assert!(!desk.2.contains_key("color-mode"));
    }

    #[test]
    fn an_unknown_mode_is_refused_rather_than_guessed() {
        let change = Change { connector: "HDMI-1".into(), mode_id: Some("nope".into()), color_mode: None };
        assert!(config_for(&two_screens(), &change).is_err());
    }
}
