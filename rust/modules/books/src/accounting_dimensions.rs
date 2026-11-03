//! `/api/accounting-dimensions` (`routes/accounting-dimensions/index.ts`):
//! reporting dimensions (classes and locations) of an entity. A value may sit
//! under a parent of the same dimension; one that is on any line can only be
//! deactivated.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::tables::ACCOUNTING_DIMENSION_VALUES as T;
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_DIMENSION_CREATED, ACCOUNTING_DIMENSION_DELETED, ACCOUNTING_DIMENSION_UPDATED,
};
use weldsuite_kit::cursor::{atob, btoa, decode_uri_component, encode_uri_component};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

const DIMENSIONS: [&str; 2] = ["class", "location"];

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("accounts:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("accounts:create")),
        )
        .route("/{id}", get(detail).route_layer(need("accounts:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("accounts:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("accounts:delete")),
        )
        .with_state(state)
}

/// The body, as `createSchema` / `updateSchema` parse it: the fields given,
/// trimmed, in the schema's order.
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut out = Map::new();
    if !partial
        && let Field::Set(dimension) =
            issues.choice(body, "dimension", Presence::Required, &DIMENSIONS)
    {
        out.insert("dimension".to_owned(), json!(dimension));
    }
    let name_presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    if let Field::Set(name) = issues.text_with(
        body,
        "name",
        name_presence,
        Text::trimmed(Some(1), Some(255)),
    ) {
        out.insert("name".to_owned(), json!(name));
    }
    match issues.text_with(
        body,
        "code",
        Presence::Nullish,
        Text::trimmed(Some(1), Some(30)),
    ) {
        Field::Set(code) => {
            out.insert("code".to_owned(), json!(code));
        }
        Field::Null => {
            out.insert("code".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    match issues.text(body, "parentId", Presence::Nullish, None, Some(30)) {
        Field::Set(parent) => {
            out.insert("parentId".to_owned(), json!(parent));
        }
        Field::Null => {
            out.insert("parentId".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    if let Field::Set(active) = issues.boolean(body, "isActive", Presence::Optional) {
        out.insert("isActive".to_owned(), json!(active));
    }
    out
}

fn event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "dimension": row["dimension"],
        "name": row["name"],
        "code": row["code"],
        "parentId": row["parentId"],
        "isActive": row["isActive"],
    })
}

/// `btoa(encodeURIComponent(JSON.stringify([name, id])))`.
fn encode_cursor(row: &Value) -> Option<String> {
    let tuple = json!([row["name"], row["id"]]).to_string();
    btoa(&encode_uri_component(&tuple))
}

/// The `[name, id]` of a cursor, or `None` when it isn't one.
fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let text = decode_uri_component(&atob(cursor)?)?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Array(items) => match (items.first(), items.get(1)) {
            (Some(Value::String(name)), Some(Value::String(id))) => {
                Some((name.clone(), id.clone()))
            }
            _ => None,
        },
        _ => None,
    }
}

async fn find_value(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(accounting_dimension_values),
        " from accounting_dimension_values t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| T.js(row)))
}

/// `parentError`: why `parent_id` can't be the parent of a value of this
/// dimension (`self_id` when updating), or `None`.
async fn parent_error(
    caller: &Caller,
    entity_id: &str,
    dimension: &str,
    parent_id: &str,
    self_id: Option<&str>,
) -> Result<Option<&'static str>, sqlx::Error> {
    if Some(parent_id) == self_id {
        return Ok(Some("A value cannot be its own parent"));
    }
    let mut cursor = Some(parent_id.to_owned());
    let mut depth = 0;
    while let Some(id) = cursor.filter(|id| !id.is_empty()) {
        if depth >= 25 {
            break;
        }
        let parent = find_value(caller, &id).await?;
        let Some(parent) = parent.filter(|p| {
            p["entityId"].as_str() == Some(entity_id) && p["dimension"].as_str() == Some(dimension)
        }) else {
            return Ok((depth == 0)
                .then_some("The parent must be an existing value of the same dimension"));
        };
        if let Some(self_id) = self_id
            && parent["parentId"].as_str() == Some(self_id)
        {
            return Ok(Some("That parent would make the hierarchy circular"));
        }
        cursor = parent["parentId"].as_str().map(str::to_owned);
        depth += 1;
    }
    Ok(None)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_values(&caller, &q).await,
        "Failed to fetch dimension values",
    )
}

