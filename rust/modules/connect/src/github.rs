//! WeldFlow's GitHub App (`routes/workflow-github/*`,
//! `routes/github-project-links`, `routes/github-connections`,
//! `routes/github-repo-links`, `routes/public-github-callback.ts`,
//! `services/github/*`): the workspace's installation, the repositories and
//! GitHub Projects linked to WeldFlow projects, and the post-install
//! callback GitHub redirects the browser to.
//!
//! The `github_*` rows are keyed by the Clerk org id (the install state
//! carries it as `workspaceId`), as in the TypeScript worker. The sync runs
//! themselves (`GithubProjectSyncWorkflow`, GitHub's webhooks) live in
//! integration-webhook-worker.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use http::{HeaderMap, StatusCode, header};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{Keyring, PgPool, Tenant, encrypt_field, js_row};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::github_app::{AppCredentials, app_jwt, installation_token_as};
use crate::js::{next_cursor, page, page_limit, query_truthy, total};
use crate::runs::RequestProjectSyncRuns;
use crate::{Caller, ConnectState, Overrides, Refusal, internal, now, validate, validate_query};
use weldsuite_kit::cursor::encode_uri_component;

const HEX: &str = "0123456789abcdef";
const DIRECTIONS: &[&str] = &["inbound", "outbound", "bidirectional"];
const OWNER_TYPES: &[&str] = &["user", "org"];
/// `services/github/auth.ts`'s REST calls.
const CORE_AGENT: &str = "WeldSuite-Core-API";
/// `services/github/projects.ts`'s GraphQL calls.
const APP_AGENT: &str = "WeldSuite-App-API";
const NOT_CONFIGURED: &str = "GitHub App is not configured";
/// The platform the callback sends the browser back to (`APP_BASE`).
const DEFAULT_APP_URL: &str = "https://app.weldsuite.org";

// ── Routers ─────────────────────────────────────────────────────────────────

/// `/api/workflow-github`.
pub(crate) fn workflow_github_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let manage = || gate.require([perm::INTEGRATIONS_GITHUB_MANAGE]);
    Router::new()
        .route("/install-url", get(install_url).route_layer(manage()))
        .route(
            "/connection",
            get(connection).delete(disconnect).route_layer(manage()),
        )
        .route(
            "/installations/discoverable",
            get(discoverable).route_layer(manage()),
        )
        .route("/recover", post(recover).route_layer(manage()))
        .route(
            "/repos/available",
            get(repos_available).route_layer(manage()),
        )
        .route("/repos/linked", get(repos_linked).route_layer(manage()))
        .route("/repos/link", post(link_repo).route_layer(manage()))
        .route(
            "/repos/{link_id}",
            patch(update_repo).delete(unlink_repo).route_layer(manage()),
        )
        .route(
            "/repos/{link_id}/sync",
            post(sync_repo).route_layer(manage()),
        )
        .route(
            "/projects/available",
            get(projects_available).route_layer(manage()),
        )
        .route(
            "/projects/status-fields",
            get(status_fields).route_layer(manage()),
        )
}

/// `/api/github-project-links`.
pub(crate) fn project_links_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let manage = || gate.require([perm::INTEGRATIONS_GITHUB_MANAGE]);
    Router::new()
        .route(
            "/",
            get(list_project_links)
                .post(link_project)
                .route_layer(manage()),
        )
        .route(
            "/{id}",
            get(get_project_link)
                .patch(update_project_link)
                .delete(unlink_project)
                .route_layer(manage()),
        )
        .route("/{id}/sync", post(sync_project).route_layer(manage()))
}

/// `/api/github-connections`: the generic object routes.
pub(crate) fn connections_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    generic_routes(gate, &CONNECTIONS)
}

/// `/api/github-repo-links`: the generic object routes.
pub(crate) fn repo_links_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    generic_routes(gate, &REPO_LINKS)
}

// ── Installation ────────────────────────────────────────────────────────────

fn env(caller_overrides: &Overrides, state: &ConnectState, name: &str) -> Option<String> {
    caller_overrides
        .env(state, name)
        .filter(|value| !value.is_empty())
}

/// The key the install state is signed with: `CLERK_SECRET_KEY`, as on
/// Global (so either backend opens the other's state), else
/// `INTERNAL_API_SECRET` on a deployment without Clerk.
fn state_secret(overrides: &Overrides, state: &ConnectState) -> String {
    env(overrides, state, "CLERK_SECRET_KEY")
        .or_else(|| env(overrides, state, "INTERNAL_API_SECRET"))
        .unwrap_or_default()
}

fn hmac(secret: &str, input: &str) -> Vec<u8> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(input.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// `signInstallStateJwt(payload, secret)`: HS256, ten minutes.
fn sign_state(claims: &Map<String, Value>, secret: &str) -> String {
    let now = unix_now();
    let mut claims = claims.clone();
    claims.insert("iat".into(), json!(now));
    claims.insert("exp".into(), json!(now + 600));
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(Value::Object(claims).to_string());
    let input = format!("{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(hmac(secret, &input));
    format!("{input}.{signature}")
}

/// base64url as `atob` reads it after padding: padding optional.
fn base64url(input: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(input.trim_end_matches('=')).ok()
}

/// `verifyInstallStateJwt(token, secret)`: the claims of a state this key
/// signed that has not expired.
fn verify_state(token: &str, secret: &str) -> Option<Map<String, Value>> {
    if secret.is_empty() {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return None;
    };
    let signature = base64url(signature)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{header}.{payload}").as_bytes());
    mac.verify_slice(&signature).ok()?;
    let claims: Value = serde_json::from_slice(&base64url(payload)?).ok()?;
    let claims = claims.as_object()?.clone();
    // `claims.exp < now`: a missing or non-numeric `exp` never compares less.
    if claims
        .get("exp")
        .and_then(Value::as_f64)
        .is_some_and(|exp| exp < f64::from(i32::try_from(unix_now()).unwrap_or(i32::MAX)))
    {
        return None;
    }
    Some(claims)
}

async fn install_url(
    State(state): State<ConnectState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let read = validate_query(query.as_deref(), |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Nullish, None, None);
        let return_to = issues.text(fields, "returnTo", Presence::Optional, None, None);
        (project_id, return_to)
    });
    let (project_id, return_to) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to build the install URL"),
    };
    let Some(slug) = env(&caller.overrides, &state, "GITHUB_APP_SLUG") else {
        return ApiError::internal()
            .with_message(NOT_CONFIGURED)
            .into_response();
    };
    let mut claims = Map::new();
    claims.insert("workspaceId".into(), json!(caller.clerk_org_id));
    claims.insert("userId".into(), json!(caller.user_id));
    if let Some(project_id) = project_id.as_set() {
        claims.insert("projectId".into(), json!(project_id));
    }
    if let Some(return_to) = return_to.as_set() {
        claims.insert("returnTo".into(), json!(return_to));
    }
    claims.insert("nonce".into(), json!(weldsuite_kit::random_string(32, HEX)));
    let secret = state_secret(&caller.overrides, &state);
    if secret.is_empty() {
        return ApiError::internal().into_response();
    }
    let token = sign_state(&claims, &secret);
    let url = format!(
        "https://github.com/apps/{slug}/installations/new?state={}",
        url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
    );
    Data(json!({ "url": url })).into_response()
}

