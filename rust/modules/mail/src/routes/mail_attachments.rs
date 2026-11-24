//! `/api/mail-attachments` (`routes/mail-attachments/index.ts`,
//! `@weldsuite/mail-domain/attachments`): attachment rows of messages in the
//! caller's mailboxes, their download from storage, and moving uploaded
//! attachments onto a message. Rows never carry their storage path or
//! download URL out.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use sea_orm::sea_query::{Asterisk, Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    MAIL_ATTACHMENT_CREATED, MAIL_ATTACHMENT_DELETED, MAIL_ATTACHMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    MESSAGES_CREATE, MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::cursor::encode_uri_component;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::accessible_account_ids;
use weldsuite_mail_domain::messages::public_attachment;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{mail_attachments, mail_messages};

use super::mail_messages::locate_message;
use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, MailResult, answer, validate};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([MESSAGES_READ]);
    Router::new()
        .route(
            "/mail-attachments/message/{message_id}",
            get(list_for_message).route_layer(read()),
        )
        .route(
            "/mail-attachments/associate",
            post(associate).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-attachments/{id}/download",
            get(download).route_layer(read()),
        )
        .route("/mail-attachments/{id}", get(detail).route_layer(read()))
        .route(
            "/mail-attachments",
            post(create).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .route(
            "/mail-attachments/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-attachments/{id}",
            axum::routing::delete(remove).route_layer(gate.require([MESSAGES_DELETE])),
        )
        .with_state(state)
}

/// `isWorkspaceStorageKey(key, [clerkOrgId, workspaceId])`.
fn is_workspace_storage_key(caller: &Caller, key: &str) -> bool {
    if key.contains("..") {
        return false;
    }
    [caller.org_id.as_deref(), Some(caller.workspace_id.as_str())]
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .any(|id| {
            key.starts_with(&format!("workspaces/{id}/")) || key.starts_with(&format!("mail/{id}/"))
        })
}

/// An attachment row as Drizzle returns it.
fn js(attachment: mail_attachments::Model) -> Result<Value, DbErr> {
    serde_json::to_value(attachment).map_err(|error| DbErr::Json(error.to_string()))
}

/// `join(mailMessages, eq(mailMessages.id, mailAttachments.messageId))`.
fn message() -> RelationDef {
    mail_attachments::Entity::belongs_to(mail_messages::Entity)
        .from(mail_attachments::Column::MessageId)
        .to(mail_messages::Column::Id)
        .into()
}

/// An attachment with its message's mailbox.
#[derive(Debug, FromQueryResult)]
struct Located {
    #[sea_orm(nested)]
    attachment: mail_attachments::Model,
    message_account_id: String,
}

/// `locateAttachment(id, accountIds)`: a live attachment of a live message
/// in one of the mailboxes, with that mailbox.
async fn locate_attachment(
    db: &PgPool,
    id: &str,
    account_ids: &[String],
) -> Result<Option<(String, Value)>, DbErr> {
    if account_ids.is_empty() {
        return Ok(None);
    }
    let row = mail_attachments::Entity::find()
        .column_as(mail_messages::Column::AccountId, "message_account_id")
        .join(JoinType::InnerJoin, message())
        .filter(mail_attachments::Column::Id.eq(id))
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .filter(mail_messages::Column::DeletedAt.is_null())
        .filter(mail_messages::Column::AccountId.is_in(account_ids.iter().cloned()))
        .into_model::<Located>()
        .one(&orm(db))
        .await?;
    row.map(|row| Ok((row.message_account_id, js(row.attachment)?)))
        .transpose()
}

