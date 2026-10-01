//! Asking the system's sound server to let go of a sound card while a film
//! plays straight to the receiver, and giving it back afterwards.
//!
//! On Linux, sound normally goes through PipeWire (or PulseAudio), which
//! keeps each card's devices open while anything plays and for a few seconds
//! after. "Send sound straight to the receiver" has mpv open the HDMI device
//! itself (`alsa/hdmi:…`), the Linux counterpart of WASAPI's exclusive mode —
//! which fails as "busy" for as long as the sound server holds it.
//!
//! The way programs that need a card to themselves ask for it is the device
//! reservation protocol, `org.freedesktop.ReserveDevice1`, on the session
//! bus: JACK and pro-audio programs use it, and WirePlumber and PulseAudio
//! both honour it. The holder owns the bus name `…ReserveDevice1.Audio<N>`
//! for card N; a program with a higher priority asks it to release the card,
//! and on a yes takes the name over. When that program lets the name go — or
//! quits, or crashes — the sound server takes the card back by itself, so a
//! crash cannot leave the system without sound.
//!
//! A refusal is not an error here: mpv then finds the device busy, and the
//! player's fallback sends the sound the ordinary way and says so.

use std::sync::Mutex;

/// Above WirePlumber's default (-20) and PulseAudio's (0), as a program the
/// user chose to give the card to for the length of a film should be.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const PRIORITY: i32 = 10;

/// The ALSA card an mpv device name is on, by the card's id:
/// `alsa/hdmi:CARD=NVidia,DEV=0` → `NVidia`. None for anything that is not
/// an ALSA device named by card (`auto`, `pipewire/…`, `wasapi/…`).
pub fn card_id(device: &str) -> Option<&str> {
    let rest = device.strip_prefix("alsa/")?;
    let at = rest.find("CARD=")? + "CARD=".len();
    let id = &rest[at..];
    let id = &id[..id.find([',', ':']).unwrap_or(id.len())];
    (!id.is_empty()).then_some(id)
}

/// The reservation held now, if any: the card's bus name and the connection
/// that owns it. Dropping the connection gives the name back.
#[derive(Default)]
pub struct Reserved(Mutex<Option<Held>>);

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Held {
    /// The card's id, as in the device name.
    card: String,
    /// The bus name owned: `org.freedesktop.ReserveDevice1.Audio<N>`.
    name: String,
    #[cfg(target_os = "linux")]
    _bus: zbus::blocking::Connection,
}

/// Said out loud rather than left to the connection closing: the bus frees a
/// name when its owner disconnects, but zbus may keep the connection alive
/// for its own tasks a while after the last handle goes.
#[cfg(target_os = "linux")]
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self._bus.release_name(self.name.as_str());
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Held, PRIORITY};
    use zbus::blocking::{Connection, Proxy};
    use zbus::fdo::{RequestNameFlags, RequestNameReply};

    /// What a holder of the name answers, as the protocol asks of it. Kinema
    /// says no to anyone else while a film plays: the film is what the user
    /// asked the card for.
    struct Reservation {
        device: String,
    }

    #[zbus::interface(name = "org.freedesktop.ReserveDevice1")]
    impl Reservation {
        fn request_release(&self, _priority: i32) -> bool {
            false
        }
        #[zbus(property)]
        fn priority(&self) -> i32 {
            PRIORITY
        }
        #[zbus(property)]
        fn application_name(&self) -> String {
            "Kinema".into()
        }
        #[zbus(property)]
        fn application_device_name(&self) -> String {
            self.device.clone()
        }
    }

    /// `card1` → 1, through `/proc/asound/<id>`, a link to the card's folder.
    fn card_number(id: &str) -> Result<u32, String> {
        let link = std::fs::read_link(format!("/proc/asound/{id}"))
            .map_err(|e| format!("no sound card \"{id}\": {e}"))?;
        link.to_string_lossy()
            .strip_prefix("card")
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| format!("sound card \"{id}\" is at {}", link.display()))
    }

    pub fn reserve(device: &str, id: &str) -> Result<(Held, String), String> {
        reserve_card(device, id, card_number(id)?)
    }

    pub(super) fn reserve_card(device: &str, id: &str, card: u32) -> Result<(Held, String), String> {
        let name = format!("org.freedesktop.ReserveDevice1.Audio{card}");
        let path = format!("/org/freedesktop/ReserveDevice1/Audio{card}");
        let bus = Connection::session().map_err(|e| e.to_string())?;
        bus.object_server()
            .at(path.as_str(), Reservation { device: device.trim_start_matches("alsa/").into() })
            .map_err(|e| e.to_string())?;
        // zbus reports "someone else has it" as an error (NameTaken), not as
        // the bus's Exists reply; both mean the same here.
        let ask = |flags| match bus.request_name_with_flags(name.as_str(), flags) {
            Ok(reply) => Ok(reply),
            Err(zbus::Error::NameTaken) => Ok(RequestNameReply::Exists),
            Err(e) => Err(e.to_string()),
        };

        let said = match ask(RequestNameFlags::DoNotQueue.into())? {
            RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner => {
                "the card was free".to_string()
            }
            _ => {
                // Someone has it: ask them, if we outrank them.
                let holder = Proxy::new(&bus, name.as_str(), path.as_str(), "org.freedesktop.ReserveDevice1")
                    .map_err(|e| e.to_string())?;
                let who: String = holder.get_property("ApplicationName").unwrap_or_default();
                let theirs: i32 = holder.get_property("Priority").unwrap_or(i32::MIN);
                if theirs >= PRIORITY {
                    return Err(format!("{who} holds it at priority {theirs}"));
                }
                let released: bool = holder
                    .call("RequestRelease", &(PRIORITY,))
                    .map_err(|e| format!("{who} did not answer: {e}"))?;
                if !released {
                    return Err(format!("{who} would not let it go"));
                }
                match ask(RequestNameFlags::ReplaceExisting | RequestNameFlags::DoNotQueue)? {
                    RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner => {
                        format!("{who} let it go")
                    }
                    other => return Err(format!("{who} let it go, but the name was not ours: {other:?}")),
                }
            }
        };
        Ok((Held { card: id.to_string(), name, _bus: bus }, said))
    }
}

