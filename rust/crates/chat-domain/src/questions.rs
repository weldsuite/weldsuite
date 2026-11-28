//! Questions on WeldBooks records (ADR BOOKS-015; Rust only, edition feature
//! `books-questions`).
//!
//! A question is a top-level message of a record chat ([`crate::books_records`])
//! whose metadata carries `question`:
//!
//! ```json
//! { "question": { "status": "open", "askedTo": ["user_1", "user_2"] } }
//! ```
//!
//! `status` is `open`, `answered` or `resolved`; `askedTo` lists the members
//! (their user ids, as the chat's members are) the question is for. The
//! thread is the message and its replies, so the conversation is WeldChat's.
//!
//! # Status
//!
//! - **open**: asked.
//! - **answered**: someone other than the asker replied in the thread
//!   ([`answer_on_reply`]), or a receipt was attached to, or booked for, the
//!   bank line the question is about ([`answer_open_on_record`]).
//! - **resolved**: closed by hand (`PATCH`), and re-opened the same way
//!   ([`set_status`]).
//!
//! A reply moves `open` to `answered` only: an answered or resolved question
//! stays as it is, and the asker's own reply is not an answer. Every change
//! is one guarded statement on the JSON (`jsonb_set` where the status is still
//! `open`), so two answers at once change it once.
//!
//! # Reading
//!
//! [`list`] returns the questions on records the caller may see: the type's
//! permission and the record's legal entity (restricted entities included),
//! plus contacts. It is the same check as reading the record's chat. With
//! [`Filters::entity`] ([`request_entity`]) it holds only the request's
//! entity, as To process counts them; a contact has no entity, so its
//! questions show in every entity.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::iso_timestamp;
use weldsuite_legal_entities::{
    EntityScopeCondition, LegalEntityApp, default_entity_id_for, entity_scope_condition,
    load_entity_access, resolve_request_entity,
};
use weldsuite_schema::tenant::{
    chat_channels as channels, chat_messages as messages, workspace_members,
};

use crate::access::Can;
use crate::books_records;
use crate::entity::{self, Provider};

/// The statuses a question has.
pub const STATUSES: [&str; 3] = ["open", "answered", "resolved"];
/// Most questions looked at in one read.
pub const SCAN_LIMIT: u64 = 2000;

/// `metadata.question.status`.
pub fn status_of(metadata: Option<&Value>) -> Option<&str> {
    metadata?.get("question")?.get("status")?.as_str()
}

