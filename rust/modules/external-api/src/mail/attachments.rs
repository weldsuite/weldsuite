//! `/v1/mail-attachments` (`routes/v1/mail-attachments/index.ts`): a
//! message's files, metadata and download. An attachment is reachable when
//! its message is. The download carries the headers WeldMail uses
//! (`attachment`, `no-store`, `nosniff`), so a file never renders inline
//! from an API origin. Uploading (`POST /`) is in [`super::sending`].
//!
//! On the EU and self-hosted editions a file the virus scan locked is not
//! served: 403 `ATTACHMENT_INFECTED`, or 409 `ATTACHMENT_SCAN_PENDING`, as
//! the platform answers (ADR MAIL-014). Global's rows have no scan, so its
//! answers are unchanged.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderValue, StatusCode, header};
use serde_json::json;
use weldsuite_mail_domain::access::principal_account_ids;
use weldsuite_mail_domain::attachments::{AttachmentRow, locate_attachment};
use weldsuite_ports::get_stored;

use super::MailCaller;
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, ok};
use crate::session::{internal, not_found};

/// The attachment when its message is in a mailbox the caller may open.
async fn reachable(mail: &MailCaller, id: &str) -> Result<Option<AttachmentRow>, Fail> {
    let accessible = principal_account_ids(mail.db(), &mail.principal).await?;
    if accessible.is_empty() {
        return Ok(None);
    }
    Ok(locate_attachment(mail.db(), id, &accessible)
        .await?
        .map(|(_, row)| row))
}

/// `encodeURIComponent(text)`.
fn encode_uri_component(text: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// RFC 6266 `attachment` with an ASCII fallback for old clients
/// (`contentDisposition(fileName)`).
fn content_disposition(file_name: &str) -> String {
    let mut ascii = String::with_capacity(file_name.len());
    let mut in_run = false;
    for c in file_name.chars() {
        if (' '..='~').contains(&c) {
            ascii.push(if c == '"' || c == '\\' { '_' } else { c });
            in_run = false;
        } else if !in_run {
            ascii.push('_');
            in_run = true;
        }
    }
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        encode_uri_component(file_name)
    )
}

/// The answer for a file the virus scan locked, if it is one.
fn scan_block(row: &AttachmentRow) -> Option<Response> {
    let (status, code, message) = match row.scan_status.as_deref() {
        Some("infected") => (
            StatusCode::FORBIDDEN,
            "ATTACHMENT_INFECTED",
            "This attachment contains a virus and can't be downloaded",
        ),
        Some("pending") => (
            StatusCode::CONFLICT,
            "ATTACHMENT_SCAN_PENDING",
            "This attachment is still being scanned for viruses",
        ),
        _ => return None,
    };
    Some(
        (
            status,
            axum::Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response(),
    )
}

/// `GET /:id`.
pub(super) async fn detail(mail: MailCaller, Path(id): Path<String>) -> Answer {
    match reachable(&mail, &id).await? {
        Some(row) => ok(row.public()),
        None => Err(not_found("MailAttachment", &id).into()),
    }
}

/// `GET /:id/download`.
pub(super) async fn download(
    State(state): State<ExternalApiState>,
    mail: MailCaller,
    Path(id): Path<String>,
) -> Answer {
    let Some(row) = reachable(&mail, &id).await? else {
        return Err(not_found("MailAttachment", &id).into());
    };
    let Some(path) = row.storage_path.clone().filter(|p| !p.is_empty()) else {
        return Err(not_found("MailAttachment", &id).into());
    };
    if let Some(blocked) = scan_block(&row) {
        return Ok(blocked);
    }
    let Some(files) = mail.bindings.files(&state) else {
        let body = json!({ "error": { "code": "STORAGE_UNAVAILABLE", "message": "File storage is not configured" } });
        return Ok((StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response());
    };
    let object = get_stored(files.private.as_ref(), files.public.as_deref(), &path)
        .await
        .map_err(|error| {
            tracing::error!(%error, "external-api: mail attachment download failed");
            Fail(internal().into_response())
        })?;
    let Some(object) = object else {
        return Err(not_found("MailAttachment", &id).into());
    };
    let content_type = row
        .content_type
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| object.info.content_type.clone().filter(|t| !t.is_empty()))
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let length = object.bytes.len();
    let mut response = Response::new(Body::from(object.bytes));
    let headers = response.headers_mut();
    let mut set = |name: header::HeaderName, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    };
    set(header::CONTENT_TYPE, content_type);
    set(header::CONTENT_LENGTH, length.to_string());
    set(
        header::CONTENT_DISPOSITION,
        content_disposition(&row.file_name),
    );
    set(header::CACHE_CONTROL, "private, no-store".to_owned());
    set(header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned());
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispositions_fall_back_to_ascii() {
        assert_eq!(
            content_disposition("résumé \"v2\".pdf"),
            "attachment; filename=\"r_sum_ _v2_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf"
        );
    }
}
