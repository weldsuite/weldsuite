//! Conversations (`@weldsuite/mail-domain/threads`, `store/thread-summary`
//! and the thread cursor of `store/cursor`): the folder and search lists of
//! threads, one thread by its key, and their summaries.
//!
//! A thread is keyed by `(account_id, coalesce(thread_id, id))`. Listing
//! wakes the scope's due snoozed mail first, so a mail that just came due is
//! already back in the inbox for the count and the page.

use sea_orm::sea_query::{
    Alias, CommonTableExpression, Expr, Func, NullOrdering, Order, Query, SelectStatement,
    UpdateStatement, WithClause,
};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_kit::cursor::{atob_url, btoa_url};
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::mail_messages::{self, Column};

use crate::labels::{
    self, ARCHIVE, LabelMatch, SPAM, TRASH, carries, label_folder_hides_archived, msg,
    thread_key_of, to_system_label,
};
use crate::messages::{
    contains_pattern, enrich_sender_contacts, in_trash_or_spam, message_record,
    message_rows, recipient_matches, search_patterns, search_term, sender_matches, wide_rows,
};
use crate::outbound::clock::{parse_iso, timestamp};

/// `MAX_THREAD_PAGE_SIZE`.
pub const MAX_THREAD_PAGE_SIZE: i64 = 100;

/// `clampThreadPageSize(pageSize)`.
pub fn clamp_thread_page_size(page_size: Option<i64>) -> i64 {
    page_size.unwrap_or(25).clamp(1, MAX_THREAD_PAGE_SIZE)
}

/// `ThreadCursor`: the keyset position after a page.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadCursor {
    pub latest_at: f64,
    pub account_id: String,
    pub thread_key: String,
}

/// A JavaScript number as `JSON.stringify` writes it.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        let whole = value as i64;
        whole.to_string()
    } else {
        value.to_string()
    }
}

/// `encodeThreadCursor(cursor)`: `t1.` and the base64url of its JSON, keys
/// in the order the store writes them.
pub fn encode_thread_cursor(cursor: &ThreadCursor) -> String {
    let text = format!(
        "{{\"latestAt\":{},\"accountId\":{},\"threadKey\":{}}}",
        js_number(cursor.latest_at),
        Value::String(cursor.account_id.clone()),
        Value::String(cursor.thread_key.clone()),
    );
    let latin1: String = text.bytes().map(char::from).collect();
    format!("t1.{}", btoa_url(&latin1).unwrap_or_default())
}

/// `decodeThreadCursor(raw)`: `None` for anything but a well-formed cursor.
pub fn decode_thread_cursor(raw: Option<&str>) -> Option<ThreadCursor> {
    let rest = raw.filter(|r| !r.is_empty())?.strip_prefix("t1.")?;
    if !rest
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let binary = atob_url(rest)?;
    let bytes: Vec<u8> = binary
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect::<Option<_>>()?;
    let text = String::from_utf8(bytes).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    // `.strict()`: exactly these three keys.
    if object.len() != 3 {
        return None;
    }
    let latest_at = object.get("latestAt")?.as_f64().filter(|n| n.is_finite())?;
    let account_id = object
        .get("accountId")?
        .as_str()
        .filter(|s| !s.is_empty())?;
    let thread_key = object
        .get("threadKey")?
        .as_str()
        .filter(|s| !s.is_empty())?;
    Some(ThreadCursor {
        latest_at,
        account_id: account_id.to_owned(),
        thread_key: thread_key.to_owned(),
    })
}

/// `ThreadListFilter` + `ThreadListPagination` as the store passes them.
#[derive(Debug, Clone, Default)]
pub struct ThreadQuery {
    pub label_slug: String,
    /// `input.accountId`: narrows the custom-label name lookup.
    pub account_id: Option<String>,
    pub search: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub has_attachment: Option<bool>,
    pub exclude_words: Option<String>,
    pub page_size: Option<i64>,
    pub offset: Option<i64>,
    pub cursor: Option<ThreadCursor>,
}

