//! `lib/url.ts`: page and referrer URLs as they are stored (no credentials,
//! no fragment, no query parameter that looks like a secret), their `host`,
//! `path` and `utm_*` columns, and the `settings.excludedUrls` matcher.

use regex::Regex;

/// Words that mark a query parameter as sensitive.
const SECRET_WORDS: &[&str] = &[
    "token",
    "key",
    "secret",
    "password",
    "passwd",
    "pwd",
    "pass",
    "passcode",
    "auth",
    "authorization",
    "code",
    "email",
    "mail",
    "otp",
    "jwt",
    "sig",
    "signature",
    "sid",
    "session",
    "credential",
    "credentials",
];
/// Run-together names (`accesstoken`, `apikey`) end in one of these.
const SECRET_SUFFIXES: &[&str] = &["token", "secret", "password", "apikey"];

const MAX_UTM: usize = 256;
const MAX_PATTERN_LENGTH: usize = 256;

/// Whether a word holds an address (`a@b.c`), as `looksLikeEmailWord`
/// counts it, in UTF-16 units.
fn looks_like_email_word(word: &str) -> bool {
    let units: Vec<u16> = word.encode_utf16().collect();
    let Some(at) = units.iter().position(|&u| u == u16::from(b'@')) else {
        return false;
    };
    if at == 0 {
        return false;
    }
    let from = at + 2;
    let dot = units
        .iter()
        .enumerate()
        .skip(from)
        .find(|(_, u)| **u == u16::from(b'.'))
        .map(|(index, _)| index);
    dot.is_some_and(|dot| dot < units.len() - 1)
}

fn looks_like_email(value: &str) -> bool {
    value.split(char::is_whitespace).any(looks_like_email_word)
}

/// `words(name)`: camelCase split, lower-cased, split on anything but
/// `[a-z0-9]`.
fn words(name: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(name.len() + 4);
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if let Some(p) = previous
            && (p.is_ascii_lowercase() || p.is_ascii_digit())
            && c.is_ascii_uppercase()
        {
            spaced.push(' ');
        }
        spaced.push(c);
        previous = Some(c);
    }
    spaced
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `isSecretParam(name, value)`.
pub(crate) fn is_secret_param(name: &str, value: &str) -> bool {
    if words(name)
        .iter()
        .any(|word| SECRET_WORDS.contains(&word.as_str()))
    {
        return true;
    }
    let squashed: String = name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    if SECRET_SUFFIXES
        .iter()
        .any(|suffix| squashed.ends_with(suffix))
    {
        return true;
    }
    looks_like_email(value)
}

/// `decodeURIComponent` (`reserved` empty) or `decodeURI` (`;/?:@&=+$,#`
/// kept encoded); `None` where JavaScript throws a `URIError`.
fn decode_uri(text: &str, reserved: &str) -> Option<String> {
    fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
        if bytes.get(at) != Some(&b'%') {
            return None;
        }
        let digits = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
        u8::from_str_radix(digits, 16).ok()
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            let c = text[i..].chars().next()?;
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let first = hex_byte(bytes, i)?;
        if first < 0x80 {
            let c = char::from(first);
            if reserved.contains(c) {
                out.push_str(&text[i..i + 3]);
            } else {
                out.push(c);
            }
            i += 3;
            continue;
        }
        let count = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut sequence = vec![first];
        for k in 1..count {
            let byte = hex_byte(bytes, i + 3 * k)?;
            if byte & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(byte);
        }
        let decoded = std::str::from_utf8(&sequence).ok()?;
        out.push_str(decoded);
        i += 3 * count;
    }
    Some(out)
}

/// `decode(part)`: `+` as a space, then `decodeURIComponent`; the part as
/// it was when that throws.
fn decode(part: &str) -> String {
    decode_uri(&part.replace('+', " "), "").unwrap_or_else(|| part.to_owned())
}

/// `?a=1&b=2` without the secret parameters, original encoding kept.
fn strip_secret_params(query: &str) -> Option<String> {
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| {
            if pair.is_empty() {
                return false;
            }
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            !is_secret_param(&decode(name), &decode(value))
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("&"))
}

/// `cleanUrl(raw)`: an http(s) URL without credentials, fragment and secret
/// parameters; `None` for anything else.
fn clean_url(raw: &str) -> Option<url::Url> {
    let mut url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_fragment(None);
    let query = url.query().map(str::to_owned);
    let stripped = query.as_deref().and_then(strip_secret_params);
    url.set_query(stripped.as_deref());
    Some(url)
}

/// UTM values: `utm_source` … `utm_term`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Utm {
    pub(crate) source: Option<String>,
    pub(crate) medium: Option<String>,
    pub(crate) campaign: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) term: Option<String>,
}

/// `parsePageUrl(raw)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PageUrl {
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) path: String,
    pub(crate) utm: Utm,
}

