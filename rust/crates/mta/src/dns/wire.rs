//! DNS messages (RFC 1035): building a query and reading the answer. Only
//! what an MTA asks: A, AAAA, MX, TXT, PTR (CNAMEs in an answer are skipped;
//! the recursive resolver has followed them).

use std::net::{Ipv4Addr, Ipv6Addr};

pub const TYPE_A: u16 = 1;
pub const TYPE_CNAME: u16 = 5;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_MX: u16 = 15;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_AAAA: u16 = 28;
const TYPE_OPT: u16 = 41;
const CLASS_IN: u16 = 1;

/// The response codes we act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rcode {
    NoError,
    /// The name does not exist.
    NxDomain,
    /// Any other failure (SERVFAIL, REFUSED, …): try again later.
    Failure(u8),
}

/// One answer record, decoded for the types we use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
    Mx {
        preference: u16,
        exchange: String,
    },
    /// The character-strings, joined (RFC 7208 §3.3).
    Txt(String),
    Ptr(String),
    Cname(String),
    Other(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub name: String,
    pub ttl: u32,
    pub record: Record,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub id: u16,
    pub truncated: bool,
    pub rcode: Rcode,
    pub answers: Vec<Answer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub &'static str);

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bad DNS message: {}", self.0)
    }
}

impl std::error::Error for WireError {}

/// A recursive query for `name`/`qtype` with an EDNS0 OPT record offering
/// 1232-byte UDP answers (the DNS flag day size).
pub fn build_query(id: u16, name: &str, qtype: u16) -> Result<Vec<u8>, WireError> {
    let mut out = Vec::with_capacity(32 + name.len());
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT
    out.extend_from_slice(&1u16.to_be_bytes()); // ARCOUNT (OPT)
    encode_name(name, &mut out)?;
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    // OPT: root name, type, UDP size, extended rcode/version/flags, rdlen.
    out.push(0);
    out.extend_from_slice(&TYPE_OPT.to_be_bytes());
    out.extend_from_slice(&1232u16.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    Ok(out)
}

fn encode_name(name: &str, out: &mut Vec<u8>) -> Result<(), WireError> {
    let name = name.trim_end_matches('.');
    if name.len() > 253 {
        return Err(WireError("name too long"));
    }
    if !name.is_empty() {
        for label in name.split('.') {
            let len = label.len();
            if len == 0 || len > 63 {
                return Err(WireError("bad label"));
            }
            out.push(u8::try_from(len).map_err(|_| WireError("bad label"))?);
            out.extend_from_slice(label.as_bytes());
        }
    }
    out.push(0);
    Ok(())
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, WireError> {
        let value = *self.data.get(self.pos).ok_or(WireError("short"))?;
        self.pos += 1;
        Ok(value)
    }

    fn u16(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }

    fn u32(&mut self) -> Result<u32, WireError> {
        Ok(u32::from_be_bytes([
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
        ]))
    }

    fn bytes(&mut self, len: usize) -> Result<&'a [u8], WireError> {
        let end = self.pos.checked_add(len).ok_or(WireError("short"))?;
        let slice = self.data.get(self.pos..end).ok_or(WireError("short"))?;
        self.pos = end;
        Ok(slice)
    }

    /// A possibly compressed name starting at the cursor.
    fn name(&mut self) -> Result<String, WireError> {
        let (name, next) = read_name(self.data, self.pos)?;
        self.pos = next;
        Ok(name)
    }
}

/// Reads a name at `start`; returns it (lowercase, no trailing dot) and the
/// offset after it in the original position (pointers are followed, at most
/// 64 jumps, only backwards).
fn read_name(data: &[u8], start: usize) -> Result<(String, usize), WireError> {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = start;
    let mut after = None;
    let mut jumps = 0;
    let mut total = 0usize;
    loop {
        let len = *data.get(pos).ok_or(WireError("short name"))?;
        match len & 0xC0 {
            0x00 => {
                if len == 0 {
                    pos += 1;
                    break;
                }
                let len = usize::from(len);
                let label = data
                    .get(pos + 1..pos + 1 + len)
                    .ok_or(WireError("short label"))?;
                total += len + 1;
                if total > 255 {
                    return Err(WireError("name too long"));
                }
                labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
                pos += 1 + len;
            }
            0xC0 => {
                let low = *data.get(pos + 1).ok_or(WireError("short pointer"))?;
                let target = (usize::from(len & 0x3F) << 8) | usize::from(low);
                if after.is_none() {
                    after = Some(pos + 2);
                }
                if target >= pos || jumps >= 64 {
                    return Err(WireError("bad pointer"));
                }
                jumps += 1;
                pos = target;
            }
            _ => return Err(WireError("bad label type")),
        }
    }
    Ok((labels.join("."), after.unwrap_or(pos)))
}

