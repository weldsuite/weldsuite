//! The webchat inbox (`@weldsuite/db/lib/desk`, `packages/core/db/src/lib/desk.ts`):
//! `desk_conversations`, `desk_messages` and `desk_visitors`.
//!
//! `appendDeskMessage` is the only writer of a conversation's state, its
//! waiting time and its last message; the desk API, the widget API and the
//! phone transcript writer all go through it. The desk API keeps its inbox
//! list and email threading; what the widget API also needs is here, with
//! the end-user identity rules of `@weldsuite/db/lib/desk-portal`
//! (`packages/core/db/src/lib/desk-portal.ts`): who may see which
//! conversation, and the visitor rows behind a visitor token.

#[rustfmt::skip]
#[path = "webchat_tables.rs"]
mod tables;

use std::collections::HashMap;
use std::hash::BuildHasher;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;

use crate::table::WriteError;
pub use tables::{DESK_CONVERSATIONS, DESK_MESSAGES, DESK_VISITORS};

/// `new Date()` as Drizzle writes it: UTC with milliseconds.
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `DeskConversationNotFoundError`, or the statement that failed.
#[derive(Debug)]
pub enum AppendError {
    NotFound,
    Write(WriteError),
}

impl From<sqlx::Error> for AppendError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

impl From<WriteError> for AppendError {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl std::fmt::Display for AppendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("conversation not found"),
            Self::Write(error) => error.fmt(f),
        }
    }
}

/// `AppendDeskMessageInput`.
pub struct Append<'a> {
    pub conversation_id: &'a str,
    pub kind: &'a str,
    pub author_type: &'a str,
    pub author_id: Option<&'a str>,
    pub body: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub metadata: Option<Map<String, Value>>,
    /// `Some(None)`: `assigneeId: null`; `None`: left out.
    #[allow(clippy::option_option)] // left out vs null, as `appendDeskMessage` reads it
    pub assignee_id: Option<Option<String>>,
}

/// `previewOf(body)`: whitespace collapsed, at most 200 UTF-16 units.
pub fn preview_of(body: Option<&str>) -> Option<String> {
    let body = body.filter(|b| !b.is_empty())?;
    let collapsed = collapse_whitespace(body);
    let trimmed = js_trim(&collapsed);
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    if units.len() > 200 {
        let head = String::from_utf16_lossy(&units[..197]);
        return Some(format!("{head}…"));
    }
    Some(trimmed.to_owned())
}

/// `text.replace(/\s+/g, ' ')`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// JavaScript's `\s`.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// `attachmentPreviewOf(attachments)`: "📎 name" (+N more).
fn attachment_preview_of(attachments: Option<&Vec<Value>>) -> Option<String> {
    let attachments = attachments?;
    let first = attachments.first()?;
    let more = if attachments.len() > 1 {
        format!(" +{}", attachments.len() - 1)
    } else {
        String::new()
    };
    let name = first["name"]
        .as_str()
        .map_or_else(|| "undefined".to_owned(), str::to_owned);
    preview_of(Some(&format!("📎 {name}{more}")))
}

