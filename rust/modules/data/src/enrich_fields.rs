//! `/api/enrich-fields`: the enrich field definitions, one provider and
//! operation enabled per entity type (`enrich_field_definitions`), an
//! org-level settings object (`settings:read`, `settings:manage`)
//! (`apps/workers/data-api/src/routes/enrich-fields/index.ts`).

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use futures_util::future::try_join_all;
use http::HeaderMap;
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ENRICH_FIELD_CREATED, ENRICH_FIELD_DELETED, ENRICH_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_crm_domain::validation::compute_changes;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, DataState, internal, now, validate, validate_query};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<DataState> {
    let read = || gate.require([perm::SETTINGS_READ]);
    let manage = || gate.require([perm::SETTINGS_MANAGE]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(read())
                .merge(axum::routing::post(create).route_layer(manage())),
        )
        .route("/reorder", put(reorder).route_layer(manage()))
        .route(
            "/{id}",
            put(update)
                .route_layer(manage())
                .merge(axum::routing::delete(remove).route_layer(manage())),
        )
}

/// `GET /?entityType=`: the live definitions, by sort order.
async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let entity_type = match validate_query(query.as_deref(), |issues, fields| {
        issues.string(fields, "entityType", false, None, None)
    }) {
        Ok(entity_type) => entity_type,
        Err(bad) => return *bad,
    };
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from enrich_field_definitions t
         where t.deleted_at is null and ($1::text is null or t.entity_type = $1)
         order by t.sort_order asc, t.created_at asc",
    )
    .bind(entity_type.filter(|e| !e.is_empty()))
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal(&error, "Failed to list enrich field definitions"),
    }
}

/// `PUT /reorder`: each live definition given its sort order.
async fn reorder(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let items = validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "items",
                Presence::Required,
                None,
                None,
                |issues, item| {
                    let fields = issues.object(item)?;
                    let id = issues.string(fields, "id", true, None, None);
                    let order = issues.integer(fields, "sortOrder", Presence::Required, None);
                    id.zip(order.into_option())
                },
            )
            .into_option()
    });
    let items = match items {
        Ok(Some(items)) => items,
        Ok(None) => return ApiError::internal().into_response(),
        Err(bad) => return *bad,
    };
    let at = now();
    let updates = items.iter().map(|(id, order)| {
        sqlx::query(
            "update enrich_field_definitions set sort_order = $2::int, updated_at = $3::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(order)
        .bind(&at)
        .execute(&caller.db)
    });
    match try_join_all(updates).await {
        Ok(_) => Data(json!({ "reordered": items.len() })).into_response(),
        Err(error) => internal(&error, "Failed to reorder enrich field definitions"),
    }
}

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z0-9_]+$").expect("slug pattern"));

/// `createEnrichFieldSchema`: the fields given, as Zod outputs them.
fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut data = Map::new();
    for (key, max) in [
        ("provider", 50),
        ("operation", 50),
        ("entityType", 50),
        ("name", 100),
    ] {
        if let Some(value) = issues.string(body, key, true, Some(1), Some(max)) {
            data.insert(key.into(), json!(value));
        }
    }
    if let Field::Set(slug) = issues.pattern(
        body,
        "slug",
        Presence::Required,
        Some(1),
        Some(100),
        |text| SLUG.is_match(text),
        "Invalid",
    ) {
        data.insert("slug".into(), json!(slug));
    }
    read_settings(issues, body, &mut data);
    data
}

/// `enabled`, `sortOrder` and `config`, shared with the update.
fn read_settings(issues: &mut Issues, body: &Map<String, Value>, data: &mut Map<String, Value>) {
    if let Field::Set(enabled) = issues.boolean(body, "enabled", Presence::Optional) {
        data.insert("enabled".into(), json!(enabled));
    }
    if let Field::Set(order) = issues.integer(body, "sortOrder", Presence::Optional, None) {
        data.insert("sortOrder".into(), json!(order));
    }
    if let Field::Set(config) = issues.nested(body, "config", Presence::Optional, |_, config| {
        Value::Object(config.clone())
    }) {
        data.insert("config".into(), config);
    }
}