async fn connection_by_workspace(
    db: &PgPool,
    workspace: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from github_connections t
         where t.workspace_id = $1 and t.deleted_at is null limit 1",
    )
    .bind(workspace)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `formatConnection(conn)`: the row without its webhook secret.
fn format_connection(mut row: Value) -> Value {
    if let Value::Object(map) = &mut row {
        map.remove("webhookSecret");
    }
    row
}

fn is_active(connection: Option<&Value>) -> bool {
    connection.is_some_and(|c| c["status"] == "active")
}

async fn connection(caller: Caller) -> Response {
    match connection_by_workspace(&caller.db, &caller.clerk_org_id).await {
        Ok(Some(row)) => Data(format_connection(row)).into_response(),
        Ok(None) => Data(Value::Null).into_response(),
        Err(error) => internal(&error, "Failed to get GitHub connection"),
    }
}

/// `revokeConnection(db, workspaceId)`.
async fn revoke(db: &PgPool, workspace: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update github_connections set status = 'revoked', revoked_at = $2::timestamp,
             updated_at = $2::timestamp
         where workspace_id = $1 and deleted_at is null",
    )
    .bind(workspace)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

async fn disconnect(caller: Caller) -> Response {
    match revoke(&caller.db, &caller.clerk_org_id).await {
        Ok(()) => NoContent.into_response(),
        Err(error) => internal(&error, "Failed to disconnect GitHub"),
    }
}

fn credentials(overrides: &Overrides, state: &ConnectState) -> Option<AppCredentials> {
    Some(AppCredentials {
        app_id: env(overrides, state, "GITHUB_APP_ID")?,
        private_key: env(overrides, state, "GITHUB_APP_PRIVATE_KEY")?,
    })
}

fn http(overrides: &Overrides, state: &ConnectState) -> OutboundHttp {
    overrides
        .http(state)
        .unwrap_or_else(|| OutboundHttp(Arc::new(crate::Unreachable)))
}

fn app_headers(request: HttpRequest, jwt: &str) -> HttpRequest {
    request
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", CORE_AGENT)
}

async fn discoverable(State(state): State<ConnectState>, caller: Caller) -> Response {
    let Some(creds) = credentials(&caller.overrides, &state) else {
        return ApiError::internal()
            .with_message(NOT_CONFIGURED)
            .into_response();
    };
    const FAILED: &str = "Failed to fetch GitHub installations";
    let jwt = match app_jwt(&creds) {
        Ok(jwt) => jwt,
        Err(error) => return internal(&error, FAILED),
    };
    let response = http(&caller.overrides, &state)
        .send(app_headers(
            HttpRequest::empty(
                "GET",
                "https://api.github.com/app/installations?per_page=100",
            ),
            &jwt,
        ))
        .await;
    let response = match response {
        Ok(response) if response.ok() => response,
        Ok(response) => return internal(&response.text(), FAILED),
        Err(error) => return internal(&error, FAILED),
    };
    let Ok(Value::Array(raw)) = serde_json::from_slice::<Value>(&response.body) else {
        return internal(&"installations are not a list", FAILED);
    };
    let mut installations = Vec::with_capacity(raw.len());
    for item in &raw {
        let Some(account) = item.get("account").filter(|a| a.is_object()) else {
            return internal(&"installation without an account", FAILED);
        };
        let account_type = if account["type"] == "Organization" {
            "Organization"
        } else {
            "User"
        };
        installations.push(json!({
            "id": item.get("id"),
            "accountLogin": account.get("login"),
            "accountType": account_type,
            "appSlug": item.get("app_slug"),
            "repositorySelection": item.get("repository_selection"),
        }));
    }
    let count = installations.len() as u64;
    List::new(installations, Pagination::new(count, false, None)).into_response()
}

/// `installationUrl(installationId)`: a safe positive integer only.
fn installation_url(id: f64) -> Result<String, String> {
    if id.fract() != 0.0 || id <= 0.0 || id > 9_007_199_254_740_991.0 {
        return Err(format!("Invalid GitHub installation id: {id}"));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(format!(
        "https://api.github.com/app/installations/{}",
        id as i64
    ))
}

/// `fetchInstallationMeta(appId, privateKey, installationId)`: the app
/// slug and the account it is installed on.
async fn installation_meta(
    http: &OutboundHttp,
    creds: &AppCredentials,
    id: f64,
) -> Result<(String, String, String), String> {
    let jwt = app_jwt(creds)?;
    let url = installation_url(id)?;
    let response = http
        .send(app_headers(HttpRequest::empty("GET", url), &jwt))
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!(
            "Failed to fetch installation metadata ({}): {}",
            response.status,
            response.text()
        ));
    }
    let data: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let account = data
        .get("account")
        .filter(|a| a.is_object())
        .ok_or("installation without an account")?;
    let text = |value: &Value| match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    Ok((
        text(&data["app_slug"]),
        if account["type"] == "Organization" {
            "org".into()
        } else {
            "user".into()
        },
        text(&account["login"]),
    ))
}

/// `upsertConnection(db, workspaceId, input, keyring)`: the installation's
/// row, re-pointed at this workspace when it exists, else a new one with a
/// fresh webhook secret.
async fn upsert_connection(
    db: &PgPool,
    workspace: &str,
    installation_id: i64,
    (app_slug, owner_type, owner_login): &(String, String, String),
    created_by: &str,
    keyring: &Keyring,
) -> Result<Value, String> {
    let stamp = now();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from github_connections
         where installation_id = $1 and deleted_at is null limit 1",
    )
    .bind(installation_id)
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let row: Value = if let Some(id) = existing {
        sqlx::query_scalar(
            "update github_connections t set workspace_id = $2, app_slug = $3, owner_type = $4,
                 owner_login = $5, scopes = null, status = 'active', installed_at = $6::timestamp,
                 revoked_at = null, updated_at = $6::timestamp
             where t.id = $1 returning to_jsonb(t)",
        )
        .bind(&id)
        .bind(workspace)
        .bind(app_slug)
        .bind(owner_type)
        .bind(owner_login)
        .bind(&stamp)
        .fetch_one(db)
        .await
        .map_err(|error| error.to_string())?
    } else {
        let secret = weldsuite_kit::random_string(64, HEX);
        let sealed = encrypt_field(&secret, keyring).map_err(|error| error.to_string())?;
        sqlx::query_scalar(
            "insert into github_connections as t
                 (id, workspace_id, installation_id, app_slug, owner_type, owner_login,
                  webhook_secret, created_by, status, scopes, installed_at, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', null, $9::timestamp, $9::timestamp,
                     $9::timestamp)
             returning to_jsonb(t)",
        )
        .bind(generate_id("ghc"))
        .bind(workspace)
        .bind(installation_id)
        .bind(app_slug)
        .bind(owner_type)
        .bind(owner_login)
        .bind(&sealed)
        .bind(created_by)
        .bind(&stamp)
        .fetch_one(db)
        .await
        .map_err(|error| error.to_string())?
    };
    Ok(js_row(row))
}

