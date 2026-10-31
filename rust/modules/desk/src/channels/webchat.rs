//! The webchat inbox's data layer (`@weldsuite/db/lib/desk`,
//! `packages/core/db/src/lib/desk.ts`): the inbox list and email threading
//! the desk API's routes use. The writer (`appendDeskMessage`, the only
//! writer of a conversation's state, waiting time and last message) and the
//! public payloads are in `weldsuite_desk_domain::webchat`, shared with the
//! helpdesk widget API.

use serde_json::{Value, json};
use weldsuite_db::PgPool;

use crate::tables::DESK_CONVERSATIONS;
pub(crate) use weldsuite_desk_domain::webchat::{
    Append, AppendError, Author, append_desk_message, author_from_member, collapse_whitespace, get,
    is_public, public_conversation, public_message,
};

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