/// `metadata.question.askedTo`.
pub fn asked_to_of(metadata: Option<&Value>) -> Vec<String> {
    metadata
        .and_then(|m| m.get("question"))
        .and_then(|q| q.get("askedTo"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The metadata a new question's first message carries.
pub fn new_metadata(asked_to: &[String]) -> Value {
    let mut question = json!({ "status": "open" });
    if !asked_to.is_empty() {
        question["askedTo"] = json!(asked_to);
    }
    json!({ "question": question })
}

/// A question whose status changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changed {
    /// The first message of the thread.
    pub message_id: String,
    pub channel_id: String,
    pub record_type: String,
    pub record_id: String,
    pub from: String,
    pub to: String,
}

/// The `jsonb_set` that sets `metadata.question.status`.
fn status_expr(status: &str) -> Expr {
    Expr::cust_with_values(
        "jsonb_set(chat_messages.metadata, string_to_array($1, ','), to_jsonb($2::text), false)",
        ["question,status", status],
    )
}

/// `metadata -> 'question' ->> 'status' = 'open'`.
fn is_open() -> Expr {
    Expr::cust("chat_messages.metadata -> 'question' ->> 'status' = 'open'")
}

/// A question, found by its first message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub message_id: String,
    pub channel_id: String,
    pub record_type: String,
    pub record_id: String,
    pub status: String,
    pub author_id: String,
}

/// The question whose first message is `message_id`: a live top-level message
/// with `metadata.question` in the live record chat of a WeldBooks record.
///
/// # Errors
///
/// The database's.
pub async fn find(db: &PgPool, message_id: &str) -> Result<Option<Found>, DbErr> {
    type Row = (
        String,
        String,
        String,
        Option<Value>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = messages::Entity::find()
        .select_only()
        .columns([
            messages::Column::Id,
            messages::Column::ChannelId,
            messages::Column::AuthorId,
            messages::Column::Metadata,
        ])
        .column(channels::Column::EntityType)
        .column(channels::Column::EntityId)
        .join(JoinType::InnerJoin, channel_of_message())
        .filter(messages::Column::Id.eq(message_id))
        .filter(messages::Column::DeletedAt.is_null())
        .filter(messages::Column::ParentId.is_null())
        .filter(channels::Column::Type.eq("entity"))
        .filter(channels::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((id, channel_id, author_id, metadata, Some(record_type), Some(record_id))) = row
    else {
        return Ok(None);
    };
    if !entity::provider(&record_type).is_some_and(Provider::is_books) {
        return Ok(None);
    }
    let Some(status) = status_of(metadata.as_ref()) else {
        return Ok(None);
    };
    Ok(Some(Found {
        message_id: id,
        channel_id,
        record_type,
        record_id,
        status: status.to_owned(),
        author_id,
    }))
}

fn channel_of_message() -> RelationDef {
    messages::Entity::belongs_to(channels::Entity)
        .from(messages::Column::ChannelId)
        .to(channels::Column::Id)
        .into()
}

/// A reply by `replier` in the thread of `parent_id` answers the question
/// there, when it is open and the replier is not the asker. `None` when
/// nothing changed.
///
/// # Errors
///
/// The database's.
pub async fn answer_on_reply(
    db: &PgPool,
    parent_id: &str,
    replier: &str,
) -> Result<Option<Changed>, DbErr> {
    let Some(question) = find(db, parent_id).await? else {
        return Ok(None);
    };
    if question.status != "open" || question.author_id == replier {
        return Ok(None);
    }
    let updated = messages::Entity::update_many()
        .col_expr(messages::Column::Metadata, status_expr("answered"))
        .filter(messages::Column::Id.eq(parent_id))
        .filter(is_open())
        .exec(&orm(db))
        .await?
        .rows_affected;
    Ok((updated > 0).then(|| Changed {
        message_id: question.message_id,
        channel_id: question.channel_id,
        record_type: question.record_type,
        record_id: question.record_id,
        from: "open".to_owned(),
        to: "answered".to_owned(),
    }))
}

/// Every open question on a record becomes answered: a receipt was attached
/// to, or booked for, the bank line. Those that changed.
///
/// # Errors
///
/// The database's.
pub async fn answer_open_on_record(
    db: &PgPool,
    record_type: &str,
    record_id: &str,
) -> Result<Vec<Changed>, DbErr> {
    let channel_ids: Vec<String> = channels::Entity::find()
        .select_only()
        .column(channels::Column::Id)
        .filter(channels::Column::Type.eq("entity"))
        .filter(channels::Column::EntityType.eq(record_type))
        .filter(channels::Column::EntityId.eq(record_id))
        .filter(channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let changed = messages::Entity::update_many()
        .col_expr(messages::Column::Metadata, status_expr("answered"))
        .filter(messages::Column::ChannelId.is_in(&channel_ids))
        .filter(messages::Column::ParentId.is_null())
        .filter(messages::Column::DeletedAt.is_null())
        .filter(is_open())
        .exec_with_returning(&orm(db))
        .await?;
    Ok(changed
        .into_iter()
        .map(|message| Changed {
            message_id: message.id,
            channel_id: message.channel_id,
            record_type: record_type.to_owned(),
            record_id: record_id.to_owned(),
            from: "open".to_owned(),
            to: "answered".to_owned(),
        })
        .collect())
}

/// Set a question's status by hand (resolve it, re-open it). `None` when the
/// message is not a question; nothing changes (and `from == to`) when it is
/// there already.
///
/// # Errors
///
/// The database's.
pub async fn set_status(
    db: &PgPool,
    message_id: &str,
    status: &str,
) -> Result<Option<Changed>, DbErr> {
    let Some(question) = find(db, message_id).await? else {
        return Ok(None);
    };
    if question.status != status {
        messages::Entity::update_many()
            .col_expr(messages::Column::Metadata, status_expr(status))
            .filter(messages::Column::Id.eq(message_id))
            .exec(&orm(db))
            .await?;
    }
    Ok(Some(Changed {
        message_id: question.message_id,
        channel_id: question.channel_id,
        record_type: question.record_type,
        record_id: question.record_id,
        from: question.status,
        to: status.to_owned(),
    }))
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// What a list asks for.
#[derive(Debug, Clone, Default)]
pub struct Filters<'a> {
    pub status: Option<&'a str>,
    /// Only the questions asked to this member.
    pub asked_to: Option<&'a str>,
    pub record_type: Option<&'a str>,
    /// Only the question with this first message.
    pub message_id: Option<&'a str>,
    /// Only the questions on records of these legal entities (the request's,
    /// [`request_entity`]); a contact has no entity and is not narrowed.
    pub entity: Option<&'a EntityScopeCondition>,
}

/// The legal entity a list of questions is about, resolved as every books
/// route resolves its entity: the one the request names (`X-Legal-Entity-Id`,
/// `X-Accounting-Entity-Id`, `?entityId`, `requested` here), else the default
/// entity, kept only when the member sees it and WeldBooks is enabled for it.
/// A document without an entity is the default entity's.
///
/// `None` (no narrowing) when the request names no entity and there is no
/// default one; [`EntityScopeCondition::Nothing`] (contacts only) when the
/// named entity does not resolve, so a restricted or unknown entity never
/// widens the list to the others.
///
/// # Errors
///
/// The database's.
pub async fn request_entity(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    requested: Option<&str>,
) -> Result<Option<EntityScopeCondition>, DbErr> {
    let Some(workspace) = can.resolved().await? else {
        return Ok(Some(EntityScopeCondition::Nothing));
    };
    let access = load_entity_access(db, user_id, workspace).await?;
    let app = Some(LegalEntityApp::Weldbooks);
    match resolve_request_entity(db, &access, requested, app, true).await? {
        Some(entity) => {
            let default = default_entity_id_for(db, app).await?;
            Ok(Some(entity_scope_condition(
                Some(&[entity]),
                default.as_deref(),
            )))
        }
        None if requested.is_some() => Ok(Some(EntityScopeCondition::Nothing)),
        None => Ok(None),
    }
}

/// A person on a question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub name: Option<String>,
}

/// One question as the list returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub id: String,
    pub channel_id: String,
    pub record_type: String,
    pub record_id: String,
    pub record_title: Option<String>,
    pub text: String,
    pub status: String,
    pub asked_by: Person,
    pub asked_to: Vec<Person>,
    pub created_at: String,
    pub last_reply_at: Option<String>,
    pub reply_count: i32,
    /// The record's legal entity (none for a contact).
    pub entity_id: Option<String>,
}

impl Question {
    /// The list's JSON: `{ id, recordType, recordId, recordTitle, text,
    /// status, askedBy, askedTo, createdAt, lastReplyAt, replyCount, entityId,
    /// channelId, link }`.
    pub fn json(&self) -> Value {
        let person = |p: &Person| json!({ "id": p.id, "name": p.name });
        json!({
            "id": self.id,
            "recordType": self.record_type,
            "recordId": self.record_id,
            "recordTitle": self.record_title,
            "text": self.text,
            "status": self.status,
            "askedBy": person(&self.asked_by),
            "askedTo": self.asked_to.iter().map(person).collect::<Vec<_>>(),
            "createdAt": self.created_at,
            "lastReplyAt": self.last_reply_at,
            "replyCount": self.reply_count,
            "entityId": self.entity_id,
            "channelId": self.channel_id,
            "link": entity::provider(&self.record_type)
                .and_then(|p| p.books_link(&self.record_id)),
        })
    }
}

/// A question the scan found, before the caller's access is applied.
struct Candidate {
    id: String,
    channel_id: String,
    author_id: String,
    author_name: String,
    text: String,
    metadata: Option<Value>,
    created_at: PrimitiveDateTime,
    reply_count: i32,
    last_reply_at: Option<PrimitiveDateTime>,
    record_type: String,
    record_id: String,
    channel_title: Option<String>,
}

type CandidateRow = (
    String,
    String,
    String,
    String,
    String,
    Option<Value>,
    PrimitiveDateTime,
    i32,
    Option<PrimitiveDateTime>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The newest questions of the given record types, [`SCAN_LIMIT`] at most.
async fn scan(db: &PgPool, types: &[&str], filters: &Filters<'_>) -> Result<Vec<Candidate>, DbErr> {
    let mut select = messages::Entity::find()
        .select_only()
        .columns([
            messages::Column::Id,
            messages::Column::ChannelId,
            messages::Column::AuthorId,
            messages::Column::AuthorName,
            messages::Column::Content,
            messages::Column::Metadata,
            messages::Column::CreatedAt,
            messages::Column::ThreadReplyCount,
            messages::Column::ThreadLastReplyAt,
        ])
        .columns([
            channels::Column::EntityType,
            channels::Column::EntityId,
            channels::Column::EntityDisplayName,
        ])
        .join(JoinType::InnerJoin, channel_of_message())
        .filter(channels::Column::Type.eq("entity"))
        .filter(channels::Column::DeletedAt.is_null())
        .filter(channels::Column::EntityType.is_in(types.iter().copied()))
        .filter(messages::Column::ParentId.is_null())
        .filter(messages::Column::DeletedAt.is_null())
        .filter(Expr::cust(
            "chat_messages.metadata -> 'question' ->> 'status' IS NOT NULL",
        ));
    if let Some(status) = filters.status {
        select = select.filter(Expr::cust_with_values(
            "chat_messages.metadata -> 'question' ->> 'status' = $1",
            [status],
        ));
    }
    if let Some(id) = filters.message_id {
        select = select.filter(messages::Column::Id.eq(id));
    }
    if let Some(user) = filters.asked_to {
        select = select.filter(Expr::cust_with_values(
            "chat_messages.metadata -> 'question' -> 'askedTo' @> to_jsonb($1::text)",
            [user],
        ));
    }
    let rows: Vec<CandidateRow> = select
        .order_by_desc(messages::Column::CreatedAt)
        .order_by_desc(messages::Column::Id)
        .limit(SCAN_LIMIT)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(
                id,
                channel_id,
                author_id,
                author_name,
                text,
                metadata,
                created_at,
                reply_count,
                last_reply_at,
                record_type,
                record_id,
                channel_title,
            )| {
                Some(Candidate {
                    id,
                    channel_id,
                    author_id,
                    author_name,
                    text,
                    metadata,
                    created_at,
                    reply_count,
                    last_reply_at,
                    record_type: record_type?,
                    record_id: record_id?,
                    channel_title,
                })
            },
        )
        .collect())
}

/// One question by its first message, as the list returns it. It does not
/// check who is asking: the caller has just checked the record.
///
/// # Errors
///
/// The database's.
pub async fn get(db: &PgPool, message_id: &str) -> Result<Option<Question>, DbErr> {
    let types: Vec<&str> = entity::record_chat_providers()
        .filter(|p| p.is_books())
        .map(Provider::type_name)
        .collect();
    let filters = Filters {
        message_id: Some(message_id),
        ..Filters::default()
    };
    let found = scan(db, &types, &filters).await?;
    let page: Vec<&Candidate> = found.iter().collect();
    Ok(hydrate(db, &page).await?.into_iter().next())
}

/// A page of the questions the caller may see.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub items: Vec<Question>,
    /// Every question that passes the filters and the caller's access.
    pub total: usize,
    pub has_more: bool,
    /// The last item's id, when there is more.
    pub cursor: Option<String>,
}

