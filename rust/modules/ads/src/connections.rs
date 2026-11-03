//! `/api/ad-connections`: connecting Meta (the OAuth start and callback),
//! the connections, a connection's sync, and disconnecting.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_ads_domain::campaigns::SyncScope;
use weldsuite_ads_domain::meta::{
    build_authorize_url, exchange_code_for_tokens, exchange_for_long_lived_token,
    get_meta_user_profile,
};
use weldsuite_ads_domain::sync::{
    SyncTarget, cleanup_connection_mappings, decrypt_access_token, discover_ad_accounts,
    encrypt_oauth_tokens, strip_connection_secrets, sync_selected_accounts,
};
use weldsuite_ads_domain::sync_index::{
    SyncIndexEntry, delete_ad_sync_index, upsert_ad_sync_index,
};
use weldsuite_ads_domain::{AdsError, now};
use weldsuite_catalogs::entity_events::{
    AD_PLATFORM_CONNECTION_CREATED, AD_PLATFORM_CONNECTION_DELETED, AD_PLATFORM_CONNECTION_UPDATED,
};
use weldsuite_kit::validation::{Presence, query_values};
use weldsuite_kit::{ApiError, Data, NoContent, generate_id};
use weldsuite_ports::OutboundHttp;

use crate::{AdsState, Caller, internal, query_param, rows, validate};

/// How long an OAuth start's state is kept (`STATE_TTL_SECONDS`).
const STATE_TTL: Duration = Duration::from_secs(600);

fn state_key(state: &str) -> String {
    format!("ads_oauth_state:{state}")
}

/// `adsOAuthRedirectUri(env)`: the platform's callback page.
fn redirect_uri(caller: &Caller) -> String {
    let base = caller
        .env("PUBLIC_APP_URL")
        .unwrap_or_else(|| "https://app.weldsuite.org".to_owned());
    let base = base.strip_suffix('/').unwrap_or(&base);
    format!("{base}/weldads/connect/callback")
}

/// Meta's API; a deployment without a client fails like a failed `fetch`.
fn meta_http(caller: &Caller, state: &AdsState) -> Result<OutboundHttp, AdsError> {
    caller
        .http(state)
        .ok_or_else(|| AdsError::message("fetch failed"))
}

/// `GET /api/ad-connections`: the live connections, newest first, without
/// their tokens.
pub(crate) async fn list(caller: Caller) -> Response {
    let result: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from ad_platform_connections c
         where c.deleted_at is null order by c.created_at desc",
    )
    .fetch_all(&caller.db)
    .await;
    match result {
        Ok(found) => Data(
            rows(found)
                .into_iter()
                .map(strip_connection_secrets)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to list ad connections"),
    }
}