/// `appendDeskMessage(db, input)`: the conversation after the message, and
/// the message.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub async fn append_desk_message(
    db: &PgPool,
    input: Append<'_>,
) -> Result<(Value, Value), AppendError> {
    let current: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from desk_conversations t where t.id = $1 limit 1")
            .bind(input.conversation_id)
            .fetch_optional(db)
            .await?;
    let Some(current) = current else {
        return Err(AppendError::NotFound);
    };
    let now = now();
    let mut state = current["state"].clone();
    let mut waiting_since = current["waiting_since"].clone();
    let mut assignee = current["assignee_id"].clone();
    let mut last_message_at = current["last_message_at"].clone();
    let mut last_preview = current["last_message_preview"].clone();
    let event_type = input
        .metadata
        .as_ref()
        .and_then(|m| m.get("eventType"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    match input.kind {
        "message" => {
            last_message_at = json!(now);
            if let Some(preview) = preview_of(input.body.as_deref())
                .or_else(|| attachment_preview_of(input.attachments.as_ref()))
            {
                last_preview = json!(preview);
            }
            match input.author_type {
                "visitor" => {
                    waiting_since = json!(now);
                    if state == "closed" {
                        state = json!("open");
                    }
                }
                "agent" | "bot" => waiting_since = Value::Null,
                _ => {}
            }
        }
        "event" => match event_type.as_deref() {
            Some("closed") => {
                state = json!("closed");
                waiting_since = Value::Null;
            }
            Some("reopened") => state = json!("open"),
            Some("assigned") => {
                assignee = match &input.assignee_id {
                    Some(Some(id)) => json!(id),
                    Some(None) => Value::Null,
                    None => input
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("assigneeId"))
                        .cloned()
                        .unwrap_or(Value::Null),
                };
            }
            Some("unassigned") => assignee = Value::Null,
            _ => {}
        },
        _ => {}
    }
    let owner_changes =
        input.kind == "event" && matches!(event_type.as_deref(), Some("assigned" | "unassigned"));

    let assignee_patch = input
        .assignee_id
        .as_ref()
        .map(|id| id.clone().map_or(Value::Null, Value::String));
    let metadata = match (input.metadata, &assignee_patch) {
        (Some(mut metadata), patch) => {
            if let Some(patch) = patch {
                metadata.insert("assigneeId".to_owned(), patch.clone());
            }
            Value::Object(metadata)
        }
        (None, Some(patch)) => json!({ "assigneeId": patch }),
        (None, None) => Value::Null,
    };

    let mut message = Map::new();
    message.insert("id".to_owned(), json!(generate_id("dmsg")));
    message.insert("created_at".to_owned(), json!(now));
    message.insert("conversation_id".to_owned(), json!(input.conversation_id));
    message.insert("kind".to_owned(), json!(input.kind));
    message.insert(
        "body".to_owned(),
        input.body.map_or(Value::Null, Value::String),
    );
    message.insert("author_type".to_owned(), json!(input.author_type));
    message.insert(
        "author_id".to_owned(),
        input.author_id.map_or(Value::Null, |a| json!(a)),
    );
    message.insert(
        "attachments".to_owned(),
        input.attachments.map_or(Value::Null, Value::Array),
    );
    message.insert("metadata".to_owned(), metadata);
    let message = DESK_MESSAGES.insert(db, message, &["createdAt"]).await?;

    let mut changes = Map::new();
    changes.insert("updated_at".to_owned(), json!(now));
    changes.insert("state".to_owned(), state);
    changes.insert("waiting_since".to_owned(), waiting_since);
    if owner_changes {
        changes.insert("assignee_id".to_owned(), assignee);
    }
    changes.insert("last_message_at".to_owned(), last_message_at);
    changes.insert("last_message_preview".to_owned(), last_preview);
    let trusted = ["updatedAt", "waitingSince", "lastMessageAt"];
    let conversation = DESK_CONVERSATIONS
        .patch(db, input.conversation_id, changes, false, &trusted)
        .await?
        .ok_or(AppendError::NotFound)?;
    Ok((conversation, message))
}

/// `getDeskConversation(db, id, { includeMessages })`.
pub async fn get(
    db: &PgPool,
    id: &str,
    include_messages: bool,
) -> Result<Option<(Value, Vec<Value>)>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from desk_conversations t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let conversation = DESK_CONVERSATIONS.js(row);
    if !include_messages {
        return Ok(Some((conversation, Vec::new())));
    }
    Ok(Some((conversation, messages(db, id).await?)))
}

/// `listDeskMessages`: the timeline, by `created_at` only.
pub async fn messages(db: &PgPool, id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_messages t where t.conversation_id = $1 order by t.created_at",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|row| DESK_MESSAGES.js(row)).collect())
}

// ── visitors and their conversations (the widget API) ───────────────────────

/// `upsertDeskVisitor`'s input. `None` is `undefined`: an existing visitor
/// keeps the value, a new one gets `null`.
#[derive(Debug, Default)]
pub struct VisitorInput<'a> {
    pub id: &'a str,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub widget_id: Option<String>,
}

