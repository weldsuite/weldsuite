//! `routes/conversations.ts`: the visitor's conversations and messages at
//! `/api/conversations`. The visitor comes from their visitor token
//! ([`crate::visitor_auth`]), never from the request. Every route that
//! touches a conversation checks that it belongs to them: their own, or, for
//! a verified visitor, any of that email's ([`webchat::can_access`]).
//! Visitors never see internal notes, and messages carry the teammate's
//! display name and avatar.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::webchat::{
    self, Append, AppendError, Author, NewConversation, Principal, RateError, VisitorInput,
    public_conversation, public_message, resolve_authors,
};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, json_body};

use crate::attachments::{MAX_MESSAGE_ATTACHMENTS, resolve_visitor_attachments};
use crate::auth::Widget;
use crate::live::{
    auto_assign, notify_team, publish_conversation_updated, publish_visitor_event,
    publish_visitor_message, visitor_display_name,
};
use crate::visitor_auth::Visitor;
use crate::{Ctx, WidgetState, bad_request, internal, not_found_error, success, uncaught};

pub(crate) fn routes() -> Router<WidgetState> {
    Router::new()
        .route("/identify", post(identify))
        .route("/", get(list).post(start))
        .route("/{id}", get(conversation))
        .route("/{id}/messages", post(send))
        .route("/{id}/rating", post(rate))
}

// ── reading the request (`zValidator`) ───────────────────────────────────────

/// A 400 from the validator, or the request's own answer.
type Read<T> = Result<T, Response>;

/// `z.string().trim().max(255).optional()`.
fn optional_name(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(
            body,
            "name",
            Presence::Optional,
            Text::trimmed(None, Some(255)),
        )
        .into_option()
}

/// `z.string().trim().email().max(255).optional()`.
fn optional_email(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    let rules = Text {
        trim: true,
        format: Some(Format::Email),
        max: Some(255),
        ..Text::default()
    };
    issues
        .text_with(body, "email", Presence::Optional, rules)
        .into_option()
}

/// `clientIdSchema`: `z.string().max(64).optional()`.
fn client_id(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(
            body,
            "clientId",
            Presence::Optional,
            Text::length(None, Some(64)),
        )
        .into_option()
}

/// `zValidator('json', schema)`: the fields `read` takes from the body. Bad
/// JSON throws in the worker, and its `onError` answers 500.
#[allow(clippy::result_large_err)] // the response is the route's answer
pub(crate) fn json<T>(
    ctx: &Ctx,
    state: &WidgetState,
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Read<T> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|_| uncaught(ctx, state, "Malformed JSON in request body"))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(IntoResponse::into_response)?;
    value.ok_or_else(|| internal("Internal server error"))
}

/// `data.x || undefined`: an empty string counts as left out.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// A string column that is set (`visitor.verifiedEmail`).
fn set(row: &Value, prop: &str) -> bool {
    row[prop].as_str().is_some_and(|value| !value.is_empty())
}

/// `visitor.verifiedEmail ?? visitor.email`.
fn contact_email(visitor: &Value) -> Value {
    if visitor["verifiedEmail"].is_null() {
        visitor["email"].clone()
    } else {
        visitor["verifiedEmail"].clone()
    }
}

/// `saveTypedContact(db, visitor, typed)`: store the name and email a
/// visitor typed. A verified visitor's email is the one that was proven, so
/// a typed one never replaces it.
async fn save_typed_contact(
    db: &PgPool,
    visitor: &Visitor,
    name: Option<String>,
    email: Option<&str>,
) -> Result<Value, weldsuite_desk_domain::table::WriteError> {
    let email = if set(&visitor.row, "verifiedEmail") {
        None
    } else {
        non_empty(email.map(str::to_lowercase))
    };
    webchat::upsert_visitor(
        db,
        VisitorInput {
            id: visitor.id(),
            name: non_empty(name),
            email,
            phone: None,
            widget_id: None,
        },
    )
    .await
}

