//! Messages (`@weldsuite/mail-domain/messages` and the message half of
//! `store/postgres/mailbox-store.ts`, `postgres` mode): the list, the
//! reading pane, stats and folder counters, and the single-message writes.
//!
//! Rows are the `mail_messages` entity as Drizzle hands them out
//! ([`message_json`]); the list rows leave out the bodies, raw MIME and the
//! three `jsonb` blobs no list reads (`wideListColumns`).

use std::collections::HashMap;

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, orm_error, utc_timestamp};
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::mail_messages::{self, Column};
use weldsuite_schema::tenant::{mail_accounts, mail_attachments, mail_drafts, mail_labels, people};

use crate::labels::{
    self, FlagPatchInput, IMPORTANT, LabelMatch, SCHEDULED, SPAM, STARRED, TRASH, add_labels,
    canonical_label_names, carries, flags_for_label_change, is_not_system, labels_for_flag_patch,
    labels_of, lower, msg, normalize_label, remove_labels, to_system_label,
};

/// `now.toISOString()`.
pub fn iso(now: OffsetDateTime) -> String {
    let ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    crate::outbound::clock::iso(ms)
}

/// `escapeLike(value)`.
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `containsPattern(value)`: `%<trimmed, escaped>%`.
pub fn contains_pattern(value: &str) -> String {
    format!("%{}%", escape_like(js_trim(value)))
}

/// The search terms of `messageSearchCondition` / `messageContainsAnyWord`:
/// at most ten whitespace-separated words, as `LIKE` patterns.
pub fn search_patterns(search: Option<&str>) -> Vec<String> {
    js_trim(search.unwrap_or_default())
        .split(char::is_whitespace)
        .filter(|term| !term.is_empty())
        .take(10)
        .map(contains_pattern)
        .collect()
}

/// `jsonb_array_elements(case when jsonb_typeof(col) = 'array' then col else
/// '[]'::jsonb end) as recipient`: the entries of a recipient column.
fn recipients_of(column: Column) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let is_array = Expr::from(Func::cust("jsonb_typeof").arg(msg(column))).eq("array");
    let entries = Expr::case(is_array, msg(column)).finally(Expr::val(json!([])));
    Query::select()
        .expr(Expr::val(1))
        .from_function(
            Func::cust("jsonb_array_elements").arg(entries),
            Alias::new("recipient"),
        )
        .to_owned()
}

/// `recipient->>'field'`.
fn recipient_field(field: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
        Expr::col(Alias::new("recipient")),
        field,
    )
}

/// `"from"->>'field'`.
pub(crate) fn sender_field(field: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(msg(Column::From), field)
}

/// A recipient column (`to`, `cc`) has an address or name matching the
/// pattern (`recipientMatches`).
pub(crate) fn recipient_matches(column: Column, pattern: &str) -> Expr {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    Expr::exists(
        recipients_of(column)
            .cond_where(
                Condition::any()
                    .add(PgExpr::ilike(recipient_field("email"), pattern))
                    .add(PgExpr::ilike(recipient_field("name"), pattern)),
            )
            .to_owned(),
    )
}

/// A recipient column has exactly this (lower-cased) address
/// (`recipientEquals`).
fn recipient_equals(column: Column, address: &str) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::exists(
        recipients_of(column)
            .cond_where(lower(recipient_field("email")).eq(address))
            .to_owned(),
    )
}

/// The sender's name or address matches the pattern.
pub(crate) fn sender_matches(pattern: &str) -> Condition {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    Condition::any()
        .add(PgExpr::ilike(sender_field("name"), pattern))
        .add(PgExpr::ilike(sender_field("email"), pattern))
}

/// One search word (`messageSearchCondition`): in the subject, preview or
/// text body, the sender, or a To / Cc recipient.
pub(crate) fn search_term(pattern: &str) -> Condition {
    Condition::any()
        .add(Column::Subject.ilike(pattern))
        .add(Column::Preview.ilike(pattern))
        .add(Column::TextBody.ilike(pattern))
        .add(sender_matches(pattern))
        .add(
            Condition::any()
                .add(recipient_matches(Column::To, pattern))
                .add(recipient_matches(Column::Cc, pattern)),
        )
}

/// `inTrashOrSpamCondition()`: labelled or flagged trash or spam.
pub(crate) fn in_trash_or_spam() -> Condition {
    let flag = |column: Column| Expr::from(Func::coalesce([msg(column), Expr::val(false)]));
    Condition::any()
        .add(carries(TRASH))
        .add(carries(SPAM))
        .add(flag(Column::IsTrash))
        .add(flag(Column::IsSpam))
}

/// `inTrashOrSpamCondition()` over `mail_messages m`, for the counts that
/// stay SQL.
macro_rules! in_trash_or_spam {
    () => {
        "(coalesce(m.labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb
          or coalesce(m.labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb
          or coalesce(m.is_trash, false) or coalesce(m.is_spam, false))"
    };
}

