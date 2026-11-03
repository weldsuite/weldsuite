//! `routes/integrations/internal.ts`: the service-to-service integration
//! endpoints, at their full `/api/integrations/...` paths ahead of the
//! session layers. A call carrying any internal header (`X-Internal-Secret`,
//! `X-Workspace-Id`, `X-Internal-Workspace-Id`) is answered here: the secret
//! must be `INTERNAL_API_SECRET`, and the tenant comes from the Clerk org id,
//! or from `workspaces.id` through the master database. Anything else goes
//! on to the member routes ([`is_internal_call`] decides, as the worker's
//! handlers call `next()`). On Global the callers (integration-sync-worker,
//! integration-webhook-worker) reach these over the `ConnectInternal`
//! entrypoint, trusted by topology; the Kubernetes editions have only the
//! secret-guarded path.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, Method};
use serde_json::{Value, json};
use weldsuite_ads_domain::campaigns::SyncScope;
use weldsuite_ads_domain::sync::{SyncTarget, decrypt_access_token, sync_selected_accounts};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_kit::ApiError;
use weldsuite_kit::Data;

use super::{
    RequestCrmSyncRuns, WatchRenewal, action_response, renew_google_calendar_watch,
    trigger_connection_sync,
};
use crate::{ConnectState, Overrides, internal as internal_error};

const PREFIX: &str = "/api/integrations";

/// The routes, at their full paths.
pub(crate) fn router<S>(state: ConnectState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/api/integrations/connections/{id}/sync", post(sync))
        .route(
            "/api/integrations/connections/{id}/renew-watch",
            post(renew_watch),
        )
        .route(
            "/api/integrations/ad-connections/{id}/sync",
            post(ad_connection_sync),
        )
        .route("/api/integrations/ad-events", post(ad_events))
        .with_state(state)
}

/// The `:id` of `/api/integrations/<object>/:id/<action>`. The handlers
/// read it from the path themselves: the server routed the request once
/// already (the member route with the same path), so axum's `Path` would
/// see both routers' parameters.
fn id_of(uri: &http::Uri) -> String {
    uri.path().split('/').nth(4).unwrap_or_default().to_owned()
}

/// Whether `/api/integrations` paths this router serves.
fn serves(path: &str) -> bool {
    let Some(rest) = path.strip_prefix(PREFIX) else {
        return false;
    };
    let segments: Vec<&str> = rest.trim_start_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["connections", id, "sync" | "renew-watch"] if !id.is_empty()
    ) || matches!(segments.as_slice(), ["ad-connections", id, "sync"] if !id.is_empty())
        || matches!(segments.as_slice(), ["ad-events"])
}

/// A request the internal router answers: a POST to one of its paths with
/// an internal header (`resolveInternal` passes the rest through).
pub fn is_internal_call(method: &Method, path: &str, headers: &HeaderMap) -> bool {
    if method != Method::POST || !serves(path) {
        return false;
    }
    let present = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| !v.is_empty())
    };
    headers.contains_key("x-internal-secret")
        || present("x-workspace-id")
        || present("x-internal-workspace-id")
}

