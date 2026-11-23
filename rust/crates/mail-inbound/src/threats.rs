//! WeldMail's threat protection at delivery (EU and self-hosted only;
//! Global never scanned): each attachment through the virus scanner, each
//! link through `weldsuite_mail_domain::threats`, once per message, before
//! it is stored in any mailbox.
//!
//! What the store does with the result ([`crate::store`]):
//!
//! - An **infected** attachment is never written to a bucket. Its row keeps
//!   the name, size and signature, and the message goes to Spam with a
//!   `threats` entry.
//! - A **malicious** link (a threat feed lists it) sends the message to Spam
//!   too; a **suspicious** one is only recorded.
//! - When the scanner can't be reached, the attachment is **pending**: kept
//!   in the private mail bucket under the message's `quarantine/` folder,
//!   not served, and the workspace is marked due for the
//!   `mail-attachment-scan` cron ([`crate::rescan`]). Mail is never held
//!   back for the scanner.
//! - Without a scanner configured nothing is scanned and attachments are
//!   stored as before.
//!
//! The helpdesk and accounting fan-out only gets the files that may be
//! served ([`MessageThreats::servable`]), and nothing at all from a message
//! that is dangerous.

use serde_json::Value;
use weldsuite_mail_domain::threats::{
    LinkFinding, LinkVerdict, attachment_threat_json, check_message_links,
};
use weldsuite_ports::{ScanVerdict, VirusScanner};

use crate::context::InboundContext;
use crate::parsed::{ParsedAttachment, ParsedEmail};

/// One attachment's scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentScan {
    /// No scanner configured: stored and served as before (`scan_status`
    /// null).
    NotScanned,
    Clean,
    Infected {
        signature: String,
    },
    /// The scanner could not be reached: locked until the rescan decides.
    Pending,
    /// The scanner answered but could not read it: served, with a warning
    /// (`scan_status` `error`).
    Unscannable,
}

impl AttachmentScan {
    /// The `scan_status` column.
    pub fn status(&self) -> Option<&'static str> {
        match self {
            Self::NotScanned => None,
            Self::Clean => Some("clean"),
            Self::Infected { .. } => Some("infected"),
            Self::Pending => Some("pending"),
            Self::Unscannable => Some("error"),
        }
    }

    /// The `scan_signature` column.
    pub fn signature(&self) -> Option<&str> {
        match self {
            Self::Infected { signature } => Some(signature),
            _ => None,
        }
    }

    /// Whether the file may be stored where it is served from, and handed to
    /// the helpdesk and accounting inboxes.
    pub fn is_servable(&self) -> bool {
        !matches!(self, Self::Infected { .. } | Self::Pending)
    }

    /// The scan as a verdict came back (the rescan's mapping too).
    pub fn from_verdict(verdict: ScanVerdict) -> Self {
        match verdict {
            ScanVerdict::Clean => Self::Clean,
            ScanVerdict::Infected { signature } => Self::Infected { signature },
            ScanVerdict::Unscannable { .. } => Self::Unscannable,
        }
    }
}

/// What the checks found in one message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageThreats {
    /// One per parsed attachment, in order.
    pub attachments: Vec<AttachmentScan>,
    /// The links that are not safe, worst first.
    pub links: Vec<LinkFinding>,
}

impl MessageThreats {
    /// Attachment `i`'s scan; [`AttachmentScan::NotScanned`] past the end.
    pub fn attachment(&self, i: usize) -> &AttachmentScan {
        self.attachments
            .get(i)
            .unwrap_or(&AttachmentScan::NotScanned)
    }

    /// An infected file or a malicious link: the message goes to Spam.
    pub fn is_dangerous(&self) -> bool {
        self.attachments
            .iter()
            .any(|a| matches!(a, AttachmentScan::Infected { .. }))
            || self
                .links
                .iter()
                .any(|l| l.verdict == LinkVerdict::Malicious)
    }

    pub fn has_pending(&self) -> bool {
        self.attachments.contains(&AttachmentScan::Pending)
    }

    /// Short reasons for the logs.
    pub fn reasons(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .attachments
            .iter()
            .enumerate()
            .filter_map(|(i, a)| match a {
                AttachmentScan::Infected { signature } => {
                    Some(format!("attachment {} infected ({signature})", i + 1))
                }
                AttachmentScan::Pending => Some(format!("attachment {} pending", i + 1)),
                _ => None,
            })
            .collect();
        out.extend(self.links.iter().map(|l| {
            format!(
                "link {} {}",
                l.verdict.as_str(),
                l.reasons.first().map_or("", |r| r.code)
            )
        }));
        out
    }

    /// The message's `threats` column: each infected attachment (with the
    /// id its row got in this mailbox, when stored) and each link finding.
    /// `None` when there is nothing to say.
    pub fn to_json(
        &self,
        attachments: &[ParsedAttachment],
        ids: &[Option<String>],
    ) -> Option<Value> {
        let mut out: Vec<Value> = Vec::new();
        for (i, scan) in self.attachments.iter().enumerate() {
            if let AttachmentScan::Infected { signature } = scan {
                let name = attachments.get(i).map_or("", |a| a.file_name.as_str());
                let id = ids.get(i).and_then(Option::as_deref);
                out.push(attachment_threat_json(name, id, signature));
            }
        }
        out.extend(self.links.iter().filter_map(LinkFinding::threat_json));
        (!out.is_empty()).then_some(Value::Array(out))
    }