/// A `mail_messages` row as the store reads it (`to_jsonb(m)`). Here and in
/// every other `mail_messages` read, `threats` (EU and self-hosted only, ADR
/// MAIL-014) is left out while null, so a message without threats reads
/// exactly as the TypeScript worker's, whose schema has no such column.
pub(crate) fn message_json(row: mail_messages::Model) -> Result<Value, DbErr> {
    let mut row = serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))?;
    if let Value::Object(fields) = &mut row
        && fields.get("threats").is_some_and(Value::is_null)
    {
        fields.remove("threats");
    }
    Ok(row)
}

/// The list columns (`wideListColumns`): every column but the bodies, raw
/// MIME, headers, custom fields and clicked links.
pub(crate) fn wide_json(row: mail_messages::Model) -> Result<Value, DbErr> {
    let mut row = message_json(row)?;
    if let Value::Object(fields) = &mut row {
        for key in [
            "textBody",
            "htmlBody",
            "rawMessage",
            "headers",
            "customFields",
            "clickedLinks",
        ] {
            fields.remove(key);
        }
    }
    Ok(row)
}

/// Rows as [`wide_json`] reads them.
pub(crate) fn wide_rows(rows: Vec<mail_messages::Model>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter().map(wide_json).collect()
}

/// Rows as [`message_json`] reads them.
pub(crate) fn message_rows(rows: Vec<mail_messages::Model>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter().map(message_json).collect()
}

/// `MessageFilters` as the list reads them.
#[derive(Debug, Clone, Default)]
pub struct MessageFilters {
    pub account_id: Option<String>,
    pub accessible_account_ids: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub search: Option<String>,
    pub is_read: Option<bool>,
    pub is_starred: Option<bool>,
    pub is_flagged: Option<bool>,
    pub has_attachments: Option<bool>,
    pub thread_id: Option<String>,
    pub label: Option<String>,
    pub from: Option<String>,
    pub counterparty: Option<String>,
    /// `cursorValue`: `(sentDate as an ISO string, id)`.
    pub cursor: Option<(String, String)>,
}

/// The values [`MessageFilters::condition`] matches on.
struct ConditionValues {
    account_id: Option<String>,
    accessible: Option<Vec<String>>,
    search: Vec<String>,
    label: Option<LabelMatch>,
    from: Option<String>,
    counterparty: Option<String>,
}

impl MessageFilters {
    async fn values(&self, db: &PgPool) -> Result<ConditionValues, DbErr> {
        let account_id = self.account_id.clone().filter(|id| !id.is_empty());
        let label = match self.label.as_deref().filter(|l| !l.is_empty()) {
            Some(label) => {
                let names =
                    labels::resolve_custom_label_names(db, label, account_id.as_deref()).await?;
                Some(LabelMatch::new(label, &names))
            }
            None => None,
        };
        Ok(ConditionValues {
            account_id,
            accessible: self.accessible_account_ids.clone(),
            search: search_patterns(self.search.as_deref()),
            label,
            from: self
                .from
                .as_deref()
                .filter(|f| !js_trim(f).is_empty())
                .map(contains_pattern),
            counterparty: self
                .counterparty
                .as_deref()
                .filter(|c| !js_trim(c).is_empty())
                .map(|c| js_trim(c).to_lowercase()),
        })
    }

    /// `buildMessageConditions(filters, labelNames)`.
    fn condition(&self, values: &ConditionValues) -> Condition {
        use sea_orm::ExprTrait as _;
        let mut all = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(account_id) = &values.account_id {
            all = all.add(Column::AccountId.eq(account_id));
        }
        if let Some(accessible) = &values.accessible {
            // An empty list is no mailbox (`= any('{}')`).
            all = all.add(Column::AccountId.is_in(accessible));
        }
        // Every search word somewhere.
        for pattern in &values.search {
            all = all.add(search_term(pattern));
        }
        for (column, value) in [
            (Column::IsRead, self.is_read),
            (Column::IsStarred, self.is_starred),
            (Column::IsFlagged, self.is_flagged),
            (Column::HasAttachments, self.has_attachments),
        ] {
            if let Some(value) = value {
                all = all.add(column.eq(value));
            }
        }
        if let Some(thread_id) = self.thread_id.as_deref().filter(|t| !t.is_empty()) {
            all = all.add(Column::ThreadId.eq(thread_id));
        }
        if let Some(label) = &values.label {
            all = all.add(label.condition());
        }
        if let Some(from) = &values.from {
            all = all.add(sender_matches(from));
        }
        if let Some(counterparty) = &values.counterparty {
            all = all.add(
                Condition::any()
                    .add(lower(sender_field("email")).eq(counterparty.as_str()))
                    .add(recipient_equals(Column::To, counterparty))
                    .add(recipient_equals(Column::Cc, counterparty))
                    .add(recipient_equals(Column::Bcc, counterparty)),
            );
        }
        all
    }
}

/// One page of `listMessagesWide`.
#[derive(Debug, Clone, Default)]
pub struct MessagePage {
    pub data: Vec<Value>,
    pub has_more: bool,
    pub total_count: i64,
}

