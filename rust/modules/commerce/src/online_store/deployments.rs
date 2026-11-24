//! Static deployments of a shop the merchant builds (storefronts plan,
//! phase 6): the files of a built site (a Vite or Astro `dist/`), uploaded
//! as one multipart request, stored in the public bucket under
//! `storefront-deployments/<workspace>/<deployment>/`, and served by the
//! storefront edge once promoted. Every deployment also gets a preview
//! address, `<deployment>--<shop>.<base domain>`.
//!
//! Staff routes (`/api/online-store/sites/:id/deployments`):
//!
//!   GET    /                       → newest first
//!   POST   /                       multipart: `files` (filename = path), optional `config`
//!   POST   /:deploymentId/promote  → live
//!   DELETE /:deploymentId          → 204 (not the live one)
//!
//! For CI, the same upload with a channel's deploy key (`wcd_…`, ADR
//! COM-011's key registry): `POST /storefront-deploy/v1/deployments[?production=true]`
//! ([`deploy_router`]).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::{HeaderMap, StatusCode, header};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    STOREFRONT_DEPLOYMENT_CREATED, STOREFRONT_DEPLOYMENT_DELETED, STOREFRONT_DEPLOYMENT_PROMOTED,
};
use weldsuite_catalogs::permission_keys::{WEBSITES_MANAGE, WEBSITES_READ, WEBSITES_UPDATE};
use weldsuite_db::{Workspaces, orm, utc_now};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynFileStore, PutOptions, is_safe_key};
use weldsuite_schema::master::storefront_key_registry;
use weldsuite_schema::tenant::{storefront_deployments, storefront_sites};

use super::config::OnlineStoreConfig;
use super::document::{is_redirect_source, is_redirect_target};
use super::registry::{self, SiteMirror};
use super::sites::load_site;
use super::{conflict, failed, invalid, invalid_field, iso, not_found, unavailable};
use crate::{Caller, CommerceState};

/// Files in one deployment.
pub(crate) const MAX_FILES: usize = 2000;
/// Bytes in one deployment.
pub(crate) const MAX_BYTES: usize = 200 * 1024 * 1024;
/// Bytes in one file.
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
/// The manifest's key under a deployment's prefix; uploads can't use it.
pub(crate) const MANIFEST: &str = ".weldstorefront-manifest.json";
/// Deployments listed at most.
const LIST: u64 = 50;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/sites/{id}/deployments",
            get(list).route_layer(gate.require([WEBSITES_READ])),
        )
        .route(
            "/sites/{id}/deployments",
            post(upload)
                .route_layer(gate.require([WEBSITES_UPDATE]))
                .layer(DefaultBodyLimit::max(MAX_BYTES + 1024 * 1024)),
        )
        .route(
            "/sites/{id}/deployments/{deployment_id}/promote",
            post(promote).route_layer(gate.require([WEBSITES_MANAGE])),
        )
        .route(
            "/sites/{id}/deployments/{deployment_id}",
            delete(remove).route_layer(gate.require([WEBSITES_MANAGE])),
        )
}

/// The prefix of a deployment's files.
pub(crate) fn prefix(workspace_id: &str, deployment_id: &str) -> String {
    format!("storefront-deployments/{workspace_id}/{deployment_id}/")
}

/// A deployment's preview host: `sfd-…--<label>.<base>`.
pub(crate) fn preview_host(deployment_id: &str, free_host: &str) -> String {
    let (label, rest) = free_host.split_once('.').unwrap_or((free_host, ""));
    format!("{}--{label}.{rest}", deployment_id.replace('_', "-"))
}

/// The deployment id and the shop's own host a preview host names.
pub(crate) fn parse_preview_host(host: &str) -> Option<(String, String)> {
    let (first, rest) = host.split_once('.')?;
    let (deployment, label) = first.split_once("--")?;
    let id = deployment.strip_prefix("sfd-")?;
    if id.is_empty() || label.is_empty() {
        return None;
    }
    Some((format!("sfd_{id}"), format!("{label}.{rest}")))
}

