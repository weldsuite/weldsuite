//! `routes/desk-conversations/index.ts`: the webchat inbox at
//! `/api/desk/conversations` (list, thread, agent file uploads, replies and
//! notes, close / reopen / assign). Writes go through
//! [`super::webchat::append_desk_message`]; every change is published live
//! (workspace hub, and the visitor's conversation room for public entries)
//! and as entity events.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::PgPool;
use weldsuite_desk_domain::notify::EntityKind;
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_mail_domain::outbound::content_screen::ScreenAttachment;
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, GuardedSendError, MimeAttachment, OutboundKind, SendEmailParams,
    SubjectInput, TransmitError, guarded_send, send_email,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{PutOptions, RealtimeMessage};

use super::Ctx;
use super::attributes;
use super::webchat::{self, Append, AppendError, Author};
use crate::notify::{Assigned, assigned};
use crate::{DeskState, Refusal, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/attributes", get(attribute_options).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_attributes).route_layer(update()))
        .route(
            "/{id}/attachments",
            post(upload)
                .route_layer(update())
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/{id}/reply", post(reply).route_layer(update()))
        .route("/{id}/manage", post(manage).route_layer(update()))
}

const CHANNELS: &[&str] = &[
    "messenger",
    "email",
    "phone",
    "whatsapp",
    "sms",
    "api",
    "portal",
];

/// `zValidator('query', schema)`: the query's values, or the 400.
#[allow(clippy::result_large_err)] // the response is the route's answer
fn read_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(value)
}

/// `isDeskSchemaMissing(err)`.
fn schema_missing(error: &sqlx::Error) -> bool {
    let code = error
        .as_database_error()
        .and_then(|e| e.code().map(std::borrow::Cow::into_owned));
    if matches!(code.as_deref(), Some("42P01" | "42703")) {
        return true;
    }
    let message = error.to_string().to_lowercase();
    (message.contains("column ") || message.contains("relation "))
        && message.contains(" does not exist")
}

// ── GET / ─────────────────────────────────────────────────────────────────────

async fn list(ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let query = match read_query(query.as_deref(), |issues, values| {
        let text = |issues: &mut Issues, key: &str, rules: Text| {
            issues
                .text_with(values, key, Presence::Optional, rules)
                .into_option()
        };
        let state = issues
            .choice(values, "state", Presence::Optional, &["open", "closed"])
            .into_option();
        let assignee_id = text(issues, "assigneeId", Text::length(None, Some(255)));
        // `z.coerce.boolean()`: `Boolean(value)`.
        let unassigned = values.get("unassigned").is_some_and(|v| match v {
            Value::String(s) => !s.is_empty(),
            _ => true,
        });
        let channel = issues
            .choice(values, "channel", Presence::Optional, CHANNELS)
            .into_option();
        let visitor_id = text(issues, "visitorId", Text::length(None, Some(64)));
        let email = text(issues, "email", Text::trimmed(None, Some(255)));
        let q = text(issues, "q", Text::trimmed(None, Some(200)));
        let priority = issues
            .choice(
                values,
                "priority",
                Presence::Optional,
                &["low", "medium", "high", "urgent", "none"],
            )
            .into_option();
        let ticket_type_id = text(issues, "ticketTypeId", Text::length(None, Some(30)));
        let department_id = text(issues, "departmentId", Text::length(None, Some(30)));
        let tag = text(
            issues,
            "tag",
            Text::trimmed(Some(1), Some(attributes::MAX_TAG_LENGTH)),
        );
        let sort = issues
            .choice(
                values,
                "sort",
                Presence::Optional,
                &["newest", "oldest", "waiting_longest"],
            )
            .into_option();
        let cursor = text(issues, "cursor", Text::default());
        let limit = issues
            .number(
                values,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(100.0),
                },
            )
            .into_option();
        webchat::ListQuery {
            state,
            assignee_id,
            unassigned,
            channel,
            visitor_id,
            email,
            q,
            priority,
            ticket_type_id,
            department_id,
            tag,
            sort,
            cursor,
            limit,
        }
    }) {
        Ok(query) => query,
        Err(response) => return response,
    };
    match webchat::list(&ctx.caller.db, &query).await {
        Ok((data, total, has_more, cursor)) => List::new(
            data,
            Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
        )
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "[app-api/desk-conversations] list failed");
            if schema_missing(&error) {
                return ApiError::unavailable(
                    "WeldDesk schema is not applied. Run tenant migration 0185_welddesk_webchat.",
                )
                .into_response();
            }
            ApiError::internal()
                .with_message("Failed to list conversations")
                .into_response()
        }
    }
}

