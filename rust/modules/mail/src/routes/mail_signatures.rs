//! `/api/mail-signatures` (`routes/mail-signatures/index.ts`,
//! `services/mail/signatures.ts`): personal signatures belong to their
//! author; company and department ones are visible to everyone and changed
//! by mail admins (`accounts:update` / `accounts:delete`). A new default
//! replaces the defaults it competes with.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    MAIL_SIGNATURE_CREATED, MAIL_SIGNATURE_DELETED, MAIL_SIGNATURE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{ACCOUNTS_READ, MESSAGES_CREATE};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{MailSignaturePosition, MailSignatureType};
use weldsuite_schema::tenant::mail_signatures;

use crate::routes::mail_drafts::to_millis;
use crate::util::{MailError, answer, list_response, page, strings, validate, validate_query};
use crate::{Caller, MailState};

const TYPES: [&str; 3] = ["personal", "company", "department"];

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let write = || gate.require([MESSAGES_CREATE]);
    Router::new()
        .route(
            "/mail-signatures",
            get(list).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route("/mail-signatures", post(create).route_layer(write()))
        .route(
            "/mail-signatures/{id}",
            get(detail).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-signatures/{id}",
            patch(update).put(update).route_layer(write()),
        )
        .route(
            "/mail-signatures/{id}",
            axum::routing::delete(remove).route_layer(write()),
        )
        .with_state(state)
}

/// `user_ids @> jsonb_build_array(userId)`.
fn lists_user(user_id: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::contains(
        Expr::col(mail_signatures::Column::UserIds),
        Expr::value(json!([user_id])),
    )
}

/// `visibleTo(userId)`: shared, or the user's own.
fn visible(user_id: &str) -> Condition {
    Condition::any()
        .add(mail_signatures::Column::Type.ne(MailSignatureType::Personal))
        .add(lists_user(user_id))
}

/// A signature row as Drizzle returns it.
fn js(signature: mail_signatures::Model) -> Result<Value, DbErr> {
    serde_json::to_value(signature).map_err(|error| DbErr::Json(error.to_string()))
}

/// The signature `id` just written, deleted or not.
async fn written_signature(caller: &Caller, id: &str) -> Result<Value, DbErr> {
    let row = mail_signatures::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail signature {id}")))?;
    js(row)
}

/// A `type` the body chose (one of `TYPES`).
fn signature_type(kind: &str) -> Result<MailSignatureType, DbErr> {
    MailSignatureType::try_from_value(&kind.to_owned())
}

/// A `position` the body chose (`above` or `below`).
fn signature_position(position: &str) -> Result<MailSignaturePosition, DbErr> {
    MailSignaturePosition::try_from_value(&position.to_owned())
}

fn is_shared(kind: &str) -> bool {
    kind != "personal"
}

/// `accountsOverlap(a, b)`: an empty or missing list means every account.
fn accounts_overlap(a: &[String], b: &[String]) -> bool {
    if a.is_empty() || b.is_empty() {
        return true;
    }
    a.iter().any(|id| b.contains(id))
}

/// `getSignature(db, userId, id)`.
async fn get_signature(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = mail_signatures::Entity::find_by_id(id.to_owned())
        .filter(mail_signatures::Column::DeletedAt.is_null())
        .filter(visible(&caller.user_id))
        .one(&orm(&caller.db))
        .await?;
    row.map(js).transpose()
}

/// `GET /` (`listSignatures`).
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let kind = issues.choice(q, "type", Presence::Optional, &TYPES);
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
            kind.into_option(),
            limit.into_option(),
            cursor.into_option(),
        )
    });
    let (kind, limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let limit = limit.unwrap_or(50).min(100);
        let (rows, total) = list_page(&caller, kind.as_deref(), limit, cursor.as_deref()).await?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list signatures")
}

