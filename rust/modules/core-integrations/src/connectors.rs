//! `/api/connectors` (`routes/connectors/index.ts`): the store and
//! accounting connectors (WooCommerce, Shopify, Picqer, Moneybird, Stripe)
//! on `weldsuite_connect_domain`: the catalog, the connections and their
//! runs, imported records and field mappings, the credential test, the
//! Picqer push ([`crate::picqer_push`]), pause/resume, connecting and the
//! OAuth flows ([`crate::connector_auth`]), manual sync
//! ([`crate::connector_sync`]) and the Moneybird push
//! ([`crate::connector_push`]). Global keeps the connector catch-up schedule
//! in its D1 index; here a resume marks the workspace on the master due
//! index (`weldsuite_connect_domain::catchup`), whose sweep reads the
//! connection's own times.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CONNECTOR_CONNECTION_PAUSED, CONNECTOR_CONNECTION_RESUMED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_connect_domain::catalog::{
    default_field_mappings, get_connector, list_connectors, offered_on, syncs,
};
use weldsuite_connect_domain::clients::Kind;
use weldsuite_connect_domain::connections::{
    get_connection, list_connection_records, list_connections, list_sync_runs, sanitize_connection,
    sanitize_with_entity,
};
use weldsuite_connect_domain::moneybird_push;
use weldsuite_connect_domain::provider::test_connector_credentials;
use weldsuite_db::{Keyring, orm, utc_now};
use weldsuite_kit::ApiError;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{connector_connections, integration_field_mappings as mappings};

