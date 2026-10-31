//! The webchat inbox's data layer (`@weldsuite/db/lib/desk`,
//! `packages/core/db/src/lib/desk.ts`): the parts the desk API's inbox
//! routes use. `appendDeskMessage` is the only writer of a conversation's
//! state, waiting time and last message.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::table::WriteError;
use crate::tables::{DESK_CONVERSATIONS, DESK_MESSAGES};

/// `DeskConversationNotFoundError`, or the statement that failed.
pub(crate) enum AppendError {
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

/// `AppendDeskMessageInput`.
pub(crate) struct Append<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) author_type: &'a str,
    pub(crate) author_id: Option<&'a str>,
    pub(crate) body: Option<String>,
    pub(crate) attachments: Option<Vec<Value>>,
    pub(crate) metadata: Option<Map<String, Value>>,
    /// `Some(None)`: `assigneeId: null`; `None`: left out.
    #[allow(clippy::option_option)] // left out vs null, as `appendDeskMessage` reads it
    pub(crate) assignee_id: Option<Option<String>>,
}

/// `previewOf(body)`: whitespace collapsed, at most 200 UTF-16 units.
pub(crate) fn preview_of(body: Option<&str>) -> Option<String> {
    let body = body.filter(|b| !b.is_empty())?;
    let collapsed = collapse_whitespace(body);
    let trimmed = weldsuite_kit::validation::js_trim(&collapsed);
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    if units.len() > 200 {
        let head = String::from_utf16_lossy(&units[..197]);
        return Some(format!("{head}…"));
    }
    Some(trimmed.to_owned())
}

/// `text.replace(/\s+/g, ' ')`.
pub(crate) fn collapse_whitespace(text: &str) -> String {
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

/// `appendDeskMessage(db, input)`: the message, and the conversation after it.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub(crate) async fn append_desk_message(
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
    let now = crate::now();
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

/// `ListDeskConversationsQuery`.
#[derive(Default)]
pub(crate) struct ListQuery {
    pub(crate) state: Option<String>,
    pub(crate) assignee_id: Option<String>,
    pub(crate) unassigned: bool,
    pub(crate) channel: Option<String>,
    pub(crate) visitor_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) q: Option<String>,
    /// A priority, or `none` for conversations without one.
    pub(crate) priority: Option<String>,
    pub(crate) ticket_type_id: Option<String>,
    pub(crate) department_id: Option<String>,
    /// Conversations carrying this tag (exact match).
    pub(crate) tag: Option<String>,
    /// The key an outside writer opened the conversation with.
    pub(crate) external_id: Option<String>,
    pub(crate) sort: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<f64>,
}

/// `%term%` for ILIKE, with `%`, `_` and `\` taken literally.
fn like_pattern(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len() + 2);
    escaped.push('%');
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped.push('%');
    escaped
}

/// `/^#?(\d{1,9})$/`.
fn conversation_number(term: &str) -> Option<i64> {
    let digits = term.strip_prefix('#').unwrap_or(term);
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

const FILTERS: &str = "($1::text is null or t.state = $1)
      and ($2::text is null or t.assignee_id = $2)
      and (not $3::boolean or t.assignee_id is null)
      and ($4::text is null or t.channel = $4)
      and ($5::text is null or t.visitor_id = $5)
      and ($6::text is null or lower(t.email) = $6)
      and ($7::text is null or (t.name ILIKE $7 or t.email ILIKE $7 or t.title ILIKE $7
           or t.last_message_preview ILIKE $7
           or exists (select 1 from desk_messages m where m.conversation_id = t.id and m.kind <> 'event' and m.body ILIKE $7)
           or ($8::integer is not null and t.conversation_number = $8)))
      and ($9::text is null or (case when $9 = 'none' then t.priority is null else t.priority = $9 end))
      and ($10::text is null or t.ticket_type_id = $10)
      and ($11::text is null or t.department_id = $11)
      and ($12::text is null or t.tags @> jsonb_build_array($12::text))
      and ($13::text is null or t.external_id = $13)";

/// `listDeskConversations(db, query)`.
pub(crate) async fn list(
    db: &PgPool,
    query: &ListQuery,
) -> Result<(Vec<Value>, i64, bool, Option<String>), sqlx::Error> {
    let limit = query.limit.unwrap_or(30.0).min(100.0);
    let term = query
        .q
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|t| !t.is_empty());
    let pattern = term.map(like_pattern);
    let number = term.and_then(conversation_number);
    let email = query
        .email
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(|e| weldsuite_kit::validation::js_trim(e).to_lowercase());
    let empty = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
    let external_id = query
        .external_id
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(|e| weldsuite_kit::validation::js_trim(e).to_owned());
    let order = match query.sort.as_deref() {
        Some("oldest") => "t.created_at, t.id",
        Some("waiting_longest") => "t.waiting_since ASC NULLS LAST, t.id",
        Some("sla_due") => "t.sla_due_at ASC NULLS LAST, t.id",
        _ => "COALESCE(t.last_message_at, t.created_at) DESC, t.id desc",
    };
    let offset = query
        .cursor
        .as_deref()
        .filter(|c| !c.is_empty())
        .and_then(crate::js::js_parse_int)
        .filter(|o| *o != 0.0)
        .unwrap_or(0.0);
    #[allow(clippy::cast_possible_truncation)]
    let offset = offset as i64;
    #[allow(clippy::cast_possible_truncation)]
    let page = limit as i64;
    macro_rules! bind {
        ($q:expr) => {
            $q.bind(empty(&query.state))
                .bind(empty(&query.assignee_id))
                .bind(query.unassigned)
                .bind(empty(&query.channel))
                .bind(empty(&query.visitor_id))
                .bind(email.clone())
                .bind(pattern.clone())
                .bind(number.map(|n| i32::try_from(n).unwrap_or(i32::MAX)))
                .bind(empty(&query.priority))
                .bind(empty(&query.ticket_type_id))
                .bind(empty(&query.department_id))
                .bind(empty(&query.tag))
                .bind(external_id.clone())
        };
    }
    let count: i64 = bind!(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from desk_conversations t where {FILTERS}"
    ))))
    .fetch_one(db)
    .await?;
    let rows: Vec<Value> = bind!(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from desk_conversations t where {FILTERS} order by {order} limit $14 offset $15"
    ))))
    .bind(page + 1)
    .bind(offset)
    .fetch_all(db)
    .await?;
    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(|row| DESK_CONVERSATIONS.js(row))
        .collect();
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > page;
    if has_more {
        rows.truncate(usize::try_from(page).unwrap_or(0));
    }
    let cursor = has_more.then(|| (offset + page).to_string());
    Ok((rows, count, has_more, cursor))
}

