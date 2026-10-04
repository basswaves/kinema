//! Asking an SMB server which shares it has: one DCE/RPC call,
//! `NetrShareEnum` on the `srvsvc` pipe, in its classic 32-bit encoding (NDR).
//!
//! The SMB library has this call, but only in the 64-bit encoding (NDR64),
//! which Samba — the server inside nearly every home NAS — refuses
//! ("ProposedTransferSyntaxesNotSupported"). Every server takes NDR, so
//! Kinema sends that itself: a bind, then the call, written and read here as
//! bytes ([MS-RPCE], [MS-SRVS] 3.1.4.8). Only the disk shares a person would
//! pick come back: not printers, and not the hidden ones (`IPC$`, `C$`).

use std::io;

const SRVSVC: [u8; 16] = guid(0x4b32_4fc8, 0x1670, 0x01d3, [0x12, 0x78, 0x5a, 0x47, 0xbf, 0x6e, 0xe1, 0x88]);
const NDR: [u8; 16] = guid(0x8a88_5d04, 0x1ceb, 0x11c9, [0x9f, 0xe8, 0x08, 0x00, 0x2b, 0x10, 0x48, 0x60]);
const NETR_SHARE_ENUM: u16 = 15;
/// The largest reply asked for. A home server's share list is a few hundred
/// bytes; a reply in several fragments is refused below rather than half-read.
pub const MAX_FRAGMENT: u16 = 65_280;

/// A GUID as it goes on the wire: the first three parts little-endian.
const fn guid(a: u32, b: u16, c: u16, d: [u8; 8]) -> [u8; 16] {
    let a = a.to_le_bytes();
    let b = b.to_le_bytes();
    let c = c.to_le_bytes();
    [a[0], a[1], a[2], a[3], b[0], b[1], c[0], c[1], d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("the server's share list: {what}"))
}

/// The common 16-byte header of a connection-oriented RPC packet.
fn header(kind: u8, length: usize, call_id: u32) -> Vec<u8> {
    let mut p = vec![5, 0, kind, 0x03, 0x10, 0, 0, 0];
    p.extend((length as u16).to_le_bytes());
    p.extend(0u16.to_le_bytes()); // no authentication
    p.extend(call_id.to_le_bytes());
    p
}

/// Bind to srvsvc 3.0 in NDR.
pub fn bind() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(MAX_FRAGMENT.to_le_bytes()); // largest packet we send
    body.extend(MAX_FRAGMENT.to_le_bytes()); // largest we take
    body.extend(0u32.to_le_bytes()); // a new association
    body.extend([1, 0, 0, 0]); // one context
    body.extend(0u16.to_le_bytes()); // its id
    body.extend([1, 0]); // one transfer syntax
    body.extend(SRVSVC);
    body.extend(3u16.to_le_bytes());
    body.extend(0u16.to_le_bytes());
    body.extend(NDR);
    body.extend(2u32.to_le_bytes());
    let mut p = header(11, 16 + body.len(), 1);
    p.extend(body);
    p
}

/// Whether the server took the bind (a `bind_ack` whose one result is 0).
pub fn check_bind(reply: &[u8]) -> io::Result<()> {
    if reply.len() < 26 || reply[2] != 12 {
        return Err(bad("the server did not take the request"));
    }
    // After the header and the fragment sizes and group: the secondary
    // address, its length first, then padding to four bytes.
    let address_len = u16::from_le_bytes([reply[24], reply[25]]) as usize;
    let results = (26 + address_len).div_ceil(4) * 4;
    let accepted = reply.get(results + 4..results + 6).map(|r| u16::from_le_bytes([r[0], r[1]]));
    match accepted {
        Some(0) => Ok(()),
        Some(_) => Err(bad("the server refused the request")),
        None => Err(bad("cut short")),
    }
}

/// Writes NDR, keeping each value on its natural boundary.
struct Writer(Vec<u8>);

impl Writer {
    fn align(&mut self) {
        while !self.0.len().is_multiple_of(4) {
            self.0.push(0);
        }
    }
    fn u32(&mut self, v: u32) {
        self.align();
        self.0.extend(v.to_le_bytes());
    }
    /// A conformant varying string of UTF-16, ending in a zero.
    fn string(&mut self, s: &str) {
        let units: Vec<u16> = s.encode_utf16().chain([0]).collect();
        self.u32(units.len() as u32);
        self.u32(0);
        self.u32(units.len() as u32);
        for u in units {
            self.0.extend(u.to_le_bytes());
        }
        self.align();
    }
}