/// What `buildThreadScope` matches on.
#[derive(Debug, Clone, Default)]
struct Scope {
    account_ids: Vec<String>,
    label: Option<LabelMatch>,
    hides_archived: bool,
    live_only: bool,
    search: Vec<String>,
    from: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    has_attachment: bool,
    exclude: Vec<String>,
}

/// `(account_id, coalesce(thread_id, id))` of `table`: a thread.
fn thread_of(table: &Alias) -> Expr {
    Expr::tuple([
        Expr::col((table.clone(), Column::AccountId)),
        Func::coalesce([
            Expr::col((table.clone(), Column::ThreadId)),
            Expr::col((table.clone(), Column::Id)),
        ])
        .into(),
    ])
}

/// `(account_id, coalesce(thread_id, id))` of `mail_messages`.
fn thread_of_message() -> Expr {
    Expr::tuple([msg(Column::AccountId), thread_key_of()])
}

impl Scope {
    /// `select a.account_id, coalesce(a.thread_id, a.id) from mail_messages a
    /// where a.deleted_at is null and a.account_id = any(scope) and …`: the
    /// threads with a message matching `condition`.
    fn threads_where(&self, condition: impl FnOnce(&Alias) -> Condition) -> SelectStatement {
        use sea_orm::ExprTrait as _;
        let a = Alias::new("a");
        Query::select()
            .expr(Expr::col((a.clone(), Column::AccountId)))
            .expr(Func::coalesce([
                Expr::col((a.clone(), Column::ThreadId)),
                Expr::col((a.clone(), Column::Id)),
            ]))
            .from_as(mail_messages::Entity, a.clone())
            .cond_where(
                Condition::all()
                    .add(Expr::col((a.clone(), Column::DeletedAt)).is_null())
                    .add(Expr::col((a.clone(), Column::AccountId)).is_in(&self.account_ids))
                    .add(condition(&a)),
            )
            .to_owned()
    }

    /// The conditions of `buildThreadScope` over `mail_messages`.
    fn condition(&self) -> Condition {
        use sea_orm::ExprTrait as _;
        use sea_orm::sea_query::extension::postgres::PgExpr;
        let mut all = Condition::all()
            .add(Column::DeletedAt.is_null())
            .add(Column::AccountId.is_in(&self.account_ids));
        if let Some(label) = &self.label {
            all = all.add(label.condition());
        }
        if self.hides_archived {
            all = all.add(carries(ARCHIVE).not());
        }
        if self.live_only {
            all = all.add(in_trash_or_spam().not());
        }
        for pattern in &self.search {
            all = all.add(search_term(pattern));
        }
        if let Some(from) = &self.from {
            all = all.add(sender_matches(from));
        }
        if let Some(to) = &self.to {
            all = all.add(
                Condition::any()
                    .add(recipient_matches(Column::To, to))
                    .add(recipient_matches(Column::Cc, to)),
            );
        }
        if let Some(subject) = &self.subject {
            all = all.add(Column::Subject.ilike(subject));
        }
        if self.has_attachment {
            // A thread with an attachment anywhere in it.
            let with_attachment = self.threads_where(|a| {
                Condition::any()
                    .add(Expr::col((a.clone(), Column::HasAttachments)).eq(true))
                    .add(
                        Expr::from(Func::coalesce([
                            Expr::col((a.clone(), Column::AttachmentCount)),
                            Expr::val(0),
                        ]))
                        .gt(0),
                    )
            });
            all = all.add(thread_of_message().in_subquery(with_attachment));
        }
        if !self.exclude.is_empty() {
            // No message of the thread has an excluded word.
            let excluded = self.threads_where(|a| {
                let field = |column: Column| Expr::col((a.clone(), column));
                let sender = |key: &str| PgExpr::cast_json_field(field(Column::From), key);
                let mut any = Condition::any();
                for pattern in &self.exclude {
                    any = any.add(
                        Condition::any()
                            .add(PgExpr::ilike(field(Column::Subject), pattern))
                            .add(PgExpr::ilike(field(Column::Preview), pattern))
                            .add(PgExpr::ilike(field(Column::TextBody), pattern))
                            .add(
                                Condition::any()
                                    .add(PgExpr::ilike(sender("name"), pattern))
                                    .add(PgExpr::ilike(sender("email"), pattern)),
                            ),
                    );
                }
                any
            });
            all = all.add(thread_of_message().not_in_subquery(excluded));
        }
        all
    }
}

