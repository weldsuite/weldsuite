//! `/v1/user-apps` (`routes/v1/user-apps.ts`): the `weld` CLI's developer
//! API for WeldApps (create, update and delete an app, upload versions,
//! submit for review, preview sessions, the OAuth client), and the agent
//! tools discovery WeldAgent and the MCP server read.
//!
//! Every route but `GET /agent-tools` needs a workspace or personal key with
//! `user-apps:manage` (`requireDeveloperKey`, which runs before the body is
//! validated); app tokens are refused. App, version and install rows live in
//! the master database, bundles in the public bucket (`STORAGE`).

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_apps_domain::adopt::sweep_adopt_system_installs;
use weldsuite_apps_domain::schemas;
use weldsuite_apps_domain::scopes::{
    is_allowed_dev_session_url, is_reserved, random_hex, sha256_hex,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Field, Issues, json_body, query_values};
use weldsuite_ports::{DynFileStore, PutOptions, StorageBuckets};
use weldsuite_schema::master::{
    user_app_dev_sessions, user_app_installs, user_app_oauth_clients, user_app_tokens,
    user_app_versions, user_apps,
};
use weldsuite_schema::tenant::workspace_installed_apps;

use crate::session::{
    Key, KeyType, bad_request, conflict, database_error, forbidden, internal_with, not_found,
};
use crate::{ExternalApiState, master_db};

const MAX_BUNDLE_FILES: usize = 500;
const MAX_BUNDLE_BYTES: usize = 50 * 1024 * 1024;
/// `DEV_SESSION_TTL_MS`.
const DEV_SESSION_TTL: time::Duration = time::Duration::minutes(5);

/// `new Date()` as a `timestamptz` column gets it from Drizzle: to the
/// millisecond.
fn now() -> OffsetDateTime {
    weldsuite_db::utc_now().assume_utc()
}

fn db_error(error: &DbErr) -> ApiError {
    database_error(error)
}

/// A row as the routes answer it: the entity's model, as Drizzle returns
/// it (`priceMonthly`, a `numeric`, as text).
fn to_json<T: serde::Serialize>(model: T) -> Result<Value, ApiError> {
    serde_json::to_value(model).map_err(|error| db_error(&DbErr::Json(error.to_string())))
}

/// `requireDeveloperKey`.
fn require_developer_key(key: &Key) -> Result<(), ApiError> {
    if key.session.key_type == KeyType::App {
        return Err(forbidden(
            "App tokens cannot access developer routes — use a workspace or personal API key",
        ));
    }
    if !key.session.has_scope("user-apps:manage") {
        return Err(forbidden("Missing required scope: user-apps:manage"));
    }
    Ok(())
}

/// The request's env (conformance builds give the test's), else the state's.
fn env_value(
    state: &ExternalApiState,
    request_env: Option<&weldsuite_kit::RequestEnv>,
    key: &str,
) -> Option<String> {
    request_env.map_or_else(
        || state.env.get(key).cloned(),
        |env| env.0.get(key).cloned(),
    )
}

/// `isOfficialPublisher`: the workspace is in `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS`.
fn is_official_publisher(setting: Option<&str>, workspace_id: &str) -> bool {
    setting
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .any(|id| !id.is_empty() && id == workspace_id)
}

/// What the developer routes share: the key, the master database, the
/// request's env and buckets.
pub(crate) struct Developer {
    key: Key,
    master: PgPool,
    env: Option<weldsuite_kit::RequestEnv>,
    /// The public bucket (`STORAGE`), where bundles live.
    public: Option<Arc<dyn DynFileStore>>,
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Developer
where
    ExternalApiState: axum::extract::FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let shared = <ExternalApiState as axum::extract::FromRef<S>>::from_ref(state);
        let key = Key::from_request_parts(parts, state).await?;
        Ok(Self {
            master: master_db(&shared, &parts.extensions),
            env: parts.extensions.get::<weldsuite_kit::RequestEnv>().cloned(),
            public: parts
                .extensions
                .get::<StorageBuckets>()
                .and_then(|buckets| buckets.public.clone())
                .or_else(|| shared.public_files.clone()),
            key,
        })
    }
}

impl Developer {
    fn actor(&self) -> &str {
        self.key.session.actor()
    }

    fn official(&self, state: &ExternalApiState) -> bool {
        is_official_publisher(
            env_value(
                state,
                self.env.as_ref(),
                "WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS",
            )
            .as_deref(),
            &self.key.session.workspace_id,
        )
    }

    /// `getOwnedApp`: the workspace's own app, not deleted.
    async fn owned_app(&self, id: &str) -> Result<Value, ApiError> {
        let row = user_apps::Entity::find_by_id(id.to_owned())
            .filter(user_apps::Column::OwnerWorkspaceId.eq(self.key.session.workspace_id.as_str()))
            .filter(user_apps::Column::DeletedAt.is_null())
            .one(&orm(&self.master))
            .await
            .map_err(|error| db_error(&error))?;
        to_json(row.ok_or_else(|| not_found("App", id))?)
    }
}

