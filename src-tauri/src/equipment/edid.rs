//! What a screen says about itself in its EDID: who made it, its name, and
//! whether — and how brightly — it can show HDR.
//!
//! Only what the equipment check needs and the desktop does not already say.
//! The modes come from the desktop (it knows which ones it can drive, which
//! the EDID alone does not), so the timing blocks are not read at all.
//!
//! Pure: bytes in, facts out. Linux reads the bytes from
//! `/sys/class/drm/<card>-<connector>/edid`; Windows asks its own API for the
//! same facts and never comes here.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[derive(Debug, Clone, PartialEq)]
pub struct Edid {
    /// The three-letter PNP maker code, "SAM", "GSM", "DEL".
    pub maker: String,
    pub product: u16,
    pub serial: u32,
    /// The monitor name descriptor, when there is one.
    pub name: Option<String>,
    /// The HDR static metadata block (CTA-861.3), when there is one.
    pub hdr: Option<HdrStatic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HdrStatic {
    /// SMPTE ST 2084 — HDR10's transfer function.
    pub pq: bool,
    /// Hybrid log-gamma.
    pub hlg: bool,
    /// "Desired content max luminance", in nits: the screen's peak.
    pub max_nits: Option<f32>,
    pub frame_average_nits: Option<f32>,
    pub min_nits: Option<f32>,
}

const HEADER: [u8; 8] = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];

pub fn parse(bytes: &[u8]) -> Option<Edid> {
    if bytes.len() < 128 || bytes[..8] != HEADER {
        return None;
    }
    let code = u16::from_be_bytes([bytes[8], bytes[9]]);
    let letter = |shift: u16| char::from(b'@' + ((code >> shift) & 0x1F) as u8);
    let maker: String = [letter(10), letter(5), letter(0)].iter().collect();
    let product = u16::from_le_bytes([bytes[10], bytes[11]]);
    let serial = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);

    // Four 18-byte descriptors; a display descriptor starts 00 00 00 <tag>,
    // and tag FC is the monitor name, ended by a line feed.
    let name = [54usize, 72, 90, 108].iter().find_map(|&at| {
        let d = &bytes[at..at + 18];
        (d[0] == 0 && d[1] == 0 && d[2] == 0 && d[3] == 0xFC).then(|| {
            let text = &d[5..18];
            let end = text.iter().position(|&c| c == 0x0A).unwrap_or(text.len());
            String::from_utf8_lossy(&text[..end]).trim().to_string()
        })
    });
    let name = name.filter(|n| !n.is_empty());

    let extensions = usize::from(bytes[126]);
    let hdr = (1..=extensions)
        .filter_map(|k| bytes.get(128 * k..128 * (k + 1)))
        .filter(|block| block[0] == 0x02)
        .find_map(hdr_static);

    Some(Edid { maker, product, serial, name, hdr })
}

/// The HDR static metadata data block of one CTA-861 extension: an extended
/// block (tag 7) of extended tag 6.
fn hdr_static(block: &[u8]) -> Option<HdrStatic> {
    let end = usize::from(block[2]).min(127);
    let mut at = 4;
    while at < end {
        let tag = block[at] >> 5;
        let len = usize::from(block[at] & 0x1F);
        let body = block.get(at + 1..=at + len)?;
        if tag == 7 && len >= 3 && body[0] == 6 {
            let eotf = body[1];
            // Code values: peak and frame average are 50·2^(v/32) nits; the
            // minimum is a fraction of the peak, peak·(v/255)²/100. Zero, or
            // a block too short to hold one, means "not given".
            let max = body.get(3).copied().filter(|&v| v > 0).map(luminance);
            let average = body.get(4).copied().filter(|&v| v > 0).map(luminance);
            let min = match (max, body.get(5).copied()) {
                (Some(peak), Some(v)) => Some(peak * (f32::from(v) / 255.0).powi(2) / 100.0),
                _ => None,
            };
            return Some(HdrStatic {
                pq: eotf & 0x04 != 0,
                hlg: eotf & 0x08 != 0,
                max_nits: max,
                frame_average_nits: average,
                min_nits: min,
            });
        }
        at += 1 + len;
    }
    None
}

fn luminance(code: u8) -> f32 {
    50.0 * 2f32.powf(f32::from(code) / 32.0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A made-up screen: maker "KIN", product 0x1234, serial 7, named
    /// "Test TV", with one CTA extension holding an HDR block — or not.
    pub(crate) fn sample(hdr_block: Option<&[u8]>) -> Vec<u8> {
        let mut base = vec![0u8; 128];
        base[..8].copy_from_slice(&HEADER);
        // K=11, I=9, N=14 → 0b0_01011_01001_01110
        let code: u16 = (11 << 10) | (9 << 5) | 14;
        base[8..10].copy_from_slice(&code.to_be_bytes());
        base[10..12].copy_from_slice(&0x1234u16.to_le_bytes());
        base[12..16].copy_from_slice(&7u32.to_le_bytes());
        // A detailed timing first (non-zero), then the name descriptor.
        base[54] = 0x01;
        base[72..77].copy_from_slice(&[0, 0, 0, 0xFC, 0]);
        let name = b"Test TV\n     ";
        base[77..90].copy_from_slice(name);
        let Some(hdr) = hdr_block else { return base };
        base[126] = 1;
        let mut ext = vec![0u8; 128];
        ext[0] = 0x02;
        ext[1] = 0x03;
        // A video block of two VICs first, so the HDR block is not the first.
        let mut at = 4;
        ext[at..at + 3].copy_from_slice(&[(2 << 5) | 2, 16, 93]);
        at += 3;
        ext[at] = (7 << 5) | hdr.len() as u8;
        ext[at + 1..at + 1 + hdr.len()].copy_from_slice(hdr);
        at += 1 + hdr.len();
        ext[2] = at as u8;
        base.extend(ext);
        base
    }

    #[test]
    fn reads_the_maker_product_serial_and_name() {
        let e = parse(&sample(None)).unwrap();
        assert_eq!((e.maker.as_str(), e.product, e.serial), ("KIN", 0x1234, 7));
        assert_eq!(e.name.as_deref(), Some("Test TV"));
        assert_eq!(e.hdr, None);
    }

    #[test]
    fn reads_an_hdr10_screens_brightness() {
        // Extended tag 6; EOTF: SDR, ST 2084, HLG; static metadata type 1;
        // max 0x6E (≈ 542 nits), frame average 0x5A (≈ 351), min 0x2E.
        let e = parse(&sample(Some(&[6, 0b1101, 1, 0x6E, 0x5A, 0x2E]))).unwrap();
        let hdr = e.hdr.unwrap();
        assert!(hdr.pq && hdr.hlg);
        assert_eq!(hdr.max_nits.map(f32::round), Some(542.0));
        assert_eq!(hdr.frame_average_nits.map(f32::round), Some(351.0));
        let min = hdr.min_nits.unwrap();
        assert!((0.17..0.18).contains(&min), "{min}");
    }

    #[test]
    fn an_hdr_block_without_brightness_still_says_what_it_can_show() {
        let e = parse(&sample(Some(&[6, 0b0101, 1]))).unwrap();
        let hdr = e.hdr.unwrap();
        assert!(hdr.pq && !hdr.hlg);
        assert_eq!((hdr.max_nits, hdr.min_nits), (None, None));
    }

    #[test]
    fn garbage_is_not_a_screen() {
        assert_eq!(parse(&[0u8; 128]), None);
        assert_eq!(parse(&HEADER), None);
    }
}