/// `POST /api/ad-connections/facebook/authorize`: a state for this
/// workspace, kept ten minutes, and the Facebook dialog to send the person to.
pub(crate) async fn authorize(State(state): State<AdsState>, caller: Caller) -> Response {
    let Some(app_id) = caller.env("FACEBOOK_APP_ID") else {
        return ApiError::internal()
            .with_message("Facebook OAuth is not configured")
            .into_response();
    };
    let Some(org_id) = caller.org_id.clone().filter(|org| !org.is_empty()) else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    if caller.user_id.is_empty() {
        return ApiError::bad_request("No active workspace").into_response();
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let stored = format!(
        "{{\"orgId\":{},\"userId\":{},\"platform\":\"facebook\"}}",
        Value::String(org_id),
        Value::String(caller.user_id.clone()),
    );
    let Some(cache) = caller.cache(&state) else {
        return internal(&"no WORKSPACE_CACHE", "Internal server error");
    };
    if let Err(error) = cache
        .put_boxed(&state_key(&nonce), &stored, Some(STATE_TTL))
        .await
    {
        return internal(&error, "Internal server error");
    }
    let authorize_url = build_authorize_url(&app_id, &redirect_uri(&caller), &nonce);
    Data(json!({ "authorizeUrl": authorize_url, "state": nonce })).into_response()
}

/// `consumeAdsOAuthState`: the state, spent, when this workspace started it.
async fn consume_state(
    caller: &Caller,
    state: &AdsState,
    nonce: &str,
    org_id: &str,
) -> Result<bool, Box<Response>> {
    let Some(cache) = caller.cache(state) else {
        return Err(Box::new(internal(
            &"no WORKSPACE_CACHE",
            "Internal server error",
        )));
    };
    let key = state_key(nonce);
    let stored = cache
        .get_boxed(&key)
        .await
        .map_err(|error| Box::new(internal(&error, "Internal server error")))?;
    let Some(stored) = stored else {
        return Ok(false);
    };
    let stored: Value = serde_json::from_str(&stored)
        .map_err(|error| Box::new(internal(&error, "Internal server error")))?;
    if stored.get("orgId").and_then(Value::as_str) != Some(org_id) {
        return Ok(false);
    }
    cache
        .delete_boxed(&key)
        .await
        .map_err(|error| Box::new(internal(&error, "Internal server error")))?;
    Ok(true)
}

/// `POST /api/ad-connections/facebook/callback { code, state }`: exchange
/// the code, store the connection with its long-lived token, find its ad
/// accounts, and put it in the sync index (disabled until an account is
/// selected).
pub(crate) async fn callback(
    State(state): State<AdsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (code, nonce) = match validate(&headers, &body, |issues, fields| {
        (
            issues
                .text(fields, "code", Presence::Required, Some(1), None)
                .into_option(),
            issues
                .text(fields, "state", Presence::Required, Some(1), None)
                .into_option(),
        )
    }) {
        Ok((Some(code), Some(nonce))) => (code, nonce),
        Ok(_) => return ApiError::internal().into_response(),
        Err(response) => return *response,
    };
    let Some(org_id) = caller.org_id.clone().filter(|org| !org.is_empty()) else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    match consume_state(&caller, &state, &nonce, &org_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::bad_request("Invalid or expired OAuth state").into_response();
        }
        Err(response) => return *response,
    }
    let (Some(app_id), Some(app_secret)) = (
        caller.env("FACEBOOK_APP_ID"),
        caller.env("FACEBOOK_APP_SECRET"),
    ) else {
        return ApiError::internal()
            .with_message("Facebook OAuth is not configured")
            .into_response();
    };
    match connect(&state, &caller, &org_id, &app_id, &app_secret, &code).await {
        Ok((connection_id, created)) => {
            let data = json!({ "id": connection_id, "platform": "facebook", "status": "active" });
            let event = if created {
                AD_PLATFORM_CONNECTION_CREATED
            } else {
                AD_PLATFORM_CONNECTION_UPDATED
            };
            caller.publish(&state, event, &connection_id, &data);
            Data(data).into_response()
        }
        Err(error) => {
            tracing::warn!(%error, "[ads-api/ad-connections] facebook callback failed");
            ApiError::bad_request(error.to_string()).into_response()
        }
    }
}

/// The callback's work inside its `try`: the connection's id, and whether it
/// is new.
async fn connect(
    state: &AdsState,
    caller: &Caller,
    org_id: &str,
    app_id: &str,
    app_secret: &str,
    code: &str,
) -> Result<(String, bool), AdsError> {
    let http = meta_http(caller, state)?;
    let redirect_uri = redirect_uri(caller);
    let short_lived =
        exchange_code_for_tokens(&http, app_id, app_secret, &redirect_uri, code).await?;
    let long_lived =
        exchange_for_long_lived_token(&http, app_id, app_secret, &short_lived.access_token).await?;
    let profile = get_meta_user_profile(&http, &long_lived.access_token).await?;
    let now = now();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from ad_platform_connections
         where platform = 'facebook' and deleted_at is null limit 1",
    )
    .fetch_optional(&caller.db)
    .await?;
    let tokens = encrypt_oauth_tokens(&long_lived.access_token, &caller.keyring())?;
    let connection_id = if let Some(id) = &existing {
        sqlx::query(
            "update ad_platform_connections set
                 platform = 'facebook', status = 'active', meta_user_id = $2, meta_user_name = $3,
                 oauth_tokens = $4, token_expires_at = $5::timestamp, last_error = null,
                 updated_at = $6::timestamp
             where id = $1",
        )
        .bind(id)
        .bind(&profile.id)
        .bind(&profile.name)
        .bind(&tokens)
        .bind(long_lived.expires_at.as_deref())
        .bind(&now)
        .execute(&caller.db)
        .await?;
        id.clone()
    } else {
        let id = generate_id("adcn");
        sqlx::query(
            "insert into ad_platform_connections
                 (id, created_at, platform, status, meta_user_id, meta_user_name, oauth_tokens,
                  token_expires_at, last_error, updated_at)
             values ($1, $6::timestamp, 'facebook', 'active', $2, $3, $4, $5::timestamp, null,
                     $6::timestamp)",
        )
        .bind(&id)
        .bind(&profile.id)
        .bind(&profile.name)
        .bind(&tokens)
        .bind(long_lived.expires_at.as_deref())
        .bind(&now)
        .execute(&caller.db)
        .await?;
        id
    };
    discover_ad_accounts(&caller.db, &http, &connection_id, &long_lived.access_token).await?;
    upsert_ad_sync_index(
        caller.master(state).as_ref(),
        &SyncIndexEntry {
            workspace_id: &caller.workspace_id,
            connection_id: &connection_id,
            clerk_org_id: org_id,
            is_enabled: false,
            metrics_interval_hours: None,
            webhook_subscribed_at: None,
        },
    )
    .await?;
    Ok((connection_id, existing.is_none()))
}

