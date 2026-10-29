//! Messages (`@weldsuite/mail-domain/messages` and the message half of
//! `store/postgres/mailbox-store.ts`, `postgres` mode): the list, the
//! reading pane, stats and folder counters, and the single-message writes.
//!
//! Rows are `to_jsonb` of `mail_messages` read back as Drizzle hands them
//! out ([`weldsuite_db::js_row`]); the list rows leave out the bodies, raw
//! MIME and the three `jsonb` blobs no list reads (`wideListColumns`).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::js_trim;

use crate::labels::{
    self, FlagPatchInput, LabelMatch, SCHEDULED, SPAM, STARRED, IMPORTANT, TRASH, add_labels,
    canonical_label_names, flags_for_label_change, labels_for_flag_patch, labels_of,
    normalize_label, remove_labels, to_system_label,
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

/// A recipient column (`to`, `cc`) has an address or name matching the
/// pattern `$p` (`recipientMatches`). Takes the column and pattern SQL.
macro_rules! recipient_matches {
    ($column:literal, $pattern:literal) => {
        concat!(
            "exists (select 1 from jsonb_array_elements(case when jsonb_typeof(",
            $column,
            ") = 'array' then ",
            $column,
            " else '[]'::jsonb end) as recipient
              where recipient->>'email' ilike ",
            $pattern,
            " or recipient->>'name' ilike ",
            $pattern,
            ")"
        )
    };
}

/// A recipient column has exactly this (lower-cased) address
/// (`recipientEquals`).
macro_rules! recipient_equals {
    ($column:literal, $address:literal) => {
        concat!(
            "exists (select 1 from jsonb_array_elements(case when jsonb_typeof(",
            $column,
            ") = 'array' then ",
            $column,
            " else '[]'::jsonb end) as recipient
              where lower(recipient->>'email') = ",
            $address,
            ")"
        )
    };
}

/// `buildMessageConditions(filters, labelNames)` over `mail_messages m`,
/// parameters `$1`–`$14` (see [`MessageFilters::bind`]).
macro_rules! message_conditions {
    () => {
        concat!(
            "m.deleted_at is null
             and ($1::text is null or m.account_id = $1)
             and ($2::text[] is null or m.account_id = any($2::text[]))
             and not exists (select 1 from unnest($3::text[]) as s(p) where not coalesce((
                  m.subject ilike s.p or m.preview ilike s.p or m.text_body ilike s.p
                  or (m.\"from\"->>'name' ilike s.p or m.\"from\"->>'email' ilike s.p)
                  or (",
            recipient_matches!("m.\"to\"", "s.p"),
            " or ",
            recipient_matches!("m.cc", "s.p"),
            ")), false))
             and ($4::bool is null or m.is_read = $4)
             and ($5::bool is null or m.is_starred = $5)
             and ($6::bool is null or m.is_flagged = $6)
             and ($7::bool is null or m.has_attachments = $7)
             and ($8::text is null or m.thread_id = $8)
             and (not $9::bool or (exists (select 1 from unnest($10::text[]) as n(name)
                       where m.labels @> jsonb_build_array(n.name))
                  or ($11::bool and m.is_starred = true)
                  or ($12::bool and m.is_important = true)))
             and ($13::text is null or (m.\"from\"->>'name' ilike $13 or m.\"from\"->>'email' ilike $13))
             and ($14::text is null or (lower(m.\"from\"->>'email') = $14
                  or ",
            recipient_equals!("m.\"to\"", "$14"),
            " or ",
            recipient_equals!("m.cc", "$14"),
            " or ",
            recipient_equals!("m.bcc", "$14"),
            "))"
        )
    };
}

/// `inTrashOrSpamCondition()` over `mail_messages m`.
macro_rules! in_trash_or_spam {
    () => {
        "(coalesce(m.labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb
          or coalesce(m.labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb
          or coalesce(m.is_trash, false) or coalesce(m.is_spam, false))"
    };
}

/// The list columns (`wideListColumns`): every column but the bodies, raw
/// MIME, headers, custom fields and clicked links.
macro_rules! wide_row {
    () => {
        "(to_jsonb(m) - 'text_body' - 'html_body' - 'raw_message' - 'headers'
           - 'custom_fields' - 'clicked_links')"
    };
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

/// The bound values of [`message_conditions!`].
struct ConditionValues {
    account_id: Option<String>,
    accessible: Option<Vec<String>>,
    search: Vec<String>,
    label: Option<LabelMatch>,
    from: Option<String>,
    counterparty: Option<String>,
}

impl MessageFilters {
    async fn values(&self, db: &PgPool) -> Result<ConditionValues, sqlx::Error> {
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
}

macro_rules! bind_conditions {
    ($query:expr, $values:expr, $filters:expr) => {{
        let label = $values.label.clone().unwrap_or_default();
        $query
            .bind($values.account_id.clone())
            .bind($values.accessible.clone())
            .bind($values.search.clone())
            .bind($filters.is_read)
            .bind($filters.is_starred)
            .bind($filters.is_flagged)
            .bind($filters.has_attachments)
            .bind($filters.thread_id.clone().filter(|t: &String| !t.is_empty()))
            .bind($values.label.is_some())
            .bind(label.names)
            .bind(label.starred)
            .bind(label.important)
            .bind($values.from.clone())
            .bind($values.counterparty.clone())
    }};
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
) -> Result<MessagePage, sqlx::Error> {
    let limit = filters.limit.unwrap_or(50).min(100);
    let values = filters.values(db).await?;
    let (cursor_at, cursor_id) = filters.cursor.clone().unzip();
    let rows: Vec<Value> = bind_conditions!(
        sqlx::query_scalar(concat!(
            "select ",
            wide_row!(),
            " from mail_messages m where ",
            message_conditions!(),
            " and ($15::timestamp is null or (m.sent_date < $15::timestamp
                   or (m.sent_date = $15::timestamp and m.id < $16)))
             order by m.sent_date desc, m.id desc limit $17"
        )),
        values,
        filters
    )
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i32 = bind_conditions!(
        sqlx::query_scalar(concat!(
            "select count(*)::int from mail_messages m where ",
            message_conditions!()
        )),
        values,
        filters
    )
    .fetch_one(db)
    .await?;
    let mut data: Vec<Value> = rows.into_iter().map(js_row).collect();
    let has_more = usize::try_from(limit)
        .ok()
        .is_some_and(|limit| data.len() > limit);
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

/// `getLiveMessagesByIds(db, accountId, ids, opts)`: lean rows, no order.
pub async fn live_messages_by_ids(
    db: &PgPool,
    account_id: &str,
    ids: &[String],
    include_deleted: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        wide_row!(),
        " from mail_messages m
         where m.account_id = $1 and m.id = any($2::text[])
           and ($3 or m.deleted_at is null)"
    ))
    .bind(account_id)
    .bind(ids)
    .bind(include_deleted)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `enrichSenderContacts(db, rows)`: the mailbox's own display name for its
/// own mail, else the matching contact's name, else the From name; and the
/// contact's avatar.
pub async fn enrich_sender_contacts(db: &PgPool, rows: &mut [Value]) -> Result<(), sqlx::Error> {
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
    let mut own_names: HashMap<String, String> = HashMap::new();
    if !account_ids.is_empty() {
        let accounts: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select id, email, display_name from mail_accounts where id = any($1::text[])",
        )
        .bind(&account_ids)
        .fetch_all(db)
        .await?;
        for (id, email, display_name) in accounts {
            let name = display_name.as_deref().map(js_trim).unwrap_or_default();
            if !email.is_empty() && !name.is_empty() {
                own_names.insert(format!("{id}::{}", email.to_lowercase()), name.to_owned());
            }
        }
    }
    let contacts: Vec<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "select email, first_name, last_name, avatar_url from people
             where email = any($1::text[]) and deleted_at is null",
        )
        .bind(&senders)
        .fetch_all(db)
        .await?;
    let mut names: HashMap<String, String> = HashMap::new();
    let mut avatars: HashMap<String, String> = HashMap::new();
    for (email, first, last, avatar) in contacts {
        let Some(email) = email else { continue };
        let key = email.to_lowercase();
        let name = format!(
            "{} {}",
            first.unwrap_or_default(),
            last.unwrap_or_default()
        );
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
pub async fn message_account_id(db: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
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
pub async fn get_message(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from mail_messages m where m.id = $1 and m.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let mut rows = [js_row(row)];
    enrich_sender_contacts(db, &mut rows).await?;
    let [mut row] = rows;
    let attachments = if row["hasAttachments"].as_bool() == Some(true) {
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(a) from mail_attachments a where a.message_id = $1",
        )
        .bind(id)
        .fetch_all(db)
        .await?;
        found.into_iter().map(js_row).collect()
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
) -> Result<Option<Value>, sqlx::Error> {
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
pub async fn thread_of_message(db: &PgPool, message_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let anchor: Option<(Option<String>, String)> = sqlx::query_as(
        "select thread_id, account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await?;
    let Some((thread_id, account_id)) = anchor else {
        return Ok(None);
    };
    let (thread_id, rows): (String, Vec<Value>) = match thread_id {
        None => {
            let rows = sqlx::query_scalar(
                "select to_jsonb(m) from mail_messages m
                 where m.id = $1 and m.deleted_at is null limit 1",
            )
            .bind(message_id)
            .fetch_all(db)
            .await?;
            (message_id.to_owned(), rows)
        }
        Some(thread_id) => {
            let rows = sqlx::query_scalar(
                "select to_jsonb(m) from mail_messages m
                 where m.thread_id = $1 and m.account_id = $2 and m.deleted_at is null
                 order by m.sent_date asc, m.id asc",
            )
            .bind(&thread_id)
            .bind(&account_id)
            .fetch_all(db)
            .await?;
            (thread_id, rows)
        }
    };
    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
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
pub async fn message_stats(db: &PgPool, account_ids: &[String]) -> Result<Value, sqlx::Error> {
    if account_ids.is_empty() {
        let zero: Map<String, Value> = STAT_KEYS
            .iter()
            .map(|k| ((*k).to_owned(), json!(0)))
            .collect();
        return Ok(Value::Object(zero));
    }
    let row: (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) = sqlx::query_as(concat!(
        "select count(*)::int,
           count(*) filter (where m.is_read = false)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"INBOX\"]'::jsonb and not ",
        in_trash_or_spam!(),
        " and m.is_read = false)::int,
           count(*) filter (where (coalesce(m.labels, '[]'::jsonb) @> '[\"STARRED\"]'::jsonb or m.is_starred = true) and not ",
        in_trash_or_spam!(),
        ")::int,
           count(*) filter (where (coalesce(m.labels, '[]'::jsonb) @> '[\"IMPORTANT\"]'::jsonb or m.is_important = true) and not ",
        in_trash_or_spam!(),
        " and m.is_read = false)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"SENT\"]'::jsonb and not ",
        in_trash_or_spam!(),
        " and m.is_read = false)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"ARCHIVE\"]'::jsonb and not ",
        in_trash_or_spam!(),
        " and m.is_read = false)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb and m.is_read = false)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb)::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"SNOOZED\"]'::jsonb and not ",
        in_trash_or_spam!(),
        ")::int,
           count(*) filter (where coalesce(m.labels, '[]'::jsonb) @> '[\"SCHEDULED\"]'::jsonb and m.send_status = 'scheduled' and not ",
        in_trash_or_spam!(),
        ")::int,
           (select count(*)::int from mail_drafts d where d.deleted_at is null and d.account_id = any($1::text[]))
         from mail_messages m
         where m.deleted_at is null and m.account_id = any($1::text[])"
    ))
    .bind(account_ids)
    .fetch_one(db)
    .await?;
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
pub async fn label_counts(
    db: &PgPool,
    account_id: &str,
    keys: &[String],
) -> Result<Map<String, Value>, sqlx::Error> {
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
        let rows: Vec<String> = sqlx::query_scalar(
            "select distinct name from mail_labels
             where account_id = $1 and deleted_at is null and lower(name) = any($2::text[])",
        )
        .bind(account_id)
        .bind(&custom_keys)
        .fetch_all(db)
        .await?;
        for name in rows {
            custom_names.entry(name.to_lowercase()).or_default().push(name);
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
    let counted: Vec<(i64, i32, i32, i32)> = sqlx::query_as(concat!(
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
    .bind(&kinds)
    .bind(&names)
    .bind(&starred)
    .bind(&important)
    .fetch_all(db)
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

/// `PostgresMailboxStore.stats()`: the counters plus the folder counts of
/// every system label and the mailbox's own labels.
pub async fn mailbox_stats(db: &PgPool, account_id: &str) -> Result<Value, sqlx::Error> {
    let mut base = message_stats(db, &[account_id.to_owned()]).await?;
    let custom: Vec<String> = sqlx::query_scalar(
        "select name from mail_labels
         where account_id = $1 and deleted_at is null and is_system is not true",
    )
    .bind(account_id)
    .fetch_all(db)
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
) -> Result<Vec<(String, String)>, sqlx::Error> {
    if ids.is_empty() || account_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as(
        "select id, account_id from mail_messages
         where id = any($1::text[]) and account_id = any($2::text[])
           and ($3 or deleted_at is null)",
    )
    .bind(ids)
    .bind(account_ids)
    .bind(include_deleted)
    .fetch_all(db)
    .await
}

/// The live ones among `ids` (`existingIds`), in row order.
pub async fn existing_ids(db: &PgPool, ids: &[String]) -> Result<Vec<String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_scalar("select id from mail_messages where id = any($1::text[]) and deleted_at is null")
        .bind(ids)
        .fetch_all(db)
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

/// `updateMessage(db, id, flags)`: the flags, with the labels they mirror
/// kept in step. `false` when the message is missing or deleted.
pub async fn update_message_flags(
    db: &PgPool,
    id: &str,
    patch: FlagPatch,
    now: OffsetDateTime,
) -> Result<bool, sqlx::Error> {
    let existing: Option<Option<Value>> = sqlx::query_scalar(
        "select labels from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
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
    sqlx::query(
        "update mail_messages set
           updated_at = $2::timestamp,
           is_read = coalesce($3, is_read),
           is_starred = case when $4::bool is null then is_starred else $4 end,
           is_flagged = case when $5::bool is null then is_flagged else $5 end,
           is_important = case when $6::bool is null then is_important else $6 end,
           is_spam = case when $7::bool is null then is_spam else $7 end,
           is_trash = case when $8::bool is null then is_trash else $8 end,
           labels = case when $9::jsonb is null then labels else $9 end
         where id = $1",
    )
    .bind(id)
    .bind(iso(now))
    .bind(patch.is_read)
    .bind(patch.is_starred)
    .bind(patch.is_flagged)
    .bind(patch.is_important)
    .bind(is_spam)
    .bind(is_trash)
    .bind(labels)
    .execute(db)
    .await?;
    Ok(true)
}

/// `updateMessage(db, id, { threadId })`.
pub async fn set_thread_id(
    db: &PgPool,
    id: &str,
    thread_id: &str,
    now: OffsetDateTime,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if found.is_none() {
        return Ok(false);
    }
    sqlx::query("update mail_messages set thread_id = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(thread_id)
        .bind(iso(now))
        .execute(db)
        .await?;
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
) -> Result<Option<Vec<String>>, sqlx::Error> {
    let account: Option<String> = sqlx::query_scalar(
        "select account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
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
    sqlx::query(
        "update mail_messages set labels = $2, is_starred = $3, is_important = $4,
           is_trash = $5, is_spam = $6, updated_at = $7::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(labels::labels_value(&next))
    .bind(has(STARRED))
    .bind(has(IMPORTANT))
    .bind(has(TRASH))
    .bind(has(SPAM))
    .bind(iso(now))
    .execute(db)
    .await?;
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
) -> Result<Option<Vec<String>>, sqlx::Error> {
    let existing: Option<(Option<Value>, String)> = sqlx::query_as(
        "select labels, account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
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
    sqlx::query(
        "update mail_messages set labels = $2,
           is_starred = case when $3::bool is null then is_starred else $3 end,
           is_important = case when $4::bool is null then is_important else $4 end,
           is_trash = case when $5::bool is null then is_trash else $5 end,
           is_spam = case when $6::bool is null then is_spam else $6 end,
           updated_at = $7::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(labels::labels_value(&next))
    .bind(flags.is_starred)
    .bind(flags.is_important)
    .bind(flags.is_trash)
    .bind(flags.is_spam)
    .bind(iso(now))
    .execute(db)
    .await?;
    Ok(Some(next))
}

/// `softDeleteMessage(db, id)`: `false` when missing.
pub async fn soft_delete_message(
    db: &PgPool,
    id: &str,
    now: OffsetDateTime,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if found.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "update mail_messages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(iso(now))
    .execute(db)
    .await?;
    Ok(true)
}

/// `applyBulkFlags(ids, patch)`'s writes on the live ids, in the order the
/// TypeScript store makes them.
pub async fn bulk_flags(
    db: &PgPool,
    ids: &[String],
    patch: FlagPatch,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    if ids.is_empty() {
        return Ok(());
    }
    if let Some(is_read) = patch.is_read {
        sqlx::query("update mail_messages set is_read = $2, updated_at = $3::timestamp where id = any($1::text[])")
            .bind(ids)
            .bind(is_read)
            .bind(iso(now))
            .execute(db)
            .await?;
    }
    if let Some(is_flagged) = patch.is_flagged {
        sqlx::query("update mail_messages set is_flagged = $2, updated_at = $3::timestamp where id = any($1::text[])")
            .bind(ids)
            .bind(is_flagged)
            .bind(iso(now))
            .execute(db)
            .await?;
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
pub async fn final_labels(db: &PgPool, ids: &[String]) -> Result<Vec<(String, Vec<String>)>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<Value>)> =
        sqlx::query_as("select id, labels from mail_messages where id = any($1::text[])")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, labels)| (id, labels_of(labels.as_ref())))
        .collect())
}
