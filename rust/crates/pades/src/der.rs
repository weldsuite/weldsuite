//! The DER subset PAdES needs: writing the structures WeldSign builds (CMS
//! signed data, timestamp and OCSP requests, test certificates) and reading
//! the ones it is handed (certificates, timestamp tokens, OCSP answers).
//!
//! Lengths are definite; a BER indefinite length is refused rather than
//! guessed at. Tags are single-byte (every tag in these structures is).

use std::fmt;

use time::OffsetDateTime;

/// Why bytes could not be read as DER.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerError(pub String);

impl fmt::Display for DerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "der: {}", self.0)
    }
}

impl std::error::Error for DerError {}

pub type DerResult<T> = Result<T, DerError>;

fn bad(message: impl Into<String>) -> DerError {
    DerError(message.into())
}

pub const BOOLEAN: u8 = 0x01;
pub const INTEGER: u8 = 0x02;
pub const BIT_STRING: u8 = 0x03;
pub const OCTET_STRING: u8 = 0x04;
pub const NULL: u8 = 0x05;
pub const OID: u8 = 0x06;
pub const ENUMERATED: u8 = 0x0A;
pub const UTF8_STRING: u8 = 0x0C;
pub const PRINTABLE_STRING: u8 = 0x13;
pub const T61_STRING: u8 = 0x14;
pub const IA5_STRING: u8 = 0x16;
pub const UTC_TIME: u8 = 0x17;
pub const GENERALIZED_TIME: u8 = 0x18;
pub const BMP_STRING: u8 = 0x1E;
pub const SEQUENCE: u8 = 0x30;
pub const SET: u8 = 0x31;

/// A context-specific tag `[n]`.
pub const fn context(n: u8, constructed: bool) -> u8 {
    0x80 | if constructed { 0x20 } else { 0 } | (n & 0x1F)
}

// ── Writing ────────────────────────────────────────────────────────────────

fn push_len(out: &mut Vec<u8>, len: usize) {
    if len < 0x80 {
        out.push(u8::try_from(len).unwrap_or(0));
        return;
    }
    let bytes = len.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    out.push(0x80 | u8::try_from(bytes.len() - skip).unwrap_or(0));
    out.extend_from_slice(&bytes[skip..]);
}

/// One element: tag, length, content.
pub fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    push_len(&mut out, content.len());
    out.extend_from_slice(content);
    out
}

/// A SEQUENCE of already encoded elements, in order.
pub fn sequence(items: impl IntoIterator<Item = Vec<u8>>) -> Vec<u8> {
    tlv(SEQUENCE, &items.into_iter().flatten().collect::<Vec<u8>>())
}

/// A SET OF already encoded elements, sorted as DER wants.
pub fn set_of(mut items: Vec<Vec<u8>>) -> Vec<u8> {
    items.sort();
    tlv(SET, &items.concat())
}

/// The content of a SET OF (without its tag), sorted: for `[n] IMPLICIT SET OF`.
pub fn set_content(mut items: Vec<Vec<u8>>) -> Vec<u8> {
    items.sort();
    items.concat()
}

/// `[n] EXPLICIT inner`.
pub fn explicit(n: u8, inner: &[u8]) -> Vec<u8> {
    tlv(context(n, true), inner)
}

/// An INTEGER from unsigned big-endian bytes (a serial number, a nonce).
pub fn integer_unsigned(bytes: &[u8]) -> Vec<u8> {
    let start = bytes
        .iter()
        .position(|b| *b != 0)
        .unwrap_or(bytes.len().saturating_sub(1));
    let trimmed = if bytes.is_empty() {
        &[0][..]
    } else {
        &bytes[start..]
    };
    let mut content = Vec::with_capacity(trimmed.len() + 1);
    if trimmed.first().is_some_and(|b| b & 0x80 != 0) {
        content.push(0);
    }
    content.extend_from_slice(trimmed);
    tlv(INTEGER, &content)
}

/// A small non-negative INTEGER.
pub fn integer(n: u64) -> Vec<u8> {
    integer_unsigned(&n.to_be_bytes())
}

/// An OBJECT IDENTIFIER from its dotted form. Panics on a malformed constant
/// would be a programming error, so a bad arc is written as 0.
pub fn oid(dotted: &str) -> Vec<u8> {
    tlv(OID, &oid_content(dotted))
}

