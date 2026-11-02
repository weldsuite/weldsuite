//! `POST /api/mail-messages/:id/forward` (`forwardAndPersist`): a forwarded
//! copy for new recipients, the original quoted inline (or attached as an
//! `.eml`), its files travelling with it unless the sender removed them.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use jiff::Timestamp;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::EMAIL_EMAIL_SENT;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_mail_domain::messages::mailbox_message;
use weldsuite_mail_domain::outbound::OutboundKind;
use weldsuite_mail_domain::outbound::clock::parse_iso;
use weldsuite_mail_domain::outbound::mime::{
    MailAddress, MimeAttachment, MimeMessage, build_rfc5322,
};
use weldsuite_mail_domain::send::{
    ExtraAttachment, SendError, SendInput, SendOptions, send_and_persist,
};
use weldsuite_mail_domain::text::{escape_html, html_to_text, plain_text_body};
use weldsuite_ports::get_stored;

use super::locate as locate_for_send;
use crate::routes::mail_accounts::email_event_data;
use crate::send::{
    RequestDoh, SendContext, attachments, emails, optional_text, send_error_response,
};
use crate::util::validate;
use crate::{Caller, MailState};

/// `forwardBody`.
struct ForwardInput {
    to: Vec<String>,
    body: Option<String>,
    html_body: Option<String>,
    attachments: Vec<weldsuite_mail_domain::send::SendAttachmentInput>,
    exclude: Vec<String>,
    as_attachment: bool,
    time_zone: Option<String>,
}

/// `forwardSubject(original)`: `Fwd: ` once.
fn forward_subject(original: Option<&str>) -> String {
    let subject = weldsuite_mail_domain::text::js_trim(original.unwrap_or_default());
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

/// A stored attachment: id, file name, content type, inline, storage path.
type StoredAttachment = (String, String, Option<String>, Option<bool>, Option<String>);

/// The original's own files minus the removed ones (`loadOriginalAttachments`).
async fn original_files(
    caller: &Caller,
    state: &MailState,
    message_id: &str,
    exclude: &[String],
) -> Result<Vec<ExtraAttachment>, SendError> {
    let rows: Vec<StoredAttachment> = sqlx::query_as(
        "select id, file_name, content_type, is_inline, storage_path from mail_attachments
         where message_id = $1 and deleted_at is null",
    )
    .bind(message_id)
    .fetch_all(&caller.db)
    .await?;
    let wanted: Vec<_> = rows
        .into_iter()
        .filter(|(id, _, _, inline, path)| {
            !inline.unwrap_or(false)
                && path.as_deref().is_some_and(|p| !p.is_empty())
                && !exclude.contains(id)
        })
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let buckets = caller.bindings.buckets(state);
    let Some(private) = buckets.private.as_ref().or(buckets.public.as_ref()) else {
        return Err(SendError::mail(
            "STORAGE_BINDING_MISSING",
            "Storage binding not configured",
        ));
    };
    let public = if buckets.private.is_some() {
        buckets.public.as_deref()
    } else {
        None
    };
    let mut loaded = Vec::new();
    for (_, file_name, content_type, _, path) in wanted {
        let object = get_stored(
            private.as_ref(),
            public,
            path.as_deref().unwrap_or_default(),
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

/// `POST /:id/forward`.
#[allow(clippy::too_many_lines)] // the route's steps, in TypeScript's order
pub(super) async fn forward(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, object| {
        let to = emails(issues, object, "to", Presence::Required, Some(1));
        let text = issues.text(object, "body", Presence::Optional, None, None);
        let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
        let files = attachments(issues, object);
        let exclude = issues.list(
            object,
            "excludeAttachmentIds",
            Presence::Optional,
            None,
            Some(100),
            |issues, item| issues.item_text(item, Text::default()),
        );
        let as_attachment = issues.boolean(object, "asAttachment", Presence::Optional);
        let time_zone = issues.text(object, "timeZone", Presence::Optional, None, Some(64));
        // `locale`: checked, but the quoted date is written for en-US.
        issues.text(object, "locale", Presence::Optional, None, Some(35));
        ForwardInput {
            to: to.unwrap_or_default(),
            body: optional_text(text),
            html_body: optional_text(html),
            attachments: files,
            exclude: exclude.into_option().unwrap_or_default(),
            as_attachment: as_attachment.into_option().unwrap_or(false),
            time_zone: optional_text(time_zone),
        }
    });
    let data = match input {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let account_id = match locate_for_send(&caller, &id).await {
        Ok(account) => account,
        Err(response) => return response,
    };
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let result = async {
        let original = mailbox_message(&caller.db, &account_id, &id, true, false)
            .await?
            .ok_or_else(|| SendError::mail("ACCOUNT_NOT_FOUND", "Original message not found"))?;
        let subject = forward_subject(original["subject"].as_str());
        let files = original_files(&caller, &state, &id, &data.exclude).await?;
        let (text, html, extras) = if data.as_attachment {
            let eml = eml_attachment(&original, &files);
            (data.body.clone(), data.html_body.clone(), vec![eml])
        } else {
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
                .unwrap_or_else(weldsuite_mail_domain::outbound::clock::now_ms);
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
            let note = plain_text_body(data.body.as_deref(), data.html_body.as_deref())
                .unwrap_or_default();
            let html_note = data
                .html_body
                .clone()
                .unwrap_or_else(|| escape_html(&note).replace('\n', "<br>"));
            (
                Some(format!("{note}{quoted_text}")),
                Some(format!("{html_note}{quoted_html}")),
                files,
            )
        };
        let input = SendInput {
            to: data.to.clone(),
            subject: Some(subject),
            body: text,
            html_body: html,
            attachments: data.attachments.clone(),
            ..SendInput::default()
        };
        let options = SendOptions {
            source: Some("forward".to_owned()),
            kind: Some(OutboundKind::Forward),
            workspace_id: Some(caller.workspace_id.clone()),
            extra_attachments: extras,
        };
        send_and_persist(
            &context.deps(&caller),
            &org,
            &caller.user_id,
            &account_id,
            &input,
            &options,
        )
        .await
    }
    .await;
    match result {
        Ok(result) => {
            let event = email_event_data(
                &caller,
                &result.account_id,
                json!({
                    "id": result.message_id,
                    "accountId": result.account_id,
                    "subject": result.subject,
                    "from": null,
                    "to": data.to,
                    "conversationId": id,
                }),
            )
            .await;
            caller.publish(&state, EMAIL_EMAIL_SENT, &result.message_id, &event);
            Data(json!({
                "messageId": result.message_id,
                "smtpMessageId": result.smtp_message_id,
                "pendingVerification": result.pending_verification,
                "forwardedFrom": id,
            }))
            .into_response()
        }
        Err(error) => send_error_response(error, "Message", Some(&id), "Failed to forward email"),
    }
}