/// `listMessagesWide(db, filters)`: newest first, `limit + 1` probed, the
/// count without the cursor, senders resolved.
pub async fn list_messages_wide(
    db: &PgPool,
    filters: &MessageFilters,
) -> Result<MessagePage, DbErr> {
    let limit = filters.limit.unwrap_or(50).min(100);
    let values = filters.values(db).await?;
    let condition = filters.condition(&values);
    let conn = orm(db);
    let mut page = mail_messages::Entity::find().filter(condition.clone());
    if let Some((at, id)) = &filters.cursor {
        page = page.filter(before_cursor(at, id));
    }
    let rows = page
        .order_by_desc(Column::SentDate)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or_default())
        .all(&conn)
        .await?;
    let total: i32 = mail_messages::Entity::find()
        .select_only()
        .column_as(count_int(), "count")
        .filter(condition)
        .into_tuple()
        .one(&conn)
        .await?
        .unwrap_or_default();
    let mut data = wide_rows(rows)?;
    let has_more = usize::try_from(limit).is_ok_and(|limit| data.len() > limit);
    if has_more {
        data.truncate(usize::try_from(limit).unwrap_or(0));
    }
    enrich_sender_contacts(db, &mut data).await?;
    Ok(MessagePage {
        data,
        has_more,
        total_count: i64::from(total),
    })
}

/// After the cursor, newest first: `sent_date < $at::timestamp or
/// (sent_date = $at::timestamp and id < $id)`. The position's time is the
/// text the cursor carries, cast by Postgres as before.
fn before_cursor(at: &str, id: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    let at = || Expr::val(at).cast_as("timestamp");
    Condition::any().add(msg(Column::SentDate).lt(at())).add(
        Condition::all()
            .add(msg(Column::SentDate).eq(at()))
            .add(Column::Id.lt(id)),
    )
}

/// `count(*)::int`.
pub(crate) fn count_int() -> Expr {
    sea_orm::ExprTrait::cast_as(Func::count(Expr::col(Asterisk)), "int")
}

/// `getLiveMessagesByIds(db, accountId, ids, opts)`: lean rows, no order.
pub async fn live_messages_by_ids(
    db: &PgPool,
    account_id: &str,
    ids: &[String],
    include_deleted: bool,
) -> Result<Vec<Value>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut find = mail_messages::Entity::find()
        .filter(Column::AccountId.eq(account_id))
        .filter(Column::Id.is_in(ids));
    if !include_deleted {
        find = find.filter(Column::DeletedAt.is_null());
    }
    wide_rows(find.all(&orm(db)).await?)
}