fn oid_content(dotted: &str) -> Vec<u8> {
    let arcs: Vec<u64> = dotted.split('.').map(|a| a.parse().unwrap_or(0)).collect();
    let mut out = Vec::new();
    let first = arcs.first().copied().unwrap_or(0) * 40 + arcs.get(1).copied().unwrap_or(0);
    push_base128(&mut out, first);
    for arc in arcs.iter().skip(2) {
        push_base128(&mut out, *arc);
    }
    out
}

fn push_base128(out: &mut Vec<u8>, mut value: u64) {
    let mut stack = [0u8; 10];
    let mut n = 0;
    loop {
        stack[n] = u8::try_from(value & 0x7F).unwrap_or(0);
        n += 1;
        value >>= 7;
        if value == 0 {
            break;
        }
    }
    for i in (0..n).rev() {
        out.push(if i == 0 { stack[i] } else { stack[i] | 0x80 });
    }
}

pub fn octet_string(bytes: &[u8]) -> Vec<u8> {
    tlv(OCTET_STRING, bytes)
}

/// A BIT STRING with no unused bits.
pub fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut content = Vec::with_capacity(bytes.len() + 1);
    content.push(0);
    content.extend_from_slice(bytes);
    tlv(BIT_STRING, &content)
}

pub fn null() -> Vec<u8> {
    vec![NULL, 0]
}

pub fn boolean(value: bool) -> Vec<u8> {
    vec![BOOLEAN, 1, if value { 0xFF } else { 0 }]
}

pub fn utf8_string(text: &str) -> Vec<u8> {
    tlv(UTF8_STRING, text.as_bytes())
}

pub fn printable_string(text: &str) -> Vec<u8> {
    tlv(PRINTABLE_STRING, text.as_bytes())
}

pub fn ia5_string(text: &str) -> Vec<u8> {
    tlv(IA5_STRING, text.as_bytes())
}

/// `UTCTime`, `YYMMDDHHMMSSZ` (certificates valid before 2050).
pub fn utc_time(at: OffsetDateTime) -> Vec<u8> {
    let at = at.to_offset(time::UtcOffset::UTC);
    let text = format!(
        "{:02}{:02}{:02}{:02}{:02}{:02}Z",
        at.year().rem_euclid(100),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    );
    tlv(UTC_TIME, text.as_bytes())
}

/// `GeneralizedTime`, `YYYYMMDDHHMMSSZ`.
pub fn generalized_time(at: OffsetDateTime) -> Vec<u8> {
    let at = at.to_offset(time::UtcOffset::UTC);
    let text = format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    );
    tlv(GENERALIZED_TIME, text.as_bytes())
}

/// An `AlgorithmIdentifier` with no parameters, or with NULL ones.
pub fn algorithm(oid_dotted: &str, null_params: bool) -> Vec<u8> {
    if null_params {
        sequence([oid(oid_dotted), null()])
    } else {
        sequence([oid(oid_dotted)])
    }
}

// ── Reading ────────────────────────────────────────────────────────────────

/// One element read from DER.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tlv<'a> {
    pub tag: u8,
    /// The content, without tag and length.
    pub content: &'a [u8],
    /// The whole element, tag and length included.
    pub raw: &'a [u8],
}

/// Read the first element of `input`; the rest comes back too.
pub fn parse(input: &[u8]) -> DerResult<(Tlv<'_>, &[u8])> {
    let (&tag, after_tag) = input.split_first().ok_or_else(|| bad("unexpected end"))?;
    if tag & 0x1F == 0x1F {
        return Err(bad("multi-byte tags are not supported"));
    }
    let (&first, after_len) = after_tag
        .split_first()
        .ok_or_else(|| bad("missing length"))?;
    let (len, header) = match first {
        0..0x80 => (usize::from(first), 2),
        0x80 => return Err(bad("indefinite length (BER) is not DER")),
        _ => {
            let n = usize::from(first & 0x7F);
            if n > 4 || after_len.len() < n {
                return Err(bad("length too long"));
            }
            let len = after_len[..n]
                .iter()
                .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
            (len, 2 + n)
        }
    };
    let end = header
        .checked_add(len)
        .filter(|end| *end <= input.len())
        .ok_or_else(|| bad("element runs past the end"))?;
    Ok((
        Tlv {
            tag,
            content: &input[header..end],
            raw: &input[..end],
        },
        &input[end..],
    ))
}

