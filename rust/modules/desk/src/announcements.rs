//! `routes/helpdesk-announcements/index.ts`: `/helpdesk-announcements`, the
//! status banners the help center and the widget show. The list, detail and
//! soft delete are the shared CRUD's ([`crate::simple::ANNOUNCEMENTS`]);
//! create and update write only the columns the schema names (`columnsOf`):
//! the author is the caller, and publishing without a `publishedAt` stamps it.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::js_date_iso;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Listing, Partial, fetch, page_list, soft_delete, write_failed};
use crate::simple::{ANNOUNCEMENTS, announcement_schema};
use crate::{Caller, DeskState, Refusal, now, validate};

/// The routes at `/helpdesk-announcements`, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    let gates = &ANNOUNCEMENTS.gates;
    Router::new()
        .route("/", get(list).route_layer(need(gates.read)))
        .route("/", post(create).route_layer(need(gates.create)))
        .route("/{id}", get(detail).route_layer(need(gates.read)))
        .route("/{id}", patch(update).route_layer(need(gates.update)))
        .route("/{id}", delete(remove).route_layer(need(gates.delete)))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let listing = Listing {
        table: ANNOUNCEMENTS.table,
        filters: ANNOUNCEMENTS.filters,
        list_sql: ANNOUNCEMENTS.list_sql,
        count_sql: ANNOUNCEMENTS.count_sql,
        slice_count: ANNOUNCEMENTS.slice_count,
    };
    match fetch(listing, &caller.db, query.as_deref()).await {
        Ok(fetched) => page_list(fetched.rows, fetched.limit, fetched.total),
        Err(error) => error.respond(ANNOUNCEMENTS.messages.list),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let message = ANNOUNCEMENTS.messages.fetch;
    match ANNOUNCEMENTS.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found(ANNOUNCEMENTS.resource, &id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

/// The body as the schema let it through.
fn read_body(
    headers: &HeaderMap,
    body: &Bytes,
    partial: bool,
) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        announcement_schema(issues, fields, Partial(partial));
        fields.clone()
    })
}

/// An ISO datetime from the body as `new Date(value)` stores it; null stays null.
fn date_of(value: &Value) -> Value {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .and_then(js_date_iso)
        .map_or(Value::Null, Value::String)
}

/// `columnsOf(data)`: the columns the body sets.
fn columns_of(data: &Map<String, Value>) -> Map<String, Value> {
    let table = ANNOUNCEMENTS.table;
    let mut values = Map::new();
    for prop in [
        "title",
        "content",
        "excerpt",
        "type",
        "status",
        "visibility",
        "targetGroups",
        "featuredImage",
        "authorName",
        "isPinned",
    ] {
        if let Some(value) = data.get(prop) {
            table.set(&mut values, prop, value.clone());
        }
    }
    for prop in ["publishedAt", "expiresAt"] {
        if let Some(value) = data.get(prop) {
            table.set(&mut values, prop, date_of(value));
        }
    }
    values
}

const DATES: [&str; 4] = ["createdAt", "updatedAt", "publishedAt", "expiresAt"];

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = ANNOUNCEMENTS.messages.create;
    let data = match read_body(&headers, &body, false) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let table = ANNOUNCEMENTS.table;
    let id = generate_id(ANNOUNCEMENTS.id_prefix);
    let now = now();
    let mut values = columns_of(&data);
    let published = data.get("status").and_then(Value::as_str) == Some("published");
    let published_at = data.get("publishedAt").map_or(Value::Null, date_of);
    let published_at = if published_at.is_null() && published {
        json!(now)
    } else {
        published_at
    };
    table.set(&mut values, "id", json!(id));
    table.set(&mut values, "authorId", json!(caller.user_id));
    table.set(&mut values, "publishedAt", published_at);
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = table.insert(&caller.db, values, &DATES).await {
        return write_failed(&error, message);
    }
    caller.publish(
        &state,
        ANNOUNCEMENTS.created,
        &id,
        &json!({ "id": id, "title": data.get("title") }),
    );
    Created(json!({ "id": id })).into_response()
}

async fn update(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = ANNOUNCEMENTS.messages.update;
    let data = match read_body(&headers, &body, true) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let table = ANNOUNCEMENTS.table;
    let existing = match table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found(ANNOUNCEMENTS.resource, &id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now));
    values.extend(columns_of(&data));
    // Published now, never before, no date given: it shows from now.
    let publishing = data.get("status").and_then(Value::as_str) == Some("published")
        && existing["status"].as_str() != Some("published");
    let no_date = data
        .get("publishedAt")
        .is_none_or(|value| date_of(value).is_null());
    if publishing && no_date && existing["publishedAt"].is_null() {
        table.set(&mut values, "publishedAt", json!(now));
    }
    if let Err(error) = table.patch(&caller.db, &id, values, true, &DATES).await {
        return write_failed(&error, message);
    }
    let title = data
        .get("title")
        .filter(|title| !title.is_null())
        .cloned()
        .unwrap_or_else(|| existing["title"].clone());
    caller.publish(
        &state,
        ANNOUNCEMENTS.updated,
        &id,
        &json!({ "id": id, "title": title }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = ANNOUNCEMENTS.messages.delete;
    match ANNOUNCEMENTS.table.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found(ANNOUNCEMENTS.resource, &id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    }
    if let Err(error) = soft_delete(&caller.db, ANNOUNCEMENTS.table, &id).await {
        return write_failed(&error, message);
    }
    caller.publish(&state, ANNOUNCEMENTS.deleted, &id, &json!({ "id": id }));
    NoContent.into_response()
}