/// Parses a response. Records of other classes are skipped.
pub fn parse_response(data: &[u8]) -> Result<Response, WireError> {
    let mut reader = Reader { data, pos: 0 };
    let id = reader.u16()?;
    let flags = reader.u16()?;
    if flags & 0x8000 == 0 {
        return Err(WireError("not a response"));
    }
    let truncated = flags & 0x0200 != 0;
    let rcode = match flags & 0x000F {
        0 => Rcode::NoError,
        3 => Rcode::NxDomain,
        other => Rcode::Failure(u8::try_from(other).unwrap_or(u8::MAX)),
    };
    let qdcount = reader.u16()?;
    let ancount = reader.u16()?;
    let _nscount = reader.u16()?;
    let _arcount = reader.u16()?;
    for _ in 0..qdcount {
        reader.name()?;
        reader.u16()?;
        reader.u16()?;
    }
    let mut answers = Vec::with_capacity(usize::from(ancount));
    if truncated {
        // A truncated answer section can stop mid-record; the caller retries
        // over TCP.
        return Ok(Response {
            id,
            truncated,
            rcode,
            answers,
        });
    }
    for _ in 0..ancount {
        let name = reader.name()?;
        let rtype = reader.u16()?;
        let class = reader.u16()?;
        let ttl = reader.u32()?;
        let rdlen = usize::from(reader.u16()?);
        let rdata_start = reader.pos;
        let rdata = reader.bytes(rdlen)?;
        if class != CLASS_IN {
            continue;
        }
        let record = match rtype {
            TYPE_A if rdlen == 4 => {
                Record::A(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]))
            }
            TYPE_AAAA if rdlen == 16 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(rdata);
                Record::Aaaa(Ipv6Addr::from(octets))
            }
            TYPE_MX if rdlen >= 3 => {
                let preference = u16::from_be_bytes([rdata[0], rdata[1]]);
                let (exchange, _) = read_name(data, rdata_start + 2)?;
                Record::Mx {
                    preference,
                    exchange,
                }
            }
            TYPE_TXT => Record::Txt(read_txt(rdata)?),
            TYPE_PTR => Record::Ptr(read_name(data, rdata_start)?.0),
            TYPE_CNAME => Record::Cname(read_name(data, rdata_start)?.0),
            other => Record::Other(other),
        };
        answers.push(Answer { name, ttl, record });
    }
    Ok(Response {
        id,
        truncated,
        rcode,
        answers,
    })
}