/// Exactly one element, nothing after it.
pub fn parse_one(input: &[u8]) -> DerResult<Tlv<'_>> {
    let (tlv, rest) = parse(input)?;
    if rest.is_empty() {
        Ok(tlv)
    } else {
        Err(bad("trailing bytes after the element"))
    }
}

/// The length of the DER element at the start of `input` (to cut padding
/// off a signature's `/Contents`).
pub fn element_len(input: &[u8]) -> DerResult<usize> {
    parse(input).map(|(tlv, _)| tlv.raw.len())
}

impl<'a> Tlv<'a> {
    /// This element, if it has `tag`.
    pub fn expect(self, tag: u8) -> DerResult<Self> {
        if self.tag == tag {
            Ok(self)
        } else {
            Err(bad(format!(
                "expected tag {tag:#04x}, found {:#04x}",
                self.tag
            )))
        }
    }

    /// The elements inside a constructed element.
    pub fn children(&self) -> DerResult<Vec<Tlv<'a>>> {
        let mut out = Vec::new();
        let mut rest = self.content;
        while !rest.is_empty() {
            let (child, next) = parse(rest)?;
            out.push(child);
            rest = next;
        }
        Ok(out)
    }

    /// A reader over the elements inside.
    pub fn reader(&self) -> Reader<'a> {
        Reader { rest: self.content }
    }

    /// An INTEGER's magnitude, without a leading zero byte.
    pub fn unsigned_bytes(&self) -> &'a [u8] {
        let content = self.content;
        if content.len() > 1 && content[0] == 0 {
            &content[1..]
        } else {
            content
        }
    }

    /// A small INTEGER or ENUMERATED.
    pub fn as_u64(&self) -> DerResult<u64> {
        let bytes = self.unsigned_bytes();
        if bytes.len() > 8
            || bytes
                .first()
                .is_some_and(|b| b & 0x80 != 0 && self.content[0] != 0)
        {
            return Err(bad("integer out of range"));
        }
        Ok(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
    }

    pub fn as_bool(&self) -> bool {
        self.content.first().is_some_and(|b| *b != 0)
    }

    /// An OBJECT IDENTIFIER in dotted form.
    pub fn oid(&self) -> DerResult<String> {
        if self.tag != OID {
            return Err(bad("not an OID"));
        }
        let mut arcs: Vec<u64> = Vec::new();
        let mut value: u64 = 0;
        for byte in self.content {
            value = value
                .checked_mul(128)
                .ok_or_else(|| bad("OID arc too large"))?
                | u64::from(byte & 0x7F);
            if byte & 0x80 == 0 {
                if arcs.is_empty() {
                    let first = (value / 40).min(2);
                    arcs.push(first);
                    arcs.push(value - first * 40);
                } else {
                    arcs.push(value);
                }
                value = 0;
            }
        }
        Ok(arcs
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("."))
    }

    /// A BIT STRING's bytes (unused bits ignored).
    pub fn bit_string(&self) -> DerResult<&'a [u8]> {
        if self.tag != BIT_STRING || self.content.is_empty() {
            return Err(bad("not a bit string"));
        }
        Ok(&self.content[1..])
    }

    /// Any of the string types as text.
    pub fn text(&self) -> String {
        match self.tag {
            BMP_STRING => {
                let units: Vec<u16> = self
                    .content
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_be_bytes(*pair))
                    .collect();
                String::from_utf16_lossy(&units)
            }
            T61_STRING => self.content.iter().map(|b| char::from(*b)).collect(),
            _ => String::from_utf8_lossy(self.content).into_owned(),
        }
    }

    /// A `UTCTime` or `GeneralizedTime` (fractional seconds ignored).
    pub fn time(&self) -> DerResult<OffsetDateTime> {
        let text = std::str::from_utf8(self.content).map_err(|_| bad("time is not ASCII"))?;
        let text = text
            .strip_suffix('Z')
            .ok_or_else(|| bad("time is not UTC"))?;
        let text = text.split('.').next().unwrap_or(text);
        let digits = |s: &str| -> DerResult<i32> { s.parse().map_err(|_| bad("time digits")) };
        let (year, rest) = match self.tag {
            UTC_TIME if text.len() >= 10 => {
                let yy = digits(&text[..2])?;
                (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &text[2..])
            }
            GENERALIZED_TIME if text.len() >= 12 => (digits(&text[..4])?, &text[4..]),
            _ => return Err(bad("not a time")),
        };
        let part = |i: usize| -> DerResult<u8> {
            rest.get(i..i + 2)
                .unwrap_or("00")
                .parse()
                .map_err(|_| bad("time digits"))
        };
        let month = time::Month::try_from(part(0)?).map_err(|_| bad("month"))?;
        let date =
            time::Date::from_calendar_date(year, month, part(2)?).map_err(|_| bad("date"))?;
        let at = date
            .with_hms(part(4)?, part(6)?, part(8)?)
            .map_err(|_| bad("time of day"))?;
        Ok(at.assume_utc())
    }
}

