//! Forward (`forwardAndPersist`, `@weldsuite/mail-domain/send`): a copy of
//! a message for new recipients, the original quoted inline (or attached as
//! an `.eml`), its files travelling with it unless the sender removed them.
//! The platform (`/api/mail-messages/:id/forward`) and the public API
//! (`/v1/mail-messages/:id/forward`) both send through here.

use jiff::Timestamp;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use serde_json::Value;
use weldsuite_ports::{FileStores, get_stored};

use crate::messages::mailbox_message;
use crate::outbound::OutboundKind;
use crate::outbound::clock::{now_ms, parse_iso};
use crate::outbound::mime::{MailAddress, MimeAttachment, MimeMessage, build_rfc5322};
use crate::send::{
    ExtraAttachment, SendAttachmentInput, SendDeps, SendError, SendInput, SendOptions, SendResult,
    send_and_persist,
};
use crate::text::{escape_html, html_to_text, js_trim, plain_text_body};

/// `ForwardInput`.
#[derive(Debug, Clone, Default)]
pub struct ForwardInput {
    pub to: Vec<String>,
    pub body: Option<String>,
    pub html_body: Option<String>,
    /// Files the sender uploaded for the forward.
    pub attachments: Vec<SendAttachmentInput>,
    /// Ids of the original's attachments to leave out.
    pub exclude: Vec<String>,
    /// Attach the original as an `.eml` file instead of quoting it.
    pub as_attachment: bool,
    /// The sender's zone, for the quoted date (UTC when unknown).
    pub time_zone: Option<String>,
    pub idempotency_key: Option<String>,
}

/// `forwardSubject(original)`: `Fwd: ` once.
pub fn forward_subject(original: Option<&str>) -> String {
    let subject = js_trim(original.unwrap_or_default());
    let lower = subject.to_lowercase();
    let prefixed = lower
        .strip_prefix("fwd:")
        .or_else(|| lower.strip_prefix("fw:"))
        .is_some();
    if prefixed {
        return subject.to_owned();
    }
    let rest = if subject.is_empty() {
        "(No subject)"
    } else {
        subject
    };
    format!("Fwd: {rest}")
}

/// `formatAddress(addr)`.
fn format_address(addr: &Value) -> String {
    if !addr.is_object() {
        return String::new();
    }
    let email = addr["email"].as_str().unwrap_or_default();
    match addr["name"].as_str().filter(|n| !n.is_empty()) {
        Some(name) => format!("{name} <{email}>"),
        None => email.to_owned(),
    }
}

/// `formatForwardDate(date, timeZone, locale)` for `en-US`: `Sun, Mar 1,
/// 2026, 9:00 AM UTC`, in the sender's zone (UTC when unknown or invalid).
fn format_forward_date(millis: i64, time_zone: Option<&str>) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let zone_name = time_zone
        .filter(|z| !z.is_empty() && TimeZone::get(z).is_ok())
        .unwrap_or("UTC");
    let Ok(at) = Timestamp::from_millisecond(millis) else {
        return String::new();
    };
    let Ok(zone) = TimeZone::get(zone_name) else {
        return String::new();
    };
    let date = at.to_zoned(zone).date();
    let weekday = match date.weekday() {
        Weekday::Monday => "Mon",
        Weekday::Tuesday => "Tue",
        Weekday::Wednesday => "Wed",
        Weekday::Thursday => "Thu",
        Weekday::Friday => "Fri",
        Weekday::Saturday => "Sat",
        Weekday::Sunday => "Sun",
    };
    let month = MONTHS[usize::try_from(date.month() - 1).unwrap_or(0)];
    let time =
        weldsuite_emails::format_time(millis, weldsuite_emails::EmailLocale::En, zone_name, true)
            .unwrap_or_default();
    format!("{weekday}, {month} {}, {}, {time}", date.day(), date.year())
}