/// `accessibleConversation(db, principal, id, includeMessages)`: a
/// conversation the calling visitor may see (with its messages when asked).
async fn accessible(
    db: &PgPool,
    principal: &Principal,
    id: &str,
    include_messages: bool,
) -> Result<Option<(Value, Vec<Value>)>, sqlx::Error> {
    let Some((conversation, messages)) = webchat::get(db, id, include_messages).await? else {
        return Ok(None);
    };
    Ok(webchat::can_access(db, &conversation, principal)
        .await?
        .then_some((conversation, messages)))
}

fn metadata_with_client_id(client_id: Option<String>) -> Option<Map<String, Value>> {
    non_empty(client_id).map(|id| {
        let mut metadata = Map::new();
        metadata.insert("clientId".to_owned(), json!(id));
        metadata
    })
}

// ── POST /identify ───────────────────────────────────────────────────────────

/// `POST /api/conversations/identify`: register or update the visitor and
/// attach their contact details to their conversations.
async fn identify(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, email) = match json(&ctx, &state, &headers, &body, |issues, body| {
        (optional_name(issues, body), optional_email(issues, body))
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal,
    };
    let db = &widget.db;
    let visitor = match save_typed_contact(db, &caller, name.clone(), email.as_deref()).await {
        Ok(visitor) => visitor,
        Err(error) => {
            tracing::error!(%error, "[widget-api] identify failed");
            return internal("Failed to identify visitor");
        }
    };
    let visitor_id = visitor["id"].as_str().unwrap_or_default().to_owned();
    // `visitor.verifiedEmail ?? data.email`.
    let attach_email = visitor["verifiedEmail"]
        .as_str()
        .map(str::to_owned)
        .or(email);
    let updated = match webchat::attach_visitor_contact(
        db,
        &visitor_id,
        name.as_deref(),
        attach_email.as_deref(),
    )
    .await
    {
        Ok(updated) => updated,
        Err(error) => {
            tracing::error!(%error, "[widget-api] identify failed");
            return internal("Failed to identify visitor");
        }
    };
    let background = state.clone();
    let org = widget.clerk_org_id.clone();
    state.events.tracker().spawn(async move {
        for conversation in &updated {
            publish_conversation_updated(&background, &org, conversation).await;
        }
    });
    success(
        StatusCode::OK,
        json!({
            "visitor": {
                "id": visitor["id"],
                "name": visitor["name"],
                "email": contact_email(&visitor),
                "verified": set(&visitor, "verifiedEmail"),
            },
        }),
    )
}

// ── GET / ────────────────────────────────────────────────────────────────────

/// `GET /api/conversations`: the visitor's history, 25 at most.
async fn list(
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
) -> Response {
    let db = &widget.db;
    let listed = async {
        let rows = webchat::list_for_principal(db, &caller.principal, 25).await?;
        let assignees: Vec<Option<&str>> =
            rows.iter().map(|row| row["assigneeId"].as_str()).collect();
        let authors = resolve_authors(db, &assignees).await?;
        Ok::<_, sqlx::Error>(
            rows.iter()
                .map(|row| public_conversation(row, &authors))
                .collect::<Vec<_>>(),
        )
    };
    match listed.await {
        Ok(conversations) => success(StatusCode::OK, Value::Array(conversations)),
        Err(error) => {
            tracing::error!(%error, "[widget-api] list conversations failed");
            internal("Failed to list conversations")
        }
    }
}

// ── POST / ───────────────────────────────────────────────────────────────────

