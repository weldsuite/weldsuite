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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_ATTACHMENT_CREATED, MAIL_ATTACHMENT_DELETED, MAIL_ATTACHMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    MESSAGES_CREATE, MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::cursor::encode_uri_component;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::accessible_account_ids;
use weldsuite_mail_domain::messages::public_attachment;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::mail_messages::locate_message;
use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, MailResult, answer, now, validate};
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

/// `locateAttachment(id, accountIds)`: a live attachment of a live message
/// in one of the mailboxes, with that mailbox.
async fn locate_attachment(
    db: &PgPool,
    id: &str,
    account_ids: &[String],
) -> Result<Option<(String, Value)>, sqlx::Error> {
    if account_ids.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, Value)> = sqlx::query_as(
        "select m.account_id, to_jsonb(a) from mail_attachments a
         join mail_messages m on m.id = a.message_id
         where a.id = $1 and a.deleted_at is null and m.deleted_at is null
           and m.account_id = any($2::text[])
         limit 1",
    )
    .bind(id)
    .bind(account_ids)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(account, row)| (account, js_row(row))))
}

/// `locateAttachmentOrRespond`: 404 for a missing attachment (or one of a
/// deleted message), 403 for one in a mailbox closed to the caller.
async fn locate_or_respond(caller: &Caller, id: &str) -> MailResult<(String, Value)> {
    let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
    if let Some(found) = locate_attachment(&caller.db, id, &accessible).await? {
        return Ok(found);
    }
    let message: Option<String> = sqlx::query_scalar(
        "select message_id from mail_attachments where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(message) = message else {
        return Err(MailError::not_found("Attachment", Some(id)));
    };
    let account: Option<String> = sqlx::query_scalar(
        "select account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(&message)
    .fetch_optional(&caller.db)
    .await?;
    match account {
        None => Err(MailError::not_found("Attachment", Some(id))),
        Some(_) => Err(MailError::forbidden(NO_ACCESS)),
    }
}

/// `refreshMessageAttachmentCount(db, messageId)`.
async fn refresh_count(db: &PgPool, message_id: &str, at: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update mail_messages set
           attachment_count = coalesce((select count(*)::int from mail_attachments
             where message_id = $1 and deleted_at is null), 0),
           has_attachments = exists (select 1 from mail_attachments
             where message_id = $1 and deleted_at is null),
           updated_at = $2::timestamp
         where id = $1",
    )
    .bind(message_id)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// `GET /message/:messageId`.
async fn list_for_message(caller: Caller, Path(message_id): Path<String>) -> Response {
    let result = async {
        locate_message(&caller, &message_id, "Message").await?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(a) from mail_attachments a
             where a.message_id = $1 and a.deleted_at is null",
        )
        .bind(&message_id)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|r| public_attachment(js_row(r)))
            .collect();
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
            let at = now();
            sqlx::query(
                "update mail_attachments set message_id = $1, updated_at = $3::timestamp
                 where id = any($2::text[]) and deleted_at is null",
            )
            .bind(&message_id)
            .bind(&moving)
            .bind(&at)
            .execute(&caller.db)
            .await?;
            refresh_count(&caller.db, &message_id, &at).await?;
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

/// `GET /:id/download`: the file, from the workspace's storage only.
async fn download(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result: MailResult<Response> = async {
        let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
        let Some((_, row)) = locate_attachment(&caller.db, &id, &accessible).await? else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
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
fn read_attachment(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let text = |issues: &mut Issues, key: &str, presence: Presence, min: Option<usize>, max: Option<usize>, out: &mut Map<String, Value>| {
        if let Some(v) = issues.text(body, key, presence, min, max).into_option() {
            out.insert(key.into(), Value::String(v));
        }
    };
    text(issues, "messageId", required, Some(1), None, &mut out);
    text(issues, "fileName", required, Some(1), Some(500), &mut out);
    text(issues, "contentType", Presence::Optional, None, Some(255), &mut out);
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
    text(issues, "storagePath", Presence::Optional, None, Some(1000), &mut out);
    text(issues, "checksum", Presence::Optional, None, Some(64), &mut out);
    if let Some(v) = issues.boolean(body, "isInline", Presence::Optional).into_option() {
        out.insert("isInline".into(), Value::Bool(v));
    }
    text(issues, "contentId", Presence::Optional, None, Some(255), &mut out);
    text(issues, "contentDisposition", Presence::Optional, None, Some(100), &mut out);
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
) -> Result<Option<Value>, sqlx::Error> {
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
        let at = now();
        sqlx::query(
            "insert into mail_attachments (id, message_id, file_name, content_type, size,
               storage_path, checksum, is_inline, content_id, content_disposition,
               created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamp, $11::timestamp)",
        )
        .bind(&id)
        .bind(&message)
        .bind(text(&data, "fileName"))
        .bind(text(&data, "contentType"))
        .bind(data.get("size").and_then(Value::as_i64))
        .bind(text(&data, "storagePath"))
        .bind(text(&data, "checksum"))
        .bind(data.get("isInline").and_then(Value::as_bool).unwrap_or(false))
        .bind(text(&data, "contentId"))
        .bind(text(&data, "contentDisposition"))
        .bind(&at)
        .execute(&caller.db)
        .await?;
        refresh_count(&caller.db, &message, &at).await?;
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
        let existing: Option<String> = sqlx::query_scalar(
            "select message_id from mail_attachments where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(previous_message) = existing else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        let at = now();
        sqlx::query(
            "update mail_attachments set updated_at = $2::timestamp,
               message_id = coalesce($3, message_id), file_name = coalesce($4, file_name),
               content_type = coalesce($5, content_type), size = coalesce($6, size),
               storage_path = coalesce($7, storage_path), checksum = coalesce($8, checksum),
               is_inline = coalesce($9, is_inline), content_id = coalesce($10, content_id),
               content_disposition = coalesce($11, content_disposition)
             where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .bind(text(&data, "messageId"))
        .bind(text(&data, "fileName"))
        .bind(text(&data, "contentType"))
        .bind(data.get("size").and_then(Value::as_i64))
        .bind(text(&data, "storagePath"))
        .bind(text(&data, "checksum"))
        .bind(data.get("isInline").and_then(Value::as_bool))
        .bind(text(&data, "contentId"))
        .bind(text(&data, "contentDisposition"))
        .execute(&caller.db)
        .await?;
        if let Some(moved) = text(&data, "messageId").filter(|m| !m.is_empty() && *m != previous_message) {
            refresh_count(&caller.db, &previous_message, &at).await?;
            refresh_count(&caller.db, moved, &at).await?;
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
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let (_, attachment) = locate_or_respond(&caller, &id).await?;
        let existing: Option<(String, Option<String>)> = sqlx::query_as(
            "select message_id, storage_path from mail_attachments
             where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some((message, storage_path)) = existing else {
            return Err(MailError::not_found("Attachment", Some(&id)));
        };
        let at = now();
        sqlx::query(
            "update mail_attachments set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        refresh_count(&caller.db, &message, &at).await?;
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