/// A sender's contact: email, first and last name, avatar.
type ContactRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// `enrichSenderContacts(db, rows)`: the mailbox's own display name for its
/// own mail, else the matching contact's name, else the From name; and the
/// contact's avatar.
pub async fn enrich_sender_contacts(db: &PgPool, rows: &mut [Value]) -> Result<(), DbErr> {
    let mut senders: Vec<String> = Vec::new();
    for row in rows.iter() {
        if let Some(email) = row["from"]["email"].as_str().filter(|e| !e.is_empty()) {
            let email = email.to_lowercase();
            if !senders.contains(&email) {
                senders.push(email);
            }
        }
    }
    if senders.is_empty() {
        return Ok(());
    }
    let mut account_ids: Vec<String> = Vec::new();
    for row in rows.iter() {
        if let Some(id) = row["accountId"].as_str().filter(|id| !id.is_empty())
            && !account_ids.iter().any(|a| a == id)
        {
            account_ids.push(id.to_owned());
        }
    }
    let conn = orm(db);
    let mut own_names: HashMap<String, String> = HashMap::new();
    if !account_ids.is_empty() {
        let accounts: Vec<(String, String, Option<String>)> = mail_accounts::Entity::find()
            .select_only()
            .columns([
                mail_accounts::Column::Id,
                mail_accounts::Column::Email,
                mail_accounts::Column::DisplayName,
            ])
            .filter(mail_accounts::Column::Id.is_in(account_ids))
            .into_tuple()
            .all(&conn)
            .await?;
        for (id, email, display_name) in accounts {
            let name = display_name.as_deref().map(js_trim).unwrap_or_default();
            if !email.is_empty() && !name.is_empty() {
                own_names.insert(format!("{id}::{}", email.to_lowercase()), name.to_owned());
            }
        }
    }
    let contacts: Vec<ContactRow> = people::Entity::find()
        .select_only()
        .columns([
            people::Column::Email,
            people::Column::FirstName,
            people::Column::LastName,
            people::Column::AvatarUrl,
        ])
        .filter(people::Column::Email.is_in(senders))
        .filter(people::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&conn)
        .await?;
    let mut names: HashMap<String, String> = HashMap::new();
    let mut avatars: HashMap<String, String> = HashMap::new();
    for (email, first, last, avatar) in contacts {
        let Some(email) = email else { continue };
        let key = email.to_lowercase();
        let name = format!("{} {}", first.unwrap_or_default(), last.unwrap_or_default());
        let name = js_trim(&name).to_owned();
        if !name.is_empty() {
            names.entry(key.clone()).or_insert(name);
        }
        if let Some(avatar) = avatar.filter(|a| !a.is_empty()) {
            avatars.entry(key).or_insert(avatar);
        }
    }
    for row in rows.iter_mut() {
        let Some(email) = row["from"]["email"].as_str().filter(|e| !e.is_empty()) else {
            continue;
        };
        let key = email.to_lowercase();
        let own = row["accountId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .and_then(|id| own_names.get(&format!("{id}::{key}")));
        let name = own.or_else(|| names.get(&key)).cloned();
        let avatar = avatars.get(&key).cloned();
        if name.is_none() && avatar.is_none() {
            continue;
        }
        if let Some(from) = row.get_mut("from").and_then(Value::as_object_mut) {
            if let Some(name) = name {
                from.insert("name".to_owned(), Value::String(name));
            }
            from.insert(
                "avatarUrl".to_owned(),
                avatar.map_or(Value::Null, Value::String),
            );
        }
    }
    Ok(())
}

/// `getMessageAccountId(db, id)`: a live message's mailbox.
pub async fn message_account_id(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    mail_messages::Entity::find()
        .select_only()
        .column(Column::AccountId)
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `toMessageRecord(row, { bodies })`: `threadKey`, `rawMessage: null`, the
/// bodies kept (as null when missing) or dropped.
pub fn message_record(mut row: Value, bodies: bool) -> Value {
    let thread_key = row["threadId"]
        .as_str()
        .or_else(|| row["id"].as_str())
        .map(str::to_owned);
    if let Some(object) = row.as_object_mut() {
        object.insert(
            "threadKey".to_owned(),
            thread_key.map_or(Value::Null, Value::String),
        );
        if bodies {
            for key in ["textBody", "htmlBody"] {
                let value = object.get(key).cloned().unwrap_or(Value::Null);
                object.insert(key.to_owned(), value);
            }
        } else {
            object.remove("textBody");
            object.remove("htmlBody");
        }
        object.insert("rawMessage".to_owned(), Value::Null);
    }
    row
}

/// `getMessage(db, id)`: the full row with senders resolved and, when it
/// has attachments, its attachment rows (deleted ones included).
pub async fn get_message(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let conn = orm(db);
    let row = mail_messages::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let mut rows = [message_json(row)?];
    enrich_sender_contacts(db, &mut rows).await?;
    let [mut row] = rows;
    let attachments = if row["hasAttachments"].as_bool() == Some(true) {
        mail_attachments::Entity::find()
            .filter(mail_attachments::Column::MessageId.eq(id))
            .all(&conn)
            .await?
            .into_iter()
            .map(|a| serde_json::to_value(a).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    row["attachments"] = Value::Array(attachments);
    Ok(Some(row))
}

/// `toPublicAttachment(row)`: without its storage path and download URL.
pub fn public_attachment(mut row: Value) -> Value {
    if let Some(object) = row.as_object_mut() {
        object.remove("storagePath");
        object.remove("downloadUrl");
        // The virus scan's columns (EU and self-hosted only, ADR MAIL-014)
        // are left out while unset, so an unscanned row reads exactly as the
        // TypeScript worker's, whose schema has no such columns.
        for key in ["scanStatus", "scanSignature", "scannedAt"] {
            if object.get(key).is_some_and(Value::is_null) {
                object.remove(key);
            }
        }
    }
    row
}

/// `PostgresMailboxStore.getMessage(id, { bodies, attachments })`: `None`
/// when the message is in another mailbox.
pub async fn mailbox_message(
    db: &PgPool,
    account_id: &str,
    id: &str,
    bodies: bool,
    attachments: bool,
) -> Result<Option<Value>, DbErr> {
    let Some(mut row) = get_message(db, id).await? else {
        return Ok(None);
    };
    if row["accountId"].as_str() != Some(account_id) {
        return Ok(None);
    }
    let files = row
        .as_object_mut()
        .and_then(|o| o.remove("attachments"))
        .unwrap_or(Value::Array(Vec::new()));
    let mut record = message_record(row, bodies);
    if attachments {
        record["attachments"] = files;
    }
    Ok(Some(record))
}

/// `getThread(db, messageId)` as the store hands it out
/// (`getThreadOfMessage`): the conversation of a message, oldest first, as
/// records with bodies. A message without a thread is a thread of one.
pub async fn thread_of_message(
    db: &PgPool,
    message_id: &str,
) -> Result<Option<Value>, DbErr> {
    let conn = orm(db);
    let anchor: Option<(Option<String>, String)> = mail_messages::Entity::find()
        .select_only()
        .columns([Column::ThreadId, Column::AccountId])
        .filter(Column::Id.eq(message_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let Some((thread_id, account_id)) = anchor else {
        return Ok(None);
    };
    let (thread_id, rows) = match thread_id {
        None => {
            let rows = mail_messages::Entity::find()
                .filter(Column::Id.eq(message_id))
                .filter(Column::DeletedAt.is_null())
                .limit(1)
                .all(&conn)
                .await?;
            (message_id.to_owned(), rows)
        }
        Some(thread_id) => {
            let rows = mail_messages::Entity::find()
                .filter(Column::ThreadId.eq(&thread_id))
                .filter(Column::AccountId.eq(&account_id))
                .filter(Column::DeletedAt.is_null())
                .order_by_asc(Column::SentDate)
                .order_by_asc(Column::Id)
                .all(&conn)
                .await?;
            (thread_id, rows)
        }
    };
    let mut rows = message_rows(rows)?;
    enrich_sender_contacts(db, &mut rows).await?;
    let messages: Vec<Value> = rows.into_iter().map(|r| message_record(r, true)).collect();
    Ok(Some(json!({ "threadId": thread_id, "messages": messages })))
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/// The keys of `MessageStats`, in declaration order.
const STAT_KEYS: [&str; 12] = [
    "total",
    "unread",
    "inboxUnread",
    "starred",
    "importantUnread",
    "sentUnread",
    "archiveUnread",
    "trashUnread",
    "spam",
    "snoozed",
    "scheduled",
    "drafts",
];

/// `getMessageStats(db, accountIds)`: the folder counters over the given
/// mailboxes (all zero for none).
pub async fn message_stats(db: &PgPool, account_ids: &[String]) -> Result<Value, DbErr> {
    use sea_orm::ExprTrait as _;
    if account_ids.is_empty() {
        let zero: Map<String, Value> = STAT_KEYS
            .iter()
            .map(|k| ((*k).to_owned(), json!(0)))
            .collect();
        return Ok(Value::Object(zero));
    }
    // `count(*) filter (where …)::int`.
    let count_if = |condition: Condition| -> Expr {
        Func::count(Expr::case(condition, 1)).cast_as("int")
    };
    let unread = || Column::IsRead.eq(false);
    let live = || in_trash_or_spam().not();
    let in_folder = |label: &str| Condition::all().add(carries(label));
    let drafts = Query::select()
        .expr(count_int())
        .from(mail_drafts::Entity)
        .cond_where(
            Condition::all()
                .add(mail_drafts::Column::DeletedAt.is_null())
                .add(mail_drafts::Column::AccountId.is_in(account_ids)),
        )
        .to_owned();
    let row: StatsRow = mail_messages::Entity::find()
        .select_only()
        .column_as(count_int(), "total")
        .column_as(count_if(Condition::all().add(unread())), "unread")
        .column_as(
            count_if(in_folder("INBOX").add(live()).add(unread())),
            "inbox_unread",
        )
        .column_as(
            count_if(
                Condition::all()
                    .add(
                        Condition::any()
                            .add(carries(STARRED))
                            .add(Column::IsStarred.eq(true)),
                    )
                    .add(live()),
            ),
            "starred",
        )
        .column_as(
            count_if(
                Condition::all()
                    .add(
                        Condition::any()
                            .add(carries(IMPORTANT))
                            .add(Column::IsImportant.eq(true)),
                    )
                    .add(live())
                    .add(unread()),
            ),
            "important_unread",
        )
        .column_as(
            count_if(in_folder("SENT").add(live()).add(unread())),
            "sent_unread",
        )
        .column_as(
            count_if(in_folder("ARCHIVE").add(live()).add(unread())),
            "archive_unread",
        )
        .column_as(count_if(in_folder(TRASH).add(unread())), "trash_unread")
        .column_as(count_if(in_folder(SPAM)), "spam")
        .column_as(count_if(in_folder("SNOOZED").add(live())), "snoozed")
        .column_as(
            count_if(
                in_folder(SCHEDULED)
                    .add(Column::SendStatus.eq("scheduled"))
                    .add(live()),
            ),
            "scheduled",
        )
        .column_as(Expr::from(drafts), "drafts")
        .filter(Column::DeletedAt.is_null())
        .filter(Column::AccountId.is_in(account_ids))
        .into_tuple()
        .one(&orm(db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("message stats".to_owned()))?;
    let values = [
        row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10, row.11,
    ];
    let stats: Map<String, Value> = STAT_KEYS
        .iter()
        .zip(values)
        .map(|(k, v)| ((*k).to_owned(), json!(v)))
        .collect();
    Ok(Value::Object(stats))
}

/// The twelve counters, in [`STAT_KEYS`] order.
type StatsRow = (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32);

/// What a folder key counts (`folderKeyCondition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FolderKind {
    Total = 0,
    All = 1,
    Scheduled = 2,
    TrashOrSpam = 3,
    System = 4,
    Custom = 5,
}

/// `labelCounts(keys)`: messages, unread and threads per folder key.
#[allow(clippy::too_many_lines)] // one statement and its parameters
pub async fn label_counts(
    db: &PgPool,
    account_id: &str,
    keys: &[String],
) -> Result<Map<String, Value>, DbErr> {
    if keys.is_empty() {
        return Ok(Map::new());
    }
    let custom_keys: Vec<String> = {
        let mut out: Vec<String> = Vec::new();
        for key in keys {
            let lower = key.to_lowercase();
            let non_custom = matches!(lower.as_str(), "__total" | "__all" | "__scheduled")
                || to_system_label(&lower).is_some();
            if !non_custom && !out.contains(&lower) {
                out.push(lower);
            }
        }
        out
    };
    let mut custom_names: HashMap<String, Vec<String>> = HashMap::new();
    if !custom_keys.is_empty() {
        let rows: Vec<String> = mail_labels::Entity::find()
            .select_only()
            .column(mail_labels::Column::Name)
            .distinct()
            .filter(mail_labels::Column::AccountId.eq(account_id))
            .filter(mail_labels::Column::DeletedAt.is_null())
            .filter(sea_orm::ExprTrait::is_in(
                lower(Expr::col((mail_labels::Entity, mail_labels::Column::Name))),
                custom_keys,
            ))
            .into_tuple()
            .all(&orm(db))
            .await?;
        for name in rows {
            custom_names
                .entry(name.to_lowercase())
                .or_default()
                .push(name);
        }
    }
    let mut kinds: Vec<i32> = Vec::with_capacity(keys.len());
    let mut names: Vec<Value> = Vec::with_capacity(keys.len());
    let mut starred: Vec<bool> = Vec::with_capacity(keys.len());
    let mut important: Vec<bool> = Vec::with_capacity(keys.len());
    for key in keys {
        let lower = key.to_lowercase();
        let (kind, matches) = match lower.as_str() {
            "__total" => (FolderKind::Total, LabelMatch::default()),
            "__all" => (FolderKind::All, LabelMatch::default()),
            "__scheduled" => (FolderKind::Scheduled, LabelMatch::new(SCHEDULED, &[])),
            _ => match to_system_label(&lower) {
                Some(TRASH | SPAM) => (FolderKind::TrashOrSpam, LabelMatch::new(&lower, &[])),
                Some(_) => (FolderKind::System, LabelMatch::new(&lower, &[])),
                None => {
                    let custom = custom_names.get(&lower).cloned().unwrap_or_default();
                    (FolderKind::Custom, LabelMatch::new(&lower, &custom))
                }
            },
        };
        kinds.push(kind as i32);
        names.push(json!(matches.names));
        starred.push(matches.starred);
        important.push(matches.important);
    }
    let counted = folder_counts(
        db,
        account_id,
        &FolderKeys {
            kinds,
            names,
            starred,
            important,
        },
    )
    .await?;
    let mut out = Map::new();
    for (i, key) in keys.iter().enumerate() {
        let ord = i64::try_from(i + 1).unwrap_or_default();
        let (messages, unread, threads) = counted
            .iter()
            .find(|(o, ..)| *o == ord)
            .map_or((0, 0, 0), |(_, m, u, t)| (*m, *u, *t));
        out.insert(
            key.clone(),
            json!({ "messages": messages, "unread": unread, "threads": threads }),
        );
    }
    Ok(out)
}

/// The folder keys [`folder_counts`] counts, as parallel arrays.
struct FolderKeys {
    kinds: Vec<i32>,
    names: Vec<Value>,
    starred: Vec<bool>,
    important: Vec<bool>,
}

/// `(key ordinal, messages, unread, threads)` for every folder key, in one
/// pass over the mailbox's messages.
#[allow(
    clippy::disallowed_methods,
    reason = "counts every folder key in one pass: the keys are parallel arrays unnested with ordinality and left-joined laterally against the mailbox's messages, which the query builder can't express"
)]
async fn folder_counts(
    db: &PgPool,
    account_id: &str,
    keys: &FolderKeys,
) -> Result<Vec<(i64, i32, i32, i32)>, DbErr> {
    sqlx::query_as(concat!(
        "select k.ord,
           count(*) filter (where h.hit)::int,
           count(*) filter (where h.hit and m.is_read = false)::int,
           count(distinct case when h.hit then coalesce(m.thread_id, m.id) end)::int
         from unnest($2::int[], $3::jsonb[], $4::bool[], $5::bool[])
              with ordinality as k(kind, names, starred, important, ord)
         left join mail_messages m on m.account_id = $1 and m.deleted_at is null
         left join lateral (select m.id is not null and (
             k.kind = 0
             or (k.kind = 1 and not ",
        in_trash_or_spam!(),
        ")
             or (k.kind in (2, 3, 4, 5) and (exists (select 1 from jsonb_array_elements_text(k.names) as n(name)
                      where m.labels @> jsonb_build_array(n.name))
                  or (k.starred and m.is_starred = true)
                  or (k.important and m.is_important = true))
                 and (k.kind <> 2 or m.send_status = 'scheduled')
                 and (k.kind = 3 or not ",
        in_trash_or_spam!(),
        ")
                 and (k.kind <> 5 or not coalesce(m.labels, '[]'::jsonb) @> '[\"ARCHIVE\"]'::jsonb)))
           as hit) h on true
         group by k.ord"
    ))
    .bind(account_id)
    .bind(&keys.kinds)
    .bind(&keys.names)
    .bind(&keys.starred)
    .bind(&keys.important)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// `PostgresMailboxStore.stats()`: the counters plus the folder counts of
/// every system label and the mailbox's own labels.
pub async fn mailbox_stats(db: &PgPool, account_id: &str) -> Result<Value, DbErr> {
    let mut base = message_stats(db, &[account_id.to_owned()]).await?;
    let custom: Vec<String> = mail_labels::Entity::find()
        .select_only()
        .column(mail_labels::Column::Name)
        .filter(mail_labels::Column::AccountId.eq(account_id))
        .filter(mail_labels::Column::DeletedAt.is_null())
        .filter(is_not_system())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut keys: Vec<String> = vec!["__total".into(), "__all".into(), "__scheduled".into()];
    for key in labels::SYSTEM_LABELS
        .iter()
        .map(|l| l.to_lowercase())
        .chain(custom.iter().map(|l| l.to_lowercase()))
    {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let counts = label_counts(db, account_id, &keys).await?;
    base["labels"] = Value::Object(counts);
    Ok(base)
}

// ---------------------------------------------------------------------------
// Locate
// ---------------------------------------------------------------------------

/// `WorkspaceMailStore.locateMessages(ids, accountIds, _, opts)`: id →
/// mailbox, within the given mailboxes, in the database's row order.
pub async fn locate_messages(
    db: &PgPool,
    ids: &[String],
    account_ids: &[String],
    include_deleted: bool,
) -> Result<Vec<(String, String)>, DbErr> {
    if ids.is_empty() || account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut find = mail_messages::Entity::find()
        .select_only()
        .columns([Column::Id, Column::AccountId])
        .filter(Column::Id.is_in(ids))
        .filter(Column::AccountId.is_in(account_ids));
    if !include_deleted {
        find = find.filter(Column::DeletedAt.is_null());
    }
    find.into_tuple().all(&orm(db)).await
}

/// The live ones among `ids` (`existingIds`), in row order.
pub async fn existing_ids(db: &PgPool, ids: &[String]) -> Result<Vec<String>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    mail_messages::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::Id.is_in(ids))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// The flags of a single-message patch (`FlagPatch`).
#[derive(Debug, Clone, Copy, Default)]
pub struct FlagPatch {
    pub is_read: Option<bool>,
    pub is_starred: Option<bool>,
    pub is_flagged: Option<bool>,
    pub is_important: Option<bool>,
    pub is_spam: Option<bool>,
    pub is_trash: Option<bool>,
}

/// A live message's column: `select <column> from mail_messages where id =
/// $1 and deleted_at is null limit 1`.
async fn live_message_column<T>(db: &PgPool, id: &str, column: Column) -> Result<Option<T>, DbErr>
where
    T: sea_orm::TryGetableMany,
{
    mail_messages::Entity::find()
        .select_only()
        .column(column)
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `update mail_messages set … where id = $1`.
async fn update_message(
    db: &PgPool,
    id: &str,
    update: sea_orm::UpdateMany<mail_messages::Entity>,
) -> Result<(), DbErr> {
    update.filter(Column::Id.eq(id)).exec(&orm(db)).await?;
    Ok(())
}

/// `updateMessage(db, id, flags)`: the flags, with the labels they mirror
/// kept in step. `false` when the message is missing or deleted.
pub async fn update_message_flags(
    db: &PgPool,
    id: &str,
    patch: FlagPatch,
    now: OffsetDateTime,
) -> Result<bool, DbErr> {
    let existing: Option<Option<Value>> = live_message_column(db, id, Column::Labels).await?;
    let Some(existing) = existing else {
        return Ok(false);
    };
    let synced = labels_for_flag_patch(
        &labels_of(existing.as_ref()),
        FlagPatchInput {
            is_starred: patch.is_starred,
            is_important: patch.is_important,
            is_spam: patch.is_spam,
            is_trash: patch.is_trash,
        },
    );
    let (labels, is_trash, is_spam) = match synced {
        Some(synced) => (
            Some(labels::labels_value(&synced.labels)),
            synced.is_trash.or(patch.is_trash),
            synced.is_spam.or(patch.is_spam),
        ),
        None => (None, patch.is_trash, patch.is_spam),
    };
    // Each flag only when the patch (or the labels it mirrors) sets it.
    let mut update =
        mail_messages::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)));
    for (column, value) in [
        (Column::IsRead, patch.is_read),
        (Column::IsStarred, patch.is_starred),
        (Column::IsFlagged, patch.is_flagged),
        (Column::IsImportant, patch.is_important),
        (Column::IsSpam, is_spam),
        (Column::IsTrash, is_trash),
    ] {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(labels) = labels {
        update = update.col_expr(Column::Labels, Expr::value(labels));
    }
    update_message(db, id, update).await?;
    Ok(true)
}

/// `updateMessage(db, id, { threadId })`.
pub async fn set_thread_id(
    db: &PgPool,
    id: &str,
    thread_id: &str,
    now: OffsetDateTime,
) -> Result<bool, DbErr> {
    let found: Option<String> = live_message_column(db, id, Column::Id).await?;
    if found.is_none() {
        return Ok(false);
    }
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::ThreadId, Expr::value(thread_id))
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)));
    update_message(db, id, update).await?;
    Ok(true)
}

/// `applyLabelsSet(id, labels)`: the label set replaced (spelled as the
/// account's labels, system slugs upper-cased, no duplicates) and the
/// mirrored flags following it. `None` when the message is missing.
pub async fn set_labels(
    db: &PgPool,
    id: &str,
    labels: &[String],
    now: OffsetDateTime,
) -> Result<Option<Vec<String>>, DbErr> {
    let account: Option<String> = live_message_column(db, id, Column::AccountId).await?;
    let Some(account) = account else {
        return Ok(None);
    };
    let canonical = canonical_label_names(db, &account, labels).await?;
    let mut next: Vec<String> = Vec::new();
    for label in canonical.iter().map(|l| normalize_label(l)) {
        if !next.contains(&label) {
            next.push(label);
        }
    }
    let has = |l: &str| next.iter().any(|n| n == l);
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::Labels, Expr::value(labels::labels_value(&next)))
        .col_expr(Column::IsStarred, Expr::value(has(STARRED)))
        .col_expr(Column::IsImportant, Expr::value(has(IMPORTANT)))
        .col_expr(Column::IsTrash, Expr::value(has(TRASH)))
        .col_expr(Column::IsSpam, Expr::value(has(SPAM)))
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)));
    update_message(db, id, update).await?;
    Ok(Some(next))
}

