//! `@weldsuite/smtp`'s message side and its contract: `buildMimeMessage`
//! (RFC 5322 text, CRLF lines, quoted-printable bodies, encoded words),
//! `generateMessageId`, and the transport a send goes through
//! ([`SmtpTransport`]: the module's SMTP client, or the conformance bridge).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_ports::BoxFuture;

const CRLF: &str = "\r\n";
const MAX_LINE_LENGTH: usize = 78;
const MAX_ENCODED_WORD_BYTES: usize = 42;
const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RESERVED_HEADERS: &[&str] = &[
    "message-id",
    "date",
    "from",
    "to",
    "cc",
    "bcc",
    "sender",
    "reply-to",
    "subject",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "content-id",
    "return-path",
    "received",
];

/// `SmtpConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    /// Implicit TLS (465); otherwise STARTTLS.
    pub secure: bool,
    pub username: String,
    pub password: String,
}

impl SmtpConfig {
    /// The config as the conformance bridge sends it (`sendMail`'s first
    /// argument).
    pub fn to_json(&self) -> Value {
        json!({
            "host": self.host,
            "port": self.port,
            "secure": self.secure,
            "username": self.username,
            "password": self.password,
        })
    }
}

/// `SmtpEnvelope`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpEnvelope {
    pub from: String,
    pub to: Vec<String>,
}

/// `SmtpSendResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpSendResult {
    pub ok: bool,
    pub response: String,
    /// Where it failed (`SmtpStage`); empty on success.
    pub stage: String,
    pub permanent: bool,
    pub recipient_rejected: bool,
    pub auth_failed: bool,
    pub delivery_uncertain: bool,
}

impl SmtpSendResult {
    /// From `sendMail`'s result object (the conformance bridge's answer).
    pub fn from_json(value: &Value) -> Self {
        let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        Self {
            ok: flag("ok"),
            response: text("response"),
            stage: text("stage"),
            permanent: flag("permanent"),
            recipient_rejected: flag("recipientRejected"),
            auth_failed: flag("authFailed"),
            delivery_uncertain: flag("deliveryUncertain"),
        }
    }
}

/// How a message leaves: `sendMail(config, envelope, raw)`. An `Err` is an
/// exception (`send_threw`); SMTP failures are `Ok` results.
pub trait SmtpTransport: Send + Sync {
    fn send(&self, config: SmtpConfig, envelope: SmtpEnvelope, raw: String) -> BoxFuture<'_, Result<SmtpSendResult, String>>;
}

/// `MailAddress`.
#[derive(Debug, Clone)]
pub struct MailAddress {
    pub email: String,
    pub name: Option<String>,
}

/// `OutgoingMessage`.
#[derive(Debug, Clone)]
pub struct OutgoingMessage {
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub reply_to: Option<MailAddress>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    pub message_id: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub headers: Vec<(String, String)>,
    pub date: OffsetDateTime,
}

fn random_hex(bytes: usize) -> String {
    weldsuite_kit::random_string(bytes * 2, "0123456789abcdef")
}

fn trim_dots_and_hyphens(value: &str) -> &str {
    value.trim_matches(|c| c == '.' || c == '-')
}

