//! Gmail-like labels (`@weldsuite/mail-domain/labels` and the pure rules of
//! `./store/model`): the system-label vocabulary, how a label change moves a
//! message, and the label rows of `mail_labels` with their bulk apply and
//! unapply against `mail_messages.labels`.
//!
//! System labels are stored upper-case (`INBOX`, `SENT`, …); a user label
//! keeps its casing. A message sits in at most one location (`INBOX`,
//! `ARCHIVE`, `TRASH`, `SPAM`): adding one replaces the previous one.

use sea_orm::sea_query::{Expr, Func, Query, UpdateStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter,
    QuerySelect, QueryTrait,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{OrmConn, orm, orm_error, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{mail_labels, mail_messages};

/// A `mail_messages` column, qualified by its table.
pub(crate) fn msg(column: mail_messages::Column) -> Expr {
    Expr::col((mail_messages::Entity, column))
}

/// `coalesce(labels, '[]'::jsonb)`.
pub(crate) fn labels_or_empty() -> Expr {
    Func::coalesce([msg(mail_messages::Column::Labels), Expr::val(json!([]))]).into()
}

/// `coalesce(labels, '[]'::jsonb) @> '["LABEL"]'::jsonb`: the message carries
/// the label.
pub(crate) fn carries(label: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::contains(
        labels_or_empty(),
        Expr::val(json!([label])),
    )
}

/// `lower(column)`.
pub(crate) fn lower(column: Expr) -> Expr {
    Func::lower(column).into()
}

/// A `mail_labels` row as Drizzle returns it.
fn label_json(row: mail_labels::Model) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
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

impl LabelMatch {
    /// `labelCondition(slug, customNames)` over `mail_messages`: the message
    /// carries one of the names (`labels @> jsonb_build_array(name)`), or the
    /// flag column says starred / important.
    pub(crate) fn condition(&self) -> Condition {
        use mail_messages::Column;
        let mut matched = Condition::any();
        for name in &self.names {
            matched = matched.add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
                msg(Column::Labels),
                Expr::val(json!([name])),
            ));
        }
        if self.starred {
            matched = matched.add(Column::IsStarred.eq(true));
        }
        if self.important {
            matched = matched.add(Column::IsImportant.eq(true));
        }
        matched
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
) -> Result<Vec<String>, DbErr> {
    use mail_labels::Column;
    use sea_orm::ExprTrait as _;
    if to_system_label(slug).is_some() {
        return Ok(Vec::new());
    }
    let mut find = mail_labels::Entity::find()
        .select_only()
        .column(Column::Name)
        .distinct()
        .filter(Column::DeletedAt.is_null())
        .filter(lower(Expr::col((mail_labels::Entity, Column::Name))).eq(lower(Expr::val(slug))));
    if let Some(account_id) = account_id {
        find = find.filter(Column::AccountId.eq(account_id));
    }
    find.into_tuple().all(&orm(db)).await
}

/// `canonicalLabelNames(db, accountId, labels)`: user labels spelled as the
/// account's label row spells them.
pub async fn canonical_label_names(
    db: &PgPool,
    account_id: &str,
    labels: &[String],
) -> Result<Vec<String>, DbErr> {
    use mail_labels::Column;
    let custom: Vec<String> = labels
        .iter()
        .filter(|l| to_system_label(l).is_none())
        .map(|l| l.to_lowercase())
        .collect();
    if custom.is_empty() {
        return Ok(labels.to_vec());
    }
    let rows: Vec<String> = mail_labels::Entity::find()
        .select_only()
        .column(Column::Name)
        .filter(Column::AccountId.eq(account_id))
        .filter(Column::DeletedAt.is_null())
        .filter(is_not_system())
        .filter(sea_orm::ExprTrait::is_in(
            lower(Expr::col((mail_labels::Entity, Column::Name))),
            custom,
        ))
        .into_tuple()
        .all(&orm(db))
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

/// `is_system is not true`: a user label.
pub(crate) fn is_not_system() -> Expr {
    sea_orm::ExprTrait::is_not(
        Expr::col((mail_labels::Entity, mail_labels::Column::IsSystem)),
        Expr::Constant(true.into()),
    )
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
    Db(DbErr),
}

impl From<DbErr> for MailLabelError {
    fn from(error: DbErr) -> Self {
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
async fn with_live_message_counts(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, DbErr> {
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
    let counted = live_label_counts(
        db,
        &account_ids,
        &LabelKeys {
            names,
            starred,
            important,
            everywhere,
            hides_archived,
        },
    )
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

/// The label keys [`live_label_counts`] counts, as parallel arrays.
struct LabelKeys {
    names: Vec<Value>,
    starred: Vec<bool>,
    important: Vec<bool>,
    everywhere: Vec<bool>,
    hides_archived: Vec<bool>,
}

/// `(account_id, key ordinal, live messages)` for every key in every
/// account, in one pass over the accounts' messages.
#[allow(
    clippy::disallowed_methods,
    reason = "counts every label key in one pass: the keys are parallel arrays unnested with ordinality and matched against each message's labels, which the query builder can't express"
)]
async fn live_label_counts(
    db: &PgPool,
    account_ids: &[String],
    keys: &LabelKeys,
) -> Result<Vec<(String, i64, i32)>, DbErr> {
    sqlx::query_as(
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
    .bind(account_ids)
    .bind(&keys.names)
    .bind(&keys.starred)
    .bind(&keys.important)
    .bind(&keys.everywhere)
    .bind(&keys.hides_archived)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// `listMailLabels(db, filters)`: one account's labels, or those of the
/// accounts in `accessible` (an empty list is no account).
pub async fn list_mail_labels(
    db: &PgPool,
    account_id: Option<&str>,
    accessible: Option<&[String]>,
) -> Result<Vec<Value>, DbErr> {
    use mail_labels::Column;
    let mut find = mail_labels::Entity::find().filter(Column::DeletedAt.is_null());
    if let Some(account_id) = account_id {
        find = find.filter(Column::AccountId.eq(account_id));
    }
    if let Some(accessible) = accessible {
        // An empty list is no account (`= any('{}')`).
        find = find.filter(Column::AccountId.is_in(accessible));
    }
    let rows = find
        .all(&orm(db))
        .await?
        .into_iter()
        .map(label_json)
        .collect::<Result<Vec<_>, _>>()?;
    with_live_message_counts(db, rows).await
}

async fn label_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    mail_labels::Entity::find_by_id(id.to_owned())
        .filter(mail_labels::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(label_json)
        .transpose()
}

/// The row as it is now (deleted or not), which must exist: `select
/// to_jsonb(l) from mail_labels l where l.id = $1`.
async fn label_row_after(db: &PgPool, id: &str) -> Result<Value, DbErr> {
    let row = mail_labels::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail_labels {id}")))?;
    label_json(row)
}

/// `getMailLabel(db, id)`.
pub async fn get_mail_label(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
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
    if name_taken(db, &data.account_id, &data.name, None).await? {
        return Err(MailLabelError::DuplicateName(DUPLICATE_NAME));
    }
    let id = generate_id("label");
    let at = utc_timestamp(now);
    let row = mail_labels::ActiveModel {
        id: Set(id.clone()),
        account_id: Set(data.account_id.clone()),
        name: Set(data.name.clone()),
        color: Set(data.color.clone()),
        message_count: Set(0),
        ai_enabled: Set(Some(data.ai_enabled.unwrap_or(false))),
        ai_keywords: Set(data.ai_keywords.as_ref().map(|k| json!(k))),
        ai_description: Set(data.ai_description.clone()),
        ai_confidence: Set(Some(
            i32::try_from(data.ai_confidence.unwrap_or(70)).unwrap_or(i32::MAX),
        )),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    };
    mail_labels::Entity::insert(row)
        .exec_without_returning(&orm(db))
        .await?;
    Ok(label_row_after(db, &id).await?)
}

/// A live label of the account already has this name, in any casing
/// (`lower(name) = lower($name)`), other than `except`.
async fn name_taken(
    db: &PgPool,
    account_id: &str,
    name: &str,
    except: Option<&str>,
) -> Result<bool, DbErr> {
    use mail_labels::Column;
    use sea_orm::ExprTrait as _;
    let mut find = mail_labels::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::AccountId.eq(account_id))
        .filter(lower(Expr::col((mail_labels::Entity, Column::Name))).eq(lower(Expr::val(name))))
        .filter(Column::DeletedAt.is_null());
    if let Some(except) = except {
        find = find.filter(Column::Id.ne(except));
    }
    let found: Option<String> = find.into_tuple().one(&orm(db)).await?;
    Ok(found.is_some())
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
        if name_taken(db, &account_id, name, Some(id)).await? {
            return Err(MailLabelError::DuplicateName(DUPLICATE_NAME));
        }
    }
    let at = utc_timestamp(now);
    let mut tx = db.begin().await.map_err(orm_error)?;
    patch_label(&OrmConn::new(&mut tx), id, data, at).await?;
    if let Some(name) = &new_name {
        relabel_messages_in(&mut *tx, &account_id, &old_name, name, at).await?;
    }
    tx.commit().await.map_err(orm_error)?;
    let after = label_row_after(db, id).await?;
    let mut counted = with_live_message_counts(db, vec![after]).await?;
    let after = counted.pop().unwrap_or(Value::Null);
    Ok((existing, after))
}

/// The fields of [`UpdateMailLabel`] the body sent (`coalesce($n, column)`),
/// and `updated_at`.
async fn patch_label<C: ConnectionTrait>(
    db: &C,
    id: &str,
    data: &UpdateMailLabel,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use mail_labels::Column;
    let mut update = mail_labels::Entity::update_many();
    if let Some(name) = &data.name {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let Some(color) = &data.color {
        update = update.col_expr(Column::Color, Expr::value(color));
    }
    if let Some(position) = data.position.and_then(|p| i32::try_from(p).ok()) {
        update = update.col_expr(Column::Position, Expr::value(position));
    }
    if let Some(enabled) = data.ai_enabled {
        update = update.col_expr(Column::AiEnabled, Expr::value(enabled));
    }
    if let Some(keywords) = &data.ai_keywords {
        update = update.col_expr(Column::AiKeywords, Expr::value(json!(keywords)));
    }
    if let Some(description) = &data.ai_description {
        update = update.col_expr(Column::AiDescription, Expr::value(description));
    }
    if let Some(confidence) = data.ai_confidence.and_then(|c| i32::try_from(c).ok()) {
        update = update.col_expr(Column::AiConfidence, Expr::value(confidence));
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
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
    let at = utc_timestamp(now);
    mail_labels::Entity::update_many()
        .col_expr(mail_labels::Column::DeletedAt, Expr::value(at))
        .col_expr(mail_labels::Column::UpdatedAt, Expr::value(at))
        .filter(mail_labels::Column::Id.eq(id))
        .exec(&orm(db))
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

/// Runs `update` with `returning id, account_id`: the messages it touched,
/// in the order the database returns them.
async fn update_returning_ids(
    db: &PgPool,
    update: sea_orm::UpdateMany<mail_messages::Entity>,
) -> Result<Vec<(String, String)>, DbErr> {
    use mail_messages::Column;
    let mut update: UpdateStatement = update.into_query();
    update.returning(Query::returning().columns([Column::Id, Column::AccountId]));
    orm(db)
        .query_all(&update)
        .await?
        .iter()
        .map(|row| Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)))
        .collect()
}

/// `moveMessagesToLocation(db, ids, location)`: one statement; the other
/// locations (and promotions, snooze) dropped, `is_trash` / `is_spam`
/// following. Back to the inbox, outgoing mail keeps its place.
pub async fn move_messages_to_location(
    db: &PgPool,
    ids: &[String],
    location: &str,
    now: OffsetDateTime,
) -> Result<Touched, DbErr> {
    use mail_messages::Column;
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    // `coalesce(labels, '[]'::jsonb) - CLEARED_BY_MOVE`, one label at a time.
    let cleared = || {
        CLEARED_BY_MOVE
            .iter()
            .fold(labels_or_empty(), |labels, label| labels.sub(*label))
    };
    let moved = PgExpr::concat(cleared(), Expr::val(json!([location])));
    let labels: Expr = if location == INBOX {
        let outgoing = Condition::any()
            .add(PgExpr::contains(cleared(), Expr::val(json!(["SENT"]))))
            .add(PgExpr::contains(cleared(), Expr::val(json!(["DRAFT"]))))
            .add(PgExpr::contains(cleared(), Expr::val(json!(["DRAFTS"]))))
            .add(PgExpr::contains(cleared(), Expr::val(json!(["SCHEDULED"]))));
        Expr::case(outgoing, cleared()).finally(moved).into()
    } else {
        moved
    };
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::Labels, labels)
        .col_expr(Column::IsTrash, Expr::value(location == TRASH))
        .col_expr(Column::IsSpam, Expr::value(location == SPAM))
        .col_expr(Column::SnoozedUntil, Expr::value(None::<PrimitiveDateTime>))
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(Column::Id.is_in(ids))
        .filter(Column::DeletedAt.is_null());
    Ok(touched(update_returning_ids(db, update).await?))
}

/// `updateLabelMessageCount`: the running tally on the label rows.
async fn update_label_message_count(
    db: &PgPool,
    label: &str,
    account_ids: &[String],
    delta: i64,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    use mail_labels::Column;
    use sea_orm::ExprTrait as _;
    if account_ids.is_empty() || delta == 0 {
        return Ok(());
    }
    // `greatest(0, message_count + delta)`, in one statement.
    let count = Func::greatest([
        Expr::val(0),
        Expr::col((mail_labels::Entity, Column::MessageCount)).add(delta),
    ]);
    mail_labels::Entity::update_many()
        .col_expr(Column::MessageCount, count.into())
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(Column::Name.eq(label))
        .filter(Column::AccountId.is_in(account_ids))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The mirrored flags a label change writes (`coalesce($flag, column)`):
/// only those it sets.
pub(crate) fn with_flags(
    mut update: sea_orm::UpdateMany<mail_messages::Entity>,
    flags: LabelFlags,
) -> sea_orm::UpdateMany<mail_messages::Entity> {
    use mail_messages::Column;
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
    update
}

/// `bulkAddLabelToMessages(db, label, ids)`: appended where missing, the
/// mirrored flag written with it; a location is a move.
pub async fn bulk_add_label(
    db: &PgPool,
    label_name: &str,
    ids: &[String],
    now: OffsetDateTime,
) -> Result<Touched, DbErr> {
    use mail_messages::Column;
    use sea_orm::ExprTrait as _;
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    let label = normalize_label(label_name);
    if is_location_label(&label) {
        return move_messages_to_location(db, ids, &label, now).await;
    }
    let flags = flags_for_label_change(std::slice::from_ref(&label), true);
    let update = mail_messages::Entity::update_many().col_expr(
        Column::Labels,
        sea_orm::sea_query::extension::postgres::PgExpr::concat(
            labels_or_empty(),
            Expr::val(json!([label])),
        ),
    );
    let update = with_flags(update, flags)
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(Column::Id.is_in(ids))
        .filter(Column::DeletedAt.is_null())
        .filter(carries(&label).not());
    let touched = touched(update_returning_ids(db, update).await?);
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
) -> Result<Touched, DbErr> {
    use mail_messages::Column;
    use sea_orm::ExprTrait as _;
    if ids.is_empty() {
        return Ok(Touched::default());
    }
    let label = normalize_label(label_name);
    let flags = flags_for_label_change(std::slice::from_ref(&label), false);
    // Starred / important may live on the column alone.
    let mut carrying = Condition::any().add(carries(&label));
    if label == STARRED {
        carrying = carrying.add(Column::IsStarred.eq(true));
    } else if label == IMPORTANT {
        carrying = carrying.add(Column::IsImportant.eq(true));
    }
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::Labels, labels_or_empty().sub(label.as_str()));
    let update = with_flags(update, flags)
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(Column::Id.is_in(ids))
        .filter(Column::DeletedAt.is_null())
        .filter(carrying);
    let touched = touched(update_returning_ids(db, update).await?);
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
) -> Result<Vec<String>, DbErr> {
    use mail_messages::Column;
    let ids: Vec<String> = mail_messages::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::AccountId.eq(account_id))
        .filter(sea_orm::ExprTrait::eq(thread_key_of(), thread_key))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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

/// `coalesce(thread_id, id)`: the message's thread key.
pub(crate) fn thread_key_of() -> Expr {
    Func::coalesce([
        msg(mail_messages::Column::ThreadId),
        msg(mail_messages::Column::Id),
    ])
    .into()
}

/// A rename on the messages: every label spelled `from` (any casing)
/// becomes `to`, in place.
#[allow(
    clippy::disallowed_methods,
    reason = "rewrites matching elements of each message's jsonb labels array in place (jsonb_agg over jsonb_array_elements), which the ORM can't express"
)]
async fn relabel_messages_in<'e, E>(
    executor: E,
    account_id: &str,
    from: &str,
    to: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr>
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
    .await
    .map_err(orm_error)?;
    Ok(())
}

/// `stripLabelFromMessages(db, accountId, name)`: the label removed from
/// every message carrying it, in any casing.
#[allow(
    clippy::disallowed_methods,
    reason = "drops matching elements from each message's jsonb labels array (jsonb_agg over jsonb_array_elements), which the ORM can't express"
)]
pub async fn strip_label_from_messages(
    db: &PgPool,
    account_id: &str,
    name: &str,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
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
    .bind(utc_timestamp(now))
    .execute(db)
    .await
    .map_err(orm_error)?;
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
