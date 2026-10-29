//! Gmail-like labels (`@weldsuite/mail-domain/labels` and the pure rules of
//! `./store/model`): the system-label vocabulary, how a label change moves a
//! message, and the label rows of `mail_labels` with their bulk apply and
//! unapply against `mail_messages.labels`.
//!
//! System labels are stored upper-case (`INBOX`, `SENT`, …); a user label
//! keeps its casing. A message sits in at most one location (`INBOX`,
//! `ARCHIVE`, `TRASH`, `SPAM`): adding one replaces the previous one.

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::js_row;
use weldsuite_kit::generate_id;

/// `now.toISOString()`.
fn iso(now: OffsetDateTime) -> String {
    let ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    crate::outbound::clock::iso(ms)
}

pub const INBOX: &str = "INBOX";
pub const SENT: &str = "SENT";
pub const TRASH: &str = "TRASH";
pub const SPAM: &str = "SPAM";
pub const STARRED: &str = "STARRED";
pub const IMPORTANT: &str = "IMPORTANT";
pub const ARCHIVE: &str = "ARCHIVE";
pub const SNOOZED: &str = "SNOOZED";
pub const SCHEDULED: &str = "SCHEDULED";

/// `SYSTEM_LABELS`, in declaration order (`Object.values(SYSTEM_LABELS)`).
pub const SYSTEM_LABELS: [&str; 13] = [
    "INBOX",
    "SENT",
    "DRAFT",
    "DRAFTS",
    "TRASH",
    "SPAM",
    "STARRED",
    "IMPORTANT",
    "ARCHIVE",
    "SNOOZED",
    "SCHEDULED",
    "PROMOTIONS",
    "PINNED",
];

/// `LOCATION_LABELS`.
pub const LOCATION_LABELS: [&str; 4] = ["INBOX", "ARCHIVE", "TRASH", "SPAM"];

/// `CLEARED_BY_MOVE`: the other locations, the promotions tab and a pending
/// snooze.
pub const CLEARED_BY_MOVE: [&str; 6] =
    ["INBOX", "ARCHIVE", "TRASH", "SPAM", "PROMOTIONS", "SNOOZED"];

/// `OUTGOING_LABELS`: a restore never puts these in the inbox.
pub const OUTGOING_LABELS: [&str; 4] = ["SENT", "DRAFT", "DRAFTS", "SCHEDULED"];

/// `toSystemLabel(slug)`: the system label a slug names, any casing.
pub fn to_system_label(slug: &str) -> Option<&'static str> {
    let lower = slug.to_lowercase();
    SYSTEM_LABELS
        .iter()
        .find(|label| label.to_lowercase() == lower)
        .copied()
}

/// `isSystemLabelSlug(slug)`.
pub fn is_system_label_slug(slug: &str) -> bool {
    to_system_label(slug).is_some()
}

/// `normalizeLabel(label)`: system slugs upper-cased, user labels as typed.
pub fn normalize_label(label: &str) -> String {
    to_system_label(label).map_or_else(|| label.to_owned(), str::to_owned)
}

/// `isLocationLabel(label)`.
pub fn is_location_label(label: &str) -> bool {
    LOCATION_LABELS.contains(&label)
}

/// `addLabels(existing, ...labels)`: normalised, no duplicates, a location
/// replacing the previous one.
pub fn add_labels(existing: &[String], labels: &[String]) -> Vec<String> {
    let mut next: Vec<String> = Vec::with_capacity(existing.len() + labels.len());
    for label in existing {
        if !next.contains(label) {
            next.push(label.clone());
        }
    }
    for raw in labels {
        let label = normalize_label(raw);
        if is_location_label(&label) {
            next.retain(|l| !CLEARED_BY_MOVE.contains(&l.as_str()));
        }
        if !next.contains(&label) {
            next.push(label);
        }
    }
    next
}

/// `removeLabels(existing, ...labels)`.
pub fn remove_labels(existing: &[String], labels: &[String]) -> Vec<String> {
    let remove: Vec<String> = labels.iter().map(|l| normalize_label(l)).collect();
    existing
        .iter()
        .filter(|l| !remove.contains(l))
        .cloned()
        .collect()
}

