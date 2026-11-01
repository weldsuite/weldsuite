//! `parseListUnsubscribe` (`@weldsuite/email/list-unsubscribe`) and the
//! subscription row an inbound message upserts
//! (`subscriptionValuesFromEmail`). Pure.

use crate::mime::js_trim;
use crate::parsed::{ParsedEmail, header_value};

/// `ListUnsubscribeInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListUnsubscribe {
    pub url: Option<String>,
    pub mailto: Option<String>,
    pub one_click: bool,
    pub list_id: Option<String>,
}

/// `isSafeUnsubscribeUrl(value)`.
fn is_safe_unsubscribe_url(value: &str) -> bool {
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_lowercase();
    if !host.contains('.') {
        return false;
    }
    let ipv4 = host.split('.').count() == 4
        && host
            .split('.')
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    if ipv4 || host.starts_with('[') {
        return false;
    }
    if host == "localhost" {
        return false;
    }
    ![
        ".localhost",
        ".local",
        ".internal",
        ".lan",
        ".home",
        ".corp",
    ]
    .iter()
    .any(|suffix| host.ends_with(suffix))
}

/// `parseMailto(value)` succeeds.
fn is_valid_mailto(value: &str) -> bool {
    if value.len() < 7 || !value[..7].eq_ignore_ascii_case("mailto:") {
        return false;
    }
    let rest = &value[7..];
    let address = rest.split('?').next().unwrap_or_default();
    let Ok(decoded) = percent_decode(address) else {
        return false;
    };
    let to = js_trim(&decoded);
    // `/^[^\s@,]+@[^\s@,][^\s@,.]*\.[^\s@,]+$/`
    let bad = |c: char| crate::mime::is_js_space(c) || c == '@' || c == ',';
    let Some((local, domain)) = to.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.chars().any(bad) || domain.chars().any(bad) {
        return false;
    }
    let mut chars = domain.chars();
    if chars.next().is_none() {
        return false;
    }
    // The first dot after the first character has something after it.
    let rest: String = chars.collect();
    rest.find('.').is_some_and(|dot| dot + 1 < rest.len())
}

/// `decodeURIComponent`: fails on a malformed escape.
fn percent_decode(text: &str) -> Result<String, ()> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or(())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// `parseListUnsubscribe(headers)`.
pub fn parse_list_unsubscribe(headers: &[(String, String)]) -> Option<ListUnsubscribe> {
    let raw = header_value(headers, "list-unsubscribe").filter(|r| !r.is_empty())?;
    let mut entries: Vec<String> = Vec::new();
    let mut rest = raw;
    while let Some(lt) = rest.find('<') {
        let after = &rest[lt + 1..];
        match after.find(['<', '>']) {
            Some(end) if after.as_bytes()[end] == b'>' && end > 0 => {
                entries.push(js_trim(&after[..end]).to_owned());
                rest = &after[end + 1..];
            }
            _ => rest = after,
        }
    }
    if entries.is_empty() {
        entries = raw.split(',').map(|s| js_trim(s).to_owned()).collect();
    }
    let mut url = None;
    let mut mailto = None;
    for entry in entries {
        let lower = entry.to_lowercase();
        if url.is_none() && lower.starts_with("https://") && is_safe_unsubscribe_url(&entry) {
            url = Some(entry);
        } else if mailto.is_none() && lower.starts_with("mailto:") && is_valid_mailto(&entry) {
            mailto = Some(entry);
        }
    }
    if url.is_none() && mailto.is_none() {
        return None;
    }
    let post = header_value(headers, "list-unsubscribe-post").unwrap_or_default();
    let one_click = url.is_some() && is_one_click(post);
    let list_id = header_value(headers, "list-id")
        .filter(|l| !l.is_empty())
        .map(|raw| {
            let inner = raw.find('<').and_then(|lt| {
                let after = &raw[lt + 1..];
                after
                    .find(['<', '>'])
                    .filter(|end| after.as_bytes()[*end] == b'>' && *end > 0)
                    .map(|end| &after[..end])
            });
            let value = js_trim(inner.unwrap_or(raw));
            value.encode_utf16().take(500).collect::<Vec<u16>>()
        })
        .map(|units| String::from_utf16_lossy(&units));
    Some(ListUnsubscribe {
        url,
        mailto,
        one_click,
        list_id,
    })
}

/// `/list-unsubscribe\s*=\s*one-click/i`.
fn is_one_click(post: &str) -> bool {
    let lower = post.to_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("list-unsubscribe") {
        let rest = lower[from + found + "list-unsubscribe".len()..]
            .trim_start_matches(crate::mime::is_js_space);
        if let Some(after) = rest.strip_prefix('=')
            && after
                .trim_start_matches(crate::mime::is_js_space)
                .starts_with("one-click")
        {
            return true;
        }
        from += found + 1;
    }
    false
}

/// The values of a subscription row (`subscriptionValuesFromEmail`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionValues {
    pub sender_email: String,
    pub sender_name: Option<String>,
    pub sender_domain: Option<String>,
    pub list_id: Option<String>,
    pub unsubscribe_url: Option<String>,
    pub unsubscribe_mailto: Option<String>,
    pub one_click: bool,
    pub last_subject: Option<String>,
    /// `receivedAt`, milliseconds.
    pub received_at: i64,
}

fn utf16_slice(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// `subscriptionValuesFromEmail(email)`.
pub fn subscription_values(email: &ParsedEmail) -> Option<SubscriptionValues> {
    let info = parse_list_unsubscribe(&email.headers)?;
    let sender = js_trim(&email.from.email).to_lowercase();
    if sender.is_empty() {
        return None;
    }
    Some(SubscriptionValues {
        sender_domain: sender.split('@').nth(1).map(str::to_owned),
        sender_email: sender,
        sender_name: email
            .from
            .name
            .as_deref()
            .map(|n| utf16_slice(n, 255))
            .filter(|n| !n.is_empty()),
        list_id: info.list_id,
        unsubscribe_url: info.url,
        unsubscribe_mailto: info.mailto,
        one_click: info.one_click,
        last_subject: Some(utf16_slice(&email.subject, 998)).filter(|s| !s.is_empty()),
        received_at: email.received_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn parses_targets() {
        let info = parse_list_unsubscribe(&headers(&[
            (
                "list-unsubscribe",
                "<mailto:u@x.com?subject=unsub>, <https://shop.example.com/u?u=1>",
            ),
            ("list-unsubscribe-post", "List-Unsubscribe=One-Click"),
            ("list-id", "Shop News <news.shop.example.com>"),
        ]))
        .expect("has targets");
        assert_eq!(info.url.as_deref(), Some("https://shop.example.com/u?u=1"));
        assert_eq!(info.mailto.as_deref(), Some("mailto:u@x.com?subject=unsub"));
        assert!(info.one_click);
        assert_eq!(info.list_id.as_deref(), Some("news.shop.example.com"));
        assert_eq!(
            parse_list_unsubscribe(&headers(&[(
                "list-unsubscribe",
                "<http://plain.example.com>"
            )])),
            None
        );
    }
}
