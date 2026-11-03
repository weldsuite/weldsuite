//! A raw message as the storage pipeline reads it: `parseRawEmail`
//! (`@weldsuite/email`), the `Authentication-Results` read of
//! `CloudflareReceiveProvider`, and the worker's `adaptCloudflareEmail`
//! (`cf-email-adapter.ts`), in one step.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};

use crate::mime::{self, Email, MailAddress, ParseError};

/// `EmailAddress`: `{ email, name? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailAddress {
    pub email: String,
    pub name: Option<String>,
}

impl EmailAddress {
    pub fn new(email: &str, name: Option<&str>) -> Self {
        Self {
            email: email.to_owned(),
            name: name.map(str::to_owned),
        }
    }

    /// The JSON the mail tables store (`name` left out when unset).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("email".to_owned(), json!(self.email));
        if let Some(name) = &self.name {
            map.insert("name".to_owned(), json!(name));
        }
        Value::Object(map)
    }

    /// `parseEmailAddress({ email: address, name })` of a postal-mime
    /// address: no address (or a group) is `unknown@unknown.com`.
    fn from_mail(address: &MailAddress) -> Self {
        let email = address
            .address
            .as_deref()
            .filter(|a| !a.is_empty())
            .unwrap_or(UNKNOWN);
        Self {
            email: email.to_owned(),
            name: Some(address.name.clone()),
        }
    }
}

const UNKNOWN: &str = "unknown@unknown.com";

/// `ParsedAttachment` (the worker's shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttachment {
    pub file_name: String,
    pub content_type: String,
    pub content: Vec<u8>,
    pub content_id: Option<String>,
}

/// `ParsedEmail` (`email-storage.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEmail {
    /// A per-delivery id (`nanoid()`), naming its stored files.
    pub email_id: String,
    pub message_id: String,
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    /// The SMTP envelope recipients (`RCPT TO`).
    pub envelope_to: Vec<String>,
    pub subject: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    /// Lower-cased header names, the last value of each, in the order the
    /// names first appear (`headers[key] = value` over postal-mime's list).
    pub headers: Vec<(String, String)>,
    /// `receivedAt` in milliseconds since the epoch.
    pub received_at: i64,
    pub has_attachments: bool,
    pub attachment_count: usize,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub spf_status: Option<String>,
    pub dkim_status: Option<String>,
    pub dmarc_status: Option<String>,
    /// The raw RFC 5322 bytes (`rawMessageBytes`).
    pub raw: Vec<u8>,
}

impl ParsedEmail {
    /// `isReply`: threading headers present.
    pub fn is_reply(&self) -> bool {
        self.in_reply_to.as_deref().is_some_and(|r| !r.is_empty())
            || self.references.as_ref().is_some_and(|r| !r.is_empty())
    }

    /// `email.headers[name]`, any case.
    pub fn header(&self, name: &str) -> Option<&str> {
        header_value(&self.headers, name)
    }
}

/// `headerValue(headers, name)`: the first header whose name matches, any
/// case.
pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name) || k.to_lowercase() == name.to_lowercase())
        .map(|(_, v)| v.as_str())
}

/// `/<name>=(\w+)/i.exec(auth)?.[1]`.
fn auth_result(auth: &str, name: &str) -> Option<String> {
    let lower = auth.to_ascii_lowercase();
    let needle = format!("{name}=");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let start = from + found + needle.len();
        let word: String = auth[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !word.is_empty() {
            return Some(word);
        }
        from = start;
    }
    None
}

/// `toSecurityStatus(s)`: only the values the column takes.
fn security_status(value: Option<String>) -> Option<String> {
    value.filter(|v| {
        matches!(
            v.as_str(),
            "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror"
        )
    })
}

/// The `Authentication-Results` the receiving MX wrote, as Cloudflare's
/// `message.headers.get('authentication-results')` hands it over: every
/// such header, in order, joined with `, `.
pub fn authentication_results(email: &Email) -> String {
    email
        .headers
        .iter()
        .filter(|(k, _)| k == "authentication-results")
        .map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// SPF, DKIM and DMARC as `CloudflareReceiveProvider.parse` reads them
/// from `Authentication-Results`, narrowed as the adapter narrows them.
pub fn auth_statuses(auth: &str) -> (Option<String>, Option<String>, Option<String>) {
    (
        security_status(auth_result(auth, "spf")),
        security_status(auth_result(auth, "dkim")),
        security_status(auth_result(auth, "dmarc")),
    )
}

/// `cryptoRandomMessageId()`, made from `seed` so a redelivered message
/// gets the same id (and is recognised as a duplicate).
fn fallback_message_id(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(seed.as_bytes());
    let hex: String = digest[..16].iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    });
    format!("<{hex}@weldmail.local>")
}