// ── GET /:id ──────────────────────────────────────────────────────────────────

async fn detail(ctx: Ctx, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let include = match read_query(query.as_deref(), |issues, values| {
        issues
            .choice(values, "include", Presence::Optional, &["messages"])
            .into_option()
    }) {
        Ok(include) => include,
        Err(response) => return response,
    };
    let with_messages = include.as_deref() == Some("messages");
    let db = &ctx.caller.db;
    let found = match webchat::get(db, &id, with_messages).await {
        Ok(found) => found,
        Err(error) => return Refusal::Database(error).respond("Failed to fetch conversation"),
    };
    let Some((mut conversation, messages)) = found else {
        return ApiError::not_found("Conversation", Some(&id)).into_response();
    };
    let custom_fields = match attributes::custom_fields(db, &conversation).await {
        Ok(fields) => fields,
        Err(error) => return Refusal::Database(error).respond("Failed to fetch conversation"),
    };
    if let Some(object) = conversation.as_object_mut() {
        object.insert("customFields".to_owned(), Value::Object(custom_fields));
        if with_messages {
            object.insert("messages".to_owned(), Value::Array(messages));
        }
    }
    Data(conversation).into_response()
}

// ── GET /attributes ───────────────────────────────────────────────────────────

/// Ticket types, their fields, teams and tags in use, for the details panel.
async fn attribute_options(ctx: Ctx) -> Response {
    match attributes::options(&ctx.caller.db).await {
        Ok(options) => Data(options).into_response(),
        Err(error) => {
            tracing::error!(%error, "[desk-api/desk-conversations] attribute options failed");
            ApiError::internal()
                .with_message("Failed to load conversation attributes")
                .into_response()
        }
    }
}

// ── PATCH /:id ────────────────────────────────────────────────────────────────

/// `updateConversationAttributesSchema`.
fn attributes_schema(issues: &mut Issues, body: &Map<String, Value>) -> attributes::Update {
    const KEYS: [&str; 5] = [
        "ticketTypeId",
        "priority",
        "tags",
        "departmentId",
        "customFields",
    ];
    let ticket_type_id = issues.text(body, "ticketTypeId", Presence::Nullish, None, Some(30));
    let priority = issues.choice(body, "priority", Presence::Nullish, attributes::PRIORITIES);
    let tags = issues
        .list(
            body,
            "tags",
            Presence::Optional,
            None,
            Some(attributes::MAX_TAGS),
            |issues, item| {
                issues.item_text(
                    item,
                    Text::trimmed(Some(1), Some(attributes::MAX_TAG_LENGTH)),
                )
            },
        )
        .into_option();
    let department_id = issues.text(body, "departmentId", Presence::Nullish, None, Some(30));
    // `z.record(z.string().max(100), z.unknown())`: only the keys are checked.
    let _ = issues.nested(
        body,
        "customFields",
        Presence::Optional,
        |issues, fields| {
            for key in fields.keys() {
                if key.encode_utf16().count() > 100 {
                    issues.string_too_big(key, 100, "String must contain at most 100 character(s)");
                }
            }
        },
    );
    // `.refine(data => Object.values(data).some(v => v !== undefined))`.
    if KEYS.iter().all(|key| !body.contains_key(*key)) {
        issues.custom_root("Nothing to update");
    }
    attributes::Update {
        ticket_type_id,
        priority,
        tags,
        department_id,
        custom_fields: Vec::new(),
    }
}