/// `addMessageLabels` / `removeMessageLabels`: the message's labels after
/// the change, `None` when it is missing.
pub async fn change_message_labels(
    db: &PgPool,
    id: &str,
    raw: &[String],
    add: bool,
    now: OffsetDateTime,
) -> Result<Option<Vec<String>>, DbErr> {
    let existing: Option<(Option<Value>, String)> = mail_messages::Entity::find()
        .select_only()
        .columns([Column::Labels, Column::AccountId])
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((current, account)) = existing else {
        return Ok(None);
    };
    let labels = canonical_label_names(db, &account, raw).await?;
    let current = labels_of(current.as_ref());
    let next = if add {
        add_labels(&current, &labels)
    } else {
        remove_labels(&current, &labels)
    };
    let flags = flags_for_label_change(&labels, add);
    let mut update = mail_messages::Entity::update_many()
        .col_expr(Column::Labels, Expr::value(labels::labels_value(&next)));
    for (column, value) in [
        (Column::IsStarred, flags.is_starred),
        (Column::IsImportant, flags.is_important),
        (Column::IsTrash, flags.is_trash),
        (Column::IsSpam, flags.is_spam),
    ] {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    let update = update.col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)));
    update_message(db, id, update).await?;
    Ok(Some(next))
}

/// `softDeleteMessage(db, id)`: `false` when missing.
pub async fn soft_delete_message(
    db: &PgPool,
    id: &str,
    now: OffsetDateTime,
) -> Result<bool, DbErr> {
    let found: Option<String> = live_message_column(db, id, Column::Id).await?;
    if found.is_none() {
        return Ok(false);
    }
    let at = utc_timestamp(now);
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(at))
        .col_expr(Column::UpdatedAt, Expr::value(at));
    update_message(db, id, update).await?;
    Ok(true)
}

