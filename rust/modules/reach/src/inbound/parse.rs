//! `lib/inbound/mime.ts`, `message-id.ts` and `token.ts`: raw RFC 822 bytes
//! to a [`ParsedInbound`] (postal-mime doing the MIME work, as
//! `weldsuite_mail_inbound::mime`), Message-ID helpers and the inbound
//! address `reply+<token>@<REACH_INBOUND_DOMAIN>`.

use std::collections::HashMap;

use sha2::{Digest, Sha256};
use weldsuite_mail_inbound::mime::{self, Email, MailAddress};
use weldsuite_reach_domain::js_slice;
use weldsuite_reach_domain::text::{html_to_text, is_js_space, js_trim, trim_edges};

/// The fixed local part the routing matches (`INBOUND_LOCAL_PART`).
pub const INBOUND_LOCAL_PART: &str = "reply";

const MAX_ID_LENGTH: usize = 255;

/// Delivery-report parts the bounce parser reads.
const REPORT_MIME_TYPES: [&str; 5] = [
    "message/delivery-status",
    "message/rfc822",
    "text/rfc822-headers",
    "message/disposition-notification",
    "message/feedback-report",
];

/// Cap for one decoded report part (`MAX_REPORT_PART_CHARS`).
const MAX_REPORT_PART_CHARS: usize = 200_000;

/// One decoded MIME part that matters for delivery reports (`ReportPart`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPart {
    /// Lower-cased MIME type.
    pub mime_type: String,
    pub text: String,
}

/// `ParsedAddress`: the address lower-cased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAddress {
    pub email: String,
    pub name: Option<String>,
}

/// A raw message normalised for reply handling (`ParsedInbound`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedInbound {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    /// Oldest first, without angle brackets.
    pub references: Vec<String>,
    pub from: Option<ParsedAddress>,
    pub to: Vec<String>,
    pub subject: String,
    /// The text part, or the HTML part as text.
    pub text: String,
    /// Lower-cased header name to its first value.
    pub headers: HashMap<String, String>,
    /// The top-level `Content-Type` (empty when absent).
    pub content_type: String,
    pub report_parts: Vec<ReportPart>,
}

impl ParsedInbound {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// `str.toLowerCase()`.
pub(crate) fn js_lower(text: &str) -> String {
    text.to_lowercase()
}

/// The first `<…>` in `raw` whose inside has no `<`, `>` or white space,
/// from `from` on: (start of the inside, end of the inside).
fn bracketed_from(chars: &[char], from: usize) -> Option<(usize, usize)> {
    let mut p = from;
    while p < chars.len() {
        if chars[p] == '<' {
            let mut j = p + 1;
            while j < chars.len() && chars[j] != '<' && chars[j] != '>' && !is_js_space(chars[j]) {
                j += 1;
            }
            if j > p + 1 && j < chars.len() && chars[j] == '>' {
                return Some((p + 1, j));
            }
        }
        p += 1;
    }
    None
}

/// `normalizeMessageId(raw)`: `<abc@host>` to `abc@host`; `None` when empty.
pub fn normalize_message_id(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let chars: Vec<char> = raw.chars().collect();
    let value = match bracketed_from(&chars, 0) {
        Some((start, end)) => chars[start..end].iter().collect::<String>(),
        None => trim_edges(js_trim(raw), "<>").to_owned(),
    };
    let value = js_trim(&value);
    if value.is_empty() {
        return None;
    }
    Some(js_slice(value, MAX_ID_LENGTH))
}

/// `"a  b".split(/\s+/)`, as JavaScript splits.
pub(crate) fn js_split_ws(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split(is_js_space).collect();
    let last = pieces.len().saturating_sub(1);
    pieces
        .into_iter()
        .enumerate()
        .filter(|(i, piece)| *i == 0 || *i == last || !piece.is_empty())
        .map(|(_, piece)| piece)
        .collect()
}

/// `parseMessageIdList(raw)`: every Message-ID of an `In-Reply-To` /
/// `References` value, in order, without brackets, de-duplicated.
pub fn parse_message_id_list(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let chars: Vec<char> = raw.chars().collect();
    let mut bracketed = Vec::new();
    let mut from = 0;
    while let Some((start, end)) = bracketed_from(&chars, from) {
        bracketed.push(chars[start..end].iter().collect::<String>());
        from = end + 1;
    }
    let ids: Vec<String> = if bracketed.is_empty() {
        js_split_ws(raw)
            .into_iter()
            .filter(|s| s.contains('@'))
            .map(str::to_owned)
            .collect()
    } else {
        bracketed
    };
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let normalized = js_slice(js_trim(&id), MAX_ID_LENGTH);
        if normalized.is_empty() || out.contains(&normalized) {
            continue;
        }
        out.push(normalized);
    }
    out
}

