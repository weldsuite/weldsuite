//! Personal mailboxes: `/api/mail/accounts` (`routes/mail-accounts.ts`),
//! `/api/mail/labels` (`routes/mail-labels.ts`) and `/api/mail/drafts`
//! (`routes/mail-drafts.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use axum::routing::get;
use http::HeaderMap;
use sea_orm::DbErr;
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, orm_error};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};

use crate::PersonalState;
use crate::booking_pages::cursor_of;
use crate::caller::{
    Caller, Failure, answer, created, data, no_content, rows, validate, validate_query,
};
use crate::events::page;
use crate::js::now_iso;
use crate::mail_send::mail_account_row;

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/mail/accounts", get(list_accounts))
        .route("/api/mail/accounts/{id}", get(get_account))
        .route("/api/mail/labels", get(list_labels))
        .route("/api/mail/drafts", get(list_drafts).post(create_draft))
        .route(
            "/api/mail/drafts/{id}",
            axum::routing::patch(update_draft).delete(remove_draft),
        )
}

/// Whether the account owns a live mailbox (`assertAccountOwned`).
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
pub(crate) async fn owns_mailbox(db: &PgPool, account: &str, mailbox: &str) -> Result<bool, DbErr> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from personal_mail_accounts
         where id = $1 and personal_account_id = $2 and deleted_at is null limit 1",
    )
    .bind(mailbox)
    .bind(account)
    .fetch_optional(db)
    .await
    .map_err(orm_error)?;
    Ok(found.is_some())
}

/// The account's live mailboxes, newest first.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn mailboxes(db: &PgPool, account: &str) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(a) from personal_mail_accounts a
         where a.personal_account_id = $1 and a.deleted_at is null
         order by a.created_at desc",
    )
    .bind(account)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// The mailbox's live labels, by position, then name.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn labels(db: &PgPool, account: &str, mailbox: &str) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(l) from personal_mail_labels l
         where l.personal_account_id = $1 and l.account_id = $2 and l.deleted_at is null
         order by l.position, l.name",
    )
    .bind(account)
    .bind(mailbox)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// `GET /api/mail/accounts`: newest first.
async fn list_accounts(caller: Caller) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let found = mailboxes(caller.personal()?, &account).await?;
        Ok(data(Value::Array(rows(found))))
    }
    .await;
    answer(result, "Failed to list mail accounts")
}

/// `GET /api/mail/accounts/:id`.
async fn get_account(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        match mail_account_row(caller.personal()?, &account, &id).await? {
            Some(row) => Ok(data(row)),
            None => Err(ApiError::not_found("Mail account", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch mail account")
}

/// `GET /api/mail/labels?accountId=`: by position, then name.
async fn list_labels(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let mailbox = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "accountId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(mailbox) => mailbox,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if !owns_mailbox(db, &account, &mailbox).await? {
            return Err(Failure::from(ApiError::not_found(
                "Mail account",
                Some(&mailbox),
            )));
        }
        let found = labels(db, &account, &mailbox).await?;
        Ok(data(Value::Array(rows(found))))
    }
    .await;
    answer(result, "Failed to list labels")
}

/// `GET /api/mail/drafts?accountId=&limit=&cursor=`: by last change.
async fn list_drafts(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        (
            issues
                .text(q, "accountId", Presence::Optional, None, None)
                .into_option(),
            issues
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
            issues
                .text(q, "cursor", Presence::Optional, None, None)
                .into_option(),
        )
    }) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let (mailbox, limit, cursor) = query;
    let mailbox = mailbox.filter(|m| !m.is_empty());
    let cursor = cursor.filter(|c| !c.is_empty());
    let limit = limit.unwrap_or(50).min(100);
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if let Some(mailbox) = &mailbox
            && !owns_mailbox(db, &account, mailbox).await?
        {
            return Err(Failure::from(ApiError::not_found("Mail account", Some(mailbox))));
        }
        let cursor_row = cursor_of(
            db,
            "select to_jsonb(d.updated_at), d.id from personal_mail_drafts d where d.id = $1 limit 1",
            cursor.as_ref(),
        )
        .await?;
        let found = draft_rows(db, &account, mailbox.as_deref(), &cursor_row, limit).await?;
        // `filters.cursor ? conditions.slice(0, -1) : conditions`: with a
        // cursor that matched no draft, the last filter goes instead of it.
        let dropped = cursor.is_some() && cursor_row.0.is_none();
        let total = count_drafts(db, &account, mailbox.as_deref(), dropped).await?;
        Ok(page(rows(found), limit, total))
    }
    .await;
    answer(result, "Failed to list drafts")
}