fn utm_value(url: &url::Url, name: &str) -> Option<String> {
    let value = url
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())?;
    let trimmed = weldsuite_kit::validation::js_trim(&value);
    if trimmed.is_empty() {
        return None;
    }
    Some(slice_utf16(trimmed, MAX_UTM))
}

/// `text.slice(0, max)` in UTF-16 units.
pub(crate) fn slice_utf16(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

pub(crate) fn parse_page_url(raw: &str) -> Option<PageUrl> {
    let url = clean_url(raw)?;
    Some(PageUrl {
        url: url.as_str().to_owned(),
        host: url.host_str().unwrap_or_default().to_owned(),
        path: url.path().to_owned(),
        utm: Utm {
            source: utm_value(&url, "utm_source"),
            medium: utm_value(&url, "utm_medium"),
            campaign: utm_value(&url, "utm_campaign"),
            content: utm_value(&url, "utm_content"),
            term: utm_value(&url, "utm_term"),
        },
    })
}

/// `parseReferrer(raw)`: the cleaned referrer and its host, or nulls.
pub(crate) fn parse_referrer(raw: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return (None, None);
    };
    match clean_url(raw) {
        Some(url) => (
            Some(url.as_str().to_owned()),
            Some(url.host_str().unwrap_or_default().to_owned()),
        ),
        None => (None, None),
    }
}

/// What `.` matches in a JavaScript regular expression without flags.
const ANY: &str = r"[^\n\r\x{2028}\x{2029}]*";

fn pattern_source(pattern: &str) -> String {
    let mut collapsed = String::with_capacity(pattern.len());
    for c in pattern.chars() {
        if c == '*' && collapsed.ends_with('*') {
            continue;
        }
        collapsed.push(c);
    }
    collapsed
        .split('*')
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(ANY)
}

/// `excludedPathMatcher(patterns)`: a pattern must match the whole path,
/// `*` standing for any characters, tried as encoded and decoded.
pub(crate) struct ExcludedPaths(Option<Regex>);

impl ExcludedPaths {
    pub(crate) fn new(patterns: &[String]) -> Self {
        let usable: Vec<String> = patterns
            .iter()
            .filter(|p| !p.is_empty() && p.encode_utf16().count() <= MAX_PATTERN_LENGTH)
            .map(|p| pattern_source(p))
            .collect();
        if usable.is_empty() {
            return Self(None);
        }
        Self(Regex::new(&format!("^(?:{})$", usable.join("|"))).ok())
    }

    pub(crate) fn matches(&self, path: &str) -> bool {
        let Some(re) = &self.0 else {
            return false;
        };
        if re.is_match(path) {
            return true;
        }
        decode_uri(path, ";/?:@&=+$,#").is_some_and(|decoded| re.is_match(&decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_parameters() {
        for name in ["resetToken", "api_key", "access-token", "apikey", "code", "Email"] {
            assert!(is_secret_param(name, "x"), "{name}");
        }
        for name in ["keyword", "author", "lang", "utm_source"] {
            assert!(!is_secret_param(name, "x"), "{name}");
        }
        assert!(is_secret_param("ref", "jane@acme.com."));
        assert!(is_secret_param("q", "contact jane@acme.com please"));
        for value in ["@weldsuite", "a@b", "a@.com", "a@b."] {
            assert!(!is_secret_param("ref", value), "{value}");
        }
    }

    #[test]
    fn page_urls() {
        let page = parse_page_url(
            "https://example.com/reset?token=abc&lang=en&q=red%20shoes&utm_source=news",
        )
        .expect("a page");
        assert_eq!(page.url, "https://example.com/reset?lang=en&q=red%20shoes&utm_source=news");
        assert_eq!(page.utm.source.as_deref(), Some("news"));
        assert_eq!(
            parse_page_url("https://example.com/login?code=1&password=3").map(|p| p.url),
            Some("https://example.com/login".to_owned())
        );
        assert_eq!(
            parse_page_url("https://user:pw@example.com/cb#access_token=abc").map(|p| p.url),
            Some("https://example.com/cb".to_owned())
        );
        assert!(parse_page_url("javascript:alert(1)").is_none());
        assert!(parse_page_url("not a url").is_none());
    }

    #[test]
    fn excluded_paths() {
        let excluded = ExcludedPaths::new(&["/admin/*".to_owned(), "/a.b".to_owned(), "/über/*".to_owned()]);
        assert!(excluded.matches("/admin/users"));
        assert!(!excluded.matches("/admin"));
        assert!(excluded.matches("/a.b"));
        assert!(!excluded.matches("/aXb"));
        assert!(excluded.matches("/%C3%BCber/x"));
        assert!(!ExcludedPaths::new(&["/admin/*".to_owned()]).matches("/%E0%A4%A"));
        assert!(!ExcludedPaths::new(&[]).matches("/anything"));
    }
}