/// The content type of a file, by its extension.
pub(crate) fn content_type(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// A file's path in a deployment: relative, safe, no hidden files but
/// `.well-known/`.
pub(crate) fn clean_path(raw: &str) -> Option<String> {
    let path = raw.trim().replace('\\', "/");
    let path = path.trim_start_matches("./").trim_start_matches('/');
    let path = path.strip_prefix("dist/").unwrap_or(path);
    if path.is_empty() || path.len() > 500 || !is_safe_key(path) || path == MANIFEST {
        return None;
    }
    let hidden = path
        .split('/')
        .any(|segment| segment.starts_with('.') && segment != ".well-known");
    (!hidden && !path.chars().any(char::is_control)).then(|| path.to_owned())
}

/// Headers a deployment may set; the edge keeps the rest its own.
const SETTABLE_HEADERS: [&str; 9] = [
    "cache-control",
    "content-security-policy",
    "permissions-policy",
    "referrer-policy",
    "x-frame-options",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    "access-control-allow-origin",
];

/// `weldstorefront.json`, checked: `spa`, `cleanUrls`, `redirects`,
/// `headers`.
pub(crate) fn check_config(config: &Value) -> Result<Value, Vec<(String, String)>> {
    let mut problems = Vec::new();
    let Some(object) = config.as_object() else {
        return Err(vec![(
            "config".to_owned(),
            "Must be a JSON object".to_owned(),
        )]);
    };
    let mut out = Map::new();
    for (key, value) in object {
        match key.as_str() {
            "$schema" => {}
            "spa" | "cleanUrls" => match value {
                Value::Bool(_) => {
                    out.insert(key.clone(), value.clone());
                }
                _ => problems.push((format!("config.{key}"), "Must be true or false".to_owned())),
            },
            "redirects" => match value.as_array() {
                Some(list) if list.len() <= 200 => {
                    for (i, redirect) in list.iter().enumerate() {
                        let from = redirect["from"].as_str().unwrap_or_default();
                        let to = redirect["to"].as_str().unwrap_or_default();
                        let status = redirect
                            .get("status")
                            .and_then(Value::as_u64)
                            .unwrap_or(301);
                        if !is_redirect_source(from)
                            || !is_redirect_target(to)
                            || !matches!(status, 301 | 302 | 307 | 308)
                        {
                            problems.push((format!("config.redirects[{i}]"), "{ from: \"/path\", to: \"/path or https://…\", status?: 301 | 302 | 307 | 308 }".to_owned()));
                        }
                    }
                    out.insert(key.clone(), value.clone());
                }
                _ => problems.push((
                    "config.redirects".to_owned(),
                    "At most 200 redirects".to_owned(),
                )),
            },
            "headers" => match value.as_array() {
                Some(list) if list.len() <= 50 => {
                    for (i, rule) in list.iter().enumerate() {
                        let source_ok = rule["source"]
                            .as_str()
                            .is_some_and(|s| s.starts_with('/') && s.len() <= 300);
                        let headers_ok = rule["headers"].as_object().is_some_and(|h| {
                            h.len() <= 20
                                && h.iter().all(|(name, value)| {
                                    SETTABLE_HEADERS.contains(&name.to_ascii_lowercase().as_str())
                                        && value.as_str().is_some_and(|v| {
                                            v.len() <= 2000 && !v.contains(['\r', '\n'])
                                        })
                                })
                        });
                        if !source_ok || !headers_ok {
                            problems.push((
                                format!("config.headers[{i}]"),
                                format!("{{ source: \"/path or /prefix/*\", headers: {{…}} }} with only: {}", SETTABLE_HEADERS.join(", ")),
                            ));
                        }
                    }
                    out.insert(key.clone(), value.clone());
                }
                _ => problems.push((
                    "config.headers".to_owned(),
                    "At most 50 header rules".to_owned(),
                )),
            },
            other => problems.push((format!("config.{other}"), "Unknown field".to_owned())),
        }
    }
    if problems.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(problems)
    }
}