/// `locateAttachmentOrRespond`: 404 for a missing attachment (or one of a
/// deleted message), 403 for one in a mailbox closed to the caller.
async fn locate_or_respond(caller: &Caller, id: &str) -> MailResult<(String, Value)> {
    let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
    if let Some(found) = locate_attachment(&caller.db, id, &accessible).await? {
        return Ok(found);
    }
    let Some(message) = live_message_id(&caller.db, id).await? else {
        return Err(MailError::not_found("Attachment", Some(id)));
    };
    let account: Option<String> = mail_messages::Entity::find_by_id(message)
        .select_only()
        .column(mail_messages::Column::AccountId)
        .filter(mail_messages::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    match account {
        None => Err(MailError::not_found("Attachment", Some(id))),
        Some(_) => Err(MailError::forbidden(NO_ACCESS)),
    }
}

/// The message of a live attachment.
async fn live_message_id(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    mail_attachments::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(mail_attachments::Column::MessageId)
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `refreshMessageAttachmentCount(db, messageId)`: one statement, the count
/// and the flag read from the message's live attachments.
pub(crate) async fn refresh_count(
    db: &PgPool,
    message_id: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let live = |select: Expr| {
        Query::select()
            .expr(select)
            .from(mail_attachments::Entity)
            .and_where(mail_attachments::Column::MessageId.eq(message_id))
            .and_where(mail_attachments::Column::DeletedAt.is_null())
            .to_owned()
    };
    let count = live(Func::cast_as(Func::count(Expr::col(Asterisk)), "int").into());
    mail_messages::Entity::update_many()
        .col_expr(
            mail_messages::Column::AttachmentCount,
            Func::coalesce([Expr::from(count), Expr::val(0)]).into(),
        )
        .col_expr(
            mail_messages::Column::HasAttachments,
            Expr::exists(live(Expr::val(1))),
        )
        .col_expr(mail_messages::Column::UpdatedAt, Expr::value(at))
        .filter(mail_messages::Column::Id.eq(message_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `GET /message/:messageId`.
async fn list_for_message(caller: Caller, Path(message_id): Path<String>) -> Response {
    let result = async {
        locate_message(&caller, &message_id, "Message").await?;
        let rows = mail_attachments::Entity::find()
            .filter(mail_attachments::Column::MessageId.eq(&message_id))
            .filter(mail_attachments::Column::DeletedAt.is_null())
            .all(&orm(&caller.db))
            .await?;
        let rows = rows
            .into_iter()
            .map(|row| js(row).map(public_attachment))
            .collect::<Result<Vec<Value>, _>>()?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to list attachments")
}

/// `POST /associate`: the caller's uploaded attachments moved onto a
/// message.
async fn associate(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let message = issues.text(body, "messageId", Presence::Required, Some(1), None);
        let ids = issues.list(
            body,
            "attachmentIds",
            Presence::Required,
            Some(1),
            Some(100),
            |issues, item| issues.item_text(item, Text::default()),
        );
        (
            message.into_option().unwrap_or_default(),
            ids.into_option().unwrap_or_default(),
        )
    });
    let (message_id, ids) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        locate_message(&caller, &message_id, "Message").await?;
        let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
        let mut unique: Vec<&String> = Vec::new();
        for id in &ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let mut movable: Vec<(String, Value)> = Vec::new();
        for id in unique {
            if let Some((_, row)) = locate_attachment(&caller.db, id, &accessible).await? {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                movable.push((id, row["fileName"].clone()));
            }
        }
        let moving: Vec<String> = movable.iter().map(|(id, _)| id.clone()).collect();
        if !moving.is_empty() {
            let at = utc_now();
            mail_attachments::Entity::update_many()
                .col_expr(
                    mail_attachments::Column::MessageId,
                    Expr::value(message_id.clone()),
                )
                .col_expr(mail_attachments::Column::UpdatedAt, Expr::value(at))
                .filter(mail_attachments::Column::Id.is_in(moving.iter().cloned()))
                .filter(mail_attachments::Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await?;
            refresh_count(&caller.db, &message_id, at).await?;
            for (id, file_name) in &movable {
                caller.publish(
                    &state,
                    MAIL_ATTACHMENT_UPDATED,
                    id,
                    &json!({ "id": id, "messageId": message_id, "fileName": file_name }),
                );
            }
        }
        Ok(Data(json!({ "messageId": message_id, "associated": moving.len() })).into_response())
    }
    .await;
    answer(result, "Failed to associate attachments")
}

/// The answer for a file the virus scan locked (`scanStatus`, set on the EU
/// and self-hosted editions by `weldsuite-mail-inbound`'s threat checks):
/// 403 `ATTACHMENT_INFECTED`, or 409 `ATTACHMENT_SCAN_PENDING` while the
/// scanner hasn't seen it yet. `None` serves it (clean, unscannable or never
/// scanned). Global's rows have no such column, so its answers are unchanged.
fn scan_block(row: &Value) -> Option<Response> {
    let (status, code, message) = match row["scanStatus"].as_str() {
        Some("infected") => (
            StatusCode::FORBIDDEN,
            "ATTACHMENT_INFECTED",
            "This attachment contains a virus and can't be downloaded",
        ),
        Some("pending") => (
            StatusCode::CONFLICT,
            "ATTACHMENT_SCAN_PENDING",
            "This attachment is still being scanned for viruses",
        ),
        _ => return None,
    };
    let body = json!({ "error": { "code": code, "message": message } });
    Some((status, axum::Json(body)).into_response())
}

/// `GET /:id/download`: the file, from the workspace's storage only.
async fn download(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: MailResult<Response> = async {
        let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
        let Some((_, row)) = locate_attachment(&caller.db, &id, &accessible).await? else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        if let Some(blocked) = scan_block(&row) {
            return Ok(blocked);
        }
        let buckets = caller.bindings.buckets(&state);
        if buckets.private.is_none() && buckets.public.is_none() {
            let body = json!({ "error": { "code": "STORAGE_BINDING_MISSING", "message": "Storage binding not configured" } });
            return Ok((StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response());
        }
        let path = row["storagePath"]
            .as_str()
            .filter(|p| !p.is_empty() && is_workspace_storage_key(&caller, p));
        let object = match path {
            Some(path) => {
                let mut found = None;
                if let Some(private) = &buckets.private {
                    found = private.get_boxed(path).await.map_err(|e| {
                        {
                        tracing::error!(error = %e, "[app-api/mail-attachments] download failed");
                        MailError::api(ApiError::internal().with_message("Failed to download attachment"))
                    }
                    })?;
                }
                if found.is_none()
                    && let Some(public) = &buckets.public
                {
                    found = public.get_boxed(path).await.map_err(|e| {
                        {
                        tracing::error!(error = %e, "[app-api/mail-attachments] download failed");
                        MailError::api(ApiError::internal().with_message("Failed to download attachment"))
                    }
                    })?;
                }
                found
            }
            None => None,
        };
        let Some(object) = object else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        let content_type = row["contentType"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .or_else(|| object.info.content_type.clone().filter(|t| !t.is_empty()))
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let file_name = row["fileName"].as_str().unwrap_or_default();
        let mut response = Response::new(Body::from(object.bytes));
        let headers = response.headers_mut();
        let mut set = |name: header::HeaderName, value: String| {
            if let Ok(value) = HeaderValue::from_str(&value) {
                headers.insert(name, value);
            }
        };
        set(header::CONTENT_TYPE, content_type);
        set(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{}", encode_uri_component(file_name)),
        );
        set(header::CONTENT_LENGTH, object.info.size.to_string());
        set(header::CACHE_CONTROL, "private, no-store".to_owned());
        set(header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned());
        Ok(response)
    }
    .await;
    answer(result, "Failed to download attachment")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
        match locate_attachment(&caller.db, &id, &accessible).await? {
            Some((_, row)) => Ok(Data(public_attachment(row)).into_response()),
            None => Err(MailError::not_found("Attachment", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch attachment")
}

/// `createBody` / `updateBody`.
fn read_attachment(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let text = |issues: &mut Issues,
                key: &str,
                presence: Presence,
                min: Option<usize>,
                max: Option<usize>,
                out: &mut Map<String, Value>| {
        if let Some(v) = issues.text(body, key, presence, min, max).into_option() {
            out.insert(key.into(), Value::String(v));
        }
    };
    text(issues, "messageId", required, Some(1), None, &mut out);
    text(issues, "fileName", required, Some(1), Some(500), &mut out);
    text(
        issues,
        "contentType",
        Presence::Optional,
        None,
        Some(255),
        &mut out,
    );
    if let Some(size) = issues
        .whole_number(
            body,
            "size",
            required,
            Number {
                int: true,
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option()
    {
        out.insert("size".into(), json!(size));
    }
    text(
        issues,
        "storagePath",
        Presence::Optional,
        None,
        Some(1000),
        &mut out,
    );
    text(
        issues,
        "checksum",
        Presence::Optional,
        None,
        Some(64),
        &mut out,
    );
    if let Some(v) = issues
        .boolean(body, "isInline", Presence::Optional)
        .into_option()
    {
        out.insert("isInline".into(), Value::Bool(v));
    }
    text(
        issues,
        "contentId",
        Presence::Optional,
        None,
        Some(255),
        &mut out,
    );
    text(
        issues,
        "contentDisposition",
        Presence::Optional,
        None,
        Some(100),
        &mut out,
    );
    out
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// `foreignStoragePath`: a storage path must be a file in this workspace.
fn foreign_storage_path(caller: &Caller, data: &Map<String, Value>) -> MailResult<()> {
    match text(data, "storagePath") {
        Some(path) if !is_workspace_storage_key(caller, path) => Err(MailError::bad_request(
            "storagePath must be a file in this workspace",
        )),
        _ => Ok(()),
    }
}

/// `store.mailbox(accountId).getAttachment(id)` without its mailbox.
async fn mailbox_attachment(
    caller: &Caller,
    account: &str,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let found = locate_attachment(&caller.db, id, &[account.to_owned()]).await?;
    Ok(found.map(|(_, row)| row))
}

/// `POST /` (`createAttachment`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_attachment(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        foreign_storage_path(&caller, &data)?;
        let message = text(&data, "messageId").unwrap_or_default().to_owned();
        let account = locate_message(&caller, &message, "Message").await?;
        let id = generate_id("attach");
        let at = utc_now();
        let owned = |key: &str| text(&data, key).map(str::to_owned);
        // An `integer` column: what Postgres refuses ("out of range") stays
        // the route's 500.
        let size = data
            .get("size")
            .and_then(Value::as_i64)
            .and_then(|size| i32::try_from(size).ok())
            .ok_or_else(|| DbErr::Custom("size: integer out of range".to_owned()))?;
        mail_attachments::Entity::insert(mail_attachments::ActiveModel {
            id: Set(id.clone()),
            message_id: Set(message.clone()),
            file_name: Set(owned("fileName").unwrap_or_default()),
            content_type: Set(owned("contentType")),
            size: Set(size),
            storage_path: Set(owned("storagePath")),
            checksum: Set(owned("checksum")),
            is_inline: Set(Some(
                data.get("isInline")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )),
            content_id: Set(owned("contentId")),
            content_disposition: Set(owned("contentDisposition")),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        refresh_count(&caller.db, &message, at).await?;
        let Some(row) = mailbox_attachment(&caller, &account, &id).await? else {
            return Err(MailError::api(
                ApiError::internal().with_message("Failed to create attachment"),
            ));
        };
        caller.publish(
            &state,
            MAIL_ATTACHMENT_CREATED,
            &id,
            &json!({ "id": id, "messageId": row["messageId"], "fileName": row["fileName"] }),
        );
        Ok(Created(public_attachment(row)).into_response())
    }
    .await;
    answer(result, "Failed to create attachment")
}

/// `PUT|PATCH /:id` (`updateAttachment`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_attachment(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    if let Err(error) = foreign_storage_path(&caller, &data) {
        return error.respond("");
    }
    let result = async {
        let (account, _) = locate_or_respond(&caller, &id).await?;
        let Some(previous_message) = live_message_id(&caller.db, &id).await? else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        let at = utc_now();
        let mut update = mail_attachments::Entity::update_many()
            .col_expr(mail_attachments::Column::UpdatedAt, Expr::value(at));
        for (key, column) in [
            ("messageId", mail_attachments::Column::MessageId),
            ("fileName", mail_attachments::Column::FileName),
            ("contentType", mail_attachments::Column::ContentType),
            ("storagePath", mail_attachments::Column::StoragePath),
            ("checksum", mail_attachments::Column::Checksum),
            ("contentId", mail_attachments::Column::ContentId),
            (
                "contentDisposition",
                mail_attachments::Column::ContentDisposition,
            ),
        ] {
            if let Some(value) = text(&data, key) {
                update = update.col_expr(column, Expr::value(value.to_owned()));
            }
        }
        if let Some(size) = data.get("size").and_then(Value::as_i64) {
            update = update.col_expr(mail_attachments::Column::Size, Expr::value(size));
        }
        if let Some(inline) = data.get("isInline").and_then(Value::as_bool) {
            update = update.col_expr(mail_attachments::Column::IsInline, Expr::value(inline));
        }
        update
            .filter(mail_attachments::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        if let Some(moved) =
            text(&data, "messageId").filter(|m| !m.is_empty() && *m != previous_message)
        {
            refresh_count(&caller.db, &previous_message, at).await?;
            refresh_count(&caller.db, moved, at).await?;
        }
        let Some(after) = mailbox_attachment(&caller, &account, &id).await? else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        caller.publish(
            &state,
            MAIL_ATTACHMENT_UPDATED,
            &id,
            &json!({ "id": id, "messageId": after["messageId"], "fileName": after["fileName"] }),
        );
        Ok(Data(public_attachment(after)).into_response())
    }
    .await;
    answer(result, "Failed to update attachment")
}

/// `DELETE /:id`: a soft delete, then the stored file (best effort).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let (_, attachment) = locate_or_respond(&caller, &id).await?;
        let existing: Option<(String, Option<String>)> =
            mail_attachments::Entity::find_by_id(id.clone())
                .select_only()
                .columns([
                    mail_attachments::Column::MessageId,
                    mail_attachments::Column::StoragePath,
                ])
                .filter(mail_attachments::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
        let Some((message, storage_path)) = existing else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        let at = utc_now();
        mail_attachments::Entity::update_many()
            .col_expr(mail_attachments::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_attachments::Column::UpdatedAt, Expr::value(at))
            .filter(mail_attachments::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        refresh_count(&caller.db, &message, at).await?;
        let buckets = caller.bindings.buckets(&state);
        if let Some(path) = storage_path.filter(|p| !p.is_empty())
            && (buckets.private.is_some() || buckets.public.is_some())
        {
            for bucket in [&buckets.private, &buckets.public].into_iter().flatten() {
                if let Err(error) = bucket.delete_boxed(&path).await {
                    tracing::error!(%error, "[app-api/mail-attachments] R2 delete failed for {path} (attachment {id})");
                }
            }
        }
        caller.publish(
            &state,
            MAIL_ATTACHMENT_DELETED,
            &id,
            &json!({ "id": id, "messageId": attachment["messageId"], "fileName": attachment["fileName"] }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete attachment")
}