/// Set the conversation's ticket fields: type, priority, tags, team and the
/// type's custom fields. The change goes on the timeline as an internal
/// event (never to the visitor); a request that changes nothing writes
/// nothing.
async fn update_attributes(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut input = match validate(&headers, &body, attributes_schema) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to update conversation"),
    };
    // The custom field values in the body's order, as `Object.entries` reads them.
    if let Some(weldsuite_core_domain::js::Js::Object(entries)) =
        weldsuite_core_domain::js::parse_body(&body).get("customFields")
    {
        input.custom_fields.clone_from(entries);
    }
    let caller = &ctx.caller;
    let updated = match attributes::update(&caller.db, &id, &caller.user_id, &input).await {
        Ok(updated) => updated,
        Err(attributes::UpdateError::NotFound) => {
            return ApiError::not_found("Conversation", Some(&id)).into_response();
        }
        Err(attributes::UpdateError::Rejected { field, message }) => {
            return ApiError::bad_request(message)
                .with_details(json!({ "field": field }))
                .into_response();
        }
        Err(attributes::UpdateError::Failed(error)) => {
            tracing::error!(%error, "[desk-api/desk-conversations] attribute update failed");
            return ApiError::internal()
                .with_message("Failed to update conversation")
                .into_response();
        }
    };
    // Other agents' open threads take the field values from the hub event.
    let mut conversation = updated.conversation;
    if let Some(object) = conversation.as_object_mut() {
        object.insert(
            "customFields".to_owned(),
            Value::Object(updated.custom_fields),
        );
    }
    if let Some(message) = &updated.message {
        publish_events(
            &ctx,
            &state,
            ev::DESK_CONVERSATION_UPDATED,
            &conversation,
            message,
        );
        publish_change(
            &state,
            &caller.clerk_org_id,
            &conversation,
            message,
            &HashMap::new(),
        );
    }
    let message = updated.message.unwrap_or(Value::Null);
    Data(json!({ "conversation": conversation, "message": message })).into_response()
}

// ── POST /:id/attachments ─────────────────────────────────────────────────────

const ATTACHMENT_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// `withoutTrailingSlash(url)`.
fn without_trailing_slashes(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// Where a conversation's agent files live: R2 key prefix and public URL.
fn attachment_location(ctx: &Ctx, id: &str) -> Option<(String, String)> {
    let base = ctx.caller.env("R2_PUBLIC_URL").filter(|u| !u.is_empty())?;
    let key_prefix = format!("desk/{}/{id}/", ctx.caller.clerk_org_id);
    let url_prefix = format!("{}/{key_prefix}", without_trailing_slashes(&base));
    Some((key_prefix, url_prefix))
}

/// `/^\d+_att_[A-Za-z0-9]+_[A-Za-z0-9._-]+$/`.
fn is_uploaded_name(name: &str) -> bool {
    let digits = name.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let Some(rest) = name[digits..].strip_prefix("_att_") else {
        return false;
    };
    // `[A-Za-z0-9]+_` then `[A-Za-z0-9._-]+`: some `_` after at least one
    // alphanumeric, with only alphanumerics before it.
    let id = rest.bytes().take_while(u8::is_ascii_alphanumeric).count();
    if id == 0 {
        return false;
    }
    let Some(tail) = rest[id..].strip_prefix('_') else {
        return false;
    };
    !tail.is_empty()
        && tail
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `name.replaceAll(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120) || 'file'`: per
/// UTF-16 unit, as JavaScript replaces.
fn safe_name(name: &str) -> String {
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
    let start = out.len().saturating_sub(120);
    let out = out[start..].to_owned();
    if out.is_empty() {
        "file".to_owned()
    } else {
        out
    }
}

/// `text.slice(0, max)` in UTF-16 units.
fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// What `formData().get('file')` found.
enum FormFile {
    File {
        name: String,
        content_type: String,
        bytes: Vec<u8>,
    },
    Missing,
    Unreadable,
}

async fn form_file(request: Request) -> FormFile {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.starts_with("application/x-www-form-urlencoded") {
        return FormFile::Missing;
    }
    let Ok(mut multipart) = Multipart::from_request(request, &()).await else {
        return FormFile::Unreadable;
    };
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                if field.name() != Some("file") {
                    continue;
                }
                let name = field.file_name().map(str::to_owned);
                let content_type = field.content_type().unwrap_or("text/plain").to_owned();
                let Ok(bytes) = field.bytes().await else {
                    return FormFile::Unreadable;
                };
                return match name {
                    Some(name) => FormFile::File {
                        name,
                        content_type,
                        bytes: bytes.to_vec(),
                    },
                    None => FormFile::Missing,
                };
            }
            Ok(None) => return FormFile::Missing,
            Err(_) => return FormFile::Unreadable,
        }
    }
}