fn keyring(overrides: &Overrides, state: &ConnectState) -> Keyring {
    Keyring {
        v1: env(overrides, state, "DATABASE_ENCRYPTION_KEY"),
        v2: env(overrides, state, "DATABASE_ENCRYPTION_KEY_V2"),
    }
}

/// `z.number().int().positive()` under `key`.
fn positive_int(
    issues: &mut Issues,
    b: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<i64> {
    let field = issues.integer(b, key, presence, None);
    if b.get(key).and_then(Value::as_f64).is_some_and(|n| n <= 0.0) {
        issues.issue_at(
            key,
            json!({
                "code": "too_small",
                "minimum": 0,
                "type": "number",
                "inclusive": false,
                "exact": false,
                "message": "Number must be greater than 0",
            }),
        );
        return Field::Absent;
    }
    field
}

async fn recover(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to recover GitHub installation";
    let installation_id = match validate(&headers, &body, |issues, b| {
        positive_int(issues, b, "installationId", Presence::Required)
    }) {
        Ok(field) => field.into_option().unwrap_or_default(),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let keyring = keyring(&caller.overrides, &state);
    let creds = credentials(&caller.overrides, &state);
    let Some(creds) = creds.filter(|_| keyring.v1.is_some() || keyring.v2.is_some()) else {
        return ApiError::internal()
            .with_message(NOT_CONFIGURED)
            .into_response();
    };
    #[allow(clippy::cast_precision_loss)]
    let meta = match installation_meta(
        &http(&caller.overrides, &state),
        &creds,
        installation_id as f64,
    )
    .await
    {
        Ok(meta) => meta,
        Err(error) => return internal(&error, FAILED),
    };
    match upsert_connection(
        &caller.db,
        &caller.clerk_org_id,
        installation_id,
        &meta,
        &caller.user_id,
        &keyring,
    )
    .await
    {
        Ok(row) => Data(format_connection(row)).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

// ── The public install callback ─────────────────────────────────────────────

fn redirect(location: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, location.to_owned())]).into_response()
}

/// `workspaceAppUrl(APP_BASE, workspaceId, '/settings/integrations/github' + qs)`.
fn settings_url(base: &str, qs: &str, workspace: Option<&str>) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = format!("/settings/integrations/github{qs}");
    match workspace.filter(|w| !w.is_empty()) {
        Some(workspace) => format!("{base}/w/{}{path}", encode_uri_component(workspace)),
        None => format!("{base}{path}"),
    }
}

/// `GET /api/weldconnect/github/callback`: GitHub's post-install redirect,
/// authenticated by the state signed at `/install-url`. Answers with a
/// redirect to the platform's GitHub settings, whatever happened.
pub(crate) async fn install_callback(
    State(state): State<ConnectState>,
    RawQuery(query): RawQuery,
    request: Request,
) -> Response {
    let (parts, _) = request.into_parts();
    let overrides = Overrides::from_extensions(&parts.extensions);
    let base =
        env(&overrides, &state, "PUBLIC_APP_URL").unwrap_or_else(|| DEFAULT_APP_URL.to_owned());
    let settings =
        |qs: &str, workspace: Option<&str>| redirect(&settings_url(&base, qs, workspace));

    let query = query.as_deref();
    let installation_id = query_truthy(query, "installation_id")
        .map(|raw| crate::js::js_number(Some(&Value::String(raw))))
        .filter(|n| *n != 0.0 && !n.is_nan());
    let setup_action = crate::js::query_param(query, "setup_action");
    let state_token = query_truthy(query, "state");
    let (Some(installation_id), Some(state_token)) = (installation_id, state_token) else {
        return settings("?error=missing_params", None);
    };
    let Some(claims) = verify_state(&state_token, &state_secret(&overrides, &state)) else {
        return settings("?error=invalid_state", None);
    };
    let workspace = match claims.get("workspaceId") {
        Some(Value::String(w)) => w.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let workspace_ref = Some(workspace.as_str());
    let success = match claims.get("returnTo").filter(|r| crate::js::truthy(r)) {
        Some(Value::String(to)) => to.clone(),
        Some(other) => other.to_string(),
        None => settings_url(&base, "?installed=1", workspace_ref),
    };

    let keyring = keyring(&overrides, &state);
    if keyring.v1.is_none() && keyring.v2.is_none() {
        tracing::error!("[GitHub] DATABASE_ENCRYPTION_KEY is not configured");
        return settings("?error=configuration_error", workspace_ref);
    }
    let Some(creds) = credentials(&overrides, &state) else {
        tracing::error!("[GitHub] GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not configured");
        return settings("?error=configuration_error", workspace_ref);
    };

    let outcome = async {
        let db = if let Some(tenant) = parts.extensions.get::<Tenant>() {
            tenant.db.clone()
        } else {
            let tenants = state.tenants.as_ref().ok_or("no tenant databases")?;
            tenants(workspace.clone()).await?
        };
        if setup_action.as_deref() == Some("delete") {
            revoke(&db, &workspace).await.map_err(|e| e.to_string())?;
            return Ok(settings("?disconnected=1", workspace_ref));
        }
        let meta = installation_meta(&http(&overrides, &state), &creds, installation_id).await?;
        let created_by = match claims.get("userId") {
            Some(Value::String(u)) => u.clone(),
            _ => String::new(),
        };
        #[allow(clippy::cast_possible_truncation)]
        upsert_connection(
            &db,
            &workspace,
            installation_id as i64,
            &meta,
            &created_by,
            &keyring,
        )
        .await?;
        Ok::<_, String>(redirect(&success))
    };
    match outcome.await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[GitHub] Callback error");
            settings("?error=internal_error", workspace_ref)
        }
    }
}

// ── Repositories ────────────────────────────────────────────────────────────

/// `listAvailableRepos(token)` behind the workspace's active installation.
async fn repos_available(State(state): State<ConnectState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to list available repositories";
    let Some(creds) = credentials(&caller.overrides, &state) else {
        return ApiError::internal()
            .with_message(NOT_CONFIGURED)
            .into_response();
    };
    let conn = match connection_by_workspace(&caller.db, &caller.clerk_org_id).await {
        Ok(conn) => conn,
        Err(error) => return internal(&error, FAILED),
    };
    let Some(conn) = conn.filter(|c| is_active(Some(c))) else {
        return ApiError::not_found("GitHub connection", None).into_response();
    };
    let client = http(&caller.overrides, &state);
    let token = match installation_token_as(
        &client,
        &creds,
        conn["installationId"].as_i64().unwrap_or_default(),
        caller.overrides.http.is_none(),
        CORE_AGENT,
    )
    .await
    {
        Ok(token) => token,
        Err(error) => return internal(&error, FAILED),
    };
    match crate::github_app::list_available_repos(&client, &token).await {
        Ok(repos) => {
            let count = repos.len() as u64;
            List::new(repos, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

/// `ListLinkedReposQuerySchema` / `ListLinkedProjectsQuerySchema`.
fn linked_query(query: Option<&str>) -> Result<(Option<String>, i64), Refusal> {
    validate_query(query, |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Nullish, None, None);
        issues.text(fields, "cursor", Presence::Optional, None, None);
        let limit = issues.number(
            fields,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: false,
                min: Some(1.0),
                max: Some(100.0),
            },
        );
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit.into_option().map_or(50, |l| l.floor() as i64);
        (project_id.into_option().filter(|p| !p.is_empty()), limit)
    })
}

/// `listLinkedRepos` / `listLinkedProjects`: newest first, `limit` of
/// them; the cursor is not read and the total is the page plus one.
async fn linked_rows(
    db: &PgPool,
    table: &str,
    workspace: &str,
    project_id: Option<&String>,
    limit: i64,
) -> Result<(Vec<Value>, bool), sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from {table} t
         where t.workspace_id = $1 and t.deleted_at is null and ($2::text is null or t.project_id = $2)
         order by t.created_at desc limit $3"
    )))
    .bind(workspace)
    .bind(project_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    Ok(page(rows.into_iter().map(js_row).collect(), limit))
}