fn present(
    config: &OnlineStoreConfig,
    deployment: &storefront_deployments::Model,
    live: Option<&str>,
    free_host: Option<&str>,
) -> Value {
    json!({
        "id": deployment.id,
        "siteId": deployment.site_id,
        "status": deployment.status,
        "fileCount": deployment.file_count,
        "totalBytes": deployment.total_bytes,
        "isProduction": live == Some(deployment.id.as_str()),
        "previewUrl": free_host.filter(|_| deployment.status == "ready")
            .map(|host| config.origin(&preview_host(&deployment.id, host))),
        "createdAt": iso(deployment.created_at),
        "promotedAt": deployment.promoted_at.map(iso),
        "createdByUserId": deployment.created_by,
        "createdByKeyId": deployment.created_by_key_id,
        "error": deployment.error,
    })
}

/// The site's free address, for preview URLs.
async fn free_host(master: Option<&PgPool>, workspace_id: &str, site_id: &str) -> Option<String> {
    let master = master?;
    registry::site_hosts(master, workspace_id, site_id)
        .await
        .ok()?
        .into_iter()
        .find(|h| h.kind == "subdomain" && h.status == "active")
        .map(|h| h.hostname)
}

async fn list(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to fetch the deployments";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let rows = storefront_deployments::Entity::find()
        .filter(storefront_deployments::Column::SiteId.eq(site.id.clone()))
        .filter(storefront_deployments::Column::DeletedAt.is_null())
        .order_by_desc(storefront_deployments::Column::CreatedAt)
        .limit(LIST)
        .all(&db)
        .await;
    let host = free_host(caller.registry.as_ref(), &caller.workspace_id, &site.id).await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.iter()
                .map(|d| {
                    present(
                        &state.online_store,
                        d,
                        site.active_deployment_id.as_deref(),
                        host.as_deref(),
                    )
                })
                .collect(),
        ))
        .into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

/// Who uploads: a member or a deploy key.
struct Uploader {
    user_id: Option<String>,
    key_id: Option<String>,
}

/// One upload, read: the files by path, the config.
struct Upload {
    files: BTreeMap<String, Vec<u8>>,
    config: Value,
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn read_upload(mut multipart: Multipart) -> Result<Upload, Response> {
    let mut files = BTreeMap::new();
    let mut config = Value::Object(Map::new());
    let mut total = 0_usize;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                return Err(invalid_field(
                    "files",
                    &format!("The upload could not be read: {error}"),
                ));
            }
        };
        let name = field.name().unwrap_or_default().to_owned();
        let filename = field.file_name().map(str::to_owned);
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(invalid_field(
                    "files",
                    &format!("The upload could not be read: {error}"),
                ));
            }
        };
        match name.as_str() {
            "config" => {
                config = serde_json::from_slice(&bytes)
                    .map_err(|_| invalid_field("config", "weldstorefront.json must be JSON"))?;
            }
            "files" | "file" => {
                let raw = filename.unwrap_or_default();
                let Some(path) = clean_path(&raw) else {
                    return Err(invalid_field(
                        "files",
                        &format!("Not an allowed file path: {raw}"),
                    ));
                };
                if bytes.len() > MAX_FILE_BYTES {
                    return Err(invalid_field(
                        "files",
                        &format!("{path} is larger than 25 MiB"),
                    ));
                }
                total += bytes.len();
                if total > MAX_BYTES {
                    return Err(invalid_field("files", "A deployment is at most 200 MiB"));
                }
                if files.insert(path.clone(), bytes.to_vec()).is_some() {
                    return Err(invalid_field(
                        "files",
                        &format!("{path} is in the upload twice"),
                    ));
                }
                if files.len() > MAX_FILES {
                    return Err(invalid_field(
                        "files",
                        &format!("A deployment has at most {MAX_FILES} files"),
                    ));
                }
            }
            _ => {}
        }
    }
    if files.is_empty() {
        return Err(invalid_field("files", "Upload at least one file"));
    }
    if !files.contains_key("index.html") {
        return Err(invalid_field(
            "files",
            "A deployment needs an index.html at its root",
        ));
    }
    Ok(Upload { files, config })
}