async fn upload(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let bucket = ctx.public_bucket(&state);
    let (Some(bucket), Some((key_prefix, url_prefix))) = (bucket, attachment_location(&ctx, &id))
    else {
        return ApiError::unavailable("File upload is not configured").into_response();
    };
    let exists: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from desk_conversations where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(&ctx.caller.db)
            .await;
    match exists {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Conversation", Some(&id)).into_response(),
        Err(error) => {
            tracing::error!(%error, "[desk-api/desk-conversations] attachment lookup failed");
            return ApiError::internal().into_response();
        }
    }
    let (name, content_type, bytes) = match form_file(request).await {
        FormFile::File {
            name,
            content_type,
            bytes,
        } => (name, content_type, bytes),
        FormFile::Missing => return ApiError::bad_request("No file provided").into_response(),
        FormFile::Unreadable => {
            return ApiError::bad_request("Expected multipart form data with a file")
                .into_response();
        }
    };
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return ApiError::bad_request("File too large (max 10 MB)").into_response();
    }
    if !ATTACHMENT_TYPES.contains(&content_type.as_str()) {
        let shown = if content_type.is_empty() {
            "unknown"
        } else {
            content_type.as_str()
        };
        return ApiError::bad_request(format!("File type not allowed: {shown}")).into_response();
    }
    let safe = safe_name(&name);
    let file_name = format!("{}_{}_{safe}", now_ms(), generate_id("att"));
    let size = bytes.len();
    let options = PutOptions {
        content_type: Some(content_type.clone()),
        content_disposition: Some(format!("inline; filename=\"{safe}\"")),
        ..PutOptions::default()
    };
    if let Err(error) = bucket
        .put_boxed(&format!("{key_prefix}{file_name}"), bytes, &options)
        .await
    {
        tracing::error!(%error, "[desk-api/desk-conversations] attachment upload failed");
        return ApiError::internal()
            .with_message("Failed to upload file")
            .into_response();
    }
    let display = utf16_prefix(&name, 255);
    let attachment = json!({
        "name": if display.is_empty() { safe.clone() } else { display },
        "url": format!("{url_prefix}{file_name}"),
        "contentType": content_type,
        "filesize": size,
    });
    let mut data = attachment.as_object().cloned().unwrap_or_default();
    data.insert("conversationId".to_owned(), json!(id));
    ctx.caller.publish(
        &state,
        ev::DESK_ATTACHMENT_CREATED,
        &file_name,
        &Value::Object(data),
    );
    Created(attachment).into_response()
}

// ── realtime ──────────────────────────────────────────────────────────────────

/// `loadAuthor(db, userId)`: the member's first name and picture.
async fn load_author(db: &PgPool, user_id: Option<&str>) -> HashMap<String, Author> {
    let mut authors = HashMap::new();
    let Some(user_id) = user_id.filter(|u| !u.is_empty()) else {
        return authors;
    };
    #[allow(clippy::type_complexity)] // name and picture
    let member: Result<Option<(Option<String>, Option<String>)>, sqlx::Error> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await;
    match member {
        Ok(Some((name, picture))) => {
            authors.insert(
                user_id.to_owned(),
                webchat::author_from_member(name.as_deref(), picture.as_deref()),
            );
        }
        Ok(None) => {}
        Err(error) => tracing::error!(%error, "[app-api/desk-conversations] author lookup failed"),
    }
    authors
}

/// `publishDeskChange`: the workspace hub (agents' inboxes, notes
/// included) and, for public entries, the visitor's conversation room.
fn publish_change(
    state: &DeskState,
    org: &str,
    conversation: &Value,
    message: &Value,
    authors: &HashMap<String, Author>,
) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    let user = message["authorId"].as_str().unwrap_or("system");
    let mut messages = vec![
        RealtimeMessage::workspace(
            org,
            "desk_conversation",
            "updated",
            conversation.clone(),
            user,
        ),
        RealtimeMessage::workspace(org, "desk_message", "created", message.clone(), user),
    ];
    if webchat::is_public(message) {
        let record = webchat::public_message(message, authors);
        let id = conversation["id"].as_str().unwrap_or_default();
        let payload = if message["kind"] == "message" {
            let mut payload = Map::new();
            payload.insert("type".to_owned(), json!("message"));
            payload.insert("id".to_owned(), message["id"].clone());
            payload.insert(
                "content".to_owned(),
                json!(message["body"].as_str().unwrap_or_default()),
            );
            payload.insert(
                "senderId".to_owned(),
                json!(message["authorId"].as_str().unwrap_or_default()),
            );
            payload.insert(
                "senderName".to_owned(),
                json!(record["authorName"].as_str().unwrap_or("Support")),
            );
            if !record["authorAvatar"].is_null() {
                payload.insert("senderAvatar".to_owned(), record["authorAvatar"].clone());
            }
            payload.insert("senderType".to_owned(), message["authorType"].clone());
            payload.insert("ts".to_owned(), json!(now_ms()));
            payload.insert("record".to_owned(), record);
            Value::Object(payload)
        } else {
            json!({
                "type": "system",
                "event": record["eventType"].as_str().unwrap_or("event"),
                "data": {
                    "state": conversation["state"],
                    "conversation": webchat::public_conversation(conversation, authors),
                    "record": record,
                },
                "ts": now_ms(),
            })
        };
        messages.push(conversation_publish(id, payload));
    }
    state.events.tracker().spawn(async move {
        for message in messages {
            if let Err(error) = realtime.publish_boxed(&message).await {
                tracing::error!(%error, "[app-api/desk-conversations] realtime publish failed");
            }
        }
    });
}

