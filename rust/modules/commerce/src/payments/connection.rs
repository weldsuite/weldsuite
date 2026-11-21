//! `/api/commerce-payments/connection`: the workspace's Mollie connection
//! (`commerce_settings:read|update`). One per workspace and provider.
//!
//! Two ways in: Mollie Connect (OAuth: `authorize`, then Mollie redirects to
//! the public callback in [`super::public`]) or the merchant's own API key.
//! Credentials are stored encrypted and never leave the server; events never
//! carry them. The master registry row ([`super::registry`]) is written with
//! the connection.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    COMMERCE_PAYMENT_CONNECTION_CONNECTED, COMMERCE_PAYMENT_CONNECTION_DISCONNECTED,
    COMMERCE_PAYMENT_CONNECTION_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMMERCE_SETTINGS_READ, COMMERCE_SETTINGS_UPDATE};
use weldsuite_commerce_domain::payments::connection;
use weldsuite_commerce_domain::payments::{Env, Error as PaymentError};
use weldsuite_db::{decrypt_field, encrypt_field};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_mollie::Mollie;
use weldsuite_mollie::connect::{COMMERCE_SCOPES, Tokens};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::registry::Registry;
use super::state;
use super::{http, refuse};
use crate::config::PaymentsConfig;
use crate::wire::{body_or_empty, iso};
use crate::{Caller, CommerceState, Refusal, now, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([COMMERCE_SETTINGS_READ]);
    let update = || gate.require([COMMERCE_SETTINGS_UPDATE]);
    // One `route` per method: `route_layer` wraps every method chained.
    Router::new()
        .route("/connection", get(read_connection).route_layer(read()))
        .route(
            "/connection",
            patch(update_connection).route_layer(update()),
        )
        .route("/connection", delete(disconnect).route_layer(update()))
        .route(
            "/connection/mollie/authorize",
            post(authorize).route_layer(update()),
        )
        .route(
            "/connection/mollie/api-key",
            post(api_key).route_layer(update()),
        )
        .route("/connection/profiles", get(profiles).route_layer(read()))
}

/// A connection as the API shows it.
pub(crate) fn present(row: &Value, oauth_available: bool) -> Value {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": get("id"),
        "provider": "mollie",
        "authMethod": get("authMethod"),
        "status": get("status"),
        "testmode": row.get("testmode").and_then(Value::as_bool).unwrap_or(false),
        "profileId": get("profileId"),
        "profileName": get("profileName"),
        "organizationId": get("organizationId"),
        "organizationName": get("organizationName"),
        "connectedAt": row.get("connectedAt").map_or(Value::Null, iso),
        "lastError": get("lastError"),
        "oauthAvailable": oauth_available,
    })
}

/// The event data of a connection: never a token.
fn event(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "provider": "mollie",
        "authMethod": row["authMethod"],
        "status": row["status"],
        "testmode": row["testmode"],
        "profileId": row["profileId"],
        "organizationName": row["organizationName"],
    })
}

