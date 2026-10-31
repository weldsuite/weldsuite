//! `routes/attachments.ts` and `lib/attachments.ts`: a visitor's file
//! uploads, and which files a message may reference.
//!
//! `POST /api/attachments/upload` stores a file at
//! `widgets/{clerkOrgId}/{conversationId}/{timestamp}_{attachmentId}_{name}`
//! in the public bucket and hands back its public URL. A message may only
//! point at such a URL, issued for the same workspace and conversation, so a
//! visitor cannot make an agent's inbox link to another host or to a file of
//! someone else's thread. Only passive types are accepted: the bucket's host
//! would run the script in an SVG or HTML file.

use axum::Extension;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_desk_domain::webchat;
use weldsuite_events::new_event_id;
use weldsuite_kit::generate_id;
use weldsuite_ports::{PutOptions, RealtimeMessage};

use crate::auth::Widget;
use crate::conversations::ClaimedAttachment;
use crate::{Ctx, WidgetState, bad_request, internal, not_found_error, success};

/// `MAX_MESSAGE_ATTACHMENTS`.
pub(crate) const MAX_MESSAGE_ATTACHMENTS: usize = 10;
/// The largest file, 10 MiB.
const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;
/// The largest upload body: a file over [`MAX_FILE_SIZE`] still gets the
/// route's own 400 up to here.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// `ALLOWED_TYPES`. No SVG: it is a document that can carry script.
const ALLOWED_TYPES: [&str; 10] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

pub(crate) fn body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_BODY)
}

/// `publicStorageBase(env)`: the public bucket's URL without trailing
/// slashes, or `None` when it is not configured.
fn public_storage_base(ctx: &Ctx, state: &WidgetState) -> Option<String> {
    let base = ctx.public_storage_url(state)?;
    let base = weldsuite_kit::validation::js_trim(&base).trim_end_matches('/');
    (!base.is_empty()).then(|| base.to_owned())
}