fn publish_events(
    ctx: &Ctx,
    state: &DeskState,
    conversation_event: ev::EventName,
    conversation: &Value,
    message: &Value,
) {
    let caller = &ctx.caller;
    caller.publish_in_order(
        state,
        vec![
            (
                conversation_event,
                conversation["id"].as_str().unwrap_or_default().to_owned(),
                conversation.clone(),
            ),
            (
                ev::DESK_MESSAGE_CREATED,
                message["id"].as_str().unwrap_or_default().to_owned(),
                message.clone(),
            ),
        ],
    );
}

// ── POST /:id/reply ───────────────────────────────────────────────────────────

struct ReplyBody {
    kind: String,
    body: String,
    attachments: Option<Vec<Value>>,
}

/// `deskMessageAttachmentSchema`: Zod strips unknown keys.
fn read_attachment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let name = issues.text(fields, "name", Presence::Required, Some(1), Some(255));
    let url = issues.text_with(
        fields,
        "url",
        Presence::Required,
        Text {
            format: Some(Format::Url),
            max: Some(2000),
            ..Text::default()
        },
    );
    let content_type = issues.text(fields, "contentType", Presence::Required, None, Some(255));
    let filesize = issues.number(
        fields,
        "filesize",
        Presence::Required,
        Number {
            int: true,
            min: Some(0.0),
            ..Number::default()
        },
    );
    let width = issues.number(fields, "width", Presence::Optional, Number::default());
    let height = issues.number(fields, "height", Presence::Optional, Number::default());
    if issues.count() > before {
        return None;
    }
    let mut out = Map::new();
    out.insert("name".to_owned(), json!(name.into_option()));
    out.insert("url".to_owned(), json!(url.into_option()));
    out.insert("contentType".to_owned(), json!(content_type.into_option()));
    out.insert("filesize".to_owned(), fields["filesize"].clone());
    let _ = filesize;
    if let Field::Set(_) = width {
        out.insert("width".to_owned(), fields["width"].clone());
    }
    if let Field::Set(_) = height {
        out.insert("height".to_owned(), fields["height"].clone());
    }
    Some(Value::Object(out))
}

fn reply_schema(issues: &mut Issues, body: &Map<String, Value>) -> ReplyBody {
    let kind = issues
        .choice(body, "kind", Presence::Optional, &["message", "note"])
        .into_option()
        .unwrap_or_else(|| "message".to_owned());
    let text = issues
        .text_with(
            body,
            "body",
            Presence::Optional,
            Text::trimmed(None, Some(20_000)),
        )
        .into_option()
        .unwrap_or_default();
    let attachments = issues
        .list(
            body,
            "attachments",
            Presence::Optional,
            None,
            Some(10),
            read_attachment,
        )
        .into_option();
    // The refinement sees the parsed data even where an attachment failed a
    // string check, so it counts the items sent.
    let sent = body
        .get("attachments")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if text.is_empty() && sent == 0 {
        issues.custom("body", "A reply needs a message or an attachment");
    }
    ReplyBody {
        kind,
        body: text,
        attachments,
    }
}

