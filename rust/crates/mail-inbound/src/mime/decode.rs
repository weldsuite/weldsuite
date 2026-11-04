//! postal-mime's `decode-strings.js`, `base64-decoder.js`, `qp-decoder.js`
//! and `pass-through-decoder.js`: charsets as `TextDecoder` reads them, RFC
//! 2047 encoded words, RFC 2231 parameter continuations and the body
//! transfer encodings.

use encoding_rs::Encoding;

/// JavaScript's `\s`.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `getDecoder(charset)`: the `TextDecoder` for a label (`utf8` when
/// none), or `windows-1252` when the label names none `TextDecoder` knows
/// (the replacement encoding throws there too).
pub(crate) fn decoder(charset: Option<&str>) -> &'static Encoding {
    let label = charset.filter(|c| !c.is_empty()).unwrap_or("utf8");
    match Encoding::for_label(label.as_bytes()) {
        Some(encoding) if encoding != encoding_rs::REPLACEMENT => encoding,
        _ => encoding_rs::WINDOWS_1252,
    }
}

/// `new TextDecoder(label).decode(bytes)`: replacement characters for bad
/// input, and a byte order mark of the encoding itself removed.
pub(crate) fn decode_text(encoding: &'static Encoding, bytes: &[u8]) -> String {
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

/// `decodeBase64(base64)`, with its quirks: characters outside the alphabet
/// count as 0, and the length comes from the input's length and padding.
pub(crate) fn decode_base64(base64: &[u8]) -> Vec<u8> {
    fn lookup(c: Option<&u8>) -> u32 {
        match c {
            Some(c @ b'A'..=b'Z') => u32::from(c - b'A'),
            Some(c @ b'a'..=b'z') => u32::from(c - b'a') + 26,
            Some(c @ b'0'..=b'9') => u32::from(c - b'0') + 52,
            Some(b'+') => 62,
            Some(b'/') => 63,
            _ => 0,
        }
    }
    let len = base64.len();
    let mut buffer_length = len.div_ceil(4) * 3;
    if len % 4 == 3 {
        buffer_length -= 1;
    } else if len % 4 == 2 {
        buffer_length -= 2;
    } else if base64.last() == Some(&b'=') {
        buffer_length -= 1;
        if len >= 2 && base64[len - 2] == b'=' {
            buffer_length -= 1;
        }
    }
    let mut bytes = vec![0u8; buffer_length];
    let mut p = 0usize;
    let mut i = 0usize;
    while i < len {
        let e1 = lookup(base64.get(i));
        let e2 = lookup(base64.get(i + 1));
        let e3 = lookup(base64.get(i + 2));
        let e4 = lookup(base64.get(i + 3));
        for value in [
            (e1 << 2) | (e2 >> 4),
            ((e2 & 15) << 4) | (e3 >> 2),
            ((e3 & 3) << 6) | (e4 & 63),
        ] {
            if p < bytes.len() {
                bytes[p] = (value & 0xff) as u8;
            }
            p += 1;
        }
        i += 4;
    }
    bytes
}

/// A body's transfer decoder (`setupContentDecoder`).
#[derive(Debug)]
pub(crate) enum ContentDecoder {
    /// `Base64Decoder`: every line read as UTF-8, everything outside the
    /// alphabet dropped (padding too), decoded at the end.
    Base64(Vec<u8>),
    /// `QPDecoder`: every line read in the part's charset, a line break
    /// added, decoded at the end.
    QuotedPrintable {
        encoding: &'static Encoding,
        text: String,
    },
    /// `PassThroughDecoder`: the lines as they came, each followed by `\n`.
    PassThrough(Vec<u8>),
}

impl ContentDecoder {
    pub(crate) fn for_encoding(transfer_encoding: &str, charset: Option<&str>) -> Self {
        let lower = transfer_encoding.to_ascii_lowercase();
        if lower.contains("base64") {
            Self::Base64(Vec::new())
        } else if lower.contains("quoted-printable") {
            Self::QuotedPrintable {
                encoding: decoder(charset),
                text: String::new(),
            }
        } else {
            Self::PassThrough(Vec::new())
        }
    }

    pub(crate) fn update(&mut self, line: &[u8]) {
        match self {
            Self::Base64(remainder) => {
                let text = decode_text(encoding_rs::UTF_8, line);
                remainder.extend(
                    text.bytes()
                        .filter(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/'),
                );
            }
            Self::QuotedPrintable { encoding, text } => {
                text.push_str(&decode_text(encoding, line));
                text.push('\n');
            }
            Self::PassThrough(bytes) => {
                bytes.extend_from_slice(line);
                bytes.push(b'\n');
            }
        }
    }

    pub(crate) fn finalize(self) -> Vec<u8> {
        match self {
            Self::Base64(remainder) => {
                if remainder.is_empty() {
                    Vec::new()
                } else {
                    decode_base64(&remainder)
                }
            }
            Self::QuotedPrintable { text, .. } => decode_qp(&text),
            Self::PassThrough(bytes) => bytes,
        }
    }
}

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `QPDecoder.decodeChunks` over the whole body: soft line breaks removed,
/// every `=XX` a byte, the text around them as UTF-8 (the `Blob` the decoder
/// builds encodes its string chunks so).
fn decode_qp(text: &str) -> Vec<u8> {
    // `str.replace(/=\r?\n/g, '')`.
    let mut unwrapped = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut start = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' {
            if bytes.get(i + 1) == Some(&b'\n') {
                unwrapped.push_str(&text[start..i]);
                i += 2;
                start = i;
                continue;
            }
            if bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                unwrapped.push_str(&text[start..i]);
                i += 3;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    unwrapped.push_str(&text[start..]);
    // Split before every `=XX` (`/(?==[a-f0-9]{2})/i`): a part either starts
    // with a valid escape, whose byte is decoded and the rest kept as text,
    // or is plain text.
    let b = unwrapped.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'='
            && let (Some(Some(hi)), Some(Some(lo))) = (
                b.get(i + 1).map(|c| hex_value(*c)),
                b.get(i + 2).map(|c| hex_value(*c)),
            )
        {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// `getHex(c)`.
fn is_hex(c: u8) -> bool {
    c.is_ascii_hexdigit()
}

/// `decodeWord(charset, encoding, str)`: one RFC 2047 encoded word.
pub(crate) fn decode_word(charset: &str, encoding: &str, text: &str) -> String {
    // An RFC 2231 language tag after `*` is ignored.
    let charset = charset.split_once('*').map_or(charset, |(c, _)| c);
    let bytes: Vec<u8> = if encoding.eq_ignore_ascii_case("Q") {
        // `=\s+X` → `=X`, then every `_` and `\s` a space.
        let mut cleaned = String::with_capacity(text.len());
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '=' {
                let mut j = i + 1;
                while j < chars.len() && is_js_space(chars[j]) {
                    j += 1;
                }
                if j > i + 1 && j < chars.len() && chars[j].is_ascii_hexdigit() {
                    cleaned.push('=');
                    i = j;
                    continue;
                }
            }
            cleaned.push(c);
            i += 1;
        }
        let spaced: String = cleaned
            .chars()
            .map(|c| if c == '_' || is_js_space(c) { ' ' } else { c })
            .collect();
        let buf = spaced.as_bytes();
        let mut out = Vec::with_capacity(buf.len());
        let mut i = 0;
        while i < buf.len() {
            let c = buf[i];
            if c == b'='
                && i + 2 < buf.len()
                && is_hex(buf[i + 1])
                && is_hex(buf[i + 2])
                && let (Some(hi), Some(lo)) = (hex_value(buf[i + 1]), hex_value(buf[i + 2]))
            {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    } else if encoding.eq_ignore_ascii_case("B") {
        let kept: Vec<u8> = text
            .bytes()
            .filter(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
            .collect();
        decode_base64(&kept)
    } else {
        text.as_bytes().to_vec()
    };
    decode_text(decoder(Some(charset)), &bytes)
}

/// The marker `decodeWords` joins adjacent encoded words with.
const JOIN: &str = "__\0JOIN\0__";

/// An encoded word at a position (`=\?([^?]+)\?[QqBb]\?([^?]*)\?=`).
struct Word<'a> {
    end: usize,
    charset: &'a str,
    encoding: u8,
    text: &'a str,
}

fn word_at(s: &str, at: usize) -> Option<Word<'_>> {
    let rest = s.get(at..)?;
    let body = rest.strip_prefix("=?")?;
    let q1 = body.find('?')?;
    if q1 == 0 {
        return None;
    }
    let charset = &body[..q1];
    let after = &body[q1 + 1..];
    let encoding = *after.as_bytes().first()?;
    if !matches!(encoding, b'B' | b'b' | b'Q' | b'q') || after.as_bytes().get(1) != Some(&b'?') {
        return None;
    }
    let text_start = &after[2..];
    let q2 = text_start.find('?')?;
    if text_start.as_bytes().get(q2 + 1) != Some(&b'=') {
        return None;
    }
    let text = &text_start[..q2];
    let consumed = 2 + q1 + 1 + 2 + q2 + 2;
    Some(Word {
        end: at + consumed,
        charset,
        encoding,
        text,
    })
}

/// The position after the JavaScript whitespace at `at`.
fn skip_space(s: &str, at: usize) -> usize {
    let mut end = at;
    for c in s[at..].chars() {
        if !is_js_space(c) {
            break;
        }
        end += c.len_utf8();
    }
    end
}

/// The next char boundary after `at`.
fn next_char(s: &str, at: usize) -> usize {
    s[at..]
        .chars()
        .next()
        .map_or(s.len(), |c| at + c.len_utf8())
}

/// One of `decodeWords`' join passes: an encoded word of `kind`
/// (`b` or `q`) followed, after whitespace only, by another of that kind
/// is marked to be joined when `join` agrees.
fn join_pass(s: &str, kind: u8, join: impl Fn(&Word<'_>, &Word<'_>) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    let mut copied = 0;
    while at < s.len() {
        if let Some(left) = word_at(s, at).filter(|w| w.encoding.to_ascii_lowercase() == kind) {
            let after = skip_space(s, left.end);
            if let Some(right) =
                word_at(s, after).filter(|w| w.encoding.to_ascii_lowercase() == kind)
            {
                out.push_str(&s[copied..at]);
                if join(&left, &right) {
                    out.push_str(&s[at..left.end]);
                    out.push_str(JOIN);
                } else {
                    out.push_str(&s[at..after]);
                }
                copied = after;
                at = after;
                continue;
            }
        }
        at = next_char(s, at);
    }
    out.push_str(&s[copied..]);
    out
}

/// `/(\?=)?__\x00JOIN\x00__(=\?([^?]+)\?[QqBb]\?)?/g` → ''.
fn remove_joins(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(found) = rest.find(JOIN) {
        let mut head = &rest[..found];
        if head.ends_with("?=") {
            head = &head[..head.len() - 2];
        }
        out.push_str(head);
        let mut tail = &rest[found + JOIN.len()..];
        // `=\?([^?]+)\?[QqBb]\?`
        if let Some(body) = tail.strip_prefix("=?")
            && let Some(q1) = body.find('?')
            && q1 > 0
            && matches!(body.as_bytes().get(q1 + 1), Some(b'Q' | b'q' | b'B' | b'b'))
            && body.as_bytes().get(q1 + 2) == Some(&b'?')
        {
            tail = &body[q1 + 3..];
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// Whitespace between two encoded words removed.
fn remove_space_between_words(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    let mut copied = 0;
    while at < s.len() {
        if let Some(left) = word_at(s, at) {
            let after = skip_space(s, left.end);
            if after > left.end && word_at(s, after).is_some() {
                out.push_str(&s[copied..left.end]);
                copied = after;
                at = after;
                continue;
            }
        }
        at = next_char(s, at);
    }
    out.push_str(&s[copied..]);
    out
}

/// The charset `decodeWords`' last pass accepts: `[\w_\-*]+`.
fn is_word_charset(charset: &str) -> bool {
    !charset.is_empty()
        && charset
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'*'))
}

/// Every encoded word decoded (`/=\?([\w_\-*]+)\?([QqBb])\?([^?]*)\?=/g`).
fn decode_all_words(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    let mut copied = 0;
    while at < s.len() {
        if let Some(word) = word_at(s, at).filter(|w| is_word_charset(w.charset)) {
            out.push_str(&s[copied..at]);
            let encoding = [word.encoding];
            let encoding = std::str::from_utf8(&encoding).unwrap_or("B");
            out.push_str(&decode_word(word.charset, encoding, word.text));
            copied = word.end;
            at = word.end;
            continue;
        }
        at = next_char(s, at);
    }
    out.push_str(&s[copied..]);
    out
}

/// `decodeWords(str)`: RFC 2047 encoded words decoded, adjacent ones in the
/// same charset joined first; when joining breaks a character, again
/// without joining.
pub(crate) fn decode_words(text: &str) -> String {
    for join in [true, false] {
        let mut s = text.to_owned();
        if join {
            s = join_pass(&s, b'b', |left, right| {
                left.charset == right.charset
                    && left.text.encode_utf16().count() % 4 == 0
                    && !left.text.ends_with('=')
            });
            s = join_pass(&s, b'q', |left, right| left.charset == right.charset);
        }
        let s = remove_joins(&s);
        let s = remove_space_between_words(&s);
        let result = decode_all_words(&s);
        if join && result.contains('\u{fffd}') {
            continue;
        }
        return result;
    }
    String::new()
}

/// `decodeURIComponentWithCharset(encodedStr, charset)`.
pub(crate) fn decode_uri_component_with_charset(encoded: &str, charset: Option<&str>) -> String {
    let units: Vec<u16> = encoded.encode_utf16().collect();
    let mut bytes = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c == u16::from(b'%')
            && units
                .get(i + 1)
                .is_some_and(|u| u8::try_from(*u).is_ok_and(|b| b.is_ascii_hexdigit()))
            && units
                .get(i + 2)
                .is_some_and(|u| u8::try_from(*u).is_ok_and(|b| b.is_ascii_hexdigit()))
        {
            let hi = hex_value(u8::try_from(units[i + 1]).unwrap_or(b'0')).unwrap_or(0);
            let lo = hex_value(u8::try_from(units[i + 2]).unwrap_or(b'0')).unwrap_or(0);
            bytes.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        if c > 126 {
            // `TextEncoder.encode(char)` of one UTF-16 unit: a lone
            // surrogate becomes U+FFFD.
            let text = String::from_utf16_lossy(&[c]);
            bytes.extend_from_slice(text.as_bytes());
        } else {
            bytes.push(u8::try_from(c).unwrap_or(b'?'));
        }
        i += 1;
    }
    decode_text(decoder(Some(charset.unwrap_or("utf-8"))), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_follows_the_javascript_lengths() {
        assert_eq!(decode_base64(b"aGVsbG8="), b"hello");
        assert_eq!(decode_base64(b"aGVsbG8"), b"hello");
        assert_eq!(decode_base64(b"aGk="), b"hi");
        assert_eq!(decode_base64(b"QUJDR").len(), 6);
    }

    #[test]
    fn quoted_printable_keeps_bad_escapes() {
        assert_eq!(decode_qp("a=3Db=\nc=ZZ\n"), b"a=bc=ZZ\n");
    }

    #[test]
    fn encoded_words() {
        assert_eq!(decode_words("=?UTF-8?B?SGFsbG8=?= world"), "Hallo world");
        assert_eq!(
            decode_words("=?utf-8?q?caf=C3=A9?= =?utf-8?q?_au_lait?="),
            "café au lait"
        );
        assert_eq!(
            decode_words("=?ISO-8859-1?Q?J=F6rg?= <j@x.de>"),
            "Jörg <j@x.de>"
        );
        assert_eq!(decode_words("plain"), "plain");
    }

    #[test]
    fn rfc2231_values() {
        assert_eq!(
            decode_uri_component_with_charset("na%C3%AFve.txt", Some("utf-8")),
            "naïve.txt"
        );
        assert_eq!(
            decode_uri_component_with_charset("%E9t%E9", Some("iso-8859-1")),
            "été"
        );
    }

    #[test]
    fn unknown_charsets_read_as_windows_1252() {
        assert_eq!(decoder(Some("x-unknown")), encoding_rs::WINDOWS_1252);
        assert_eq!(decoder(None), encoding_rs::UTF_8);
        assert_eq!(decoder(Some("latin1")), encoding_rs::WINDOWS_1252);
    }
}
