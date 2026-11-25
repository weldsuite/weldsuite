//! `/api/mail/messages` (`routes/mail-messages.ts`): the list and the
//! unread badge, one message and its attachments, flag and label changes
//! with the WeldMail "email read" push
//! (`sendPersonalMailReadPush`, `@weldsuite/mail-domain/read-push`), and the
//! outbound paths ([`crate::mail_send`]).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::DbErr;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm_error};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, string_or_number_issue};
use weldsuite_ports::OutboundHttp;

use crate::PersonalState;
use crate::booking_pages::cursor_of;
use crate::caller::{Caller, Failure, answer, created, data, rows, validate, validate_query};
use crate::events::page;
use crate::js::{js_trim, now_iso};
use crate::mail_send::{
    Compose, ForwardBody, ReplyBody, SendContext, forward_and_persist, message_row,
    reply_and_persist, require_message, send_and_persist, send_error_response,
};

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/mail/messages", get(list_messages))
        .route("/api/mail/messages/unread-count", get(unread_count))
        .route("/api/mail/messages/send", post(send))
        .route("/api/mail/messages/{id}/reply", post(reply))
        .route("/api/mail/messages/{id}/forward", post(forward))
        .route("/api/mail/messages/{id}/attachments", get(attachments))
        .route("/api/mail/messages/{id}", get(get_one).patch(update))
}

/// `listQuery`.
struct ListQuery {
    account_id: Option<String>,
    label: Option<String>,
    thread_id: Option<String>,
    unread_only: bool,
    search: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// `z.coerce.boolean()`: `Boolean(value)`.
fn coerce_boolean(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(_) => true,
    }
}

/// `escapeLike(value)`.
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `GET /api/mail/messages`: newest first, a thread oldest first.
#[allow(clippy::too_many_lines)] // the list and its count, one filter each
async fn list_messages(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let optional = |issues: &mut Issues, key: &str, max: Option<usize>| {
            issues
                .text(q, key, Presence::Optional, None, max)
                .into_option()
        };
        ListQuery {
            account_id: optional(issues, "accountId", None),
            label: optional(issues, "label", None),
            thread_id: optional(issues, "threadId", None),
            unread_only: coerce_boolean(q.get("unreadOnly")),
            search: optional(issues, "search", Some(200)),
            cursor: optional(issues, "cursor", None),
            limit: issues
                .whole_number(
                    q,
                    "limit",
                    Presence::Optional,
                    Number {
                        coerce: true,
                        int: true,
                        min: Some(1.0),
                        max: Some(100.0),
                    },
                )
                .into_option(),
        }
    }) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let limit = query.limit.unwrap_or(50).min(100);
    let truthy = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
    let mailbox = truthy(&query.account_id);
    let label = truthy(&query.label);
    let thread = truthy(&query.thread_id);
    let term = query
        .search
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", escape_like(s)));
    let ascending = thread.is_some();
    let result = async {
        let db = caller.personal()?;
        let cursor = cursor_of(
            db,
            "select to_jsonb(m.sent_date), m.id from personal_mail_messages m where m.id = $1 limit 1",
            truthy(&query.cursor).as_ref(),
        )
        .await?;
        let filters = Filters {
            account: &account,
            mailbox: mailbox.as_deref(),
            label: label.as_ref().map(|label| json!([label])),
            thread: thread.as_deref(),
            unread_only: query.unread_only,
            term: term.as_deref(),
        };
        let found = list_rows(db, &filters, &cursor, ascending, limit).await?;

        // `filters.cursor ? conditions.slice(0, -1) : conditions`: with a
        // cursor that matched no message, the last filter goes instead.
        let mut active = vec!["account", "deleted"];
        if mailbox.is_some() {
            active.push("mailbox");
        }
        if label.is_some() {
            active.push("label");
        }
        if thread.is_some() {
            active.push("thread");
        }
        if query.unread_only {
            active.push("unread");
        }
        if term.is_some() {
            active.push("search");
        }
        let dropped = (truthy(&query.cursor).is_some() && cursor.0.is_none())
            .then(|| active.last().copied())
            .flatten()
            .unwrap_or("");
        let total = count_rows(db, &filters, dropped).await?;
        Ok(page(rows(found), limit, total))
    }
    .await;
    answer(result, "Failed to list messages")
}

