//! `listDeskConversations` and `listDeskMessages` (`@weldsuite/db/lib/desk`):
//! the inbox list the desk API shows agents and the public API
//! (`/v1/conversations`) answers integrations with, and a conversation's
//! timeline a page at a time.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::js_trim;

use crate::webchat::{DESK_CONVERSATIONS, DESK_MESSAGES};

/// `Number.parseInt(raw, 10)`: `None` for `NaN`.
fn js_parse_int(raw: &str) -> Option<f64> {
    let rest = raw.trim_start_matches(|c: char| (c.is_whitespace() && c != '') || c == '﻿');
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `ListDeskConversationsQuery`.
#[derive(Debug, Default)]
pub struct ListQuery {
    pub state: Option<String>,
    pub assignee_id: Option<String>,
    pub unassigned: bool,
    pub channel: Option<String>,
    pub visitor_id: Option<String>,
    pub email: Option<String>,
    pub q: Option<String>,
    /// A priority, or `none` for conversations without one.
    pub priority: Option<String>,
    pub ticket_type_id: Option<String>,
    pub department_id: Option<String>,
    /// Conversations carrying this tag (exact match).
    pub tag: Option<String>,
    /// The key an outside writer opened the conversation with.
    pub external_id: Option<String>,
    pub sort: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<f64>,
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
pub async fn list(
    db: &PgPool,
    query: &ListQuery,
) -> Result<(Vec<Value>, i64, bool, Option<String>), sqlx::Error> {
    let limit = query.limit.unwrap_or(30.0).min(100.0);
    let term = query.q.as_deref().map(js_trim).filter(|t| !t.is_empty());
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
        .and_then(js_parse_int)
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

/// A page of a conversation's timeline (`listDeskMessages(db, id, query)`):
/// oldest first, `cursor` the offset.
#[derive(Debug, Clone)]
pub struct MessagesPage {
    pub data: Vec<Value>,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// `listDeskMessages(db, conversationId, { cursor, limit })`: `limit`
/// defaults to 100 and is kept to 1–200.
pub async fn messages_page(
    db: &PgPool,
    conversation_id: &str,
    cursor: Option<&str>,
    limit: Option<f64>,
) -> Result<MessagesPage, sqlx::Error> {
    let limit = limit.unwrap_or(100.0).clamp(1.0, 200.0);
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit as i64;
    let offset = cursor
        .filter(|c| !c.is_empty())
        .map_or(0.0, |c| js_parse_int(c).unwrap_or(0.0).max(0.0));
    #[allow(clippy::cast_possible_truncation)]
    let offset = offset as i64;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_messages t where t.conversation_id = $1
         order by t.created_at, t.id limit $2 offset $3",
    )
    .bind(conversation_id)
    .bind(limit + 1)
    .bind(offset)
    .fetch_all(db)
    .await?;
    let mut data: Vec<Value> = rows.into_iter().map(|row| DESK_MESSAGES.js(row)).collect();
    let has_more = i64::try_from(data.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        data.truncate(usize::try_from(limit).unwrap_or(0));
    }
    Ok(MessagesPage {
        data,
        has_more,
        cursor: has_more.then(|| (offset + limit).to_string()),
    })
}
