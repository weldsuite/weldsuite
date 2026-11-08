//! Reports that come back on the return path:
//!
//! - DSNs (RFC 3464, `multipart/report; report-type=delivery-status`): a
//!   server that accepted a message and could not deliver it after all.
//! - ARF complaint reports (RFC 5965, `report-type=feedback-report`): a
//!   mailbox provider's feedback loop (Yahoo CFL, Microsoft JMRP, …) saying a
//!   recipient marked the message as spam.
//!
//! Plus [`hard_failure`]: which permanent failures mean the address is gone
//! (suppressed) rather than this one message refused.

use crate::message::{self, content_type, header_value, headers, multipart_parts, param};

/// One recipient block of a DSN.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DsnRecipient {
    pub final_recipient: Option<String>,
    /// `failed`, `delayed`, `delivered`, `relayed`, `expanded`.
    pub action: String,
    /// `5.1.1`.
    pub status: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Report {
    Dsn(Vec<DsnRecipient>),
    Complaint {
        /// `abuse`, `fraud`, `virus`, `other`, …
        feedback_type: String,
        /// `X-WeldSuite-Mta-Id` of the original message, if included.
        mta_id: Option<String>,
        /// `Original-Mail-From` (our VERP address), if given.
        original_mail_from: Option<String>,
    },
    /// Anything else (auto-replies, spam to the bounce domain).
    Other,
}

/// What `message` reports.
pub fn parse(message_bytes: &[u8]) -> Report {
    find_report(message_bytes, 0).unwrap_or(Report::Other)
}

fn find_report(entity: &[u8], depth: u8) -> Option<Report> {
    if depth > 3 {
        return None;
    }
    let (block, body) = message::split(entity);
    let (kind, params) = content_type(&header_value(block, "content-type").unwrap_or_default());
    if !kind.starts_with("multipart/") {
        return None;
    }
    let boundary = param(&params, "boundary")?;
    let parts = multipart_parts(body, boundary);
    if kind == "multipart/report" {
        match param(&params, "report-type")
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("delivery-status") => return Some(dsn(&parts)),
            Some("feedback-report") => return Some(arf(&parts)),
            _ => {}
        }
    }
    parts.iter().find_map(|part| find_report(part, depth + 1))
}

fn part_type(part: &[u8]) -> String {
    let (block, _) = message::split(part);
    content_type(&header_value(block, "content-type").unwrap_or_else(|| "text/plain".into())).0
}

/// Field blocks separated by empty lines.
fn field_blocks(body: &[u8]) -> Vec<Vec<message::Header>> {
    let text = message::normalize_crlf(body);
    let text = String::from_utf8_lossy(&text);
    text.split("\r\n\r\n")
        .map(|block| headers(format!("{}\r\n", block.trim_matches(['\r', '\n'])).as_bytes()))
        .filter(|fields| !fields.is_empty())
        .collect()
}

fn field(fields: &[message::Header], name: &str) -> Option<String> {
    fields
        .iter()
        .find(|f| f.name.eq_ignore_ascii_case(name))
        .map(|f| f.value.clone())
}

/// `rfc822; bob@example.com` → `bob@example.com`.
fn typed_address(value: &str) -> String {
    value
        .split_once(';')
        .map_or(value, |(_, address)| address)
        .trim()
        .trim_matches(['<', '>'])
        .to_lowercase()
}

fn dsn(parts: &[&[u8]]) -> Report {
    let Some(status) = parts.iter().find(|part| {
        matches!(
            part_type(part).as_str(),
            "message/delivery-status" | "message/global-delivery-status"
        )
    }) else {
        return Report::Dsn(Vec::new());
    };
    let (_, body) = message::split(status);
    let blocks = field_blocks(body);
    // The first block is per-message; the rest are per-recipient.
    let recipients = blocks
        .iter()
        .skip(1)
        .filter_map(|fields| {
            let action = field(fields, "action")?.to_ascii_lowercase();
            Some(DsnRecipient {
                final_recipient: field(fields, "final-recipient").map(|v| typed_address(&v)),
                action,
                status: field(fields, "status").unwrap_or_default(),
                diagnostic: field(fields, "diagnostic-code").map(|v| {
                    v.split_once(';')
                        .map_or(v.as_str(), |(_, text)| text)
                        .trim()
                        .to_owned()
                }),
            })
        })
        .collect();
    Report::Dsn(recipients)
}

fn arf(parts: &[&[u8]]) -> Report {
    let mut feedback_type = "abuse".to_owned();
    let mut original_mail_from = None;
    let mut mta_id = None;
    for part in parts {
        let kind = part_type(part);
        let (_, body) = message::split(part);
        match kind.as_str() {
            "message/feedback-report" => {
                if let Some(fields) = field_blocks(body).first() {
                    if let Some(value) = field(fields, "feedback-type") {
                        feedback_type = value.to_ascii_lowercase();
                    }
                    original_mail_from =
                        field(fields, "original-mail-from").map(|v| typed_address(&v));
                }
            }
            "message/rfc822" | "text/rfc822-headers" | "message/rfc822-headers" => {
                let (original_headers, _) = message::split(body);
                mta_id = header_value(original_headers, "x-weldsuite-mta-id")
                    .map(|v| v.trim().to_ascii_lowercase());
            }
            _ => {}
        }
    }
    Report::Complaint {
        feedback_type,
        mta_id,
        original_mail_from,
    }
}