/// `sha256Hex(raw)`.
pub fn sha256_hex(raw: &[u8]) -> String {
    hex::encode(Sha256::digest(raw))
}

/// `syntheticMessageId(raw)`: a stable id for a message without one.
pub fn synthetic_message_id(raw: &[u8]) -> String {
    format!("raw-{}@reach.invalid", &sha256_hex(raw)[..40])
}

/// `inboundAddress(token, domain)`: what a mailbox forwards to.
pub fn inbound_address(token: &str, inbound_domain: &str) -> String {
    format!(
        "{INBOUND_LOCAL_PART}+{token}@{}",
        js_trim(inbound_domain).to_lowercase()
    )
}

/// `extractAddress(raw)`: `Name <local@host>` or `local@host` to
/// `local@host`, lower-cased.
pub fn extract_address(raw: &str) -> String {
    // `/<([^<>]+)>/`: the first `<…>` with no `<` or `>` inside.
    let chars: Vec<char> = raw.chars().collect();
    let mut found = None;
    let mut p = 0;
    while p < chars.len() && found.is_none() {
        if chars[p] == '<' {
            let mut j = p + 1;
            while j < chars.len() && chars[j] != '<' && chars[j] != '>' {
                j += 1;
            }
            if j > p + 1 && j < chars.len() && chars[j] == '>' {
                found = Some(chars[p + 1..j].iter().collect::<String>());
            }
        }
        p += 1;
    }
    js_lower(js_trim(found.as_deref().unwrap_or(raw)))
}

