//! `/api/pickers`: warehouse workers (list with status stats, stats, detail
//! with pick performance, their pick lists, create, full update, status,
//! soft delete), backed by `warehouse_workers`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PICKER_CREATED, PICKER_DELETED, PICKER_UPDATED};
use weldsuite_catalogs::permission_keys::{
    WAREHOUSES_CREATE, WAREHOUSES_DELETE, WAREHOUSES_READ, WAREHOUSES_UPDATE,
};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_body, sliced};
use crate::crud::{cursor_failed, soft_delete, write_failed};
use crate::js::{js_limit, number_text, query_param, query_set, sql_limit};
use crate::tables::{PICK_LISTS, WAREHOUSE_WORKERS};
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WAREHOUSES_READ]);
    let update = || gate.require([WAREHOUSES_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([WAREHOUSES_CREATE])),
        )
        .route("/stats", get(stats).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", put(replace).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([WAREHOUSES_DELETE])),
        )
        .route("/{id}/picklists", get(pick_lists).route_layer(read()))
        .route("/{id}/status", patch(set_status).route_layer(update()))
}

macro_rules! conditions {
    () => {
        "(not $1::boolean or t.deleted_at is null) and (not $2::boolean or (t.name like $3 or t.email like $3)) \
         and (not $4::boolean or t.status = $5) and (not $6::boolean or t.warehouse_id = $7) \
         and (not $8::boolean or t.role = $9) \
         and (not $10::boolean or (t.created_at < $11::timestamp or (t.created_at = $11::timestamp and t.id < $12)))"
    };
}

const LIST_SQL: &str = concat!(
    "select to_jsonb(t) from warehouse_workers t where ",
    conditions!(),
    " order by t.created_at desc, t.id desc limit $13"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from warehouse_workers t where ",
    conditions!()
);

/// The status stats: live rows, optionally one warehouse's.
const STATS_SQL: &str = "select jsonb_build_object('total', count(*)::int, \
    'active', count(*) filter (where t.status = 'active')::int, \
    'inactive', count(*) filter (where t.status = 'inactive')::int, \
    'on_break', count(*) filter (where t.status = 'on_break')::int) \
    from warehouse_workers t where t.deleted_at is null and (not $1::boolean or t.warehouse_id = $2)";

