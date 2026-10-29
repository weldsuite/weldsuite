//! The browser built-ins the TypeScript routes build their opaque cursors
//! from, so a Rust route can read a cursor a worker issued and issue the same
//! bytes: `btoa`/`atob` (standard base64, padded, over Latin-1 "binary
//! strings"), the URL-safe unpadded variant some routes derive from them, and
//! `encodeURIComponent`/`decodeURIComponent`.
//!
//! Each route picks its own cursor format (an id, `<iso>|<id>`, a JSON tuple,
//! an offset); the format belongs to the route and is ported with it. Where
//! JavaScript throws, these return `None`, and the routes answer an
//! unreadable cursor with the first page, never an error.

use serde::Serialize;
use serde::de::DeserializeOwned;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `btoa(input)`: each character is one byte, so a character above U+00FF
/// has no encoding (JavaScript throws `InvalidCharacterError`).
pub fn btoa(input: &str) -> Option<String> {
    let bytes = input
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect::<Option<Vec<u8>>>()?;
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let sextets = [
            b[0] >> 2,
            ((b[0] & 3) << 4) | (b[1] >> 4),
            ((b[1] & 15) << 2) | (b[2] >> 6),
            b[2] & 63,
        ];
        for (i, sextet) in sextets.into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[usize::from(sextet)]));
            } else {
                out.push('=');
            }
        }
    }
    Some(out)
}

/// `atob(input)`, the WHATWG forgiving-base64 decode: ASCII whitespace is
/// ignored, the padding may be left out, leftover bits are dropped, and the
/// result is a Latin-1 string (one character per byte). `None` where
/// JavaScript throws: a character outside the standard alphabet (`-` and `_`
/// included) or a length that cannot be base64.
pub fn atob(input: &str) -> Option<String> {
    let mut data: Vec<u8> = input
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = String::with_capacity(data.len() / 4 * 3 + 2);
    let mut buffer: u32 = 0;
    let mut bits = 0_u32;
    for byte in data {
        let sextet = ALPHABET.iter().position(|&a| a == byte)?;
        buffer = (buffer << 6) | u32::try_from(sextet).ok()?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(char::from(u8::try_from((buffer >> bits) & 0xff).ok()?));
        }
    }
    Some(out)
}

/// `btoa(input)` made URL-safe and unpadded:
/// `.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')`.
pub fn btoa_url(input: &str) -> Option<String> {
    let encoded = btoa(input)?;
    Some(
        encoded
            .trim_end_matches('=')
            .chars()
            .map(|c| match c {
                '+' => '-',
                '/' => '_',
                c => c,
            })
            .collect(),
    )
}

/// The reverse of [`btoa_url`]: `atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))`.
pub fn atob_url(input: &str) -> Option<String> {
    let standard: String = input
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    atob(&standard)
}

/// `encodeURIComponent(input)`: everything but ASCII letters, digits and
/// `-_.!~*'()` as UTF-8 `%XX`, upper-case hex.
pub fn encode_uri_component(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    out
}

/// `decodeURIComponent(input)`: every `%XX` sequence decoded as UTF-8.
/// `None` where JavaScript throws `URIError`: a `%` not followed by two hex
/// digits, or escapes that are not one well-formed UTF-8 character.
pub fn decode_uri_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let first = hex_byte(bytes, i)?;
        i += 3;
        let width = match first.leading_ones() {
            0 => {
                out.push(first);
                continue;
            }
            n @ 2..=4 => n,
            _ => return None,
        };
        let mut octets = vec![first];
        for _ in 1..width {
            let next = hex_byte(bytes, i)?;
            if next & 0xc0 != 0x80 {
                return None;
            }
            octets.push(next);
            i += 3;
        }
        // Overlong forms, surrogates and code points past U+10FFFF throw.
        std::str::from_utf8(&octets).ok()?;
        out.extend_from_slice(&octets);
    }
    String::from_utf8(out).ok()
}

/// The byte of the `%XX` escape at `at`.
fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    let digits = bytes.get(at + 1..at + 3)?;
    let text = std::str::from_utf8(digits).ok()?;
    if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u8::from_str_radix(text, 16).ok()
}

/// `btoa(encodeURIComponent(JSON.stringify(value)))`, the JSON-tuple cursor of
/// the books-api keyset lists. `serde_json` writes strings, integers and
/// booleans as `JSON.stringify` does; keep fractional numbers out of cursors.
pub fn encode_json_cursor<T: Serialize + ?Sized>(value: &T) -> Option<String> {
    let json = serde_json::to_string(value).ok()?;
    btoa(&encode_uri_component(&json))
}

