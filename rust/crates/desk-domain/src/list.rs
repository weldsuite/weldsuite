//! `listDeskConversations` and `listDeskMessages` (`@weldsuite/db/lib/desk`):
//! the inbox list the desk API shows agents and the public API
//! (`/v1/conversations`) answers integrations with, and a conversation's
//! timeline a page at a time.

use sea_orm::sea_query::{Alias, Expr, Func, NullOrdering, Order, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{desk_conversations, desk_messages};

use crate::row;

/// `Number.parseInt(raw, 10)`: `None` for `NaN`.
pub(crate) fn js_parse_int(raw: &str) -> Option<f64> {
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
pub(crate) fn like_pattern(term: &str) -> String {
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

/// `/^#?(\d{1,9})$/`: a conversation's number, or a problem's.
pub(crate) fn conversation_number(term: &str) -> Option<i64> {
    let digits = term.strip_prefix('#').unwrap_or(term);
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `col ILIKE pattern`.
pub(crate) fn ilike(column: impl sea_orm::sea_query::IntoColumnRef, pattern: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::ilike(Expr::col(column), pattern)
}

/// The list's filters (`desk-list`'s `conversationFilters`); empty values
/// filter nothing.
fn filters(query: &ListQuery) -> Condition {
    use desk_conversations::Column;
    use sea_orm::ExprTrait as _;
    let empty = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
    let term = query.q.as_deref().map(js_trim).filter(|t| !t.is_empty());
    let mut filters = Condition::all();
    if let Some(state) = empty(&query.state) {
        filters = filters.add(Column::State.eq(state));
    }
    if let Some(assignee) = empty(&query.assignee_id) {
        filters = filters.add(Column::AssigneeId.eq(assignee));
    }
    if query.unassigned {
        filters = filters.add(Column::AssigneeId.is_null());
    }
    if let Some(channel) = empty(&query.channel) {
        filters = filters.add(Column::Channel.eq(channel));
    }
    if let Some(visitor) = empty(&query.visitor_id) {
        filters = filters.add(Column::VisitorId.eq(visitor));
    }
    if let Some(email) = query.email.as_deref().filter(|e| !e.is_empty()) {
        let email = js_trim(email).to_lowercase();
        filters = filters.add(Expr::from(Func::lower(Expr::col(Column::Email))).eq(email));
    }
    if let Some(term) = term {
        let pattern = like_pattern(term);
        let message = Alias::new("m");
        let in_messages = Query::select()
            .expr(Expr::val(1))
            .from_as(desk_messages::Entity, message.clone())
            .and_where(
                Expr::col((message.clone(), desk_messages::Column::ConversationId))
                    .equals((desk_conversations::Entity, Column::Id)),
            )
            .and_where(Expr::col((message.clone(), desk_messages::Column::Kind)).ne("event"))
            .and_where(ilike((message, desk_messages::Column::Body), &pattern))
            .to_owned();
        let mut any = Condition::any()
            .add(ilike(Column::Name, &pattern))
            .add(ilike(Column::Email, &pattern))
            .add(ilike(Column::Title, &pattern))
            .add(ilike(Column::LastMessagePreview, &pattern))
            .add(Expr::exists(in_messages));
        if let Some(number) = conversation_number(term) {
            any = any.add(Column::ConversationNumber.eq(i32::try_from(number).unwrap_or(i32::MAX)));
        }
        filters = filters.add(any);
    }
    match empty(&query.priority).as_deref() {
        Some("none") => filters = filters.add(Column::Priority.is_null()),
        Some(priority) => filters = filters.add(Column::Priority.eq(priority)),
        None => {}
    }
    if let Some(ticket_type) = empty(&query.ticket_type_id) {
        filters = filters.add(Column::TicketTypeId.eq(ticket_type));
    }
    if let Some(team) = empty(&query.department_id) {
        filters = filters.add(Column::DepartmentId.eq(team));
    }
    if let Some(tag) = empty(&query.tag) {
        // `tags @> jsonb_build_array(tag)`.
        filters = filters.add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col(Column::Tags),
            json!([tag]),
        ));
    }
    if let Some(external_id) = query
        .external_id
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(|e| js_trim(e).to_owned())
    {
        filters = filters.add(Column::ExternalId.eq(external_id));
    }
    filters
}

/// `listDeskConversations(db, query)`.
pub async fn list(
    db: &PgPool,
    query: &ListQuery,
) -> Result<(Vec<Value>, i64, bool, Option<String>), DbErr> {
    use desk_conversations::Column;
    let limit = query.limit.unwrap_or(30.0).min(100.0);
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
    let orm_db = orm(db);
    let filtered = desk_conversations::Entity::find().filter(filters(query));
    let count = filtered.clone().count(&orm_db).await?;
    let count = i64::try_from(count).unwrap_or(i64::MAX);
    let ordered = match query.sort.as_deref() {
        Some("oldest") => filtered.order_by_asc(Column::CreatedAt),
        Some("waiting_longest") => {
            filtered.order_by_with_nulls(Column::WaitingSince, Order::Asc, NullOrdering::Last)
        }
        Some("sla_due") => {
            filtered.order_by_with_nulls(Column::SlaDueAt, Order::Asc, NullOrdering::Last)
        }
        _ => filtered.order_by_desc(Expr::from(Func::coalesce([
            Expr::col(Column::LastMessageAt),
            Expr::col(Column::CreatedAt),
        ]))),
    };
    let ordered = if matches!(
        query.sort.as_deref(),
        Some("oldest" | "waiting_longest" | "sla_due")
    ) {
        ordered.order_by_asc(Column::Id)
    } else {
        ordered.order_by_desc(Column::Id)
    };
    let rows = ordered
        .limit(u64::try_from(page + 1).unwrap_or(0))
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(&orm_db)
        .await?;
    let mut rows: Vec<Value> = rows.into_iter().map(row).collect();
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
) -> Result<MessagesPage, DbErr> {
    let limit = limit.unwrap_or(100.0).clamp(1.0, 200.0);
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit as i64;
    let offset = cursor
        .filter(|c| !c.is_empty())
        .map_or(0.0, |c| js_parse_int(c).unwrap_or(0.0).max(0.0));
    #[allow(clippy::cast_possible_truncation)]
    let offset = offset as i64;
    let rows = desk_messages::Entity::find()
        .filter(desk_messages::Column::ConversationId.eq(conversation_id))
        .order_by_asc(desk_messages::Column::CreatedAt)
        .order_by_asc(desk_messages::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(&orm(db))
        .await?;
    let mut data: Vec<Value> = rows.into_iter().map(row).collect();
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