/// Stores the files and the manifest, and records the deployment.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn store(
    files_store: &Arc<dyn DynFileStore>,
    db: &DatabaseConnection,
    workspace_id: &str,
    site: &storefront_sites::Model,
    upload: Upload,
    uploader: &Uploader,
) -> Result<storefront_deployments::Model, Response> {
    const FAILED: &str = "Failed to store the deployment";
    let config = check_config(&upload.config).map_err(|problems| invalid(&problems))?;
    let now = utc_now();
    let id = generate_id("sfd");
    let total: usize = upload.files.values().map(Vec::len).sum();
    let row = storefront_deployments::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        site_id: Set(site.id.clone()),
        channel_id: Set(site.channel_id.clone()),
        status: Set("uploading".to_owned()),
        file_count: Set(i32::try_from(upload.files.len()).unwrap_or(i32::MAX)),
        total_bytes: Set(i64::try_from(total).unwrap_or(i64::MAX)),
        config: Set(config.clone()),
        manifest: Set(json!({})),
        error: Set(None),
        created_by: Set(uploader.user_id.clone()),
        created_by_key_id: Set(uploader.key_id.clone()),
        promoted_at: Set(None),
    };
    storefront_deployments::Entity::insert(row)
        .exec_without_returning(db)
        .await
        .map_err(|error| failed(&error, FAILED))?;
    let base = prefix(workspace_id, &id);
    let mut manifest = Map::new();
    let mut problem: Option<String> = None;
    for (path, bytes) in upload.files {
        let etag = hex::encode(&Sha256::digest(&bytes)[..8]);
        let options = PutOptions {
            content_type: Some(content_type(&path).to_owned()),
            ..PutOptions::default()
        };
        let file_size = bytes.len();
        if let Err(error) = files_store
            .put_boxed(&format!("{base}{path}"), bytes, &options)
            .await
        {
            problem = Some(format!("{path}: {error}"));
            break;
        }
        manifest.insert(path, json!({ "size": file_size, "etag": etag }));
    }
    let manifest = json!({
        "siteId": site.id,
        "workspaceId": workspace_id,
        "config": config,
        "files": manifest,
    });
    if problem.is_none() {
        let options = PutOptions {
            content_type: Some("application/json".to_owned()),
            ..PutOptions::default()
        };
        if let Err(error) = files_store
            .put_boxed(
                &format!("{base}{MANIFEST}"),
                manifest.to_string().into_bytes(),
                &options,
            )
            .await
        {
            problem = Some(format!("manifest: {error}"));
        }
    }
    let (status, error) = match &problem {
        Some(problem) => ("failed", Some(problem.clone())),
        None => ("ready", None),
    };
    let saved = storefront_deployments::Entity::update(storefront_deployments::ActiveModel {
        id: Set(id.clone()),
        status: Set(status.to_owned()),
        manifest: Set(manifest["files"].clone()),
        error: Set(error),
        updated_at: Set(utc_now()),
        ..Default::default()
    })
    .exec(db)
    .await
    .map_err(|error| failed(&error, FAILED))?;
    if let Some(problem) = problem {
        tracing::error!(%problem, deployment = %id, "[online-store] a deployment's files were not stored");
        return Err(failed(
            &problem,
            "The deployment's files could not be stored",
        ));
    }
    Ok(saved)
}