/// The list's filters, as the queries bind them.
struct Filters<'a> {
    account: &'a str,
    mailbox: Option<&'a str>,
    /// `[label]`, for `labels @>`.
    label: Option<Value>,
    thread: Option<&'a str>,
    unread_only: bool,
    /// The escaped `%search%`.
    term: Option<&'a str>,
}

/// The live messages in the filters, newest first (a thread oldest first),
/// after the cursor: one more than `limit`.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn list_rows(
    db: &PgPool,
    filters: &Filters<'_>,
    cursor: &(Option<String>, Option<String>),
    ascending: bool,
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(m) from personal_mail_messages m
         where m.personal_account_id = $1 and m.deleted_at is null
           and ($2::text is null or m.account_id = $2)
           and ($3::jsonb is null or m.labels @> $3::jsonb)
           and ($4::text is null or m.thread_id = $4)
           and (not $5 or m.is_read = false)
           and ($6::text is null or (m.subject ilike $6 or m.preview ilike $6
                or m.\"from\"->>'name' ilike $6 or m.\"from\"->>'email' ilike $6))
           and ($7::timestamp is null or (case when $9
                then (m.sent_date > $7::timestamp or (m.sent_date = $7::timestamp and m.id > $8))
                else (m.sent_date < $7::timestamp or (m.sent_date = $7::timestamp and m.id < $8)) end))
         order by
           case when $9 then m.sent_date end asc, case when $9 then m.id end asc,
           case when not $9 then m.sent_date end desc, case when not $9 then m.id end desc
         limit $10",
    )
    .bind(filters.account)
    .bind(filters.mailbox)
    .bind(&filters.label)
    .bind(filters.thread)
    .bind(filters.unread_only)
    .bind(filters.term)
    .bind(&cursor.0)
    .bind(&cursor.1)
    .bind(ascending)
    .bind(limit + 1)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// The messages' total, without the filter named by `dropped` (a cursor
/// that matched no message drops the last one; `""` drops none).
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn count_rows(db: &PgPool, filters: &Filters<'_>, dropped: &str) -> Result<i64, DbErr> {
    sqlx::query_scalar(
        "select count(*)::int8 from personal_mail_messages m
         where ($7 = 'account' or m.personal_account_id = $1)
           and ($7 = 'deleted' or m.deleted_at is null)
           and ($2::text is null or $7 = 'mailbox' or m.account_id = $2)
           and ($3::jsonb is null or $7 = 'label' or m.labels @> $3::jsonb)
           and ($4::text is null or $7 = 'thread' or m.thread_id = $4)
           and (not $5 or $7 = 'unread' or m.is_read = false)
           and ($6::text is null or $7 = 'search' or (m.subject ilike $6 or m.preview ilike $6
                or m.\"from\"->>'name' ilike $6 or m.\"from\"->>'email' ilike $6))",
    )
    .bind(filters.account)
    .bind(filters.mailbox)
    .bind(&filters.label)
    .bind(filters.thread)
    .bind(filters.unread_only)
    .bind(filters.term)
    .bind(dropped)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// `GET /api/mail/messages/unread-count`: the inbox badge, per mailbox.
async fn unread_count(caller: Caller) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let counts = unread_by_mailbox(caller.personal()?, &account).await?;
        let mut by_account = Map::new();
        let mut total = 0;
        for (mailbox, count) in counts {
            by_account.insert(mailbox, json!(count));
            total += count;
        }
        Ok(data(json!({ "total": total, "byAccount": by_account })))
    }
    .await;
    answer(result, "Failed to count unread messages")
}

/// The account's unread inbox messages, per mailbox.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn unread_by_mailbox(db: &PgPool, account: &str) -> Result<Vec<(String, i64)>, DbErr> {
    sqlx::query_as(
        "select account_id, count(*)::int8 from personal_mail_messages
         where personal_account_id = $1 and is_read = false and is_trash = false
           and deleted_at is null and labels @> '[\"INBOX\"]'::jsonb
         group by account_id",
    )
    .bind(account)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// The issues of the body's unions, each with the microtask turn it
/// settles on.
#[derive(Default)]
struct Unions(Vec<(u8, Vec<Value>)>);

impl Unions {
    /// Adds them after the body's synchronous issues, in the order the
    /// unions settle (field order on the same turn).
    fn finish(mut self, issues: &mut Issues) {
        self.0.sort_by_key(|(turn, _)| *turn);
        for (_, list) in self.0 {
            for issue in list {
                issues.push_raw(issue);
            }
        }
    }
}

/// `z.union([z.string().email(), z.array(z.string().email()).min(1)])`
/// with `presence`, as a list. A union settles asynchronously under
/// `zValidator` (`safeParseAsync`), after the body's synchronous checks, so
/// its issues go to `unions` for the caller to add last. Zod's async union
/// pushes them three turns after its slowest option settles: a string (or a
/// value neither option takes) settles at once, an array one turn later
/// (`Promise.all` of its items, then a `.then`), two when it has items.
fn email_or_list(
    unions: &mut Unions,
    body: &Map<String, Value>,
    key: &str,
    required: bool,
) -> Option<Vec<String>> {
    let mut issues = Issues::default();
    let value = read_email_or_list(&mut issues, body, key, required);
    if let Err(invalid) = issues.finish() {
        let turn = match body.get(key) {
            Some(Value::Array(items)) if items.is_empty() => 4,
            Some(Value::Array(_)) => 5,
            _ => 3,
        };
        unions.0.push((turn, invalid.issues().to_vec()));
        return None;
    }
    value
}

fn read_email_or_list(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    required: bool,
) -> Option<Vec<String>> {
    let email = Text {
        format: Some(Format::Email),
        ..Text::length(None, None)
    };
    match body.get(key) {
        None if !required => None,
        Some(Value::String(_)) => issues
            .text_with(body, key, Presence::Required, email)
            .into_option()
            .map(|address| vec![address]),
        Some(Value::Array(_)) => issues
            .list(
                body,
                key,
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, email),
            )
            .into_option(),
        value => {
            // Neither option takes it: Zod's `invalid_union`, as for
            // string | number, with `array` in place of `number`.
            let path = issues.path_of(key);
            let mut issue = string_or_number_issue(&path, value);
            let received = issue["unionErrors"][1]["issues"][0]["received"].clone();
            let message = if received == "undefined" {
                "Required".to_owned()
            } else {
                format!(
                    "Expected array, received {}",
                    received.as_str().unwrap_or_default()
                )
            };
            issue["unionErrors"][1]["issues"][0]["expected"] = json!("array");
            issue["unionErrors"][1]["issues"][0]["message"] = json!(message);
            issues.push_raw(issue);
            None
        }
    }
}

/// `POST /api/mail/messages/send`.
async fn send(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| {
        let mut unions = Unions::default();
        let account_id = issues
            .text(b, "accountId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        let to = email_or_list(&mut unions, b, "to", true).unwrap_or_default();
        let cc = email_or_list(&mut unions, b, "cc", false).unwrap_or_default();
        let bcc = email_or_list(&mut unions, b, "bcc", false).unwrap_or_default();
        let subject = issues
            .text(b, "subject", Presence::Required, None, Some(998))
            .into_option()
            .unwrap_or_default();
        let text_body = issues
            .text(b, "textBody", Presence::Optional, None, None)
            .into_option();
        let html_body = issues
            .text(b, "htmlBody", Presence::Optional, None, None)
            .into_option();
        let in_reply_to = issues
            .text(b, "inReplyTo", Presence::Optional, None, Some(500))
            .into_option();
        let references = issues
            .list(
                b,
                "references",
                Presence::Optional,
                None,
                Some(50),
                |issues, item| issues.item_text(item, Text::length(None, Some(500))),
            )
            .into_option();
        let thread_id = issues
            .text(b, "threadId", Presence::Optional, None, Some(255))
            .into_option();
        let idempotency_key = issues
            .text(b, "idempotencyKey", Presence::Optional, Some(1), Some(64))
            .into_option();
        unions.finish(issues);
        Compose {
            account_id,
            to,
            cc,
            bcc,
            subject,
            text_body,
            html_body,
            in_reply_to,
            references,
            thread_id,
            idempotency_key,
            ..Compose::default()
        }
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(_) => {
            return ApiError::internal()
                .with_message("Failed to send message")
                .into_response();
        }
    };
    let ctx = SendContext::new(&caller, &db, &account);
    match send_and_persist(&ctx, &input).await {
        Ok((message, pending)) => {
            created(merged(message, &[("pendingVerification", json!(pending))]))
        }
        Err(error) => send_error_response(error, "Failed to send message"),
    }
}

/// `{ ...message, ...extra }`.
fn merged(message: Value, extra: &[(&str, Value)]) -> Value {
    let mut fields = match message {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    for (key, value) in extra {
        fields.insert((*key).to_owned(), value.clone());
    }
    Value::Object(fields)
}

/// `POST /api/mail/messages/:id/reply`.
async fn reply(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| ReplyBody {
        text_body: issues
            .text(b, "textBody", Presence::Optional, None, None)
            .into_option(),
        html_body: issues
            .text(b, "htmlBody", Presence::Optional, None, None)
            .into_option(),
        reply_all: issues
            .boolean(b, "replyAll", Presence::Optional)
            .into_option()
            .unwrap_or(false),
        idempotency_key: issues
            .text(b, "idempotencyKey", Presence::Optional, Some(1), Some(64))
            .into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(_) => {
            return ApiError::internal()
                .with_message("Failed to send reply")
                .into_response();
        }
    };
    let ctx = SendContext::new(&caller, &db, &account);
    match reply_and_persist(&ctx, &id, input).await {
        Ok((message, pending)) => created(merged(
            message,
            &[
                ("pendingVerification", json!(pending)),
                ("repliedTo", json!(id)),
            ],
        )),
        Err(error) => send_error_response(error, "Failed to send reply"),
    }
}

/// `POST /api/mail/messages/:id/forward`.
async fn forward(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| {
        let mut unions = Unions::default();
        let input = ForwardBody {
            to: email_or_list(&mut unions, b, "to", true).unwrap_or_default(),
            cc: email_or_list(&mut unions, b, "cc", false).unwrap_or_default(),
            text_body: issues
                .text(b, "textBody", Presence::Optional, None, None)
                .into_option(),
            html_body: issues
                .text(b, "htmlBody", Presence::Optional, None, None)
                .into_option(),
            idempotency_key: issues
                .text(b, "idempotencyKey", Presence::Optional, Some(1), Some(64))
                .into_option(),
        };
        unions.finish(issues);
        input
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(_) => {
            return ApiError::internal()
                .with_message("Failed to forward message")
                .into_response();
        }
    };
    let ctx = SendContext::new(&caller, &db, &account);
    match forward_and_persist(&ctx, &id, input).await {
        Ok((message, pending)) => created(merged(
            message,
            &[
                ("pendingVerification", json!(pending)),
                ("forwardedFrom", json!(id)),
            ],
        )),
        Err(error) => send_error_response(error, "Failed to forward message"),
    }
}

/// `GET /api/mail/messages/:id/attachments`: ownership is checked on the
/// message.
async fn attachments(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(_) => {
            return ApiError::internal()
                .with_message("Failed to list attachments")
                .into_response();
        }
    };
    if let Err(error) = require_message(&db, &account, &id).await {
        return send_error_response(error, "Failed to list attachments");
    }
    let result = async {
        let found = attachment_rows(&db, &account, &id).await?;
        Ok(data(Value::Array(rows(found))))
    }
    .await;
    answer(result, "Failed to list attachments")
}

/// The message's live attachments, oldest first.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn attachment_rows(db: &PgPool, account: &str, message: &str) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(a) from personal_mail_attachments a
         where a.message_id = $1 and a.personal_account_id = $2 and a.deleted_at is null
         order by a.created_at",
    )
    .bind(message)
    .bind(account)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// `GET /api/mail/messages/:id`.
async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        match message_row(caller.personal()?, &account, &id).await? {
            Some(row) => Ok(data(row)),
            None => Err(ApiError::not_found("Message", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch message")
}

/// `updateBody`.
struct MessageUpdate {
    is_read: Option<bool>,
    is_starred: Option<bool>,
    is_trash: Option<bool>,
    is_spam: Option<bool>,
    labels: Option<Vec<String>>,
}

/// `[...new Set(list)]`.
fn unique(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for item in list {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// `buildMessagePatch(body, existingLabels)`: the spam flag and the labels.
fn next_labels(body: &MessageUpdate, current: &[String]) -> (Option<bool>, Option<Vec<String>>) {
    if let Some(requested) = &body.labels {
        // `nextExplicitLabels`: moving a promotion to the inbox drops Promotions.
        let labels =
            if requested.iter().any(|l| l == "INBOX") && !current.iter().any(|l| l == "INBOX") {
                requested
                    .iter()
                    .filter(|l| *l != "PROMOTIONS")
                    .cloned()
                    .collect()
            } else {
                requested.clone()
            };
        return (body.is_spam, Some(labels));
    }
    match body.is_spam {
        // `spamPatch`.
        Some(true) => {
            let mut labels: Vec<String> =
                current.iter().filter(|l| *l != "INBOX").cloned().collect();
            labels.push("SPAM".to_owned());
            (Some(true), Some(unique(labels)))
        }
        Some(false) => {
            let mut labels: Vec<String> =
                current.iter().filter(|l| *l != "SPAM").cloned().collect();
            if !labels.iter().any(|l| l == "TRASH" || l == "ARCHIVE") {
                labels.push("INBOX".to_owned());
                labels = unique(labels);
            }
            (Some(false), Some(labels))
        }
        None => (None, None),
    }
}

/// `PATCH /api/mail/messages/:id`.
async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| MessageUpdate {
        is_read: issues
            .boolean(b, "isRead", Presence::Optional)
            .into_option(),
        is_starred: issues
            .boolean(b, "isStarred", Presence::Optional)
            .into_option(),
        is_trash: issues
            .boolean(b, "isTrash", Presence::Optional)
            .into_option(),
        is_spam: issues
            .boolean(b, "isSpam", Presence::Optional)
            .into_option(),
        labels: issues
            .list(
                b,
                "labels",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::length(None, None)),
            )
            .into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    if input.is_read.is_none()
        && input.is_starred.is_none()
        && input.is_trash.is_none()
        && input.is_spam.is_none()
        && input.labels.is_none()
    {
        return ApiError::bad_request("No fields to update").into_response();
    }
    let result = async {
        let db = caller.personal()?;
        let Some(existing) = labels_of(db, &account, &id).await? else {
            return Err(Failure::from(ApiError::not_found("Message", Some(&id))));
        };
        let current: Vec<String> = existing
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let (is_spam, labels) = next_labels(&input, &current);
        let updated = update_flags(db, &id, &input, is_spam, labels.as_deref()).await?;
        // `patchClearsUnreadBanner(patch)`.
        let clears = input.is_read == Some(true)
            || input.is_trash == Some(true)
            || is_spam == Some(true)
            || labels
                .as_ref()
                .is_some_and(|labels| !labels.iter().any(|l| l == "INBOX"));
        if clears {
            queue_read_push(&caller, db.clone(), &account, vec![id.clone()]);
        }
        Ok(data(weldsuite_db::js_row(updated)))
    }
    .await;
    answer(result, "Failed to update message")
}

/// The live message's labels (`[]` when null), or `None`.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn labels_of(db: &PgPool, account: &str, id: &str) -> Result<Option<Value>, DbErr> {
    sqlx::query_scalar(
        "select coalesce(labels, '[]'::jsonb) from personal_mail_messages
         where id = $1 and personal_account_id = $2 and deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await
    .map_err(orm_error)
}

/// The flags the body set and the labels `buildMessagePatch` worked out, as
/// `to_jsonb` writes the row.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn update_flags(
    db: &PgPool,
    id: &str,
    input: &MessageUpdate,
    is_spam: Option<bool>,
    labels: Option<&[String]>,
) -> Result<Value, DbErr> {
    sqlx::query_scalar(
        "update personal_mail_messages m set
           updated_at = $2::timestamp,
           is_read = coalesce($3, is_read),
           is_starred = coalesce($4, is_starred),
           is_trash = coalesce($5, is_trash),
           is_spam = coalesce($6, is_spam),
           labels = case when $7 then $8::jsonb else labels end
         where m.id = $1
         returning to_jsonb(m)",
    )
    .bind(id)
    .bind(now_iso())
    .bind(input.is_read)
    .bind(input.is_starred)
    .bind(input.is_trash)
    .bind(is_spam)
    .bind(labels.is_some())
    .bind(labels.map(|labels| json!(labels)))
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// `IDS_PER_PUSH`.
const IDS_PER_PUSH: usize = 40;

/// `queueMailReadPush`: in the background, as `waitUntil`.
fn queue_read_push(caller: &Caller, db: PgPool, account: &str, ids: Vec<String>) {
    let http = caller.http.clone();
    let user = caller.user_id.clone();
    let account = account.to_owned();
    caller.state.tracker.spawn(async move {
        send_personal_read_push(&db, http.as_ref(), &user, &account, &ids).await;
    });
}

/// `buildMailReadPushMessages(tokens, { emailIds, inboxUnread, tenantKind: 'personal' })`.
fn build_messages(tokens: &[String], ids: &[String], unread: Option<i64>) -> Vec<Value> {
    let ids: Vec<String> = unique(ids.iter().filter(|id| !id.is_empty()).cloned().collect());
    let mut out = Vec::new();
    for to in tokens {
        for chunk in ids.chunks(IDS_PER_PUSH) {
            let mut data = json!({
                "type": "email_read",
                "emailIds": chunk.join(","),
                "tenantKind": "personal",
            });
            let mut message = json!({ "to": to, "_contentAvailable": true, "priority": "normal" });
            if let Some(unread) = unread {
                message["badge"] = json!(unread);
                data["inboxUnread"] = Value::String(unread.to_string());
            }
            message["data"] = data;
            out.push(message);
        }
    }
    out
}

/// `sendPersonalMailReadPush(db, { clerkUserId, personalAccountId, emailIds })`.
async fn send_personal_read_push(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    user: &str,
    account: &str,
    ids: &[String],
) {
    if ids.is_empty() {
        return;
    }
    let run = async {
        let tokens = push_tokens(db, user).await?;
        if tokens.is_empty() {
            return Ok::<(), DbErr>(());
        }
        let unread = match inbox_unread(db, account).await {
            Ok(count) => Some(count),
            Err(error) => {
                tracing::error!(%error, "[MailReadPush] Failed to count unread inbox messages");
                None
            }
        };
        let messages = build_messages(&tokens, ids, unread);
        let result = weldsuite_notifications::send_expo_push(http, messages).await;
        let mut invalid: Vec<String> = Vec::new();
        for token in result.invalid_tokens.into_iter().filter(|t| !t.is_empty()) {
            if !invalid.contains(&token) {
                invalid.push(token);
            }
        }
        for token in invalid {
            if let Err(error) = deactivate_token(db, &token).await {
                tracing::error!(%error, "[MailReadPush] Failed to deactivate token");
            }
        }
        Ok(())
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[MailReadPush] Personal push failed for {user}");
    }
}

/// The user's active WeldMail push tokens.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn push_tokens(db: &PgPool, user: &str) -> Result<Vec<String>, DbErr> {
    sqlx::query_scalar(
        "select token from personal_device_tokens
         where clerk_user_id = $1 and app_code = 'weldmail' and is_active is null",
    )
    .bind(user)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// The account's unread inbox messages (the badge).
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn inbox_unread(db: &PgPool, account: &str) -> Result<i64, DbErr> {
    sqlx::query_scalar(
        "select count(*)::int8 from personal_mail_messages
         where personal_account_id = $1 and is_read = false and is_trash = false
           and deleted_at is null and labels @> '[\"INBOX\"]'::jsonb",
    )
    .bind(account)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// A token Expo refused, deactivated now.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn deactivate_token(db: &PgPool, token: &str) -> Result<(), DbErr> {
    let now = now_iso();
    sqlx::query(
        "update personal_device_tokens set is_active = $2::timestamp, updated_at = $2::timestamp
         where token = $1",
    )
    .bind(token)
    .bind(&now)
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(labels: Option<&[&str]>, is_spam: Option<bool>) -> MessageUpdate {
        MessageUpdate {
            is_read: None,
            is_starred: None,
            is_trash: None,
            is_spam,
            labels: labels.map(|l| l.iter().map(|s| (*s).to_owned()).collect()),
        }
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn spam_and_labels_move_together() {
        assert_eq!(
            next_labels(
                &update(None, Some(true)),
                &strings(&["INBOX", "PROMOTIONS"])
            ),
            (Some(true), Some(strings(&["PROMOTIONS", "SPAM"])))
        );
        assert_eq!(
            next_labels(
                &update(None, Some(false)),
                &strings(&["PROMOTIONS", "SPAM"])
            ),
            (Some(false), Some(strings(&["PROMOTIONS", "INBOX"])))
        );
        assert_eq!(
            next_labels(
                &update(Some(&["INBOX", "PROMOTIONS"]), None),
                &strings(&["SENT"])
            ),
            (None, Some(strings(&["INBOX"])))
        );
        assert!(coerce_boolean(Some(&json!("false"))));
        assert!(!coerce_boolean(Some(&json!(""))));
        assert_eq!(escape_like("50%_a\\"), "50\\%\\_a\\\\");
    }
}
