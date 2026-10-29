//! `/api/mail-folders` (`routes/mail-folders/index.ts`, `@weldsuite/mail-domain/folders`):
//! a mailbox's IMAP-style folders. System folders keep their name, type,
//! parent and path, and cannot be deleted.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_FOLDER_CREATED, MAIL_FOLDER_DELETED, MAIL_FOLDER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{MailError, MailResult, answer, now, unhandled, validate, validate_query};
use crate::{Caller, MailState};

const NO_ACCESS: &str = "Access to this mail account is not allowed";

const FOLDER_TYPES: [&str; 7] = [
    "inbox", "sent", "drafts", "spam", "trash", "archive", "custom",
];

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-folders",
            get(list).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-folders",
            post(create).route_layer(gate.require([ACCOUNTS_CREATE])),
        )
        .route(
            "/mail-folders/{id}",
            get(detail).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-folders/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([ACCOUNTS_UPDATE])),
        )
        .route(
            "/mail-folders/{id}",
            axum::routing::delete(remove).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .with_state(state)
}

/// `getFolder(db, id)`: a live folder row.
async fn get_folder(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from mail_folders f where f.id = $1 and f.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

/// `GET /` (`listFolders`): one mailbox's folders, or every folder.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "accountId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(account) => account.filter(|a| !a.is_empty()),
        Err(error) => return error.respond(""),
    };
    let result = async {
        if let Some(account) = &account
            && !check_account_access(&caller.db, account, &caller.user_id).await?
        {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(f) from mail_folders f
             where f.deleted_at is null and ($1::text is null or f.account_id = $1)
             order by f.position asc, f.name asc",
        )
        .bind(&account)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response())
    }
    .await;
    answer(result, "Failed to list folders")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = get_folder(&caller, &id).await? else {
            return Err(MailError::not_found("Folder", Some(&id)));
        };
        let account = row["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch folder")
}

/// `createBody` (with `accountId`) or `updateBody` (without, `.partial()`).
fn read_folder(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> Map<String, Value> {
    let mut out = Map::new();
    if create
        && let Some(account) = issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
    {
        out.insert("accountId".into(), Value::String(account));
    }
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    if let Some(name) = issues
        .text(body, "name", required, Some(1), Some(255))
        .into_option()
    {
        out.insert("name".into(), Value::String(name));
    }
    if let Some(kind) = issues
        .choice(body, "type", Presence::Optional, &FOLDER_TYPES)
        .into_option()
    {
        out.insert("type".into(), Value::String(kind));
    }
    for (key, max) in [
        ("parentId", None),
        ("path", Some(1000)),
        ("color", Some(7)),
        ("icon", Some(50)),
    ] {
        if let Some(value) = issues
            .text(body, key, Presence::Optional, None, max)
            .into_option()
        {
            out.insert(key.into(), Value::String(value));
        }
    }
    if let Some(position) = issues
        .whole_number(
            body,
            "position",
            Presence::Optional,
            Number {
                int: true,
                ..Number::default()
            },
        )
        .into_option()
    {
        out.insert("position".into(), json!(position));
    }
    out
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// The fields of a folder entity event.
fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "accountId": row["accountId"], "name": row["name"], "type": row["type"] })
}

/// `POST /` (`createFolder`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_folder(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = text(&data, "accountId").unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let id = generate_id("mfld");
        sqlx::query(
            "insert into mail_folders (id, account_id, name, type, parent_id, path, color, icon,
               position, is_selectable, is_system, created_at, updated_at)
             values ($1, $2, $3, $4::mail_folder_type, $5, $6, $7, $8, $9, true, false,
               $10::timestamp, $10::timestamp)",
        )
        .bind(&id)
        .bind(account)
        .bind(text(&data, "name"))
        .bind(text(&data, "type").unwrap_or("custom"))
        .bind(text(&data, "parentId"))
        .bind(text(&data, "path"))
        .bind(text(&data, "color"))
        .bind(text(&data, "icon"))
        .bind(data.get("position").and_then(Value::as_i64).unwrap_or(0))
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row: Value =
            sqlx::query_scalar("select to_jsonb(f) from mail_folders f where f.id = $1")
                .bind(&id)
                .fetch_one(&caller.db)
                .await?;
        let row = js_row(row);
        caller.publish(&state, MAIL_FOLDER_CREATED, &id, &event(&row, &id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create folder")
}

/// `PUT|PATCH /:id` (`updateFolder`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_folder(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    // Outside the route's try/catch.
    let existing = match get_folder(&caller, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return MailError::not_found("Folder", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    };
    let account = existing["accountId"].as_str().unwrap_or_default();
    match check_account_access(&caller.db, account, &caller.user_id).await {
        Ok(true) => {}
        Ok(false) => return MailError::forbidden(NO_ACCESS).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result: MailResult<Response> = async {
        let current = get_folder(&caller, &id).await?;
        let Some(current) = current else {
            return Err(MailError::not_found("Folder", None));
        };
        if current["isSystem"].as_bool() == Some(true) {
            for key in ["name", "type", "parentId", "path"] {
                if data.contains_key(key) {
                    return Err(MailError::forbidden(format!(
                        "Field \"{key}\" cannot be changed on a system folder."
                    )));
                }
            }
        }
        sqlx::query(
            "update mail_folders set updated_at = $2::timestamp,
               name = coalesce($3, name), type = coalesce($4::mail_folder_type, type),
               parent_id = coalesce($5, parent_id), path = coalesce($6, path),
               color = coalesce($7, color), icon = coalesce($8, icon),
               position = coalesce($9, position)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text(&data, "name"))
        .bind(text(&data, "type"))
        .bind(text(&data, "parentId"))
        .bind(text(&data, "path"))
        .bind(text(&data, "color"))
        .bind(text(&data, "icon"))
        .bind(data.get("position").and_then(Value::as_i64))
        .execute(&caller.db)
        .await?;
        let after: Value =
            sqlx::query_scalar("select to_jsonb(f) from mail_folders f where f.id = $1")
                .bind(&id)
                .fetch_one(&caller.db)
                .await?;
        let after = js_row(after);
        caller.publish(&state, MAIL_FOLDER_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update folder")
}

/// `DELETE /:id` (`softDeleteFolder`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = get_folder(&caller, &id).await? else {
            return Err(MailError::not_found("Folder", Some(&id)));
        };
        let account = existing["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let Some(current) = get_folder(&caller, &id).await? else {
            return Err(MailError::not_found("Folder", Some(&id)));
        };
        if current["isSystem"].as_bool() == Some(true) {
            return Err(MailError::forbidden("System folders cannot be deleted."));
        }
        let at = now();
        sqlx::query(
            "update mail_folders set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, MAIL_FOLDER_DELETED, &id, &event(&current, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete folder")
}
