//! `/api/enrichments`: read-only views over the enrichment results, the
//! enabled definitions and the enrichment log (`contacts:read`)
//! (`apps/workers/data-api/src/routes/enrichments/index.ts`).

use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::Value;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::js_row;
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, js_slice, query_param, sql_limit, text};
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
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from enrich_field_results t
         where t.entity_type = $1 and t.entity_id = $2
         order by t.provider asc, t.operation asc",
    )
    .bind(&entity_type)
    .bind(&entity_id)
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
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
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from enrich_field_definitions t
         where t.deleted_at is null and t.entity_type = $1 and (not $2 or t.enabled = true)
         order by t.sort_order asc, t.name asc",
    )
    .bind(&entity_type)
    .bind(enabled_only)
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
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

    // The conditions in order: entityType, entityId, the keyset.
    let mut conditions: Vec<&str> = Vec::new();
    if entity_type.is_some() {
        conditions.push("t.entity_type = $1");
    }
    if entity_id.is_some() {
        conditions.push("t.entity_id = $2");
    }
    let keyset = match &cursor {
        Some(id) => match cursor_of(&caller, id).await {
            Ok(keyset) => keyset,
            Err(error) => return internal(&error, "Failed to list enrichment logs"),
        },
        None => None,
    };
    if keyset.is_some() {
        conditions
            .push("(t.created_at < $3::timestamp or (t.created_at = $3::timestamp and t.id < $4))");
    }
    let mut counted = conditions.clone();
    if cursor.is_some() {
        counted.pop();
    }
    let clause = |conditions: &[&str]| {
        if conditions.is_empty() {
            "true".to_owned()
        } else {
            conditions.join(" and ")
        }
    };
    let (created, id) = keyset.unzip();
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from enrichment_logs t where {}
           and ($1::text is null or true) and ($2::text is null or true)
           and ($3::timestamp is null or true) and ($4::text is null or true)
         order by t.created_at desc, t.id desc limit $5",
        clause(&conditions)
    )))
    .bind(&entity_type)
    .bind(&entity_id)
    .bind(&created)
    .bind(&id)
    .bind(sql_limit(limit))
    .fetch_all(&caller.db)
    .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from enrichment_logs t where {}
           and ($1::text is null or true) and ($2::text is null or true)
           and ($3::timestamp is null or true) and ($4::text is null or true)",
        clause(&counted)
    )))
    .bind(&entity_type)
    .bind(&entity_id)
    .bind(&created)
    .bind(&id)
    .fetch_one(&caller.db)
    .await;
    let (rows, total) = match (found, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => {
            return internal(&error, "Failed to list enrichment logs");
        }
    };
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data: Vec<Value> = if has_more {
        js_slice(rows, limit)
    } else {
        rows
    }
    .into_iter()
    .map(js_row)
    .collect();
    let next = if has_more {
        data.last()
            .and_then(|row| text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    List::new(
        data,
        Pagination::new(u64::try_from(total).unwrap_or_default(), has_more, next),
    )
    .into_response()
}

/// The cursor row's keyset (`createdAt` as a `Date` holds it, the id).
async fn cursor_of(caller: &Caller, id: &str) -> Result<Option<(String, String)>, sqlx::Error> {
    let created: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t.created_at) from enrichment_logs t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(created
        .and_then(|created| {
            js_row(serde_json::json!({ "createdAt": created }))
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .map(|created| (created, id.to_owned())))
}
