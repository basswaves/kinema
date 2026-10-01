//! What an HDMI or DisplayPort sink — a TV, or the receiver in front of it —
//! announced it can play: the ELD (EDID-Like Data) the graphics card's sound
//! device keeps for each output, built from the sink's own EDID.
//!
//! This is the Linux equivalent of asking Windows "would this device accept
//! TrueHD?" — and a more direct one: it is the receiver's own list, the same
//! one Windows' driver answers from. The layout is the HD Audio
//! specification's (§7.3.3.34), as the kernel's `hda_eld.c` reads it.
//!
//! Pure: bytes in, facts out. `linux.rs` reads the bytes from ALSA's `ELD`
//! control of each HDMI PCM device.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[derive(Debug, Clone, PartialEq)]
pub struct Eld {
    /// What the sink calls itself. A receiver often answers with the TV's
    /// name, as it passes the TV's EDID on with its own audio list in it.
    pub monitor_name: String,
    /// "HDMI" or "DisplayPort".
    pub connection: &'static str,
    pub sads: Vec<Sad>,
}

/// One Short Audio Descriptor: a format, and the most channels and the sample
/// rates it is taken at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sad {
    pub format: u8,
    pub channels: u8,
    /// Bit 0 32 kHz … bit 6 192 kHz.
    pub rates: u8,
}

pub const LPCM: u8 = 1;
pub const AC3: u8 = 2;
pub const DTS: u8 = 7;
pub const EAC3: u8 = 10;
pub const DTS_HD: u8 = 11;
pub const MLP: u8 = 12;

pub fn parse(bytes: &[u8]) -> Option<Eld> {
    // ELD version 2 is CEA-861-D, the only one with a complete baseline
    // block. Nothing connected reads as zeros — version 0.
    if bytes.len() < 20 || bytes[0] >> 3 != 2 {
        return None;
    }
    let baseline_end = 4 + usize::from(bytes[2]) * 4;
    let name_len = usize::from(bytes[4] & 0x1F);
    let sad_count = usize::from(bytes[5] >> 4);
    let connection = if (bytes[5] >> 2) & 0x3 == 1 { "DisplayPort" } else { "HDMI" };
    let name_end = 20 + name_len;
    let sads_end = name_end + 3 * sad_count;
    // The descriptors sit inside the baseline block, which sits inside what
    // was read; anything else is a damaged ELD.
    if sads_end > baseline_end || sads_end > bytes.len() {
        return None;
    }
    let monitor_name = String::from_utf8_lossy(&bytes[20..name_end]).trim().to_string();
    let sads = bytes[name_end..sads_end]
        .as_chunks::<3>()
        .0
        .iter()
        .map(|s| Sad { format: (s[0] >> 3) & 0x0F, channels: (s[0] & 0x07) + 1, rates: s[1] & 0x7F })
        .collect();
    Some(Eld { monitor_name, connection, sads })
}

impl Eld {
    fn has(&self, format: u8) -> bool {
        self.sads.iter().any(|s| s.format == format)
    }

    /// Whether the sink lists the format mpv's `--audio-spdif` names `codec`.
    /// A DTS-HD sink decodes DTS too: the core is part of every DTS-HD stream,
    /// and the specification does not oblige it to list both.
    pub fn takes(&self, codec: &str) -> bool {
        match codec {
            "ac3" => self.has(AC3),
            "eac3" => self.has(EAC3),
            "dts" => self.has(DTS) || self.has(DTS_HD),
            "dts-hd" => self.has(DTS_HD),
            "truehd" => self.has(MLP),
            _ => false,
        }
    }

    /// The most channels of plain PCM the sink takes.
    pub fn max_pcm_channels(&self) -> Option<u16> {
        self.sads.iter().filter(|s| s.format == LPCM).map(|s| u16::from(s.channels)).max()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// ELD bytes as the kernel hands them over: header, baseline block with
    /// the name and these descriptors (format, channels, rates byte).
    pub(crate) fn sample(name: &str, dp: bool, sads: &[(u8, u8, u8)]) -> Vec<u8> {
        let mut b = vec![0u8; 20];
        b[0] = 2 << 3;
        b[4] = (3 << 5) | name.len() as u8;
        b[5] = ((sads.len() as u8) << 4) | (u8::from(dp) << 2);
        b[7] = 0x5F;
        b.extend_from_slice(name.as_bytes());
        for &(format, channels, rates) in sads {
            b.extend_from_slice(&[(format << 3) | (channels - 1), rates, 0]);
        }
        while !b.len().is_multiple_of(4) {
            b.push(0);
        }
        b[2] = ((b.len() - 4) / 4) as u8;
        // ALSA's control is a fixed-size buffer; the rest is zeros.
        b.resize(128, 0);
        b
    }

    /// What a typical AV receiver announces: 8-channel PCM, every Dolby and
    /// DTS format, and DSD.
    pub(crate) fn receiver() -> Vec<u8> {
        sample(
            "AV Receiver",
            false,
            &[(LPCM, 2, 0x7F), (LPCM, 8, 0x7F), (AC3, 6, 0x07), (DTS, 7, 0x1E), (9, 6, 0x02),
              (EAC3, 8, 0x06), (MLP, 8, 0x14), (DTS_HD, 8, 0x14)],
        )
    }

    #[test]
    fn a_receiver_takes_every_bitstream() {
        let e = parse(&receiver()).unwrap();
        assert_eq!((e.monitor_name.as_str(), e.connection), ("AV Receiver", "HDMI"));
        for codec in ["ac3", "eac3", "dts", "dts-hd", "truehd"] {
            assert!(e.takes(codec), "{codec}");
        }
        assert_eq!(e.max_pcm_channels(), Some(8));
    }

    #[test]
    fn a_tv_takes_only_the_lossy_formats() {
        let e = parse(&sample("TV", false, &[(LPCM, 2, 0x07), (AC3, 6, 0x07), (EAC3, 6, 0x07)])).unwrap();
        assert!(e.takes("ac3") && e.takes("eac3"));
        assert!(!e.takes("dts") && !e.takes("truehd") && !e.takes("dts-hd"));
        assert_eq!(e.max_pcm_channels(), Some(2));
    }

    #[test]
    fn displayport_is_said_so() {
        let e = parse(&sample("Monitor", true, &[(LPCM, 2, 0x07)])).unwrap();
        assert_eq!(e.connection, "DisplayPort");
    }

    #[test]
    fn nothing_connected_is_no_eld() {
        assert_eq!(parse(&[0u8; 128]), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn a_truncated_eld_is_refused_rather_than_misread() {
        let mut b = receiver();
        b.truncate(30);
        assert_eq!(parse(&b), None);
    }
}
