//! Conversations (`@weldsuite/mail-domain/threads`, `store/thread-summary`
//! and the thread cursor of `store/cursor`): the folder and search lists of
//! threads, one thread by its key, and their summaries.
//!
//! A thread is keyed by `(account_id, coalesce(thread_id, id))`. Listing
//! wakes the scope's due snoozed mail first, so a mail that just came due is
//! already back in the inbox for the count and the page.

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::cursor::{atob_url, btoa_url};
use weldsuite_kit::validation::js_trim;

use crate::labels::{self, LabelMatch, SPAM, TRASH, label_folder_hides_archived, to_system_label};
use crate::messages::{contains_pattern, enrich_sender_contacts, iso, message_record, search_patterns};
use crate::outbound::clock::parse_iso;

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
    let account_id = object.get("accountId")?.as_str().filter(|s| !s.is_empty())?;
    let thread_key = object.get("threadKey")?.as_str().filter(|s| !s.is_empty())?;
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

/// The conditions of `buildThreadScope` over `mail_messages m`, account
/// scope `$1`, parameters up to `$13`.
macro_rules! thread_conditions {
    () => {
        "m.deleted_at is null and m.account_id = any($1::text[])
         and (not $2::bool or (exists (select 1 from unnest($3::text[]) as n(name)
                  where m.labels @> jsonb_build_array(n.name))
              or ($4::bool and m.is_starred = true)
              or ($5::bool and m.is_important = true)))
         and (not $6::bool or not coalesce(m.labels, '[]'::jsonb) @> '[\"ARCHIVE\"]'::jsonb)
         and (not $7::bool or not (coalesce(m.labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb
              or coalesce(m.labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb
              or coalesce(m.is_trash, false) or coalesce(m.is_spam, false)))
         and not exists (select 1 from unnest($8::text[]) as s(p) where not coalesce((
              m.subject ilike s.p or m.preview ilike s.p or m.text_body ilike s.p
              or (m.\"from\"->>'name' ilike s.p or m.\"from\"->>'email' ilike s.p)
              or (exists (select 1 from jsonb_array_elements(case when jsonb_typeof(m.\"to\") = 'array'
                       then m.\"to\" else '[]'::jsonb end) as r
                     where r->>'email' ilike s.p or r->>'name' ilike s.p)
                  or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(m.cc) = 'array'
                       then m.cc else '[]'::jsonb end) as r
                     where r->>'email' ilike s.p or r->>'name' ilike s.p))), false))
         and ($9::text is null or (m.\"from\"->>'name' ilike $9 or m.\"from\"->>'email' ilike $9))
         and ($10::text is null or (exists (select 1 from jsonb_array_elements(case when jsonb_typeof(m.\"to\") = 'array'
                       then m.\"to\" else '[]'::jsonb end) as r
                     where r->>'email' ilike $10 or r->>'name' ilike $10)
                  or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(m.cc) = 'array'
                       then m.cc else '[]'::jsonb end) as r
                     where r->>'email' ilike $10 or r->>'name' ilike $10)))
         and ($11::text is null or m.subject ilike $11)
         and (not $12::bool or (m.account_id, coalesce(m.thread_id, m.id)) in (
              select a.account_id, coalesce(a.thread_id, a.id) from mail_messages a
              where a.deleted_at is null and a.account_id = any($1::text[])
                and (a.has_attachments = true or coalesce(a.attachment_count, 0) > 0)))
         and (cardinality($13::text[]) = 0 or (m.account_id, coalesce(m.thread_id, m.id)) not in (
              select a.account_id, coalesce(a.thread_id, a.id) from mail_messages a
              where a.deleted_at is null and a.account_id = any($1::text[])
                and exists (select 1 from unnest($13::text[]) as w(p)
                     where a.subject ilike w.p or a.preview ilike w.p or a.text_body ilike w.p
                        or (a.\"from\"->>'name' ilike w.p or a.\"from\"->>'email' ilike w.p))))"
    };
}

/// The bound values of [`thread_conditions!`].
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

macro_rules! bind_scope {
    ($query:expr, $scope:expr) => {{
        let label = $scope.label.clone().unwrap_or_default();
        $query
            .bind($scope.account_ids.clone())
            .bind($scope.label.is_some())
            .bind(label.names)
            .bind(label.starred)
            .bind(label.important)
            .bind($scope.hides_archived)
            .bind($scope.live_only)
            .bind($scope.search.clone())
            .bind($scope.from.clone())
            .bind($scope.to.clone())
            .bind($scope.subject.clone())
            .bind($scope.has_attachment)
            .bind($scope.exclude.clone())
    }};
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
) -> Result<Scope, sqlx::Error> {
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

/// `buildWakeDueSnoozedUpdate(db, { now, scope })`: due snoozed mail back in
/// the inbox. The ids and mailboxes woken.
pub async fn wake_due_snoozed(
    db: &PgPool,
    account_ids: Option<&[String]>,
    now: OffsetDateTime,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    sqlx::query_as(
        "update mail_messages set
           labels = ((labels - 'SNOOZED') - 'INBOX') || '[\"INBOX\"]'::jsonb,
           is_read = false, snoozed_until = null, unsnooze_trigger_run_id = null,
           unsnoozed_at = $1::timestamp, unsnoozed_early = false, updated_at = $1::timestamp
         where deleted_at is null and snoozed_until <= $1::timestamp
           and labels @> '[\"SNOOZED\"]'::jsonb
           and ($2::text[] is null or account_id = any($2::text[]))
         returning account_id, id",
    )
    .bind(iso(now))
    .bind(account_ids)
    .fetch_all(db)
    .await
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
    let latest_date = [&latest["receivedDate"], &latest["sentDate"], &latest["createdAt"]]
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
pub async fn list_threads(
    db: &PgPool,
    account_ids: &[String],
    q: &ThreadQuery,
    now: OffsetDateTime,
) -> Result<ThreadPage, sqlx::Error> {
    if account_ids.is_empty() {
        return Ok(ThreadPage::default());
    }
    let scope = build_scope(db, account_ids, q).await?;
    let page_size = clamp_thread_page_size(q.page_size);
    let limit = page_size + 1;
    let (cursor_at, cursor_account, cursor_key) = match &q.cursor {
        Some(cursor) => {
            #[allow(clippy::cast_possible_truncation)]
            let ms = cursor.latest_at as i64;
            (
                Some(crate::outbound::clock::iso(ms)),
                Some(cursor.account_id.clone()),
                Some(cursor.thread_key.clone()),
            )
        }
        None => (None, None, None),
    };
    let offset = if q.cursor.is_some() {
        0
    } else {
        q.offset.unwrap_or(0).max(0)
    };

    // The wake, then the count and the page. A wake that cannot land (a
    // read-only workspace) does not fail the listing.
    if let Err(error) = wake_due_snoozed(db, Some(account_ids), now).await {
        tracing::warn!(%error, "[mail] waking snoozed mail failed; listing without it");
    }
    let total: i32 = bind_scope!(
        sqlx::query_scalar(concat!(
            "select count(distinct (m.account_id, coalesce(m.thread_id, m.id)))::int
             from mail_messages m where ",
            thread_conditions!()
        )),
        scope
    )
    .fetch_one(db)
    .await?;
    let rows: Vec<(String, String)> = bind_scope!(
        sqlx::query_as(concat!(
            "with matching as (
                 select m.account_id, coalesce(m.thread_id, m.id) as tk
                 from mail_messages m where ",
            thread_conditions!(),
            " group by m.account_id, coalesce(m.thread_id, m.id)
             ), dates as (
                 select m.account_id, coalesce(m.thread_id, m.id) as tk,
                        max(coalesce(m.received_date, m.sent_date, m.created_at)) as latest
                 from mail_messages m
                 where m.deleted_at is null and m.account_id = any($1::text[])
                 group by m.account_id, coalesce(m.thread_id, m.id)
             )
             select mt.account_id, mt.tk from matching mt
             join dates d on d.account_id = mt.account_id and d.tk = mt.tk
             where ($14::timestamp is null or (d.latest < $14::timestamp
                    or (d.latest = $14::timestamp and (mt.account_id > $15
                        or (mt.account_id = $15 and mt.tk > $16)))))
             order by d.latest desc, mt.account_id asc, mt.tk asc
             limit $17 offset $18"
        )),
        scope
    )
    .bind(cursor_at)
    .bind(cursor_account)
    .bind(cursor_key)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await?;
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
    let found: Vec<Value> = sqlx::query_scalar(
        "select (to_jsonb(m) - 'text_body' - 'html_body' - 'raw_message' - 'headers'
                 - 'custom_fields' - 'clicked_links')
         from mail_messages m
         where m.account_id = any($1::text[])
           and coalesce(m.thread_id, m.id) = any($2::text[])
           and m.deleted_at is null
         order by m.sent_date asc",
    )
    .bind(&page_accounts)
    .bind(&thread_ids)
    .fetch_all(db)
    .await?;
    let found: Vec<Value> = found.into_iter().map(js_row).collect();

    let mut summaries: Vec<Value> = Vec::new();
    for (account, tk) in &rows {
        let messages: Vec<Value> = found
            .iter()
            .filter(|m| {
                m["accountId"].as_str() == Some(account.as_str())
                    && m["threadId"]
                        .as_str()
                        .or_else(|| m["id"].as_str())
                        == Some(tk.as_str())
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

/// `enrichThreadContacts(db, summaries)`: every message's sender resolved,
/// and the latest sender's name and avatar from it.
async fn enrich_thread_contacts(db: &PgPool, summaries: &mut [Value]) -> Result<(), sqlx::Error> {
    let mut all: Vec<Value> = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    for summary in summaries.iter_mut() {
        let messages = summary["messages"].as_array_mut().map(std::mem::take).unwrap_or_default();
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
                summary["latestSenderAvatarUrl"] = from.get("avatarUrl").cloned().unwrap_or(Value::Null);
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
) -> Result<Option<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from mail_messages m
         where m.account_id = $1 and coalesce(m.thread_id, m.id) = $2 and m.deleted_at is null
         order by m.sent_date asc, m.id asc",
    )
    .bind(account_id)
    .bind(thread_key)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    enrich_sender_contacts(db, &mut rows).await?;
    Ok(Some(json!({
        "threadId": thread_key,
        "accountId": account_id,
        "messages": rows.into_iter().map(|r| message_record(r, true)).collect::<Vec<_>>(),
    })))
}
