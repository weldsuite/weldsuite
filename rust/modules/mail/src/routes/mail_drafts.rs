//! `/api/mail-drafts` (`routes/mail-drafts/index.ts`, `@weldsuite/mail-domain/drafts`):
//! a mailbox's drafts. A draft in a mailbox closed to the caller is a 403,
//! a missing one a 404 (`postgres` mode).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_DRAFT_CREATED, MAIL_DRAFT_DELETED, MAIL_DRAFT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    MESSAGES_CREATE, MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{
    MailError, MailResult, answer, list_response, now, page, validate, validate_query,
};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-drafts",
            get(list).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-drafts",
            post(create).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .route(
            "/mail-drafts/{id}",
            get(detail).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-drafts/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-drafts/{id}",
            axum::routing::delete(remove).route_layer(gate.require([MESSAGES_DELETE])),
        )
        .with_state(state)
}

/// `listDrafts(db, filters)`: newest edit first.
async fn list_drafts(
    caller: &Caller,
    account: Option<&str>,
    accessible: Option<&[String]>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Response, sqlx::Error> {
    let limit = limit.min(100);
    let cursor_row: Option<(String, String)> = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => {
            sqlx::query_as(
                "select to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
                 from mail_drafts where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await?
        }
        None => None,
    };
    let (cursor_at, cursor_id) = cursor_row.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from mail_drafts d
         where d.deleted_at is null and ($1::text is null or d.account_id = $1)
           and ($2::text[] is null or d.account_id = any($2::text[]))
           and ($3::timestamp is null or (d.updated_at < $3::timestamp
                or (d.updated_at = $3::timestamp and d.id < $4)))
         order by d.updated_at desc, d.id desc limit $5",
    )
    .bind(account)
    .bind(accessible)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from mail_drafts d
         where d.deleted_at is null and ($1::text is null or d.account_id = $1)
           and ($2::text[] is null or d.account_id = any($2::text[]))",
    )
    .bind(account)
    .bind(accessible)
    .fetch_one(&caller.db)
    .await?;
    let rows = rows.into_iter().map(js_row).collect();
    let (data, has_more, next) = page(rows, limit);
    Ok(list_response(data, i64::from(total), has_more, next))
}

/// `GET /`.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let account = issues.text(q, "accountId", Presence::Optional, None, None);
        let limit = issues.whole_number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        (account.into_option(), limit.into_option(), cursor.into_option())
    });
    let (account, limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let limit = limit.unwrap_or(50);
        if let Some(account) = account.filter(|a| !a.is_empty()) {
            if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                return Err(MailError::forbidden(NO_ACCESS));
            }
            return Ok(list_drafts(&caller, Some(&account), None, limit, cursor.as_deref()).await?);
        }
        let ids = accessible_account_ids(&caller.db, &caller.user_id).await?;
        if ids.is_empty() {
            return Ok(list_response(Vec::new(), 0, false, None));
        }
        Ok(list_drafts(&caller, None, Some(&ids), limit, cursor.as_deref()).await?)
    }
    .await;
    answer(result, "Failed to list drafts")
}

/// `locateDraftOrRespond`: the draft among the caller's mailboxes, or 404 /
/// 403.
async fn locate(caller: &Caller, id: &str) -> MailResult<Value> {
    let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
    if !accessible.is_empty() {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from mail_drafts d
             where d.id = $1 and d.deleted_at is null and d.account_id = any($2::text[]) limit 1",
        )
        .bind(id)
        .bind(&accessible)
        .fetch_optional(&caller.db)
        .await?;
        if let Some(row) = row {
            return Ok(js_row(row));
        }
    }
    let exists: Option<String> =
        sqlx::query_scalar("select id from mail_drafts where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    match exists {
        None => Err(MailError::not_found("Draft", Some(id))),
        Some(_) => Err(MailError::forbidden(NO_ACCESS)),
    }
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async { Ok(Data(locate(&caller, &id).await?).into_response()) }.await;
    answer(result, "Failed to fetch draft")
}