/// The account's live drafts (of one mailbox), by last change, after the
/// cursor: one more than `limit`.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn draft_rows(
    db: &PgPool,
    account: &str,
    mailbox: Option<&str>,
    cursor: &(Option<String>, Option<String>),
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(d) from personal_mail_drafts d
         where d.personal_account_id = $1 and d.deleted_at is null
           and ($2::text is null or d.account_id = $2)
           and ($3::timestamp is null
                or (d.updated_at < $3::timestamp or (d.updated_at = $3::timestamp and d.id < $4)))
         order by d.updated_at desc, d.id desc
         limit $5",
    )
    .bind(account)
    .bind(mailbox)
    .bind(&cursor.0)
    .bind(&cursor.1)
    .bind(limit + 1)
    .fetch_all(db)
    .await
    .map_err(orm_error)
}

/// The drafts' total; `dropped` (a cursor that matched no draft) drops the
/// last filter.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn count_drafts(
    db: &PgPool,
    account: &str,
    mailbox: Option<&str>,
    dropped: bool,
) -> Result<i64, DbErr> {
    sqlx::query_scalar(
        "select count(*)::int8 from personal_mail_drafts d
         where d.personal_account_id = $1 and ($3 or d.deleted_at is null)
           and ($2::text is null or $4 or d.account_id = $2)",
    )
    .bind(account)
    .bind(mailbox)
    .bind(dropped && mailbox.is_none())
    .bind(dropped && mailbox.is_some())
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// The draft schema's shared fields (`baseBody`), as parsed: every field the
/// body set.
fn read_draft(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> Map<String, Value> {
    let mut out = Map::new();
    if create
        && let Some(account) = issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
    {
        out.insert("accountId".to_owned(), Value::String(account));
    }
    let any = Text::length(None, None);
    let text =
        |issues: &mut Issues, out: &mut Map<String, Value>, key: &str, max: Option<usize>| {
            if let Some(value) = issues
                .text(body, key, Presence::Optional, None, max)
                .into_option()
            {
                out.insert(key.to_owned(), Value::String(value));
            }
        };
    let strings = |issues: &mut Issues, out: &mut Map<String, Value>, key: &str| {
        let list = issues.list(body, key, Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, any).map(Value::String)
        });
        if let Some(list) = list.into_option() {
            out.insert(key.to_owned(), Value::Array(list));
        }
    };
    text(issues, &mut out, "subject", Some(998));
    strings(issues, &mut out, "to");
    strings(issues, &mut out, "cc");
    strings(issues, &mut out, "bcc");
    strings(issues, &mut out, "replyTo");
    text(issues, &mut out, "body", None);
    text(issues, &mut out, "htmlBody", None);
    if let Some(importance) = issues
        .choice(
            body,
            "importance",
            Presence::Optional,
            &["low", "normal", "high"],
        )
        .into_option()
    {
        out.insert("importance".to_owned(), Value::String(importance));
    }
    strings(issues, &mut out, "labels");
    strings(issues, &mut out, "attachmentIds");
    text(issues, &mut out, "inReplyTo", Some(500));
    text(issues, &mut out, "originalMessageId", None);
    for key in ["isReply", "isForward"] {
        if let Some(flag) = issues.boolean(body, key, Presence::Optional).into_option() {
            out.insert(key.to_owned(), Value::Bool(flag));
        }
    }
    out
}

/// `POST /api/mail/drafts`.
async fn create_draft(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_draft(issues, b, true)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        let mailbox = input["accountId"].as_str().unwrap_or_default().to_owned();
        if !owns_mailbox(db, &account, &mailbox).await? {
            return Err(Failure::from(ApiError::not_found(
                "Mail account",
                Some(&mailbox),
            )));
        }
        let row = insert_draft(db, &account, &mailbox, &input).await?;
        Ok(created(weldsuite_db::js_row(row)))
    }
    .await;
    answer(result, "Failed to create draft")
}

/// The new draft, as `to_jsonb` writes it.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn insert_draft(
    db: &PgPool,
    account: &str,
    mailbox: &str,
    input: &Map<String, Value>,
) -> Result<Value, DbErr> {
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let json = |key: &str| input.get(key).cloned();
    let attachments = input
        .get("attachmentIds")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let now = now_iso();
    sqlx::query_scalar(
        "insert into personal_mail_drafts
           (id, personal_account_id, account_id, subject, \"to\", cc, bcc, reply_to, body, html_body,
            importance, labels, attachment_ids, has_attachments, attachment_count, in_reply_to,
            original_message_id, is_reply, is_forward, last_auto_saved_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11,
                 $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19,
                 $20::timestamp, $20::timestamp, $20::timestamp)
         returning to_jsonb(personal_mail_drafts)",
    )
    .bind(weldsuite_kit::generate_id("draft"))
    .bind(account)
    .bind(mailbox)
    .bind(text("subject"))
    .bind(json("to"))
    .bind(json("cc"))
    .bind(json("bcc"))
    .bind(json("replyTo"))
    .bind(text("body"))
    .bind(text("htmlBody"))
    .bind(text("importance").unwrap_or_else(|| "normal".to_owned()))
    .bind(json("labels"))
    .bind(json("attachmentIds"))
    .bind(attachments > 0)
    .bind(i32::try_from(attachments).unwrap_or(i32::MAX))
    .bind(text("inReplyTo"))
    .bind(text("originalMessageId"))
    .bind(input.get("isReply").and_then(Value::as_bool).unwrap_or(false))
    .bind(input.get("isForward").and_then(Value::as_bool).unwrap_or(false))
    .bind(&now)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// Whether the account has the live draft.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn find_draft(db: &PgPool, account: &str, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from personal_mail_drafts
         where id = $1 and personal_account_id = $2 and deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await
    .map_err(orm_error)?;
    Ok(found.is_some())
}

