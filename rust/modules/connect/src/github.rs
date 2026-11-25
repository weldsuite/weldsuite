//! WeldFlow's GitHub App (`routes/workflow-github/*`,
//! `routes/github-project-links`, `routes/github-connections`,
//! `routes/github-repo-links`, `routes/public-github-callback.ts`,
//! `services/github/*`): the workspace's installation, the repositories and
//! GitHub Projects linked to WeldFlow projects, and the post-install
//! callback GitHub redirects the browser to.
//!
//! The installation is a WeldMerge connection (`merge_connections`, provider
//! `github`, read through [`crate::github_connections`]); the link rows
//! (`github_repo_links`, `github_project_links`) are keyed by the Clerk org
//! id (the install state carries it as `workspaceId`), as in the TypeScript
//! worker. The sync runs themselves (`GithubProjectSyncWorkflow`, GitHub's
//! webhooks) live in integration-webhook-worker.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, StatusCode, header};
use sea_orm::sea_query::{Alias, Expr, Func, Order, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_connect_domain::github_user::{
    InstallationAccessEvidence, prove_github_installation_access,
};
use weldsuite_connect_domain::install_state;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{Keyring, PgPool, Tenant, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_merge_domain::installations::{
    GithubInstallation, RecordError, record_github_installation, release_github_installation_index,
    set_github_installation_status,
};
use weldsuite_merge_domain::member_token::stored_member_github_token;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_schema::master::workspaces;
use weldsuite_schema::tenant::{
    github_project_links as project_links, github_repo_links as repo_links, merge_connections,
};

use crate::github_app::{AppCredentials, app_jwt, installation_token_as};
use crate::js::{next_cursor, page, page_limit, query_truthy, total};
use crate::runs::RequestProjectSyncRuns;
use crate::{Caller, ConnectState, Overrides, Refusal, internal, now, validate, validate_query};
use weldsuite_kit::cursor::encode_uri_component;

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

/// `/api/github-connections`: the generic object routes, over the
/// workspace's WeldMerge GitHub connections.
pub(crate) fn connections_routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    crate::github_connections::routes(gate)
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
/// `INTERNAL_API_SECRET` on a deployment without Clerk. The state itself is
/// the one WeldMerge's install flow signs and verifies too
/// (`weldsuite_connect_domain::install_state`).
fn state_secret(overrides: &Overrides, state: &ConnectState) -> String {
    install_state::state_secret(
        env(overrides, state, "CLERK_SECRET_KEY").as_deref(),
        env(overrides, state, "INTERNAL_API_SECRET").as_deref(),
    )
}

/// ADR OPS-026: a route that reaches GitHub, or starts or extends a
/// connection to it, answers 403 `OUTSIDE_EU_SERVICE_OFF` while the
/// workspace hasn't switched GitHub on (enforced on the EU edition;
/// elsewhere this never reads the database). Reading what is stored, editing
/// and removing it stay open, so a workspace can always disconnect.
async fn github_off(caller: &Caller) -> Option<Response> {
    weldsuite_outside_eu::require(&caller.db, weldsuite_outside_eu::ServiceId::GitHub)
        .await
        .err()
        .map(|error| error.to_api_error().into_response())
}

async fn install_url(
    State(state): State<ConnectState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(off) = github_off(&caller).await {
        return off;
    }
    let read = validate_query(query.as_deref(), |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Nullish, None, None);
        let return_to = issues.text(fields, "returnTo", Presence::Optional, None, None);
        (project_id, return_to)
    });
    let (project_id, return_to) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to build the install URL"),
    };
    let (Some(slug), Some(kv)) = (
        env(&caller.overrides, &state, "GITHUB_APP_SLUG"),
        caller.overrides.kv(&state),
    ) else {
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
    let nonce = install_state::install_state_nonce();
    claims.insert("nonce".into(), json!(nonce));
    let secret = state_secret(&caller.overrides, &state);
    if secret.is_empty() {
        return ApiError::internal().into_response();
    }
    let token = install_state::sign_install_state(&claims, &secret);
    // The state is good for one redirect: the callback (or WeldMerge's setup route) takes the nonce.
    if let Err(error) =
        install_state::remember_install_nonce(kv.as_ref(), &nonce, &caller.clerk_org_id).await
    {
        return internal(&error, "Failed to build the install URL");
    }
    let url = format!(
        "https://github.com/apps/{slug}/installations/new?state={}",
        url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
    );
    Data(json!({ "url": url })).into_response()
}