/// The original's own files minus the removed ones
/// (`loadOriginalAttachments`), and minus what the virus scan locked
/// (`scan_status` `infected` or `pending`, EU and self-hosted only): a
/// forward never carries those on. `files` are the buckets as
/// `getStoredObject` reads them (the private one first).
pub async fn original_files(
    db: &weldsuite_db::PgPool,
    files: Option<&FileStores>,
    message_id: &str,
    exclude: &[String],
) -> Result<Vec<ExtraAttachment>, SendError> {
    // The message's live files, `scan_status` read through `to_jsonb`: the
    // conformance suite's database has the frozen Drizzle schema, without
    // the column.
    let rows = crate::attachments::list_for_message(db, message_id).await?;
    let wanted: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            !row.is_inline.unwrap_or(false)
                && row.storage_path.as_deref().is_some_and(|p| !p.is_empty())
                && !exclude.contains(&row.id)
                && !matches!(row.scan_status.as_deref(), Some("infected" | "pending"))
        })
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let Some(files) = files else {
        return Err(SendError::mail(
            "STORAGE_BINDING_MISSING",
            "Storage binding not configured",
        ));
    };
    let mut loaded = Vec::new();
    for row in wanted {
        let file_name = row.file_name;
        let content_type = row.content_type;
        let object = get_stored(
            files.private.as_ref(),
            files.public.as_deref(),
            row.storage_path.as_deref().unwrap_or_default(),
        )
        .await
        .map_err(|error| SendError::Internal(error.to_string()))?;
        let Some(object) = object else {
            return Err(SendError::mail(
                "ATTACHMENT_NOT_IN_STORAGE",
                format!("Attachment {file_name} not found in storage"),
            ));
        };
        loaded.push(ExtraAttachment {
            filename: file_name,
            content_type: content_type
                .filter(|t| !t.is_empty())
                .or(object.info.content_type),
            content: object.bytes,
        });
    }
    Ok(loaded)
}

/// `buildEmlAttachment`: the original rebuilt from its stored row (the
/// Kubernetes editions keep no raw copy apart from it).
fn eml_attachment(original: &Value, files: &[ExtraAttachment]) -> ExtraAttachment {
    let address = |v: &Value| {
        v.get("email")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
            .map(|email| MailAddress {
                email: email.to_owned(),
                name: v.get("name").and_then(Value::as_str).map(str::to_owned),
            })
    };
    let list = |v: &Value| -> Vec<MailAddress> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(address)
            .collect()
    };
    let from = address(&original["from"]).unwrap_or_else(|| MailAddress::new("unknown@invalid"));
    let date = original["sentDate"]
        .as_str()
        .or_else(|| original["createdAt"].as_str())
        .and_then(parse_iso)
        .and_then(|ms| Timestamp::from_millisecond(ms).ok())
        .map(|t| t.strftime("%a, %d %b %Y %H:%M:%S GMT").to_string())
        .unwrap_or_default();
    let message = MimeMessage {
        from: Some(from),
        to: list(&original["to"]),
        cc: list(&original["cc"]),
        subject: original["subject"].as_str().unwrap_or_default().to_owned(),
        text: original["textBody"].as_str().map(str::to_owned),
        html: original["htmlBody"].as_str().map(str::to_owned),
        message_id: original["messageId"].as_str().map(str::to_owned),
        headers: vec![("Date".to_owned(), date)],
        attachments: files
            .iter()
            .map(|f| MimeAttachment {
                filename: f.filename.clone(),
                content_type: f.content_type.clone(),
                content: f.content.clone(),
                cid: None,
            })
            .collect(),
        ..MimeMessage::default()
    };
    let content = build_rfc5322(&message)
        .map(|built| built.raw)
        .unwrap_or_default();
    let mut name = String::new();
    let mut last_space = false;
    for ch in original["subject"].as_str().unwrap_or_default().chars() {
        let ch = if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || ch.is_whitespace()
        {
            ' '
        } else {
            ch
        };
        if ch == ' ' {
            if !last_space {
                name.push(' ');
            }
            last_space = true;
        } else {
            name.push(ch);
            last_space = false;
        }
    }
    let name: String = name.trim().chars().take(100).collect();
    ExtraAttachment {
        filename: format!("{}.eml", if name.is_empty() { "message" } else { &name }),
        content_type: Some("application/octet-stream".to_owned()),
        content,
    }
}