async fn read_connection(State(state): State<CommerceState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to fetch the payment connection";
    let oauth = state.payments.oauth_available();
    match connection::row(&caller.db).await {
        Ok(Some(row)) => Data(present(&row, oauth)).into_response(),
        Ok(None) => {
            axum::Json(json!({ "data": null, "meta": { "oauthAvailable": oauth } })).into_response()
        }
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

// ── OAuth ───────────────────────────────────────────────────────────────────

fn relative_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.contains(char::is_control)
        && path.len() <= 500
}

async fn authorize(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to start the Mollie connection";
    let (headers, body) = body_or_empty(&headers, &body);
    let redirect_to = match validate(&headers, &body, |issues, fields| {
        issues
            .text_with(
                fields,
                "redirectTo",
                Presence::Optional,
                Text::trimmed(Some(1), Some(500)),
            )
            .into_option()
    }) {
        Ok(redirect_to) => redirect_to,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if let Some(path) = &redirect_to
        && !relative_path(path)
    {
        return crate::wire::invalid("redirectTo", "Must be a path on this site").respond(FAILED);
    }
    let config = &state.payments;
    let (Some(app), Some(secret), Some(callback)) = (
        config.connect.as_ref(),
        config.state_secret.as_deref(),
        config.callback_url(),
    ) else {
        return ApiError::new(
            StatusCode::CONFLICT,
            "MOLLIE_CONNECT_NOT_CONFIGURED",
            "This install has no Mollie Connect app configured",
        )
        .into_response();
    };
    let mut claims = Map::new();
    claims.insert("workspaceId".to_owned(), json!(caller.workspace_id));
    claims.insert("userId".to_owned(), json!(caller.user_id));
    claims.insert("redirectTo".to_owned(), json!(redirect_to));
    claims.insert("nonce".to_owned(), json!(generate_id("nonce")));
    let Some(signed) = state::sign(secret, &claims) else {
        return crate::internal(&"state cannot be signed", FAILED);
    };
    match app.authorize_url(&callback, &signed, COMMERCE_SCOPES) {
        Some(url) => Data(json!({ "url": url })).into_response(),
        None => crate::internal(&"authorize url is not a URL", FAILED),
    }
}

// ── API key ─────────────────────────────────────────────────────────────────

fn key_invalid(message: &str) -> Response {
    ApiError::new(StatusCode::BAD_REQUEST, "MOLLIE_KEY_INVALID", message).into_response()
}

async fn api_key(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to connect Mollie";
    let (headers, body) = body_or_empty(&headers, &body);
    let (key, profile_id) = match validate(&headers, &body, |issues, fields| {
        (
            issues
                .text_with(
                    fields,
                    "apiKey",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(200)),
                )
                .into_option(),
            issues
                .text_with(
                    fields,
                    "profileId",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(50)),
                )
                .into_option(),
        )
    }) {
        Ok((Some(key), profile_id)) => (key, profile_id),
        Ok(_) => return Refusal::from(ApiError::internal()).respond(FAILED),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let testmode = key.starts_with("test_");
    if !testmode && !key.starts_with("live_") {
        return key_invalid("A Mollie API key starts with live_ or test_");
    }
    let http = match http(&state) {
        Ok(http) => http,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let profile = match Mollie::new(&state.payments.api_url, &key)
        .current_profile(http)
        .await
    {
        Ok(profile) => profile,
        Err(error) if error.is_refusal() => {
            return key_invalid("Mollie does not accept this API key");
        }
        Err(error) => {
            return ApiError::new(
                StatusCode::BAD_GATEWAY,
                "PROVIDER_ERROR",
                format!("Mollie could not be reached: {error}"),
            )
            .into_response();
        }
    };
    let saved = Save {
        auth_method: "api_key",
        tokens: None,
        api_key: Some(&key),
        testmode,
        profile_id: Some(profile.id.as_str()).or(profile_id.as_deref()),
        profile_name: Some(profile.name.as_str()),
        organization_id: None,
        organization_name: None,
        connected_by: &caller.user_id,
    };
    let master = match Registry::of(&caller) {
        Ok(registry) => registry,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match save(&master, &caller.db, &state.payments, &saved).await {
        Ok(row) => {
            caller.publish(
                &state,
                COMMERCE_PAYMENT_CONNECTION_CONNECTED,
                row["id"].as_str().unwrap_or_default(),
                &event(&row),
            );
            (
                StatusCode::CREATED,
                axum::Json(json!({ "data": present(&row, state.payments.oauth_available()) })),
            )
                .into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

// ── storing a connection ────────────────────────────────────────────────────

/// A connection to store (replacing the workspace's one).
pub(crate) struct Save<'a> {
    pub(crate) auth_method: &'a str,
    pub(crate) tokens: Option<&'a Tokens>,
    pub(crate) api_key: Option<&'a str>,
    pub(crate) testmode: bool,
    pub(crate) profile_id: Option<&'a str>,
    pub(crate) profile_name: Option<&'a str>,
    pub(crate) organization_id: Option<&'a str>,
    pub(crate) organization_name: Option<&'a str>,
    pub(crate) connected_by: &'a str,
}

/// Stores the connection: the master registry first, then the tenant row,
/// undoing the registry when the tenant write fails. The connection keeps
/// its id across a reconnect, so webhook URLs already given to Mollie keep
/// working.
#[allow(clippy::too_many_lines, reason = "seal, register, write, undo")]
pub(crate) async fn save(
    registry: &Registry<'_>,
    db: &PgPool,
    config: &PaymentsConfig,
    new: &Save<'_>,
) -> Result<Value, Refusal> {
    let seal = |value: &str| {
        encrypt_field(value, &config.keyring).map_err(|error| {
            tracing::error!(?error, "[commerce] payment credentials cannot be encrypted");
            Refusal::from(
                ApiError::internal().with_message("The credentials cannot be stored securely"),
            )
        })
    };
    let access = new.tokens.map(|t| seal(&t.access_token)).transpose()?;
    let refresh = new
        .tokens
        .and_then(|t| t.refresh_token.as_deref())
        .map(seal)
        .transpose()?;
    let api_key = new.api_key.map(seal).transpose()?;
    let expires_in = new
        .tokens
        .map_or(0, |t| i32::try_from(t.expires_in).unwrap_or(3600));

    let existing: Option<String> = sqlx::query_scalar(
        "select id from commerce_payment_connections \
         where provider = 'mollie' and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    let id = existing.clone().unwrap_or_else(|| generate_id("cpc"));
    let before = registry.before(&id).await?;
    registry.register(&id).await?;
    let written = async {
        let at = now();
        if existing.is_some() {
            sqlx::query(
                "update commerce_payment_connections set auth_method = $2, status = 'connected', \
                   access_token_encrypted = $3, refresh_token_encrypted = $4, api_key_encrypted = $5, \
                   token_expires_at = case when $3::text is null then null \
                     else (now() at time zone 'utc') + make_interval(secs => $6::double precision) end, \
                   scope = $7, profile_id = $8, profile_name = $9, organization_id = $10, \
                   organization_name = $11, testmode = $12, connected_by = $13, \
                   connected_at = $14::timestamp, disconnected_at = null, last_error = null, \
                   updated_at = $14::timestamp where id = $1",
            )
            .bind(&id)
            .bind(new.auth_method)
            .bind(&access)
            .bind(&refresh)
            .bind(&api_key)
            .bind(expires_in)
            .bind(new.tokens.and_then(|t| t.scope.as_deref()))
            .bind(new.profile_id)
            .bind(new.profile_name)
            .bind(new.organization_id)
            .bind(new.organization_name)
            .bind(new.testmode)
            .bind(new.connected_by)
            .bind(&at)
            .execute(db)
            .await?;
        } else {
            sqlx::query(
                "insert into commerce_payment_connections (id, provider, auth_method, status, \
                   access_token_encrypted, refresh_token_encrypted, api_key_encrypted, \
                   token_expires_at, scope, profile_id, profile_name, organization_id, \
                   organization_name, testmode, connected_by, connected_at) \
                 values ($1, 'mollie', $2, 'connected', $3, $4, $5, \
                   case when $3::text is null then null \
                     else (now() at time zone 'utc') + make_interval(secs => $6::double precision) end, \
                   $7, $8, $9, $10, $11, $12, $13, $14::timestamp)",
            )
            .bind(&id)
            .bind(new.auth_method)
            .bind(&access)
            .bind(&refresh)
            .bind(&api_key)
            .bind(expires_in)
            .bind(new.tokens.and_then(|t| t.scope.as_deref()))
            .bind(new.profile_id)
            .bind(new.profile_name)
            .bind(new.organization_id)
            .bind(new.organization_name)
            .bind(new.testmode)
            .bind(new.connected_by)
            .bind(&at)
            .execute(db)
            .await?;
        }
        connection::row(db).await
    }
    .await;
    match written {
        Ok(Some(row)) => Ok(row),
        Ok(None) => {
            let _ = registry.restore(&id, before).await;
            Err(ApiError::internal().into())
        }
        Err(error) => {
            if let Err(undo) = registry.restore(&id, before).await {
                tracing::error!(%undo, "[commerce] could not undo the connection registry");
            }
            Err(Refusal::Database(error))
        }
    }
}

// ── profiles, test mode ─────────────────────────────────────────────────────

fn env<'a>(state: &'a CommerceState, db: &'a PgPool) -> Result<Env<'a>, Refusal> {
    Ok(state.payments.env(db, http(state)?))
}

async fn profiles(State(state): State<CommerceState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to fetch the Mollie profiles";
    let result = async {
        let env = env(&state, &caller.db)?;
        let active = connection::active(&env).await.map_err(refuse)?;
        if active.auth_method != "oauth" {
            return Err(Refusal::from(ApiError::new(
                StatusCode::CONFLICT,
                "NOT_OAUTH",
                "Profiles can be listed for a connection made with Mollie Connect only",
            )));
        }
        let list = active
            .mollie()
            .profiles(env.http)
            .await
            .map_err(|error| refuse(PaymentError::Provider(error.to_string())))?;
        Ok(list
            .into_iter()
            .map(|p| json!({ "id": p.id, "name": p.name, "website": p.website, "mode": p.mode }))
            .collect::<Vec<_>>())
    }
    .await;
    match result {
        Ok(list) => Data(json!(list)).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn update_connection(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update the payment connection";
    let (headers, body) = body_or_empty(&headers, &body);
    let (profile_id, testmode) = match validate(&headers, &body, |issues, fields| {
        (
            issues
                .text_with(
                    fields,
                    "profileId",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(50)),
                )
                .into_option(),
            issues
                .boolean(fields, "testmode", Presence::Optional)
                .into_option(),
        )
    }) {
        Ok(values) => values,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let env = env(&state, &caller.db)?;
        let active = connection::active(&env).await.map_err(refuse)?;
        let mut name: Option<String> = None;
        if let Some(testmode) = testmode
            && active.auth_method != "oauth"
            && testmode != active.testmode
        {
            return Err(Refusal::from(ApiError::new(
                StatusCode::CONFLICT,
                "TESTMODE_FIXED",
                "An API key's test mode is fixed by the key",
            )));
        }
        if let Some(wanted) = profile_id.as_deref()
            && active.auth_method == "oauth"
        {
            let list = active
                .mollie()
                .profiles(env.http)
                .await
                .map_err(|error| refuse(PaymentError::Provider(error.to_string())))?;
            let Some(found) = list.into_iter().find(|p| p.id == wanted) else {
                return Err(crate::wire::invalid(
                    "profileId",
                    "That profile is not one of the organisation's",
                ));
            };
            name = Some(found.name);
        }
        sqlx::query(
            "update commerce_payment_connections set \
               profile_id = case when $2::text is null then profile_id else $2 end, \
               profile_name = coalesce($3, profile_name), \
               testmode = case when $4::boolean is null or auth_method <> 'oauth' then testmode else $4 end, \
               updated_at = now() at time zone 'utc' where id = $1",
        )
        .bind(&active.id)
        .bind(
            profile_id
                .as_deref()
                .filter(|_| active.auth_method == "oauth"),
        )
        .bind(name)
        .bind(testmode)
        .execute(&caller.db)
        .await?;
        let row = connection::row(&caller.db)
            .await?
            .ok_or_else(|| Refusal::not_found("Payment connection", "mollie"))?;
        Ok::<_, Refusal>(row)
    }
    .await;
    match result {
        Ok(row) => {
            caller.publish(
                &state,
                COMMERCE_PAYMENT_CONNECTION_UPDATED,
                row["id"].as_str().unwrap_or_default(),
                &event(&row),
            );
            Data(present(&row, state.payments.oauth_available())).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

// ── disconnecting ───────────────────────────────────────────────────────────

/// Mollie forgets the grant (best effort: the connection goes either way).
async fn revoke_tokens(state: &CommerceState, db: &PgPool) {
    let (Some(app), Some(http)) = (state.payments.connect.as_ref(), state.http.as_ref()) else {
        return;
    };
    let tokens: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select access_token_encrypted, refresh_token_encrypted \
         from commerce_payment_connections \
         where provider = 'mollie' and deleted_at is null and auth_method = 'oauth'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let Some((access, refresh)) = tokens else {
        return;
    };
    for (token, hint) in [(refresh, "refresh_token"), (access, "access_token")] {
        let Some(plain) = token.and_then(|t| decrypt_field(&t, &state.payments.keyring).ok())
        else {
            continue;
        };
        if let Err(error) = app.revoke(http, &plain, hint).await {
            tracing::warn!(%error, "[commerce] Mollie did not revoke the {hint}");
        }
    }
}

async fn disconnect(State(state): State<CommerceState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to disconnect Mollie";
    let result = async {
        let row = connection::row(&caller.db)
            .await?
            .ok_or_else(|| Refusal::not_found("Payment connection", "mollie"))?;
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let registry = Registry::of(&caller)?;
        let before = registry.before(&id).await?;
        revoke_tokens(&state, &caller.db).await;
        registry.remove(&id).await?;
        let done = sqlx::query(
            "update commerce_payment_connections set status = 'disconnected', \
               access_token_encrypted = null, refresh_token_encrypted = null, api_key_encrypted = null, \
               token_expires_at = null, last_error = null, \
               disconnected_at = now() at time zone 'utc', updated_at = now() at time zone 'utc' \
             where id = $1",
        )
        .bind(&id)
        .execute(&caller.db)
        .await;
        if let Err(error) = done {
            if let Err(undo) = registry.restore(&id, before).await {
                tracing::error!(%undo, "[commerce] could not undo the connection registry");
            }
            return Err(Refusal::Database(error));
        }
        Ok::<_, Refusal>(row)
    }
    .await;
    match result {
        Ok(row) => {
            let mut data = event(&row);
            data["status"] = json!("disconnected");
            caller.publish(
                &state,
                COMMERCE_PAYMENT_CONNECTION_DISCONNECTED,
                row["id"].as_str().unwrap_or_default(),
                &data,
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