/// Reads the elements of a constructed element one at a time.
#[derive(Debug, Clone, Copy)]
pub struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        Self { rest: input }
    }

    pub fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    /// The next element's tag, without reading it.
    pub fn peek_tag(&self) -> Option<u8> {
        self.rest.first().copied()
    }

    /// The next element, which must be there.
    #[allow(
        clippy::should_implement_trait,
        reason = "fallible, unlike Iterator::next; every reader call site reads one required element"
    )]
    pub fn next(&mut self) -> DerResult<Tlv<'a>> {
        let (tlv, rest) = parse(self.rest)?;
        self.rest = rest;
        Ok(tlv)
    }

    /// The next element if it has `tag`.
    pub fn optional(&mut self, tag: u8) -> DerResult<Option<Tlv<'a>>> {
        if self.peek_tag() == Some(tag) {
            self.next().map(Some)
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oids_round_trip() {
        for dotted in ["1.2.840.113549.1.9.16.2.47", "2.5.4.3", "0.4.0.1862.1.6.1"] {
            let encoded = oid(dotted);
            let tlv = parse_one(&encoded).expect("oid");
            assert_eq!(tlv.oid().expect("dotted"), dotted);
        }
        // sha256WithRSAEncryption, as every certificate spells it.
        assert_eq!(
            oid("1.2.840.113549.1.1.11"),
            [
                0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B
            ]
        );
    }

    #[test]
    fn long_lengths_and_integers() {
        let big = vec![7u8; 300];
        let encoded = octet_string(&big);
        assert_eq!(&encoded[..4], &[0x04, 0x82, 0x01, 0x2C]);
        assert_eq!(parse_one(&encoded).expect("octets").content, &big[..]);
        assert_eq!(integer(0), [0x02, 0x01, 0x00]);
        assert_eq!(integer(128), [0x02, 0x02, 0x00, 0x80]);
        assert_eq!(integer_unsigned(&[0, 0, 0x7F]), [0x02, 0x01, 0x7F]);
        assert_eq!(
            parse_one(&integer(65_537)).expect("int").as_u64(),
            Ok(65_537)
        );
    }

    #[test]
    fn sets_are_sorted_and_times_read_back() {
        let set = set_of(vec![vec![0x02, 0x01, 0x05], vec![0x02, 0x01, 0x01]]);
        assert_eq!(set, [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x05]);
        let at = time::macros::datetime!(2026-11-25 13:45:07 UTC);
        assert_eq!(parse_one(&utc_time(at)).expect("utc").time(), Ok(at));
        assert_eq!(
            parse_one(&generalized_time(at)).expect("gen").time(),
            Ok(at)
        );
        let fraction = tlv(GENERALIZED_TIME, b"20261125134507.123Z");
        assert_eq!(parse_one(&fraction).expect("frac").time(), Ok(at));
    }

    #[test]
    fn indefinite_lengths_are_refused() {
        assert!(parse(&[0x30, 0x80, 0x00, 0x00]).is_err());
        assert!(parse(&[0x04, 0x05, 0x01]).is_err());
    }
}