/// A "contains" filter's pattern when the text is not blank.
fn field_pattern(value: Option<&str>) -> Option<String> {
    value
        .filter(|v| !js_trim(v).is_empty())
        .map(contains_pattern)
}

/// `buildThreadScope(db, accountScope, input)`.
async fn build_scope(
    db: &PgPool,
    account_ids: &[String],
    q: &ThreadQuery,
) -> Result<Scope, DbErr> {
    let search = search_patterns(q.search.as_deref());
    let system = to_system_label(&q.label_slug);
    let mut scope = Scope {
        account_ids: account_ids.to_vec(),
        search,
        from: field_pattern(q.from.as_deref()),
        to: field_pattern(q.to.as_deref()),
        subject: field_pattern(q.subject.as_deref()),
        has_attachment: q.has_attachment == Some(true),
        exclude: search_patterns(q.exclude_words.as_deref()),
        ..Scope::default()
    };
    if q.label_slug != "all" && scope.search.is_empty() {
        let names =
            labels::resolve_custom_label_names(db, &q.label_slug, q.account_id.as_deref()).await?;
        scope.label = Some(LabelMatch::new(&q.label_slug, &names));
        scope.hides_archived = label_folder_hides_archived(&q.label_slug);
    }
    scope.live_only = !scope.search.is_empty() || !matches!(system, Some(TRASH | SPAM));
    Ok(scope)
}

/// Runs `update` with `returning <columns>`: two text columns per row, in
/// the order the database returns them.
async fn update_returning<const N: usize>(
    db: &PgPool,
    mut update: UpdateStatement,
    columns: [Column; N],
) -> Result<Vec<[String; N]>, DbErr> {
    update.returning(Query::returning().columns(columns));
    orm(db)
        .query_all(&update)
        .await?
        .iter()
        .map(|row| {
            let mut out: [String; N] = std::array::from_fn(|_| String::new());
            for (index, slot) in out.iter_mut().enumerate() {
                *slot = row.try_get_by_index(index)?;
            }
            Ok(out)
        })
        .collect()
}

/// `buildWakeDueSnoozedUpdate(db, { now, scope })`: due snoozed mail back in
/// the inbox. The ids and mailboxes woken.
pub async fn wake_due_snoozed(
    db: &PgPool,
    account_ids: Option<&[String]>,
    now: OffsetDateTime,
) -> Result<Vec<(String, String)>, DbErr> {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let at = utc_timestamp(now);
    // `((labels - 'SNOOZED') - 'INBOX') || '["INBOX"]'`.
    let labels = PgExpr::concat(
        msg(Column::Labels).sub("SNOOZED").sub("INBOX"),
        Expr::val(json!(["INBOX"])),
    );
    let mut update = mail_messages::Entity::update_many()
        .col_expr(Column::Labels, labels)
        .col_expr(Column::IsRead, Expr::value(false))
        .col_expr(Column::SnoozedUntil, Expr::value(None::<PrimitiveDateTime>))
        .col_expr(Column::UnsnoozeTriggerRunId, Expr::value(None::<String>))
        .col_expr(Column::UnsnoozedAt, Expr::value(at))
        .col_expr(Column::UnsnoozedEarly, Expr::value(false))
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::SnoozedUntil.lte(at))
        .filter(PgExpr::contains(
            msg(Column::Labels),
            Expr::val(json!(["SNOOZED"])),
        ));
    if let Some(account_ids) = account_ids {
        update = update.filter(Column::AccountId.is_in(account_ids));
    }
    let rows = update_returning(
        db,
        update.into_query(),
        [Column::AccountId, Column::Id],
    )
    .await?;
    Ok(rows.into_iter().map(|[account, id]| (account, id)).collect())
}

/// One page of threads.
#[derive(Debug, Clone, Default)]
pub struct ThreadPage {
    pub threads: Vec<Value>,
    pub total_count: i64,
    pub next_cursor: Option<ThreadCursor>,
}

