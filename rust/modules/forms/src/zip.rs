//! A minimal ZIP writer for the XLSX export (`@weldsuite/zip-xml`'s
//! `writeZip`): the entries in the order given, UTF-8 names, sizes in the
//! local headers (no data descriptors). Entries are stored, not deflated:
//! every reader of an Office package takes both, and the export is small
//! next to the 50,000-row cap's worth of XML text it may carry.

/// `crc32(bytes)` (IEEE 802.3, as zip uses it).
fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::LazyLock<[u32; 256]> = std::sync::LazyLock::new(|| {
        let mut table = [0u32; 256];
        for (n, slot) in table.iter_mut().enumerate() {
            let mut c = u32::try_from(n).unwrap_or_default();
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        table
    });
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        let index = usize::from(u8::try_from(crc & 0xFF).unwrap_or_default() ^ byte);
        crc = TABLE[index] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// The DOS time and date of a UTC moment in ms (`dosDateTime`).
fn dos_date_time(ms: i64) -> (u16, u16) {
    let at = time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000))
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let year = at.year().max(1980);
    let time =
        (u16::from(at.hour()) << 11) | (u16::from(at.minute()) << 5) | u16::from(at.second() / 2);
    let date = (u16::try_from(year - 1980).unwrap_or_default() << 9)
        | (u16::from(u8::from(at.month())) << 5)
        | u16::from(at.day());
    (time, date)
}

fn u16_le(out: &mut Vec<u8>, n: u16) {
    out.extend_from_slice(&n.to_le_bytes());
}

fn u32_le(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_le_bytes());
}

/// `writeZip(files, { date })`.
pub(crate) fn write_zip(files: &[(&str, Vec<u8>)], now_ms: i64) -> Vec<u8> {
    const LOCAL: u32 = 0x0403_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const END: u32 = 0x0605_4b50;
    let (time, date) = dos_date_time(now_ms);
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, bytes) in files {
        let offset = u32::try_from(out.len()).unwrap_or(u32::MAX);
        let crc = crc32(bytes);
        let size = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        let name_len = u16::try_from(name.len()).unwrap_or(u16::MAX);

        u32_le(&mut out, LOCAL);
        u16_le(&mut out, 20); // version needed
        u16_le(&mut out, 0x0800); // UTF-8 names
        u16_le(&mut out, 0); // stored
        u16_le(&mut out, time);
        u16_le(&mut out, date);
        u32_le(&mut out, crc);
        u32_le(&mut out, size);
        u32_le(&mut out, size);
        u16_le(&mut out, name_len);
        u16_le(&mut out, 0);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(bytes);

        u32_le(&mut central, CENTRAL);
        u16_le(&mut central, 20); // made by
        u16_le(&mut central, 20); // needed
        u16_le(&mut central, 0x0800);
        u16_le(&mut central, 0);
        u16_le(&mut central, time);
        u16_le(&mut central, date);
        u32_le(&mut central, crc);
        u32_le(&mut central, size);
        u32_le(&mut central, size);
        u16_le(&mut central, name_len);
        u16_le(&mut central, 0); // extra
        u16_le(&mut central, 0); // comment
        u16_le(&mut central, 0); // disk
        u16_le(&mut central, 0); // internal attributes
        u32_le(&mut central, 0); // external attributes
        u32_le(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    let directory_offset = u32::try_from(out.len()).unwrap_or(u32::MAX);
    let directory_size = u32::try_from(central.len()).unwrap_or(u32::MAX);
    let count = u16::try_from(files.len()).unwrap_or(u16::MAX);
    out.extend_from_slice(&central);
    u32_le(&mut out, END);
    u16_le(&mut out, 0);
    u16_le(&mut out, 0);
    u16_le(&mut out, count);
    u16_le(&mut out, count);
    u32_le(&mut out, directory_size);
    u32_le(&mut out, directory_offset);
    u16_le(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_and_layout() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        let zip = write_zip(&[("a.txt", b"hi".to_vec())], 0);
        assert_eq!(&zip[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert_eq!(&zip[30..35], b"a.txt");
        assert_eq!(&zip[35..37], b"hi");
        assert_eq!(
            &zip[zip.len() - 22..zip.len() - 18],
            &[0x50, 0x4b, 0x05, 0x06]
        );
    }
}