fn respond(result: Result<Response, ApiError>) -> Response {
    result.unwrap_or_else(IntoResponse::into_response)
}

/// `zValidator('json', schema)` after the developer gate.
fn validated<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let read = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(IntoResponse::into_response)?;
    read.ok_or_else(|| crate::session::internal().into_response())
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `{ data: rows, pagination: { totalCount: rows.length, hasMore: false, cursor: null } }`.
fn whole_list(rows: &[Value]) -> Response {
    let total = rows.len();
    Json(json!({
        "data": rows,
        "pagination": { "totalCount": total, "hasMore": false, "cursor": null },
    }))
    .into_response()
}

/// `{ clientId, createdAt }` of an app's OAuth client.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OauthClient {
    client_id: String,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// An install's app code, name, manifest and granted scopes.
type ToolRow = (String, String, Option<Value>, Option<Value>);

// ── GET /agent-tools ─────────────────────────────────────────────────────────

/// `GET /agent-tools`: every installed app's agent tools (an app token sees
/// only its own app's). No developer gate.
pub(crate) async fn agent_tools(caller: Developer) -> Response {
    let Developer { key, master, .. } = caller;
    let app_id = (key.session.key_type == KeyType::App)
        .then(|| key.session.app_id.clone())
        .flatten();
    let rows: Result<Vec<ToolRow>, DbErr> = user_app_installs::Entity::find()
        .join(
            JoinType::InnerJoin,
            user_app_installs::Entity::belongs_to(user_apps::Entity)
                .from(user_app_installs::Column::AppId)
                .to(user_apps::Column::Id)
                .into(),
        )
        .select_only()
        .column(user_apps::Column::Code)
        .column(user_apps::Column::Name)
        .column(user_apps::Column::Manifest)
        .column(user_app_installs::Column::GrantedScopes)
        .filter(user_app_installs::Column::WorkspaceId.eq(key.session.workspace_id.as_str()))
        .filter(user_app_installs::Column::Status.eq("active"))
        .filter(user_apps::Column::IsActive.eq(true))
        .filter(user_apps::Column::DeletedAt.is_null())
        .apply_if(app_id, |select, app_id| {
            select.filter(user_app_installs::Column::AppId.eq(app_id))
        })
        .into_tuple()
        .all(&orm(&master))
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return db_error(&error).into_response(),
    };
    let mut tools = Vec::new();
    for (code, name, manifest, granted) in rows {
        let granted = granted
            .filter(|value| !value.is_null())
            .unwrap_or_else(|| json!([]));
        let Some(Value::Array(items)) = manifest.as_ref().and_then(|m| m.get("agentTools")) else {
            continue;
        };
        for tool in items {
            let mut out = Map::new();
            out.insert("appCode".into(), json!(code));
            out.insert("appName".into(), json!(name));
            // Keys the tool leaves out stay out (`undefined` in the JSON).
            for field in ["name", "description", "parameters", "action"] {
                if let Some(value) = tool.get(field) {
                    out.insert(field.into(), value.clone());
                }
            }
            out.insert("grantedScopes".into(), granted.clone());
            tools.push(Value::Object(out));
        }
    }
    Json(json!({ "data": tools })).into_response()
}

// ── apps ─────────────────────────────────────────────────────────────────────

/// `POST /`: register a new app.
pub(crate) async fn create(
    State(state): State<ExternalApiState>,
    developer: Developer,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = developer_gate(&developer) {
        return error.into_response();
    }
    let body = match validated(&headers, &body, schemas::create_app) {
        Ok(body) => body,
        Err(response) => return response,
    };
    respond(
        async {
            let official = developer.official(&state);
            if is_reserved(&body.code) && !official {
                return Err(conflict(format!("App code '{}' is reserved", body.code)));
            }
            let master = orm(&developer.master);
            let taken: Option<String> = user_apps::Entity::find()
                .select_only()
                .column(user_apps::Column::Id)
                .filter(user_apps::Column::Code.eq(body.code.as_str()))
                .into_tuple()
                .one(&master)
                .await
                .map_err(|error| db_error(&error))?;
            if taken.is_some() {
                return Err(conflict(format!("App code '{}' is already taken", body.code)));
            }
            let truthy = |value: Option<String>| value.filter(|text| !text.is_empty());
            let now = now();
            let row = user_apps::Entity::insert(user_apps::ActiveModel {
                id: Set(generate_id("uapp")),
                code: Set(body.code),
                name: Set(body.name),
                description: Set(body.description),
                icon: Set(truthy(body.icon).unwrap_or_else(|| "Puzzle".to_owned())),
                category: Set(truthy(body.category).unwrap_or_else(|| "Productivity".to_owned())),
                website_url: Set(truthy(body.website_url)),
                privacy_url: Set(truthy(body.privacy_url)),
                screenshots: Set(Some(
                    body.screenshots.map_or_else(|| json!([]), |shots| json!(shots)),
                )),
                webhook_url: Set(truthy(body.webhook_url)),
                owner_workspace_id: Set(developer.key.session.workspace_id.clone()),
                created_by: Set(developer.actor().to_owned()),
                publisher_type: Set(if official { "weldsuite" } else { "community" }.to_owned()),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_with_returning(&master)
            .await
            .map_err(|error| match error {
                DbErr::RecordNotInserted => internal_with("Failed to create app"),
                error => db_error(&error),
            })?;
            Ok((StatusCode::CREATED, Json(json!({ "data": to_json(row)? }))).into_response())
        }
        .await,
    )
}

/// The developer gate as an error.
fn developer_gate(developer: &Developer) -> Result<(), ApiError> {
    require_developer_key(&developer.key)
}

/// `GET /`: the workspace's apps, newest first.
pub(crate) async fn list(developer: Developer) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            let rows = user_apps::Entity::find()
                .filter(
                    user_apps::Column::OwnerWorkspaceId
                        .eq(developer.key.session.workspace_id.as_str()),
                )
                .filter(user_apps::Column::DeletedAt.is_null())
                .order_by_desc(user_apps::Column::CreatedAt)
                .order_by_desc(user_apps::Column::Id)
                .all(&orm(&developer.master))
                .await
                .map_err(|error| db_error(&error))?;
            Ok(whole_list(
                &rows.into_iter().map(to_json).collect::<Result<Vec<_>, _>>()?,
            ))
        }
        .await,
    )
}