/// Whether a permanent failure says the address does not exist (or is
/// disabled), so it should be suppressed. Policy and content refusals
/// (5.7.x), a full mailbox (5.2.2) and size refusals are not.
pub fn hard_failure(enhanced: Option<(u8, u16, u16)>, code: u16, text: &str) -> bool {
    match enhanced {
        // 5.1.7 and 5.1.8 are about the sender, not the recipient.
        Some((5, 1, 7 | 8)) => false,
        Some((5, 1, _) | (5, 2, 1)) => true,
        Some(_) => false,
        None => {
            let lower = text.to_lowercase();
            matches!(code, 550 | 551 | 553)
                && [
                    "unknown",
                    "no such",
                    "does not exist",
                    "doesn't exist",
                    "not exist",
                    "invalid recipient",
                    "user not found",
                    "recipient not found",
                    "mailbox unavailable",
                    "address rejected",
                ]
                .iter()
                .any(|phrase| lower.contains(phrase))
        }
    }
}

/// `5.1.1` → `(5, 1, 1)`.
pub fn parse_status(status: &str) -> Option<(u8, u16, u16)> {
    let mut parts = status.trim().split(['.', ' ']);
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSN: &[u8] = b"From: MAILER-DAEMON@mx.example.com\r\n\
To: b+rabc-0123456789abcdef@bounces.eu.test\r\n\
Subject: Undelivered Mail\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/report; report-type=delivery-status;\r\n\tboundary=\"XYZ\"\r\n\
\r\n\
--XYZ\r\n\
Content-Type: text/plain\r\n\
\r\n\
Your message could not be delivered.\r\n\
--XYZ\r\n\
Content-Type: message/delivery-status\r\n\
\r\n\
Reporting-MTA: dns; mx.example.com\r\n\
Arrival-Date: Sat, 7 Nov 2026 12:00:00 +0000\r\n\
\r\n\
Final-Recipient: rfc822; Bob@Example.com\r\n\
Action: failed\r\n\
Status: 5.1.1\r\n\
Diagnostic-Code: smtp; 550 5.1.1 <bob@example.com>: Recipient address rejected\r\n\
\r\n\
--XYZ\r\n\
Content-Type: text/rfc822-headers\r\n\
\r\n\
X-WeldSuite-Mta-Id: rabc\r\n\
Subject: hello\r\n\
\r\n\
--XYZ--\r\n";

    #[test]
    fn reads_a_dsn() {
        let Report::Dsn(recipients) = parse(DSN) else {
            panic!("not a DSN");
        };
        assert_eq!(recipients.len(), 1);
        assert_eq!(
            recipients[0].final_recipient.as_deref(),
            Some("bob@example.com")
        );
        assert_eq!(recipients[0].action, "failed");
        assert_eq!(parse_status(&recipients[0].status), Some((5, 1, 1)));
        assert_eq!(
            recipients[0].diagnostic.as_deref(),
            Some("550 5.1.1 <bob@example.com>: Recipient address rejected")
        );
    }

    #[test]
    fn reads_an_arf_complaint() {
        let arf = b"From: staff@hotmail.com\r\n\
Content-Type: multipart/report; report-type=feedback-report; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain\r\n\
\r\n\
This is an email abuse report.\r\n\
--b\r\n\
Content-Type: message/feedback-report\r\n\
\r\n\
Feedback-Type: abuse\r\n\
User-Agent: JMRP/1.0\r\n\
Version: 1\r\n\
Original-Mail-From: <b+rxyz-0011223344556677@bounces.eu.test>\r\n\
\r\n\
--b\r\n\
Content-Type: message/rfc822\r\n\
\r\n\
From: anna@acme.eu\r\n\
X-WeldSuite-Mta-Id: rXYZ\r\n\
\r\n\
body\r\n\
--b--\r\n";
        assert_eq!(
            parse(arf),
            Report::Complaint {
                feedback_type: "abuse".into(),
                mta_id: Some("rxyz".into()),
                original_mail_from: Some("b+rxyz-0011223344556677@bounces.eu.test".into()),
            }
        );
    }

    #[test]
    fn ignores_other_mail() {
        assert_eq!(
            parse(b"Subject: Out of office\r\n\r\nI'm away.\r\n"),
            Report::Other
        );
    }

    #[test]
    fn tells_hard_from_soft_failures() {
        assert!(hard_failure(Some((5, 1, 1)), 550, "no such user"));
        assert!(hard_failure(Some((5, 2, 1)), 550, "disabled"));
        assert!(!hard_failure(Some((5, 1, 7)), 553, "bad sender address"));
        assert!(!hard_failure(
            Some((5, 1, 8)),
            550,
            "Sender address rejected: Domain not found"
        ));
        assert!(!hard_failure(Some((5, 7, 1)), 550, "blocked by policy"));
        assert!(!hard_failure(Some((5, 2, 2)), 552, "mailbox full"));
        assert!(hard_failure(
            None,
            550,
            "User unknown in local recipient table"
        ));
        assert!(!hard_failure(None, 554, "message rejected as spam"));
        assert_eq!(parse_status("4.4.7"), Some((4, 4, 7)));
        assert_eq!(parse_status("x"), None);
    }
}