/// The forward's text and HTML: the sender's note, then the original quoted
/// under the "Forwarded message" header block.
fn quoted(original: &Value, data: &ForwardInput) -> (String, String) {
    let sender = Some(format_address(&original["from"]))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown".to_owned());
    let to_label = original["to"]
        .as_array()
        .into_iter()
        .flatten()
        .map(format_address)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let millis = ["sentDate", "receivedDate", "createdAt"]
        .iter()
        .find_map(|k| original[*k].as_str().and_then(parse_iso))
        .unwrap_or_else(now_ms);
    let sent_on = format_forward_date(millis, data.time_zone.as_deref());
    let original_subject = original["subject"].as_str().unwrap_or_default();
    let original_text = original["textBody"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            original["htmlBody"]
                .as_str()
                .filter(|h| !h.is_empty())
                .map(html_to_text)
        })
        .unwrap_or_default();
    let mut header_lines = vec![
        format!("From: {sender}"),
        format!("Date: {sent_on}"),
        format!("Subject: {original_subject}"),
    ];
    if !to_label.is_empty() {
        header_lines.push(format!("To: {to_label}"));
    }
    let quoted_text = format!(
        "\n\n---------- Forwarded message ----------\n{}\n\n{original_text}",
        header_lines.join("\n")
    );
    let mut quoted_header = vec![
        format!("<b>From:</b> {}", escape_html(&sender)),
        format!("<b>Date:</b> {}", escape_html(&sent_on)),
        format!("<b>Subject:</b> {}", escape_html(original_subject)),
    ];
    if !to_label.is_empty() {
        quoted_header.push(format!("<b>To:</b> {}", escape_html(&to_label)));
    }
    let original_html = original["htmlBody"].as_str().map_or_else(
        || {
            format!(
                "<div style=\"white-space:pre-wrap\">{}</div>",
                escape_html(&original_text)
            )
        },
        str::to_owned,
    );
    let quoted_html = format!(
        "<br><br><div style=\"border-left:2px solid #ccc;padding-left:1em;color:#555\"><p>---------- Forwarded message ----------</p><p>{}</p>{original_html}</div>",
        quoted_header.join("<br>")
    );
    let note = plain_text_body(data.body.as_deref(), data.html_body.as_deref()).unwrap_or_default();
    let html_note = data
        .html_body
        .clone()
        .unwrap_or_else(|| escape_html(&note).replace('\n', "<br>"));
    (
        format!("{note}{quoted_text}"),
        format!("{html_note}{quoted_html}"),
    )
}

/// `forwardAndPersist(env, db, orgId, caller, originalMessageId, data, opts)`:
/// `original_id` in `account_id`'s mailbox (the caller has checked it may
/// open it) forwarded to `data.to`. `files` are the buckets the original's
/// files are read from.
#[allow(clippy::too_many_arguments)] // `forwardAndPersist`'s parameters, and the buckets
pub async fn forward_and_persist(
    deps: &SendDeps<'_>,
    files: Option<&FileStores>,
    org: &str,
    user_id: &str,
    account_id: &str,
    original_id: &str,
    data: &ForwardInput,
    opts: &SendOptions,
) -> Result<SendResult, SendError> {
    let original = mailbox_message(deps.db, account_id, original_id, true, false)
        .await?
        .ok_or_else(|| SendError::mail("ACCOUNT_NOT_FOUND", "Original message not found"))?;
    let subject = forward_subject(original["subject"].as_str());
    let originals = original_files(deps.db, files, original_id, &data.exclude).await?;
    let (text, html, extras) = if data.as_attachment {
        let eml = eml_attachment(&original, &originals);
        (data.body.clone(), data.html_body.clone(), vec![eml])
    } else {
        let (text, html) = quoted(&original, data);
        (Some(text), Some(html), originals)
    };
    let input = SendInput {
        to: data.to.clone(),
        subject: Some(subject),
        body: text,
        html_body: html,
        attachments: data.attachments.clone(),
        idempotency_key: data.idempotency_key.clone(),
        ..SendInput::default()
    };
    let options = opts.derived("forward", Some(OutboundKind::Forward), extras);
    send_and_persist(deps, org, user_id, account_id, &input, &options).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_subjects_get_one_prefix() {
        assert_eq!(forward_subject(Some("Hello")), "Fwd: Hello");
        assert_eq!(forward_subject(Some(" FW: Hello ")), "FW: Hello");
        assert_eq!(forward_subject(Some("fwd:x")), "fwd:x");
        assert_eq!(forward_subject(None), "Fwd: (No subject)");
    }
}