/// `NetrShareEnum(\\server, level 1, everything)`.
pub fn share_enum(server: &str) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    w.u32(0x0002_0000); // the server's name: present
    w.string(&format!("\\\\{server}"));
    w.u32(1); // level 1: names, kinds, remarks
    w.u32(1); // the union's tag, the same
    w.u32(0x0002_0004); // the container: present
    w.u32(0); // no entries yet
    w.u32(0); // no array yet
    w.u32(u32::MAX); // as many as there are
    w.u32(0x0002_0008); // the resume point: present
    w.u32(0); // from the start
    let stub = w.0;
    let mut p = header(0, 24 + stub.len(), 2);
    p.extend((stub.len() as u32).to_le_bytes()); // allocation hint
    p.extend(0u16.to_le_bytes()); // context 0
    p.extend(NETR_SHARE_ENUM.to_le_bytes());
    p.extend(stub);
    p
}

/// Reads NDR back.
struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> io::Result<u32> {
        self.at = self.at.div_ceil(4) * 4;
        let b = self.data.get(self.at..self.at + 4).ok_or_else(|| bad("cut short"))?;
        self.at += 4;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn string(&mut self) -> io::Result<String> {
        let _max = self.u32()?;
        let _offset = self.u32()?;
        let count = self.u32()? as usize;
        let bytes = self.data.get(self.at..self.at + count * 2).ok_or_else(|| bad("cut short"))?;
        self.at += count * 2;
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        Ok(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string())
    }
}

/// The disk shares in a `NetrShareEnum` reply, in the server's order.
pub fn parse_share_enum(reply: &[u8]) -> io::Result<Vec<String>> {
    if reply.len() < 24 || reply[2] != 2 {
        return Err(bad("not an answer"));
    }
    if reply[3] & 0x03 != 0x03 {
        return Err(bad("in several parts, which Kinema does not read"));
    }
    let mut r = Reader { data: &reply[24..], at: 0 };
    let _level = r.u32()?;
    let _tag = r.u32()?;
    let mut shares = Vec::new();
    // The container and its array may each be absent (a refusal sends
    // neither); the call's result after them is read either way.
    if r.u32()? != 0 {
        let count = r.u32()? as usize;
        if r.u32()? != 0 {
            let _max = r.u32()?;
            let mut entries = Vec::with_capacity(count.min(1024));
            for _ in 0..count {
                let name = r.u32()?;
                let kind = r.u32()?;
                let remark = r.u32()?;
                entries.push((name != 0, kind, remark != 0));
            }
            for (has_name, kind, has_remark) in entries {
                let name = if has_name { r.string()? } else { String::new() };
                if has_remark {
                    r.string()?;
                }
                // Disk shares only (kind 0), not the hidden or special ones.
                if kind == 0 && !name.is_empty() && !name.ends_with('$') {
                    shares.push(name);
                }
            }
        }
    }
    // The call's own result, last.
    let _total = r.u32()?;
    if r.u32()? != 0 {
        let _resume = r.u32()?;
    }
    match r.u32()? {
        0 => Ok(shares),
        5 => Err(io::Error::new(io::ErrorKind::PermissionDenied, "the server will not list its shares")),
        code => Err(bad(&format!("error {code}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bind_and_the_call_are_what_the_protocol_says() {
        let b = bind();
        assert_eq!(&b[..4], &[5, 0, 11, 3]);
        assert_eq!(u16::from_le_bytes([b[8], b[9]]) as usize, b.len());
        // srvsvc's GUID as Windows and Samba send it.
        assert_eq!(&b[32..36], &[0xc8, 0x4f, 0x32, 0x4b]);
        let c = share_enum("nas");
        assert_eq!(c[2], 0);
        assert_eq!(u16::from_le_bytes([c[22], c[23]]), 15);
        assert_eq!(u16::from_le_bytes([c[8], c[9]]) as usize, c.len());
    }

    fn reply(stub: Vec<u8>) -> Vec<u8> {
        let mut p = header(2, 24 + stub.len(), 2);
        p.extend((stub.len() as u32).to_le_bytes());
        p.extend([0, 0, 0, 0]);
        p.extend(stub);
        p
    }

    #[test]
    fn disk_shares_come_back_and_the_rest_do_not() {
        let mut w = Writer(Vec::new());
        w.u32(1);
        w.u32(1);
        w.u32(0x20000);
        w.u32(4);
        w.u32(0x20004);
        w.u32(4);
        for (kind, remark) in [(0u32, true), (0, false), (0x8000_0003, true), (1, true)] {
            w.u32(0x20008);
            w.u32(kind);
            w.u32(if remark { 0x2000c } else { 0 });
        }
        for (name, remark) in [("films", Some("Films")), ("TV shows", None), ("IPC$", Some("IPC")), ("printer", Some("A printer"))] {
            w.string(name);
            if let Some(r) = remark {
                w.string(r);
            }
        }
        w.u32(4);
        w.u32(0x20010);
        w.u32(0);
        w.u32(0);
        assert_eq!(parse_share_enum(&reply(w.0)).unwrap(), ["films", "TV shows"]);
    }

    #[test]
    fn a_refusal_is_said_as_one() {
        let mut w = Writer(Vec::new());
        for v in [1, 1, 0x20000, 0, 0, 0, 0, 5] {
            w.u32(v);
        }
        assert_eq!(parse_share_enum(&reply(w.0)).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
}