/// `JSON.parse(decodeURIComponent(atob(cursor)))` into `T`. `None` for
/// anything JavaScript would throw on, or that does not deserialize as `T`.
/// Deserializing into a tuple is stricter than the routes' `Array.isArray`
/// check: an array with extra elements is refused rather than truncated.
pub fn decode_json_cursor<T: DeserializeOwned>(cursor: &str) -> Option<T> {
    let json = decode_uri_component(&atob(cursor)?)?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values are what Node prints for the same calls.
    #[test]
    fn btoa_matches_javascript() {
        assert_eq!(btoa("").as_deref(), Some(""));
        assert_eq!(btoa("f").as_deref(), Some("Zg=="));
        assert_eq!(btoa("fo").as_deref(), Some("Zm8="));
        assert_eq!(btoa("foo").as_deref(), Some("Zm9v"));
        assert_eq!(
            btoa("2026-01-31T10:00:00.000Z|run_abc").as_deref(),
            Some("MjAyNi0wMS0zMVQxMDowMDowMC4wMDBafHJ1bl9hYmM=")
        );
        assert_eq!(btoa("\u{ff}\u{fe}?").as_deref(), Some("//4/"));
        assert_eq!(btoa("é").as_deref(), Some("6Q=="));
        // Above Latin-1 btoa throws.
        assert_eq!(btoa("€"), None);
    }

    #[test]
    fn atob_is_forgiving_like_javascript() {
        assert_eq!(atob("Zm9v").as_deref(), Some("foo"));
        assert_eq!(atob("Zm8=").as_deref(), Some("fo"));
        assert_eq!(atob("Zm8").as_deref(), Some("fo"));
        assert_eq!(atob("Zg").as_deref(), Some("f"));
        assert_eq!(atob(" Zm\n9v\t").as_deref(), Some("foo"));
        assert_eq!(atob("").as_deref(), Some(""));
        // Leftover bits are dropped, not checked.
        assert_eq!(atob("Zh==").as_deref(), Some("f"));
        assert_eq!(atob("//4/").as_deref(), Some("\u{ff}\u{fe}?"));
        for bad in [
            "Z", "Zm9vZ", "Zm-v", "Zm_v", "Zm9v=", "Zg===", "Z===", "Zm=v", "é",
        ] {
            assert_eq!(atob(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_url_safe_variant_round_trips() {
        let encoded = btoa_url("2026-01-31|dep_\u{ff}\u{fe}?").unwrap_or_default();
        assert_eq!(encoded, "MjAyNi0wMS0zMXxkZXBf__4_");
        assert_eq!(
            atob_url(&encoded).as_deref(),
            Some("2026-01-31|dep_\u{ff}\u{fe}?")
        );
        assert_eq!(btoa_url("f").as_deref(), Some("Zg"));
    }

    #[test]
    fn encode_uri_component_matches_javascript() {
        assert_eq!(
            encode_uri_component("[\"Café\",\"dim_1\"]"),
            "%5B%22Caf%C3%A9%22%2C%22dim_1%22%5D"
        );
        assert_eq!(
            encode_uri_component("A-z_0.9!~*'() /?#&=+$,;:@"),
            "A-z_0.9!~*'()%20%2F%3F%23%26%3D%2B%24%2C%3B%3A%40"
        );
        assert_eq!(encode_uri_component("😀"), "%F0%9F%98%80");
    }

    #[test]
    fn decode_uri_component_matches_javascript() {
        assert_eq!(
            decode_uri_component("%5B%22Caf%C3%A9%22%5D").as_deref(),
            Some("[\"Café\"]")
        );
        assert_eq!(decode_uri_component("%f0%9f%98%80").as_deref(), Some("😀"));
        // Reserved characters decode too, and plain text passes through.
        assert_eq!(
            decode_uri_component("a%2Fb%3f é").as_deref(),
            Some("a/b? é")
        );
        for bad in [
            "%",
            "%2",
            "%zz",
            "%C3",
            "%C3%",
            "%C3A9",
            "%80",
            "%C0%AF",
            "%ED%A0%80",
            "%F4%90%80%80",
            "%FF",
        ] {
            assert_eq!(decode_uri_component(bad), None, "{bad}");
        }
    }

    #[test]
    fn json_cursors_match_the_books_routes() {
        // btoa(encodeURIComponent(JSON.stringify(['Café', 'dim_1'])))
        let cursor = encode_json_cursor(&("Café", "dim_1")).unwrap_or_default();
        assert_eq!(cursor, "JTVCJTIyQ2FmJUMzJUE5JTIyJTJDJTIyZGltXzElMjIlNUQ=");
        assert_eq!(
            decode_json_cursor::<(String, String)>(&cursor),
            Some(("Café".to_owned(), "dim_1".to_owned()))
        );
        assert_eq!(decode_json_cursor::<(String, String)>("not base64!"), None);
        assert_eq!(
            decode_json_cursor::<(String, String)>(&btoa("%E0").unwrap_or_default()),
            None
        );
        let number = encode_json_cursor(&(1, "x")).unwrap_or_default();
        assert_eq!(decode_json_cursor::<(String, String)>(&number), None);
    }
}