/// The live connection `id`, as Drizzle returns the row.
async fn live_connection(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from ad_platform_connections c
         where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `POST /api/ad-connections/:id/sync[?scope=push|pull|metrics]
/// [&platformAccountId=][&platformCampaignId=]`.
pub(crate) async fn sync(
    State(state): State<AdsState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query_values(query.as_deref());
    let scope = match query_param(&query, "scope").as_deref() {
        Some("push") => SyncScope::Push,
        Some("pull" | "metrics") => SyncScope::Pull,
        _ => SyncScope::Full,
    };
    let connection = match live_connection(&caller, &id).await {
        Ok(Some(connection)) => connection,
        Ok(None) => return ApiError::not_found("Ad connection", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let encrypted = match &connection["oauthTokens"]["accessToken"] {
        Value::Null | Value::Bool(false) => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    };
    let access_token = match decrypt_access_token(encrypted.as_deref(), &caller.keyring()) {
        Ok(Some(token)) => token,
        Ok(None) => {
            return ApiError::bad_request("Connection has no valid access token").into_response();
        }
        Err(error) => return internal(&error, "Internal server error"),
    };
    let workspace_id = if caller.org_id.as_deref().is_some_and(|org| !org.is_empty()) {
        caller.workspace_id.clone()
    } else {
        String::new()
    };
    let platform_account_id = query_param(&query, "platformAccountId").filter(|v| !v.is_empty());
    let platform_campaign_id = query_param(&query, "platformCampaignId").filter(|v| !v.is_empty());
    let master = caller.master(&state);
    let result = async {
        let http = meta_http(&caller, &state)?;
        sync_selected_accounts(
            SyncTarget {
                db: &caller.db,
                master: master.as_ref(),
                http: &http,
            },
            &id,
            &access_token,
            &workspace_id,
            scope,
            platform_account_id.as_deref(),
            platform_campaign_id.as_deref(),
        )
        .await
    }
    .await;
    match result {
        Ok(result) => Data(result.to_json()).into_response(),
        Err(error) => {
            tracing::error!(%error, "[ads-api/ad-connections] sync failed");
            let marked = sqlx::query(
                "update ad_platform_connections
                 set status = 'error', last_error = $2, updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(error.to_string())
            .bind(now())
            .execute(&caller.db)
            .await;
            if let Err(error) = marked {
                return internal(&error, "Internal server error");
            }
            ApiError::internal()
                .with_message("Failed to sync ad connection")
                .into_response()
        }
    }
}

/// `DELETE /api/ad-connections/:id`: the connection, its accounts and
/// campaigns go (soft), and so does its sync index entry.
pub(crate) async fn remove(
    State(state): State<AdsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let connection = match live_connection(&caller, &id).await {
        Ok(Some(connection)) => connection,
        Ok(None) => return ApiError::not_found("Ad connection", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let result = async {
        let now = now();
        cleanup_connection_mappings(&caller.db, &id).await?;
        sqlx::query(
            "update ad_platform_connections
             set deleted_at = $2::timestamp, updated_at = $2::timestamp, status = 'error'
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        if caller.org_id.as_deref().is_some_and(|org| !org.is_empty()) {
            delete_ad_sync_index(caller.master(&state).as_ref(), &caller.workspace_id, &id).await?;
        }
        Ok::<_, AdsError>(())
    }
    .await;
    if let Err(error) = result {
        return internal(&error, "Internal server error");
    }
    caller.publish(
        &state,
        AD_PLATFORM_CONNECTION_DELETED,
        &id,
        &json!({ "id": id, "platform": connection["platform"] }),
    );
    NoContent.into_response()
}