async fn live_definition(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from enrich_field_definitions t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn definition(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from enrich_field_definitions t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> &'a str {
    data.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `POST /`: one definition per provider, operation and entity type.
async fn create(
    State(state): State<DataState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_create) {
        Ok(data) => data,
        Err(bad) => return *bad,
    };
    match insert(&caller.db, &data).await {
        Ok(Ok((id, created))) => {
            let mut event = data;
            event.insert("id".into(), json!(id));
            caller.publish(&state, ENRICH_FIELD_CREATED, &id, Value::Object(event));
            Created(created).into_response()
        }
        Ok(Err(conflict)) => conflict,
        Err(error) => internal(&error, "Failed to create enrich field definition"),
    }
}

/// The insert, or the 409 when the definition exists.
async fn insert(
    db: &PgPool,
    data: &Map<String, Value>,
) -> Result<Result<(String, Value), Response>, sqlx::Error> {
    let (provider, operation, entity_type) = (
        text(data, "provider"),
        text(data, "operation"),
        text(data, "entityType"),
    );
    let existing: Option<String> = sqlx::query_scalar(
        "select id from enrich_field_definitions
         where provider = $1 and operation = $2 and entity_type = $3 and deleted_at is null limit 1",
    )
    .bind(provider)
    .bind(operation)
    .bind(entity_type)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Ok(Err(ApiError::conflict(format!(
            "An enrich field for {provider}/{operation} on {entity_type} already exists"
        ))
        .into_response()));
    }
    let id = generate_id("efd");
    let at = now();
    sqlx::query(
        "insert into enrich_field_definitions
           (id, provider, operation, entity_type, name, slug, enabled, sort_order, config, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::int, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(provider)
    .bind(operation)
    .bind(entity_type)
    .bind(text(data, "name"))
    .bind(text(data, "slug"))
    .bind(data.get("enabled").and_then(Value::as_bool).unwrap_or(true))
    .bind(data.get("sortOrder").and_then(Value::as_i64).unwrap_or(0))
    .bind(data.get("config"))
    .bind(&at)
    .execute(db)
    .await?;
    let created = definition(db, &id).await?.unwrap_or(Value::Null);
    Ok(Ok((id, created)))
}

/// `PUT /:id`: `name`, `enabled`, `sortOrder`, `config` (the provider,
/// operation and entity type are fixed).
async fn update(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let mut data = Map::new();
        if let Some(name) = issues.string(body, "name", false, Some(1), Some(100)) {
            data.insert("name".into(), json!(name));
        }
        read_settings(issues, body, &mut data);
        data
    }) {
        Ok(data) => data,
        Err(bad) => return *bad,
    };
    let failed = |error: &sqlx::Error| internal(error, "Failed to update enrich field definition");
    let existing = match live_definition(&caller.db, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => {
            return ApiError::not_found("Enrich field definition", Some(&id)).into_response();
        }
        Err(error) => return failed(&error),
    };
    let written = sqlx::query(
        "update enrich_field_definitions set updated_at = $2::timestamp,
                name = coalesce($3, name),
                enabled = coalesce($4, enabled),
                sort_order = coalesce($5::int, sort_order),
                config = case when $6::boolean then $7 else config end
         where id = $1",
    )
    .bind(&id)
    .bind(now())
    .bind(data.get("name").and_then(Value::as_str))
    .bind(data.get("enabled").and_then(Value::as_bool))
    .bind(data.get("sortOrder").and_then(Value::as_i64))
    .bind(data.contains_key("config"))
    .bind(data.get("config"))
    .execute(&caller.db)
    .await;
    if let Err(error) = written {
        return failed(&error);
    }
    let updated = match definition(&caller.db, &id).await {
        Ok(updated) => updated.unwrap_or(Value::Null),
        Err(error) => return failed(&error),
    };
    let input = Value::Object(data.clone());
    if let Some(changes) = compute_changes(&existing, &input) {
        let mut event = data;
        event.insert("id".into(), json!(id));
        caller.publish_changes(
            &state,
            ENRICH_FIELD_UPDATED,
            &id,
            Value::Object(event),
            changes,
        );
    }
    Data(updated).into_response()
}

/// `DELETE /:id`: soft.
async fn remove(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let failed = |error: &sqlx::Error| internal(error, "Failed to delete enrich field definition");
    match live_definition(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return ApiError::not_found("Enrich field definition", Some(&id)).into_response();
        }
        Err(error) => return failed(&error),
    }
    let at = now();
    let written = sqlx::query(
        "update enrich_field_definitions set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&at)
    .execute(&caller.db)
    .await;
    if let Err(error) = written {
        return failed(&error);
    }
    caller.publish(&state, ENRICH_FIELD_DELETED, &id, json!({ "id": id }));
    Data(json!({ "deleted": true })).into_response()
}