/// The newest questions on records `user_id` may see, `limit` after `cursor`
/// (a question id). A type the member has no permission for, and a record they
/// may not see (its legal entity restricted, say), are left out, so the count
/// is of what they can open. Contacts count: their permission is the rule.
///
/// # Errors
///
/// The database's.
pub async fn list(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    filters: &Filters<'_>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page, DbErr> {
    let mut providers: Vec<Provider> = Vec::new();
    for provider in entity::record_chat_providers().filter(|p| p.is_books()) {
        if filters
            .record_type
            .is_some_and(|wanted| wanted != provider.type_name())
        {
            continue;
        }
        if can.can(provider.required_permission()).await? {
            providers.push(provider);
        }
    }
    if providers.is_empty() {
        return Ok(Page {
            items: Vec::new(),
            total: 0,
            has_more: false,
            cursor: None,
        });
    }
    let types: Vec<&str> = providers.iter().map(|p| p.type_name()).collect();
    let candidates = scan(db, &types, filters).await?;
    let mut visible: HashMap<&str, HashSet<String>> = HashMap::new();
    for provider in &providers {
        let mut ids: Vec<String> = candidates
            .iter()
            .filter(|c| c.record_type == provider.type_name())
            .map(|c| c.record_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        let seen = if ids.is_empty() {
            HashSet::new()
        } else {
            let within = filters.entity.unwrap_or(&EntityScopeCondition::All);
            books_records::visible_in(*provider, db, user_id, can, &ids, within).await?
        };
        visible.insert(provider.type_name(), seen);
    }
    let allowed: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| {
            visible
                .get(c.record_type.as_str())
                .is_some_and(|ids| ids.contains(&c.record_id))
        })
        .collect();
    let total = allowed.len();
    let start = cursor
        .and_then(|after| allowed.iter().position(|c| c.id == after))
        .map_or(0, |at| at + 1);
    let end = (start + limit).min(total);
    let page: Vec<&Candidate> = allowed.iter().skip(start).take(end - start).collect();
    let has_more = end < total;
    let next = has_more
        .then(|| page.last().map(|c| c.id.clone()))
        .flatten();
    let items = hydrate(db, &page).await?;
    Ok(Page {
        items,
        total,
        has_more,
        cursor: next,
    })
}