use crate::integrations::{field_mappings_body, replace_mappings};
use crate::js::{page_limit, query_truthy};
use crate::{Caller, IntegrationsState, internal, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<IntegrationsState> {
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
        .route(
            "/connections/{id}",
            axum::routing::patch(crate::connector_auth::patch_connection).route_layer(update()),
        )
        .route(
            "/connections/{id}",
            axum::routing::delete(crate::connector_auth::delete_connection)
                .route_layer(gate.require([perm::INTEGRATIONS_DELETE])),
        )
        .route(
            "/connect",
            post(crate::connector_auth::connect)
                .route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route(
            "/authorize",
            post(crate::connector_auth::authorize)
                .route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route(
            "/oauth/callback",
            post(crate::connector_auth::oauth_callback)
                .route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route(
            "/connections/{id}/select-account",
            post(crate::connector_auth::select_account)
                .route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
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
        .route(
            "/connections/{id}/picqer/push",
            post(crate::picqer_push::push).route_layer(update()),
        )
        .route(
            "/connections/{id}/sync",
            post(crate::connector_sync::sync_now).route_layer(update()),
        )
        .route("/connections/{id}/pause", post(pause).route_layer(update()))
        .route(
            "/connections/{id}/resume",
            post(resume).route_layer(update()),
        )
        .route(
            "/connections/{id}/moneybird/options",
            get(moneybird_options).route_layer(read()),
        )
        .route(
            "/connections/{id}/moneybird/push-status",
            get(moneybird_push_status).route_layer(read()),
        )
        .route(
            "/connections/{id}/moneybird/push",
            post(crate::connector_push::push_now).route_layer(update()),
        )
        // Rust only (ADR INT-013): register a Moneybird connection's webhooks
        // again when live updates are off.
        .route(
            "/connections/{id}/live-updates",
            post(crate::connector_auth::repair_live_updates).route_layer(update()),
        )
}

/// `keyringFromEnv(c.env)`.
pub(crate) fn keyring(caller: &Caller, state: &IntegrationsState) -> Keyring {
    weldsuite_connect_domain::connections::keyring(
        caller.overrides.env(state, "DATABASE_ENCRYPTION_KEY"),
        caller.overrides.env(state, "DATABASE_ENCRYPTION_KEY_V2"),
    )
}

/// An unhandled failure: Hono's error handler answers a plain 500.
fn unhandled(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "[connect-api/connectors] request failed");
    ApiError::internal().into_response()
}

async fn catalog(State(state): State<IntegrationsState>, caller: Caller) -> Response {
    let rows = match list_connections(&caller.db).await {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to load connector catalog"),
    };
    let keyring = keyring(&caller, &state);
    let entries: Vec<Value> = list_connectors()
        .iter()
        .filter(|connector| offered_on(connector, state.connector_edition))
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
#[allow(clippy::result_large_err)]
async fn found(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_connection(&caller.db, id).await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(ApiError::not_found("Connection", Some(id)).into_response()),
        Err(error) => Err(unhandled(&error)),
    }
}

async fn connection(
    State(state): State<IntegrationsState>,
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
    let mut rows = mappings::Entity::find().filter(mappings::Column::ConnectionId.eq(&id));
    if let Some(entity_type) = &entity_type {
        rows = rows.filter(mappings::Column::EntityType.eq(entity_type));
    }
    let rows = rows.all(&orm(&caller.db)).await.and_then(|rows| {
        rows.into_iter()
            .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<_>, _>>()
    });
    match rows {
        Ok(rows) => Data(rows).into_response(),
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
    State(state): State<IntegrationsState>,
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
    // ADR OPS-026: not even a test against a store outside the EU the
    // workspace has switched off.
    if let Err(error) = weldsuite_outside_eu::require_integration(&caller.db, &provider).await {
        return error.to_api_error().into_response();
    }
    let http = caller.overrides.http(&state);
    let tested = test_connector_credentials(&provider, &creds, http.as_ref())
        .await
        .map(|tested| tested.store_url);
    match tested {
        Ok(store_url) => Data(json!({ "ok": true, "storeUrl": store_url })).into_response(),
        Err(message) => ApiError::bad_request(message).into_response(),
    }
}

/// Pause or resume: the status, then the event.
async fn set_status(
    state: &IntegrationsState,
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
    if let Err(error) = connector_connections::Entity::update_many()
        .col_expr(connector_connections::Column::Status, Expr::value(status))
        .col_expr(
            connector_connections::Column::UpdatedAt,
            Expr::value(utc_now()),
        )
        .filter(connector_connections::Column::Id.eq(row_id))
        .exec(&orm(&caller.db))
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
    // `setConnectorIndexEnabled(true)`: the catch-up looks at it again (the
    // app's own master database; none in conformance builds).
    if status == "active"
        && let Some(master) = &state.master
    {
        weldsuite_db::due_index::mark_due(
            master,
            weldsuite_connect_domain::catchup::DUE_KIND,
            &caller.workspace_id,
            time::OffsetDateTime::now_utc(),
        )
        .await;
    }
    Data(json!({ "status": status })).into_response()
}

async fn pause(
    State(state): State<IntegrationsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_status(&state, &caller, &id, "paused", CONNECTOR_CONNECTION_PAUSED).await
}

async fn resume(
    State(state): State<IntegrationsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_status(&state, &caller, &id, "active", CONNECTOR_CONNECTION_RESUMED).await
}

/// `moneybirdConnection(c, id)`: the row when it is a Moneybird connection,
/// else the 404 the Moneybird routes answer.
#[allow(clippy::result_large_err)]
async fn moneybird_connection(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_connection(&caller.db, id).await {
        Ok(Some(row)) if row["provider"] == "moneybird" => Ok(row),
        Ok(_) => Err(ApiError::not_found("Moneybird connection", Some(id)).into_response()),
        Err(error) => Err(unhandled(&error)),
    }
}

/// `GET /connections/:id/moneybird/options`.
async fn moneybird_options(
    State(state): State<IntegrationsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let row = match moneybird_connection(&caller, &id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let http = caller.overrides.http(&state);
    match moneybird_push::options(&caller.db, http.as_ref(), &row, &keyring(&caller, &state)).await
    {
        Ok(options) => Data(options).into_response(),
        Err(moneybird_push::OptionsError::Connector(error)) if error.kind == Kind::Auth => {
            ApiError::bad_request("Moneybird rejected the connection — reconnect it")
                .into_response()
        }
        Err(moneybird_push::OptionsError::Connector(error)) => {
            ApiError::bad_request(error.message).into_response()
        }
        Err(moneybird_push::OptionsError::Database(error)) => {
            tracing::error!(%error, "[connect-api/moneybird-push] options failed");
            ApiError::bad_request(weldsuite_connect_domain::sync::db_error_text(&error))
                .into_response()
        }
    }
}

/// `GET /connections/:id/moneybird/push-status`.
async fn moneybird_push_status(caller: Caller, Path(id): Path<String>) -> Response {
    let row = match moneybird_connection(&caller, &id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    match moneybird_push::status(&caller.db, &row).await {
        Ok(status) => Data(status).into_response(),
        Err(error) => unhandled(&error),
    }
}