    /// The attachments the helpdesk and accounting inboxes may take.
    pub fn servable(&self, attachments: &[ParsedAttachment]) -> Vec<ParsedAttachment> {
        attachments
            .iter()
            .enumerate()
            .filter(|(i, _)| self.attachment(*i).is_servable())
            .map(|(_, a)| a.clone())
            .collect()
    }
}

/// Each attachment through `scanner`. After the first one the scanner
/// can't take, the rest are pending without asking it again: one timeout
/// per message, not one per file.
pub async fn scan_attachments(
    scanner: Option<&dyn VirusScanner>,
    attachments: &[ParsedAttachment],
) -> Vec<AttachmentScan> {
    let Some(scanner) = scanner else {
        return vec![AttachmentScan::NotScanned; attachments.len()];
    };
    let mut out = Vec::with_capacity(attachments.len());
    let mut reachable = true;
    for (i, attachment) in attachments.iter().enumerate() {
        if !reachable {
            out.push(AttachmentScan::Pending);
            continue;
        }
        if attachment.content.is_empty() {
            out.push(AttachmentScan::Clean);
            continue;
        }
        match scanner.scan(&attachment.content).await {
            Ok(verdict) => out.push(AttachmentScan::from_verdict(verdict)),
            Err(error) => {
                tracing::warn!(%error, index = i + 1, "[Threats] scanner unreachable; attachments stay pending");
                reachable = false;
                out.push(AttachmentScan::Pending);
            }
        }
    }
    out
}

/// The checks for one message: its attachments and its links.
pub async fn inspect(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> MessageThreats {
    let attachments = scan_attachments(ctx.scanner.as_deref(), attachments).await;
    let links = check_message_links(
        &ctx.master,
        email.html_body.as_deref(),
        email.text_body.as_deref(),
    )
    .await;
    let threats = MessageThreats { attachments, links };
    if threats.is_dangerous() || threats.has_pending() || !threats.links.is_empty() {
        tracing::info!(
            dangerous = threats.is_dangerous(),
            reasons = %threats.reasons().join(", "),
            "[Threats] inspected"
        );
    }
    threats
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weldsuite_mail_domain::threats::LinkReason;
    use weldsuite_ports::{EICAR, FakeScanner};

    use super::*;

    fn att(name: &str, content: &[u8]) -> ParsedAttachment {
        ParsedAttachment {
            file_name: name.to_owned(),
            content_type: "application/octet-stream".to_owned(),
            content: content.to_vec(),
            content_id: None,
        }
    }

    #[tokio::test]
    async fn scans_until_the_scanner_goes_away() {
        let scanner = FakeScanner::new();
        let files = [
            att("a.txt", b"hello"),
            att("eicar.com", EICAR),
            att("e.txt", b""),
        ];
        assert_eq!(
            scan_attachments(Some(&scanner), &files).await,
            [
                AttachmentScan::Clean,
                AttachmentScan::Infected {
                    signature: FakeScanner::EICAR_SIGNATURE.to_owned()
                },
                AttachmentScan::Clean,
            ]
        );
        scanner.set_available(false);
        let before = scanner.scans();
        assert_eq!(
            scan_attachments(Some(&scanner), &files).await,
            [
                AttachmentScan::Pending,
                AttachmentScan::Pending,
                AttachmentScan::Pending
            ]
        );
        // One attempt, then the rest are pending without asking.
        assert_eq!(scanner.scans(), before + 1);
        assert_eq!(
            scan_attachments(None, &files).await,
            vec![AttachmentScan::NotScanned; 3]
        );
    }

    #[test]
    fn the_threats_column() {
        let files = [att("ok.pdf", b"x"), att("bad.exe", EICAR)];
        let threats = MessageThreats {
            attachments: vec![
                AttachmentScan::Clean,
                AttachmentScan::Infected {
                    signature: "Eicar-Signature".to_owned(),
                },
            ],
            links: vec![LinkFinding {
                url: "http://192.0.2.1/".to_owned(),
                verdict: LinkVerdict::Suspicious,
                reasons: vec![LinkReason {
                    code: "ip_host",
                    source: None,
                    threat: None,
                }],
            }],
        };
        assert!(threats.is_dangerous());
        assert!(!threats.has_pending());
        assert_eq!(
            threats.to_json(
                &files,
                &[Some("attach_1".to_owned()), Some("attach_2".to_owned())]
            ),
            Some(json!([
                { "kind": "attachment", "verdict": "infected", "fileName": "bad.exe",
                  "signature": "Eicar-Signature", "attachmentId": "attach_2" },
                { "kind": "link", "verdict": "suspicious", "url": "http://192.0.2.1/", "reason": "ip_host" },
            ]))
        );
        assert_eq!(threats.servable(&files).len(), 1);
        assert_eq!(MessageThreats::default().to_json(&files, &[]), None);
    }
}
