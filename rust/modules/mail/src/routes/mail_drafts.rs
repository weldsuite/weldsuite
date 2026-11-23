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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    MAIL_DRAFT_CREATED, MAIL_DRAFT_DELETED, MAIL_DRAFT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    MESSAGES_CREATE, MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::mail_drafts;

use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, MailResult, answer, list_response, page, validate, validate_query};
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

/// A draft row as Drizzle returns it.
fn js(draft: mail_drafts::Model) -> Result<Value, DbErr> {
    serde_json::to_value(draft).map_err(|error| DbErr::Json(error.to_string()))
}

/// The cursor's `updated_at` as the keyset compares it: the
/// `to_char(…, '…SS.MS')` text, so to the millisecond (truncated).
pub(crate) fn to_millis(at: PrimitiveDateTime) -> PrimitiveDateTime {
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

/// `listDrafts(db, filters)`: newest edit first.
async fn list_drafts(
    caller: &Caller,
    account: Option<&str>,
    accessible: Option<&[String]>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Response, DbErr> {
    let limit = limit.min(100);
    let db = orm(&caller.db);
    let cursor_row: Option<(PrimitiveDateTime, String)> = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => {
            mail_drafts::Entity::find_by_id(cursor.to_owned())
                .select_only()
                .columns([mail_drafts::Column::UpdatedAt, mail_drafts::Column::Id])
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let mut scope = Condition::all().add(mail_drafts::Column::DeletedAt.is_null());
    if let Some(account) = account {
        scope = scope.add(mail_drafts::Column::AccountId.eq(account));
    }
    if let Some(accessible) = accessible {
        scope = scope.add(mail_drafts::Column::AccountId.is_in(accessible.iter().cloned()));
    }
    let mut page_scope = scope.clone();
    if let Some((at, id)) = cursor_row {
        let at = to_millis(at);
        page_scope = page_scope.add(
            Condition::any()
                .add(mail_drafts::Column::UpdatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(mail_drafts::Column::UpdatedAt.eq(at))
                        .add(mail_drafts::Column::Id.lt(id)),
                ),
        );
    }
    let rows = mail_drafts::Entity::find()
        .filter(page_scope)
        .order_by_desc(mail_drafts::Column::UpdatedAt)
        .order_by_desc(mail_drafts::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await?;
    let total = mail_drafts::Entity::find().filter(scope).count(&db).await?;
    let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
    let (data, has_more, next) = page(rows, limit);
    Ok(list_response(
        data,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
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
        (
            account.into_option(),
            limit.into_option(),
            cursor.into_option(),
        )
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
        let row = mail_drafts::Entity::find_by_id(id.to_owned())
            .filter(mail_drafts::Column::DeletedAt.is_null())
            .filter(mail_drafts::Column::AccountId.is_in(accessible))
            .one(&orm(&caller.db))
            .await?;
        if let Some(row) = row {
            return Ok(js(row)?);
        }
    }
    let exists: Option<String> = mail_drafts::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(mail_drafts::Column::Id)
        .filter(mail_drafts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
        if let Some(v) = issues
            .text(body, key, Presence::Optional, None, None)
            .into_option()
        {
            out.insert(key.into(), Value::String(v));
        }
    }
    if let Some(v) = issues
        .choice(
            body,
            "importance",
            Presence::Optional,
            &["low", "normal", "high"],
        )
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

fn attachment_count(data: &Map<String, Value>) -> Option<i32> {
    data.get("attachmentIds")
        .and_then(Value::as_array)
        .map(|ids| i32::try_from(ids.len()).unwrap_or(i32::MAX))
}

fn owned(data: &Map<String, Value>, key: &str) -> Option<String> {
    text(data, key).map(str::to_owned)
}

async fn draft_row(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = mail_drafts::Entity::find_by_id(id.to_owned())
        .filter(mail_drafts::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(js).transpose()
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
        let at = utc_now();
        mail_drafts::Entity::insert(mail_drafts::ActiveModel {
            id: Set(id.clone()),
            account_id: Set(account.clone()),
            subject: Set(owned(&data, "subject")),
            to: Set(data.get("to").cloned()),
            cc: Set(data.get("cc").cloned()),
            bcc: Set(data.get("bcc").cloned()),
            reply_to: Set(data.get("replyTo").cloned()),
            body: Set(owned(&data, "body")),
            html_body: Set(owned(&data, "htmlBody")),
            importance: Set(Some(
                text(&data, "importance").unwrap_or("normal").to_owned(),
            )),
            labels: Set(data.get("labels").cloned()),
            attachment_ids: Set(data.get("attachmentIds").cloned()),
            in_reply_to: Set(owned(&data, "inReplyTo")),
            original_message_id: Set(owned(&data, "originalMessageId")),
            is_reply: Set(Some(flag(&data, "isReply").unwrap_or(false))),
            is_forward: Set(Some(flag(&data, "isForward").unwrap_or(false))),
            has_attachments: Set(Some(count > 0)),
            attachment_count: Set(Some(count)),
            last_auto_saved_at: Set(Some(at)),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
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
        write_update(&caller, &id, &data).await?;
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

/// `updateDraft`'s write: the fields the body sent, `updatedAt` and
/// `lastAutoSavedAt`.
async fn write_update(caller: &Caller, id: &str, data: &Map<String, Value>) -> Result<(), DbErr> {
    let at = utc_now();
    let mut update = mail_drafts::Entity::update_many()
        .col_expr(mail_drafts::Column::UpdatedAt, Expr::value(at))
        .col_expr(mail_drafts::Column::LastAutoSavedAt, Expr::value(at));
    for (key, column) in [
        ("subject", mail_drafts::Column::Subject),
        ("body", mail_drafts::Column::Body),
        ("htmlBody", mail_drafts::Column::HtmlBody),
        ("importance", mail_drafts::Column::Importance),
        ("inReplyTo", mail_drafts::Column::InReplyTo),
        ("originalMessageId", mail_drafts::Column::OriginalMessageId),
    ] {
        if let Some(value) = owned(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    for (key, column) in [
        ("to", mail_drafts::Column::To),
        ("cc", mail_drafts::Column::Cc),
        ("bcc", mail_drafts::Column::Bcc),
        ("replyTo", mail_drafts::Column::ReplyTo),
        ("labels", mail_drafts::Column::Labels),
        ("attachmentIds", mail_drafts::Column::AttachmentIds),
    ] {
        if let Some(value) = data.get(key) {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    for (key, column) in [
        ("isReply", mail_drafts::Column::IsReply),
        ("isForward", mail_drafts::Column::IsForward),
    ] {
        if let Some(value) = flag(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(count) = attachment_count(data) {
        update = update
            .col_expr(mail_drafts::Column::HasAttachments, Expr::value(count > 0))
            .col_expr(mail_drafts::Column::AttachmentCount, Expr::value(count));
    }
    update
        .filter(mail_drafts::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `DELETE /:id` (`softDeleteDraft`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let located = locate(&caller, &id).await?;
        let account = located["accountId"].as_str().unwrap_or_default().to_owned();
        let at = utc_now();
        let done = mail_drafts::Entity::update_many()
            .col_expr(mail_drafts::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_drafts::Column::UpdatedAt, Expr::value(at))
            .filter(mail_drafts::Column::Id.eq(&id))
            .filter(mail_drafts::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        if done.rows_affected == 0 {
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