/// `upsertDeskVisitor(db, input)`: the visitor, created or with its
/// last-seen time moved on.
pub async fn upsert_visitor(db: &PgPool, input: VisitorInput<'_>) -> Result<Value, WriteError> {
    let now = now();
    let existing = DESK_VISITORS.find_live(db, input.id).await?;
    let field = |value: Option<String>| value.map_or(Value::Null, Value::String);
    if let Some(existing) = existing {
        let mut changes = Map::new();
        changes.insert("last_seen_at".to_owned(), json!(now));
        changes.insert("updated_at".to_owned(), json!(now));
        for (column, value) in [
            ("name", input.name),
            ("email", input.email),
            ("phone", input.phone),
            ("widget_id", input.widget_id),
        ] {
            if let Some(value) = value {
                changes.insert(column.to_owned(), json!(value));
            }
        }
        let updated = DESK_VISITORS
            .patch(db, input.id, changes, false, &["lastSeenAt", "updatedAt"])
            .await?;
        return Ok(updated.unwrap_or(existing));
    }
    let mut values = Map::new();
    values.insert("id".to_owned(), json!(input.id));
    values.insert("created_at".to_owned(), json!(now));
    values.insert("updated_at".to_owned(), json!(now));
    values.insert("last_seen_at".to_owned(), json!(now));
    values.insert("name".to_owned(), field(input.name));
    values.insert("email".to_owned(), field(input.email));
    values.insert("phone".to_owned(), field(input.phone));
    values.insert("widget_id".to_owned(), field(input.widget_id));
    DESK_VISITORS
        .insert(db, values, &["createdAt", "updatedAt", "lastSeenAt"])
        .await
}

/// `CreateDeskConversationInput`, as the widget API fills it (a messenger
/// conversation started by the visitor's first message).
pub struct NewConversation<'a> {
    pub visitor_id: &'a str,
    pub name: Value,
    pub email: Value,
    pub body: String,
    pub author_type: &'a str,
    pub author_id: Option<&'a str>,
    pub metadata: Option<Map<String, Value>>,
}

/// A Postgres unique violation (`23505`).
fn unique_violation(error: &WriteError) -> bool {
    matches!(
        error,
        WriteError::Database(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505")
    )
}

/// `createDeskConversation(db, input)`: the new conversation and its first
/// message. `conversation_number` is `MAX + 1` under a unique index, so a
/// number two conversations took at once is tried again, five times at most.
pub async fn create_conversation(
    db: &PgPool,
    input: NewConversation<'_>,
) -> Result<(Value, Value), AppendError> {
    let title = preview_of(Some(&input.body)).map_or(Value::Null, Value::String);
    create_on_channel(
        db,
        ChannelConversation {
            channel: "messenger",
            title,
            attachments: None,
            conversation: input,
        },
    )
    .await
}

/// `createDeskConversation(db, input)` with the channel, title and first
/// message's files the caller chooses (the email channel's
/// `ingestDeskEmail`).
pub struct ChannelConversation<'a> {
    pub channel: &'a str,
    /// `input.title ?? previewOf(input.body)`, already resolved.
    pub title: Value,
    pub attachments: Option<Vec<Value>>,
    pub conversation: NewConversation<'a>,
}