use crate::github_connections::connection_by_workspace;

/// `formatConnection(conn)`: the connection without its webhook secret.
fn format_connection(view: Value) -> Value {
    crate::github_connections::without_secret(view)
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

/// `String(Number(text))`: an installation id as connect-api passes it on
/// (`Number(row.externalAccountId)`, then `String(installationId)`).
fn installation_key(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_finite() && number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        return (number as i64).to_string();
    }
    number.to_string()
}

/// `revokeConnection(env, db, workspaceId)`: the connection the settings page
/// shows (`getConnectionByWorkspace`: the newest active one, else the newest)
/// is revoked and leaves the master index, but only when the index row names
/// this workspace (`workspace_id` is `workspaces.id`), so a member never
/// unroutes another workspace's installation. The workspace's other GitHub
/// organisations, connected in WeldMerge, keep syncing.
async fn revoke_connection(
    db: &PgPool,
    master: Option<&PgPool>,
    workspace_id: &str,
) -> Result<(), String> {
    let installation: Option<String> = merge_connections::Entity::find()
        .select_only()
        .column(merge_connections::Column::ExternalAccountId)
        .filter(merge_connections::Column::Provider.eq("github"))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .order_by_desc(merge_connections::Column::Status.eq("active"))
        .order_by_desc(merge_connections::Column::CreatedAt)
        .order_by_desc(merge_connections::Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    if let Some(installation) = installation {
        let key = installation_key(weldsuite_kit::validation::js_number(&installation));
        set_github_installation_status(db, &key, "revoked")
            .await
            .map_err(|error| error.to_string())?;
        let master = master.ok_or("no master database")?;
        release_github_installation_index(master, &key, workspace_id)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn disconnect(State(state): State<ConnectState>, caller: Caller) -> Response {
    let master = caller.overrides.master(&state);
    // `c.get('workspaceId')`: the session's own workspace.
    let workspace_id = if caller.workspace_id.is_empty() {
        match workspace_id_for(master.as_ref(), &caller.clerk_org_id).await {
            Ok(id) => id,
            Err(error) => return internal(&error, "Failed to disconnect GitHub"),
        }
    } else {
        caller.workspace_id.clone()
    };
    match revoke_connection(&caller.db, master.as_ref(), &workspace_id).await {
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
    if let Some(off) = github_off(&caller).await {
        return off;
    }
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

/// `recordInstallation(env, db, workspaceRef, input)`: the installation as
/// the workspace's WeldMerge connection (`merge_connections` and the master
/// installation index), through WeldMerge's installation recorder, the code
/// merge-api's setup route runs. `workspace_id` is `workspaces.id`. Answers
/// the connection row (as Drizzle reads it), or `None` when another
/// workspace holds the installation (`GithubInstallationTakenError`).
async fn record_installation(
    db: &PgPool,
    master: Option<&PgPool>,
    workspace_id: &str,
    installation_id: &str,
    (app_slug, owner_type, owner_login): &(String, String, String),
    user_id: &str,
    keyring: &Keyring,
) -> Result<Option<Value>, String> {
    let master = master.ok_or("no master database")?;
    let input = GithubInstallation {
        installation_id: installation_id.to_owned(),
        app_slug: app_slug.clone(),
        account_login: owner_login.clone(),
        // `org` / `user` read as GitHub's `Organization` / `User` would.
        account_type: owner_type.clone(),
        workspace_id: workspace_id.to_owned(),
        user_id: user_id.to_owned(),
        scopes: None,
        status: None,
    };
    match record_github_installation(db, master, keyring, &input).await {
        Ok(recorded) => Ok(Some(recorded.connection)),
        Err(RecordError::Taken(_)) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// `proveGithubInstallationAccess(installationId, { code, clientId, clientSecret, memberToken })`:
/// GitHub's `code` (exchanged with the App's OAuth client), else the
/// member's linked GitHub account as stored, must reach the installation.
async fn installation_reachable(
    overrides: &Overrides,
    state: &ConnectState,
    db: &PgPool,
    keyring: &Keyring,
    user_id: &str,
    installation_id: &str,
    code: Option<&str>,
) -> Result<bool, String> {
    let client_id = env(overrides, state, "GITHUB_APP_CLIENT_ID");
    let client_secret = env(overrides, state, "GITHUB_APP_CLIENT_SECRET");
    prove_github_installation_access(
        &http(overrides, state),
        installation_id,
        InstallationAccessEvidence {
            code,
            client_id: client_id.as_deref(),
            client_secret: client_secret.as_deref(),
        },
        || async {
            stored_member_github_token(db, keyring, user_id)
                .await
                .map_err(|error| error.to_string())
        },
    )
    .await
}

/// `getWorkspaceForOrg(env, ref).id`: the workspace a Clerk org id (or a
/// `workspaces.id`) names, from the master database.
async fn workspace_id_for(master: Option<&PgPool>, reference: &str) -> Result<String, String> {
    let master = master.ok_or("no master database")?;
    let id: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(reference))
                .add(workspaces::Column::ClerkOrgId.eq(reference)),
        )
        .into_tuple()
        .one(&orm(master))
        .await
        .map_err(|error| error.to_string())?;
    id.ok_or_else(|| format!("Workspace not found: {reference}"))
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
    if let Some(off) = github_off(&caller).await {
        return off;
    }
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
    // The installation must be the member's to reach: their linked GitHub account lists it.
    match installation_reachable(
        &caller.overrides,
        &state,
        &caller.db,
        &keyring,
        &caller.user_id,
        &installation_id.to_string(),
        None,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                "installation_unverified",
                "Link your GitHub account in WeldMerge with access to this installation, or install the GitHub App again",
            )
            .into_response();
        }
        Err(error) => return internal(&error, FAILED),
    }
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
    // `getWorkspaceForOrg(env, clerkOrgId).id`: the session's own workspace.
    let workspace_id = if caller.workspace_id.is_empty() {
        match workspace_id_for(
            caller.overrides.master(&state).as_ref(),
            &caller.clerk_org_id,
        )
        .await
        {
            Ok(id) => id,
            Err(error) => return internal(&error, FAILED),
        }
    } else {
        caller.workspace_id.clone()
    };
    match record_installation(
        &caller.db,
        caller.overrides.master(&state).as_ref(),
        &workspace_id,
        &installation_id.to_string(),
        &meta,
        &caller.user_id,
        &keyring,
    )
    .await
    {
        Ok(Some(row)) => Data(format_connection(
            crate::github_connections::connection_view(&row, &caller.clerk_org_id),
        ))
        .into_response(),
        Ok(None) => ApiError::new(
            StatusCode::CONFLICT,
            "installation_taken",
            "This GitHub installation belongs to another workspace",
        )
        .into_response(),
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
    let code = crate::js::query_param(query, "code");
    let (Some(installation_id), Some(state_token)) = (installation_id, state_token) else {
        return settings("?error=missing_params", None);
    };
    let Some(claims) =
        install_state::verify_install_state(&state_token, &state_secret(&overrides, &state))
    else {
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
    let (Some(creds), Some(kv)) = (credentials(&overrides, &state), overrides.kv(&state)) else {
        tracing::error!(
            "[GitHub] GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY or WORKSPACE_CACHE is not configured"
        );
        return settings("?error=configuration_error", workspace_ref);
    };

    let master = overrides.master(&state);
    let outcome = async {
        // A state is redeemed once: a replay (or a state never issued) stops here.
        let nonce = claims.get("nonce").and_then(Value::as_str);
        if !install_state::consume_install_nonce(kv.as_ref(), nonce)
            .await
            .map_err(|error| error.to_string())?
        {
            return Ok(settings("?error=state_expired", workspace_ref));
        }
        let tenant = parts.extensions.get::<Tenant>();
        let db = if let Some(tenant) = tenant {
            tenant.db.clone()
        } else {
            let tenants = state.tenants.as_ref().ok_or("no tenant databases")?;
            tenants(workspace.clone()).await?
        };
        let installation = installation_key(installation_id);
        // `workspaces.id` (the request's own tenant's in conformance).
        let workspace_id = match tenant {
            Some(tenant) => tenant.workspace_id.clone(),
            None => workspace_id_for(master.as_ref(), &workspace).await?,
        };
        if setup_action.as_deref() == Some("delete") {
            // Only this workspace's connection, and the index row only when it names this workspace.
            set_github_installation_status(&db, &installation, "revoked")
                .await
                .map_err(|error| error.to_string())?;
            let master = master.as_ref().ok_or("no master database")?;
            release_github_installation_index(master, &installation, &workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            return Ok(settings("?disconnected=1", workspace_ref));
        }
        // ADR OPS-026: no installation is recorded while GitHub is off.
        if !weldsuite_outside_eu::allowed(
            &db,
            weldsuite_outside_eu::ServiceId::GitHub,
            &format!("github install callback {workspace_id}"),
        )
        .await
        {
            return Ok(settings("?error=outside_eu_service_off", workspace_ref));
        }
        let created_by = match claims.get("userId") {
            Some(Value::String(u)) => u.clone(),
            _ => String::new(),
        };
        let reachable = installation_reachable(
            &overrides,
            &state,
            &db,
            &keyring,
            &created_by,
            &installation,
            code.as_deref(),
        )
        .await?;
        if !reachable {
            return Ok(settings("?error=installation_unverified", workspace_ref));
        }
        let meta = installation_meta(&http(&overrides, &state), &creds, installation_id).await?;
        // The installation becomes the workspace's WeldMerge connection
        // (`merge_connections` + the master index), never taken from another workspace.
        let recorded = record_installation(
            &db,
            master.as_ref(),
            &workspace_id,
            &installation,
            &meta,
            &created_by,
            &keyring,
        )
        .await?;
        if recorded.is_none() {
            return Ok(settings("?error=installation_taken", workspace_ref));
        }
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
    if let Some(off) = github_off(&caller).await {
        return off;
    }
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

/// `github_repo_links` as Drizzle returns its rows.
const REPO_LINK_ROWS: JsonTable = JsonTable::of::<repo_links::Entity>();
/// `github_project_links` as Drizzle returns its rows.
const PROJECT_LINK_ROWS: JsonTable = JsonTable::of::<project_links::Entity>();

/// `t.<name>` of a link table.
fn link_column(table: &JsonTable, name: &str) -> Result<Expr, DbErr> {
    table
        .column(name)
        .ok_or_else(|| DbErr::Custom(format!("{} has no {name}", table.table_name())))
}

/// `t.workspace_id = <workspace> and t.deleted_at is null`.
fn live_links(table: &JsonTable, workspace: &str) -> Result<Condition, DbErr> {
    Ok(Condition::all()
        .add(sea_orm::ExprTrait::eq(
            link_column(table, "workspace_id")?,
            workspace,
        ))
        .add(sea_orm::ExprTrait::is_null(link_column(
            table,
            "deleted_at",
        )?)))
}

/// `listLinkedRepos` / `listLinkedProjects`: newest first, `limit` of
/// them; the cursor is not read and the total is the page plus one.
async fn linked_rows(
    db: &PgPool,
    table: &JsonTable,
    workspace: &str,
    project_id: Option<&String>,
    limit: i64,
) -> Result<(Vec<Value>, bool), DbErr> {
    let mut condition = live_links(table, workspace)?;
    if let Some(project_id) = project_id {
        condition = condition.add(sea_orm::ExprTrait::eq(
            link_column(table, "project_id")?,
            project_id,
        ));
    }
    let select = table
        .select()
        .cond_where(condition)
        .order_by_expr(link_column(table, "created_at")?, Order::Desc)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .to_owned();
    let rows = table.rows(&orm(db), &select).await?;
    Ok(page(rows, limit))
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
        &REPO_LINK_ROWS,
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
    if let Some(off) = github_off(&caller).await {
        return off;
    }
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
    let stamp = utc_now();
    let id = generate_id("ghrl");
    let inserted = repo_links::Entity::insert(repo_links::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(caller.clerk_org_id.clone()),
        connection_id: Set(conn["id"].as_str().unwrap_or_default().to_owned()),
        project_id: Set(input.project_id.clone()),
        repo_id: Set(input.repo_id),
        repo_full_name: Set(input.repo_full_name.clone()),
        default_branch: Set(input.default_branch.clone()),
        sync_issues: Set(input.sync_issues),
        sync_direction: Set(input.sync_direction.clone()),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js);
    match inserted {
        Ok(row) => Created(serialize_repo_link(&row)).into_response(),
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
    let mut update = repo_links::Entity::update_many()
        .col_expr(repo_links::Column::UpdatedAt, Expr::value(utc_now()));
    if !project_id.is_absent() {
        update = update.col_expr(
            repo_links::Column::ProjectId,
            Expr::value(project_id.as_set().cloned()),
        );
    }
    // `coalesce($value, <column>)`: what the body sent.
    if let Some(branch) = default_branch.as_set() {
        update = update.col_expr(repo_links::Column::DefaultBranch, Expr::value(branch));
    }
    if let Some(direction) = sync_direction.as_set() {
        update = update.col_expr(repo_links::Column::SyncDirection, Expr::value(direction));
    }
    if let Some(sync) = sync_issues.as_set() {
        update = update.col_expr(repo_links::Column::SyncIssues, Expr::value(*sync));
    }
    let updated = update
        .filter(repo_links::Column::Id.eq(&link_id))
        .filter(repo_links::Column::WorkspaceId.eq(&caller.clerk_org_id))
        .filter(repo_links::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js).transpose());
    match updated {
        Ok(Some(row)) => Data(serialize_repo_link(&row)).into_response(),
        Ok(None) => ApiError::not_found("Repository link", Some(&link_id)).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

/// A row as Drizzle returns it.
fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// Soft-deletes a live link of this workspace; whether there was one.
async fn soft_delete(
    db: &PgPool,
    table: &JsonTable,
    workspace: &str,
    id: &str,
) -> Result<bool, DbErr> {
    let stamp = utc_now();
    let update = Query::update()
        .table(Alias::new(table.table_name()))
        .values([
            (Alias::new("deleted_at"), stamp.into()),
            (Alias::new("updated_at"), stamp.into()),
        ])
        .cond_where(
            live_links(table, workspace)?
                .add(sea_orm::ExprTrait::eq(link_column(table, "id")?, id)),
        )
        .to_owned();
    let result = orm(db).execute(&update).await?;
    Ok(result.rows_affected() > 0)
}

async fn unlink_repo(caller: Caller, Path(link_id): Path<String>) -> Response {
    match soft_delete(&caller.db, &REPO_LINK_ROWS, &caller.clerk_org_id, &link_id).await {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("Repository link", Some(&link_id)).into_response(),
        Err(error) => internal(&error, "Failed to unlink repository"),
    }
}

async fn live_row(
    db: &PgPool,
    table: &JsonTable,
    workspace: &str,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let select = table
        .select()
        .cond_where(
            Condition::all()
                .add(sea_orm::ExprTrait::eq(link_column(table, "id")?, id))
                .add(live_links(table, workspace)?),
        )
        .limit(1)
        .to_owned();
    Ok(table.rows(&orm(db), &select).await?.into_iter().next())
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
        if live_row(&caller.db, &REPO_LINK_ROWS, &caller.clerk_org_id, &link_id)
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
    if let Some(off) = github_off(caller).await {
        return Err(Box::new(off));
    }
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
        &PROJECT_LINK_ROWS,
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
    match live_row(&caller.db, &PROJECT_LINK_ROWS, &caller.clerk_org_id, &id).await {
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

async fn link_project(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to link project";
    if let Some(off) = github_off(&caller).await {
        return off;
    }
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
    let db = orm(&caller.db);
    let existing: Result<Option<String>, DbErr> = project_links::Entity::find()
        .select_only()
        .column(project_links::Column::Id)
        .filter(project_links::Column::WorkspaceId.eq(&caller.clerk_org_id))
        .filter(project_links::Column::ProjectId.eq(values["project_id"].as_str()))
        .into_tuple()
        .one(&db)
        .await;
    // Every link column is written: one the body left out is null.
    let (written, mut sent) = match existing {
        Err(error) => return internal(&error, FAILED),
        Ok(Some(id)) => {
            let mut record = values.clone();
            record.insert("deleted_at".into(), Value::Null);
            record.insert("updated_at".into(), json!(stamp));
            let row = PROJECT_LINK_ROWS
                .update(&db, &id, record, false)
                .await
                .and_then(|row| {
                    row.ok_or_else(|| {
                        DbErr::RecordNotFound("no rows returned by a query".to_owned())
                    })
                });
            (row, vec![id])
        }
        Ok(None) => {
            let id = generate_id("ghpl");
            let mut record = values.clone();
            record.insert("id".into(), json!(id));
            record.insert("workspace_id".into(), json!(caller.clerk_org_id));
            record.insert("created_at".into(), json!(stamp));
            record.insert("updated_at".into(), json!(stamp));
            let row = PROJECT_LINK_ROWS.insert(&db, record).await;
            (row, vec![id, caller.clerk_org_id.clone()])
        }
    };
    match written {
        Ok(row) => Created(serialize_project_link(&row)).into_response(),
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
    // `coalesce($value, <column>)`: what the body sent.
    let mut update = project_links::Entity::update_many()
        .col_expr(project_links::Column::UpdatedAt, Expr::value(utc_now()));
    if let Some(title) = title.as_set() {
        update = update.col_expr(project_links::Column::ProjectTitle, Expr::value(title));
    }
    if let Some(field) = status_field_id.as_set() {
        update = update.col_expr(project_links::Column::StatusFieldId, Expr::value(field));
    }
    if let Some(map) = map.as_set() {
        update = update.col_expr(
            project_links::Column::StatusOptionMap,
            Expr::value(map.clone()),
        );
    }
    if let Some(direction) = sync_direction.as_set() {
        update = update.col_expr(project_links::Column::SyncDirection, Expr::value(direction));
    }
    if let Some(sync) = sync_issues.as_set() {
        update = update.col_expr(project_links::Column::SyncIssues, Expr::value(*sync));
    }
    let updated = update
        .filter(project_links::Column::Id.eq(&id))
        .filter(project_links::Column::WorkspaceId.eq(&caller.clerk_org_id))
        .filter(project_links::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js).transpose());
    match updated {
        Ok(Some(row)) => Data(serialize_project_link(&row)).into_response(),
        Ok(None) => ApiError::not_found("GitHub project link", Some(&id)).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

async fn unlink_project(caller: Caller, Path(id): Path<String>) -> Response {
    match soft_delete(&caller.db, &PROJECT_LINK_ROWS, &caller.clerk_org_id, &id).await {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("GitHub project link", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to unlink project"),
    }
}

/// `POST /:id/sync`: starts `GITHUB_PROJECT_SYNC` under a per-minute run
/// id; a run already there for that minute is reused.
async fn sync_project(caller: Caller, Path(id): Path<String>, request: Request) -> Response {
    const FAILED: &str = "Failed to trigger synchronization";
    if let Some(off) = github_off(&caller).await {
        return off;
    }
    let runs = request
        .extensions()
        .get::<RequestProjectSyncRuns>()
        .and_then(|runs| runs.0.clone());
    let result = async {
        let conn = connection_by_workspace(&caller.db, &caller.clerk_org_id).await?;
        if !is_active(conn.as_ref()) {
            return Err(Refusal::bad_request("No active GitHub connection."));
        }
        if live_row(&caller.db, &PROJECT_LINK_ROWS, &caller.clerk_org_id, &id)
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

/// The generic object router of `github-repo-links`: Drizzle's passthrough
/// create and update.
struct Generic {
    entity: JsonTable,
    resource: &'static str,
    plural: &'static str,
    prefix: &'static str,
    /// The list's equality filters: query name, column.
    filters: &'static [(&'static str, &'static str)],
    /// Property → column.
    columns: &'static [(&'static str, &'static str)],
    validate: fn(&mut Issues, &Map<String, Value>, bool),
}

const REPO_LINKS: Generic = Generic {
    entity: REPO_LINK_ROWS,
    resource: "GitHub repo link",
    plural: "github repo links",
    prefix: "ghr",
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
const DATE_PROPERTIES: &[&str] = &["createdAt", "updatedAt", "deletedAt", "lastSyncedAt"];

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

/// `t.<column>` of the spec's table.
fn generic_column(spec: &Generic, name: &str) -> Result<Expr, DbErr> {
    link_column(&spec.entity, name)
}

/// The list's rows and their count: the live rows matching the filters,
/// after the cursor's row when it exists. The count leaves out the last
/// condition either way: the cursor's, or (when its row is gone) the last
/// filter.
async fn generic_page(
    spec: &'static Generic,
    db: &sea_orm::DatabaseConnection,
    query: Option<&str>,
    limit: i64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let mut conditions = vec![sea_orm::ExprTrait::is_null(generic_column(
        spec,
        "deleted_at",
    )?)];
    for (name, column) in spec.filters {
        if let Some(value) = crate::js::query_param(query, name).filter(|v| !v.is_empty()) {
            conditions.push(sea_orm::ExprTrait::eq(generic_column(spec, column)?, value));
        }
    }
    let mut count_conditions = conditions.clone();
    if let Some(cursor) = query_truthy(query, "cursor") {
        if cursor_row_dated(spec, db, &cursor).await? {
            conditions.push(after_cursor(spec, &cursor)?);
        } else {
            count_conditions.pop();
        }
    }
    let all = |conditions: Vec<Expr>| {
        conditions
            .into_iter()
            .fold(Condition::all(), Condition::add)
    };
    let rows = spec
        .entity
        .select()
        .cond_where(all(conditions))
        .order_by_expr(generic_column(spec, "created_at")?, Order::Desc)
        .order_by_expr(generic_column(spec, "id")?, Order::Desc)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .to_owned();
    let rows = spec.entity.rows(db, &rows).await?;
    let count = spec
        .entity
        .select()
        .cond_where(all(count_conditions))
        .to_owned();
    let count = spec.entity.count(db, &count).await?;
    Ok((rows, count))
}

/// `select created_at is not null from <table> where id = <cursor> limit 1`.
async fn cursor_row_dated(
    spec: &Generic,
    db: &sea_orm::DatabaseConnection,
    cursor: &str,
) -> Result<bool, DbErr> {
    let found = spec
        .entity
        .select()
        .clear_selects()
        .expr(sea_orm::ExprTrait::is_not_null(generic_column(
            spec,
            "created_at",
        )?))
        .and_where(sea_orm::ExprTrait::eq(generic_column(spec, "id")?, cursor))
        .limit(1)
        .to_owned();
    match db.query_one(&found).await? {
        Some(row) => Ok(row.try_get_by_index::<Option<bool>>(0)? == Some(true)),
        None => Ok(false),
    }
}

/// `t.created_at < c.created_at or (t.created_at = c.created_at and t.id <
/// c.id)`, with the cursor row's `created_at` to the millisecond.
fn after_cursor(spec: &Generic, cursor: &str) -> Result<Expr, DbErr> {
    let c = Alias::new("c");
    let cursor_at = || -> SelectStatement {
        Query::select()
            .expr(Func::cust("date_trunc").args([
                Expr::val("milliseconds"),
                Expr::col((c.clone(), Alias::new("created_at"))),
            ]))
            .from_as(Alias::new(spec.entity.table_name()), c.clone())
            .and_where(sea_orm::ExprTrait::eq(
                Expr::col((c.clone(), Alias::new("id"))),
                cursor,
            ))
            .to_owned()
    };
    let created_at = || generic_column(spec, "created_at");
    Ok(sea_orm::ExprTrait::or(
        sea_orm::ExprTrait::lt(created_at()?, Expr::from(cursor_at())),
        sea_orm::ExprTrait::and(
            sea_orm::ExprTrait::eq(created_at()?, Expr::from(cursor_at())),
            sea_orm::ExprTrait::lt(generic_column(spec, "id")?, cursor),
        ),
    ))
}

async fn generic_list(spec: &'static Generic, caller: Caller, query: Option<String>) -> Response {
    let failed = format!("Failed to list {}", spec.plural);
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    match generic_page(spec, &orm(&caller.db), query, limit).await {
        Ok((rows, count)) => {
            let (data, has_more) = page(rows, limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        Err(error) => internal(&error, &failed),
    }
}

async fn generic_get(spec: &'static Generic, caller: Caller, id: String) -> Response {
    match spec.entity.find(&orm(&caller.db), &id, true).await {
        Ok(Some(row)) => Data(row).into_response(),
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
) -> Result<Map<String, Value>, ()> {
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
        record.insert((*column).to_owned(), value.clone());
    }
    Ok(record)
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
    let Ok(mut record) = generic_values(spec, &data, &["createdAt", "updatedAt"]) else {
        return internal(&"value.toISOString is not a function", &failed);
    };
    if !record.contains_key("id") {
        record.insert("id".into(), json!(id));
    }
    let stamp = now();
    record.insert("created_at".into(), json!(stamp));
    record.insert("updated_at".into(), json!(stamp));
    let inserted = spec.entity.insert(&orm(&caller.db), record).await;
    match inserted {
        Ok(_) => Created(json!({ "id": id })).into_response(),
        Err(error) => internal(&error, &failed),
    }
}

async fn generic_exists(spec: &Generic, db: &PgPool, id: &str) -> Result<bool, DbErr> {
    Ok(spec.entity.find(&orm(db), id, true).await?.is_some())
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
        let Ok(mut record) = generic_values(spec, &data, &[]) else {
            return Err(Refusal::Response(Box::new(internal(
                &"value.toISOString is not a function",
                &failed,
            ))));
        };
        if !record.contains_key("updated_at") {
            record.insert("updated_at".into(), json!(now()));
        }
        spec.entity
            .update(&orm(&caller.db), &id, record, true)
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
        let stamp = now();
        let mut record = Map::new();
        record.insert("deleted_at".into(), json!(stamp));
        record.insert("updated_at".into(), json!(stamp));
        spec.entity
            .update(&orm(&caller.db), &id, record, false)
            .await?;
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond(&failed))
}