/// `adaptCloudflareEmail(message)` over raw bytes: the parsed email and its
/// attachments. `email_id` names this delivery's stored files; `seed`
/// derives a missing Message-ID; `now_ms` is the receipt time when the
/// message has no usable `Date`.
pub fn parse_inbound(
    raw: &[u8],
    envelope_to: &[String],
    email_id: &str,
    seed: &str,
    now_ms: i64,
) -> Result<(ParsedEmail, Vec<ParsedAttachment>), ParseError> {
    let email = mime::parse(raw)?;
    let auth = authentication_results(&email);
    let (spf, dkim, dmarc) = auth_statuses(&auth);
    let attachments: Vec<ParsedAttachment> = email
        .attachments
        .iter()
        .map(|att| ParsedAttachment {
            file_name: att
                .filename
                .clone()
                .unwrap_or_else(|| "attachment".to_owned()),
            content_type: att.mime_type.clone(),
            content: att.content.clone(),
            content_id: att.content_id.clone(),
        })
        .collect();
    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in &email.headers {
        let key = key.to_lowercase();
        if let Some(slot) = headers.iter_mut().find(|(k, _)| *k == key) {
            slot.1.clone_from(value);
        } else {
            headers.push((key, value.clone()));
        }
    }
    let received_at = email
        .date
        .as_deref()
        .filter(|d| !d.is_empty())
        .and_then(mime::parse_date)
        .unwrap_or(now_ms);
    let html = weldsuite_mail_domain::html::sanitize_email_html(email.html.as_deref());
    let parsed = ParsedEmail {
        email_id: email_id.to_owned(),
        message_id: email
            .message_id
            .clone()
            .unwrap_or_else(|| fallback_message_id(seed)),
        from: email
            .from
            .as_ref()
            .map_or_else(|| EmailAddress::new(UNKNOWN, None), EmailAddress::from_mail),
        to: email.to.iter().map(EmailAddress::from_mail).collect(),
        cc: email.cc.iter().map(EmailAddress::from_mail).collect(),
        envelope_to: envelope_to.to_vec(),
        subject: email.subject.clone().unwrap_or_default(),
        text_body: email.text.clone(),
        html_body: (!html.is_empty()).then_some(html),
        headers,
        received_at,
        has_attachments: !attachments.is_empty(),
        attachment_count: attachments.len(),
        in_reply_to: email.in_reply_to.clone(),
        references: email.references.as_deref().map(|r| {
            r.split(mime::is_js_space)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        }),
        spf_status: spf,
        dkim_status: dkim,
        dmarc_status: dmarc,
        raw: raw.to_vec(),
    };
    Ok((parsed, attachments))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_authentication_results_as_cloudflare_does() {
        assert_eq!(
            auth_statuses(
                "mx.weldsuite.eu; spf=pass smtp.mailfrom=a@b.c; dkim=fail header.d=b.c; dmarc=none"
            ),
            (
                Some("pass".to_owned()),
                Some("fail".to_owned()),
                Some("none".to_owned())
            )
        );
        // Values outside the column's enum, and upper case, are dropped.
        assert_eq!(auth_statuses("x; SPF=PASS dkim=policy"), (None, None, None));
    }

    #[test]
    fn parses_a_message() {
        let raw = b"From: Sender <sender@example.com>\r\nTo: Recipient <recipient@example.com>\r\nSubject: Hello\r\nMessage-ID: <abc123@example.com>\r\nAuthentication-Results: mx.test; spf=pass smtp.mailfrom=sender@example.com; dkim=none; dmarc=none\r\n\r\nBody text.\r\n";
        let (email, attachments) = parse_inbound(
            raw,
            &["recipient@example.com".to_owned()],
            "e1",
            "inbound/k1",
            0,
        )
        .expect("parses");
        assert_eq!(attachments.len(), 0);
        assert_eq!(email.subject, "Hello");
        assert_eq!(email.from.email, "sender@example.com");
        assert_eq!(email.spf_status.as_deref(), Some("pass"));
        assert_eq!(email.text_body.as_deref(), Some("Body text.\n"));
        assert_eq!(email.envelope_to, ["recipient@example.com"]);
        assert_eq!(email.raw, raw);
    }
}