fn linked_list(rows: &[Value], has_more: bool, serialize: fn(&Value) -> Value) -> Response {
    let cursor = next_cursor(rows, has_more, "id");
    let count = rows.len() as u64 + u64::from(has_more);
    let data = rows.iter().map(serialize).collect();
    List::new(data, Pagination::new(count, has_more, cursor)).into_response()
}

/// `serializeRepoLink(row)`.
fn serialize_repo_link(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "connectionId": row["connectionId"],
        "projectId": row["projectId"],
        "repoId": row["repoId"],
        "repoFullName": row["repoFullName"],
        "defaultBranch": row["defaultBranch"],
        "syncIssues": row["syncIssues"],
        "syncDirection": row["syncDirection"],
        "lastSyncedAt": row["lastSyncedAt"],
        "syncCursor": row["syncCursor"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

async fn repos_linked(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (project_id, limit) = match linked_query(query.as_deref()) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to list linked repositories"),
    };
    match linked_rows(
        &caller.db,
        "github_repo_links",
        &caller.clerk_org_id,
        project_id.as_ref(),
        limit,
    )
    .await
    {
        Ok((rows, has_more)) => linked_list(&rows, has_more, serialize_repo_link),
        Err(error) => internal(&error, "Failed to list linked repositories"),
    }
}

/// A failed write as Drizzle reports it (`Failed query: … params: …`): the
/// routes answer 409 only when that text says `unique` or `duplicate`, which
/// with Drizzle's wrapping means one of the written values does.
fn names_conflict(values: &[&str]) -> bool {
    values
        .iter()
        .any(|v| v.contains("unique") || v.contains("duplicate"))
}

/// `LinkRepoInputSchema`.
struct RepoLink {
    project_id: Option<String>,
    repo_id: i64,
    repo_full_name: String,
    default_branch: Option<String>,
    sync_direction: String,
    sync_issues: bool,
}

fn direction(issues: &mut Issues, b: &Map<String, Value>) -> Field<String> {
    issues.choice(b, "syncDirection", Presence::Optional, DIRECTIONS)
}

async fn link_repo(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to link repository";
    let input = match validate(&headers, &body, |issues, b| RepoLink {
        project_id: issues
            .text(b, "projectId", Presence::Nullish, None, None)
            .into_option(),
        repo_id: positive_int(issues, b, "repoId", Presence::Required)
            .into_option()
            .unwrap_or_default(),
        repo_full_name: issues
            .text(b, "repoFullName", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        default_branch: issues
            .text(b, "defaultBranch", Presence::Optional, None, None)
            .into_option(),
        sync_direction: direction(issues, b)
            .into_option()
            .unwrap_or_else(|| "bidirectional".into()),
        sync_issues: issues
            .boolean(b, "syncIssues", Presence::Optional)
            .into_option()
            .unwrap_or(true),
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let conn = match connection_by_workspace(&caller.db, &caller.clerk_org_id).await {
        Ok(conn) => conn,
        Err(error) => return internal(&error, FAILED),
    };
    let Some(conn) = conn.filter(|c| is_active(Some(c))) else {
        return ApiError::bad_request("No active GitHub connection. Install the GitHub App first.")
            .into_response();
    };
    let stamp = now();
    let id = generate_id("ghrl");
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into github_repo_links as t
             (id, workspace_id, connection_id, project_id, repo_id, repo_full_name, default_branch,
              sync_issues, sync_direction, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $10::timestamp)
         returning to_jsonb(t)",
    )
    .bind(&id)
    .bind(&caller.clerk_org_id)
    .bind(conn["id"].as_str())
    .bind(&input.project_id)
    .bind(input.repo_id)
    .bind(&input.repo_full_name)
    .bind(&input.default_branch)
    .bind(input.sync_issues)
    .bind(&input.sync_direction)
    .bind(&stamp)
    .fetch_one(&caller.db)
    .await;
    match inserted {
        Ok(row) => Created(serialize_repo_link(&js_row(row))).into_response(),
        Err(error) => {
            let mut values = vec![
                id.as_str(),
                caller.clerk_org_id.as_str(),
                conn["id"].as_str().unwrap_or_default(),
                input.repo_full_name.as_str(),
                input.sync_direction.as_str(),
            ];
            values.extend(input.project_id.as_deref());
            values.extend(input.default_branch.as_deref());
            if names_conflict(&values) {
                return ApiError::conflict("This repository is already linked.").into_response();
            }
            internal(&error, FAILED)
        }
    }
}

async fn update_repo(
    caller: Caller,
    Path(link_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update repository link";
    let input = match validate(&headers, &body, |issues, b| {
        (
            issues.text(b, "projectId", Presence::Nullish, None, None),
            issues.text(b, "defaultBranch", Presence::Optional, None, None),
            direction(issues, b),
            issues.boolean(b, "syncIssues", Presence::Optional),
        )
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let (project_id, default_branch, sync_direction, sync_issues) = input;
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update github_repo_links t set updated_at = $3::timestamp,
             project_id = case when $4 then $5 else t.project_id end,
             default_branch = coalesce($6, t.default_branch),
             sync_direction = coalesce($7, t.sync_direction),
             sync_issues = coalesce($8, t.sync_issues)
         where t.id = $1 and t.workspace_id = $2 and t.deleted_at is null
         returning to_jsonb(t)",
    )
    .bind(&link_id)
    .bind(&caller.clerk_org_id)
    .bind(now())
    .bind(!project_id.is_absent())
    .bind(project_id.as_set())
    .bind(default_branch.as_set())
    .bind(sync_direction.as_set())
    .bind(sync_issues.as_set())
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => Data(serialize_repo_link(&js_row(row))).into_response(),
        Ok(None) => ApiError::not_found("Repository link", Some(&link_id)).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

/// Soft-deletes a live link of this workspace; whether there was one.
async fn soft_delete(
    db: &PgPool,
    table: &str,
    workspace: &str,
    id: &str,
) -> Result<bool, sqlx::Error> {
    let stamp = now();
    let result = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update {table} set deleted_at = $3::timestamp, updated_at = $3::timestamp
         where id = $1 and workspace_id = $2 and deleted_at is null"
    )))
    .bind(id)
    .bind(workspace)
    .bind(&stamp)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

async fn unlink_repo(caller: Caller, Path(link_id): Path<String>) -> Response {
    match soft_delete(
        &caller.db,
        "github_repo_links",
        &caller.clerk_org_id,
        &link_id,
    )
    .await
    {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("Repository link", Some(&link_id)).into_response(),
        Err(error) => internal(&error, "Failed to unlink repository"),
    }
}

async fn live_row(
    db: &PgPool,
    table: &str,
    workspace: &str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from {table} t
         where t.id = $1 and t.workspace_id = $2 and t.deleted_at is null limit 1"
    )))
    .bind(id)
    .bind(workspace)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `POST /repos/:linkId/sync`: the full sync is a Workflow binding
/// (`GITHUB_FULL_SYNC`) no deployment declares, so after its checks the
/// route answers what Global answers without it.
async fn sync_repo(caller: Caller, Path(link_id): Path<String>) -> Response {
    const FAILED: &str = "Failed to trigger synchronization";
    let result = async {
        let conn = connection_by_workspace(&caller.db, &caller.clerk_org_id).await?;
        if !is_active(conn.as_ref()) {
            return Err(Refusal::bad_request("No active GitHub connection."));
        }
        if live_row(
            &caller.db,
            "github_repo_links",
            &caller.clerk_org_id,
            &link_id,
        )
        .await?
        .is_none()
        {
            return Err(Refusal::not_found("Repository link", &link_id));
        }
        Ok(ApiError::internal()
            .with_message("GitHub full-sync workflow binding not configured")
            .into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(FAILED))
}

// ── GitHub Projects ─────────────────────────────────────────────────────────

/// `githubGraphql(token, query, variables)`.
async fn graphql(
    http: &OutboundHttp,
    token: &str,
    query: &str,
    variables: Value,
) -> Result<Value, String> {
    let response = http
        .send(
            HttpRequest::json(
                "POST",
                "https://api.github.com/graphql",
                &json!({ "query": query, "variables": variables }),
            )
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", APP_AGENT),
        )
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!(
            "GitHub GraphQL request failed ({}): {}",
            response.status,
            response.text()
        ));
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    if let Some(errors) = body["errors"].as_array().filter(|e| !e.is_empty()) {
        let messages: Vec<String> = errors
            .iter()
            .map(|e| e["message"].as_str().unwrap_or_default().to_owned())
            .collect();
        return Err(format!("GitHub GraphQL errors: {}", messages.join("; ")));
    }
    match body.get("data") {
        Some(data) if crate::js::truthy(data) => Ok(data.clone()),
        _ => Err("GitHub GraphQL response missing data".into()),
    }
}

const PROJECTS_V2_QUERY: &str = "
  query ($login: String!, $cursor: String) {
    OWNER_FIELD(login: $login) {
      projectsV2(first: 100, after: $cursor) {
        nodes {
          id
          number
          title
          shortDescription
          url
          closed
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
";

const STATUS_FIELD_QUERY: &str = r#"
  query ($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
"#;

/// `listAvailableProjectsV2(token, ownerLogin, ownerType)`.
async fn available_projects(
    http: &OutboundHttp,
    token: &str,
    owner_login: &Value,
    owner_type: &Value,
) -> Result<Vec<Value>, String> {
    let field = if owner_type == "org" {
        "organization"
    } else {
        "user"
    };
    let query = PROJECTS_V2_QUERY.replacen("OWNER_FIELD", field, 1);
    let mut projects = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let data = graphql(
            http,
            token,
            &query,
            json!({ "login": owner_login, "cursor": cursor }),
        )
        .await?;
        let owner = match data.get("organization") {
            Some(org) if !org.is_null() => org,
            _ => data.get("user").unwrap_or(&Value::Null),
        };
        let Some(connection) = owner.get("projectsV2").filter(|c| !c.is_null()) else {
            break;
        };
        for node in connection["nodes"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
        {
            projects.push(json!({
                "nodeId": node["id"],
                "number": node["number"],
                "title": node["title"],
                "ownerType": owner_type,
                "ownerLogin": owner_login,
                "url": node["url"],
                "shortDescription": node["shortDescription"],
                "closed": node["closed"],
            }));
        }
        if !crate::js::truthy(&connection["pageInfo"]["hasNextPage"]) {
            break;
        }
        cursor = connection["pageInfo"]["endCursor"].clone();
        if !crate::js::truthy(&cursor) {
            break;
        }
    }
    Ok(projects)
}

/// The installation token behind the workspace's active connection, or
/// the route's refusal.
async fn active_token(
    state: &ConnectState,
    caller: &Caller,
    failed: &str,
) -> Result<(Value, String), Box<Response>> {
    let Some(creds) = credentials(&caller.overrides, state) else {
        return Err(Box::new(
            ApiError::internal()
                .with_message(NOT_CONFIGURED)
                .into_response(),
        ));
    };
    let conn = connection_by_workspace(&caller.db, &caller.clerk_org_id)
        .await
        .map_err(|error| Box::new(internal(&error, failed)))?;
    let Some(conn) = conn.filter(|c| is_active(Some(c))) else {
        return Err(Box::new(
            ApiError::not_found("GitHub connection", None).into_response(),
        ));
    };
    let token = installation_token_as(
        &http(&caller.overrides, state),
        &creds,
        conn["installationId"].as_i64().unwrap_or_default(),
        caller.overrides.http.is_none(),
        CORE_AGENT,
    )
    .await
    .map_err(|error| Box::new(internal(&error, failed)))?;
    Ok((conn, token))
}

async fn projects_available(State(state): State<ConnectState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to list available projects";
    let (conn, token) = match active_token(&state, &caller, FAILED).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match available_projects(
        &http(&caller.overrides, &state),
        &token,
        &conn["ownerLogin"],
        &conn["ownerType"],
    )
    .await
    {
        Ok(projects) => {
            let count = projects.len() as u64;
            List::new(projects, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

async fn status_fields(
    State(state): State<ConnectState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to read project status fields";
    let node_id = match validate_query(query.as_deref(), |issues, fields| {
        issues
            .text(fields, "nodeId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(node_id) => node_id,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let (_, token) = match active_token(&state, &caller, FAILED).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let data = match graphql(
        &http(&caller.overrides, &state),
        &token,
        STATUS_FIELD_QUERY,
        json!({ "id": node_id }),
    )
    .await
    {
        Ok(data) => data,
        Err(error) => return internal(&error, FAILED),
    };
    let field = &data["node"]["field"];
    if !crate::js::truthy(field) {
        return Data(json!({ "fieldId": null, "fieldName": null, "options": [] })).into_response();
    }
    let options: Vec<Value> = field["options"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|o| json!({ "id": o["id"], "name": o["name"] }))
        .collect();
    Data(json!({ "fieldId": field["id"], "fieldName": field["name"], "options": options }))
        .into_response()
}

/// `serializeProjectLink(row)`.
fn serialize_project_link(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "connectionId": row["connectionId"],
        "projectId": row["projectId"],
        "projectV2NodeId": row["projectV2NodeId"],
        "projectV2Number": row["projectV2Number"],
        "projectTitle": row["projectTitle"],
        "ownerType": row["ownerType"],
        "ownerLogin": row["ownerLogin"],
        "repoId": row["repoId"],
        "repoFullName": row["repoFullName"],
        "statusFieldId": row["statusFieldId"],
        "statusOptionMap": if row["statusOptionMap"].is_null() { json!([]) } else { row["statusOptionMap"].clone() },
        "syncIssues": row["syncIssues"],
        "syncDirection": row["syncDirection"],
        "lastSyncedAt": row["lastSyncedAt"],
        "lastError": row["lastError"],
        "syncCursor": row["syncCursor"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

async fn list_project_links(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (project_id, limit) = match linked_query(query.as_deref()) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to list linked projects"),
    };
    match linked_rows(
        &caller.db,
        "github_project_links",
        &caller.clerk_org_id,
        project_id.as_ref(),
        limit,
    )
    .await
    {
        Ok((rows, has_more)) => linked_list(&rows, has_more, serialize_project_link),
        Err(error) => internal(&error, "Failed to list linked projects"),
    }
}

async fn get_project_link(caller: Caller, Path(id): Path<String>) -> Response {
    match live_row(
        &caller.db,
        "github_project_links",
        &caller.clerk_org_id,
        &id,
    )
    .await
    {
        Ok(Some(row)) => Data(serialize_project_link(&row)).into_response(),
        Ok(None) => ApiError::not_found("GitHub project link", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch project link"),
    }
}

/// `z.array(GithubProjectStatusOptionMappingSchema)` under `statusOptionMap`,
/// each mapping with its unknown keys stripped.
fn status_option_map(issues: &mut Issues, b: &Map<String, Value>) -> Field<Value> {
    match issues.list(
        b,
        "statusOptionMap",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            issues.object(item).map(|fields| {
                let id = issues.text(fields, "githubOptionId", Presence::Required, None, None);
                let name = issues.text(fields, "githubOptionName", Presence::Required, None, None);
                let stage = issues.text(fields, "stageId", Presence::Nullable, None, None);
                json!({
                    "githubOptionId": id.into_option(),
                    "githubOptionName": name.into_option(),
                    "stageId": stage.into_option(),
                })
            })
        },
    ) {
        Field::Set(items) => Field::Set(Value::Array(items)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `LinkProjectInputSchema`, as the row values `linkProject` writes.
fn project_link_values(issues: &mut Issues, b: &Map<String, Value>) -> Map<String, Value> {
    let mut values = Map::new();
    let project_id = issues.text(b, "projectId", Presence::Required, Some(1), None);
    let node_id = issues.text(b, "projectV2NodeId", Presence::Required, Some(1), None);
    let number = positive_int(issues, b, "projectV2Number", Presence::Required);
    let title = issues.text(b, "projectTitle", Presence::Optional, None, None);
    let owner_type = issues.choice(b, "ownerType", Presence::Required, OWNER_TYPES);
    let owner_login = issues.text(b, "ownerLogin", Presence::Required, Some(1), None);
    let repo_id = positive_int(issues, b, "repoId", Presence::Optional);
    let repo_full_name = issues.text(b, "repoFullName", Presence::Optional, None, None);
    let status_field_id = issues.text(b, "statusFieldId", Presence::Optional, None, None);
    let map = status_option_map(issues, b);
    let sync_direction = direction(issues, b);
    let sync_issues = issues.boolean(b, "syncIssues", Presence::Optional);
    values.insert("project_id".into(), json!(project_id.into_option()));
    values.insert("project_v2_node_id".into(), json!(node_id.into_option()));
    values.insert("project_v2_number".into(), json!(number.into_option()));
    values.insert("project_title".into(), json!(title.into_option()));
    values.insert("owner_type".into(), json!(owner_type.into_option()));
    values.insert("owner_login".into(), json!(owner_login.into_option()));
    values.insert("repo_id".into(), json!(repo_id.into_option()));
    values.insert("repo_full_name".into(), json!(repo_full_name.into_option()));
    values.insert(
        "status_field_id".into(),
        json!(status_field_id.into_option()),
    );
    values.insert(
        "status_option_map".into(),
        map.into_option().unwrap_or_else(|| json!([])),
    );
    values.insert(
        "sync_issues".into(),
        json!(sync_issues.into_option().unwrap_or(true)),
    );
    values.insert(
        "sync_direction".into(),
        json!(
            sync_direction
                .into_option()
                .unwrap_or_else(|| "bidirectional".into())
        ),
    );
    values
}

/// The text of every string among a write's values.
fn strings(values: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values.values() {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Array(_) | Value::Object(_) => out.push(value.to_string()),
            _ => {}
        }
    }
    out
}

const PROJECT_LINK_COLUMNS: &str =
    "project_id, project_v2_node_id, project_v2_number, project_title,
    owner_type, owner_login, repo_id, repo_full_name, status_field_id, status_option_map,
    sync_issues, sync_direction";

async fn link_project(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to link project";
    let mut values = match validate(&headers, &body, project_link_values) {
        Ok(values) => values,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let conn = match connection_by_workspace(&caller.db, &caller.clerk_org_id).await {
        Ok(conn) => conn,
        Err(error) => return internal(&error, FAILED),
    };
    let Some(conn) = conn.filter(|c| is_active(Some(c))) else {
        return ApiError::bad_request("No active GitHub connection. Install the GitHub App first.")
            .into_response();
    };
    values.insert("connection_id".into(), conn["id"].clone());
    let stamp = now();
    let existing: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from github_project_links where workspace_id = $1 and project_id = $2 limit 1",
    )
    .bind(&caller.clerk_org_id)
    .bind(values["project_id"].as_str())
    .fetch_optional(&caller.db)
    .await;
    let columns = format!("connection_id, {PROJECT_LINK_COLUMNS}");
    let record = Value::Object(values.clone());
    let (written, mut sent) = match existing {
        Err(error) => return internal(&error, FAILED),
        Ok(Some(id)) => {
            let assignments: Vec<String> = columns
                .split(',')
                .map(str::trim)
                .map(|c| format!("{c} = r.{c}"))
                .collect();
            let row: Result<Value, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "update github_project_links t set {}, deleted_at = null, updated_at = $3::timestamp
                 from jsonb_populate_record(null::github_project_links, $2) r
                 where t.id = $1 returning to_jsonb(t)",
                assignments.join(", ")
            )))
            .bind(&id)
            .bind(&record)
            .bind(&stamp)
            .fetch_one(&caller.db)
            .await;
            (row, vec![id])
        }
        Ok(None) => {
            let id = generate_id("ghpl");
            let row: Result<Value, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "insert into github_project_links as t (id, workspace_id, {columns}, created_at, updated_at)
                 select $1, $2, {columns}, $4::timestamp, $4::timestamp
                 from jsonb_populate_record(null::github_project_links, $3)
                 returning to_jsonb(t)"
            )))
            .bind(&id)
            .bind(&caller.clerk_org_id)
            .bind(&record)
            .bind(&stamp)
            .fetch_one(&caller.db)
            .await;
            (row, vec![id, caller.clerk_org_id.clone()])
        }
    };
    match written {
        Ok(row) => Created(serialize_project_link(&js_row(row))).into_response(),
        Err(error) => {
            sent.extend(strings(&values));
            let sent: Vec<&str> = sent.iter().map(String::as_str).collect();
            if names_conflict(&sent) {
                return ApiError::conflict(
                    "This WeldFlow project is already linked to a GitHub Project, or this Project is already linked.",
                )
                .into_response();
            }
            internal(&error, FAILED)
        }
    }
}

async fn update_project_link(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update project link";
    let input = match validate(&headers, &body, |issues, b| {
        (
            issues.text(b, "projectTitle", Presence::Optional, None, None),
            issues.text(b, "statusFieldId", Presence::Optional, None, None),
            status_option_map(issues, b),
            direction(issues, b),
            issues.boolean(b, "syncIssues", Presence::Optional),
        )
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let (title, status_field_id, map, sync_direction, sync_issues) = input;
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update github_project_links t set updated_at = $3::timestamp,
             project_title = coalesce($4, t.project_title),
             status_field_id = coalesce($5, t.status_field_id),
             status_option_map = coalesce($6, t.status_option_map),
             sync_direction = coalesce($7, t.sync_direction),
             sync_issues = coalesce($8, t.sync_issues)
         where t.id = $1 and t.workspace_id = $2 and t.deleted_at is null
         returning to_jsonb(t)",
    )
    .bind(&id)
    .bind(&caller.clerk_org_id)
    .bind(now())
    .bind(title.as_set())
    .bind(status_field_id.as_set())
    .bind(map.as_set())
    .bind(sync_direction.as_set())
    .bind(sync_issues.as_set())
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => Data(serialize_project_link(&js_row(row))).into_response(),
        Ok(None) => ApiError::not_found("GitHub project link", Some(&id)).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

async fn unlink_project(caller: Caller, Path(id): Path<String>) -> Response {
    match soft_delete(
        &caller.db,
        "github_project_links",
        &caller.clerk_org_id,
        &id,
    )
    .await
    {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("GitHub project link", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to unlink project"),
    }
}

/// `POST /:id/sync`: starts `GITHUB_PROJECT_SYNC` under a per-minute run
/// id; a run already there for that minute is reused.
async fn sync_project(caller: Caller, Path(id): Path<String>, request: Request) -> Response {
    const FAILED: &str = "Failed to trigger synchronization";
    let runs = request
        .extensions()
        .get::<RequestProjectSyncRuns>()
        .and_then(|runs| runs.0.clone());
    let result = async {
        let conn = connection_by_workspace(&caller.db, &caller.clerk_org_id).await?;
        if !is_active(conn.as_ref()) {
            return Err(Refusal::bad_request("No active GitHub connection."));
        }
        if live_row(
            &caller.db,
            "github_project_links",
            &caller.clerk_org_id,
            &id,
        )
        .await?
        .is_none()
        {
            return Err(Refusal::not_found("GitHub project link", &id));
        }
        let Some(runs) = runs else {
            return Ok(ApiError::internal()
                .with_message("GitHub project-sync workflow binding not configured")
                .into_response());
        };
        let bucket = time::OffsetDateTime::now_utc().unix_timestamp() / 60;
        let run_id = format!("github-project-sync-{id}-{bucket}");
        let params = json!({ "workspaceId": caller.clerk_org_id, "projectLinkId": id });
        if let Err(error) = runs.create(&run_id, &params).await {
            tracing::info!(%error, "[GitHub] Project sync already running for link {id} ({run_id}) — reusing");
        }
        Ok(Data(json!({ "runId": run_id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(FAILED))
}

// ── The generic object routes ───────────────────────────────────────────────

/// One of the generic object routers (`github-connections`,
/// `github-repo-links`): Drizzle's passthrough create and update.
struct Generic {
    table: &'static str,
    resource: &'static str,
    plural: &'static str,
    prefix: &'static str,
    /// Hide `webhookSecret` from reads.
    hides_secret: bool,
    /// The list's equality filters: query name, column.
    filters: &'static [(&'static str, &'static str)],
    /// Property → column.
    columns: &'static [(&'static str, &'static str)],
    validate: fn(&mut Issues, &Map<String, Value>, bool),
}

const CONNECTIONS: Generic = Generic {
    table: "github_connections",
    resource: "GitHub connection",
    plural: "github connections",
    prefix: "ghc",
    hides_secret: true,
    filters: &[("status", "status")],
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("workspaceId", "workspace_id"),
        ("installationId", "installation_id"),
        ("appSlug", "app_slug"),
        ("ownerType", "owner_type"),
        ("ownerLogin", "owner_login"),
        ("webhookSecret", "webhook_secret"),
        ("createdBy", "created_by"),
        ("status", "status"),
        ("scopes", "scopes"),
        ("installedAt", "installed_at"),
        ("revokedAt", "revoked_at"),
    ],
    validate: |issues, b, _partial| {
        issues.text(b, "installationId", Presence::Nullish, None, None);
        issues.text(b, "accountLogin", Presence::Optional, None, Some(255));
        issues.text(b, "status", Presence::Optional, None, Some(30));
    },
};

const REPO_LINKS: Generic = Generic {
    table: "github_repo_links",
    resource: "GitHub repo link",
    plural: "github repo links",
    prefix: "ghr",
    hides_secret: false,
    filters: &[
        ("connectionId", "connection_id"),
        ("projectId", "project_id"),
    ],
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("workspaceId", "workspace_id"),
        ("connectionId", "connection_id"),
        ("projectId", "project_id"),
        ("repoId", "repo_id"),
        ("repoFullName", "repo_full_name"),
        ("defaultBranch", "default_branch"),
        ("syncIssues", "sync_issues"),
        ("syncDirection", "sync_direction"),
        ("lastSyncedAt", "last_synced_at"),
        ("syncCursor", "sync_cursor"),
    ],
    validate: |issues, b, partial| {
        let required = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        issues.text(b, "connectionId", required, None, None);
        issues.text(b, "repoFullName", required, Some(1), Some(255));
        issues.text(b, "projectId", Presence::Nullish, None, None);
        issues.boolean(b, "isActive", Presence::Optional);
    },
};

/// Timestamp columns: Drizzle refuses anything but a `Date` there.
const DATE_PROPERTIES: &[&str] = &[
    "createdAt",
    "updatedAt",
    "deletedAt",
    "installedAt",
    "revokedAt",
    "lastSyncedAt",
];

fn generic_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
    spec: &'static Generic,
) -> Router<ConnectState> {
    let read = || gate.require([perm::INTEGRATIONS_READ]);
    Router::new()
        .route(
            "/",
            get(move |caller: Caller, RawQuery(query): RawQuery| generic_list(spec, caller, query))
                .route_layer(read()),
        )
        .route(
            "/",
            post(move |caller: Caller, headers: HeaderMap, body: Bytes| {
                generic_create(spec, caller, headers, body)
            })
            .route_layer(gate.require([perm::INTEGRATIONS_CREATE])),
        )
        .route(
            "/{id}",
            get(move |caller: Caller, Path(id): Path<String>| generic_get(spec, caller, id))
                .route_layer(read()),
        )
        .route(
            "/{id}",
            patch(
                move |caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes| {
                    generic_update(spec, caller, id, headers, body)
                },
            )
            .route_layer(gate.require([perm::INTEGRATIONS_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(move |caller: Caller, Path(id): Path<String>| {
                generic_delete(spec, caller, id)
            })
            .route_layer(gate.require([perm::INTEGRATIONS_DELETE])),
        )
}

fn generic_row(spec: &Generic, row: Value) -> Value {
    let mut row = js_row(row);
    if spec.hides_secret
        && let Value::Object(map) = &mut row
    {
        map.remove("webhookSecret");
    }
    row
}

async fn generic_list(spec: &'static Generic, caller: Caller, query: Option<String>) -> Response {
    let failed = format!("Failed to list {}", spec.plural);
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let mut conditions = vec!["t.deleted_at is null".to_owned()];
    let mut binds: Vec<String> = Vec::new();
    for (name, column) in spec.filters {
        if let Some(value) = crate::js::query_param(query, name).filter(|v| !v.is_empty()) {
            binds.push(value);
            conditions.push(format!("t.{column} = ${}", binds.len()));
        }
    }
    let cursor = query_truthy(query, "cursor");
    let mut count_conditions = conditions.clone();
    let mut count_binds = binds.len();
    if let Some(cursor) = &cursor {
        // The cursor's own condition, when its row exists. The count leaves
        // out the last condition either way: the cursor's, or (when its row
        // is gone) the last filter.
        let found: Result<Option<bool>, sqlx::Error> =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select created_at is not null from {} where id = $1 limit 1",
                spec.table
            )))
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await;
        match found {
            Ok(Some(true)) => {
                binds.push(cursor.clone());
                let n = binds.len();
                conditions.push(format!(
                    "(t.created_at < (select date_trunc('milliseconds', c.created_at) from {table} c where c.id = ${n})
                      or (t.created_at = (select date_trunc('milliseconds', c.created_at) from {table} c where c.id = ${n})
                          and t.id < ${n}))",
                    table = spec.table
                ));
            }
            Ok(_) => {
                if count_conditions.len() > 1 {
                    count_binds -= 1;
                }
                count_conditions.pop();
            }
            Err(error) => return internal(&error, &failed),
        }
    }
    let where_rows = conditions.join(" and ");
    let where_count = if count_conditions.is_empty() {
        "true".to_owned()
    } else {
        count_conditions.join(" and ")
    };
    let mut rows_query = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from {} t where {where_rows} order by t.created_at desc, t.id desc limit {}",
        spec.table,
        limit + 1
    )));
    for bind in &binds {
        rows_query = rows_query.bind(bind);
    }
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
        "select count(*) from {} t where {where_count}",
        spec.table
    )));
    for bind in binds.iter().take(count_binds) {
        count_query = count_query.bind(bind);
    }
    match (
        rows_query.fetch_all(&caller.db).await,
        count_query.fetch_one(&caller.db).await,
    ) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(
                rows.into_iter().map(|r| generic_row(spec, r)).collect(),
                limit,
            );
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, &failed),
    }
}

async fn generic_get(spec: &'static Generic, caller: Caller, id: String) -> Response {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from {} t where t.id = $1 and t.deleted_at is null limit 1",
        spec.table
    )))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => Data(generic_row(spec, row)).into_response(),
        Ok(None) => ApiError::not_found(spec.resource, Some(&id)).into_response(),
        Err(error) => internal(
            &error,
            &format!("Failed to fetch {}", spec.resource.to_lowercase()),
        ),
    }
}

/// The body's column values for `jsonb_populate_record`; `Err` when a
/// timestamp property carries something other than null (Drizzle throws
/// `value.toISOString is not a function`).
fn generic_values(
    spec: &Generic,
    data: &Map<String, Value>,
    skip: &[&str],
) -> Result<(Vec<&'static str>, Value), ()> {
    let mut columns = Vec::new();
    let mut record = Map::new();
    for (key, value) in data {
        if skip.contains(&key.as_str()) {
            continue;
        }
        let Some((_, column)) = spec.columns.iter().find(|(name, _)| name == key) else {
            continue;
        };
        if DATE_PROPERTIES.contains(&key.as_str()) && !value.is_null() {
            return Err(());
        }
        columns.push(*column);
        record.insert((*column).to_owned(), value.clone());
    }
    Ok((columns, Value::Object(record)))
}

async fn generic_create(
    spec: &'static Generic,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failed = format!("Failed to create {}", spec.resource.to_lowercase());
    let data = match validate(&headers, &body, |issues, b| {
        (spec.validate)(issues, b, false);
        b.clone()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(&failed),
    };
    let id = generate_id(spec.prefix);
    // `{ id, ...data, createdAt: now, updatedAt: now }`.
    let Ok((mut columns, mut record)) = generic_values(spec, &data, &["createdAt", "updatedAt"])
    else {
        return internal(&"value.toISOString is not a function", &failed);
    };
    if !columns.contains(&"id") {
        columns.push("id");
        record["id"] = json!(id);
    }
    let list = columns.join(", ");
    let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
        "insert into {table} ({list}, created_at, updated_at)
         select {list}, $2::timestamp, $2::timestamp from jsonb_populate_record(null::{table}, $1)",
        table = spec.table
    )))
    .bind(&record)
    .bind(now())
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => Created(json!({ "id": id })).into_response(),
        Err(error) => internal(&error, &failed),
    }
}