/// `POST /api/conversations`: a new conversation with the visitor's first
/// message.
async fn start(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = json(&ctx, &state, &headers, &body, |issues, body| {
        let name = optional_name(issues, body);
        let email = optional_email(issues, body);
        let text = issues
            .text_with(
                body,
                "body",
                Presence::Required,
                Text::trimmed(Some(1), Some(10_000)),
            )
            .into_option();
        let client = client_id(issues, body);
        (name, email, text, client)
    });
    let (name, email, text, client) = match read {
        Ok((name, email, Some(text), client)) => (name, email, text, client),
        Ok(_) => return internal("Failed to start conversation"),
        Err(refusal) => return refusal,
    };
    let db = &widget.db;
    let started = async {
        let visitor = save_typed_contact(db, &caller, name, email.as_deref())
            .await
            .map_err(|error| error.to_string())?;
        let visitor_id = visitor["id"].as_str().unwrap_or_default().to_owned();
        let (conversation, message) = webchat::create_conversation(
            db,
            NewConversation {
                visitor_id: &visitor_id,
                name: visitor["name"].clone(),
                email: contact_email(&visitor),
                body: text,
                author_type: "visitor",
                author_id: Some(&visitor_id),
                metadata: metadata_with_client_id(client),
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        let name = visitor_display_name(db, &visitor_id, &visitor).await;
        Ok::<_, String>((conversation, message, name))
    };
    let (conversation, message, visitor_name) = match started.await {
        Ok(started) => started,
        Err(error) => {
            tracing::error!(%error, "[widget-api] start conversation failed");
            return internal("Failed to start conversation");
        }
    };
    spawn_visitor_message(
        &state,
        &widget,
        &conversation,
        &message,
        &visitor_name,
        Fanout::Created,
    );
    let authors = HashMap::<String, Author>::new();
    let record = public_message(&message, &authors);
    success(
        StatusCode::CREATED,
        json!({
            "conversation": public_conversation(&conversation, &authors),
            "messages": [record],
            "message": record,
        }),
    )
}

/// What a visitor message sets off after the response.
#[derive(Clone, Copy)]
enum Fanout {
    /// A new conversation: the team hears about it.
    Created,
    /// A reply; the team hears about it unless it was already waiting.
    Updated { team_already_waiting: bool },
}

/// The publishes, the auto-assignment and the team's notification, after
/// the response (`waitUntil`). The assignment runs first, so the
/// notification goes to the new owner.
fn spawn_visitor_message(
    state: &WidgetState,
    widget: &Widget,
    conversation: &Value,
    message: &Value,
    visitor_name: &str,
    fanout: Fanout,
) {
    let state_ = state.clone();
    let db = widget.db.clone();
    let org = widget.clerk_org_id.clone();
    let workspace_id = widget.workspace_id.clone();
    let conversation = conversation.clone();
    let message = message.clone();
    let visitor_name = visitor_name.to_owned();
    state.events.tracker().spawn(async move {
        let event = match fanout {
            Fanout::Created => "created",
            Fanout::Updated { .. } => "updated",
        };
        publish_visitor_message(&state_, &org, &conversation, &message, &visitor_name, event).await;
        let current = auto_assign(&state_, &db, &org, &workspace_id, conversation).await;
        let notify = match fanout {
            Fanout::Created => Some(true),
            Fanout::Updated {
                team_already_waiting: false,
            } => Some(false),
            Fanout::Updated { .. } => None,
        };
        if let Some(is_new) = notify {
            notify_team(
                &state_,
                &db,
                &org,
                &current,
                &message,
                &visitor_name,
                is_new,
            )
            .await;
        }
    });
}

// ── GET /:id ─────────────────────────────────────────────────────────────────

/// `GET /api/conversations/:id`: the conversation and its public messages.
async fn conversation(
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    Path(id): Path<String>,
) -> Response {
    let db = &widget.db;
    let found = async {
        let Some((conversation, messages)) = accessible(db, &caller.principal, &id, true).await?
        else {
            return Ok(None);
        };
        let visible: Vec<Value> = messages.into_iter().filter(webchat::is_public).collect();
        let mut ids: Vec<Option<&str>> = vec![conversation["assigneeId"].as_str()];
        ids.extend(
            visible
                .iter()
                .filter(|m| m["authorType"] == "agent")
                .map(|m| m["authorId"].as_str()),
        );
        let authors = resolve_authors(db, &ids).await?;
        Ok::<_, sqlx::Error>(Some(json!({
            "conversation": public_conversation(&conversation, &authors),
            "messages": visible.iter().map(|m| public_message(m, &authors)).collect::<Vec<_>>(),
        })))
    };
    match found.await {
        Ok(Some(data)) => success(StatusCode::OK, data),
        Ok(None) => not_found_error("Conversation", &id),
        Err(error) => {
            tracing::error!(%error, "[widget-api] get conversation failed");
            internal("Failed to fetch conversation")
        }
    }
}

// ── POST /:id/messages ───────────────────────────────────────────────────────

/// One `attachmentSchema` item as the visitor sent it.
pub(crate) struct ClaimedAttachment {
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) content_type: String,
    pub(crate) width: Option<i64>,
    pub(crate) height: Option<i64>,
}

/// Whether every field has the type the schema wants: Zod runs an object's
/// `.refine()` only then (a failed `.min()` or `.max()` does not stop it).
fn types_ok(body: &Map<String, Value>) -> bool {
    let string = |key: &str, required: bool| match body.get(key) {
        None => !required,
        Some(value) => value.is_string(),
    };
    let attachments_ok = match body.get("attachments") {
        None => true,
        Some(Value::Array(items)) => items.iter().all(|item| {
            item.as_object().is_some_and(|item| {
                ["name", "url", "contentType"]
                    .iter()
                    .all(|key| item.get(*key).is_some_and(Value::is_string))
                    && item.get("filesize").is_some_and(Value::is_number)
                    && ["width", "height"]
                        .iter()
                        .all(|key| item.get(*key).is_none_or(Value::is_number))
            })
        }),
        Some(_) => false,
    };
    string("body", false) && string("clientId", false) && attachments_ok
}

/// `z.number().int().positive().optional()`.
fn positive(issues: &mut Issues, item: &Map<String, Value>, key: &str) -> Option<i64> {
    let value = issues
        .whole_number(item, key, Presence::Optional, Number::default())
        .into_option()?;
    if value <= 0 {
        issues.issue_at(
            key,
            json!({
                "code": "too_small",
                "minimum": 0,
                "type": "number",
                "inclusive": false,
                "exact": false,
                "message": "Number must be greater than 0",
            }),
        );
        return None;
    }
    Some(value)
}

/// `attachmentSchema`.
fn attachment(issues: &mut Issues, item: &Value) -> Option<ClaimedAttachment> {
    let item = issues.object(item)?;
    let name = issues
        .text_with(
            item,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let url = issues
        .text_with(
            item,
            "url",
            Presence::Required,
            Text::length(None, Some(2048)),
        )
        .into_option();
    let content_type = issues
        .text_with(
            item,
            "contentType",
            Presence::Required,
            Text::length(None, Some(255)),
        )
        .into_option();
    let filesize = issues
        .whole_number(
            item,
            "filesize",
            Presence::Required,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option();
    let width = positive(issues, item, "width");
    let height = positive(issues, item, "height");
    filesize?;
    Some(ClaimedAttachment {
        name: name?,
        url: url?,
        content_type: content_type?,
        width,
        height,
    })
}

/// `POST /api/conversations/:id/messages`: a visitor message, with files
/// this worker stored for the same conversation.
#[allow(clippy::too_many_lines)] // the TypeScript route, step by step
async fn send(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = json(&ctx, &state, &headers, &body, |issues, body| {
        let text = issues
            .text_with(
                body,
                "body",
                Presence::Optional,
                Text::trimmed(None, Some(10_000)),
            )
            .into_option();
        let attachments = issues.list(
            body,
            "attachments",
            Presence::Optional,
            None,
            Some(MAX_MESSAGE_ATTACHMENTS),
            attachment,
        );
        let client = client_id(issues, body);
        // `.refine()` sees the parsed data even when a length check failed:
        // the trimmed text and the array as sent.
        let has_text = body
            .get("body")
            .and_then(Value::as_str)
            .is_some_and(|text| !weldsuite_kit::validation::js_trim(text).is_empty());
        let files = body
            .get("attachments")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        if types_ok(body) && !has_text && files == 0 {
            issues.custom("body", "A message needs text or at least one attachment");
        }
        (text, attachments.into_option(), client)
    });
    let (text, claimed, client) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal,
    };
    let visitor_id = caller.id().to_owned();
    let db = &widget.db;
    let existing = match accessible(db, &caller.principal, &id, false).await {
        Ok(Some((conversation, _))) => conversation,
        Ok(None) => return not_found_error("Conversation", &id),
        Err(error) => {
            tracing::error!(%error, "[widget-api] send message failed");
            return internal("Failed to send message");
        }
    };
    let mut attachments = None;
    if let Some(claimed) = claimed.filter(|claimed| !claimed.is_empty()) {
        match resolve_visitor_attachments(&ctx, &state, &widget.clerk_org_id, &id, claimed).await {
            Ok(Ok(resolved)) => attachments = Some(resolved),
            Ok(Err(message)) => return bad_request(message),
            Err(error) => {
                tracing::error!(%error, "[widget-api] send message failed");
                return internal("Failed to send message");
            }
        }
    }
    let appended = webchat::append_desk_message(
        db,
        Append {
            conversation_id: &id,
            kind: "message",
            author_type: "visitor",
            author_id: Some(&visitor_id),
            body: non_empty(text),
            attachments,
            metadata: metadata_with_client_id(client),
            assignee_id: None,
        },
    )
    .await;
    let (conversation, message) = match appended {
        Ok(appended) => appended,
        Err(AppendError::NotFound) => return not_found_error("Conversation", &id),
        Err(AppendError::Write(error)) => {
            tracing::error!(%error, "[widget-api] send message failed");
            return internal("Failed to send message");
        }
    };
    let visitor_name = visitor_display_name(db, &visitor_id, &existing).await;
    // The ball was already in the team's court: they've been told.
    let team_already_waiting = existing["state"] == "open" && !existing["waitingSince"].is_null();
    spawn_visitor_message(
        &state,
        &widget,
        &conversation,
        &message,
        &visitor_name,
        Fanout::Updated {
            team_already_waiting,
        },
    );
    match resolve_authors(db, &[conversation["assigneeId"].as_str()]).await {
        Ok(authors) => success(
            StatusCode::CREATED,
            json!({
                "conversation": public_conversation(&conversation, &authors),
                "message": public_message(&message, &authors),
            }),
        ),
        Err(error) => {
            tracing::error!(%error, "[widget-api] send message failed");
            internal("Failed to send message")
        }
    }
}

// ── POST /:id/rating ─────────────────────────────────────────────────────────

/// `POST /api/conversations/:id/rating`: the visitor's CSAT answer for a
/// conversation the team closed.
async fn rate(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = json(&ctx, &state, &headers, &body, |issues, body| {
        let rating = issues
            .whole_number(
                body,
                "rating",
                Presence::Required,
                Number {
                    #[allow(clippy::cast_precision_loss)]
                    min: Some(webchat::RATING_MIN as f64),
                    #[allow(clippy::cast_precision_loss)]
                    max: Some(webchat::RATING_MAX as f64),
                    ..Number::default()
                },
            )
            .into_option();
        let comment = issues
            .text_with(
                body,
                "comment",
                Presence::Optional,
                Text::trimmed(None, Some(2000)),
            )
            .into_option();
        (rating, comment)
    });
    let (rating, comment) = match read {
        Ok((Some(rating), comment)) => (rating, comment),
        Ok(_) => return internal("Failed to save rating"),
        Err(refusal) => return refusal,
    };
    let visitor_id = caller.id().to_owned();
    let db = &widget.db;
    match accessible(db, &caller.principal, &id, false).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found_error("Conversation", &id),
        Err(error) => {
            tracing::error!(%error, "[widget-api] rate conversation failed");
            return internal("Failed to save rating");
        }
    }
    let (conversation, message) =
        match webchat::rate(db, &id, &visitor_id, rating, comment.as_deref()).await {
            Ok(rated) => rated,
            Err(RateError::NotFound) => return not_found_error("Conversation", &id),
            Err(RateError::Rejected(message)) => {
                return crate::failure(StatusCode::CONFLICT, "CONFLICT", message);
            }
            Err(RateError::Write(error)) => {
                tracing::error!(%error, "[widget-api] rate conversation failed");
                return internal("Failed to save rating");
            }
        };
    let authors = match resolve_authors(db, &[conversation["assigneeId"].as_str()]).await {
        Ok(authors) => authors,
        Err(error) => {
            tracing::error!(%error, "[widget-api] rate conversation failed");
            return internal("Failed to save rating");
        }
    };
    let background = state.clone();
    let org = widget.clerk_org_id.clone();
    let (published, record, assigned) = (conversation.clone(), message.clone(), authors.clone());
    state.events.tracker().spawn(async move {
        publish_visitor_event(&background, &org, &published, &record, &assigned, "updated").await;
    });
    success(
        StatusCode::CREATED,
        json!({
            "conversation": public_conversation(&conversation, &authors),
            "message": public_message(&message, &authors),
        }),
    )
}