fn read_txt(rdata: &[u8]) -> Result<String, WireError> {
    let mut out = Vec::with_capacity(rdata.len());
    let mut pos = 0;
    while pos < rdata.len() {
        let len = usize::from(rdata[pos]);
        let chunk = rdata
            .get(pos + 1..pos + 1 + len)
            .ok_or(WireError("short TXT"))?;
        out.extend_from_slice(chunk);
        pos += 1 + len;
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
pub(crate) fn tests_read_name(data: &[u8], start: usize) -> (String, usize) {
    read_name(data, start).expect("a name")
}

/// `4.3.2.1.in-addr.arpa` for 1.2.3.4.
pub fn reverse_name(ip: Ipv4Addr) -> String {
    let [a, b, c, d] = ip.octets();
    format!("{d}.{c}.{b}.{a}.in-addr.arpa")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A response for tests: header, the question, then the given answers
    /// (`name`, `type`, rdata), every name written out (no compression)
    /// except where the rdata carries its own pointers.
    pub(crate) fn response(
        id: u16,
        rcode: u16,
        question: (&str, u16),
        answers: &[(&str, u16, Vec<u8>)],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&(0x8180u16 | rcode).to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&u16::try_from(answers.len()).expect("few").to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        encode_name(question.0, &mut out).expect("name");
        out.extend_from_slice(&question.1.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        for (name, rtype, rdata) in answers {
            encode_name(name, &mut out).expect("name");
            out.extend_from_slice(&rtype.to_be_bytes());
            out.extend_from_slice(&CLASS_IN.to_be_bytes());
            out.extend_from_slice(&300u32.to_be_bytes());
            out.extend_from_slice(&u16::try_from(rdata.len()).expect("small").to_be_bytes());
            out.extend_from_slice(rdata);
        }
        out
    }

    pub(crate) fn mx_rdata(preference: u16, exchange: &str) -> Vec<u8> {
        let mut out = preference.to_be_bytes().to_vec();
        encode_name(exchange, &mut out).expect("name");
        out
    }

    pub(crate) fn txt_rdata(chunks: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in chunks {
            out.push(u8::try_from(chunk.len()).expect("short"));
            out.extend_from_slice(chunk.as_bytes());
        }
        out
    }

    #[test]
    fn builds_a_query_with_edns() {
        let query = build_query(0x1234, "example.com.", TYPE_MX).expect("query");
        assert_eq!(&query[..2], &[0x12, 0x34]);
        assert_eq!(&query[12..25], b"\x07example\x03com\x00");
        assert_eq!(&query[25..29], &[0, 15, 0, 1]);
        assert_eq!(query.len(), 29 + 11);
        assert!(build_query(1, "a..b", TYPE_A).is_err());
        assert!(build_query(1, &"a".repeat(64), TYPE_A).is_err());
    }

    #[test]
    fn reads_mx_txt_and_a_answers() {
        let data = response(
            7,
            0,
            ("example.com", TYPE_MX),
            &[
                ("example.com", TYPE_MX, mx_rdata(10, "mx1.example.com")),
                ("example.com", TYPE_TXT, txt_rdata(&["v=spf1 ", "-all"])),
                ("mx1.example.com", TYPE_A, vec![192, 0, 2, 1]),
            ],
        );
        let parsed = parse_response(&data).expect("parse");
        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.rcode, Rcode::NoError);
        assert_eq!(
            parsed.answers[0].record,
            Record::Mx {
                preference: 10,
                exchange: "mx1.example.com".into()
            }
        );
        assert_eq!(parsed.answers[1].record, Record::Txt("v=spf1 -all".into()));
        assert_eq!(
            parsed.answers[2].record,
            Record::A(Ipv4Addr::new(192, 0, 2, 1))
        );
    }

    #[test]
    fn follows_compression_pointers() {
        // Question name at offset 12; the MX exchange is "mx." + pointer to it.
        let mut rdata = 5u16.to_be_bytes().to_vec();
        rdata.extend_from_slice(b"\x02mx\xC0\x0C");
        let data = response(
            1,
            0,
            ("example.com", TYPE_MX),
            &[("example.com", TYPE_MX, rdata)],
        );
        let parsed = parse_response(&data).expect("parse");
        assert_eq!(
            parsed.answers[0].record,
            Record::Mx {
                preference: 5,
                exchange: "mx.example.com".into()
            }
        );
    }

    #[test]
    fn refuses_pointer_loops_and_short_data() {
        let mut data = response(1, 0, ("example.com", TYPE_A), &[]);
        data[7] = 1; // ANCOUNT 1, answer name pointing at itself
        let at = data.len();
        data.extend_from_slice(&[0xC0, u8::try_from(at).expect("small")]);
        assert!(parse_response(&data).is_err());
        assert!(parse_response(&[0x00, 0x01]).is_err());
    }

    #[test]
    fn reads_nxdomain_and_truncation() {
        let data = response(9, 3, ("nope.example", TYPE_MX), &[]);
        assert_eq!(parse_response(&data).expect("parse").rcode, Rcode::NxDomain);
        let mut data = response(9, 0, ("big.example", TYPE_TXT), &[]);
        data[2] |= 0x02;
        assert!(parse_response(&data).expect("parse").truncated);
    }

    #[test]
    fn reverses_an_ipv4_address() {
        assert_eq!(
            reverse_name(Ipv4Addr::new(1, 2, 3, 4)),
            "4.3.2.1.in-addr.arpa"
        );
    }
}