async fn list_values(caller: &Caller, q: &Query) -> Reply {
    // `Math.min(Math.max(Number.parseInt(q.limit || '200', 10) || 200, 1), 500)`
    let limit = q
        .present("limit")
        .and_then(weldsuite_books_domain::js::parse_int)
        .filter(|n| *n != 0)
        .unwrap_or(200)
        .clamp(1, 500);
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let dimension = q.present("dimension");
    if let Some(dimension) = dimension
        && !DIMENSIONS.contains(&dimension)
    {
        return Err(Refusal::bad_request(
            "dimension must be 'class' or 'location'",
        ));
    }
    let active = q.get("isActive").map(|v| v == "true");
    let parent = q.present("parentId");
    let search = q.present("search").map(|s| format!("%{s}%"));
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from accounting_dimension_values where deleted_at is null and entity_id = $1 \
         and ($2::text is null or dimension = $2) and ($3::boolean is null or is_active = $3) \
         and ($4::text is null or parent_id = $4) and ($5::text is null or (name like $5 or code like $5))",
    )
    .bind(&entity_id)
    .bind(dimension)
    .bind(active)
    .bind(parent)
    .bind(&search)
    .fetch_one(&caller.db)
    .await?;
    let after = match q.present("cursor") {
        Some(cursor) => match decode_cursor(cursor) {
            Some(after) => Some(after),
            None => return Err(Refusal::bad_request("Invalid cursor")),
        },
        None => None,
    };
    let (after_name, after_id) = after.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(accounting_dimension_values),
        " from accounting_dimension_values t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.dimension = $2) and ($3::boolean is null or t.is_active = $3) \
         and ($4::text is null or t.parent_id = $4) and ($5::text is null or (t.name like $5 or t.code like $5)) \
         and ($6::text is null or (t.name, t.id) > ($6::text, $7::text)) \
         order by t.name, t.id limit $8"
    ))
    .bind(&entity_id)
    .bind(dimension)
    .bind(active)
    .bind(parent)
    .bind(&search)
    .bind(after_name)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let mut rows = T.js_rows(rows);
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let cursor = if has_more {
        rows.last().and_then(encode_cursor)
    } else {
        None
    };
    Ok(paged(rows, total, has_more, cursor))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find_value(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Dimension value", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch dimension value")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create dimension value"),
    };
    reply(
        create_value(&caller, &state, data).await,
        "Failed to create dimension value",
    )
}

async fn create_value(caller: &Caller, state: &BooksState, data: Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let dimension = data["dimension"].as_str().unwrap_or_default().to_owned();
    if let Some(code) = data
        .get("code")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        let duplicate: Option<String> = sqlx::query_scalar(
            "select id from accounting_dimension_values where entity_id = $1 and dimension = $2 \
             and code = $3 and deleted_at is null limit 1",
        )
        .bind(&entity_id)
        .bind(&dimension)
        .bind(code)
        .fetch_optional(db)
        .await?;
        if duplicate.is_some() {
            return Err(Refusal::conflict(format!(
                "Code '{code}' is already used by another {dimension}"
            )));
        }
    }
    if let Some(parent) = data
        .get("parentId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        && let Some(problem) = parent_error(caller, &entity_id, &dimension, parent, None).await?
    {
        return Err(Refusal::bad_request(problem));
    }
    let at = now();
    let id = generate_id("dim");
    let mut values = Map::new();
    for (key, value) in [
        ("id", json!(id)),
        ("entityId", json!(entity_id)),
        ("dimension", json!(dimension)),
        ("name", data["name"].clone()),
        ("code", data.get("code").cloned().unwrap_or(Value::Null)),
        (
            "parentId",
            data.get("parentId").cloned().unwrap_or(Value::Null),
        ),
        (
            "isActive",
            data.get("isActive").cloned().unwrap_or(json!(true)),
        ),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
        ("deletedAt", Value::Null),
    ] {
        T.set(&mut values, key, value);
    }
    let row = T.insert_raw(db, values).await?;
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_dimension",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(state, ACCOUNTING_DIMENSION_CREATED, &id, event_data(&row));
    Ok(created(row))
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update dimension value"),
    };
    reply(
        update_value(&caller, &state, &id, data).await,
        "Failed to update dimension value",
    )
}