/// [`create_conversation`] on any channel.
pub async fn create_on_channel(
    db: &PgPool,
    spec: ChannelConversation<'_>,
) -> Result<(Value, Value), AppendError> {
    let ChannelConversation {
        channel,
        title,
        attachments,
        conversation: input,
    } = spec;
    let id = generate_id("dconv");
    let now = now();
    let preview = preview_of(Some(&input.body)).map_or(Value::Null, Value::String);
    for attempt in 0.. {
        let number: i64 = sqlx::query_scalar(
            "select (coalesce(max(conversation_number), 0) + 1)::bigint from desk_conversations",
        )
        .fetch_one(db)
        .await?;
        let mut values = Map::new();
        values.insert("id".to_owned(), json!(id));
        values.insert("created_at".to_owned(), json!(now));
        values.insert("updated_at".to_owned(), json!(now));
        values.insert("conversation_number".to_owned(), json!(number));
        values.insert("title".to_owned(), title.clone());
        values.insert("state".to_owned(), json!("open"));
        values.insert("channel".to_owned(), json!(channel));
        values.insert("visitor_id".to_owned(), json!(input.visitor_id));
        values.insert("name".to_owned(), input.name.clone());
        values.insert("email".to_owned(), input.email.clone());
        values.insert("contact_id".to_owned(), Value::Null);
        values.insert("assignee_id".to_owned(), Value::Null);
        values.insert(
            "waiting_since".to_owned(),
            if input.author_type == "visitor" {
                json!(now)
            } else {
                Value::Null
            },
        );
        values.insert("last_message_at".to_owned(), json!(now));
        values.insert("last_message_preview".to_owned(), preview.clone());
        let trusted = ["createdAt", "updatedAt", "waitingSince", "lastMessageAt"];
        match DESK_CONVERSATIONS.insert(db, values, &trusted).await {
            Ok(_) => break,
            Err(error) if attempt < 4 && unique_violation(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
    append_desk_message(
        db,
        Append {
            conversation_id: &id,
            kind: "message",
            author_type: input.author_type,
            author_id: Some(input.author_id.unwrap_or(input.visitor_id)),
            body: Some(input.body),
            attachments,
            metadata: input.metadata,
            assignee_id: None,
        },
    )
    .await
}

// ── who is asking (`@weldsuite/db/lib/desk-portal`) ──────────────────────────

/// `DeskPrincipal`: the visitor row the caller's token names, and the email
/// they proved. A conversation is theirs when it is on their own visitor
/// row, or, once they have a verified email, when it is on any visitor
/// verified for that email or came in by email from it. An email a visitor
/// merely typed is never a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub visitor_id: String,
    /// Lower-cased proven email; `None` for an anonymous visitor.
    pub verified_email: Option<String>,
}

/// `normalizeDeskEmail(email)`.
pub fn normalize_email(email: &str) -> String {
    js_trim(email).to_lowercase()
}

/// `deskPrincipalOf(visitor)`, for a `desk_visitors` row as
/// [`DESK_VISITORS`] reads it.
pub fn principal_of(visitor: &Value) -> Principal {
    Principal {
        visitor_id: visitor["id"].as_str().unwrap_or_default().to_owned(),
        verified_email: visitor["verifiedEmail"]
            .as_str()
            .filter(|email| !email.is_empty())
            .map(normalize_email),
    }
}

/// `canAccessDeskConversation(db, conversation, principal)`: whether the
/// principal may read and write this conversation.
pub async fn can_access(
    db: &PgPool,
    conversation: &Value,
    principal: &Principal,
) -> Result<bool, sqlx::Error> {
    let visitor_id = conversation["visitorId"].as_str();
    if visitor_id == Some(principal.visitor_id.as_str()) {
        return Ok(true);
    }
    let Some(email) = &principal.verified_email else {
        return Ok(false);
    };
    if conversation["channel"] == "email"
        && conversation["email"]
            .as_str()
            .is_some_and(|from| !from.is_empty() && normalize_email(from) == *email)
    {
        return Ok(true);
    }
    let Some(visitor_id) = visitor_id.filter(|id| !id.is_empty()) else {
        return Ok(false);
    };
    let owner: Option<Option<String>> =
        sqlx::query_scalar("select verified_email from desk_visitors where id = $1 limit 1")
            .bind(visitor_id)
            .fetch_optional(db)
            .await?;
    Ok(owner
        .flatten()
        .is_some_and(|owner| !owner.is_empty() && normalize_email(&owner) == *email))
}

/// `listDeskConversationsForPrincipal(db, principal, { limit })`'s rows:
/// the principal's conversations (`deskConversationsOwnedBy`), most recent
/// activity first, `limit` at most.
pub async fn list_for_principal(
    db: &PgPool,
    principal: &Principal,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t
         where t.visitor_id = $1
            or ($2::text is not null and (
                 t.visitor_id in (select v.id from desk_visitors v where v.verified_email = $2)
                 or (t.channel = 'email' and lower(t.email) = $2)))
         order by coalesce(t.last_message_at, t.created_at) desc, t.id desc
         limit $3",
    )
    .bind(&principal.visitor_id)
    .bind(principal.verified_email.as_deref())
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DESK_CONVERSATIONS.js(row))
        .collect())
}