/// The flag columns that mirror a system label (`LabelFlags`); `None` is
/// left alone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LabelFlags {
    pub is_starred: Option<bool>,
    pub is_important: Option<bool>,
    pub is_trash: Option<bool>,
    pub is_spam: Option<bool>,
}

/// `flagsForLabelChange(labels, action)`.
pub fn flags_for_label_change(labels: &[String], add: bool) -> LabelFlags {
    let mut flags = LabelFlags::default();
    for raw in labels {
        let label = normalize_label(raw);
        if label == STARRED {
            flags.is_starred = Some(add);
        } else if label == IMPORTANT {
            flags.is_important = Some(add);
        } else if add && is_location_label(&label) {
            flags.is_trash = Some(label == TRASH);
            flags.is_spam = Some(label == SPAM);
        } else if label == TRASH {
            flags.is_trash = Some(false);
        } else if label == SPAM {
            flags.is_spam = Some(false);
        }
    }
    flags
}

/// `leaveLocation(labels, location)`: back to the inbox unless the mail
/// already sits somewhere else.
pub fn leave_location(labels: &[String], location: &str) -> Vec<String> {
    let next = remove_labels(labels, &[location.to_owned()]);
    let elsewhere = [TRASH, SPAM, ARCHIVE]
        .iter()
        .any(|l| next.iter().any(|n| n == l));
    if elsewhere {
        next
    } else {
        add_labels(&next, &[INBOX.to_owned()])
    }
}

/// The mirrored flags of a single-message patch (`FlagPatchInput`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlagPatchInput {
    pub is_starred: Option<bool>,
    pub is_important: Option<bool>,
    pub is_spam: Option<bool>,
    pub is_trash: Option<bool>,
}

/// What `labelsForFlagPatch` returns: the labels, and the flags a move
/// implies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlagPatchLabels {
    pub labels: Vec<String>,
    pub is_trash: Option<bool>,
    pub is_spam: Option<bool>,
}

/// `labelsForFlagPatch(existing, data)`: `None` when the patch sets none of
/// the mirrored flags.
pub fn labels_for_flag_patch(existing: &[String], data: FlagPatchInput) -> Option<FlagPatchLabels> {
    if data.is_starred.is_none()
        && data.is_important.is_none()
        && data.is_spam.is_none()
        && data.is_trash.is_none()
    {
        return None;
    }
    let mut labels = existing.to_vec();
    let toggle = |labels: Vec<String>, value: Option<bool>, label: &str| match value {
        Some(true) => add_labels(&labels, &[label.to_owned()]),
        Some(false) => remove_labels(&labels, &[label.to_owned()]),
        None => labels,
    };
    labels = toggle(labels, data.is_starred, STARRED);
    labels = toggle(labels, data.is_important, IMPORTANT);
    match data.is_spam {
        Some(true) => labels = add_labels(&labels, &[SPAM.to_owned()]),
        Some(false) => labels = leave_location(&labels, SPAM),
        None => {}
    }
    match data.is_trash {
        Some(true) => labels = add_labels(&labels, &[TRASH.to_owned()]),
        Some(false) => labels = leave_location(&labels, TRASH),
        None => {}
    }
    let moved = data.is_spam.is_some() || data.is_trash.is_some();
    let (is_trash, is_spam) = if moved {
        (
            Some(labels.iter().any(|l| l == TRASH)),
            Some(labels.iter().any(|l| l == SPAM)),
        )
    } else {
        (None, None)
    };
    Some(FlagPatchLabels {
        labels,
        is_trash,
        is_spam,
    })
}

/// `labelFolderHidesArchived(slug)`: a user label's folder leaves out
/// archived mail.
pub fn label_folder_hides_archived(slug: &str) -> bool {
    slug.to_lowercase() != "all" && to_system_label(slug).is_none()
}

/// A JSON labels column as a list of strings (non-strings dropped, as no
/// write path stores them).
pub fn labels_of(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// `labelCondition(slug, customNames)` as the SQL parameters the queries in
/// this crate take: the names a message's labels are matched against, and
/// whether starred / important also match on the flag column.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LabelMatch {
    pub names: Vec<String>,
    pub starred: bool,
    pub important: bool,
}