/// A filter that is set and not `all`.
fn set_not_all(query: Option<&str>, name: &str) -> Option<String> {
    query_set(query, name).filter(|value| value != "all")
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let search = query_set(query, "search").map(|search| format!("%{search}%"));
    let status = set_not_all(query, "status");
    let warehouse = set_not_all(query, "warehouseId");
    let role = set_not_all(query, "role");
    let cursor_given = query_set(query, "cursor");
    let cursor = match &cursor_given {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("warehouse_workers"), cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let on = vec![
        true,
        search.is_some(),
        status.is_some(),
        warehouse.is_some(),
        role.is_some(),
        cursor.is_some(),
    ];
    let args = |on: &[bool]| {
        vec![
            Arg::Bool(on[0]),
            Arg::Bool(on[1]),
            Arg::Text(search.clone()),
            Arg::Bool(on[2]),
            Arg::Text(status.clone()),
            Arg::Bool(on[3]),
            Arg::Text(warehouse.clone()),
            Arg::Bool(on[4]),
            Arg::Text(role.clone()),
            Arg::Bool(on[5]),
            Arg::opt(cursor.as_ref().map(|(at, _)| at.as_str())),
            Arg::opt(cursor.as_ref().map(|(_, id)| id.as_str())),
        ]
    };
    let mut page = args(&on);
    page.push(Arg::Int(sql_limit(limit)));
    let count_on = sliced(on.clone(), cursor_given.is_some());
    let message = "Failed to list pickers";
    let rows: Vec<Value> = match bind_scalar(sqlx::query_scalar(LIST_SQL), page)
        .fetch_all(&caller.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return internal(&error, message),
    };
    let total: i64 = match bind_scalar(sqlx::query_scalar(COUNT_SQL), args(&count_on))
        .fetch_one(&caller.db)
        .await
    {
        Ok(total) => total,
        Err(error) => return internal(&error, message),
    };
    let by_status: Value = match sqlx::query_scalar(STATS_SQL)
        .bind(false)
        .bind(None::<&str>)
        .fetch_one(&caller.db)
        .await
    {
        Ok(counts) => counts,
        Err(error) => return internal(&error, message),
    };
    page_body(
        rows.into_iter()
            .map(|row| WAREHOUSE_WORKERS.js(row))
            .collect(),
        limit,
        total,
        "stats",
        by_status,
    )
}

async fn stats(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let warehouse = set_not_all(query.as_deref(), "warehouseId");
    match sqlx::query_scalar::<_, Value>(STATS_SQL)
        .bind(warehouse.is_some())
        .bind(warehouse)
        .fetch_one(&caller.db)
        .await
    {
        Ok(stats) => Data(stats).into_response(),
        Err(error) => internal(&error, "Failed to fetch picker stats"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let message = "Failed to fetch picker";
    let row = match WAREHOUSE_WORKERS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Picker", &id).respond(message),
        Err(error) => return internal(&error, message),
    };
    let performance: Value = match sqlx::query_scalar(
        "select jsonb_build_object('totalPicklists', count(*)::int, \
         'completedPicklists', count(*) filter (where t.status = 'completed')::int, \
         'totalItems', coalesce(sum(t.total_items), 0)::int, \
         'pickedItems', coalesce(sum(t.picked_items), 0)::int) \
         from pick_lists t where t.assigned_to = $1 and t.deleted_at is null",
    )
    .bind(&id)
    .fetch_one(&caller.db)
    .await
    {
        Ok(performance) => performance,
        Err(error) => return internal(&error, message),
    };
    let mut row = match row {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    row.insert("performance".to_owned(), performance);
    Data(Value::Object(row)).into_response()
}

async fn pick_lists(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let status = set_not_all(query.as_deref(), "status");
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from pick_lists t where t.assigned_to = $1 and t.deleted_at is null \
         and (not $2::boolean or t.status = $3) order by t.created_at desc limit 50",
    )
    .bind(&id)
    .bind(status.is_some())
    .bind(status)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|row| PICK_LISTS.js(row))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to fetch picker picklists"),
    }
}