/// A visitor row by id, as Drizzle's `select()` returns it.
pub async fn find_visitor(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    DESK_VISITORS.find_live(db, id).await
}

/// `createAnonymousDeskVisitor(db, generateId, widgetId)`: a fresh
/// anonymous visitor (the widget's first visit).
pub async fn create_anonymous_visitor(
    db: &PgPool,
    widget_id: Option<&str>,
) -> Result<Value, WriteError> {
    let now = now();
    let mut values = Map::new();
    values.insert("id".to_owned(), json!(generate_id("dvis")));
    values.insert("created_at".to_owned(), json!(now));
    values.insert("updated_at".to_owned(), json!(now));
    values.insert("last_seen_at".to_owned(), json!(now));
    values.insert("widget_id".to_owned(), json!(widget_id));
    DESK_VISITORS
        .insert(db, values, &["createdAt", "updatedAt", "lastSeenAt"])
        .await
}

/// `upsertIdentifiedDeskVisitor`'s input: a person the customer's site
/// vouched for (identity token).
#[derive(Debug, Clone, Copy)]
pub struct IdentifiedVisitor<'a> {
    pub widget_id: &'a str,
    pub external_id: &'a str,
    pub email: Option<&'a str>,
    pub name: Option<&'a str>,
}

/// The visitor of `(widget_id, external_id)`, if any.
async fn identified_visitor(
    db: &PgPool,
    widget_id: &str,
    external_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_visitors t where t.widget_id = $1 and t.external_id = $2 limit 1",
    )
    .bind(widget_id)
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_VISITORS.js(row)))
}

/// `upsertIdentifiedDeskVisitor(db, generateId, input)`: one row per
/// (widget, external user id). The token's email becomes the verified email,
/// so a changed address on the customer's side follows here.
pub async fn upsert_identified_visitor(
    db: &PgPool,
    input: IdentifiedVisitor<'_>,
) -> Result<Value, WriteError> {
    let now = now();
    let email = input
        .email
        .filter(|email| !email.is_empty())
        .map(normalize_email);
    let name = input.name.map(js_trim).filter(|name| !name.is_empty());
    if let Some(existing) = identified_visitor(db, input.widget_id, input.external_id).await? {
        let mut changes = Map::new();
        changes.insert("last_seen_at".to_owned(), json!(now));
        changes.insert("updated_at".to_owned(), json!(now));
        changes.insert(
            "name".to_owned(),
            name.map_or_else(|| existing["name"].clone(), |name| json!(name)),
        );
        changes.insert(
            "email".to_owned(),
            email
                .as_ref()
                .map_or_else(|| existing["email"].clone(), |email| json!(email)),
        );
        changes.insert("verified_email".to_owned(), json!(email));
        let newly_verified = email
            .as_deref()
            .is_some_and(|email| existing["verifiedEmail"].as_str() != Some(email));
        changes.insert(
            "verified_at".to_owned(),
            if newly_verified {
                json!(now)
            } else {
                existing["verifiedAt"].clone()
            },
        );
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let trusted = ["lastSeenAt", "updatedAt", "verifiedAt"];
        let updated = DESK_VISITORS
            .patch(db, &id, changes, false, &trusted)
            .await?;
        return Ok(updated.unwrap_or(existing));
    }
    let mut values = Map::new();
    values.insert("id".to_owned(), json!(generate_id("dvis")));
    values.insert("created_at".to_owned(), json!(now));
    values.insert("updated_at".to_owned(), json!(now));
    values.insert("last_seen_at".to_owned(), json!(now));
    values.insert("widget_id".to_owned(), json!(input.widget_id));
    values.insert("external_id".to_owned(), json!(input.external_id));
    values.insert("name".to_owned(), json!(name));
    values.insert("email".to_owned(), json!(email));
    values.insert("verified_email".to_owned(), json!(email));
    values.insert(
        "verified_at".to_owned(),
        if email.is_some() {
            json!(now)
        } else {
            Value::Null
        },
    );
    let trusted = ["createdAt", "updatedAt", "lastSeenAt", "verifiedAt"];
    match DESK_VISITORS.insert(db, values, &trusted).await {
        Ok(created) => Ok(created),
        Err(error) => {
            // Two first visits at once: the unique (widget, external id) index let one in.
            match identified_visitor(db, input.widget_id, input.external_id).await? {
                Some(raced) => Ok(raced),
                None => Err(error),
            }
        }
    }
}