/// `/^\d+_att_[a-z0-9]+_[A-Za-z0-9._-]*$/`: the object name the upload
/// route writes.
fn is_object_name(name: &str) -> bool {
    let Some((digits, rest)) = name.split_once("_att_") else {
        return false;
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // `[a-z0-9]+_` then the file name: try every split, as the regex
    // backtracks over an id followed by `_`.
    rest.match_indices('_').any(|(at, _)| {
        let (id, file) = (&rest[..at], &rest[at + 1..]);
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && file
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}

/// `ownedAttachmentKey(env, workspaceId, conversationId, url)`: the object
/// key behind a URL issued for the conversation, or `None`.
fn owned_attachment_key(
    base: &str,
    workspace_id: &str,
    conversation_id: &str,
    url: &str,
) -> Option<String> {
    let folder = format!("widgets/{workspace_id}/{conversation_id}/");
    let object = url.strip_prefix(&format!("{base}/{folder}"))?;
    is_object_name(object).then(|| format!("{folder}{object}"))
}

/// `resolveVisitorAttachments(env, workspaceId, conversationId, attachments)`:
/// the attachments as stored (the bucket's size and type win over the
/// client's), or the 400's message. `Err` is a bucket failure.
pub(crate) async fn resolve_visitor_attachments(
    ctx: &Ctx,
    state: &WidgetState,
    workspace_id: &str,
    conversation_id: &str,
    claimed: Vec<ClaimedAttachment>,
) -> Result<Result<Vec<Value>, &'static str>, String> {
    let Some(base) = public_storage_base(ctx, state) else {
        return Ok(Err("File attachments are not available"));
    };
    let mut resolved = Vec::with_capacity(claimed.len());
    for attachment in claimed {
        let Some(key) = owned_attachment_key(&base, workspace_id, conversation_id, &attachment.url)
        else {
            return Ok(Err("Attachment was not uploaded to this conversation"));
        };
        let bucket = ctx
            .public_bucket(state)
            .ok_or("Cannot read properties of undefined (reading 'head')")?;
        let Some(object) = bucket
            .head_boxed(&key)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(Err("Attachment was not found"));
        };
        let mut stored = json!({
            "name": attachment.name,
            "url": attachment.url,
            "contentType": object.content_type.unwrap_or(attachment.content_type),
            "filesize": object.size,
        });
        if let Some(width) = attachment.width.filter(|w| *w != 0) {
            stored["width"] = json!(width);
        }
        if let Some(height) = attachment.height.filter(|h| *h != 0) {
            stored["height"] = json!(height);
        }
        resolved.push(stored);
    }
    Ok(Ok(resolved))
}

/// One form field as `formData.get(name)` reads it: a string, or a file.
enum FormValue {
    Text(String),
    File {
        name: String,
        content_type: String,
        bytes: Vec<u8>,
    },
}

/// The first value of each field, or `None` when the body is not form data
/// (`c.req.formData()` throws).
async fn form(request: Request) -> Option<Vec<(String, FormValue)>> {
    let content_type = request
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.starts_with("application/x-www-form-urlencoded") {
        let bytes = axum::body::to_bytes(request.into_body(), MAX_BODY)
            .await
            .ok()?;
        let mut fields: Vec<(String, FormValue)> = Vec::new();
        for (key, value) in form_urlencoded::parse(&bytes) {
            if !fields.iter().any(|(known, _)| *known == key) {
                fields.push((key.into_owned(), FormValue::Text(value.into_owned())));
            }
        }
        return Some(fields);
    }
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut fields: Vec<(String, FormValue)> = Vec::new();
    while let Some(field) = multipart.next_field().await.ok()? {
        let name = field.name().unwrap_or_default().to_owned();
        let file_name = field.file_name().map(str::to_owned);
        // A part without a type is `text/plain`; `File#type` is lower case.
        let content_type = field
            .content_type()
            .unwrap_or("text/plain")
            .to_ascii_lowercase();
        let bytes = field.bytes().await.ok()?;
        if fields.iter().any(|(known, _)| *known == name) {
            continue;
        }
        let value = match file_name {
            Some(file_name) => FormValue::File {
                name: file_name,
                content_type,
                bytes: bytes.to_vec(),
            },
            None => FormValue::Text(String::from_utf8_lossy(&bytes).into_owned()),
        };
        fields.push((name, value));
    }
    Some(fields)
}

/// `ID_PATTERN`: `/^[A-Za-z0-9_-]{1,64}$/`, as ids go into the object key.
fn is_id(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// `file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')`, one `_` per UTF-16 unit.
fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn text_field<'a>(fields: &'a [(String, FormValue)], name: &str) -> Option<&'a str> {
    fields.iter().find_map(|(key, value)| match value {
        FormValue::Text(text) if key == name => Some(text.as_str()),
        _ => None,
    })
}

/// `POST /api/attachments/upload`.
#[allow(clippy::too_many_lines)] // the TypeScript route, step by step
pub(crate) async fn upload(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    request: Request,
) -> Response {
    let unavailable = || internal("File upload not available");
    let Some(bucket) = ctx.public_bucket(&state) else {
        tracing::error!("[Widget] storage bucket not configured");
        return unavailable();
    };
    // No fallback host: without the public bucket's URL, links would point
    // into another environment's bucket.
    let Some(base) = public_storage_base(&ctx, &state) else {
        tracing::error!("[Widget] R2_PUBLIC_URL not configured");
        return unavailable();
    };
    let failed = || internal("Failed to upload attachment");
    let Some(fields) = form(request).await else {
        return failed();
    };
    let file = fields
        .iter()
        .find(|(key, _)| key == "file")
        .and_then(|(_, value)| match value {
            FormValue::File {
                name,
                content_type,
                bytes,
            } => Some((name, content_type, bytes)),
            FormValue::Text(_) => None,
        });
    let Some((name, content_type, bytes)) = file else {
        return bad_request("No file provided");
    };
    let Some(conversation_id) = text_field(&fields, "conversationId").filter(|id| is_id(id)) else {
        return bad_request("conversationId is required");
    };
    let Some(visitor_id) = text_field(&fields, "visitorId").filter(|id| is_id(id)) else {
        return bad_request("visitorId is required");
    };
    match webchat::get(&widget.db, conversation_id, false).await {
        Ok(Some((conversation, _))) if conversation["visitorId"].as_str() == Some(visitor_id) => {}
        Ok(_) => return not_found_error("Conversation", conversation_id),
        Err(error) => {
            tracing::error!(%error, "[Widget] Failed to upload attachment");
            return failed();
        }
    }
    if bytes.len() > MAX_FILE_SIZE {
        return bad_request("File too large (max 10MB)");
    }
    if !ALLOWED_TYPES.contains(&content_type.as_str()) {
        return bad_request(&format!("File type not allowed: {content_type}"));
    }
    let attachment_id = generate_id("att");
    let timestamp = i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default();
    let file_key = format!(
        "widgets/{}/{conversation_id}/{timestamp}_{attachment_id}_{}",
        widget.clerk_org_id,
        sanitize(name)
    );
    if let Err(error) = bucket
        .put_boxed(
            &file_key,
            bytes.clone(),
            &PutOptions::content_type(content_type.clone()),
        )
        .await
    {
        tracing::error!(%error, "[Widget] Failed to upload attachment");
        return failed();
    }
    let url = format!("{base}/{file_key}");
    let data = json!({
        "id": attachment_id,
        "fileName": name,
        "fileSize": bytes.len(),
        "mimeType": content_type,
        "url": url,
        "fileKey": file_key,
    });
    publish_attachment_created(
        &state,
        &widget,
        &attachment_id,
        data.clone(),
        conversation_id,
    );
    success(StatusCode::CREATED, data)
}