/// `secretMatches`: both present, equal, compared without an early exit.
fn secret_matches(given: Option<&str>, expected: Option<&str>) -> bool {
    let (Some(given), Some(expected)) = (given, expected) else {
        return false;
    };
    if expected.is_empty() || given.len() != expected.len() {
        return false;
    }
    given
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// An authenticated internal call's tenant.
struct Internal {
    db: PgPool,
    clerk_org_id: String,
    overrides: Overrides,
    /// The request's own tenant (conformance): its `workspaces.id`.
    tenant_workspace: Option<String>,
}

impl Internal {
    /// `getWorkspaceForOrg(env, clerkOrgId).id`.
    #[allow(clippy::result_large_err)]
    async fn workspace_id(&self, state: &ConnectState) -> Result<String, Response> {
        if let Some(id) = &self.tenant_workspace {
            return Ok(id.clone());
        }
        let Some(master) = self.overrides.master(state) else {
            return Err(ApiError::internal().into_response());
        };
        let found: Option<String> = sqlx::query_scalar(
            "select id from workspaces where clerk_org_id = $1 or id = $1 limit 1",
        )
        .bind(&self.clerk_org_id)
        .fetch_optional(&master)
        .await
        .map_err(|error| internal_error(&error, "Failed to resolve workspace"))?;
        found.ok_or_else(|| {
            ApiError::not_found("Workspace", Some(&self.clerk_org_id)).into_response()
        })
    }
}

/// `resolveInternal`: the secret, then the tenant.
#[allow(clippy::result_large_err)]
async fn resolve(
    state: &ConnectState,
    headers: &HeaderMap,
    extensions: &http::Extensions,
) -> Result<Internal, Response> {
    let overrides = Overrides::from_extensions(extensions);
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let expected = overrides.env(state, "INTERNAL_API_SECRET");
    if !secret_matches(header("x-internal-secret"), expected.as_deref()) {
        return Err(ApiError::unauthorized()
            .with_message("Invalid internal secret")
            .into_response());
    }
    let mut clerk_org_id = header("x-workspace-id")
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    if clerk_org_id.is_none()
        && let Some(workspace) = header("x-internal-workspace-id").filter(|v| !v.is_empty())
    {
        // The Google Calendar push path names the workspace by its own id.
        let Some(master) = overrides.master(state) else {
            return Err(ApiError::internal().into_response());
        };
        let found: Option<Option<String>> =
            sqlx::query_scalar("select clerk_org_id from workspaces where id = $1 limit 1")
                .bind(workspace)
                .fetch_optional(&master)
                .await
                .map_err(|error| internal_error(&error, "Failed to resolve workspace"))?;
        clerk_org_id = found.flatten();
    }
    let Some(clerk_org_id) = clerk_org_id else {
        return Err(ApiError::bad_request(
            "X-Workspace-Id or X-Internal-Workspace-Id header required",
        )
        .into_response());
    };
    // Conformance: the test's `getTenantDbForWorkspace` hands out its own database.
    if let Some(tenant) = extensions.get::<Tenant>() {
        return Ok(Internal {
            db: tenant.db.clone(),
            clerk_org_id,
            overrides,
            tenant_workspace: Some(tenant.workspace_id.clone()),
        });
    }
    let opened = match &state.tenants {
        Some(tenants) => tenants(clerk_org_id.clone()).await,
        None => Err("no tenant databases".to_owned()),
    };
    match opened {
        Ok(db) => Ok(Internal {
            db,
            clerk_org_id,
            overrides,
            tenant_workspace: None,
        }),
        Err(error) => {
            tracing::error!(%error, "[app-api/integrations-internal] tenant resolution failed");
            Err(ApiError::not_found("Workspace", Some(&clerk_org_id)).into_response())
        }
    }
}

fn http_of(overrides: &Overrides, state: &ConnectState) -> weldsuite_ports::OutboundHttp {
    overrides
        .http(state)
        .unwrap_or_else(|| weldsuite_ports::OutboundHttp(Arc::new(crate::Unreachable)))
}

async fn sync(
    State(state): State<ConnectState>,
    uri: http::Uri,
    headers: HeaderMap,
    extensions: http::Extensions,
    body: Bytes,
) -> Response {
    let id = id_of(&uri);
    let internal = match resolve(&state, &headers, &extensions).await {
        Ok(internal) => internal,
        Err(response) => return response,
    };
    // `{ syncType?: 'full' | 'incremental' }`; no or bad JSON keeps `full`.
    let sync_type = match serde_json::from_slice::<Value>(&body) {
        Ok(body) if body.get("syncType").and_then(Value::as_str) == Some("incremental") => {
            "incremental"
        }
        _ => "full",
    };
    let runs = extensions
        .get::<RequestCrmSyncRuns>()
        .and_then(|runs| runs.0.clone());
    let result = trigger_connection_sync(
        &internal.db,
        runs.as_ref(),
        &internal.clerk_org_id,
        &id,
        sync_type,
    )
    .await;
    action_response(result, &id, true, "Failed to trigger sync")
}

async fn renew_watch(
    State(state): State<ConnectState>,
    uri: http::Uri,
    headers: HeaderMap,
    extensions: http::Extensions,
) -> Response {
    let id = id_of(&uri);
    let internal = match resolve(&state, &headers, &extensions).await {
        Ok(internal) => internal,
        Err(response) => return response,
    };
    let http = http_of(&internal.overrides, &state);
    let env = |name: &str| {
        internal
            .overrides
            .env(&state, name)
            .filter(|v| !v.is_empty())
    };
    let renewal = WatchRenewal {
        http: &http,
        client_id: env("GOOGLE_CALENDAR_CLIENT_ID"),
        client_secret: env("GOOGLE_CALENDAR_CLIENT_SECRET"),
        environment: internal.overrides.env(&state, "ENVIRONMENT"),
    };
    let result = renew_google_calendar_watch(&internal.db, renewal, &id).await;
    action_response(result, &id, false, "Failed to renew watch channel")
}

fn keyring(overrides: &Overrides, state: &ConnectState) -> weldsuite_db::Keyring {
    let key = |name: &str| overrides.env(state, name).filter(|v| !v.is_empty());
    weldsuite_db::Keyring {
        v1: key("DATABASE_ENCRYPTION_KEY"),
        v2: key("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

async fn ad_connection_sync(
    State(state): State<ConnectState>,
    uri: http::Uri,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    extensions: http::Extensions,
) -> Response {
    let id = id_of(&uri);
    let internal = match resolve(&state, &headers, &extensions).await {
        Ok(internal) => internal,
        Err(response) => return response,
    };
    let scope = match crate::js::query_param(query.as_deref(), "scope").as_deref() {
        Some("push") => SyncScope::Push,
        Some("pull" | "metrics") => SyncScope::Pull,
        _ => SyncScope::Full,
    };
    let connection: Option<Value> = match sqlx::query_scalar(
        "select to_jsonb(c) from ad_platform_connections c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&internal.db)
    .await
    {
        Ok(row) => row,
        Err(error) => return internal_error(&error, "Failed to sync ad connection"),
    };
    let Some(connection) = connection else {
        return ApiError::not_found("Ad connection", Some(&id)).into_response();
    };
    let encrypted = connection["oauth_tokens"]
        .get("accessToken")
        .and_then(Value::as_str);
    let access_token = match decrypt_access_token(encrypted, &keyring(&internal.overrides, &state))
    {
        Ok(Some(token)) => token,
        Ok(None) => {
            return ApiError::bad_request("Connection has no valid access token").into_response();
        }
        Err(error) => return internal_error(&error, "Failed to decrypt the access token"),
    };
    let workspace_id = match internal.workspace_id(&state).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let http = http_of(&internal.overrides, &state);
    let master = internal.overrides.master(&state);
    let target = SyncTarget {
        db: &internal.db,
        master: master.as_ref(),
        http: &http,
    };
    match sync_selected_accounts(target, &id, &access_token, &workspace_id, scope, None, None).await
    {
        Ok(result) => Data(result.to_json()).into_response(),
        Err(error) => internal_error(&error, "Failed to sync ad connection"),
    }
}

/// `adEventSchema`: `(platformAccountId, platformCampaignId)`, or `None`.
fn ad_event(body: &Value) -> Option<(String, Option<String>)> {
    let fields = body.as_object()?;
    let account = fields
        .get("platformAccountId")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())?;
    let campaign = match fields.get("platformCampaignId") {
        None => None,
        Some(Value::String(campaign)) => Some(campaign.clone()),
        Some(_) => return None,
    };
    match fields.get("objectType") {
        None => {}
        Some(Value::String(kind))
            if ["campaign", "adset", "ad", "unknown"].contains(&kind.as_str()) => {}
        Some(_) => return None,
    }
    Some((account.to_owned(), campaign))
}

async fn ad_events(
    State(state): State<ConnectState>,
    headers: HeaderMap,
    extensions: http::Extensions,
    body: Bytes,
) -> Response {
    let internal = match resolve(&state, &headers, &extensions).await {
        Ok(internal) => internal,
        Err(response) => return response,
    };
    let parsed = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    let Some((account_id, campaign_id)) = ad_event(&parsed) else {
        return ApiError::bad_request("Invalid ad event payload").into_response();
    };
    let result: Result<Response, Response> = async {
        let fail = |error: &dyn std::fmt::Display| internal_error(error, "Failed to ingest ad event");
        let account: Option<String> = sqlx::query_scalar(
            "select connection_id from ad_accounts
             where platform_account_id = $1 and is_selected = true and deleted_at is null limit 1",
        )
        .bind(&account_id)
        .fetch_optional(&internal.db)
        .await
        .map_err(|e| fail(&e))?;
        let Some(connection_id) = account else {
            return Ok(Data(json!({ "skipped": true, "reason": "account_not_selected" })).into_response());
        };
        let connection: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(c) from ad_platform_connections c where c.id = $1 and c.deleted_at is null limit 1",
        )
        .bind(&connection_id)
        .fetch_optional(&internal.db)
        .await
        .map_err(|e| fail(&e))?;
        let encrypted = connection
            .as_ref()
            .and_then(|c| c["oauth_tokens"].get("accessToken"))
            .filter(|t| crate::js::truthy(t))
            .and_then(Value::as_str);
        let Some(encrypted) = encrypted else {
            return Ok(Data(json!({ "skipped": true, "reason": "missing_token" })).into_response());
        };
        let Some(access_token) = decrypt_access_token(Some(encrypted), &keyring(&internal.overrides, &state))
            .map_err(|e| fail(&e))?
        else {
            return Ok(Data(json!({ "skipped": true, "reason": "invalid_token" })).into_response());
        };
        let workspace_id = internal.workspace_id(&state).await?;
        let http = http_of(&internal.overrides, &state);
        let master = internal.overrides.master(&state);
        let target = SyncTarget {
            db: &internal.db,
            master: master.as_ref(),
            http: &http,
        };
        let synced = sync_selected_accounts(
            target,
            &connection_id,
            &access_token,
            &workspace_id,
            SyncScope::Pull,
            Some(&account_id),
            campaign_id.as_deref(),
        )
        .await
        .map_err(|e| fail(&e))?;
        Ok(Data(synced.to_json()).into_response())
    }
    .await;
    result.unwrap_or_else(|response| response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, http::HeaderValue::from_str(value).expect("header"));
        }
        map
    }

    #[test]
    fn intercepts_only_internal_calls_to_its_paths() {
        let secret = headers(&[("x-internal-secret", "s")]);
        let post = Method::POST;
        assert!(is_internal_call(
            &post,
            "/api/integrations/connections/intc_1/sync",
            &secret
        ));
        assert!(is_internal_call(
            &post,
            "/api/integrations/ad-events",
            &secret
        ));
        assert!(is_internal_call(
            &post,
            "/api/integrations/ad-connections/a/sync",
            &secret
        ));
        assert!(!is_internal_call(
            &post,
            "/api/integrations/connections/intc_1/test",
            &secret
        ));
        assert!(!is_internal_call(
            &Method::GET,
            "/api/integrations/ad-events",
            &secret
        ));
        assert!(!is_internal_call(
            &post,
            "/api/integrations/connections/intc_1/sync",
            &HeaderMap::new()
        ));
        let empty_workspace = headers(&[("x-workspace-id", "")]);
        assert!(!is_internal_call(
            &post,
            "/api/integrations/connections/x/sync",
            &empty_workspace
        ));
        let workspace = headers(&[("x-workspace-id", "org_1")]);
        assert!(is_internal_call(
            &post,
            "/api/integrations/connections/x/renew-watch",
            &workspace
        ));
    }

    #[test]
    fn secrets() {
        assert!(secret_matches(Some("abc"), Some("abc")));
        assert!(!secret_matches(Some("abc"), Some("abd")));
        assert!(!secret_matches(Some(""), Some("")));
        assert!(!secret_matches(None, Some("abc")));
    }

    #[test]
    fn ad_event_payloads() {
        assert!(ad_event(&json!({ "platformAccountId": "act_1" })).is_some());
        assert!(ad_event(&json!({ "platformAccountId": "" })).is_none());
        assert!(ad_event(&json!({ "platformAccountId": "a", "objectType": "page" })).is_none());
        assert!(ad_event(&Value::Null).is_none());
    }
}
