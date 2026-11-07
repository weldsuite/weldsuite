//! What the GitLab, Bitbucket and Azure DevOps mappers share
//! (`@weldsuite/merge-domain/providers/shared`): JSON readers, provider date
//! parsing and the signature primitives. Pure: no I/O.

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;
use weldsuite_kit::validation::{js_date_parse, js_iso_from_millis};

/// `obj(value)`: a plain object, else `None`.
pub(crate) fn obj(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `str(value)`: a non-empty string, else `None`.
pub(crate) fn str_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `arr(value)`: an array's items, else none.
pub(crate) fn arr(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `idString(value)`: a provider id (number or string) as a string.
pub(crate) fn id_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite) => {
            Some(crate::github::js_string(value))
        }
        _ => str_of(value),
    }
}

/// `lowerLogin(value)`.
pub(crate) fn lower_login(value: Option<&Value>) -> Option<String> {
    str_of(value).map(|login| login.to_lowercase())
}

/// `Number(value)` for an integer field (`iid`): `None` when not finite.
pub(crate) fn number_of(value: Option<&Value>) -> Option<i64> {
    let number = weldsuite_kit::validation::js_number_of(value);
    #[allow(clippy::cast_possible_truncation)]
    number.is_finite().then_some(number as i64)
}

/// GitLab's webhook date (`2026-11-05 10:00:00 UTC`, `… +0100`) as ISO, or
/// the text as it is.
fn gitlab_date(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let shape = text.len() >= 19
        && digits(0..4)
        && bytes[4] == b'-'
        && digits(5..7)
        && bytes[7] == b'-'
        && digits(8..10)
        && bytes[10] == b' '
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19);
    if !shape {
        return None;
    }
    let (date, time) = (&text[..10], &text[11..19]);
    let rest = &text[19..];
    let offset = match rest {
        "" | " UTC" => "Z".to_owned(),
        zone if zone.len() == 6
            && zone.starts_with(' ')
            && matches!(zone.as_bytes()[1], b'+' | b'-')
            && zone[2..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("{}:{}", &zone[1..4], &zone[4..])
        }
        _ => return None,
    };
    Some(format!("{date}T{time}{offset}"))
}

/// `parseProviderDate(value)`: an ISO 8601 date or GitLab's webhook format,
/// as ISO; an unreadable value is the epoch.
pub(crate) fn parse_provider_date(value: Option<&Value>) -> String {
    let epoch = || js_iso_from_millis(0.0).unwrap_or_default();
    let Some(text) = str_of(value) else {
        return epoch();
    };
    let iso = gitlab_date(&text).unwrap_or(text);
    js_date_parse(&iso)
        .and_then(js_iso_from_millis)
        .unwrap_or_else(epoch)
}

/// `nullableDate(value)`.
pub(crate) fn nullable_date(value: Option<&Value>) -> Option<String> {
    str_of(value).map(|_| parse_provider_date(value))
}

/// `trimTrailingSlashes(value)`.
pub(crate) fn trim_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

/// `constantTimeEqual(a, b)`.
pub(crate) fn constant_time_equal(a: &str, b: &str) -> bool {
    let (left, right) = (a.as_bytes(), b.as_bytes());
    let mut diff = left.len() ^ right.len();
    for i in 0..left.len().max(right.len()) {
        diff |= usize::from(left.get(i).copied().unwrap_or(0) ^ right.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

/// `hmacSha256Hex(secret, body)`.
pub(crate) fn hmac_sha256_hex(secret: &str, body: &str) -> String {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return String::new();
    };
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// `header(headers, name)`: by exact name, then case-insensitively.
pub(crate) fn header<'a>(headers: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    if let Some(value) = headers.get(name).and_then(Value::as_str) {
        return Some(value);
    }
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_gitlab_and_iso_dates() {
        assert_eq!(
            parse_provider_date(Some(&json!("2026-11-05 10:00:00 UTC"))),
            "2026-11-05T10:00:00.000Z"
        );
        assert_eq!(
            parse_provider_date(Some(&json!("2026-11-05 10:00:00 +0100"))),
            "2026-11-05T09:00:00.000Z"
        );
        assert_eq!(
            parse_provider_date(Some(&json!("2026-11-05T10:00:00Z"))),
            "2026-11-05T10:00:00.000Z"
        );
        assert_eq!(
            parse_provider_date(Some(&json!("garbage"))),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(nullable_date(Some(&Value::Null)), None);
    }

    #[test]
    fn compares_in_constant_time_and_signs_like_web_crypto() {
        assert!(constant_time_equal("abc", "abc"));
        assert!(!constant_time_equal("abc", "abd"));
        assert!(!constant_time_equal("abc", "ab"));
        assert_eq!(
            hmac_sha256_hex("key", "The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }
}