/// `listSignatures`' page (`limit + 1` rows after the cursor) and its total.
async fn list_page(
    caller: &Caller,
    kind: Option<&str>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, i64), DbErr> {
    let db = orm(&caller.db);
    let cursor_row: Option<(PrimitiveDateTime, String)> = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => {
            mail_signatures::Entity::find_by_id(cursor.to_owned())
                .select_only()
                .columns([
                    mail_signatures::Column::CreatedAt,
                    mail_signatures::Column::Id,
                ])
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let mut scope = Condition::all()
        .add(mail_signatures::Column::DeletedAt.is_null())
        .add(visible(&caller.user_id));
    if let Some(kind) = kind {
        scope = scope.add(mail_signatures::Column::Type.eq(signature_type(kind)?));
    }
    let mut page_scope = scope.clone();
    if let Some((at, id)) = cursor_row {
        let at = to_millis(at);
        page_scope = page_scope.add(
            Condition::any()
                .add(mail_signatures::Column::CreatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(mail_signatures::Column::CreatedAt.eq(at))
                        .add(mail_signatures::Column::Id.lt(id)),
                ),
        );
    }
    let rows = mail_signatures::Entity::find()
        .filter(page_scope)
        .order_by_desc(mail_signatures::Column::CreatedAt)
        .order_by_desc(mail_signatures::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await?;
    let total = mail_signatures::Entity::find()
        .filter(scope)
        .count(&db)
        .await?;
    let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match get_signature(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(MailError::not_found("Signature", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch signature")
}

/// `createBody` / `updateBody`: the given fields in the schema's order.
fn read_signature(
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
    if let Some(name) = issues
        .text_with(body, "name", required, Text::trimmed(Some(1), Some(255)))
        .into_option()
    {
        out.insert("name".into(), Value::String(name));
    }
    if let Some(content) = issues
        .text(body, "content", required, Some(1), Some(100_000))
        .into_option()
    {
        out.insert("content".into(), Value::String(content));
    }
    if let Some(v) = issues
        .boolean(body, "isDefault", Presence::Optional)
        .into_option()
    {
        out.insert("isDefault".into(), Value::Bool(v));
    }
    if let Some(v) = issues
        .choice(body, "type", Presence::Optional, &TYPES)
        .into_option()
    {
        out.insert("type".into(), Value::String(v));
    }
    let list = |issues: &mut Issues, key: &str| {
        issues
            .list(body, key, Presence::Optional, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
            .into_option()
    };
    if let Some(v) = list(issues, "accountIds") {
        out.insert("accountIds".into(), json!(v));
    }
    if let Some(v) = list(issues, "userIds") {
        out.insert("userIds".into(), json!(v));
    }
    for key in ["includeInReplies", "includeInForwards"] {
        if let Some(v) = issues.boolean(body, key, Presence::Optional).into_option() {
            out.insert(key.into(), Value::Bool(v));
        }
    }
    if let Some(v) = issues
        .choice(body, "position", Presence::Optional, &["above", "below"])
        .into_option()
    {
        out.insert("position".into(), Value::String(v));
    }
    if let Some(v) = list(issues, "tags") {
        out.insert("tags".into(), json!(v));
    }
    out
}

/// `clearCompetingDefaults`: other defaults in the same scope (shared, or the
/// user's personal ones) whose accounts overlap lose their default flag.
async fn clear_competing_defaults(
    caller: &Caller,
    id: &str,
    kind: &str,
    account_ids: &[String],
) -> Result<(), DbErr> {
    let scope = if is_shared(kind) {
        Condition::all().add(mail_signatures::Column::Type.ne(MailSignatureType::Personal))
    } else {
        Condition::all()
            .add(mail_signatures::Column::Type.eq(MailSignatureType::Personal))
            .add(lists_user(&caller.user_id))
    };
    let defaults: Vec<(String, Option<Value>)> = mail_signatures::Entity::find()
        .select_only()
        .columns([
            mail_signatures::Column::Id,
            mail_signatures::Column::AccountIds,
        ])
        .filter(mail_signatures::Column::DeletedAt.is_null())
        .filter(mail_signatures::Column::IsDefault.eq(true))
        .filter(mail_signatures::Column::Id.ne(id))
        .filter(scope)
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    let competing: Vec<String> = defaults
        .into_iter()
        .filter(|(_, accounts)| {
            accounts_overlap(
                &accounts.as_ref().map(strings).unwrap_or_default(),
                account_ids,
            )
        })
        .map(|(id, _)| id)
        .collect();
    if competing.is_empty() {
        return Ok(());
    }
    mail_signatures::Entity::update_many()
        .col_expr(mail_signatures::Column::IsDefault, Expr::value(false))
        .col_expr(mail_signatures::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(mail_signatures::Column::Id.is_in(competing))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

const SHARED_ONLY: &str = "Only mail admins can change shared signatures";

/// `POST /` (`createSignature`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_signature(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let kind = text(&data, "type").unwrap_or("personal").to_owned();
    if is_shared(&kind) && !caller.can("accounts:update") {
        return MailError::forbidden(SHARED_ONLY).respond("");
    }
    let result = async {
        let id = generate_id("msig");
        let user_ids = if is_shared(&kind) {
            data.get("userIds").cloned()
        } else {
            Some(json!([caller.user_id]))
        };
        let at = utc_now();
        mail_signatures::Entity::insert(mail_signatures::ActiveModel {
            id: Set(id.clone()),
            name: Set(text(&data, "name").unwrap_or_default().to_owned()),
            content: Set(text(&data, "content").unwrap_or_default().to_owned()),
            is_default: Set(flag(&data, "isDefault").unwrap_or(false)),
            account_ids: Set(data.get("accountIds").cloned()),
            user_ids: Set(user_ids),
            type_: Set(signature_type(&kind)?),
            include_in_replies: Set(flag(&data, "includeInReplies").unwrap_or(true)),
            include_in_forwards: Set(flag(&data, "includeInForwards").unwrap_or(true)),
            position: Set(signature_position(
                text(&data, "position").unwrap_or("below"),
            )?),
            tags: Set(data.get("tags").cloned()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        if flag(&data, "isDefault") == Some(true) {
            let accounts = data.get("accountIds").map(strings).unwrap_or_default();
            clear_competing_defaults(&caller, &id, &kind, &accounts).await?;
        }
        let row = written_signature(&caller, &id).await?;
        caller.publish(
            &state,
            MAIL_SIGNATURE_CREATED,
            &id,
            &json!({ "id": id, "name": row["name"], "isDefault": row["isDefault"] }),
        );
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create signature")
}

/// `PUT|PATCH /:id` (`updateSignature`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_signature(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let Some(existing) = get_signature(&caller, &id).await? else {
            return Err(MailError::not_found("Signature", Some(&id)));
        };
        let existing_type = existing["type"].as_str().unwrap_or("personal").to_owned();
        let kind = text(&data, "type").unwrap_or(&existing_type).to_owned();
        let touches_shared = is_shared(&existing_type) || is_shared(&kind);
        if touches_shared && !caller.can("accounts:update") {
            return Err(MailError::forbidden(SHARED_ONLY));
        }
        if is_shared(&existing_type) && text(&data, "type") == Some("personal") {
            return Err(MailError::bad_request(
                "A shared signature cannot be made personal",
            ));
        }
        // `userIds`: given, cleared when a personal one becomes shared, the
        // author for a personal one.
        let user_ids: Option<Option<Value>> = if is_shared(&kind) {
            if !is_shared(&existing_type) && !data.contains_key("userIds") {
                Some(None)
            } else {
                data.get("userIds").cloned().map(Some)
            }
        } else {
            Some(Some(json!([caller.user_id])))
        };
        let user_ids = match user_ids {
            Some(value) => UserIds::Set(value),
            None => UserIds::Keep,
        };
        write_update(&caller, &id, &data, user_ids).await?;
        let after = written_signature(&caller, &id).await?;
        let reconsider = flag(&data, "isDefault") == Some(true)
            || data.contains_key("accountIds")
            || data.contains_key("type");
        if after["isDefault"].as_bool() == Some(true) && reconsider {
            let accounts = strings(&after["accountIds"]);
            let after_type = after["type"].as_str().unwrap_or("personal").to_owned();
            clear_competing_defaults(&caller, &id, &after_type, &accounts).await?;
        }
        caller.publish(
            &state,
            MAIL_SIGNATURE_UPDATED,
            &id,
            &json!({ "id": id, "name": after["name"], "isDefault": after["isDefault"] }),
        );
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update signature")
}

/// What an update does to `userIds`.
enum UserIds {
    Keep,
    /// The list, or null to clear it.
    Set(Option<Value>),
}

/// `updateSignature`'s write: the fields the body sent, `userIds` when
/// decided, and `updatedAt`.
async fn write_update(
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
    user_ids: UserIds,
) -> Result<(), DbErr> {
    let mut update = mail_signatures::Entity::update_many()
        .col_expr(mail_signatures::Column::UpdatedAt, Expr::value(utc_now()));
    for (key, column) in [
        ("name", mail_signatures::Column::Name),
        ("content", mail_signatures::Column::Content),
    ] {
        if let Some(value) = text(data, key) {
            update = update.col_expr(column, Expr::value(value.to_owned()));
        }
    }
    if let Some(value) = flag(data, "isDefault") {
        update = update.col_expr(mail_signatures::Column::IsDefault, Expr::value(value));
    }
    if let Some(kind) = text(data, "type") {
        update = update.col_expr(
            mail_signatures::Column::Type,
            mail_signatures::Column::Type.save_as(Expr::value(signature_type(kind)?)),
        );
    }
    if let Some(accounts) = data.get("accountIds") {
        update = update.col_expr(
            mail_signatures::Column::AccountIds,
            Expr::value(accounts.clone()),
        );
    }
    if let UserIds::Set(user_ids) = user_ids {
        update = update.col_expr(mail_signatures::Column::UserIds, Expr::value(user_ids));
    }
    for (key, column) in [
        (
            "includeInReplies",
            mail_signatures::Column::IncludeInReplies,
        ),
        (
            "includeInForwards",
            mail_signatures::Column::IncludeInForwards,
        ),
    ] {
        if let Some(value) = flag(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(position) = text(data, "position") {
        update = update.col_expr(
            mail_signatures::Column::Position,
            mail_signatures::Column::Position.save_as(Expr::value(signature_position(position)?)),
        );
    }
    if let Some(tags) = data.get("tags") {
        update = update.col_expr(mail_signatures::Column::Tags, Expr::value(tags.clone()));
    }
    update
        .filter(mail_signatures::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `DELETE /:id` (`softDeleteSignature`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = get_signature(&caller, &id).await? else {
            return Err(MailError::not_found("Signature", Some(&id)));
        };
        if is_shared(existing["type"].as_str().unwrap_or("personal"))
            && !caller.can("accounts:delete")
        {
            return Err(MailError::forbidden(SHARED_ONLY));
        }
        let at = utc_now();
        mail_signatures::Entity::update_many()
            .col_expr(mail_signatures::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_signatures::Column::UpdatedAt, Expr::value(at))
            .filter(mail_signatures::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            MAIL_SIGNATURE_DELETED,
            &id,
            &json!({ "id": id, "name": existing["name"] }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete signature")
}
