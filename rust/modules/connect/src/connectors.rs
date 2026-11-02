//! `/api/connectors` (`routes/connectors/index.ts`): the store and
//! accounting connectors (WooCommerce, Shopify, Picqer, Moneybird, Stripe)
//! on `weldsuite_connect_domain`. Served here so far: the catalog, the
//! connections and their runs, imported records and field mappings, the
//! credential test (WooCommerce, Shopify and Picqer) and pause/resume.
//! Not yet (they need connect-domain's sync engine, the Stripe and Moneybird
//! clients, WooCommerce's app authorisation or provider webhooks, still on
//! Global): connect, authorize, the OAuth callback, select-account, manual
//! sync, the Picqer push, the Moneybird push routes, PATCH and DELETE of a
//! connection. Global keeps the connector sync schedule in its D1 index;
//! nothing reads one here, so pause and resume write none.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CONNECTOR_CONNECTION_PAUSED, CONNECTOR_CONNECTION_RESUMED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_connect_domain::catalog::{
    default_field_mappings, get_connector, list_connectors, syncs,
};
use weldsuite_connect_domain::clients::product_write_client;
use weldsuite_connect_domain::connections::{
    get_connection, list_connection_records, list_connections, list_sync_runs, sanitize_connection,
    sanitize_with_entity,
};
use weldsuite_db::{Keyring, js_row};
use weldsuite_kit::ApiError;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::integrations::{field_mappings_body, replace_mappings};
use crate::js::{page_limit, query_truthy};
use crate::{Caller, ConnectState, internal, now, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::INTEGRATIONS_READ]);
    let update = || gate.require([perm::INTEGRATIONS_UPDATE]);
    Router::new()
        .route("/catalog", get(catalog).route_layer(read()))
        .route("/connections", get(connections).route_layer(read()))
        .route(
            "/test",
            post(test).route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route("/connections/{id}", get(connection).route_layer(read()))
        .route("/connections/{id}/runs", get(runs).route_layer(read()))
        .route(
            "/connections/{id}/records",
            get(records).route_layer(read()),
        )
        .route(
            "/connections/{id}/field-mappings",
            get(field_mappings).route_layer(read()),
        )
        .route(
            "/connections/{id}/field-mappings",
            put(replace_field_mappings).route_layer(update()),
        )
        .route(
            "/connections/{id}/field-mappings/defaults",
            get(defaults).route_layer(read()),
        )
        .route("/connections/{id}/pause", post(pause).route_layer(update()))
        .route(
            "/connections/{id}/resume",
            post(resume).route_layer(update()),
        )
}

/// `keyringFromEnv(c.env)`.
fn keyring(caller: &Caller, state: &ConnectState) -> Keyring {
    weldsuite_connect_domain::connections::keyring(
        caller.overrides.env(state, "DATABASE_ENCRYPTION_KEY"),
        caller.overrides.env(state, "DATABASE_ENCRYPTION_KEY_V2"),
    )
}

/// An unhandled failure: Hono's error handler answers a plain 500.
fn unhandled(error: &sqlx::Error) -> Response {
    tracing::error!(%error, "[connect-api/connectors] request failed");
    ApiError::internal().into_response()
}

async fn catalog(State(state): State<ConnectState>, caller: Caller) -> Response {
    let rows = match list_connections(&caller.db).await {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to load connector catalog"),
    };
    let keyring = keyring(&caller, &state);
    let entries: Vec<Value> = list_connectors()
        .iter()
        .map(|connector| {
            let provider = connector["provider"].as_str().unwrap_or_default();
            let accounting = connector["category"].as_str() == Some("accounting");
            let sanitized: Vec<Value> = rows
                .iter()
                .filter(|row| row["provider"].as_str() == Some(provider))
                .map(|row| {
                    if accounting {
                        sanitize_with_entity(row, &keyring)
                    } else {
                        sanitize_connection(row, None)
                    }
                })
                .collect();
            let sync_list: Vec<Value> = syncs(connector)
                .iter()
                .map(|s| {
                    json!({
                        "syncName": s["syncName"],
                        "model": s["model"],
                        "internalEntity": s["internalEntity"],
                        "settingKey": s["settingKey"],
                    })
                })
                .collect();
            json!({
                "provider": connector["provider"],
                "label": connector["label"],
                "description": connector["description"],
                "category": connector["category"],
                "icon": connector["icon"],
                "auth": connector["auth"],
                "syncs": sync_list,
                "connectionCount": sanitized.len(),
                "connections": sanitized,
            })
        })
        .collect();
    Data(entries).into_response()
}