async fn generic_exists(spec: &Generic, db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select 1 from {} where id = $1 and deleted_at is null limit 1",
        spec.table
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

async fn generic_update(
    spec: &'static Generic,
    caller: Caller,
    id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failed = format!("Failed to update {}", spec.resource.to_lowercase());
    let data = match validate(&headers, &body, |issues, b| {
        (spec.validate)(issues, b, true);
        b.clone()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(&failed),
    };
    let result = async {
        if !generic_exists(spec, &caller.db, &id).await? {
            return Err(Refusal::not_found(spec.resource, &id));
        }
        let Ok((columns, record)) = generic_values(spec, &data, &[]) else {
            return Err(Refusal::Response(Box::new(internal(
                &"value.toISOString is not a function",
                &failed,
            ))));
        };
        let set: String = columns
            .iter()
            .fold(String::new(), |set, c| set + ", " + c + " = r." + c);
        let stamp = if columns.contains(&"updated_at") {
            String::new()
        } else {
            "updated_at = $3::timestamp".to_owned()
        };
        let set = if stamp.is_empty() {
            set.trim_start_matches(", ").to_owned()
        } else {
            format!("{stamp}{set}")
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update {table} t set {set}
             from jsonb_populate_record(null::{table}, $2) r
             where t.id = $1 and t.deleted_at is null and $3::timestamp is not null",
            table = spec.table
        )))
        .bind(&id)
        .bind(&record)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(&failed))
}

async fn generic_delete(spec: &'static Generic, caller: Caller, id: String) -> Response {
    let failed = format!("Failed to delete {}", spec.resource.to_lowercase());
    let result = async {
        if !generic_exists(spec, &caller.db, &id).await? {
            return Err(Refusal::not_found(spec.resource, &id));
        }
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update {} set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            spec.table
        )))
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(&failed))
}
