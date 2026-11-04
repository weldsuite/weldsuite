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
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_apps_domain::adopt::sweep_adopt_system_installs;
use weldsuite_apps_domain::schemas;
use weldsuite_apps_domain::scopes::{
    is_allowed_dev_session_url, is_reserved, random_hex, sha256_hex,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::ApiError;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_ports::{DynFileStore, PutOptions, StorageBuckets};

use crate::session::{
    Key, KeyType, bad_request, conflict, database_error, forbidden, internal_with, not_found,
};
use crate::{ExternalApiState, master_db};

/// A `user_apps` row as JSON, `price_monthly` as Drizzle reads `numeric`.
macro_rules! app_json {
    () => {
        "to_jsonb(a) || jsonb_build_object('price_monthly', a.price_monthly::text)"
    };
}

const MAX_BUNDLE_FILES: usize = 500;
const MAX_BUNDLE_BYTES: usize = 50 * 1024 * 1024;
/// `DEV_SESSION_TTL_MS`.
const DEV_SESSION_TTL: time::Duration = time::Duration::minutes(5);

fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

fn db_error(error: &sqlx::Error) -> ApiError {
    database_error(error)
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
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            app_json!(),
            " from user_apps a where a.id = $1 and a.owner_workspace_id = $2 and a.deleted_at is null limit 1"
        ))
        .bind(id)
        .bind(&self.key.session.workspace_id)
        .fetch_optional(&self.master)
        .await
        .map_err(|error| db_error(&error))?;
        row.map(js_row).ok_or_else(|| not_found("App", id))
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
    let rows: Result<Vec<ToolRow>, sqlx::Error> = sqlx::query_as(
        "select a.code, a.name, a.manifest, i.granted_scopes
           from user_app_installs i
           join user_apps a on a.id = i.app_id
          where i.workspace_id = $1 and i.status = 'active' and a.is_active = true
            and a.deleted_at is null and ($2::text is null or i.app_id = $2)",
    )
    .bind(&key.session.workspace_id)
    .bind(app_id)
    .fetch_all(&master)
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
            let taken: Option<String> = sqlx::query_scalar("select id from user_apps where code = $1 limit 1")
                .bind(&body.code)
                .fetch_optional(&developer.master)
                .await
                .map_err(|error| db_error(&error))?;
            if taken.is_some() {
                return Err(conflict(format!("App code '{}' is already taken", body.code)));
            }
            let truthy = |value: Option<String>| value.filter(|text| !text.is_empty());
            let now = now();
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "insert into user_apps as a
                   (id, code, name, description, icon, category, website_url, privacy_url, screenshots,
                    webhook_url, owner_workspace_id, created_by, publisher_type, created_at, updated_at)
                 values ($1, $2, $3, $4, coalesce($5, 'Puzzle'), coalesce($6, 'Productivity'), $7, $8,
                         coalesce($9::jsonb, '[]'::jsonb), $10, $11, $12, $13, $14::timestamptz, $14::timestamptz)
                 returning ",
                app_json!()
            ))
            .bind(generate_id("uapp"))
            .bind(&body.code)
            .bind(&body.name)
            .bind(body.description)
            .bind(truthy(body.icon))
            .bind(truthy(body.category))
            .bind(truthy(body.website_url))
            .bind(truthy(body.privacy_url))
            .bind(body.screenshots.map(|shots| json!(shots)))
            .bind(truthy(body.webhook_url))
            .bind(&developer.key.session.workspace_id)
            .bind(developer.actor())
            .bind(if official { "weldsuite" } else { "community" })
            .bind(&now)
            .fetch_optional(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            let row = row.ok_or_else(|| internal_with("Failed to create app"))?;
            Ok((StatusCode::CREATED, Json(json!({ "data": js_row(row) }))).into_response())
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
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a where a.owner_workspace_id = $1 and a.deleted_at is null
                  order by a.created_at desc, a.id desc"
            ))
            .bind(&developer.key.session.workspace_id)
            .fetch_all(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            Ok(whole_list(
                &rows.into_iter().map(js_row).collect::<Vec<_>>(),
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
            let set = |field: &weldsuite_kit::validation::Field<String>| -> (bool, Option<String>) {
                match field {
                    weldsuite_kit::validation::Field::Absent => (false, None),
                    weldsuite_kit::validation::Field::Null => (true, None),
                    weldsuite_kit::validation::Field::Set(value) => (true, Some(value.clone())),
                }
            };
            let (name_set, name) = set(&body.name);
            let (description_set, description) = set(&body.description);
            let (icon_set, icon) = set(&body.icon);
            let (category_set, category) = set(&body.category);
            let (website_set, website) = set(&body.website_url);
            let (privacy_set, privacy) = set(&body.privacy_url);
            let (webhook_set, webhook) = set(&body.webhook_url);
            let is_active = body.is_active.as_set().copied();
            let screenshots = body.screenshots.as_set().map(|shots| json!(shots));
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "update user_apps as a set
                   name = case when $2 then $3 else a.name end,
                   description = case when $4 then $5 else a.description end,
                   icon = case when $6 then $7 else a.icon end,
                   category = case when $8 then $9 else a.category end,
                   is_active = coalesce($10, a.is_active),
                   website_url = case when $11 then $12 else a.website_url end,
                   privacy_url = case when $13 then $14 else a.privacy_url end,
                   screenshots = case when $15::jsonb is null then a.screenshots else $15::jsonb end,
                   webhook_url = case when $16 then $17 else a.webhook_url end,
                   updated_at = $18::timestamptz
                 where a.id = $1
                 returning ",
                app_json!()
            ))
            .bind(&id)
            .bind(name_set)
            .bind(name)
            .bind(description_set)
            .bind(description)
            .bind(icon_set)
            .bind(icon)
            .bind(category_set)
            .bind(category)
            .bind(is_active)
            .bind(website_set)
            .bind(website)
            .bind(privacy_set)
            .bind(privacy)
            .bind(screenshots)
            .bind(webhook_set)
            .bind(webhook)
            .bind(now())
            .fetch_optional(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            let row = row.ok_or_else(|| internal_with("Failed to update app"))?;
            Ok(Json(json!({ "data": js_row(row) })).into_response())
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
            let workspace_id = &developer.key.session.workspace_id;
            let foreign: i64 = sqlx::query_scalar(
                "select count(*) from user_app_installs
                  where app_id = $1 and status = 'active' and workspace_id <> $2",
            )
            .bind(&id)
            .bind(workspace_id)
            .fetch_one(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            if foreign > 0 {
                return Err(conflict("App is still installed in other workspaces"));
            }
            let now = now();
            let master = &developer.master;
            for statement in [
                "update user_apps set deleted_at = $2::timestamptz, is_active = false, updated_at = $2::timestamptz where id = $1",
                "update user_app_installs set status = 'revoked', revoked_at = $2::timestamptz, updated_at = $2::timestamptz
                  where app_id = $1 and status = 'active'",
                "update user_app_tokens set revoked_at = $2::timestamptz where app_id = $1 and revoked_at is null",
            ] {
                sqlx::query(statement)
                    .bind(&id)
                    .bind(&now)
                    .execute(master)
                    .await
                    .map_err(|error| db_error(&error))?;
            }
            sqlx::query(
                "update workspace_installed_apps set deleted_at = $2::timestamptz, is_active = false, updated_at = $2::timestamptz
                  where user_app_id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(&now)
            .execute(&developer.key.db)
            .await
            .map_err(|error| db_error(&error))?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

// ── versions ─────────────────────────────────────────────────────────────────

/// `GET /:id/versions`.
pub(crate) async fn versions(developer: Developer, Path(id): Path<String>) -> Response {
    respond(
        async {
            developer_gate(&developer)?;
            developer.owned_app(&id).await?;
            let rows: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(v) from user_app_versions v where v.app_id = $1
                  order by v.created_at desc, v.id desc",
            )
            .bind(&id)
            .fetch_all(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            Ok(whole_list(
                &rows.into_iter().map(js_row).collect::<Vec<_>>(),
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
    let master = &developer.master;
    let dupe: Option<String> = sqlx::query_scalar(
        "select id from user_app_versions where app_id = $1 and version = $2 limit 1",
    )
    .bind(&id)
    .bind(&version)
    .fetch_optional(master)
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
    let row: Option<Value> = sqlx::query_scalar(
        "insert into user_app_versions as v
           (id, app_id, version, manifest, requested_scopes, bundle_key, entrypoint, bundle_size,
            file_count, status, changelog, created_by, published_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz)
         returning to_jsonb(v)",
    )
    .bind(&version_id)
    .bind(&id)
    .bind(&version)
    .bind(manifest)
    .bind(&scopes)
    .bind(&bundle_key)
    .bind(&entrypoint)
    .bind(i64::try_from(upload.total_bytes).unwrap_or(i64::MAX))
    .bind(i64::try_from(file_count).unwrap_or(i64::MAX))
    .bind(if publish_now { "published" } else { "draft" })
    .bind(upload.changelog)
    .bind(developer.actor())
    .bind(publish_now.then(|| now.clone()))
    .bind(&now)
    .fetch_optional(master)
    .await
    .map_err(|error| db_error(&error))?;
    let row = row.ok_or_else(|| internal_with("Failed to create version"))?;
    if publish_now {
        publish_live(master, &app, manifest, &version_id, &now)
            .await
            .map_err(|error| db_error(&error))?;
    } else {
        sqlx::query("update user_apps set review_status = 'submitted', updated_at = $2::timestamptz where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(master)
            .await
            .map_err(|error| db_error(&error))?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "data": js_row(row) }))).into_response())
}

/// `publishVersionLive`: supersede the other published versions, roll the
/// app forward onto the manifest, and flag the new scopes on every active
/// install for re-consent.
async fn publish_live(
    master: &PgPool,
    app: &Value,
    manifest: &Value,
    version_id: &str,
    now: &str,
) -> Result<(), sqlx::Error> {
    let app_id = text(app, "id");
    sqlx::query(
        "update user_app_versions set status = 'superseded'
          where app_id = $1 and status = 'published' and id <> $2",
    )
    .bind(app_id)
    .bind(version_id)
    .execute(master)
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
    sqlx::query(
        "update user_apps set
           current_version_id = $2, manifest = $3, requested_scopes = $4, name = $5,
           icon = coalesce($6, icon), category = coalesce($7, category),
           description = $8, website_url = $9, privacy_url = $10, screenshots = $11::jsonb,
           webhook_url = $12, updated_at = $13::timestamptz
         where id = $1",
    )
    .bind(app_id)
    .bind(version_id)
    .bind(manifest)
    .bind(&scopes)
    .bind(text(manifest, "name"))
    .bind(truthy("icon"))
    .bind(truthy("category"))
    .bind(as_text(or_app("description", "description")))
    .bind(as_text(or_app("websiteUrl", "websiteUrl")))
    .bind(as_text(or_app("privacyUrl", "privacyUrl")))
    .bind(Some(or_app("screenshots", "screenshots")).filter(|value| !value.is_null()))
    .bind(as_text(or_app("webhookUrl", "webhookUrl")))
    .bind(now)
    .execute(master)
    .await?;
    let requested = string_list(Some(&scopes));
    let installs: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, granted_scopes from user_app_installs where app_id = $1 and status = 'active'",
    )
    .bind(app_id)
    .fetch_all(master)
    .await?;
    for (install_id, granted) in installs {
        let granted = string_list(granted.as_ref());
        let pending: Vec<&String> = requested
            .iter()
            .filter(|scope| !granted.contains(scope))
            .collect();
        if !pending.is_empty() {
            sqlx::query(
                "update user_app_installs set pending_scopes = $2, updated_at = $3::timestamptz where id = $1",
            )
            .bind(&install_id)
            .bind(json!(pending))
            .bind(now)
            .execute(master)
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
            let version: Option<String> =
                sqlx::query_scalar("select id from user_app_versions where app_id = $1 limit 1")
                    .bind(&id)
                    .fetch_optional(&developer.master)
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
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "update user_apps as a set
                   visibility = 'public',
                   review_status = case when $2 then 'approved' else 'submitted' end,
                   reviewed_by = case when $2 then $3 else a.reviewed_by end,
                   reviewed_at = case when $2 then $4::timestamptz else a.reviewed_at end,
                   review_notes = case when $2 then $5 when $6::text is not null then $6 else a.review_notes end,
                   updated_at = $4::timestamptz
                 where a.id = $1
                 returning ",
                app_json!()
            ))
            .bind(&id)
            .bind(official)
            .bind(developer.actor())
            .bind(now())
            .bind(notes_or_kept)
            .bind(notes_patch)
            .fetch_optional(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            let row = js_row(row.ok_or_else(|| internal_with("Failed to submit app"))?);
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
            let now_at = OffsetDateTime::now_utc();
            let now = iso_timestamp(now_at);
            let expires_at = iso_timestamp(now_at + DEV_SESSION_TTL);
            let app_id = text(&app, "id");
            let workspace_id = &developer.key.session.workspace_id;
            let existing: Option<String> = sqlx::query_scalar(
                "select id from user_app_dev_sessions where app_id = $1 and user_id = $2 and workspace_id = $3 limit 1",
            )
            .bind(app_id)
            .bind(&user_id)
            .bind(workspace_id)
            .fetch_optional(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            let row: Option<Value> = match existing {
                Some(existing) => sqlx::query_scalar(
                    "update user_app_dev_sessions set url = $2, expires_at = $3::timestamptz, updated_at = $4::timestamptz
                      where id = $1
                     returning jsonb_build_object('url', url, 'expiresAt', expires_at)",
                )
                .bind(existing)
                .bind(&url)
                .bind(&expires_at)
                .bind(&now)
                .fetch_optional(&developer.master)
                .await,
                None => sqlx::query_scalar(
                    "insert into user_app_dev_sessions
                       (id, app_id, workspace_id, user_id, url, expires_at, created_at, updated_at)
                     values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $7::timestamptz)
                     returning jsonb_build_object('url', url, 'expiresAt', expires_at)",
                )
                .bind(generate_id("uads"))
                .bind(app_id)
                .bind(workspace_id)
                .bind(&user_id)
                .bind(&url)
                .bind(&expires_at)
                .bind(&now)
                .fetch_optional(&developer.master)
                .await,
            }
            .map_err(|error| db_error(&error))?;
            let row = row.ok_or_else(|| internal_with("Failed to save preview session"))?;
            Ok(Json(json!({ "data": js_row(row) })).into_response())
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
            sqlx::query(
                "delete from user_app_dev_sessions where app_id = $1 and user_id = $2 and workspace_id = $3",
            )
            .bind(text(&app, "id"))
            .bind(&user_id)
            .bind(&developer.key.session.workspace_id)
            .execute(&developer.master)
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
            let row: Option<Value> = sqlx::query_scalar(
                "select jsonb_build_object('clientId', client_id, 'createdAt', created_at)
                   from user_app_oauth_clients where app_id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(&developer.master)
            .await
            .map_err(|error| db_error(&error))?;
            let row = row.ok_or_else(|| not_found("OAuth client", &id))?;
            Ok(Json(json!({ "data": js_row(row) })).into_response())
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
            let master = &developer.master;
            let existing: Option<(String, String)> =
                sqlx::query_as("select id, client_id from user_app_oauth_clients where app_id = $1 limit 1")
                    .bind(&id)
                    .fetch_optional(master)
                    .await
                    .map_err(|error| db_error(&error))?;
            if let Some((row_id, client_id)) = existing {
                sqlx::query(
                    "update user_app_oauth_clients set client_secret_hash = $2, updated_at = $3::timestamptz where id = $1",
                )
                .bind(&row_id)
                .bind(&hash)
                .bind(&now)
                .execute(master)
                .await
                .map_err(|error| db_error(&error))?;
                return Ok(Json(json!({ "data": { "clientId": client_id, "clientSecret": secret } })).into_response());
            }
            let client_id = format!("wac_{}", random_hex(12));
            sqlx::query(
                "insert into user_app_oauth_clients (id, app_id, client_id, client_secret_hash, created_at, updated_at)
                 values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)",
            )
            .bind(generate_id("uaoc"))
            .bind(&id)
            .bind(&client_id)
            .bind(&hash)
            .bind(&now)
            .execute(master)
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