async fn connections(caller: Caller) -> Response {
    match list_connections(&caller.db).await {
        Ok(rows) => Data(
            rows.iter()
                .map(|row| sanitize_connection(row, None))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to list connections"),
    }
}

/// The connection, or the 404 the routes answer first.
async fn found(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_connection(&caller.db, id).await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(ApiError::not_found("Connection", Some(id)).into_response()),
        Err(error) => Err(unhandled(&error)),
    }
}

async fn connection(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match found(&caller, &id).await {
        Ok(row) => Data(sanitize_with_entity(&row, &keyring(&caller, &state))).into_response(),
        Err(response) => response,
    }
}

async fn runs(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let row = match found(&caller, &id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let limit = page_limit(query.as_deref(), 25, 100);
    match list_sync_runs(&caller.db, row["id"].as_str().unwrap_or_default(), limit).await {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => unhandled(&error),
    }
}

async fn records(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let row = match found(&caller, &id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let limit = page_limit(query.as_deref(), 50, 100);
    match list_connection_records(&caller.db, row["id"].as_str().unwrap_or_default(), limit).await {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => unhandled(&error),
    }
}

async fn field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = found(&caller, &id).await {
        return response;
    }
    let entity_type = query_truthy(query.as_deref(), "entityType");
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(m) from integration_field_mappings m
         where m.connection_id = $1 and ($2::text is null or m.entity_type = $2)",
    )
    .bind(&id)
    .bind(&entity_type)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => internal(&error, "Failed to fetch field mappings"),
    }
}

async fn defaults(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let Some(entity_type) = query_truthy(query.as_deref(), "entityType") else {
        return ApiError::bad_request("entityType query param required").into_response();
    };
    match found(&caller, &id).await {
        Ok(row) => Data(default_field_mappings(
            &entity_type,
            row["provider"].as_str(),
        ))
        .into_response(),
        Err(response) => response,
    }
}

async fn replace_field_mappings(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update field mappings";
    let (entity_type, mappings) = match validate(&headers, &body, field_mappings_body) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if let Err(response) = found(&caller, &id).await {
        return response;
    }
    match replace_mappings(&caller.db, &id, &entity_type, &mappings).await {
        Ok(()) => {
            Data(json!({ "entityType": entity_type, "count": mappings.len() })).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

/// `z.record(z.string().min(1))` at `key`.
fn credentials(issues: &mut Issues, b: &Map<String, Value>, key: &str) -> Map<String, Value> {
    issues
        .nested(b, key, Presence::Required, |issues, inner| {
            let mut out = Map::new();
            for name in inner.keys() {
                if let Some(value) = issues
                    .text_with(inner, name, Presence::Required, Text::length(Some(1), None))
                    .into_option()
                {
                    out.insert(name.clone(), json!(value));
                }
            }
            out
        })
        .into_option()
        .unwrap_or_default()
}

async fn test(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (provider, creds) = match validate(&headers, &body, |issues, b| {
        let provider = issues
            .text(b, "provider", Presence::Required, Some(1), Some(100))
            .into_option()
            .unwrap_or_default();
        (provider, credentials(issues, b, "credentials"))
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    if get_connector(&provider).is_none() {
        return ApiError::bad_request(format!("Unknown connector '{provider}'")).into_response();
    }
    if matches!(provider.as_str(), "stripe" | "moneybird") {
        // Their clients are not ported yet (connect-domain).
        return ApiError::internal()
            .with_message("Connector request failed")
            .into_response();
    }
    // `testConnectorCredentials`: a client that can't be built is a failed test.
    let tested = match product_write_client(&provider, &creds, None) {
        Ok(client) => client.test(caller.overrides.http(&state).as_ref()).await,
        Err(error) => Err(error.message),
    };
    match tested {
        Ok(store_url) => Data(json!({ "ok": true, "storeUrl": store_url })).into_response(),
        Err(message) => ApiError::bad_request(message).into_response(),
    }
}

/// Pause or resume: the status, then the event.
async fn set_status(
    state: &ConnectState,
    caller: &Caller,
    id: &str,
    status: &str,
    event: weldsuite_catalogs::entity_events::EventName,
) -> Response {
    let row = match found(caller, id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let row_id = row["id"].as_str().unwrap_or_default();
    if let Err(error) = sqlx::query(
        "update connector_connections set status = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(row_id)
    .bind(status)
    .bind(now())
    .execute(&caller.db)
    .await
    {
        return unhandled(&error);
    }
    caller.publish(
        state,
        event,
        row_id,
        &json!({ "id": row_id, "provider": row["provider"], "status": status }),
    );
    Data(json!({ "status": status })).into_response()
}

async fn pause(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_status(&state, &caller, &id, "paused", CONNECTOR_CONNECTION_PAUSED).await
}

async fn resume(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_status(&state, &caller, &id, "active", CONNECTOR_CONNECTION_RESUMED).await
}