/// The names of the people on a page and the records' current names and entities.
async fn hydrate(db: &PgPool, page: &[&Candidate]) -> Result<Vec<Question>, DbErr> {
    let mut people: Vec<String> = Vec::new();
    for candidate in page {
        people.push(candidate.author_id.clone());
        people.extend(asked_to_of(candidate.metadata.as_ref()));
    }
    people.sort();
    people.dedup();
    let names: HashMap<String, Option<String>> = if people.is_empty() {
        HashMap::new()
    } else {
        let rows: Vec<(String, Option<String>)> = workspace_members::Entity::find()
            .select_only()
            .columns([
                workspace_members::Column::UserId,
                workspace_members::Column::Name,
            ])
            .filter(workspace_members::Column::UserId.is_in(&people))
            .into_tuple()
            .all(&orm(db))
            .await?;
        rows.into_iter().collect()
    };
    let person = |id: &str, fallback: Option<&str>| Person {
        id: id.to_owned(),
        name: names
            .get(id)
            .cloned()
            .flatten()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| fallback.map(str::to_owned)),
    };
    let mut records: HashMap<(String, String), books_records::BooksRecord> = HashMap::new();
    for candidate in page {
        let key = (candidate.record_type.clone(), candidate.record_id.clone());
        if records.contains_key(&key) {
            continue;
        }
        if let Some(provider) = entity::provider(&candidate.record_type)
            && let Some(record) =
                books_records::records(provider, db, std::slice::from_ref(&candidate.record_id))
                    .await?
                    .remove(&candidate.record_id)
        {
            records.insert(key, record);
        }
    }
    Ok(page
        .iter()
        .map(|c| {
            let record = records.get(&(c.record_type.clone(), c.record_id.clone()));
            Question {
                id: c.id.clone(),
                channel_id: c.channel_id.clone(),
                record_type: c.record_type.clone(),
                record_id: c.record_id.clone(),
                record_title: record
                    .map(|r| r.title.clone())
                    .or_else(|| c.channel_title.clone()),
                text: c.text.clone(),
                status: status_of(c.metadata.as_ref()).unwrap_or("open").to_owned(),
                asked_by: person(&c.author_id, Some(&c.author_name)),
                asked_to: asked_to_of(c.metadata.as_ref())
                    .iter()
                    .map(|id| person(id, None))
                    .collect(),
                created_at: iso_timestamp(c.created_at.assume_utc()),
                last_reply_at: c.last_reply_at.map(|at| iso_timestamp(at.assume_utc())),
                reply_count: c.reply_count,
                entity_id: record.and_then(|r| r.entity_id.clone()),
            }
        })
        .collect())
}

/// The time a status changed, for event data.
pub fn changed_json(changed: &Changed) -> Value {
    json!({
        "id": changed.message_id,
        "channelId": changed.channel_id,
        "recordType": changed.record_type,
        "recordId": changed.record_id,
        "from": changed.from,
        "status": changed.to,
        "at": iso_timestamp(utc_now().assume_utc()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_question_is_read_from_the_metadata() {
        let meta = json!({ "question": { "status": "open", "askedTo": ["u1", "u2"] }, "x": 1 });
        assert_eq!(status_of(Some(&meta)), Some("open"));
        assert_eq!(asked_to_of(Some(&meta)), ["u1", "u2"]);
        assert_eq!(status_of(Some(&json!({ "anchor": {} }))), None);
        assert_eq!(status_of(None), None);
        assert_eq!(
            asked_to_of(Some(&json!({ "question": { "status": "open" } }))),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_new_question_is_open_and_names_who_it_is_for() {
        assert_eq!(
            new_metadata(&["u1".to_owned()]),
            json!({ "question": { "status": "open", "askedTo": ["u1"] } })
        );
        assert_eq!(
            new_metadata(&[]),
            json!({ "question": { "status": "open" } })
        );
    }
}
