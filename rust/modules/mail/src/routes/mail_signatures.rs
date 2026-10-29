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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_SIGNATURE_CREATED, MAIL_SIGNATURE_DELETED, MAIL_SIGNATURE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{ACCOUNTS_READ, MESSAGES_CREATE};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{
    MailError, answer, list_response, now, page, strings, validate, validate_query,
};
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

/// `visibleTo(userId)` over `mail_signatures s`, the user as `$1`.
macro_rules! visible {
    () => {
        "(s.type <> 'personal' or s.user_ids @> jsonb_build_array($1::text))"
    };
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
async fn get_signature(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(s) from mail_signatures s
         where s.id = $2 and s.deleted_at is null and ",
        visible!(),
        " limit 1"
    ))
    .bind(&caller.user_id)
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
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
        (kind.into_option(), limit.into_option(), cursor.into_option())
    });
    let (kind, limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let limit = limit.unwrap_or(50).min(100);
        let cursor_row: Option<(String, String)> =
            match cursor.as_deref().filter(|c| !c.is_empty()) {
                Some(cursor) => {
                    sqlx::query_as(
                        "select to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
                         from mail_signatures where id = $1 limit 1",
                    )
                    .bind(cursor)
                    .fetch_optional(&caller.db)
                    .await?
                }
                None => None,
            };
        let (cursor_at, cursor_id) = cursor_row.unzip();
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(s) from mail_signatures s
             where s.deleted_at is null and ",
            visible!(),
            " and ($2::text is null or s.type = $2::mail_signature_type)
               and ($3::timestamp is null or (s.created_at < $3::timestamp
                    or (s.created_at = $3::timestamp and s.id < $4)))
             order by s.created_at desc, s.id desc limit $5"
        ))
        .bind(&caller.user_id)
        .bind(&kind)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i32 = sqlx::query_scalar(concat!(
            "select count(*)::int from mail_signatures s where s.deleted_at is null and ",
            visible!(),
            " and ($2::text is null or s.type = $2::mail_signature_type)"
        ))
        .bind(&caller.user_id)
        .bind(&kind)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, i64::from(total), has_more, next))
    }
    .await;
    answer(result, "Failed to list signatures")
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
fn read_signature(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
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
    if let Some(v) = issues.boolean(body, "isDefault", Presence::Optional).into_option() {
        out.insert("isDefault".into(), Value::Bool(v));
    }
    if let Some(v) = issues.choice(body, "type", Presence::Optional, &TYPES).into_option() {
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
) -> Result<(), sqlx::Error> {
    let defaults: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, account_ids from mail_signatures
         where deleted_at is null and is_default = true and id <> $1
           and (case when $2 then type <> 'personal'
                else type = 'personal' and user_ids @> jsonb_build_array($3::text) end)",
    )
    .bind(id)
    .bind(is_shared(kind))
    .bind(&caller.user_id)
    .fetch_all(&caller.db)
    .await?;
    let competing: Vec<String> = defaults
        .into_iter()
        .filter(|(_, accounts)| {
            accounts_overlap(&accounts.as_ref().map(strings).unwrap_or_default(), account_ids)
        })
        .map(|(id, _)| id)
        .collect();
    if competing.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "update mail_signatures set is_default = false, updated_at = $2::timestamp
         where id = any($1::text[])",
    )
    .bind(&competing)
    .bind(now())
    .execute(&caller.db)
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
        sqlx::query(
            "insert into mail_signatures (id, name, content, is_default, account_ids, user_ids,
               type, include_in_replies, include_in_forwards, position, tags, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7::mail_signature_type, coalesce($8, true),
               coalesce($9, true), coalesce($10::mail_signature_position, 'below'), $11,
               $12::timestamp, $12::timestamp)",
        )
        .bind(&id)
        .bind(text(&data, "name"))
        .bind(text(&data, "content"))
        .bind(flag(&data, "isDefault").unwrap_or(false))
        .bind(data.get("accountIds").cloned())
        .bind(user_ids)
        .bind(&kind)
        .bind(flag(&data, "includeInReplies"))
        .bind(flag(&data, "includeInForwards"))
        .bind(text(&data, "position"))
        .bind(data.get("tags").cloned())
        .bind(now())
        .execute(&caller.db)
        .await?;
        if flag(&data, "isDefault") == Some(true) {
            let accounts = data.get("accountIds").map(strings).unwrap_or_default();
            clear_competing_defaults(&caller, &id, &kind, &accounts).await?;
        }
        let row: Value =
            sqlx::query_scalar("select to_jsonb(s) from mail_signatures s where s.id = $1")
                .bind(&id)
                .fetch_one(&caller.db)
                .await?;
        let row = js_row(row);
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
        sqlx::query(
            "update mail_signatures set updated_at = $2::timestamp,
               name = coalesce($3, name), content = coalesce($4, content),
               is_default = coalesce($5, is_default),
               type = coalesce($6::mail_signature_type, type),
               account_ids = coalesce($7, account_ids),
               user_ids = case when $8 then $9 else user_ids end,
               include_in_replies = coalesce($10, include_in_replies),
               include_in_forwards = coalesce($11, include_in_forwards),
               position = coalesce($12::mail_signature_position, position),
               tags = coalesce($13, tags)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text(&data, "name"))
        .bind(text(&data, "content"))
        .bind(flag(&data, "isDefault"))
        .bind(text(&data, "type"))
        .bind(data.get("accountIds").cloned())
        .bind(user_ids.is_some())
        .bind(user_ids.flatten())
        .bind(flag(&data, "includeInReplies"))
        .bind(flag(&data, "includeInForwards"))
        .bind(text(&data, "position"))
        .bind(data.get("tags").cloned())
        .execute(&caller.db)
        .await?;
        let after: Value =
            sqlx::query_scalar("select to_jsonb(s) from mail_signatures s where s.id = $1")
                .bind(&id)
                .fetch_one(&caller.db)
                .await?;
        let after = js_row(after);
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

/// `DELETE /:id` (`softDeleteSignature`).
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = get_signature(&caller, &id).await? else {
            return Err(MailError::not_found("Signature", Some(&id)));
        };
        if is_shared(existing["type"].as_str().unwrap_or("personal"))
            && !caller.can("accounts:delete")
        {
            return Err(MailError::forbidden(SHARED_ONLY));
        }
        sqlx::query(
            "update mail_signatures set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
