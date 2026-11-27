//! The XML of an aggregate report, out of its attachment. Receivers send
//! `.xml.gz` (most), `.zip` (one XML entry) or plain `.xml`. The format is
//! told by the bytes, not the name or the MIME type, which receivers get
//! wrong. Anyone can mail the report address, so every size is capped before
//! it is read: a decompression bomb stops at [`MAX_XML_BYTES`].

use std::io::Read;

/// The largest attachment read.
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
/// The most XML one attachment may hold once decompressed.
pub const MAX_XML_BYTES: usize = 50 * 1024 * 1024;

/// Why an attachment holds no readable report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    /// Not gzip, zip or XML.
    Unknown,
    /// Over [`MAX_ATTACHMENT_BYTES`] or, decompressed, [`MAX_XML_BYTES`].
    TooLarge,
    /// A broken or unsupported archive (encrypted, zip64, another method).
    Corrupt(&'static str),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown => f.write_str("not a gzip, zip or XML attachment"),
            Self::TooLarge => f.write_str("attachment too large"),
            Self::Corrupt(why) => write!(f, "corrupt archive: {why}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

/// What the bytes are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Gzip,
    Zip,
    Xml,
}

/// The format of `bytes`, from their first bytes.
pub fn kind(bytes: &[u8]) -> Option<Kind> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Some(Kind::Gzip);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return Some(Kind::Zip);
    }
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let first = text.iter().find(|byte| !byte.is_ascii_whitespace())?;
    (*first == b'<').then_some(Kind::Xml)
}

/// The report XML in `bytes`, as text.
///
/// # Errors
///
/// [`ArchiveError`] when the bytes are no report archive, too large, or
/// broken.
pub fn extract(bytes: &[u8]) -> Result<String, ArchiveError> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(ArchiveError::TooLarge);
    }
    let xml = match kind(bytes).ok_or(ArchiveError::Unknown)? {
        Kind::Gzip => read_capped(flate2::read::MultiGzDecoder::new(bytes))?,
        Kind::Zip => unzip_first_xml(bytes)?,
        Kind::Xml => bytes.to_vec(),
    };
    if xml.len() > MAX_XML_BYTES {
        return Err(ArchiveError::TooLarge);
    }
    let text = match String::from_utf8(xml) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(text))
}

/// Everything `reader` yields, up to [`MAX_XML_BYTES`].
fn read_capped(reader: impl Read) -> Result<Vec<u8>, ArchiveError> {
    let mut out = Vec::new();
    let cap = u64::try_from(MAX_XML_BYTES).unwrap_or(u64::MAX) + 1;
    reader
        .take(cap)
        .read_to_end(&mut out)
        .map_err(|_| ArchiveError::Corrupt("decompression failed"))?;
    if out.len() > MAX_XML_BYTES {
        return Err(ArchiveError::TooLarge);
    }
    Ok(out)
}

fn u16_at(bytes: &[u8], at: usize) -> Result<usize, ArchiveError> {
    bytes
        .get(at..at + 2)
        .map(|b| usize::from(u16::from_le_bytes([b[0], b[1]])))
        .ok_or(ArchiveError::Corrupt("truncated"))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<usize, ArchiveError> {
    bytes
        .get(at..at + 4)
        .and_then(|b| usize::try_from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok())
        .ok_or(ArchiveError::Corrupt("truncated"))
}

const EOCD: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const CENTRAL: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
const LOCAL: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];