async fn upload(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    const FAILED: &str = "Failed to upload the deployment";
    let Some(files_store) = state.online_store.files.clone() else {
        return unavailable("Static hosting needs the public bucket (S3_BUCKET_PUBLIC)");
    };
    let multipart = match Multipart::from_request(request, &()).await {
        Ok(multipart) => multipart,
        Err(rejection) => {
            return invalid_field("body", &format!("Send multipart/form-data: {rejection}"));
        }
    };
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let upload = match read_upload(multipart).await {
        Ok(upload) => upload,
        Err(response) => return response,
    };
    let uploader = Uploader {
        user_id: Some(caller.user_id.clone()),
        key_id: None,
    };
    let deployment = match store(
        &files_store,
        &db,
        &caller.workspace_id,
        &site,
        upload,
        &uploader,
    )
    .await
    {
        Ok(deployment) => deployment,
        Err(response) => return response,
    };
    let host = free_host(caller.registry.as_ref(), &caller.workspace_id, &site.id).await;
    let value = present(
        &state.online_store,
        &deployment,
        site.active_deployment_id.as_deref(),
        host.as_deref(),
    );
    caller.publish(
        &state,
        STOREFRONT_DEPLOYMENT_CREATED,
        &deployment.id,
        &value,
    );
    Created(value).into_response()
}