/// `generateMessageId(domain)`: `<random>.<base36 ms>@domain`, no brackets.
pub fn generate_message_id(domain: &str) -> Result<String, String> {
    let after_at = &domain[domain.rfind('@').map_or(0, |at| at + 1)..];
    let lowered = after_at.trim().to_lowercase();
    let filtered: String = lowered
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    let cleaned = trim_dots_and_hyphens(&filtered);
    if cleaned.is_empty() {
        return Err("generateMessageId: a domain is required".to_owned());
    }
    let ms = u64::try_from(crate::epoch_ms(crate::now())).unwrap_or_default();
    Ok(format!("{}.{}@{cleaned}", random_hex(16), base36(ms)))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn format_date(date: OffsetDateTime) -> String {
    let weekday = DAYS[usize::from(date.weekday().number_days_from_sunday())];
    let month = MONTHS[usize::from(u8::from(date.month())) - 1];
    format!(
        "{weekday}, {:02} {month} {} {:02}:{:02}:{:02} +0000",
        date.day(),
        date.year(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

fn fold_header(name: &str, chunks: &[String]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut current = format!("{name}:");
    let mut has_content = false;
    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        if !has_content {
            current.push(' ');
            current.push_str(chunk);
            has_content = true;
        } else if crate::js_len(&current) + 1 + crate::js_len(chunk) <= MAX_LINE_LENGTH {
            current.push(' ');
            current.push_str(chunk);
        } else {
            lines.push(std::mem::take(&mut current));
            current = format!(" {chunk}");
        }
    }
    lines.push(current);
    lines.join(CRLF)
}

fn clean_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_control = false;
    for c in value.chars() {
        let control = (c as u32) <= 0x1f || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}';
        if control {
            if !in_control {
                out.push(' ');
            }
            in_control = true;
        } else {
            out.push(c);
            in_control = false;
        }
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut previous_space = false;
    for c in out.chars() {
        if c == ' ' && previous_space {
            continue;
        }
        previous_space = c == ' ';
        collapsed.push(c);
    }
    crate::text::js_trim(&collapsed).to_owned()
}

fn printable_ascii(text: &str) -> bool {
    text.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn needs_encoding(text: &str) -> bool {
    if !printable_ascii(text) {
        return true;
    }
    // `/=\?.*\?=/`: an `=?` followed later by `?=`.
    text.find("=?").is_some_and(|start| text[start + 2..].contains("?="))
}

fn encode_word(text: &str) -> String {
    format!("=?UTF-8?B?{}?=", STANDARD.encode(text.as_bytes()))
}

fn encode_as_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut size = 0;
    for c in text.chars() {
        let bytes = c.len_utf8();
        if size + bytes > MAX_ENCODED_WORD_BYTES {
            words.push(encode_word(&current));
            current.clear();
            size = 0;
        }
        current.push(c);
        size += bytes;
    }
    if !current.is_empty() {
        words.push(encode_word(&current));
    }
    words
}

fn unstructured_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    let cleaned = clean_text(value);
    for word in cleaned.split(' ') {
        if word.is_empty() {
            continue;
        }
        if needs_encoding(word) {
            run.push(word);
        } else {
            if !run.is_empty() {
                chunks.extend(encode_as_words(&run.join(" ")));
                run.clear();
            }
            chunks.push(word.to_owned());
        }
    }
    if !run.is_empty() {
        chunks.extend(encode_as_words(&run.join(" ")));
    }
    chunks
}

fn sanitize_email(email: &str) -> Result<String, String> {
    let cleaned: String = email
        .chars()
        .filter(|c| !((*c as u32) <= 0x20 || *c == '\u{7f}' || *c == '<' || *c == '>'))
        .collect();
    if cleaned.is_empty() {
        return Err("buildMimeMessage: an email address is required".to_owned());
    }
    Ok(cleaned)
}

fn is_atext_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b))
}

fn mailbox_chunks(address: &MailAddress) -> Result<Vec<String>, String> {
    let email = sanitize_email(&address.email)?;
    let name = address.name.as_deref().map(clean_text).unwrap_or_default();
    if name.is_empty() {
        return Ok(vec![email]);
    }
    let angle = format!("<{email}>");
    if printable_ascii(&name) && !name.contains("=?") {
        let words: Vec<&str> = name.split(' ').collect();
        if words.iter().all(|w| is_atext_word(w)) {
            let mut out: Vec<String> = words.iter().map(|w| (*w).to_owned()).collect();
            out.push(angle);
            return Ok(out);
        }
        let quoted = format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""));
        let mut out: Vec<String> = quoted.split(' ').map(str::to_owned).collect();
        out.push(angle);
        return Ok(out);
    }
    let mut out = encode_as_words(&name);
    out.push(angle);
    Ok(out)
}

fn address_list_chunks(addresses: &[MailAddress]) -> Result<Vec<String>, String> {
    let mut chunks = Vec::new();
    for (index, address) in addresses.iter().enumerate() {
        let mut parts = mailbox_chunks(address)?;
        if index < addresses.len() - 1
            && let Some(last) = parts.last_mut()
        {
            last.push(',');
        }
        chunks.extend(parts);
    }
    Ok(chunks)
}

fn clean_message_id(id: &str) -> String {
    id.chars().filter(|c| ('\u{21}'..='\u{7e}').contains(c) && *c != '<' && *c != '>').collect()
}

fn format_message_id(id: &str) -> Option<String> {
    let cleaned = clean_message_id(id);
    (!cleaned.is_empty()).then(|| format!("<{cleaned}>"))
}

fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

fn quoted_printable(text: &str) -> String {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = normalised.split('\n').collect();
    if lines.len() > 1 && lines.last() == Some(&"") {
        lines.pop();
    }
    lines.iter().map(|l| qp_line(l)).collect::<Vec<_>>().join(CRLF)
}

fn qp_line(line: &str) -> String {
    let bytes = line.as_bytes();
    let tokens: Vec<String> = bytes
        .iter()
        .enumerate()
        .map(|(i, &byte)| {
            let whitespace = byte == 0x20 || byte == 0x09;
            let literal = if whitespace {
                i < bytes.len() - 1
            } else {
                (0x21..=0x7e).contains(&byte) && byte != 0x3d
            };
            if literal {
                (byte as char).to_string()
            } else {
                format!("={}{}", HEX[usize::from(byte >> 4)] as char, HEX[usize::from(byte & 0x0f)] as char)
            }
        })
        .collect();
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, token) in tokens.iter().enumerate() {
        let limit = if index == tokens.len() - 1 { 76 } else { 75 };
        if current.len() + token.len() > limit {
            out.push(format!("{current}="));
            current.clear();
        }
        current.push_str(token);
    }
    out.push(current);
    out.join(CRLF)
}