/// `attachDeskVisitorContact(db, visitorId, contact)`: copy the name and
/// email a visitor gave onto their conversations that have none yet. The
/// conversations it changed.
pub async fn attach_visitor_contact(
    db: &PgPool,
    visitor_id: &str,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<Vec<Value>, WriteError> {
    let email = email
        .map(|e| js_trim(e).to_lowercase())
        .filter(|e| !e.is_empty());
    let name = name.map(js_trim).filter(|n| !n.is_empty());
    let mut updated = Vec::new();
    if email.is_none() && name.is_none() {
        return Ok(updated);
    }
    let rows: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from desk_conversations t where t.visitor_id = $1")
            .bind(visitor_id)
            .fetch_all(db)
            .await?;
    let empty = |value: &Value| value.as_str().is_none_or(str::is_empty);
    for row in rows {
        let mut changes = Map::new();
        if let Some(email) = &email
            && empty(&row["email"])
        {
            changes.insert("email".to_owned(), json!(email));
        }
        if let Some(name) = name
            && empty(&row["name"])
        {
            changes.insert("name".to_owned(), json!(name));
        }
        if changes.is_empty() {
            continue;
        }
        changes.insert("updated_at".to_owned(), json!(now()));
        let id = row["id"].as_str().unwrap_or_default();
        if let Some(next) = DESK_CONVERSATIONS
            .patch(db, id, changes, false, &["updatedAt"])
            .await?
        {
            updated.push(next);
        }
    }
    Ok(updated)
}

/// `DESK_RATING_MIN`.
pub const RATING_MIN: i64 = 1;
/// `DESK_RATING_MAX`.
pub const RATING_MAX: i64 = 5;

/// Why `rateDeskConversation` refused, or the statement that failed.
#[derive(Debug)]
pub enum RateError {
    NotFound,
    /// `DeskRatingRejectedError`, with its message.
    Rejected(&'static str),
    Write(WriteError),
}

impl From<AppendError> for RateError {
    fn from(error: AppendError) -> Self {
        match error {
            AppendError::NotFound => Self::NotFound,
            AppendError::Write(error) => Self::Write(error),
        }
    }
}

impl From<sqlx::Error> for RateError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

const NOT_CLOSED: &str = "Only a closed conversation can be rated";
const ALREADY_RATED: &str = "This conversation was already rated";

/// `rateDeskConversation(db, input)`: the visitor's CSAT answer on a closed
/// conversation, and its `rated` event. One rating per conversation: the
/// update only lands while `rated_at` is empty.
pub async fn rate(
    db: &PgPool,
    conversation_id: &str,
    author_id: &str,
    rating: i64,
    comment: Option<&str>,
) -> Result<(Value, Value), RateError> {
    let current: Option<(String, Option<String>)> = sqlx::query_as(
        "select state, rated_at::text from desk_conversations where id = $1 limit 1",
    )
    .bind(conversation_id)
    .fetch_optional(db)
    .await?;
    let Some((state, rated_at)) = current else {
        return Err(RateError::NotFound);
    };
    if state != "closed" {
        return Err(RateError::Rejected(NOT_CLOSED));
    }
    if rated_at.is_some() {
        return Err(RateError::Rejected(ALREADY_RATED));
    }
    let comment = comment.map(js_trim).filter(|c| !c.is_empty());
    let now = now();
    let rated: Option<String> = sqlx::query_scalar(
        "update desk_conversations set rating = $2, rating_comment = $3,
         rated_at = $4::timestamp, updated_at = $4::timestamp
         where id = $1 and rated_at is null returning id",
    )
    .bind(conversation_id)
    .bind(i32::try_from(rating).unwrap_or(i32::MAX))
    .bind(comment)
    .bind(&now)
    .fetch_optional(db)
    .await?;
    if rated.is_none() {
        return Err(RateError::Rejected(ALREADY_RATED));
    }
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("rated"));
    metadata.insert("rating".to_owned(), json!(rating));
    metadata.insert("ratingComment".to_owned(), json!(comment));
    Ok(append_desk_message(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type: "visitor",
            author_id: Some(author_id),
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await?)
}

// ── the public payloads ──────────────────────────────────────────────────────

/// `DeskAuthorInfo`.
#[derive(Debug, Clone)]
pub struct Author {
    pub name: String,
    pub avatar: Value,
}

/// `deskAuthorFromMember`: first name only, never the email.
pub fn author_from_member(name: Option<&str>, picture: Option<&str>) -> Author {
    let first = name
        .map(js_trim)
        .and_then(|n| n.split(is_js_space).find(|part| !part.is_empty()))
        .filter(|n| !n.is_empty());
    Author {
        name: first.unwrap_or("Support").to_owned(),
        avatar: picture.map_or(Value::Null, |p| json!(p)),
    }
}

/// `resolveAuthors(db, userIds)`: the display name and avatar of each
/// teammate among `user_ids`, by user id.
pub async fn resolve_authors(
    db: &PgPool,
    user_ids: &[Option<&str>],
) -> Result<HashMap<String, Author>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for id in user_ids.iter().flatten() {
        if !id.is_empty() && !ids.iter().any(|known| known == id) {
            ids.push((*id).to_owned());
        }
    }
    let mut authors = HashMap::new();
    if ids.is_empty() {
        return Ok(authors);
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select user_id, name, picture from workspace_members where user_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    for (user_id, name, picture) in rows {
        authors.insert(
            user_id,
            author_from_member(name.as_deref(), picture.as_deref()),
        );
    }
    Ok(authors)
}

/// `isPublicDeskMessage`: notes, ticket-field changes and SLA events stay with the team.
pub fn is_public(message: &Value) -> bool {
    if message["kind"] == "note" {
        return false;
    }
    let internal = matches!(
        message["metadata"]["eventType"].as_str(),
        Some("attributes_changed" | "sla_warning" | "sla_breached")
    );
    !(message["kind"] == "event" && internal)
}

/// `toPublicDeskMessage(message, authors)`.
pub fn public_message<S: BuildHasher>(
    message: &Value,
    authors: &HashMap<String, Author, S>,
) -> Value {
    let author_type = message["authorType"].as_str().unwrap_or_default();
    let author = if author_type == "agent" {
        message["authorId"]
            .as_str()
            .filter(|a| !a.is_empty())
            .and_then(|id| authors.get(id))
    } else {
        None
    };
    let metadata = &message["metadata"];
    let author_name = match author_type {
        "agent" => json!(author.map_or("Support", |a| a.name.as_str())),
        "bot" => json!("Bot"),
        _ => Value::Null,
    };
    json!({
        "id": message["id"],
        "conversationId": message["conversationId"],
        "kind": if message["kind"] == "event" { "event" } else { "message" },
        "body": message["body"],
        "authorType": message["authorType"],
        "authorName": author_name,
        "authorAvatar": author.map_or(Value::Null, |a| a.avatar.clone()),
        "attachments": message["attachments"],
        "eventType": metadata.get("eventType").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
        "clientId": metadata.get("clientId").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
        "createdAt": message["createdAt"],
    })
}

/// `toPublicDeskConversation(conversation, authors)`.
pub fn public_conversation<S: BuildHasher>(
    conversation: &Value,
    authors: &HashMap<String, Author, S>,
) -> Value {
    let assignee = conversation["assigneeId"]
        .as_str()
        .filter(|a| !a.is_empty())
        .and_then(|id| authors.get(id))
        .map_or(
            Value::Null,
            |a| json!({ "name": a.name, "avatar": a.avatar }),
        );
    json!({
        "id": conversation["id"],
        "conversationNumber": conversation["conversationNumber"],
        "title": conversation["title"],
        "state": conversation["state"],
        "createdAt": conversation["createdAt"],
        "lastMessageAt": conversation["lastMessageAt"],
        "lastMessagePreview": conversation["lastMessagePreview"],
        "lastMessageFromTeam": conversation["waitingSince"].is_null() && !conversation["lastMessageAt"].is_null(),
        "assignee": assignee,
        "rating": conversation["rating"],
    })
}