impl LabelMatch {
    pub fn new(slug: &str, custom_names: &[String]) -> Self {
        match to_system_label(slug) {
            Some(STARRED) => Self {
                names: vec![STARRED.to_owned()],
                starred: true,
                important: false,
            },
            Some(IMPORTANT) => Self {
                names: vec![IMPORTANT.to_owned()],
                starred: false,
                important: true,
            },
            Some(system) => Self {
                names: vec![system.to_owned()],
                starred: false,
                important: false,
            },
            None => {
                let mut names = vec![slug.to_owned()];
                for name in custom_names {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
                Self {
                    names,
                    starred: false,
                    important: false,
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Label names
// ---------------------------------------------------------------------------

/// `resolveCustomLabelNames(db, slug, accountId)`: the stored names a
/// non-system slug stands for, matched case-insensitively.
pub async fn resolve_custom_label_names(
    db: &PgPool,
    slug: &str,
    account_id: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    if to_system_label(slug).is_some() {
        return Ok(Vec::new());
    }
    sqlx::query_scalar(
        "select distinct name from mail_labels
         where deleted_at is null and lower(name) = lower($1)
           and ($2::text is null or account_id = $2)",
    )
    .bind(slug)
    .bind(account_id)
    .fetch_all(db)
    .await
}

/// `canonicalLabelNames(db, accountId, labels)`: user labels spelled as the
/// account's label row spells them.
pub async fn canonical_label_names(
    db: &PgPool,
    account_id: &str,
    labels: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let custom: Vec<String> = labels
        .iter()
        .filter(|l| to_system_label(l).is_none())
        .map(|l| l.to_lowercase())
        .collect();
    if custom.is_empty() {
        return Ok(labels.to_vec());
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "select name from mail_labels
         where account_id = $1 and deleted_at is null and is_system is not true
           and lower(name) = any($2::text[])",
    )
    .bind(account_id)
    .bind(&custom)
    .fetch_all(db)
    .await?;
    // `new Map(rows.map(...))`: a later row wins a shared lower-case key.
    let mut by_lower: Vec<(String, String)> = Vec::new();
    for name in rows {
        let lower = name.to_lowercase();
        if let Some(entry) = by_lower.iter_mut().find(|(l, _)| *l == lower) {
            entry.1 = name;
        } else {
            by_lower.push((lower, name));
        }
    }
    Ok(labels
        .iter()
        .map(|l| {
            if to_system_label(l).is_some() {
                return l.clone();
            }
            let lower = l.to_lowercase();
            by_lower
                .iter()
                .find(|(k, _)| *k == lower)
                .map_or_else(|| l.clone(), |(_, name)| name.clone())
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Label rows (`mail_labels`)
// ---------------------------------------------------------------------------

/// `MailLabelError`.
#[derive(Debug)]
pub enum MailLabelError {
    DuplicateName(&'static str),
    NotFound,
    SystemLabelImmutable(&'static str),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for MailLabelError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

const RESERVED_NAME: &str = "This name is reserved for a system folder";
const DUPLICATE_NAME: &str = "A label with this name already exists on this account";

/// What a label row is matched by on messages: a system label's slug,
/// otherwise its name (`labelRowKey`).
fn label_row_key(row: &Value) -> String {
    let is_system = row["isSystem"].as_bool().unwrap_or(false);
    match row["slug"].as_str() {
        Some(slug) if is_system && !slug.is_empty() => slug.to_owned(),
        _ => row["name"].as_str().unwrap_or_default().to_owned(),
    }
}

/// `withLiveMessageCounts(db, rows)`: each row's `messageCount` replaced by
/// the live messages carrying the label, counted as its folder lists them.
async fn with_live_message_counts(
    db: &PgPool,
    rows: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let mut account_ids: Vec<String> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for row in &rows {
        let account = row["accountId"].as_str().unwrap_or_default().to_owned();
        if !account_ids.contains(&account) {
            account_ids.push(account);
        }
        let key = label_row_key(row);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let mut names: Vec<Value> = Vec::with_capacity(keys.len());
    let mut starred = Vec::with_capacity(keys.len());
    let mut important = Vec::with_capacity(keys.len());
    let mut everywhere = Vec::with_capacity(keys.len());
    let mut hides_archived = Vec::with_capacity(keys.len());
    for key in &keys {
        let matches = LabelMatch::new(key, &[]);
        names.push(json!(matches.names));
        starred.push(matches.starred);
        important.push(matches.important);
        let system = to_system_label(key);
        everywhere.push(matches!(system, Some(TRASH | SPAM)));
        hides_archived.push(label_folder_hides_archived(key));
    }
    let counted: Vec<(String, i64, i32)> = sqlx::query_as(
        "select m.account_id, k.ord, (count(*) filter (where
             (exists (select 1 from jsonb_array_elements_text(k.names) as n(name)
                      where m.labels @> jsonb_build_array(n.name))
              or (k.starred and m.is_starred = true)
              or (k.important and m.is_important = true))
             and (k.everywhere or not (coalesce(m.labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb
                  or coalesce(m.labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb
                  or coalesce(m.is_trash, false) or coalesce(m.is_spam, false)))
             and (not k.hides_archived or not coalesce(m.labels, '[]'::jsonb) @> '[\"ARCHIVE\"]'::jsonb)
           ))::int
         from mail_messages m
         cross join unnest($2::jsonb[], $3::bool[], $4::bool[], $5::bool[], $6::bool[])
              with ordinality as k(names, starred, important, everywhere, hides_archived, ord)
         where m.deleted_at is null and m.account_id = any($1::text[])
         group by m.account_id, k.ord",
    )
    .bind(&account_ids)
    .bind(&names)
    .bind(&starred)
    .bind(&important)
    .bind(&everywhere)
    .bind(&hides_archived)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let account = row["accountId"].as_str().unwrap_or_default().to_owned();
            let key = label_row_key(&row);
            let ord = keys.iter().position(|k| *k == key).unwrap_or_default() + 1;
            let count = counted
                .iter()
                .find(|(a, o, _)| *a == account && usize::try_from(*o).ok() == Some(ord))
                .map_or(0, |(_, _, c)| *c);
            row["messageCount"] = json!(count);
            row
        })
        .collect())
}

/// `listMailLabels(db, filters)`: one account's labels, or those of the
/// accounts in `accessible` (an empty list is no account).
pub async fn list_mail_labels(
    db: &PgPool,
    account_id: Option<&str>,
    accessible: Option<&[String]>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from mail_labels l
         where l.deleted_at is null
           and ($1::text is null or l.account_id = $1)
           and ($2::text[] is null or l.account_id = any($2))",
    )
    .bind(account_id)
    .bind(accessible)
    .fetch_all(db)
    .await?;
    with_live_message_counts(db, rows.into_iter().map(js_row).collect()).await
}

async fn label_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from mail_labels l where l.id = $1 and l.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `getMailLabel(db, id)`.
pub async fn get_mail_label(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = label_row(db, id).await? else {
        return Ok(None);
    };
    let mut counted = with_live_message_counts(db, vec![row]).await?;
    Ok(counted.pop())
}

/// `CreateMailLabelInput`.
#[derive(Debug, Clone, Default)]
pub struct CreateMailLabel {
    pub account_id: String,
    pub name: String,
    pub color: Option<String>,
    pub ai_enabled: Option<bool>,
    pub ai_keywords: Option<Vec<String>>,
    pub ai_description: Option<String>,
    pub ai_confidence: Option<i64>,
}

fn assert_not_reserved_name(name: &str) -> Result<(), MailLabelError> {
    if is_system_label_slug(crate::text::js_trim(name)) {
        return Err(MailLabelError::DuplicateName(RESERVED_NAME));
    }
    Ok(())
}

/// `createMailLabel(db, data)`.
pub async fn create_mail_label(
    db: &PgPool,
    data: &CreateMailLabel,
    now: OffsetDateTime,
) -> Result<Value, MailLabelError> {
    assert_not_reserved_name(&data.name)?;
    let existing: Option<String> = sqlx::query_scalar(
        "select id from mail_labels
         where account_id = $1 and lower(name) = lower($2) and deleted_at is null limit 1",
    )
    .bind(&data.account_id)
    .bind(&data.name)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Err(MailLabelError::DuplicateName(DUPLICATE_NAME));
    }
    let id = generate_id("label");
    let at = iso(now);
    sqlx::query(
        "insert into mail_labels (id, account_id, name, color, message_count, ai_enabled,
             ai_keywords, ai_description, ai_confidence, created_at, updated_at)
         values ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9::timestamp, $9::timestamp)",
    )
    .bind(&id)
    .bind(&data.account_id)
    .bind(&data.name)
    .bind(data.color.as_deref())
    .bind(data.ai_enabled.unwrap_or(false))
    .bind(data.ai_keywords.as_ref().map(|k| json!(k)))
    .bind(data.ai_description.as_deref())
    .bind(data.ai_confidence.unwrap_or(70))
    .bind(&at)
    .execute(db)
    .await?;
    let row: Value = sqlx::query_scalar("select to_jsonb(l) from mail_labels l where l.id = $1")
        .bind(&id)
        .fetch_one(db)
        .await?;
    Ok(js_row(row))
}

/// `UpdateMailLabelInput`: `None` is left out of the patch.
#[derive(Debug, Clone, Default)]
pub struct UpdateMailLabel {
    pub name: Option<String>,
    pub color: Option<String>,
    pub position: Option<i64>,
    pub ai_enabled: Option<bool>,
    pub ai_keywords: Option<Vec<String>>,
    pub ai_description: Option<String>,
    pub ai_confidence: Option<i64>,
}

impl UpdateMailLabel {
    /// Any field but `position` set.
    fn touches_immutable(&self) -> bool {
        self.name.is_some()
            || self.color.is_some()
            || self.ai_enabled.is_some()
            || self.ai_keywords.is_some()
            || self.ai_description.is_some()
            || self.ai_confidence.is_some()
    }
}

/// `updateMailLabel(db, id, data)`: `(before, after)`. A rename relabels
/// the messages carrying the old name in the same transaction.
pub async fn update_mail_label(
    db: &PgPool,
    id: &str,
    data: &UpdateMailLabel,
    now: OffsetDateTime,
) -> Result<(Value, Value), MailLabelError> {
    let Some(existing) = label_row(db, id).await? else {
        return Err(MailLabelError::NotFound);
    };
    if existing["isSystem"].as_bool().unwrap_or(false) && data.touches_immutable() {
        return Err(MailLabelError::SystemLabelImmutable(
            "System labels cannot be renamed or recoloured; only `position` may change.",
        ));
    }
    let old_name = existing["name"].as_str().unwrap_or_default().to_owned();
    let account_id = existing["accountId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // `data.name && data.name !== existing.name`.
    let new_name = data
        .name
        .as_deref()
        .filter(|n| !n.is_empty() && *n != old_name)
        .map(str::to_owned);
    if let Some(name) = &new_name {
        assert_not_reserved_name(name)?;
        let collision: Option<String> = sqlx::query_scalar(
            "select id from mail_labels
             where account_id = $1 and lower(name) = lower($2) and deleted_at is null and id != $3
             limit 1",
        )
        .bind(&account_id)
        .bind(name)
        .bind(id)
        .fetch_optional(db)
        .await?;
        if collision.is_some() {
            return Err(MailLabelError::DuplicateName(DUPLICATE_NAME));
        }
    }
    let at = iso(now);
    let mut tx = db.begin().await?;
    sqlx::query(
        "update mail_labels set
             name = coalesce($2, name),
             color = coalesce($3, color),
             position = coalesce($4, position),
             ai_enabled = coalesce($5, ai_enabled),
             ai_keywords = case when $6::jsonb is null then ai_keywords else $6::jsonb end,
             ai_description = coalesce($7, ai_description),
             ai_confidence = coalesce($8, ai_confidence),
             updated_at = $9::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(data.name.as_deref())
    .bind(data.color.as_deref())
    .bind(data.position.and_then(|p| i32::try_from(p).ok()))
    .bind(data.ai_enabled)
    .bind(data.ai_keywords.as_ref().map(|k| json!(k)))
    .bind(data.ai_description.as_deref())
    .bind(data.ai_confidence.and_then(|c| i32::try_from(c).ok()))
    .bind(&at)
    .execute(&mut *tx)
    .await?;
    if let Some(name) = &new_name {
        relabel_messages_in(&mut *tx, &account_id, &old_name, name, &at).await?;
    }
    tx.commit().await?;
    let after: Value = sqlx::query_scalar("select to_jsonb(l) from mail_labels l where l.id = $1")
        .bind(id)
        .fetch_one(db)
        .await?;
    let mut counted = with_live_message_counts(db, vec![js_row(after)]).await?;
    let after = counted.pop().unwrap_or(Value::Null);
    Ok((existing, after))
}

/// `deleteMailLabel(db, id)`: the row before the delete; `None` when there
/// was no live label.
pub async fn delete_mail_label(
    db: &PgPool,
    id: &str,
    now: OffsetDateTime,
) -> Result<Option<Value>, MailLabelError> {
    let Some(existing) = label_row(db, id).await? else {
        return Ok(None);
    };
    if existing["isSystem"].as_bool().unwrap_or(false) {
        return Err(MailLabelError::SystemLabelImmutable(
            "System labels cannot be deleted",
        ));
    }
    let at = iso(now);
    sqlx::query(
        "update mail_labels set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&at)
    .execute(db)
    .await?;
    let account_id = existing["accountId"].as_str().unwrap_or_default();
    let name = existing["name"].as_str().unwrap_or_default();
    strip_label_from_messages(db, account_id, name, now).await?;
    Ok(Some(existing))
}

// ---------------------------------------------------------------------------
// Bulk apply / unapply against `mail_messages.labels`
// ---------------------------------------------------------------------------

/// What a bulk label write touched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Touched {
    pub ids: Vec<String>,
    pub account_ids: Vec<String>,
}

fn touched(rows: Vec<(String, String)>) -> Touched {
    let mut out = Touched::default();
    for (id, account) in rows {
        out.ids.push(id);
        if !out.account_ids.contains(&account) {
            out.account_ids.push(account);
        }
    }
    out
}

/// `moveMessagesToLocation(db, ids, location)`: one statement; the other
/// locations (and promotions, snooze) dropped, `is_trash` / `is_spam`
/// following. Back to the inbox, outgoing mail keeps its place.
pub async fn move_messages_to_location(
    db: &PgPool,
    ids: &[String],
    location: &str,
    now: OffsetDateTime,
) -> Result<Touched, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "with c as (
             select id, (coalesce(labels, '[]'::jsonb) - $4::text[]) as cleared
             from mail_messages where id = any($1::text[]) and deleted_at is null
         )
         update mail_messages m set
             labels = case
                 when $2 = 'INBOX' and (c.cleared @> '[\"SENT\"]'::jsonb or c.cleared @> '[\"DRAFT\"]'::jsonb
                      or c.cleared @> '[\"DRAFTS\"]'::jsonb or c.cleared @> '[\"SCHEDULED\"]'::jsonb)
                 then c.cleared
                 else c.cleared || jsonb_build_array($2::text)
             end,
             is_trash = ($2 = 'TRASH'),
             is_spam = ($2 = 'SPAM'),
             snoozed_until = null,
             updated_at = $3::timestamp
         from c
         where m.id = c.id
         returning m.id, m.account_id",
    )
    .bind(ids)
    .bind(location)
    .bind(iso(now))
    .bind(CLEARED_BY_MOVE.as_slice())
    .fetch_all(db)
    .await?;
    Ok(touched(rows))
}

/// `updateLabelMessageCount`: the running tally on the label rows.
async fn update_label_message_count(
    db: &PgPool,
    label: &str,
    account_ids: &[String],
    delta: i64,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    if account_ids.is_empty() || delta == 0 {
        return Ok(());
    }
    sqlx::query(
        "update mail_labels
         set message_count = greatest(0, message_count + $1), updated_at = $2::timestamp
         where name = $3 and account_id = any($4::text[]) and deleted_at is null",
    )
    .bind(delta)
    .bind(iso(now))
    .bind(label)
    .bind(account_ids)
    .execute(db)
    .await?;
    Ok(())
}

/// `bulkAddLabelToMessages(db, label, ids)`: appended where missing, the
/// mirrored flag written with it; a location is a move.
pub async fn bulk_add_label(
    db: &PgPool,
    label_name: &str,
    ids: &[String],
    now: OffsetDateTime,
) -> Result<Touched, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    let label = normalize_label(label_name);
    if is_location_label(&label) {
        return move_messages_to_location(db, ids, &label, now).await;
    }
    let flags = flags_for_label_change(std::slice::from_ref(&label), true);
    let rows: Vec<(String, String)> = sqlx::query_as(
        "update mail_messages set
             labels = coalesce(labels, '[]'::jsonb) || jsonb_build_array($2::text),
             is_starred = coalesce($3, is_starred),
             is_important = coalesce($4, is_important),
             is_trash = coalesce($5, is_trash),
             is_spam = coalesce($6, is_spam),
             updated_at = $7::timestamp
         where id = any($1::text[]) and deleted_at is null
           and not coalesce(labels, '[]'::jsonb) @> jsonb_build_array($2::text)
         returning id, account_id",
    )
    .bind(ids)
    .bind(&label)
    .bind(flags.is_starred)
    .bind(flags.is_important)
    .bind(flags.is_trash)
    .bind(flags.is_spam)
    .bind(iso(now))
    .fetch_all(db)
    .await?;
    let touched = touched(rows);
    let delta = i64::try_from(touched.ids.len()).unwrap_or(i64::MAX);
    update_label_message_count(db, &label, &touched.account_ids, delta, now).await?;
    Ok(touched)
}

/// `bulkRemoveLabelFromMessages(db, label, ids)`.
pub async fn bulk_remove_label(
    db: &PgPool,
    label_name: &str,
    ids: &[String],
    now: OffsetDateTime,
) -> Result<Touched, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    let label = normalize_label(label_name);
    let flags = flags_for_label_change(std::slice::from_ref(&label), false);
    // Starred / important may live on the column alone.
    let flag_column = if label == STARRED {
        "starred"
    } else if label == IMPORTANT {
        "important"
    } else {
        ""
    };
    let rows: Vec<(String, String)> = sqlx::query_as(
        "update mail_messages set
             labels = coalesce(labels, '[]'::jsonb) - $2::text,
             is_starred = coalesce($3, is_starred),
             is_important = coalesce($4, is_important),
             is_trash = coalesce($5, is_trash),
             is_spam = coalesce($6, is_spam),
             updated_at = $7::timestamp
         where id = any($1::text[]) and deleted_at is null
           and (coalesce(labels, '[]'::jsonb) @> jsonb_build_array($2::text)
                or ($8 = 'starred' and is_starred = true)
                or ($8 = 'important' and is_important = true))
         returning id, account_id",
    )
    .bind(ids)
    .bind(&label)
    .bind(flags.is_starred)
    .bind(flags.is_important)
    .bind(flags.is_trash)
    .bind(flags.is_spam)
    .bind(iso(now))
    .bind(flag_column)
    .fetch_all(db)
    .await?;
    let touched = touched(rows);
    let delta = -i64::try_from(touched.ids.len()).unwrap_or(i64::MAX);
    update_label_message_count(db, &label, &touched.account_ids, delta, now).await?;
    Ok(touched)
}

/// `applyLabelToThread(db, accountId, threadKey, label, action)`: the ids
/// whose labels changed.
pub async fn apply_label_to_thread(
    db: &PgPool,
    account_id: &str,
    thread_key: &str,
    label: &str,
    add: bool,
    now: OffsetDateTime,
) -> Result<Vec<String>, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select id from mail_messages
         where account_id = $1 and coalesce(thread_id, id) = $2 and deleted_at is null",
    )
    .bind(account_id)
    .bind(thread_key)
    .fetch_all(db)
    .await?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let result = if add {
        bulk_add_label(db, label, &ids, now).await?
    } else {
        bulk_remove_label(db, label, &ids, now).await?
    };
    Ok(result.ids)
}

async fn relabel_messages_in<'e, E>(
    executor: E,
    account_id: &str,
    from: &str,
    to: &str,
    at: &str,
) -> Result<(), sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query(
        "update mail_messages set
             labels = (
                 select jsonb_agg(case when jsonb_typeof(value) = 'string'
                          and lower(value #>> '{}') = lower($2::text)
                        then to_jsonb($3::text) else value end)
                 from jsonb_array_elements(labels)
             ),
             updated_at = $4::timestamp
         where account_id = $1
           and exists (select 1 from jsonb_array_elements_text(coalesce(labels, '[]'::jsonb)) as carried(name)
                       where lower(carried.name) = lower($2::text))
           and deleted_at is null",
    )
    .bind(account_id)
    .bind(from)
    .bind(to)
    .bind(at)
    .execute(executor)
    .await?;
    Ok(())
}

/// `stripLabelFromMessages(db, accountId, name)`: the label removed from
/// every message carrying it, in any casing.
pub async fn strip_label_from_messages(
    db: &PgPool,
    account_id: &str,
    name: &str,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update mail_messages set
             labels = (
                 select coalesce(jsonb_agg(value), '[]'::jsonb)
                 from jsonb_array_elements(labels) as value
                 where not (jsonb_typeof(value) = 'string' and lower(value #>> '{}') = lower($2::text))
             ),
             updated_at = $3::timestamp
         where account_id = $1
           and exists (select 1 from jsonb_array_elements_text(coalesce(labels, '[]'::jsonb)) as carried(name)
                       where lower(carried.name) = lower($2::text))
           and deleted_at is null",
    )
    .bind(account_id)
    .bind(name)
    .bind(iso(now))
    .execute(db)
    .await?;
    Ok(())
}

/// A row's labels as an object field, for patches built in Rust.
pub fn labels_value(labels: &[String]) -> Value {
    Value::Array(labels.iter().cloned().map(Value::String).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| (*i).to_owned()).collect()
    }

    #[test]
    fn locations_replace_each_other() {
        assert_eq!(
            add_labels(&s(&["INBOX", "Work", "SNOOZED"]), &s(&["trash"])),
            s(&["Work", "TRASH"])
        );
        assert_eq!(
            add_labels(&s(&["INBOX"]), &s(&["starred"])),
            s(&["INBOX", "STARRED"])
        );
        assert_eq!(
            remove_labels(&s(&["INBOX", "STARRED"]), &s(&["starred"])),
            s(&["INBOX"])
        );
    }

    #[test]
    fn flag_patches_move_the_message() {
        let out = labels_for_flag_patch(
            &s(&["TRASH"]),
            FlagPatchInput {
                is_trash: Some(false),
                ..FlagPatchInput::default()
            },
        )
        .expect("a mirrored flag");
        assert_eq!(out.labels, s(&["INBOX"]));
        assert_eq!(out.is_trash, Some(false));
        assert!(labels_for_flag_patch(&s(&["INBOX"]), FlagPatchInput::default()).is_none());
        let flags = flags_for_label_change(&s(&["spam"]), true);
        assert_eq!(flags.is_spam, Some(true));
        assert_eq!(flags.is_trash, Some(false));
    }

    #[test]
    fn label_matches_follow_label_condition() {
        assert_eq!(
            LabelMatch::new("starred", &[]),
            LabelMatch {
                names: s(&["STARRED"]),
                starred: true,
                important: false
            }
        );
        assert_eq!(
            LabelMatch::new("invoices", &s(&["Invoices", "invoices"])).names,
            s(&["invoices", "Invoices"])
        );
        assert!(label_folder_hides_archived("Work"));
        assert!(!label_folder_hides_archived("inbox"));
        assert!(!label_folder_hides_archived("all"));
    }
}