/// `applyBulkFlags(ids, patch)`'s writes on the live ids, in the order the
/// TypeScript store makes them.
pub async fn bulk_flags(
    db: &PgPool,
    ids: &[String],
    patch: FlagPatch,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    if ids.is_empty() {
        return Ok(());
    }
    for (column, value) in [
        (Column::IsRead, patch.is_read),
        (Column::IsFlagged, patch.is_flagged),
    ] {
        if let Some(value) = value {
            mail_messages::Entity::update_many()
                .col_expr(column, Expr::value(value))
                .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
                .filter(Column::Id.is_in(ids))
                .exec(&orm(db))
                .await?;
        }
    }
    for (value, label) in [(patch.is_starred, STARRED), (patch.is_important, IMPORTANT)] {
        match value {
            Some(true) => {
                labels::bulk_add_label(db, label, ids, now).await?;
            }
            Some(false) => {
                labels::bulk_remove_label(db, label, ids, now).await?;
            }
            None => {}
        }
    }
    if let Some(spam) = patch.is_spam {
        labels::move_messages_to_location(db, ids, if spam { SPAM } else { labels::INBOX }, now)
            .await?;
    }
    if let Some(trash) = patch.is_trash {
        labels::move_messages_to_location(db, ids, if trash { TRASH } else { labels::INBOX }, now)
            .await?;
    }
    Ok(())
}

/// `finalLabelsFor(ids)`: each id's labels after a bulk write.
pub async fn final_labels(
    db: &PgPool,
    ids: &[String],
) -> Result<Vec<(String, Vec<String>)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<Value>)> = mail_messages::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Labels])
        .filter(Column::Id.is_in(ids))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, labels)| (id, labels_of(labels.as_ref())))
        .collect())
}