/// `buildMimeMessage(message)`.
pub fn build_mime_message(message: &OutgoingMessage) -> Result<String, String> {
    let mut headers = vec![
        fold_header("Date", &[format_date(message.date)]),
        fold_header("From", &address_list_chunks(std::slice::from_ref(&message.from))?),
        fold_header(
            "To",
            &if message.to.is_empty() {
                vec!["undisclosed-recipients:;".to_owned()]
            } else {
                address_list_chunks(&message.to)?
            },
        ),
    ];
    if let Some(reply_to) = &message.reply_to {
        headers.push(fold_header("Reply-To", &address_list_chunks(std::slice::from_ref(reply_to))?));
    }
    headers.push(fold_header("Subject", &unstructured_chunks(&message.subject)));
    let id = format_message_id(&message.message_id).ok_or("buildMimeMessage: a message id is required")?;
    headers.push(fold_header("Message-ID", &[id]));
    if let Some(in_reply_to) = message.in_reply_to.as_deref().filter(|v| !v.is_empty()) {
        let id = format_message_id(in_reply_to).ok_or("buildMimeMessage: a message id is required")?;
        headers.push(fold_header("In-Reply-To", &[id]));
    }
    let references: Vec<String> = message.references.iter().filter_map(|r| format_message_id(r)).collect();
    if !references.is_empty() {
        headers.push(fold_header("References", &references));
    }
    headers.push("MIME-Version: 1.0".to_owned());
    for (raw_name, raw_value) in &message.headers {
        let name = raw_name.trim();
        if !is_header_name(name) || RESERVED_HEADERS.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        let chunks = unstructured_chunks(raw_value);
        if !chunks.is_empty() {
            headers.push(fold_header(name, &chunks));
        }
    }
    let text_body = quoted_printable(&message.text);
    let html = message.html.as_deref().filter(|h| !crate::text::js_trim(h).is_empty());
    let Some(html) = html else {
        headers.push("Content-Type: text/plain; charset=utf-8".to_owned());
        headers.push("Content-Transfer-Encoding: quoted-printable".to_owned());
        return Ok(format!("{}{CRLF}{CRLF}{text_body}{CRLF}", headers.join(CRLF)));
    };
    let html_body = quoted_printable(html);
    let boundary = loop {
        let candidate = format!("_weld_alt_{}", random_hex(16));
        if !text_body.contains(&candidate) && !html_body.contains(&candidate) {
            break candidate;
        }
    };
    headers.push(format!("Content-Type: multipart/alternative;{CRLF} boundary=\"{boundary}\""));
    let part = |kind: &str| format!("Content-Type: {kind}; charset=utf-8{CRLF}Content-Transfer-Encoding: quoted-printable{CRLF}{CRLF}");
    Ok(format!(
        "{}{CRLF}{CRLF}--{boundary}{CRLF}{}{text_body}{CRLF}--{boundary}{CRLF}{}{html_body}{CRLF}--{boundary}--{CRLF}",
        headers.join(CRLF),
        part("text/plain"),
        part("text/html"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_message() {
        let raw = build_mime_message(&OutgoingMessage {
            from: MailAddress {
                email: "jane@getacme.com".to_owned(),
                name: Some("Jane Doe".to_owned()),
            },
            to: vec![MailAddress {
                email: "ann@x.com".to_owned(),
                name: None,
            }],
            reply_to: None,
            subject: "Héllo there".to_owned(),
            text: "Hi =\nbye".to_owned(),
            html: None,
            message_id: "abc@getacme.com".to_owned(),
            in_reply_to: None,
            references: Vec::new(),
            headers: vec![("List-Unsubscribe".to_owned(), "<mailto:jane@getacme.com?subject=unsubscribe>".to_owned())],
            date: OffsetDateTime::UNIX_EPOCH,
        })
        .expect("message");
        assert!(raw.starts_with("Date: Thu, 01 Jan 1970 00:00:00 +0000\r\nFrom: Jane Doe <jane@getacme.com>\r\n"));
        assert!(raw.contains("Subject: =?UTF-8?B?SMOpbGxv?= there\r\n"));
        assert!(raw.contains("Message-ID: <abc@getacme.com>\r\n"));
        assert!(raw.ends_with("Hi =3D\r\nbye\r\n"));
        assert!(generate_message_id("jane@GetAcme.com").expect("id").ends_with("@getacme.com"));
    }
}
