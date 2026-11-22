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
use sea_orm::sea_query::{Asterisk, Expr, Func, Order};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PICKER_CREATED, PICKER_DELETED, PICKER_UPDATED};
use weldsuite_catalogs::permission_keys::{
    WAREHOUSES_CREATE, WAREHOUSES_DELETE, WAREHOUSES_READ, WAREHOUSES_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{pick_lists, warehouse_workers};

use crate::args::{
    CursorRow, all_on, before, cursor_row, limit_plus_one, page_body, pushed, sliced, table_count,
    table_rows,
};
use crate::crud::{cursor_failed, soft_delete, write_failed};
use crate::js::{js_limit, number_text, query_param, query_set};
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

/// The status stats: live rows, optionally one warehouse's.
async fn status_stats(db: &PgPool, warehouse: Option<String>) -> Result<Value, DbErr> {
    use warehouse_workers::{Column, Entity};
    let status = |status: &str| Expr::from(Func::count(Expr::case(Column::Status.eq(status), 1)));
    let mut select = Entity::find()
        .select_only()
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total")
        .column_as(status("active"), "active")
        .column_as(status("inactive"), "inactive")
        .column_as(status("on_break"), "on_break")
        .filter(Column::DeletedAt.is_null());
    if let Some(warehouse) = warehouse {
        select = select.filter(Column::WarehouseId.eq(warehouse));
    }
    Ok(select
        .into_json()
        .one(&orm(db))
        .await?
        .unwrap_or_else(|| json!({})))
}

/// A filter that is set and not `all`.
fn set_not_all(query: Option<&str>, name: &str) -> Option<String> {
    query_set(query, name).filter(|value| value != "all")
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    use warehouse_workers::{Column, Entity};
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let cursor_given = query_set(query, "cursor");
    let cursor = match &cursor_given {
        Some(cursor) => {
            match cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let message = "Failed to list pickers";
    match fetch(
        &caller.db,
        query,
        cursor_given.is_some(),
        cursor.as_ref(),
        limit,
    )
    .await
    {
        Ok((rows, total, by_status)) => page_body(rows, limit, total, "stats", by_status),
        Err(error) => internal(&error, message),
    }
}

/// The page, its count and the status stats of every live picker.
async fn fetch(
    db: &PgPool,
    query: Option<&str>,
    cursor_given: bool,
    cursor: Option<&CursorRow>,
    limit: f64,
) -> Result<(Vec<Value>, i64, Value), DbErr> {
    use warehouse_workers::{Column, Entity};
    let eq = |value: Option<String>, column: Column| {
        value.map(|value| Condition::all().add(column.eq(value)))
    };
    let search = query_set(query, "search").map(|search| {
        let term = format!("%{search}%");
        Condition::any()
            .add(Column::Name.like(term.as_str()))
            .add(Column::Email.like(term.as_str()))
    });
    let slots = vec![
        Some(Condition::all().add(Column::DeletedAt.is_null())),
        search,
        eq(set_not_all(query, "status"), Column::Status),
        eq(set_not_all(query, "warehouseId"), Column::WarehouseId),
        eq(set_not_all(query, "role"), Column::Role),
        cursor.map(|cursor| before(Column::CreatedAt, Column::Id, cursor)),
    ];
    let on = pushed(&slots);
    let count_on = sliced(on.clone(), cursor_given);
    let mut page = WAREHOUSE_WORKERS.entity.select();
    page.cond_where(all_on(&slots, &on))
        .order_by((Entity, Column::CreatedAt), Order::Desc)
        .order_by((Entity, Column::Id), Order::Desc);
    limit_plus_one(&mut page, limit);
    let mut counted = WAREHOUSE_WORKERS.entity.select();
    counted.cond_where(all_on(&slots, &count_on));
    let rows = table_rows(db, &WAREHOUSE_WORKERS, &page).await?;
    let total = table_count(db, &WAREHOUSE_WORKERS, &counted).await?;
    let by_status = status_stats(db, None).await?;
    Ok((rows, total, by_status))
}

async fn stats(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let warehouse = set_not_all(query.as_deref(), "warehouseId");
    match status_stats(&caller.db, warehouse).await {
        Ok(stats) => Data(stats).into_response(),
        Err(error) => internal(&error, "Failed to fetch picker stats"),
    }
}

/// A picker's pick performance: their live pick lists, the completed
/// ones, and the items on them and picked.
async fn performance(db: &PgPool, id: &str) -> Result<Value, DbErr> {
    use pick_lists::{Column, Entity};
    let sum = |column: Column| {
        Expr::from(Func::coalesce([
            Expr::from(Func::sum(Expr::col((Entity, column)))),
            Expr::val(0),
        ]))
    };
    Ok(Entity::find()
        .select_only()
        .column_as(
            Expr::from(Func::count(Expr::col(Asterisk))),
            "totalPicklists",
        )
        .column_as(
            Expr::from(Func::count(Expr::case(Column::Status.eq("completed"), 1))),
            "completedPicklists",
        )
        .column_as(sum(Column::TotalItems), "totalItems")
        .column_as(sum(Column::PickedItems), "pickedItems")
        .filter(Column::AssignedTo.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_json()
        .one(&orm(db))
        .await?
        .unwrap_or_else(|| json!({})))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let message = "Failed to fetch picker";
    let row = match WAREHOUSE_WORKERS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Picker", &id).respond(message),
        Err(error) => return internal(&error, message),
    };
    let performance = match performance(&caller.db, &id).await {
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
    use pick_lists::{Column, Entity};
    let status = set_not_all(query.as_deref(), "status");
    let mut condition = Condition::all()
        .add(Column::AssignedTo.eq(id))
        .add(Column::DeletedAt.is_null());
    if let Some(status) = status {
        condition = condition.add(Column::Status.eq(status));
    }
    let mut select = PICK_LISTS.entity.select();
    select
        .cond_where(condition)
        .order_by((Entity, Column::CreatedAt), Order::Desc)
        .limit(50);
    match table_rows(&caller.db, &PICK_LISTS, &select).await {
        Ok(rows) => Data(rows).into_response(),
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
    let updated = warehouse_workers::Entity::update_many()
        .col_expr(warehouse_workers::Column::Status, Expr::value(text))
        .col_expr(warehouse_workers::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(warehouse_workers::Column::Id.eq(id.as_str()))
        .filter(warehouse_workers::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
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
