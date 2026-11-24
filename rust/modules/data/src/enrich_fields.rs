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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ENRICH_FIELD_CREATED, ENRICH_FIELD_DELETED, ENRICH_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_crm_domain::validation::compute_changes;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enrich_field_definitions::{self, Column as Definition};

use crate::service::{int4, js, js_rows};
use crate::{Caller, DataState, internal, validate, validate_query};

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
    let mut found =
        enrich_field_definitions::Entity::find().filter(Definition::DeletedAt.is_null());
    if let Some(entity_type) = entity_type.filter(|e| !e.is_empty()) {
        found = found.filter(Definition::EntityType.eq(entity_type));
    }
    let found = found
        .order_by_asc(Definition::SortOrder)
        .order_by_asc(Definition::CreatedAt)
        .all(&orm(&caller.db))
        .await;
    match found.and_then(js_rows) {
        Ok(rows) => Data(rows).into_response(),
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
    let at = utc_now();
    let db = orm(&caller.db);
    let updates = items.iter().map(|(id, order)| {
        let db = &db;
        async move {
            enrich_field_definitions::Entity::update_many()
                .col_expr(Definition::SortOrder, Expr::value(int4(*order)?))
                .col_expr(Definition::UpdatedAt, Expr::value(at))
                .filter(Definition::Id.eq(id.as_str()))
                .filter(Definition::DeletedAt.is_null())
                .exec(db)
                .await
        }
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

async fn live_definition(db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
    let row = enrich_field_definitions::Entity::find_by_id(id)
        .filter(Definition::DeletedAt.is_null())
        .one(db)
        .await?;
    row.map(js).transpose()
}

async fn definition(db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
    let row = enrich_field_definitions::Entity::find_by_id(id)
        .one(db)
        .await?;
    row.map(js).transpose()
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
    match insert(&orm(&caller.db), &data).await {
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
    db: &DatabaseConnection,
    data: &Map<String, Value>,
) -> Result<Result<(String, Value), Response>, DbErr> {
    let (provider, operation, entity_type) = (
        text(data, "provider"),
        text(data, "operation"),
        text(data, "entityType"),
    );
    let existing: Option<String> = enrich_field_definitions::Entity::find()
        .select_only()
        .column(Definition::Id)
        .filter(Definition::Provider.eq(provider))
        .filter(Definition::Operation.eq(operation))
        .filter(Definition::EntityType.eq(entity_type))
        .filter(Definition::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    if existing.is_some() {
        return Ok(Err(ApiError::conflict(format!(
            "An enrich field for {provider}/{operation} on {entity_type} already exists"
        ))
        .into_response()));
    }
    let id = generate_id("efd");
    let at = utc_now();
    enrich_field_definitions::Entity::insert(enrich_field_definitions::ActiveModel {
        id: Set(id.clone()),
        provider: Set(provider.to_owned()),
        operation: Set(operation.to_owned()),
        entity_type: Set(entity_type.to_owned()),
        name: Set(text(data, "name").to_owned()),
        slug: Set(text(data, "slug").to_owned()),
        enabled: Set(data.get("enabled").and_then(Value::as_bool).unwrap_or(true)),
        sort_order: Set(int4(
            data.get("sortOrder").and_then(Value::as_i64).unwrap_or(0),
        )?),
        config: Set(data.get("config").cloned()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(db)
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
    let failed = |error: &DbErr| internal(error, "Failed to update enrich field definition");
    let db = orm(&caller.db);
    let existing = match live_definition(&db, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => {
            return ApiError::not_found("Enrich field definition", Some(&id)).into_response();
        }
        Err(error) => return failed(&error),
    };
    if let Err(error) = write_update(&db, &id, &data).await {
        return failed(&error);
    }
    let updated = match definition(&db, &id).await {
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

/// The update's statement: `updatedAt` and the fields given.
async fn write_update(
    db: &DatabaseConnection,
    id: &str,
    data: &Map<String, Value>,
) -> Result<(), DbErr> {
    let mut update = enrich_field_definitions::Entity::update_many()
        .col_expr(Definition::UpdatedAt, Expr::value(utc_now()));
    if let Some(name) = data.get("name").and_then(Value::as_str) {
        update = update.col_expr(Definition::Name, Expr::value(name));
    }
    if let Some(enabled) = data.get("enabled").and_then(Value::as_bool) {
        update = update.col_expr(Definition::Enabled, Expr::value(enabled));
    }
    if let Some(order) = data.get("sortOrder").and_then(Value::as_i64) {
        update = update.col_expr(Definition::SortOrder, Expr::value(int4(order)?));
    }
    if let Some(config) = data.get("config") {
        update = update.col_expr(Definition::Config, Expr::value(config.clone()));
    }
    update.filter(Definition::Id.eq(id)).exec(db).await?;
    Ok(())
}

/// `DELETE /:id`: soft.
async fn remove(
    State(state): State<DataState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let failed = |error: &DbErr| internal(error, "Failed to delete enrich field definition");
    let db = orm(&caller.db);
    match live_definition(&db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return ApiError::not_found("Enrich field definition", Some(&id)).into_response();
        }
        Err(error) => return failed(&error),
    }
    let at = utc_now();
    let written = enrich_field_definitions::Entity::update_many()
        .col_expr(Definition::DeletedAt, Expr::value(at))
        .col_expr(Definition::UpdatedAt, Expr::value(at))
        .filter(Definition::Id.eq(id.as_str()))
        .exec(&db)
        .await;
    if let Err(error) = written {
        return failed(&error);
    }
    caller.publish(&state, ENRICH_FIELD_DELETED, &id, json!({ "id": id }));
    Data(json!({ "deleted": true })).into_response()
}
