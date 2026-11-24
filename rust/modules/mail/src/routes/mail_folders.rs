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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_FOLDER_CREATED, MAIL_FOLDER_DELETED, MAIL_FOLDER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::MailFolderType;
use weldsuite_schema::tenant::mail_folders;

use crate::util::{MailError, MailResult, answer, unhandled, validate, validate_query};
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

/// A folder row as Drizzle returns it.
fn js(folder: mail_folders::Model) -> Result<Value, DbErr> {
    serde_json::to_value(folder).map_err(|error| DbErr::Json(error.to_string()))
}

/// `getFolder(db, id)`: a live folder row.
async fn get_folder(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = mail_folders::Entity::find_by_id(id.to_owned())
        .filter(mail_folders::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(js).transpose()
}

/// The folder `id` just written, deleted or not.
async fn written_folder(caller: &Caller, id: &str) -> Result<Value, DbErr> {
    let row = mail_folders::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail folder {id}")))?;
    js(row)
}

/// A `type` the body chose (one of `FOLDER_TYPES`).
fn folder_type(kind: &str) -> Result<MailFolderType, DbErr> {
    MailFolderType::try_from_value(&kind.to_owned())
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
        let mut find =
            mail_folders::Entity::find().filter(mail_folders::Column::DeletedAt.is_null());
        if let Some(account) = &account {
            find = find.filter(mail_folders::Column::AccountId.eq(account));
        }
        let rows = find
            .order_by_asc(mail_folders::Column::Position)
            .order_by_asc(mail_folders::Column::Name)
            .all(&orm(&caller.db))
            .await?;
        let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
        Ok(Data(rows).into_response())
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
        let owned = |key: &str| text(&data, key).map(str::to_owned);
        // An `integer` column: what Postgres refuses ("out of range") stays
        // the route's 500.
        let position = i32::try_from(data.get("position").and_then(Value::as_i64).unwrap_or(0))
            .map_err(|_| DbErr::Custom("position: integer out of range".to_owned()))?;
        let at = utc_now();
        mail_folders::Entity::insert(mail_folders::ActiveModel {
            id: Set(id.clone()),
            account_id: Set(account.to_owned()),
            name: Set(owned("name").unwrap_or_default()),
            type_: Set(folder_type(text(&data, "type").unwrap_or("custom"))?),
            parent_id: Set(owned("parentId")),
            path: Set(owned("path")),
            color: Set(owned("color")),
            icon: Set(owned("icon")),
            position: Set(position),
            is_selectable: Set(true),
            is_system: Set(Some(false)),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        let row = written_folder(&caller, &id).await?;
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
        let mut update = mail_folders::Entity::update_many()
            .col_expr(mail_folders::Column::UpdatedAt, Expr::value(utc_now()));
        if let Some(name) = text(&data, "name") {
            update = update.col_expr(mail_folders::Column::Name, Expr::value(name.to_owned()));
        }
        if let Some(kind) = text(&data, "type") {
            update = update.col_expr(
                mail_folders::Column::Type,
                mail_folders::Column::Type.save_as(Expr::value(folder_type(kind)?)),
            );
        }
        for (key, column) in [
            ("parentId", mail_folders::Column::ParentId),
            ("path", mail_folders::Column::Path),
            ("color", mail_folders::Column::Color),
            ("icon", mail_folders::Column::Icon),
        ] {
            if let Some(value) = text(&data, key) {
                update = update.col_expr(column, Expr::value(value.to_owned()));
            }
        }
        if let Some(position) = data.get("position").and_then(Value::as_i64) {
            update = update.col_expr(mail_folders::Column::Position, Expr::value(position));
        }
        update
            .filter(mail_folders::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let after = written_folder(&caller, &id).await?;
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
        let at = utc_now();
        mail_folders::Entity::update_many()
            .col_expr(mail_folders::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_folders::Column::UpdatedAt, Expr::value(at))
            .filter(mail_folders::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, MAIL_FOLDER_DELETED, &id, &event(&current, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete folder")
}