async fn update_value(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_value(caller, id).await? else {
        return Err(Refusal::not_found("Dimension value", id));
    };
    let entity_id = existing["entityId"].as_str().unwrap_or_default().to_owned();
    let dimension = existing["dimension"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if let Some(code) = data
        .get("code")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        && existing["code"].as_str() != Some(code)
    {
        let duplicate: Option<String> = sqlx::query_scalar(
            "select id from accounting_dimension_values where entity_id = $1 and dimension = $2 \
             and code = $3 and deleted_at is null limit 1",
        )
        .bind(&entity_id)
        .bind(&dimension)
        .bind(code)
        .fetch_optional(db)
        .await?;
        if duplicate.is_some_and(|dup| dup != id) {
            return Err(Refusal::conflict(format!(
                "Code '{code}' is already used by another {dimension}"
            )));
        }
    }
    if let Some(parent) = data
        .get("parentId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        && let Some(problem) =
            parent_error(caller, &entity_id, &dimension, parent, Some(id)).await?
    {
        return Err(Refusal::bad_request(problem));
    }
    let mut values = T.values(&data);
    T.set(&mut values, "updatedAt", json!(now()));
    let Some(updated) = T.patch_raw(db, id, values, true).await? else {
        return Err(Refusal::not_found("Dimension value", id));
    };
    let changes: Map<String, Value> = data
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                change(
                    existing.get(key).cloned().unwrap_or(Value::Null),
                    value.clone(),
                ),
            )
        })
        .collect();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_dimension",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_DIMENSION_UPDATED,
        id,
        event_data(&updated),
    );
    Ok(ok(updated))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_value(&caller, &state, &id).await,
        "Failed to delete dimension value",
    )
}

async fn remove_value(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_value(caller, id).await? else {
        return Err(Refusal::not_found("Dimension value", id));
    };
    let child: Option<String> = sqlx::query_scalar(
        "select id from accounting_dimension_values where parent_id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if child.is_some() {
        return Err(Refusal::conflict(
            "This value has children — move or delete them first",
        ));
    }
    let dimension = existing["dimension"].as_str().unwrap_or_default();
    let used: bool = if dimension == "class" {
        sqlx::query_scalar(
            "select exists (select 1 from journal_lines where class_id = $1 and deleted_at is null) \
             or exists (select 1 from invoice_items where class_id = $1 and deleted_at is null) \
             or exists (select 1 from bill_items where class_id = $1 and deleted_at is null)",
        )
        .bind(id)
        .fetch_one(db)
        .await?
    } else {
        sqlx::query_scalar(
            "select exists (select 1 from journal_lines where location_id = $1 and deleted_at is null) \
             or exists (select 1 from invoice_items where location_id = $1 and deleted_at is null) \
             or exists (select 1 from bill_items where location_id = $1 and deleted_at is null)",
        )
        .bind(id)
        .fetch_one(db)
        .await?
    };
    if used {
        return Err(Refusal::conflict(format!(
            "This {dimension} is used on bookings — deactivate it instead"
        )));
    }
    let at = now();
    sqlx::query(
        "update accounting_dimension_values set deleted_at = $1::timestamp, is_active = false, \
         updated_at = $1::timestamp where id = $2",
    )
    .bind(&at)
    .bind(id)
    .execute(db)
    .await?;
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: existing["entityId"].as_str(),
            entity_type: "accounting_dimension",
            entity_id: id,
            action: "deleted",
            changes: None,
        },
    )
    .await;
    caller.publish(state, ACCOUNTING_DIMENSION_DELETED, id, json!({ "id": id }));
    Ok(no_content())
}