/// Before a film that goes straight to `device`: take its card from the sound
/// server. Returns what happened, for the log; does nothing for a device that
/// is not an ALSA card (Windows, `auto`).
#[tauri::command]
pub async fn reserve_audio_device(
    state: tauri::State<'_, Reserved>,
    device: String,
) -> Result<String, String> {
    let Some(id) = card_id(&device).map(str::to_string) else {
        return Ok(format!("{device} is not a card to reserve"));
    };
    #[cfg(target_os = "linux")]
    {
        {
            let mut held = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(h) = held.as_ref().filter(|h| h.card == id) {
                return Ok(format!("{} already held", h.name));
            }
            // A different card: give the old one back first.
            *held = None;
        }
        let (h, said) = crate::jobs::off_main(move || linux::reserve(&device, &id)).await?;
        let line = format!("{}: {said}", h.name);
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(h);
        Ok(line)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, id);
        Ok("nothing to reserve on this system".into())
    }
}

/// After the film (leaving the player, or falling back to the ordinary
/// path): give the card back to the sound server.
#[tauri::command]
pub fn release_audio_device(state: tauri::State<'_, Reserved>) -> Option<String> {
    let mut held = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // Dropping it (Drop above) is what gives the name back.
    held.take().map(|h| h.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_is_read_from_mpvs_device_name() {
        assert_eq!(card_id("alsa/hdmi:CARD=NVidia,DEV=0"), Some("NVidia"));
        assert_eq!(card_id("alsa/plughw:CARD=PCH,DEV=0"), Some("PCH"));
        assert_eq!(card_id("alsa/hdmi:CARD=Generic"), Some("Generic"));
        assert_eq!(card_id("auto"), None);
        assert_eq!(card_id("pipewire/alsa_output.hdmi"), None);
        assert_eq!(card_id("wasapi/{0000}"), None);
        assert_eq!(card_id("alsa/default"), None);
    }

    /// The protocol against a stand-in for the sound server on a real session
    /// bus: `scripts/reserve-holder.py` holds card 7 at WirePlumber's priority
    /// and lets go when asked. Ignored: it needs that bus and that script
    /// running (see the script).
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn takes_the_card_from_a_holder_that_agrees_and_gives_it_back() {
        use zbus::blocking::fdo::DBusProxy;
        let watch = zbus::blocking::Connection::session().unwrap();
        let bus = DBusProxy::new(&watch).unwrap();
        let name = "org.freedesktop.ReserveDevice1.Audio7";
        let owner = || bus.get_name_owner(name.try_into().unwrap()).ok().map(|o| o.to_string());
        let before = owner().expect("the holder script owns the name");

        let (held, said) = linux::reserve_card("alsa/hdmi:CARD=Test,DEV=0", "Test", 7).unwrap();
        println!("reserved: {said}");
        let ours = owner().unwrap();
        assert_ne!(ours, before, "the name moved to Kinema");

        drop(held);
        // The holder takes it back when it is free again.
        let back = (0..50).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            owner().filter(|o| *o != ours)
        });
        println!("after release: {back:?}");
        assert!(back.is_some(), "the holder took the card back");
    }
}