/// `getDeskConversation(db, id, { includeMessages })`.
pub(crate) async fn get(
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
pub(crate) async fn messages(db: &PgPool, id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from desk_messages t where t.conversation_id = $1 order by t.created_at")
            .bind(id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|row| DESK_MESSAGES.js(row)).collect())
}

/// `DeskAuthorInfo`.
#[derive(Clone)]
pub(crate) struct Author {
    pub(crate) name: String,
    pub(crate) avatar: Value,
}

/// `deskAuthorFromMember`: first name only, never the email.
pub(crate) fn author_from_member(name: Option<&str>, picture: Option<&str>) -> Author {
    let first = name
        .map(weldsuite_kit::validation::js_trim)
        .and_then(|n| n.split(is_js_space).find(|part| !part.is_empty()))
        .filter(|n| !n.is_empty());
    Author {
        name: first.unwrap_or("Support").to_owned(),
        avatar: picture.map_or(Value::Null, |p| json!(p)),
    }
}

/// `isPublicDeskMessage`: notes, ticket-field changes and SLA events stay with the team.
pub(crate) fn is_public(message: &Value) -> bool {
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
pub(crate) fn public_message(message: &Value, authors: &HashMap<String, Author>) -> Value {
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
pub(crate) fn public_conversation(
    conversation: &Value,
    authors: &HashMap<String, Author>,
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

/// `getDeskEmailReplyContext`: where an email reply is sent from, and what
/// it threads on.
pub(crate) struct EmailThread {
    pub(crate) helpdesk_address: Option<String>,
    pub(crate) last_email_message_id: Option<String>,
    pub(crate) references: Vec<String>,
    pub(crate) subject: Option<String>,
}

pub(crate) async fn email_thread(
    db: &PgPool,
    id: &str,
) -> Result<Option<EmailThread>, sqlx::Error> {
    let Some((conversation, messages)) = get(db, id, true).await? else {
        return Ok(None);
    };
    let mut thread = EmailThread {
        helpdesk_address: None,
        last_email_message_id: None,
        references: Vec::new(),
        subject: conversation["title"].as_str().map(str::to_owned),
    };
    for message in &messages {
        let meta = &message["metadata"];
        if let Some(address) = meta["helpdeskAddress"].as_str().filter(|a| !a.is_empty()) {
            thread.helpdesk_address = Some(address.to_owned());
        }
        if let Some(id) = meta["emailMessageId"].as_str().filter(|a| !a.is_empty()) {
            thread.last_email_message_id = Some(id.to_owned());
            thread.references.push(id.to_owned());
        }
    }
    let keep = thread.references.len().saturating_sub(20);
    thread.references.drain(..keep);
    Ok(Some(thread))
}

/// `normalizeRfcMessageId`: without its angle brackets.
fn normalize_rfc_message_id(id: &str) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(id);
    let trimmed = trimmed.strip_prefix('<').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('>').unwrap_or(trimmed);
    let trimmed = weldsuite_kit::validation::js_trim(trimmed);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `stampDeskMessageEmailId`: the sent RFC Message-ID on the message.
pub(crate) async fn stamp_email_id(
    db: &PgPool,
    message_id: &str,
    email_message_id: &str,
) -> Result<(), sqlx::Error> {
    let rfc =
        normalize_rfc_message_id(email_message_id).unwrap_or_else(|| email_message_id.to_owned());
    let metadata: Option<Option<Value>> =
        sqlx::query_scalar("select metadata from desk_messages where id = $1 limit 1")
            .bind(message_id)
            .fetch_optional(db)
            .await?;
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let mut next = metadata
        .and_then(|m| m.as_object().cloned())
        .unwrap_or_default();
    next.insert("emailMessageId".to_owned(), json!(rfc));
    sqlx::query("update desk_messages set metadata = $2 where id = $1")
        .bind(message_id)
        .bind(Value::Object(next))
        .execute(db)
        .await?;
    Ok(())
}
