//! `/api/enrichments`: read-only views over the enrichment results, the
//! enabled definitions and the enrichment log (`contacts:read`)
//! (`apps/workers/data-api/src/routes/enrichments/index.ts`).

use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::Value;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enrich_field_definitions::{self, Column as Definition};
use weldsuite_schema::tenant::enrich_field_results::{self, Column as FieldResult};
use weldsuite_schema::tenant::enrichment_logs::{self, Column as Log};

use crate::js::{js_limit, js_slice, query_param, sql_limit, text};
use crate::service::{before, cursor_row, js, js_rows};
use crate::{Caller, DataState, internal};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<DataState> {
    let read = || gate.require([perm::CONTACTS_READ]);
    Router::new()
        .route("/", get(results).route_layer(read()))
        .route("/definitions", get(definitions).route_layer(read()))
        .route("/logs", get(logs).route_layer(read()))
}

/// `c.req.query()[name]`, a falsy (empty) value as none.
fn param(query: Option<&str>, name: &str) -> Option<String> {
    query_param(query, name).filter(|value| !value.is_empty())
}

/// `GET /?entityType=&entityId=`: the latest result per field for a record.
async fn results(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (Some(entity_type), Some(entity_id)) = (
        param(query.as_deref(), "entityType"),
        param(query.as_deref(), "entityId"),
    ) else {
        return ApiError::bad_request("entityType and entityId are required").into_response();
    };
    let found = enrich_field_results::Entity::find()
        .filter(FieldResult::EntityType.eq(entity_type))
        .filter(FieldResult::EntityId.eq(entity_id))
        .order_by_asc(FieldResult::Provider)
        .order_by_asc(FieldResult::Operation)
        .all(&orm(&caller.db))
        .await;
    match found.and_then(js_rows) {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to list enrichment results"),
    }
}

/// `GET /definitions?entityType=&enabled=true`: the live definitions of an
/// entity type.
async fn definitions(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let Some(entity_type) = param(query.as_deref(), "entityType") else {
        return ApiError::bad_request("entityType is required").into_response();
    };
    let enabled_only = query_param(query.as_deref(), "enabled").as_deref() == Some("true");
    let mut found = enrich_field_definitions::Entity::find()
        .filter(Definition::DeletedAt.is_null())
        .filter(Definition::EntityType.eq(entity_type));
    if enabled_only {
        found = found.filter(Definition::Enabled.eq(true));
    }
    let found = found
        .order_by_asc(Definition::SortOrder)
        .order_by_asc(Definition::Name)
        .all(&orm(&caller.db))
        .await;
    match found.and_then(js_rows) {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to list enrichment definitions"),
    }
}

/// `GET /logs`: the enrichment log, newest first, by cursor. With a cursor
/// the count leaves out the last filter, as the worker's does.
async fn logs(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 50.0, 100.0);
    let entity_type = param(query, "entityType");
    let entity_id = param(query, "entityId");
    let cursor = param(query, "cursor");
    let db = orm(&caller.db);

    // The conditions in order: entityType, entityId, the keyset.
    let mut conditions: Vec<Condition> = Vec::new();
    if let Some(entity_type) = &entity_type {
        conditions.push(Condition::all().add(Log::EntityType.eq(entity_type.as_str())));
    }
    if let Some(entity_id) = &entity_id {
        conditions.push(Condition::all().add(Log::EntityId.eq(entity_id.as_str())));
    }
    let keyset = match &cursor {
        Some(id) => {
            match cursor_row::<enrichment_logs::Entity>(&db, Log::CreatedAt, Log::Id, id).await {
                Ok(keyset) => keyset,
                Err(error) => return internal(&error, "Failed to list enrichment logs"),
            }
        }
        None => None,
    };
    if let Some(keyset) = &keyset {
        conditions.push(before(Log::CreatedAt, Log::Id, keyset));
    }
    let mut counted = conditions.clone();
    if cursor.is_some() {
        counted.pop();
    }
    let all = |conditions: Vec<Condition>| {
        conditions
            .into_iter()
            .fold(Condition::all(), Condition::add)
    };
    let found = enrichment_logs::Entity::find()
        .filter(all(conditions))
        .order_by_desc(Log::CreatedAt)
        .order_by_desc(Log::Id)
        .limit(sql_limit(limit).and_then(|limit| u64::try_from(limit).ok()))
        .all(&db)
        .await;
    let total = enrichment_logs::Entity::find()
        .filter(all(counted))
        .count(&db)
        .await;
    match (found, total) {
        (Ok(rows), Ok(total)) => match page(rows, limit, total) {
            Ok(page) => page,
            Err(error) => internal(&error, "Failed to list enrichment logs"),
        },
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list enrichment logs"),
    }
}

/// The page of `limit + 1` rows, with its count and next cursor.
fn page(rows: Vec<enrichment_logs::Model>, limit: f64, total: u64) -> Result<Response, DbErr> {
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data: Vec<Value> = if has_more {
        js_slice(rows, limit)
    } else {
        rows
    }
    .into_iter()
    .map(js)
    .collect::<Result<_, _>>()?;
    let next = if has_more {
        data.last()
            .and_then(|row| text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    Ok(List::new(data, Pagination::new(total, has_more, next)).into_response())
}