/// `/^[a-z0-9][a-z0-9_-]{5,39}$/`.
fn is_token(local: &str) -> bool {
    let bytes = local.as_bytes();
    (6..=40).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

/// `parseInboundToken(recipient, inboundDomain)`: the token in an envelope
/// recipient, or `None` when the address is not an inbound one. Without a
/// domain (`REACH_INBOUND_DOMAIN` unset) any domain is accepted.
pub fn parse_inbound_token(recipient: &str, inbound_domain: Option<&str>) -> Option<String> {
    let address = extract_address(recipient);
    let at = address.rfind('@').filter(|at| *at > 0)?;
    let domain = &address[at + 1..];
    if let Some(expected) = inbound_domain.filter(|d| !d.is_empty())
        && domain != js_trim(expected).to_lowercase()
    {
        return None;
    }
    let mut local = &address[..at];
    if let Some(plus) = local.find('+') {
        let base = &local[..plus];
        local = if base == INBOUND_LOCAL_PART {
            &local[plus + 1..]
        } else {
            base
        };
    }
    is_token(local).then(|| local.to_owned())
}

fn to_parsed_address(address: Option<&MailAddress>) -> Option<ParsedAddress> {
    let address = address?;
    let mailbox = if address.address.is_some() {
        address
    } else {
        address.group.as_ref()?.first()?
    };
    let email = mailbox.address.as_deref().filter(|a| !a.is_empty())?;
    let name = js_trim(&mailbox.name);
    Some(ParsedAddress {
        email: js_lower(js_trim(email)),
        name: (!name.is_empty()).then(|| name.to_owned()),
    })
}

fn flatten_addresses(addresses: &[MailAddress]) -> Vec<String> {
    let mut out = Vec::new();
    for address in addresses {
        match address.address.as_deref() {
            Some(a) if !a.is_empty() => out.push(js_lower(js_trim(a))),
            Some(_) => {}
            None => {
                for member in address.group.iter().flatten() {
                    if let Some(a) = member.address.as_deref().filter(|a| !a.is_empty()) {
                        out.push(js_lower(js_trim(a)));
                    }
                }
            }
        }
    }
    out
}

/// `new TextDecoder().decode(content)` (a leading BOM dropped), capped.
fn decode_part(content: &[u8]) -> String {
    let text = String::from_utf8_lossy(content);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    js_slice(text, MAX_REPORT_PART_CHARS)
}

/// `bodyText(email)`: the text part, else the HTML part as text.
pub fn body_text(email: &Email) -> String {
    if let Some(text) = email.text.as_deref().filter(|t| !js_trim(t).is_empty()) {
        return text.to_owned();
    }
    if let Some(html) = email.html.as_deref().filter(|h| !js_trim(h).is_empty()) {
        return html_to_text(html);
    }
    String::new()
}

/// `parseInbound(raw)`.
pub fn parse_inbound(raw: &[u8]) -> Result<ParsedInbound, String> {
    let email = mime::parse(raw).map_err(|error| error.0)?;
    let mut headers: HashMap<String, String> = HashMap::new();
    for (key, value) in &email.headers {
        headers.entry(key.clone()).or_insert_with(|| value.clone());
    }
    let report_parts = email
        .attachments
        .iter()
        .filter_map(|attachment| {
            let mime_type = js_lower(&attachment.mime_type);
            REPORT_MIME_TYPES
                .contains(&mime_type.as_str())
                .then(|| ReportPart {
                    mime_type,
                    text: decode_part(&attachment.content),
                })
        })
        .collect();
    Ok(ParsedInbound {
        message_id: normalize_message_id(email.message_id.as_deref()),
        in_reply_to: normalize_message_id(email.in_reply_to.as_deref()),
        references: parse_message_id_list(email.references.as_deref()),
        from: to_parsed_address(email.from.as_ref()),
        to: flatten_addresses(&email.to),
        subject: js_trim(email.subject.as_deref().unwrap_or_default()).to_owned(),
        text: body_text(&email),
        content_type: headers.get("content-type").cloned().unwrap_or_default(),
        headers,
        report_parts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_ids() {
        assert_eq!(normalize_message_id(Some("<a@b>")).as_deref(), Some("a@b"));
        assert_eq!(normalize_message_id(Some("  a@b ")).as_deref(), Some("a@b"));
        assert_eq!(normalize_message_id(Some("")), None);
        assert_eq!(normalize_message_id(Some("<>")), None);
        assert_eq!(
            parse_message_id_list(Some("<a@b> <c@d>\r\n <a@b>")),
            ["a@b", "c@d"]
        );
        assert_eq!(parse_message_id_list(Some("a@b  c x@y")), ["a@b", "x@y"]);
    }

    #[test]
    fn splits_like_javascript() {
        assert_eq!(js_split_ws("a  b"), ["a", "b"]);
        assert_eq!(js_split_ws(" a"), ["", "a"]);
        assert_eq!(js_split_ws("a  "), ["a", ""]);
        assert_eq!(js_split_ws(""), [""]);
        assert_eq!(js_split_ws("  "), ["", ""]);
    }

    #[test]
    fn inbound_tokens() {
        let domain = Some("reply.weldreach.com");
        assert_eq!(
            parse_inbound_token("reply+abc123def@reply.weldreach.com", domain).as_deref(),
            Some("abc123def")
        );
        assert_eq!(
            parse_inbound_token("Reach <REPLY+abc123def@Reply.WeldReach.com>", domain).as_deref(),
            Some("abc123def")
        );
        assert_eq!(
            parse_inbound_token("abc123def+tag@reply.weldreach.com", domain).as_deref(),
            Some("abc123def")
        );
        assert_eq!(
            parse_inbound_token("reply+abc@reply.weldreach.com", domain),
            None
        );
        assert_eq!(
            parse_inbound_token("reply+abc123def@other.com", domain),
            None
        );
        assert_eq!(
            parse_inbound_token("reply+abc123def@other.com", None).as_deref(),
            Some("abc123def")
        );
        assert_eq!(
            inbound_address("tok123", " Reply.WeldReach.com "),
            "reply+tok123@reply.weldreach.com"
        );
    }

    #[test]
    fn synthetic_ids_are_stable() {
        let a = synthetic_message_id(b"From: a@b.c\r\n\r\nhi");
        assert_eq!(a, synthetic_message_id(b"From: a@b.c\r\n\r\nhi"));
        assert_ne!(a, synthetic_message_id(b"From: a@b.c\r\n\r\nhello"));
        assert!(a.ends_with("@reach.invalid"));
    }
}