async fn reply(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, reply_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to reply"),
    };
    if let Some(attachments) = data.attachments.as_ref().filter(|a| !a.is_empty()) {
        let location = attachment_location(&ctx, &id);
        let owned = |url: &str| {
            location.as_ref().is_some_and(|(_, prefix)| {
                url.strip_prefix(prefix.as_str())
                    .is_some_and(is_uploaded_name)
            })
        };
        if location.is_none()
            || attachments
                .iter()
                .any(|a| !owned(a["url"].as_str().unwrap_or_default()))
        {
            return ApiError::bad_request(
                "Attachments must be uploaded to this conversation first",
            )
            .into_response();
        }
    }
    let caller = &ctx.caller;
    let appended = webchat::append_desk_message(
        &caller.db,
        Append {
            conversation_id: &id,
            kind: &data.kind,
            author_type: "agent",
            author_id: Some(&caller.user_id),
            body: (!data.body.is_empty()).then(|| data.body.clone()),
            attachments: data.attachments.clone(),
            metadata: None,
            assignee_id: None,
        },
    )
    .await;
    let (conversation, message) = match appended {
        Ok(done) => done,
        Err(AppendError::NotFound) => {
            return ApiError::not_found("Conversation", Some(&id)).into_response();
        }
        Err(AppendError::Write(error)) => {
            tracing::error!(%error, "[app-api/desk-conversations] reply failed");
            return ApiError::internal()
                .with_message("Failed to reply")
                .into_response();
        }
    };
    publish_events(
        &ctx,
        &state,
        ev::DESK_CONVERSATION_UPDATED,
        &conversation,
        &message,
    );
    let authors = load_author(&caller.db, Some(&caller.user_id)).await;
    publish_change(
        &state,
        &caller.clerk_org_id,
        &conversation,
        &message,
        &authors,
    );
    if conversation["channel"] == "email" && data.kind == "message" {
        send_email_reply(&ctx, &state, &conversation, &message).await;
    }
    Created(json!({ "conversation": conversation, "message": message })).into_response()
}

// ── the email reply ───────────────────────────────────────────────────────────

/// `replySubject(subject)`.
fn reply_subject(subject: Option<&str>) -> String {
    let trimmed = weldsuite_kit::validation::js_trim(subject.unwrap_or_default());
    let trimmed = if trimmed.is_empty() {
        "Support"
    } else {
        trimmed
    };
    if trimmed
        .get(..3)
        .is_some_and(|head| head.eq_ignore_ascii_case("re:"))
    {
        trimmed.to_owned()
    } else {
        format!("Re: {trimmed}")
    }
}