/// `PATCH /api/mail/drafts/:id` (`buildDraftPatch`).
async fn update_draft(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_draft(issues, b, false)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if !find_draft(db, &account, &id).await? {
            return Err(Failure::from(ApiError::not_found("Draft", Some(&id))));
        }
        let row = update_draft_row(db, &id, &input).await?;
        Ok(data(weldsuite_db::js_row(row)))
    }
    .await;
    answer(result, "Failed to update draft")
}

/// `buildDraftPatch`: the fields the body set, as `to_jsonb` writes the row.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn update_draft_row(
    db: &PgPool,
    id: &str,
    input: &Map<String, Value>,
) -> Result<Value, DbErr> {
    let set = |key: &str| input.contains_key(key);
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let json = |key: &str| input.get(key).cloned();
    let flag = |key: &str| input.get(key).and_then(Value::as_bool);
    let attachments = input
        .get("attachmentIds")
        .and_then(Value::as_array)
        .map(Vec::len);
    sqlx::query_scalar(
        "update personal_mail_drafts d set
           updated_at = $2::timestamp, last_auto_saved_at = $2::timestamp,
           subject = case when $3 then $4 else subject end,
           \"to\" = case when $5 then $6::jsonb else \"to\" end,
           cc = case when $7 then $8::jsonb else cc end,
           bcc = case when $9 then $10::jsonb else bcc end,
           reply_to = case when $11 then $12::jsonb else reply_to end,
           body = case when $13 then $14 else body end,
           html_body = case when $15 then $16 else html_body end,
           importance = case when $17 then $18 else importance end,
           labels = case when $19 then $20::jsonb else labels end,
           in_reply_to = case when $21 then $22 else in_reply_to end,
           original_message_id = case when $23 then $24 else original_message_id end,
           is_reply = case when $25 then $26 else is_reply end,
           is_forward = case when $27 then $28 else is_forward end,
           attachment_ids = case when $29 then $30::jsonb else attachment_ids end,
           has_attachments = case when $29 then $31 else has_attachments end,
           attachment_count = case when $29 then $32 else attachment_count end
         where d.id = $1
         returning to_jsonb(d)",
    )
    .bind(id)
    .bind(now_iso())
    .bind(set("subject"))
    .bind(text("subject"))
    .bind(set("to"))
    .bind(json("to"))
    .bind(set("cc"))
    .bind(json("cc"))
    .bind(set("bcc"))
    .bind(json("bcc"))
    .bind(set("replyTo"))
    .bind(json("replyTo"))
    .bind(set("body"))
    .bind(text("body"))
    .bind(set("htmlBody"))
    .bind(text("htmlBody"))
    .bind(set("importance"))
    .bind(text("importance"))
    .bind(set("labels"))
    .bind(json("labels"))
    .bind(set("inReplyTo"))
    .bind(text("inReplyTo"))
    .bind(set("originalMessageId"))
    .bind(text("originalMessageId"))
    .bind(set("isReply"))
    .bind(flag("isReply"))
    .bind(set("isForward"))
    .bind(flag("isForward"))
    .bind(attachments.is_some())
    .bind(json("attachmentIds"))
    .bind(attachments.is_some_and(|n| n > 0))
    .bind(attachments.and_then(|n| i32::try_from(n).ok()))
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// `DELETE /api/mail/drafts/:id`: soft delete.
async fn remove_draft(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if !find_draft(db, &account, &id).await? {
            return Err(Failure::from(ApiError::not_found("Draft", Some(&id))));
        }
        soft_delete_draft(db, &id).await?;
        Ok(no_content())
    }
    .await;
    answer(result, "Failed to delete draft")
}

#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn soft_delete_draft(db: &PgPool, id: &str) -> Result<(), DbErr> {
    sqlx::query(
        "update personal_mail_drafts set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(now_iso())
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}