/// `GET /:id`.
pub(crate) async fn detail(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            let app = developer.owned_app(&id).await?;
            Ok(Json(json!({ "data": app })).into_response())
        }
        .await,
    )
}

/// `PATCH /:id`: the fields the body names.
pub(crate) async fn update(
    developer: Developer,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = developer_gate(&developer) {
        return error.into_response();
    }
    let body = match validated(&headers, &body, schemas::update_app) {
        Ok(body) => body,
        Err(response) => return response,
    };
    respond(
        async {
            developer.owned_app(&id).await?;
            // `case when $set then $value else a.<column> end`: a column only
            // when the body names it (`null` clears it).
            let mut update = user_apps::Entity::update_many();
            for (field, column) in [
                (&body.name, user_apps::Column::Name),
                (&body.description, user_apps::Column::Description),
                (&body.icon, user_apps::Column::Icon),
                (&body.category, user_apps::Column::Category),
                (&body.website_url, user_apps::Column::WebsiteUrl),
                (&body.privacy_url, user_apps::Column::PrivacyUrl),
                (&body.webhook_url, user_apps::Column::WebhookUrl),
            ] {
                match field {
                    Field::Absent => {}
                    Field::Null => {
                        update = update.col_expr(column, Expr::value(Option::<String>::None));
                    }
                    Field::Set(value) => {
                        update = update.col_expr(column, Expr::value(value.clone()));
                    }
                }
            }
            // `coalesce($isActive, a.is_active)`; screenshots only when sent.
            if let Some(is_active) = body.is_active.as_set().copied() {
                update = update.col_expr(user_apps::Column::IsActive, Expr::value(is_active));
            }
            if let Some(shots) = body.screenshots.as_set() {
                update = update.col_expr(user_apps::Column::Screenshots, Expr::value(json!(shots)));
            }
            let row = update
                .col_expr(user_apps::Column::UpdatedAt, Expr::value(now()))
                .filter(user_apps::Column::Id.eq(id.as_str()))
                .exec_with_returning(&orm(&developer.master))
                .await
                .map_err(|error| db_error(&error))?
                .into_iter()
                .next();
            let row = row.ok_or_else(|| internal_with("Failed to update app"))?;
            Ok(Json(json!({ "data": to_json(row)? })).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`: soft-delete the app, revoke its installs and tokens, and
/// retire its sidebar entry in this workspace. Refused while another
/// workspace still has it installed.
pub(crate) async fn remove(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            developer.owned_app(&id).await?;
            let workspace_id = developer.key.session.workspace_id.as_str();
            let master = orm(&developer.master);
            let foreign = user_app_installs::Entity::find()
                .filter(user_app_installs::Column::AppId.eq(id.as_str()))
                .filter(user_app_installs::Column::Status.eq("active"))
                .filter(user_app_installs::Column::WorkspaceId.ne(workspace_id))
                .count(&master)
                .await
                .map_err(|error| db_error(&error))?;
            if foreign > 0 {
                return Err(conflict("App is still installed in other workspaces"));
            }
            retire_app(&master, &orm(&developer.key.db), &id, now())
                .await
                .map_err(|error| db_error(&error))?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

/// Soft-delete the app, revoke its active installs and live tokens (master),
/// and retire its sidebar entry in this workspace (`tenant`).
async fn retire_app(
    master: &DatabaseConnection,
    tenant: &DatabaseConnection,
    id: &str,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    user_apps::Entity::update_many()
        .col_expr(user_apps::Column::DeletedAt, Expr::value(now))
        .col_expr(user_apps::Column::IsActive, Expr::value(false))
        .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
        .filter(user_apps::Column::Id.eq(id))
        .exec(master)
        .await?;
    user_app_installs::Entity::update_many()
        .col_expr(user_app_installs::Column::Status, Expr::value("revoked"))
        .col_expr(user_app_installs::Column::RevokedAt, Expr::value(now))
        .col_expr(user_app_installs::Column::UpdatedAt, Expr::value(now))
        .filter(user_app_installs::Column::AppId.eq(id))
        .filter(user_app_installs::Column::Status.eq("active"))
        .exec(master)
        .await?;
    user_app_tokens::Entity::update_many()
        .col_expr(user_app_tokens::Column::RevokedAt, Expr::value(now))
        .filter(user_app_tokens::Column::AppId.eq(id))
        .filter(user_app_tokens::Column::RevokedAt.is_null())
        .exec(master)
        .await?;
    workspace_installed_apps::Entity::update_many()
        .col_expr(workspace_installed_apps::Column::DeletedAt, Expr::value(now))
        .col_expr(workspace_installed_apps::Column::IsActive, Expr::value(false))
        .col_expr(workspace_installed_apps::Column::UpdatedAt, Expr::value(now))
        .filter(workspace_installed_apps::Column::UserAppId.eq(id))
        .filter(workspace_installed_apps::Column::DeletedAt.is_null())
        .exec(tenant)
        .await?;
    Ok(())
}

// ── versions ─────────────────────────────────────────────────────────────────

/// `GET /:id/versions`.
pub(crate) async fn versions(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            developer.owned_app(&id).await?;
            let rows = user_app_versions::Entity::find()
                .filter(user_app_versions::Column::AppId.eq(id.as_str()))
                .order_by_desc(user_app_versions::Column::CreatedAt)
                .order_by_desc(user_app_versions::Column::Id)
                .all(&orm(&developer.master))
                .await
                .map_err(|error| db_error(&error))?;
            Ok(whole_list(
                &rows.into_iter().map(to_json).collect::<Result<Vec<_>, _>>()?,
            ))
        }
        .await,
    )
}

/// One multipart entry: a text field, or a file with its name.
enum FormValue {
    Text(String),
    File { name: String, bytes: Vec<u8> },
}

/// `c.req.parseBody({ all: true })`: a multipart or url-encoded form; any
/// other body reads as empty. `None` when a multipart body cannot be read.
async fn form_data(request: Request) -> Option<Vec<(String, FormValue)>> {
    let media = request
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if media == "application/x-www-form-urlencoded" {
        let body = axum::body::to_bytes(request.into_body(), MAX_BUNDLE_BYTES * 2)
            .await
            .ok()?;
        return Some(
            form_urlencoded::parse(&body)
                .map(|(key, value)| (key.into_owned(), FormValue::Text(value.into_owned())))
                .collect(),
        );
    }
    if media != "multipart/form-data" {
        return Some(Vec::new());
    }
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut entries = Vec::new();
    while let Some(field) = multipart.next_field().await.ok()? {
        let name = field.name().unwrap_or_default().to_owned();
        let file_name = field.file_name().map(str::to_owned);
        let bytes = field.bytes().await.ok()?.to_vec();
        entries.push((
            name,
            match file_name {
                Some(name) => FormValue::File { name, bytes },
                None => FormValue::Text(String::from_utf8_lossy(&bytes).into_owned()),
            },
        ));
    }
    Some(entries)
}

/// `sanitizeBundlePath`: `\` → `/`, a leading `./` or `/` dropped; empty,
/// over 255 characters, or with an empty, `.` or `..` segment is unsafe.
fn sanitize_bundle_path(raw: &str) -> Option<String> {
    let replaced = raw.replace('\\', "/");
    // `^\.?\/+`: an optional `.` and at least one `/`; `.a` stays as it is.
    let path = match replaced
        .strip_prefix('.')
        .filter(|rest| rest.starts_with('/'))
    {
        Some(rest) => rest.trim_start_matches('/'),
        None => replaced.trim_start_matches('/'),
    };
    if path.is_empty() || path.encode_utf16().count() > 255 {
        return None;
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(path.to_owned())
}

/// `CONTENT_TYPES` by extension, `application/octet-stream` otherwise.
fn content_type_for(path: &str) -> &'static str {
    let extension = path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// A parsed version upload.
struct Upload {
    manifest: Value,
    changelog: Option<String>,
    files: Vec<(String, Vec<u8>)>,
    total_bytes: usize,
}

/// `parseVersionUpload`, or the 400 it answers.
async fn parse_upload(request: Request, app_code: &str) -> Result<Upload, ApiError> {
    let entries = form_data(request)
        .await
        .ok_or_else(|| bad_request("Expected multipart/form-data"))?;
    // `parseBody({ all: true })` keeps a single value as it is and repeats
    // as an array; a non-string `manifest` (a file) is not the field.
    let texts = |key: &str| {
        entries
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value)
            .collect::<Vec<_>>()
    };
    let manifest_values = texts("manifest");
    let raw_manifest = match manifest_values.as_slice() {
        [FormValue::Text(text)] => text.clone(),
        _ => {
            return Err(bad_request(
                "A 'manifest' field with the weldapp.json contents is required",
            ));
        }
    };
    let json: Value = serde_json::from_str(&raw_manifest)
        .map_err(|_| bad_request("manifest must be valid JSON"))?;
    let manifest = schemas::manifest(&json)
        .map_err(|details| bad_request("Invalid manifest").with_details(details))?;
    let code = text(&manifest, "code");
    if code != app_code {
        return Err(bad_request(format!(
            "Manifest code '{code}' does not match app code '{app_code}'"
        )));
    }
    let changelog = match texts("changelog").as_slice() {
        [FormValue::Text(text)] => Some(text.clone()),
        _ => None,
    };
    let files: Vec<(String, Vec<u8>)> = entries
        .into_iter()
        .filter(|(name, _)| name == "files")
        .filter_map(|(_, value)| match value {
            FormValue::File { name, bytes } => Some((name, bytes)),
            FormValue::Text(_) => None,
        })
        .collect();
    if files.is_empty() {
        return Err(bad_request("At least one 'files' entry is required"));
    }
    if files.len() > MAX_BUNDLE_FILES {
        return Err(bad_request(format!(
            "Bundle exceeds the {MAX_BUNDLE_FILES}-file limit"
        )));
    }
    let total_bytes = files.iter().map(|(_, bytes)| bytes.len()).sum();
    if total_bytes > MAX_BUNDLE_BYTES {
        return Err(bad_request("Bundle exceeds the 50MB size limit"));
    }
    Ok(Upload {
        manifest,
        changelog,
        files,
        total_bytes,
    })
}

/// `POST /:id/versions`: upload a bundle. Private, unapproved and official
/// apps go live at once; an approved public app's version waits for review.
pub(crate) async fn upload_version(
    developer: Developer,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    respond(upload(developer, id, request).await)
}

async fn upload(developer: Developer, id: String, request: Request) -> Result<Response, ApiError> {
    developer_gate(&developer)?;
    let app = developer.owned_app(&id).await?;
    let storage = developer
        .public
        .clone()
        .ok_or_else(|| internal_with("Bundle storage is not configured"))?;
    let upload = parse_upload(request, text(&app, "code")).await?;
    let version = text(&upload.manifest, "version").to_owned();
    let master = &orm(&developer.master);
    let dupe: Option<String> = user_app_versions::Entity::find()
        .select_only()
        .column(user_app_versions::Column::Id)
        .filter(user_app_versions::Column::AppId.eq(id.as_str()))
        .filter(user_app_versions::Column::Version.eq(version.as_str()))
        .into_tuple()
        .one(master)
        .await
        .map_err(|error| db_error(&error))?;
    if dupe.is_some() {
        return Err(conflict(format!(
            "Version {version} already exists for this app"
        )));
    }
    let version_id = generate_id("uav");
    let bundle_key = format!("user-apps/{id}/{version_id}");
    let file_count = upload.files.len();
    for (name, bytes) in upload.files {
        let Some(path) = sanitize_bundle_path(&name) else {
            return Err(bad_request(format!("Invalid bundle file path: {name}")));
        };
        storage
            .put_boxed(
                &format!("{bundle_key}/{path}"),
                bytes,
                &PutOptions::content_type(content_type_for(&path)),
            )
            .await
            .map_err(|error| {
                tracing::error!(%error, "external-api: bundle upload failed");
                crate::session::internal()
            })?;
    }
    let publish_now = text(&app, "visibility") == "private"
        || text(&app, "reviewStatus") != "approved"
        || text(&app, "publisherType") == "weldsuite";
    let now = now();
    let manifest = &upload.manifest;
    let scopes = manifest.get("scopes").cloned().unwrap_or_else(|| json!([]));
    let entrypoint = manifest
        .get("entrypoint")
        .and_then(Value::as_str)
        .unwrap_or("index.html")
        .to_owned();
    let row = user_app_versions::Entity::insert(user_app_versions::ActiveModel {
        id: Set(version_id.clone()),
        app_id: Set(id.clone()),
        version: Set(version),
        manifest: Set(Some(manifest.clone())),
        requested_scopes: Set(Some(scopes)),
        bundle_key: Set(bundle_key),
        entrypoint: Set(entrypoint),
        bundle_size: Set(i32::try_from(upload.total_bytes).unwrap_or(i32::MAX)),
        file_count: Set(i32::try_from(file_count).unwrap_or(i32::MAX)),
        status: Set(if publish_now { "published" } else { "draft" }.to_owned()),
        changelog: Set(upload.changelog),
        created_by: Set(developer.actor().to_owned()),
        published_at: Set(publish_now.then_some(now)),
        created_at: Set(now),
    })
    .exec_with_returning(master)
    .await
    .map_err(|error| match error {
        DbErr::RecordNotInserted => internal_with("Failed to create version"),
        error => db_error(&error),
    })?;
    if publish_now {
        publish_live(master, &app, manifest, &version_id, now)
            .await
            .map_err(|error| db_error(&error))?;
    } else {
        user_apps::Entity::update_many()
            .col_expr(user_apps::Column::ReviewStatus, Expr::value("submitted"))
            .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
            .filter(user_apps::Column::Id.eq(id.as_str()))
            .exec(master)
            .await
            .map_err(|error| db_error(&error))?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "data": to_json(row)? }))).into_response())
}

/// `publishVersionLive`: supersede the other published versions, roll the
/// app forward onto the manifest, and flag the new scopes on every active
/// install for re-consent.
async fn publish_live(
    master: &DatabaseConnection,
    app: &Value,
    manifest: &Value,
    version_id: &str,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    let app_id = text(app, "id");
    user_app_versions::Entity::update_many()
        .col_expr(user_app_versions::Column::Status, Expr::value("superseded"))
        .filter(user_app_versions::Column::AppId.eq(app_id))
        .filter(user_app_versions::Column::Status.eq("published"))
        .filter(user_app_versions::Column::Id.ne(version_id))
        .exec(master)
        .await?;
    // `manifest.x ?? appRow.x`, and `icon`/`category` only when truthy.
    let or_app = |key: &str, column: &str| -> Value {
        manifest
            .get(key)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| app.get(column).cloned().unwrap_or(Value::Null))
    };
    let truthy = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let as_text = |value: Value| value.as_str().map(str::to_owned);
    let scopes = manifest.get("scopes").cloned().unwrap_or_else(|| json!([]));
    let mut update = user_apps::Entity::update_many()
        .col_expr(user_apps::Column::CurrentVersionId, Expr::value(version_id))
        .col_expr(user_apps::Column::Manifest, Expr::value(manifest.clone()))
        .col_expr(user_apps::Column::RequestedScopes, Expr::value(scopes.clone()))
        .col_expr(user_apps::Column::Name, Expr::value(text(manifest, "name")));
    // `coalesce($icon, icon)`, `coalesce($category, category)`.
    if let Some(icon) = truthy("icon") {
        update = update.col_expr(user_apps::Column::Icon, Expr::value(icon));
    }
    if let Some(category) = truthy("category") {
        update = update.col_expr(user_apps::Column::Category, Expr::value(category));
    }
    update
        .col_expr(
            user_apps::Column::Description,
            Expr::value(as_text(or_app("description", "description"))),
        )
        .col_expr(
            user_apps::Column::WebsiteUrl,
            Expr::value(as_text(or_app("websiteUrl", "websiteUrl"))),
        )
        .col_expr(
            user_apps::Column::PrivacyUrl,
            Expr::value(as_text(or_app("privacyUrl", "privacyUrl"))),
        )
        .col_expr(
            user_apps::Column::Screenshots,
            Expr::value(Some(or_app("screenshots", "screenshots")).filter(|value| !value.is_null())),
        )
        .col_expr(
            user_apps::Column::WebhookUrl,
            Expr::value(as_text(or_app("webhookUrl", "webhookUrl"))),
        )
        .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
        .filter(user_apps::Column::Id.eq(app_id))
        .exec(master)
        .await?;
    let requested = string_list(Some(&scopes));
    let installs: Vec<(String, Option<Value>)> = user_app_installs::Entity::find()
        .select_only()
        .columns([
            user_app_installs::Column::Id,
            user_app_installs::Column::GrantedScopes,
        ])
        .filter(user_app_installs::Column::AppId.eq(app_id))
        .filter(user_app_installs::Column::Status.eq("active"))
        .into_tuple()
        .all(master)
        .await?;
    for (install_id, granted) in installs {
        let granted = string_list(granted.as_ref());
        let pending: Vec<&String> = requested
            .iter()
            .filter(|scope| !granted.contains(scope))
            .collect();
        if !pending.is_empty() {
            user_app_installs::Entity::update_many()
                .col_expr(user_app_installs::Column::PendingScopes, Expr::value(json!(pending)))
                .col_expr(user_app_installs::Column::UpdatedAt, Expr::value(now))
                .filter(user_app_installs::Column::Id.eq(install_id))
                .exec(master)
                .await?;
        }
    }
    Ok(())
}

/// `POST /:id/submit`: list the app publicly, after review (an official app
/// is approved at once, and its first-party installs adopted).
pub(crate) async fn submit(
    State(state): State<ExternalApiState>,
    developer: Developer,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = developer_gate(&developer) {
        return error.into_response();
    }
    let notes = match validated(&headers, &body, schemas::submit) {
        Ok(notes) => notes,
        Err(response) => return response,
    };
    respond(
        async {
            let app = developer.owned_app(&id).await?;
            let master = orm(&developer.master);
            let version: Option<String> = user_app_versions::Entity::find()
                .select_only()
                .column(user_app_versions::Column::Id)
                .filter(user_app_versions::Column::AppId.eq(id.as_str()))
                .into_tuple()
                .one(&master)
                .await
                .map_err(|error| db_error(&error))?;
            if version.is_none() {
                return Err(bad_request(
                    "Upload at least one version before submitting for review",
                ));
            }
            let official = text(&app, "publisherType") == "weldsuite";
            let notes_or_kept = notes
                .clone()
                .or_else(|| app.get("reviewNotes").and_then(Value::as_str).map(str::to_owned));
            let notes_patch = notes.filter(|text| !text.is_empty());
            // An official app is approved at once, by the caller; another
            // waits for review, keeping its notes unless the body has some.
            let now = now();
            let mut update = user_apps::Entity::update_many()
                .col_expr(user_apps::Column::Visibility, Expr::value("public"))
                .col_expr(
                    user_apps::Column::ReviewStatus,
                    Expr::value(if official { "approved" } else { "submitted" }),
                );
            if official {
                update = update
                    .col_expr(user_apps::Column::ReviewedBy, Expr::value(developer.actor()))
                    .col_expr(user_apps::Column::ReviewedAt, Expr::value(now))
                    .col_expr(user_apps::Column::ReviewNotes, Expr::value(notes_or_kept));
            } else if let Some(notes) = notes_patch {
                update = update.col_expr(user_apps::Column::ReviewNotes, Expr::value(notes));
            }
            let row = update
                .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
                .filter(user_apps::Column::Id.eq(id.as_str()))
                .exec_with_returning(&master)
                .await
                .map_err(|error| db_error(&error))?
                .into_iter()
                .next();
            let row = to_json(row.ok_or_else(|| internal_with("Failed to submit app"))?)?;
            if official {
                state.events.tracker().spawn(sweep_adopt_system_installs(
                    developer.master.clone(),
                    Arc::clone(&state.workspaces),
                    row.clone(),
                    developer.actor().to_owned(),
                ));
            }
            Ok(Json(json!({ "data": row })).into_response())
        }
        .await,
    )
}

// ── preview sessions ─────────────────────────────────────────────────────────

/// `PUT /:id/dev-session`: register or refresh a developer's preview URL.
pub(crate) async fn put_dev_session(
    developer: Developer,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = developer_gate(&developer) {
        return error.into_response();
    }
    let (url, body_user) = match validated(&headers, &body, schemas::dev_session_for) {
        Ok(read) => read,
        Err(response) => return response,
    };
    respond(
        async {
            let app = developer.owned_app(&id).await?;
            let Some(user_id) = developer.key.session.user_id.clone().or(body_user) else {
                return Err(bad_request(
                    "Pass userId (your Clerk user id) or use a personal API key. The platform iframe matches the preview to the signed-in user.",
                ));
            };
            if !is_allowed_dev_session_url(&url) {
                return Err(bad_request(
                    "Preview URL must be localhost, 127.0.0.1, a Cloudflare quick tunnel, ngrok, or pages.dev",
                ));
            }
            let now = now();
            let expires_at = now + DEV_SESSION_TTL;
            let app_id = text(&app, "id");
            let workspace_id = developer.key.session.workspace_id.as_str();
            let master = orm(&developer.master);
            let existing: Option<String> = user_app_dev_sessions::Entity::find()
                .select_only()
                .column(user_app_dev_sessions::Column::Id)
                .filter(user_app_dev_sessions::Column::AppId.eq(app_id))
                .filter(user_app_dev_sessions::Column::UserId.eq(user_id.as_str()))
                .filter(user_app_dev_sessions::Column::WorkspaceId.eq(workspace_id))
                .into_tuple()
                .one(&master)
                .await
                .map_err(|error| db_error(&error))?;
            let row = match existing {
                Some(existing) => user_app_dev_sessions::Entity::update_many()
                    .col_expr(user_app_dev_sessions::Column::Url, Expr::value(url.as_str()))
                    .col_expr(user_app_dev_sessions::Column::ExpiresAt, Expr::value(expires_at))
                    .col_expr(user_app_dev_sessions::Column::UpdatedAt, Expr::value(now))
                    .filter(user_app_dev_sessions::Column::Id.eq(existing))
                    .exec_with_returning(&master)
                    .await
                    .map(|rows| rows.into_iter().next()),
                None => user_app_dev_sessions::Entity::insert(user_app_dev_sessions::ActiveModel {
                    id: Set(generate_id("uads")),
                    app_id: Set(app_id.to_owned()),
                    workspace_id: Set(workspace_id.to_owned()),
                    user_id: Set(user_id),
                    url: Set(url),
                    expires_at: Set(expires_at),
                    created_at: Set(now),
                    updated_at: Set(now),
                })
                .exec_with_returning(&master)
                .await
                .map(Some)
                .or_else(|error| match error {
                    DbErr::RecordNotInserted => Ok(None),
                    error => Err(error),
                }),
            }
            .map_err(|error| db_error(&error))?;
            // `returning jsonb_build_object('url', url, 'expiresAt', expires_at)`.
            let row = row
                .map(|session| {
                    to_json(session).map(|session| {
                        json!({ "url": session["url"], "expiresAt": session["expiresAt"] })
                    })
                })
                .transpose()?;
            let row = row.ok_or_else(|| internal_with("Failed to save preview session"))?;
            Ok(Json(json!({ "data": row })).into_response())
        }
        .await,
    )
}

/// `DELETE /:id/dev-session`: the caller's preview (a workspace key names
/// the user in `?userId=`).
pub(crate) async fn delete_dev_session(
    developer: Developer,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            let query = query_values(raw.as_deref());
            // `session.userId ?? c.req.query('userId') ?? null`, then `if (!userId)`.
            let user_id = developer
                .key
                .session
                .user_id
                .clone()
                .or_else(|| {
                    query.get("userId").and_then(|value| match value {
                        Value::String(text) => Some(text.clone()),
                        Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
                        _ => None,
                    })
                })
                .filter(|user| !user.is_empty());
            let app = developer.owned_app(&id).await?;
            let Some(user_id) = user_id else {
                return Err(bad_request(
                    "Pass userId as a query param when using a workspace API key",
                ));
            };
            user_app_dev_sessions::Entity::delete_many()
                .filter(user_app_dev_sessions::Column::AppId.eq(text(&app, "id")))
                .filter(user_app_dev_sessions::Column::UserId.eq(user_id.as_str()))
                .filter(
                    user_app_dev_sessions::Column::WorkspaceId
                        .eq(developer.key.session.workspace_id.as_str()),
                )
                .exec(&orm(&developer.master))
                .await
                .map_err(|error| db_error(&error))?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

// ── OAuth client ─────────────────────────────────────────────────────────────

/// `GET /:id/oauth-client`: the client id (never the secret).
pub(crate) async fn oauth_client(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            developer.owned_app(&id).await?;
            let row: Option<OauthClient> = user_app_oauth_clients::Entity::find()
                .select_only()
                .columns([
                    user_app_oauth_clients::Column::ClientId,
                    user_app_oauth_clients::Column::CreatedAt,
                ])
                .filter(user_app_oauth_clients::Column::AppId.eq(id.as_str()))
                .into_model()
                .one(&orm(&developer.master))
                .await
                .map_err(|error| db_error(&error))?;
            let row = row.ok_or_else(|| not_found("OAuth client", &id))?;
            Ok(Json(json!({ "data": to_json(row)? })).into_response())
        }
        .await,
    )
}

/// `POST /:id/oauth-client`: create the client, or rotate its secret. The
/// secret is shown once.
pub(crate) async fn rotate_oauth_client(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            developer.owned_app(&id).await?;
            let secret = format!("wacs_{}", random_hex(20));
            let hash = sha256_hex(&secret);
            let now = now();
            let master = &orm(&developer.master);
            let existing: Option<(String, String)> = user_app_oauth_clients::Entity::find()
                .select_only()
                .columns([
                    user_app_oauth_clients::Column::Id,
                    user_app_oauth_clients::Column::ClientId,
                ])
                .filter(user_app_oauth_clients::Column::AppId.eq(id.as_str()))
                .into_tuple()
                .one(master)
                .await
                .map_err(|error| db_error(&error))?;
            if let Some((row_id, client_id)) = existing {
                user_app_oauth_clients::Entity::update_many()
                    .col_expr(
                        user_app_oauth_clients::Column::ClientSecretHash,
                        Expr::value(hash.as_str()),
                    )
                    .col_expr(user_app_oauth_clients::Column::UpdatedAt, Expr::value(now))
                    .filter(user_app_oauth_clients::Column::Id.eq(row_id))
                    .exec(master)
                    .await
                    .map_err(|error| db_error(&error))?;
                return Ok(Json(json!({ "data": { "clientId": client_id, "clientSecret": secret } })).into_response());
            }
            let client_id = format!("wac_{}", random_hex(12));
            user_app_oauth_clients::Entity::insert(user_app_oauth_clients::ActiveModel {
                id: Set(generate_id("uaoc")),
                app_id: Set(id.clone()),
                client_id: Set(client_id.clone()),
                client_secret_hash: Set(hash),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(master)
            .await
            .map_err(|error| db_error(&error))?;
            Ok((
                StatusCode::CREATED,
                Json(json!({ "data": { "clientId": client_id, "clientSecret": secret } })),
            )
                .into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_paths_are_sanitized() {
        assert_eq!(
            sanitize_bundle_path("index.html").as_deref(),
            Some("index.html")
        );
        assert_eq!(
            sanitize_bundle_path("./assets/a.js").as_deref(),
            Some("assets/a.js")
        );
        assert_eq!(sanitize_bundle_path("/a/b.css").as_deref(), Some("a/b.css"));
        assert_eq!(sanitize_bundle_path("a\\b.css").as_deref(), Some("a/b.css"));
        assert_eq!(sanitize_bundle_path("../x"), None);
        assert_eq!(sanitize_bundle_path("a//b"), None);
        assert_eq!(sanitize_bundle_path(""), None);
        assert_eq!(sanitize_bundle_path(".hidden").as_deref(), Some(".hidden"));
    }

    #[test]
    fn official_publishers_come_from_the_setting() {
        assert!(is_official_publisher(Some("ws_a, ws_b"), "ws_b"));
        assert!(!is_official_publisher(Some(""), "ws_b"));
        assert!(!is_official_publisher(None, "ws_b"));
    }

    #[test]
    fn content_types_by_extension() {
        assert_eq!(content_type_for("a/B.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("noext"), "application/octet-stream");
    }
}