/// The milliseconds of the first present date (`dateOf`).
fn date_of(message: &Value) -> f64 {
    for key in ["receivedDate", "sentDate", "createdAt"] {
        if let Some(text) = message[key].as_str() {
            #[allow(clippy::cast_precision_loss)]
            return parse_iso(text).map_or(f64::NAN, |ms| ms as f64);
        }
    }
    0.0
}

/// `normalizeSubject(subject)`.
pub fn normalize_subject(subject: Option<&str>) -> String {
    let Some(subject) = subject.filter(|s| !s.is_empty()) else {
        return "(No subject)".to_owned();
    };
    let mut rest = subject;
    loop {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[..3].eq_ignore_ascii_case(b"re:") {
            rest = rest[3..].trim_start_matches(|c: char| c.is_whitespace());
        } else {
            break;
        }
    }
    if rest.is_empty() {
        "(No subject)".to_owned()
    } else {
        rest.to_owned()
    }
}

/// `buildThreadSummary(row, messages)`, before the senders are resolved.
fn thread_summary(account_id: &str, thread_id: &str, mut messages: Vec<Value>) -> Value {
    // `Array.prototype.sort` is stable; NaN compares as equal.
    messages.sort_by(|a, b| {
        date_of(a)
            .partial_cmp(&date_of(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let first = &messages[0];
    let latest = &messages[messages.len() - 1];
    let mut participants: Vec<String> = Vec::new();
    let mut labels_seen: Vec<String> = Vec::new();
    let mut has_attachments = false;
    let mut is_starred = false;
    let mut unread = 0;
    for msg in &messages {
        let sender = msg["from"]["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| msg["from"]["email"].as_str().filter(|s| !s.is_empty()));
        if let Some(sender) = sender
            && !participants.iter().any(|p| p == sender)
        {
            participants.push(sender.to_owned());
        }
        if let Some(items) = msg["labels"].as_array() {
            for label in items.iter().filter_map(Value::as_str) {
                if !labels_seen.iter().any(|l| l == label) {
                    labels_seen.push(label.to_owned());
                }
            }
        }
        if msg["hasAttachments"].as_bool() == Some(true) {
            has_attachments = true;
        }
        if msg["isStarred"].as_bool() == Some(true) {
            is_starred = true;
        }
        if !msg["isRead"].as_bool().unwrap_or(false) {
            unread += 1;
        }
    }
    if labels_seen.iter().any(|l| l == labels::STARRED) {
        is_starred = true;
    }
    let latest_from = &latest["from"];
    let latest_sender = latest_from["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| latest_from["email"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("Unknown")
        .to_owned();
    let latest_date = [
        &latest["receivedDate"],
        &latest["sentDate"],
        &latest["createdAt"],
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .cloned()
    .unwrap_or(Value::Null);
    json!({
        "threadId": thread_id,
        "accountId": account_id,
        "subject": normalize_subject(first["subject"].as_str()),
        "participants": participants,
        "latestMessageId": latest["id"],
        "latestSender": latest_sender,
        "latestSenderEmail": latest_from["email"].as_str().unwrap_or_default(),
        "latestSenderAvatarUrl": null,
        "latestDate": latest_date,
        "preview": latest["preview"].as_str().unwrap_or_default(),
        "messageCount": messages.len(),
        "unreadCount": unread,
        "hasAttachments": has_attachments,
        "isStarred": is_starred,
        "labels": labels_seen,
        "scheduledFor": latest.get("scheduledFor").cloned().unwrap_or(Value::Null),
        "sendStatus": latest.get("sendStatus").cloned().unwrap_or(Value::Null),
        "messages": messages,
    })
}

/// `listThreadsForAccounts(db, accountIds, input)` with the store's
/// lookahead, as `PostgresMailboxStore.listThreads` /
/// `PostgresWorkspaceMailStore.listThreads` page it.
#[allow(clippy::too_many_lines)] // the count, the page and the summaries, as TypeScript reads them
pub async fn list_threads(
    db: &PgPool,
    account_ids: &[String],
    q: &ThreadQuery,
    now: OffsetDateTime,
) -> Result<ThreadPage, DbErr> {
    if account_ids.is_empty() {
        return Ok(ThreadPage::default());
    }
    let scope = build_scope(db, account_ids, q).await?;
    let page_size = clamp_thread_page_size(q.page_size);
    let limit = page_size + 1;
    let offset = if q.cursor.is_some() {
        0
    } else {
        q.offset.unwrap_or(0).max(0)
    };
    let conn = orm(db);

    // The wake, then the count and the page. A wake that cannot land (a
    // read-only workspace) does not fail the listing.
    if let Err(error) = wake_due_snoozed(db, Some(account_ids), now).await {
        tracing::warn!(%error, "[mail] waking snoozed mail failed; listing without it");
    }
    let condition = scope.condition();
    let total: i32 = mail_messages::Entity::find()
        .select_only()
        .column_as(
            sea_orm::ExprTrait::cast_as(Func::count_distinct(thread_of_message()), "int"),
            "count",
        )
        .filter(condition.clone())
        .into_tuple()
        .one(&conn)
        .await?
        .unwrap_or_default();
    let page = thread_page(&scope, condition, q.cursor.as_ref(), limit, offset);
    let rows: Vec<(String, String)> = conn
        .query_all(&page)
        .await?
        .iter()
        .map(|row| Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)))
        .collect::<Result<_, DbErr>>()?;
    let total_count = i64::from(total);
    if rows.is_empty() {
        return Ok(ThreadPage {
            threads: Vec::new(),
            total_count,
            next_cursor: None,
        });
    }

    let thread_ids: Vec<String> = rows
        .iter()
        .map(|(_, tk)| tk.clone())
        .filter(|tk| !tk.is_empty())
        .collect();
    let mut page_accounts: Vec<String> = Vec::new();
    for (account, _) in &rows {
        if !page_accounts.contains(account) {
            page_accounts.push(account.clone());
        }
    }
    let found = mail_messages::Entity::find()
        .filter(Column::AccountId.is_in(page_accounts))
        .filter(sea_orm::ExprTrait::is_in(thread_key_of(), thread_ids))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::SentDate)
        .all(&conn)
        .await?;
    let found = wide_rows(found)?;

    let mut summaries: Vec<Value> = Vec::new();
    for (account, tk) in &rows {
        let messages: Vec<Value> = found
            .iter()
            .filter(|m| {
                m["accountId"].as_str() == Some(account.as_str())
                    && m["threadId"].as_str().or_else(|| m["id"].as_str()) == Some(tk.as_str())
            })
            .cloned()
            .collect();
        if messages.is_empty() {
            continue;
        }
        summaries.push(thread_summary(account, tk, messages));
    }
    enrich_thread_contacts(db, &mut summaries).await?;

    let page_size = usize::try_from(page_size).unwrap_or(25);
    let has_more = summaries.len() > page_size;
    if has_more {
        summaries.truncate(page_size);
    }
    let next_cursor = if has_more {
        summaries.last().map(|last| ThreadCursor {
            #[allow(clippy::cast_precision_loss)]
            latest_at: last["latestDate"]
                .as_str()
                .and_then(parse_iso)
                .map_or(0.0, |ms| ms as f64),
            account_id: last["accountId"].as_str().unwrap_or_default().to_owned(),
            thread_key: last["threadId"].as_str().unwrap_or_default().to_owned(),
        })
    } else {
        None
    };
    Ok(ThreadPage {
        threads: summaries,
        total_count,
        next_cursor,
    })
}

/// The page of `listThreadsForAccounts`: the scope's threads by their latest
/// message (any message of the thread counts, matching or not), newest
/// first, after the cursor.
///
/// ```sql
/// with matching as (select account_id, coalesce(thread_id, id) as tk
///                   from mail_messages where <scope> group by 1, 2),
///      dates as (select account_id, coalesce(thread_id, id) as tk,
///                       max(coalesce(received_date, sent_date, created_at)) as latest
///                from mail_messages where deleted_at is null
///                  and account_id = any(<accounts>) group by 1, 2)
/// select mt.account_id, mt.tk from matching mt join dates d using the thread
/// where <after the cursor>
/// order by d.latest desc, mt.account_id asc, mt.tk asc limit … offset …
/// ```
fn thread_page(
    scope: &Scope,
    condition: Condition,
    cursor: Option<&ThreadCursor>,
    limit: i64,
    offset: i64,
) -> sea_orm::sea_query::WithQuery {
    use sea_orm::ExprTrait as _;
    let (matching, dates) = (Alias::new("matching"), Alias::new("dates"));
    let (mt, d) = (Alias::new("mt"), Alias::new("d"));
    let (tk, latest) = (Alias::new("tk"), Alias::new("latest"));
    let matching_query = Query::select()
        .expr(msg(Column::AccountId))
        .expr_as(thread_key_of(), tk.clone())
        .from(mail_messages::Entity)
        .cond_where(condition)
        .group_by_columns([(mail_messages::Entity, Column::AccountId)])
        .add_group_by([thread_key_of()])
        .to_owned();
    let dates_query = Query::select()
        .expr(msg(Column::AccountId))
        .expr_as(thread_key_of(), tk.clone())
        .expr_as(
            Func::max(Func::coalesce([
                msg(Column::ReceivedDate),
                msg(Column::SentDate),
                msg(Column::CreatedAt),
            ])),
            latest.clone(),
        )
        .from(mail_messages::Entity)
        .cond_where(
            Condition::all()
                .add(Column::DeletedAt.is_null())
                .add(Column::AccountId.is_in(&scope.account_ids)),
        )
        .group_by_columns([(mail_messages::Entity, Column::AccountId)])
        .add_group_by([thread_key_of()])
        .to_owned();
    let col = |table: &Alias, column: &Alias| Expr::col((table.clone(), column.clone()));
    let account = Alias::new("account_id");
    let mut page = Condition::all();
    if let Some(cursor) = cursor {
        #[allow(clippy::cast_possible_truncation)]
        let at = timestamp(cursor.latest_at as i64);
        page = page.add(
            Condition::any().add(col(&d, &latest).lt(at)).add(
                Condition::all().add(col(&d, &latest).eq(at)).add(
                    Condition::any()
                        .add(col(&mt, &account).gt(cursor.account_id.as_str()))
                        .add(
                            Condition::all()
                                .add(col(&mt, &account).eq(cursor.account_id.as_str()))
                                .add(col(&mt, &tk).gt(cursor.thread_key.as_str())),
                        ),
                ),
            ),
        );
    }
    let select = Query::select()
        .expr(col(&mt, &account))
        .expr(col(&mt, &tk))
        .from_as(matching.clone(), mt.clone())
        .join_as(
            sea_orm::JoinType::InnerJoin,
            dates.clone(),
            d.clone(),
            Condition::all()
                .add(col(&d, &account).eq(col(&mt, &account)))
                .add(col(&d, &tk).eq(col(&mt, &tk))),
        )
        .cond_where(page)
        .order_by((d.clone(), latest.clone()), Order::Desc)
        .order_by((mt.clone(), account.clone()), Order::Asc)
        .order_by((mt.clone(), tk.clone()), Order::Asc)
        .limit(u64::try_from(limit).unwrap_or_default())
        .offset(u64::try_from(offset).unwrap_or_default())
        .to_owned();
    let with = WithClause::new()
        .cte(
            CommonTableExpression::new()
                .query(matching_query)
                .table_name(matching)
                .to_owned(),
        )
        .cte(
            CommonTableExpression::new()
                .query(dates_query)
                .table_name(dates)
                .to_owned(),
        )
        .to_owned();
    select.with(with)
}

/// `enrichThreadContacts(db, summaries)`: every message's sender resolved,
/// and the latest sender's name and avatar from it.
async fn enrich_thread_contacts(db: &PgPool, summaries: &mut [Value]) -> Result<(), DbErr> {
    let mut all: Vec<Value> = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    for summary in summaries.iter_mut() {
        let messages = summary["messages"]
            .as_array_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        counts.push(messages.len());
        all.extend(messages);
    }
    enrich_sender_contacts(db, &mut all).await?;
    let mut rest = all.into_iter();
    for (summary, count) in summaries.iter_mut().zip(counts) {
        let messages: Vec<Value> = rest.by_ref().take(count).collect();
        let latest_id = summary["latestMessageId"].clone();
        if let Some(latest) = messages.iter().find(|m| m["id"] == latest_id) {
            let from = &latest["from"];
            if from.is_object() {
                let sender = from["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| from["email"].as_str().filter(|s| !s.is_empty()))
                    .unwrap_or("Unknown")
                    .to_owned();
                summary["latestSender"] = Value::String(sender);
                summary["latestSenderAvatarUrl"] =
                    from.get("avatarUrl").cloned().unwrap_or(Value::Null);
            }
        }
        summary["messages"] = Value::Array(messages);
    }
    Ok(())
}

/// `getThreadByKey(db, accountId, threadKey)` as the store hands it out
/// (`getThread`): the messages with bodies, senders resolved.
pub async fn thread_by_key(
    db: &PgPool,
    account_id: &str,
    thread_key: &str,
) -> Result<Option<Value>, DbErr> {
    let rows = mail_messages::Entity::find()
        .filter(Column::AccountId.eq(account_id))
        .filter(sea_orm::ExprTrait::eq(thread_key_of(), thread_key))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::SentDate)
        .order_by_asc(Column::Id)
        .all(&orm(db))
        .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut rows = message_rows(rows)?;
    enrich_sender_contacts(db, &mut rows).await?;
    Ok(Some(json!({
        "threadId": thread_key,
        "accountId": account_id,
        "messages": rows.into_iter().map(|r| message_record(r, true)).collect::<Vec<_>>(),
    })))
}

/// `markThreadRead(db, accountId, threadKey, isRead)`: the ids whose read
/// state changed.
pub async fn mark_thread_read(
    db: &PgPool,
    account_id: &str,
    thread_key: &str,
    is_read: bool,
    now: OffsetDateTime,
) -> Result<Vec<String>, DbErr> {
    let update = mail_messages::Entity::update_many()
        .col_expr(Column::IsRead, Expr::value(is_read))
        .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(Column::AccountId.eq(account_id))
        .filter(sea_orm::ExprTrait::eq(thread_key_of(), thread_key))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::IsRead.eq(!is_read));
    let rows = update_returning(db, update.into_query(), [Column::Id]).await?;
    Ok(rows.into_iter().map(|[id]| id).collect())
}

/// `MARK_READ_BATCH_SIZE` / `MARK_READ_MAX_BATCHES`.
const MARK_READ_BATCH_SIZE: i64 = 1000;
const MARK_READ_MAX_BATCHES: usize = 50;

/// What `markFolderReadForAccounts` reports.
#[derive(Debug, Clone, Default)]
pub struct FolderRead {
    pub updated_count: usize,
    /// `(id, accountId)`, at most `updated_per_account` per mailbox.
    pub updated: Vec<(String, String)>,
}

/// `markFolderReadForAccounts(db, accountIds, { labelSlug }, { updatedPerAccount })`:
/// every unread message of the folder's threads read, newest first, in
/// batches; the due snoozed mail woken first.
pub async fn mark_folder_read(
    db: &PgPool,
    account_ids: &[String],
    label_slug: &str,
    updated_per_account: usize,
    now: OffsetDateTime,
) -> Result<FolderRead, DbErr> {
    if account_ids.is_empty() {
        return Ok(FolderRead::default());
    }
    let query = ThreadQuery {
        label_slug: label_slug.to_owned(),
        ..ThreadQuery::default()
    };
    let scope = build_scope(db, account_ids, &query).await?;
    if let Err(error) = wake_due_snoozed(db, Some(account_ids), now).await {
        tracing::error!(%error, "[mail-thread-ops] waking snoozed mail failed");
    }
    let conn = orm(db);
    let mut out = FolderRead::default();
    let mut kept: Vec<(String, usize)> = Vec::new();
    for _ in 0..MARK_READ_MAX_BATCHES {
        let batch: Vec<(String, String)> = conn
            .query_all(&unread_batch(&scope))
            .await?
            .iter()
            .map(|row| Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)))
            .collect::<Result<_, DbErr>>()?;
        if batch.is_empty() {
            break;
        }
        let ids: Vec<String> = batch.iter().map(|(id, _)| id.clone()).collect();
        let update = mail_messages::Entity::update_many()
            .col_expr(Column::IsRead, Expr::value(true))
            .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(now)))
            .filter(Column::Id.is_in(ids))
            .filter(Column::IsRead.eq(false));
        let done: Vec<String> = update_returning(db, update.into_query(), [Column::Id])
            .await?
            .into_iter()
            .map(|[id]| id)
            .collect();
        out.updated_count += done.len();
        for (id, account) in &batch {
            if !done.contains(id) {
                continue;
            }
            let index = if let Some(index) = kept.iter().position(|(a, _)| a == account) {
                index
            } else {
                kept.push((account.clone(), 0));
                kept.len() - 1
            };
            if kept[index].1 >= updated_per_account {
                continue;
            }
            kept[index].1 += 1;
            out.updated.push((id.clone(), account.clone()));
        }
        if i64::try_from(batch.len()).unwrap_or(i64::MAX) < MARK_READ_BATCH_SIZE {
            break;
        }
    }
    Ok(out)
}