/// `createPickerSchema` (`partial`: `updatePickerSchema`): the parsed body.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
fn schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    let mut out = Map::new();
    let text = |issues: &mut Issues, key: &str, presence: Presence, rules: Text, out: &mut Body| {
        match issues.text_with(body, key, presence, rules) {
            Field::Set(value) => {
                out.insert(key.to_owned(), Value::String(value));
            }
            Field::Null => {
                out.insert(key.to_owned(), Value::Null);
            }
            Field::Absent => {}
        }
    };
    text(
        issues,
        "userId",
        Presence::Nullish,
        Text::default(),
        &mut out,
    );
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    text(
        issues,
        "name",
        required,
        Text::length(Some(1), Some(255)),
        &mut out,
    );
    text(
        issues,
        "email",
        Presence::Optional,
        Text {
            format: Some(Format::Email),
            ..Text::length(None, Some(255))
        },
        &mut out,
    );
    text(
        issues,
        "phone",
        Presence::Optional,
        Text::length(None, Some(50)),
        &mut out,
    );
    text(
        issues,
        "warehouseId",
        Presence::Nullish,
        Text::default(),
        &mut out,
    );
    text(
        issues,
        "role",
        Presence::Optional,
        Text::default(),
        &mut out,
    );
    if !partial && !out.contains_key("role") {
        out.insert("role".to_owned(), json!("picker"));
    }
    if let Field::Set(status) = issues.choice(
        body,
        "status",
        Presence::Optional,
        &["active", "inactive", "on_break"],
    ) {
        out.insert("status".to_owned(), Value::String(status));
    } else if !partial && !body.contains_key("status") {
        out.insert("status".to_owned(), json!("active"));
    }
    if let Field::Set(skills) = issues.list(
        body,
        "skills",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    ) {
        out.insert("skills".to_owned(), json!(skills));
    }
    text(
        issues,
        "notes",
        Presence::Optional,
        Text::default(),
        &mut out,
    );
    if issues
        .nested(body, "metadata", Presence::Optional, |_, _| ())
        .as_set()
        .is_some()
    {
        out.insert(
            "metadata".to_owned(),
            body.get("metadata").cloned().unwrap_or(Value::Null),
        );
    }
    out
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        schema(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create picker"),
    };
    let id = generate_id("wkr");
    let now = now();
    let mut values = Map::new();
    WAREHOUSE_WORKERS.set(&mut values, "id", json!(id));
    for (key, value) in &data {
        WAREHOUSE_WORKERS.set(&mut values, key, value.clone());
    }
    WAREHOUSE_WORKERS.set(&mut values, "createdAt", json!(now));
    WAREHOUSE_WORKERS.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = WAREHOUSE_WORKERS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, "Failed to create picker");
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert(
        "name".to_owned(),
        data.get("name").cloned().unwrap_or(Value::Null),
    );
    if let Some(warehouse) = data.get("warehouseId") {
        event.insert("warehouseId".to_owned(), warehouse.clone());
    }
    caller.publish(&state, PICKER_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

async fn replace(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update picker";
    let data = match validate(&headers, &body, |issues, fields| {
        schema(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let existing = match WAREHOUSE_WORKERS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Picker", &id).respond(message),
        Err(error) => return internal(&error, message),
    };
    let mut values = Map::new();
    WAREHOUSE_WORKERS.set(&mut values, "updatedAt", json!(now()));
    for key in [
        "name",
        "email",
        "phone",
        "warehouseId",
        "role",
        "status",
        "skills",
        "notes",
        "userId",
        "metadata",
    ] {
        if let Some(value) = data.get(key) {
            WAREHOUSE_WORKERS.set(&mut values, key, value.clone());
        }
    }
    if let Err(error) = WAREHOUSE_WORKERS
        .patch(&caller.db, &id, values, true, &["updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    let name = data
        .get("name")
        .filter(|name| !name.is_null())
        .cloned()
        .unwrap_or_else(|| existing.get("name").cloned().unwrap_or(Value::Null));
    caller.publish(
        &state,
        PICKER_UPDATED,
        &id,
        &json!({ "id": id, "name": name }),
    );
    Data(json!({ "id": id })).into_response()
}

/// `PATCH /:id/status`: `await c.req.json().catch(() => ({}))`, then
/// `if (!status)`.
async fn set_status(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let message = "Failed to update picker status";
    let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    if body.is_null() {
        // `const { status } = null` throws outside the route's `try`.
        return ApiError::internal().into_response();
    }
    let status = body.get("status").cloned().unwrap_or(Value::Null);
    let truthy = match &status {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    if !truthy {
        return Refusal::bad_request("Status is required").respond(message);
    }
    match WAREHOUSE_WORKERS.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Picker", &id).respond(message),
        Err(error) => return internal(&error, message),
    }
    let text = match &status {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    };
    let updated = sqlx::query(
        "update warehouse_workers set status = $2, updated_at = $3::timestamp \
         where id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&text)
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = updated {
        return internal(&error, message);
    }
    caller.publish(
        &state,
        PICKER_UPDATED,
        &id,
        &json!({ "id": id, "status": status }),
    );
    Data(json!({ "id": id, "status": status })).into_response()
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = "Failed to delete picker";
    let existing = match WAREHOUSE_WORKERS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Picker", &id).respond(message),
        Err(error) => return internal(&error, message),
    };
    if let Err(error) = soft_delete(&caller.db, &WAREHOUSE_WORKERS, &id).await {
        return write_failed(&error, message);
    }
    caller.publish(
        &state,
        PICKER_DELETED,
        &id,
        &json!({ "id": id, "name": existing.get("name") }),
    );
    NoContent.into_response()
}