/// The first `.xml` entry of a zip archive (or its first entry when none is
/// named so), read through the central directory, as entries written with a
/// data descriptor carry no sizes in their local header. Stored and deflated
/// entries only; encrypted and zip64 archives are refused.
fn unzip_first_xml(bytes: &[u8]) -> Result<Vec<u8>, ArchiveError> {
    // The end-of-central-directory record: 22 bytes plus a comment of at
    // most 64 KiB, at the end.
    let search_from = bytes.len().saturating_sub(22 + 65_535);
    let eocd = bytes[search_from..]
        .windows(4)
        .rposition(|window| window == EOCD)
        .map(|at| search_from + at)
        .ok_or(ArchiveError::Corrupt("no end of central directory"))?;
    let entries = u16_at(bytes, eocd + 10)?;
    let mut at = u32_at(bytes, eocd + 16)?;
    if entries == 0 || at == 0xffff_ffff {
        return Err(ArchiveError::Corrupt("empty or zip64 archive"));
    }
    let mut chosen = None;
    for _ in 0..entries.min(64) {
        if bytes.get(at..at + 4) != Some(&CENTRAL[..]) {
            return Err(ArchiveError::Corrupt("bad central directory"));
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        let compressed = u32_at(bytes, at + 20)?;
        let name_len = u16_at(bytes, at + 28)?;
        let extra_len = u16_at(bytes, at + 30)?;
        let comment_len = u16_at(bytes, at + 32)?;
        let local = u32_at(bytes, at + 42)?;
        let name = bytes
            .get(at + 46..at + 46 + name_len)
            .ok_or(ArchiveError::Corrupt("truncated"))?;
        let entry = (flags, method, compressed, local);
        let is_xml = name.to_ascii_lowercase().ends_with(b".xml");
        if is_xml {
            chosen = Some(entry);
            break;
        }
        if chosen.is_none() {
            chosen = Some(entry);
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    let (flags, method, compressed, local) = chosen.ok_or(ArchiveError::Corrupt("no entry"))?;
    if flags & 1 != 0 {
        return Err(ArchiveError::Corrupt("encrypted entry"));
    }
    if compressed == 0xffff_ffff || local == 0xffff_ffff {
        return Err(ArchiveError::Corrupt("zip64 entry"));
    }
    if bytes.get(local..local + 4) != Some(&LOCAL[..]) {
        return Err(ArchiveError::Corrupt("bad local header"));
    }
    let start = local + 30 + u16_at(bytes, local + 26)? + u16_at(bytes, local + 28)?;
    let data = bytes
        .get(start..start + compressed)
        .ok_or(ArchiveError::Corrupt("truncated entry"))?;
    match method {
        0 => Ok(data.to_vec()),
        8 => read_capped(flate2::read::DeflateDecoder::new(data)),
        _ => Err(ArchiveError::Corrupt("unsupported compression method")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use super::*;

    pub(crate) fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).expect("gzip");
        encoder.finish().expect("gzip")
    }

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).expect("deflate");
        encoder.finish().expect("deflate")
    }

    fn le16(value: usize) -> [u8; 2] {
        u16::try_from(value).expect("u16").to_le_bytes()
    }

    fn le32(value: usize) -> [u8; 4] {
        u32::try_from(value).expect("u32").to_le_bytes()
    }

    /// A one-entry zip archive, deflated, sizes in the central directory
    /// only (as with a data descriptor).
    pub(crate) fn zip(name: &str, data: &[u8]) -> Vec<u8> {
        let packed = deflate(data);
        let mut out = Vec::new();
        out.extend_from_slice(&LOCAL);
        out.extend_from_slice(&[20, 0, 8, 0, 8, 0, 0, 0, 0, 0]); // version, flags (descriptor), method, time, date
        out.extend_from_slice(&[0; 12]); // crc, sizes: in the descriptor
        out.extend_from_slice(&le16(name.len()));
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&packed);
        let central = out.len();
        out.extend_from_slice(&CENTRAL);
        out.extend_from_slice(&[20, 0, 20, 0, 8, 0, 8, 0, 0, 0, 0, 0]); // versions, flags, method, time, date
        out.extend_from_slice(&[0; 4]); // crc (unchecked)
        out.extend_from_slice(&le32(packed.len()));
        out.extend_from_slice(&le32(data.len()));
        out.extend_from_slice(&le16(name.len()));
        out.extend_from_slice(&[0; 12]); // extra, comment, disk, attributes
        out.extend_from_slice(&le32(0)); // local header at 0
        out.extend_from_slice(name.as_bytes());
        let size = out.len() - central;
        out.extend_from_slice(&EOCD);
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&le16(1));
        out.extend_from_slice(&le16(1));
        out.extend_from_slice(&le32(size));
        out.extend_from_slice(&le32(central));
        out.extend_from_slice(&le16(0));
        out
    }

    #[test]
    fn reads_gzip_zip_and_plain_xml() {
        let xml = b"<?xml version=\"1.0\"?><feedback/>";
        assert_eq!(
            extract(&gzip(xml)).expect("gzip"),
            String::from_utf8_lossy(xml)
        );
        assert_eq!(
            extract(&zip("google.com!acme.test!1!2.xml", xml)).expect("zip"),
            String::from_utf8_lossy(xml)
        );
        assert_eq!(
            extract(b"\xef\xbb\xbf  <feedback/>").expect("xml"),
            "  <feedback/>"
        );
    }

    #[test]
    fn refuses_what_is_not_a_report() {
        assert_eq!(extract(b"%PDF-1.7"), Err(ArchiveError::Unknown));
        assert!(matches!(
            extract(b"PK\x03\x04broken"),
            Err(ArchiveError::Corrupt(_))
        ));
        assert!(matches!(
            extract(&[0x1f, 0x8b, 0, 0]),
            Err(ArchiveError::Corrupt(_))
        ));
    }

    #[test]
    fn a_bomb_stops_at_the_cap() {
        let zeros = vec![b' '; MAX_XML_BYTES + 10];
        let bomb = gzip(&zeros);
        assert!(bomb.len() < MAX_ATTACHMENT_BYTES);
        assert_eq!(extract(&bomb), Err(ArchiveError::TooLarge));
    }
}