/// Makes `deployment` the site's live one.
async fn make_live(
    db: &DatabaseConnection,
    site: &storefront_sites::Model,
    deployment_id: &str,
) -> Result<(storefront_sites::Model, storefront_deployments::Model), DbErr> {
    let now = utc_now();
    let deployment = storefront_deployments::Entity::update(storefront_deployments::ActiveModel {
        id: Set(deployment_id.to_owned()),
        promoted_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(db)
    .await?;
    let site = storefront_sites::Entity::update(storefront_sites::ActiveModel {
        id: Set(site.id.clone()),
        active_deployment_id: Set(Some(deployment_id.to_owned())),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(db)
    .await?;
    Ok((site, deployment))
}

async fn find_deployment(
    db: &DatabaseConnection,
    site_id: &str,
    deployment_id: &str,
) -> Result<Option<storefront_deployments::Model>, DbErr> {
    storefront_deployments::Entity::find_by_id(deployment_id.to_owned())
        .filter(storefront_deployments::Column::SiteId.eq(site_id))
        .filter(storefront_deployments::Column::DeletedAt.is_null())
        .one(db)
        .await
}

async fn promote(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, deployment_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to promote the deployment";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    if site.mode != "static" {
        return conflict(
            "NOT_A_STATIC_SITE",
            "Switch the shop to hosting your own code first",
            None,
        );
    }
    match find_deployment(&db, &site.id, &deployment_id).await {
        Ok(Some(deployment)) if deployment.status == "ready" => {}
        Ok(Some(_)) => {
            return conflict(
                "DEPLOYMENT_NOT_READY",
                "Only a complete deployment can go live",
                None,
            );
        }
        Ok(None) => return not_found("Deployment", &deployment_id),
        Err(error) => return failed(&error, FAILED),
    }
    let (site, deployment) = match make_live(&db, &site, &deployment_id).await {
        Ok(done) => done,
        Err(error) => return failed(&error, FAILED),
    };
    super::sites::mirror(&state, &caller, &site).await;
    let host = free_host(caller.registry.as_ref(), &caller.workspace_id, &site.id).await;
    let value = present(
        &state.online_store,
        &deployment,
        site.active_deployment_id.as_deref(),
        host.as_deref(),
    );
    caller.publish(
        &state,
        STOREFRONT_DEPLOYMENT_PROMOTED,
        &deployment.id,
        &value,
    );
    Data(value).into_response()
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, deployment_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete the deployment";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    if site.active_deployment_id.as_deref() == Some(deployment_id.as_str()) {
        return conflict(
            "DEPLOYMENT_LIVE",
            "Promote another deployment before deleting the live one",
            None,
        );
    }
    let deployment = match find_deployment(&db, &site.id, &deployment_id).await {
        Ok(Some(deployment)) => deployment,
        Ok(None) => return not_found("Deployment", &deployment_id),
        Err(error) => return failed(&error, FAILED),
    };
    if let Some(files_store) = &state.online_store.files {
        let base = prefix(&caller.workspace_id, &deployment.id);
        let mut keys: Vec<String> = deployment
            .manifest
            .as_object()
            .map(|files| files.keys().map(|path| format!("{base}{path}")).collect())
            .unwrap_or_default();
        keys.push(format!("{base}{MANIFEST}"));
        if let Err(error) = files_store.delete_many_boxed(&keys).await {
            tracing::warn!(%error, deployment = %deployment.id, "[online-store] a deployment's files were not all deleted");
        }
    }
    let now = utc_now();
    if let Err(error) =
        storefront_deployments::Entity::update(storefront_deployments::ActiveModel {
            id: Set(deployment.id.clone()),
            deleted_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec(&db)
        .await
    {
        return failed(&error, FAILED);
    }
    caller.publish(
        &state,
        STOREFRONT_DEPLOYMENT_DELETED,
        &deployment.id,
        &json!({ "id": deployment.id, "siteId": site.id }),
    );
    NoContent.into_response()
}

// ── Deploy keys (CI) ───────────────────────────────────────────────────

/// What the deploy-key upload needs from the server.
#[derive(Clone)]
pub struct DeployState {
    pub master: PgPool,
    pub workspaces: Arc<Workspaces>,
    pub events: EntityEventPublisher,
    pub config: OnlineStoreConfig,
}

impl std::fmt::Debug for DeployState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeployState").finish_non_exhaustive()
    }
}

/// `POST /storefront-deploy/v1/deployments`, authenticated by a deploy key.
pub fn deploy_router(state: DeployState) -> Router {
    Router::new()
        .route(
            "/storefront-deploy/v1/deployments",
            post(deploy_with_key).layer(DefaultBodyLimit::max(MAX_BYTES + 1024 * 1024)),
        )
        .with_state(state)
}

fn key_refused() -> Response {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "INVALID_KEY",
        "Invalid or missing deploy key. Send Authorization: Bearer wcd_….",
    )
    .into_response()
}

#[allow(
    clippy::too_many_lines,
    reason = "the key, the workspace, the site, the upload and promotion in turn"
)]
async fn deploy_with_key(
    State(state): State<DeployState>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    request: Request,
) -> Response {
    const FAILED: &str = "Failed to upload the deployment";
    let Some(key) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|k| k.starts_with("wcd_"))
    else {
        return key_refused();
    };
    let Some(files_store) = state.config.files.clone() else {
        return unavailable("Static hosting needs the public bucket (S3_BUCKET_PUBLIC)");
    };
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    let entry = storefront_key_registry::Entity::find()
        .filter(storefront_key_registry::Column::KeyHash.eq(hash))
        .filter(storefront_key_registry::Column::RevokedAt.is_null())
        .filter(storefront_key_registry::Column::Kind.eq("deploy"))
        .one(&orm(&state.master))
        .await;
    let entry = match entry {
        Ok(Some(entry)) => entry,
        Ok(None) => return key_refused(),
        Err(error) => return failed(&error, FAILED),
    };
    let tenant = match state.workspaces.tenant(&entry.workspace_id).await {
        Ok(tenant) => tenant,
        Err(error) => return failed(&error, "The shop could not be reached"),
    };
    let licensed = tenant
        .licensed_apps()
        .is_none_or(|apps| apps.iter().any(|a| a == "weldcommerce"));
    if tenant.suspended || !licensed || tenant.restrictions.read_only {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "WORKSPACE_UNAVAILABLE",
            "This workspace can't take deployments now",
        )
        .into_response();
    }
    let db = orm(&tenant.db);
    let site = storefront_sites::Entity::find()
        .filter(storefront_sites::Column::ChannelId.eq(entry.channel_id.clone()))
        .filter(storefront_sites::Column::DeletedAt.is_null())
        .one(&db)
        .await;
    let site = match site {
        Ok(Some(site)) => site,
        Ok(None) => {
            return conflict(
                "NO_SITE",
                "Create the channel's online store (mode: your own code) first",
                None,
            );
        }
        Err(error) => return failed(&error, FAILED),
    };
    let multipart = match Multipart::from_request(request, &()).await {
        Ok(multipart) => multipart,
        Err(rejection) => {
            return invalid_field("body", &format!("Send multipart/form-data: {rejection}"));
        }
    };
    let upload = match read_upload(multipart).await {
        Ok(upload) => upload,
        Err(response) => return response,
    };
    let uploader = Uploader {
        user_id: None,
        key_id: Some(entry.id.clone()),
    };
    let mut deployment = match store(
        &files_store,
        &db,
        &tenant.workspace_id,
        &site,
        upload,
        &uploader,
    )
    .await
    {
        Ok(deployment) => deployment,
        Err(response) => return response,
    };
    let events = EventContext::from_ids(
        &tenant.workspace_id,
        tenant.clerk_org_id.as_deref(),
        "system",
    );
    let production = query.as_deref().is_some_and(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .any(|(k, v)| k == "production" && (v == "true" || v == "1"))
    });
    let mut site = site;
    if production {
        if site.mode != "static" {
            return conflict(
                "NOT_A_STATIC_SITE",
                "Switch the shop to hosting your own code first; the deployment was uploaded",
                Some(json!({ "deploymentId": deployment.id })),
            );
        }
        match make_live(&db, &site, &deployment.id).await {
            Ok((live_site, live)) => {
                site = live_site;
                deployment = live;
            }
            Err(error) => return failed(&error, FAILED),
        }
        let mirror = SiteMirror {
            mode: site.mode.clone(),
            published_version_id: site.published_version_id.clone(),
            deployment_id: site.active_deployment_id.clone(),
            visibility: site.visibility.clone(),
            password_hash: site.password_hash.clone(),
        };
        if let Err(error) = registry::sync_site(
            &state.master,
            state.config.cache.as_ref(),
            &tenant.workspace_id,
            &site.id,
            &mirror,
        )
        .await
        {
            tracing::error!(%error, "[online-store] the hosts could not be updated");
        }
    }
    let host = free_host(Some(&state.master), &tenant.workspace_id, &site.id).await;
    let value = present(
        &state.config,
        &deployment,
        site.active_deployment_id.as_deref(),
        host.as_deref(),
    );
    publish_entity_event(
        &state.events,
        &events,
        STOREFRONT_DEPLOYMENT_CREATED,
        &deployment.id,
        &value,
    );
    if production {
        publish_entity_event(
            &state.events,
            &events,
            STOREFRONT_DEPLOYMENT_PROMOTED,
            &deployment.id,
            &value,
        );
    }
    Created(value).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(clean_path("dist/index.html").as_deref(), Some("index.html"));
        assert_eq!(
            clean_path("./assets/app-1a2b.js").as_deref(),
            Some("assets/app-1a2b.js")
        );
        assert_eq!(
            clean_path(".well-known/security.txt").as_deref(),
            Some(".well-known/security.txt")
        );
        for bad in [
            "",
            "../etc/passwd",
            "a/../b",
            ".git/config",
            "a//b",
            MANIFEST,
        ] {
            assert_eq!(clean_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn preview_hosts_round_trip() {
        let host = preview_host("sfd_m9x2k3abcd1234", "myshop.weldshop.eu");
        assert_eq!(host, "sfd-m9x2k3abcd1234--myshop.weldshop.eu");
        assert_eq!(
            parse_preview_host(&host),
            Some((
                "sfd_m9x2k3abcd1234".to_owned(),
                "myshop.weldshop.eu".to_owned()
            ))
        );
        assert_eq!(parse_preview_host("myshop.weldshop.eu"), None);
    }

    #[test]
    fn config_is_checked() {
        assert!(check_config(&json!({ "spa": true, "cleanUrls": false })).is_ok());
        assert!(check_config(&json!({ "redirects": [{ "from": "/old", "to": "/new" }] })).is_ok());
        assert!(
            check_config(
                &json!({ "headers": [{ "source": "/*", "headers": { "Set-Cookie": "x" } }] })
            )
            .is_err()
        );
        assert!(check_config(&json!({ "functions": {} })).is_err());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("a/b.WOFF2"), "font/woff2");
        assert_eq!(content_type("data.bin"), "application/octet-stream");
    }
}