/// `prepareEmailAttachments(env, files)`: our files up to 10 MB in total as
/// MIME parts, the rest as links.
async fn email_attachments(
    ctx: &Ctx,
    state: &DeskState,
    files: &[Value],
) -> (Vec<MimeAttachment>, Vec<Value>) {
    let mut attached = Vec::new();
    let mut linked = Vec::new();
    let mut total: u64 = 0;
    let base = ctx
        .caller
        .env("R2_PUBLIC_URL")
        .filter(|u| !u.is_empty())
        .map(|u| without_trailing_slashes(&u).to_owned());
    let bucket = ctx.public_bucket(state);
    for file in files {
        let url = file["url"].as_str().unwrap_or_default();
        let key = base.as_ref().and_then(|base| {
            url.strip_prefix(&format!("{base}/desk/"))
                .map(|_| url[base.len() + 1..].to_owned())
                .filter(|key| !key.contains(".."))
        });
        let size = file["filesize"]
            .as_f64()
            .filter(|s| *s > 0.0)
            .unwrap_or(0.0);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let over = |total: u64, size: f64| total as f64 + size > MAX_ATTACHMENT_BYTES as f64;
        let (Some(key), Some(bucket)) = (key, bucket.as_ref()) else {
            linked.push(file.clone());
            continue;
        };
        if over(total, size) {
            linked.push(file.clone());
            continue;
        }
        match bucket.get_boxed(&key).await {
            #[allow(clippy::cast_precision_loss)]
            Ok(Some(object)) if !over(total, object.bytes.len() as f64) => {
                total += object.bytes.len() as u64;
                let content_type = file["contentType"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("application/octet-stream");
                attached.push(MimeAttachment {
                    filename: file["name"].as_str().unwrap_or_default().to_owned(),
                    content_type: Some(content_type.to_owned()),
                    content: object.bytes,
                    cid: None,
                });
            }
            Ok(_) => linked.push(file.clone()),
            Err(error) => {
                tracing::warn!(%error, "[desk-email] Could not read attachment {key}, sending a link instead");
                linked.push(file.clone());
            }
        }
    }
    (attached, linked)
}

/// `emailTextBody(body, attached, linked)`.
fn email_text_body(body: Option<&str>, attached: &[MimeAttachment], linked: &[Value]) -> String {
    let mut parts = Vec::new();
    let text = body
        .map(weldsuite_kit::validation::js_trim)
        .filter(|t| !t.is_empty());
    if let Some(text) = text {
        parts.push(text.to_owned());
    }
    if !linked.is_empty() {
        let lines: Vec<String> = linked
            .iter()
            .map(|f| {
                format!(
                    "- {}: {}",
                    f["name"].as_str().unwrap_or_default(),
                    f["url"].as_str().unwrap_or_default()
                )
            })
            .collect();
        parts.push(format!("Attachments:\n{}", lines.join("\n")));
    } else if text.is_none() && !attached.is_empty() {
        let names: Vec<&str> = attached.iter().map(|a| a.filename.as_str()).collect();
        parts.push(format!("Attachments: {}", names.join(", ")));
    }
    parts.join("\n\n")
}

/// `sendDeskEmailReply`: a failure is logged, the reply stands.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
async fn send_email_reply(ctx: &Ctx, state: &DeskState, conversation: &Value, message: &Value) {
    let Some(recipient) = conversation["email"].as_str().filter(|e| !e.is_empty()) else {
        return;
    };
    let files: Vec<Value> = message["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let has_text = message["body"]
        .as_str()
        .is_some_and(|b| !weldsuite_kit::validation::js_trim(b).is_empty());
    if !has_text && files.is_empty() {
        return;
    }
    let db = &ctx.caller.db;
    let id = conversation["id"].as_str().unwrap_or_default();
    let thread = match webchat::email_thread(db, id).await {
        Ok(thread) => thread,
        Err(error) => {
            tracing::error!(%error, "[app-api/desk-conversations] outbound email failed");
            return;
        }
    };
    let Some(thread) = thread else { return };
    let Some(from) = thread.helpdesk_address.clone() else {
        tracing::warn!(
            "[desk-email] Skipping outbound send for {id}: no helpdesk address on the thread"
        );
        return;
    };
    let subject = reply_subject(
        thread
            .subject
            .as_deref()
            .or_else(|| conversation["title"].as_str()),
    );
    let (attached, linked) = email_attachments(ctx, state, &files).await;
    let text = email_text_body(message["body"].as_str(), &attached, &linked);
    let mut headers = Vec::new();
    if let Some(last) = &thread.last_email_message_id {
        headers.push(("In-Reply-To".to_owned(), last.clone()));
    }
    if !thread.references.is_empty() {
        headers.push(("References".to_owned(), thread.references.join(" ")));
    }
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: ctx.caller.clerk_org_id.clone(),
            workspace_id: None,
        },
        "desk",
        OutboundKind::Reply,
        &from,
        vec![recipient.to_owned()],
    );
    input.subject_line = Some(subject.clone());
    input.text = Some(text.clone());
    input.attachments = attached
        .iter()
        .map(|a| ScreenAttachment {
            filename: a.filename.clone(),
            content_type: a.content_type.clone(),
        })
        .collect();
    let params = SendEmailParams {
        from: from.clone(),
        to: vec![recipient.to_owned()],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject,
        text: Some(text),
        html: None,
        reply_to: None,
        headers,
        attachments: attached,
    };
    let outbound = outbound(ctx, state);
    let transport = outbound.transport.clone();
    let sent = guarded_send(&outbound.guard, Some(db), &input, || async {
        match &transport {
            Some(transport) => send_email(transport.as_ref(), &params).await,
            None => Err(TransmitError::Config(
                "SEND_EMAIL binding missing".to_owned(),
            )),
        }
    })
    .await;
    match sent {
        Ok(sent) => {
            if !sent.message_id.is_empty()
                && let Err(error) = webchat::stamp_email_id(
                    db,
                    message["id"].as_str().unwrap_or_default(),
                    &sent.message_id,
                )
                .await
            {
                tracing::error!(%error, "[app-api/desk-conversations] outbound email failed");
            }
        }
        Err(GuardedSendError::Denied(denied)) => tracing::warn!(
            "[desk-email] Reply for conversation {id} blocked by the outbound guard ({}): {}",
            denied.code().as_str(),
            denied.message()
        ),
        Err(GuardedSendError::Send(error)) => {
            tracing::error!(%error, "[app-api/desk-conversations] outbound email failed");
        }
    }
}