/// The widget's own `publishEntityEvent` for `helpdesk_attachment:created`:
/// to the workspace hub's `helpdesk` topic. Its other half, the analytics
/// queue, has no counterpart on the Kubernetes editions (analytics is an
/// unavailable feature there).
fn publish_attachment_created(
    state: &WidgetState,
    widget: &Widget,
    attachment_id: &str,
    mut data: Value,
    conversation_id: &str,
) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    data["conversationId"] = json!(conversation_id);
    let event_type = "helpdesk_attachment:created";
    let message = json!({
        "id": new_event_id(),
        "eventType": event_type,
        "entityType": "helpdesk_attachment",
        "entityId": attachment_id,
        "action": "created",
        "data": data,
        "metadata": {
            "workspaceId": widget.clerk_org_id,
            "userId": widget.id,
            "timestamp": webchat::now(),
            "source": "widget",
        },
    });
    let published = RealtimeMessage::workspace(
        &widget.clerk_org_id,
        "helpdesk",
        event_type,
        message,
        "system",
    );
    state.events.tracker().spawn(async move {
        if let Err(error) = realtime.publish_boxed(&published).await {
            tracing::error!(%error, "[EntityEvents] Failed to publish realtime platform event");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_names_are_the_upload_routes() {
        assert!(is_object_name("1700000000000_att_abc123xyz_screenshot.png"));
        assert!(is_object_name("1_att_a_"));
        assert!(is_object_name("1_att_a_b_c.txt"));
        assert!(!is_object_name("x_att_abc_a.png"));
        assert!(!is_object_name("1_att__a.png"));
        assert!(!is_object_name("1_att_ABC_a.png"));
        assert!(!is_object_name("1_att_abc_a b.png"));
        assert!(!is_object_name("../1_att_abc_a.png"));
    }

    #[test]
    fn only_urls_issued_for_the_conversation_resolve() {
        let base = "https://files.test";
        let url = "https://files.test/widgets/org_1/dconv_1/1700000000000_att_abc_shot.png";
        assert_eq!(
            owned_attachment_key(base, "org_1", "dconv_1", url).as_deref(),
            Some("widgets/org_1/dconv_1/1700000000000_att_abc_shot.png")
        );
        assert_eq!(owned_attachment_key(base, "org_1", "dconv_2", url), None);
        assert_eq!(
            owned_attachment_key("https://other.test", "org_1", "dconv_1", url),
            None
        );
    }

    #[test]
    fn names_are_sanitised_per_utf16_unit() {
        assert_eq!(sanitize("my file (1).png"), "my_file__1_.png");
        assert_eq!(sanitize("é😀.txt"), "___.txt");
    }

    #[test]
    fn ids_match_the_pattern() {
        assert!(is_id("dconv_abc-1"));
        assert!(!is_id(""));
        assert!(!is_id("a/b"));
        assert!(!is_id(&"a".repeat(65)));
    }
}