/// One batch of `markFolderReadForAccounts`: the scope's unread messages in
/// the folder's threads, newest first.
///
/// ```sql
/// select o.id, o.account_id from mail_messages o
/// where o.account_id = any(<accounts>) and o.deleted_at is null and o.is_read = false
///   and (o.account_id, coalesce(o.thread_id, o.id)) in (select <thread> from mail_messages where <scope>)
/// order by coalesce(o.received_date, o.sent_date) desc nulls last limit 1000
/// ```
fn unread_batch(scope: &Scope) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let o = Alias::new("o");
    let col = |column: Column| Expr::col((o.clone(), column));
    let in_folder = Query::select()
        .expr(msg(Column::AccountId))
        .expr(thread_key_of())
        .from(mail_messages::Entity)
        .cond_where(scope.condition())
        .to_owned();
    Query::select()
        .expr(col(Column::Id))
        .expr(col(Column::AccountId))
        .from_as(mail_messages::Entity, o.clone())
        .cond_where(
            Condition::all()
                .add(col(Column::AccountId).is_in(&scope.account_ids))
                .add(col(Column::DeletedAt).is_null())
                .add(col(Column::IsRead).eq(false))
                .add(thread_of(&o).in_subquery(in_folder)),
        )
        .order_by_expr_with_nulls(
            Func::coalesce([col(Column::ReceivedDate), col(Column::SentDate)]).into(),
            Order::Desc,
            NullOrdering::Last,
        )
        .limit(u64::try_from(MARK_READ_BATCH_SIZE).unwrap_or_default())
        .to_owned()
}