/// The guard and transport: the request's bindings, and the master database
/// only where the worker has one (`DATABASE_URL_MASTER`).
fn outbound(ctx: &Ctx, state: &DeskState) -> crate::dispatch::Outbound {
    let caller = &ctx.caller;
    let bindings = caller
        .outbound
        .as_ref()
        .map_or_else(|| state.outbound.clone(), |own| own.0.clone());
    let master = if caller.env.is_some() && caller.env("DATABASE_URL_MASTER").is_none() {
        None
    } else {
        caller
            .master
            .as_ref()
            .map(|m| m.0.clone())
            .or_else(|| state.master.clone())
    };
    crate::dispatch::Outbound {
        guard: bindings.guard(master, ctx.kv(state)),
        transport: bindings.transport.clone(),
    }
}

// ── POST /:id/manage ──────────────────────────────────────────────────────────

enum Action {
    Close,
    Open,
    Assign(Option<String>),
}

fn manage_schema(issues: &mut Issues, body: &Map<String, Value>) -> Option<Action> {
    let options = ["close", "open", "assign"];
    match body.get("action").and_then(Value::as_str) {
        Some("close") => Some(Action::Close),
        Some("open") => Some(Action::Open),
        Some("assign") => {
            let assignee = issues.text(body, "assigneeId", Presence::Nullish, None, Some(255));
            Some(Action::Assign(assignee.into_option()))
        }
        _ => {
            issues.invalid_discriminator("action", &options);
            None
        }
    }
}

async fn manage(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let action = match validate(&headers, &body, manage_schema) {
        Ok(Some(action)) => action,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond("Failed to update conversation"),
    };
    let caller = &ctx.caller;
    let before: Result<Option<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select assignee_id from desk_conversations where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await;
    let before = match before {
        Ok(before) => before.flatten(),
        Err(error) => return Refusal::Database(error).respond("Failed to update conversation"),
    };
    let (event_type, assignee, is_assign) = match &action {
        Action::Close => ("closed", None, false),
        Action::Open => ("reopened", None, false),
        Action::Assign(Some(assignee)) if !assignee.is_empty() => {
            ("assigned", Some(Some(assignee.clone())), true)
        }
        Action::Assign(_) => ("unassigned", Some(None), true),
    };
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    metadata.insert(
        "assigneeId".to_owned(),
        assignee
            .clone()
            .flatten()
            .map_or(Value::Null, Value::String),
    );
    let appended = webchat::append_desk_message(
        &caller.db,
        Append {
            conversation_id: &id,
            kind: "event",
            author_type: "agent",
            author_id: Some(&caller.user_id),
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: assignee.clone(),
        },
    )
    .await;
    let (conversation, message) = match appended {
        Ok(done) => done,
        Err(AppendError::NotFound) => {
            return ApiError::not_found("Conversation", Some(&id)).into_response();
        }
        Err(AppendError::Write(error)) => {
            tracing::error!(%error, "[app-api/desk-conversations] manage failed");
            return ApiError::internal()
                .with_message("Failed to update conversation")
                .into_response();
        }
    };
    let event = if is_assign {
        ev::DESK_CONVERSATION_ASSIGNED
    } else {
        ev::DESK_CONVERSATION_STATE_CHANGED
    };
    publish_events(&ctx, &state, event, &conversation, &message);
    let authors = load_author(&caller.db, conversation["assigneeId"].as_str()).await;
    publish_change(
        &state,
        &caller.clerk_org_id,
        &conversation,
        &message,
        &authors,
    );
    if event_type == "assigned" {
        let subject = [
            &conversation["title"],
            &conversation["name"],
            &conversation["email"],
        ]
        .into_iter()
        .find(|v| super::truthy(v))
        .and_then(Value::as_str)
        .map(str::to_owned);
        assigned(
            &state,
            caller,
            Assigned {
                assignee_id: assignee.flatten(),
                previous: before,
                kind: EntityKind::Conversation,
                entity_id: conversation["id"].as_str().unwrap_or_default().to_owned(),
                subject,
                reference: Some(format!("#{}", conversation["conversationNumber"])),
                by: Some(caller.user_id.clone()),
            },
        );
    }
    Data(json!({ "conversation": conversation, "message": message })).into_response()
}