/// `baseBody`, in its order.
fn read_draft(issues: &mut Issues, body: &Map<String, Value>, out: &mut Map<String, Value>) {
    let mut text = |issues: &mut Issues, key: &str, max: Option<usize>| {
        if let Some(v) = issues
            .text(body, key, Presence::Optional, None, max)
            .into_option()
        {
            out.insert(key.into(), Value::String(v));
        }
    };
    text(issues, "subject", Some(998));
    let list = |issues: &mut Issues, key: &str| {
        issues
            .list(body, key, Presence::Optional, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
            .into_option()
    };
    for key in ["to", "cc", "bcc", "replyTo"] {
        if let Some(v) = list(issues, key) {
            out.insert(key.into(), json!(v));
        }
    }
    for key in ["body", "htmlBody"] {
        if let Some(v) = issues.text(body, key, Presence::Optional, None, None).into_option() {
            out.insert(key.into(), Value::String(v));
        }
    }
    if let Some(v) = issues
        .choice(body, "importance", Presence::Optional, &["low", "normal", "high"])
        .into_option()
    {
        out.insert("importance".into(), Value::String(v));
    }
    for key in ["labels", "attachmentIds"] {
        if let Some(v) = list(issues, key) {
            out.insert(key.into(), json!(v));
        }
    }
    if let Some(v) = issues
        .text(body, "inReplyTo", Presence::Optional, None, Some(500))
        .into_option()
    {
        out.insert("inReplyTo".into(), Value::String(v));
    }
    if let Some(v) = issues
        .text(body, "originalMessageId", Presence::Optional, None, None)
        .into_option()
    {
        out.insert("originalMessageId".into(), Value::String(v));
    }
    for key in ["isReply", "isForward"] {
        if let Some(v) = issues.boolean(body, key, Presence::Optional).into_option() {
            out.insert(key.into(), Value::Bool(v));
        }
    }
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

fn attachment_count(data: &Map<String, Value>) -> Option<i64> {
    data.get("attachmentIds")
        .and_then(Value::as_array)
        .map(|ids| i64::try_from(ids.len()).unwrap_or_default())
}

async fn draft_row(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from mail_drafts d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

/// `POST /` (`createDraft`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = validate(&headers, &body, |issues, body| {
        let mut out = Map::new();
        if let Some(account) = issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
        {
            out.insert("accountId".into(), Value::String(account));
        }
        read_draft(issues, body, &mut out);
        out
    });
    let data = match data {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = text(&data, "accountId").unwrap_or_default().to_owned();
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let id = generate_id("draft");
        let count = attachment_count(&data).unwrap_or(0);
        sqlx::query(
            "insert into mail_drafts (id, account_id, subject, \"to\", cc, bcc, reply_to, body,
               html_body, importance, labels, attachment_ids, in_reply_to, original_message_id,
               is_reply, is_forward, has_attachments, attachment_count, last_auto_saved_at,
               created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 'normal'), $11, $12, $13,
               $14, coalesce($15, false), coalesce($16, false), $17, $18, $19::timestamp,
               $19::timestamp, $19::timestamp)",
        )
        .bind(&id)
        .bind(&account)
        .bind(text(&data, "subject"))
        .bind(data.get("to").cloned())
        .bind(data.get("cc").cloned())
        .bind(data.get("bcc").cloned())
        .bind(data.get("replyTo").cloned())
        .bind(text(&data, "body"))
        .bind(text(&data, "htmlBody"))
        .bind(text(&data, "importance"))
        .bind(data.get("labels").cloned())
        .bind(data.get("attachmentIds").cloned())
        .bind(text(&data, "inReplyTo"))
        .bind(text(&data, "originalMessageId"))
        .bind(flag(&data, "isReply"))
        .bind(flag(&data, "isForward"))
        .bind(count > 0)
        .bind(count)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row = draft_row(&caller, &id)
            .await?
            .filter(|row| row["accountId"].as_str() == Some(account.as_str()));
        let Some(row) = row else {
            return Err(MailError::api(
                ApiError::internal().with_message("Failed to create draft"),
            ));
        };
        caller.publish(
            &state,
            MAIL_DRAFT_CREATED,
            &id,
            &json!({ "id": id, "accountId": row["accountId"], "subject": row["subject"] }),
        );
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create draft")
}

/// `PUT|PATCH /:id` (`updateDraft`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = validate(&headers, &body, |issues, body| {
        let mut out = Map::new();
        read_draft(issues, body, &mut out);
        out
    });
    let data = match data {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let located = locate(&caller, &id).await?;
        let account = located["accountId"].as_str().unwrap_or_default().to_owned();
        if draft_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Draft", Some(&id)));
        }
        let count = attachment_count(&data);
        sqlx::query(
            "update mail_drafts set updated_at = $2::timestamp, last_auto_saved_at = $2::timestamp,
               subject = coalesce($3, subject), \"to\" = coalesce($4, \"to\"), cc = coalesce($5, cc),
               bcc = coalesce($6, bcc), reply_to = coalesce($7, reply_to), body = coalesce($8, body),
               html_body = coalesce($9, html_body), importance = coalesce($10, importance),
               labels = coalesce($11, labels), attachment_ids = coalesce($12, attachment_ids),
               in_reply_to = coalesce($13, in_reply_to),
               original_message_id = coalesce($14, original_message_id),
               is_reply = coalesce($15, is_reply), is_forward = coalesce($16, is_forward),
               has_attachments = case when $17::bigint is null then has_attachments else $17 > 0 end,
               attachment_count = coalesce($17::int, attachment_count)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text(&data, "subject"))
        .bind(data.get("to").cloned())
        .bind(data.get("cc").cloned())
        .bind(data.get("bcc").cloned())
        .bind(data.get("replyTo").cloned())
        .bind(text(&data, "body"))
        .bind(text(&data, "htmlBody"))
        .bind(text(&data, "importance"))
        .bind(data.get("labels").cloned())
        .bind(data.get("attachmentIds").cloned())
        .bind(text(&data, "inReplyTo"))
        .bind(text(&data, "originalMessageId"))
        .bind(flag(&data, "isReply"))
        .bind(flag(&data, "isForward"))
        .bind(count)
        .execute(&caller.db)
        .await?;
        let after = draft_row(&caller, &id)
            .await?
            .filter(|row| row["accountId"].as_str() == Some(account.as_str()));
        let Some(after) = after else {
            return Err(MailError::not_found("Draft", Some(&id)));
        };
        caller.publish(
            &state,
            MAIL_DRAFT_UPDATED,
            &id,
            &json!({ "id": id, "accountId": after["accountId"], "subject": after["subject"] }),
        );
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update draft")
}

/// `DELETE /:id` (`softDeleteDraft`).
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let located = locate(&caller, &id).await?;
        let account = located["accountId"].as_str().unwrap_or_default().to_owned();
        let at = now();
        let done = sqlx::query(
            "update mail_drafts set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        if done.rows_affected() == 0 {
            return Err(MailError::not_found("Draft", Some(&id)));
        }
        caller.publish(
            &state,
            MAIL_DRAFT_DELETED,
            &id,
            &json!({ "id": id, "accountId": account, "subject": null }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete draft")
}
