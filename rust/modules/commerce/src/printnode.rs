//! `/api/printnode`: the PrintNode config under the first live
//! `workspace_settings.customSettings.printnode` (no table of its own).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::tables;
use crate::{Caller, CommerceState, Refusal, now, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(read).route_layer(gate.require([perm::GENERAL_READ])))
        .route(
            "/",
            axum::routing::put(write).route_layer(gate.require([perm::GENERAL_UPDATE])),
        )
}

/// The first live settings row (no ORDER BY, as the route reads it).
async fn settings_row(caller: &Caller) -> Result<Option<(String, Option<Value>)>, sqlx::Error> {
    sqlx::query_as("select id, custom_settings from workspace_settings where deleted_at is null limit 1")
        .fetch_optional(&caller.db)
        .await
}

/// `(customSettings as Record | null) || {}`.
fn custom(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

async fn read(State(_state): State<CommerceState>, caller: Caller) -> Response {
    // Read failures answer `null`, as the legacy route did.
    let settings = match settings_row(&caller).await {
        Ok(row) => custom(row.and_then(|(_, custom)| custom))
            .get("printnode")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null),
        Err(error) => {
            tracing::error!(%error, "[commerce-api/printnode] Failed to fetch PrintNode settings");
            Value::Null
        }
    };
    Data(settings).into_response()
}

async fn write(State(_state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to update PrintNode settings";
    let settings = match validate(&headers, &body, |issues, fields| {
        issues.text_with(fields, "apiKey", Presence::Required, Text::default());
        fields.clone()
    }) {
        Ok(settings) => Value::Object(settings),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let now = now();
    let created = match settings_row(&caller).await {
        Ok(Some((id, current))) => {
            let mut current = custom(current);
            current.insert("printnode".to_owned(), settings.clone());
            let written = sqlx::query(
                "update workspace_settings set custom_settings = $1, updated_at = $2::timestamptz where id = $3",
            )
            .bind(Value::Object(current))
            .bind(&now)
            .bind(&id)
            .execute(&caller.db)
            .await;
            if let Err(error) = written {
                return Refusal::Database(error).respond(FAILED);
            }
            false
        }
        Ok(None) => {
            let t = &tables::WORKSPACE_SETTINGS;
            let mut values = Map::new();
            t.set(&mut values, "id", json!(generate_id("ws")));
            t.set(&mut values, "customSettings", json!({ "printnode": settings }));
            t.set(&mut values, "createdAt", json!(now));
            t.set(&mut values, "updatedAt", json!(now));
            if let Err(error) = t.insert(&caller.db, values, &["createdAt", "updatedAt"]).await {
                tracing::error!(%error, "[commerce-api/printnode] {FAILED}");
                return ApiError::internal().with_message(FAILED).into_response();
            }
            true
        }
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    (status, axum::Json(json!({ "data": settings }))).into_response()
}