#[cfg(test)]
mod tmp_sql_print {
    use sea_orm::{DbBackend, EntityTrait, QueryFilter, QueryTrait};

    use super::*;

    #[test]
    fn print_sql() {
        let scope = Scope {
            account_ids: vec!["acc1".into(), "acc2".into()],
            label: Some(LabelMatch::new("starred", &[])),
            hides_archived: true,
            live_only: true,
            search: vec!["%foo%".into()],
            from: Some("%bob%".into()),
            to: Some("%al%".into()),
            subject: Some("%subj%".into()),
            has_attachment: true,
            exclude: vec!["%spam%".into(), "%junk%".into()],
        };
        let cursor = ThreadCursor {
            latest_at: 1_791_883_800_000.0,
            account_id: "acc1".into(),
            thread_key: "tk".into(),
        };
        let page = thread_page(&scope, scope.condition(), Some(&cursor), 26, 0);
        println!("PAGE: {}\n", DbBackend::Postgres.build(&page).to_string());
        println!("BATCH: {}\n", DbBackend::Postgres.build(&unread_batch(&scope)).to_string());
        let count = mail_messages::Entity::find()
            .select_only()
            .column_as(
                sea_orm::ExprTrait::cast_as(Func::count_distinct(thread_of_message()), "int"),
                "count",
            )
            .filter(scope.condition())
            .build(DbBackend::Postgres);
        println!("COUNT: {}\n", count.to_string());
    }
}
