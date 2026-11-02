//! `/api/storage` (`apps/workers/app-api/src/routes/storage/index.ts`): the
//! upload broker, the files cookie and signed URLs, the private-object read,
//! and the move of old private files out of the public bucket.
//!
//! Two routers, as the worker mounts two:
//!
//! - [`storage_router`], behind the session and tenant database like every
//!   `/api` route: `POST /generate-upload-url`, `POST /confirm-upload`,
//!   `POST|DELETE /access`, `POST /sign`, `POST /migrate-private`.
//! - [`storage_public_router`], before any authentication, at its full
//!   paths: `PUT /api/storage/upload/:token` (the token is the credential),
//!   `GET /api/storage/private/*` (a files cookie, a session token or a
//!   signed URL for the key's workspace) and the local-dev-only
//!   `GET /api/storage/public/*`.
//!
//! Upload tokens live in the cache port (`WORKSPACE_CACHE` in TypeScript),
//! ten minutes, as the same JSON. Uploads go to the private bucket unless
//! they are public (avatars and logos always are).

mod migrate;
mod signing;
mod upload;

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, OriginalUri, Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, ETAG, RANGE, SET_COOKIE,
    X_CONTENT_TYPE_OPTIONS,
};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use weldsuite_auth::SessionVerifier;
use weldsuite_catalogs::entity_events::FILE_UPDATED;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{ApiError, RequestEnv, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{
    ByteRange, CacheExt, DynCache, DynFileStore, DynJobs, FileStores, ObjectInfo, PutOptions,
    RequestCache, StorageBuckets,
};

use crate::files::resolve_stored_content;
use crate::{
    Caller, CoreFilesState, json_response, private_object_url, query_param, request_origin,
    validate, workspace_of_key,
};
use signing::{
    FILES_COOKIE, cookie_values, files_cookie_path, now_seconds, sign_files_cookie,
    sign_private_object_url, verify_files_cookie, verify_private_object_signature,
};
use upload::{
    ALWAYS_PUBLIC_ENTITY_TYPES, MAX_UPLOAD_BYTES, PendingUpload, UPLOAD_TOKEN_PREFIX,
    UPLOAD_TOKEN_TTL, build_upload_key, generate_upload_token, now_millis, read_upload_request,
};

/// `PRIVATE_OBJECT_PATH`: where private objects are served.
pub(crate) const PRIVATE_OBJECT_PATH: &str = "/api/storage/private/";

const PUBLIC_OBJECT_PATH: &str = "/api/storage/public/";

/// What only the storage routes need from the deployment.
#[derive(Clone, Default)]
pub struct StorageState {
    /// Where upload tokens live (Valkey; in-process without one).
    pub cache: Option<Arc<dyn DynCache>>,
    /// Session tokens, for a private read with a bearer header.
    pub verifier: Option<Arc<SessionVerifier>>,
    /// `STORAGE_SIGNING_KEY`: files cookies and signed URLs.
    pub signing_key: Option<Arc<str>>,
    /// `ENVIRONMENT`: `production` refuses private uploads without the
    /// private bucket; `development` opens the local public read.
    pub environment: Arc<str>,
    /// Starts the 30-day purge of a trashed file.
    pub jobs: Option<Arc<dyn DynJobs>>,
}

impl std::fmt::Debug for StorageState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorageState")
            .field("cache", &self.cache.is_some())
            .field("verifier", &self.verifier.is_some())
            .field("signing_key", &self.signing_key.is_some())
            .field("environment", &self.environment)
            .field("jobs", &self.jobs.is_some())
            .finish()
    }
}

/// `/api/storage`, to nest under `/api` behind the session, tenant
/// database, licence and flag layers. No `requirePermission` on the broker
/// itself: it serves avatars, drive files, attachments and receipts alike,
/// and every key it hands out sits under the caller's own workspace.
pub fn storage_router<S, Q>(state: CoreFilesState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/generate-upload-url", post(generate_upload_url))
        .route("/confirm-upload", post(confirm_upload))
        .route("/access", post(grant_access).delete(revoke_access))
        .route("/sign", post(sign))
        .route(
            "/migrate-private",
            post(migrate_private).route_layer(gate.require(["settings:general:update".to_owned()])),
        )
        .with_state(state)
}

/// The storage routes that run before authentication, at their full paths
/// (`/api/storage/upload/:token`, `/api/storage/private/*`,
/// `/api/storage/public/*`), to merge into the root router.
pub fn storage_public_router<S>(state: CoreFilesState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/api/storage/upload/{token}",
            put(upload_object).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/storage/private/", get(private_object))
        .route("/api/storage/private/{*key}", get(private_object))
        .route("/api/storage/public/", get(public_object))
        .route("/api/storage/public/{*key}", get(public_object))
        .with_state(state)
}

// ── What a request brings ──────────────────────────────────────────────────

/// What conformance builds put on a request (the test's env, buckets, KV
/// and session key); absent in a deployment, where the state's are used.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    env: Option<RequestEnv>,
    buckets: Option<StorageBuckets>,
    cache: Option<RequestCache>,
    verifier: Option<Arc<SessionVerifier>>,
}

impl Overrides {
    pub(crate) fn from_parts(parts: &Parts) -> Self {
        let extensions = &parts.extensions;
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            buckets: extensions
                .get::<StorageBuckets>()
                .cloned()
                .or_else(|| extensions.get::<FileStores>().cloned().map(Into::into)),
            cache: extensions.get::<RequestCache>().cloned(),
            verifier: extensions.get::<Arc<SessionVerifier>>().cloned(),
        }
    }

    fn env(&self, name: &str) -> Option<&str> {
        self.env.as_ref().and_then(|env| env.get(name))
    }

    /// `c.env.ENVIRONMENT`.
    fn environment<'a>(&'a self, state: &'a CoreFilesState) -> &'a str {
        self.env("ENVIRONMENT")
            .unwrap_or(&state.storage.environment)
    }

    /// `c.env.STORAGE_SIGNING_KEY`, when set.
    fn signing_key(&self, state: &CoreFilesState) -> Option<String> {
        self.env("STORAGE_SIGNING_KEY")
            .map(str::to_owned)
            .or_else(|| state.storage.signing_key.as_deref().map(str::to_owned))
            .filter(|key| !key.is_empty())
    }

    /// `c.env.STORAGE` and `c.env.PRIVATE_STORAGE`, each when bound.
    fn buckets(&self, state: &CoreFilesState) -> StorageBuckets {
        self.buckets
            .clone()
            .or_else(|| state.files.clone().map(Into::into))
            .unwrap_or_default()
    }

    /// `bucketFor(env, name)`.
    fn bucket(&self, state: &CoreFilesState, name: &str) -> Option<Arc<dyn DynFileStore>> {
        let buckets = self.buckets(state);
        if name == "private" {
            buckets.private
        } else {
            buckets.public
        }
    }

    /// `c.env.WORKSPACE_CACHE`.
    fn cache(&self, state: &CoreFilesState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|RequestCache(cache)| Arc::clone(cache))
            .or_else(|| state.storage.cache.clone())
    }

    fn verifier(&self, state: &CoreFilesState) -> Option<Arc<SessionVerifier>> {
        self.verifier
            .clone()
            .or_else(|| state.storage.verifier.clone())
    }

    /// `c.env.R2_PUBLIC_URL`.
    fn public_files_url(&self, state: &CoreFilesState) -> Option<String> {
        self.env("R2_PUBLIC_URL")
            .map(str::to_owned)
            .or_else(|| state.public_files_url.as_deref().map(str::to_owned))
            .filter(|url| !url.is_empty())
    }
}

/// A request to a public route: its origin and what it brings.
pub(crate) struct Visitor {
    origin: String,
    overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Visitor {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            origin: request_origin(&parts.headers),
            overrides: Overrides::from_parts(parts),
        }))
    }
}

/// `c.json({ error: message }, status)`: the broker's own error shape.
fn plain_error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "error": message }))
}

/// `c.json({ success: false, error: message }, status)`.
fn unsuccessful(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "success": false, "error": message }))
}

/// `c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404)`.
fn file_not_found() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "File not found").into_response()
}

fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_bytes(text.as_bytes()).unwrap_or_else(|_| HeaderValue::from_static(""))
}

async fn read_pending(
    cache: &Arc<dyn DynCache>,
    token: &str,
) -> Result<Option<PendingUpload>, Box<Response>> {
    cache
        .get_json(&format!("{UPLOAD_TOKEN_PREFIX}{token}"))
        .await
        .map_err(|error| {
            tracing::error!(%error, "storage: reading an upload token failed");
            Box::new(ApiError::internal().into_response())
        })
}

async fn write_pending(
    cache: &Arc<dyn DynCache>,
    token: &str,
    pending: &PendingUpload,
) -> Result<(), weldsuite_ports::PortError> {
    cache
        .put_json(
            &format!("{UPLOAD_TOKEN_PREFIX}{token}"),
            pending,
            Some(UPLOAD_TOKEN_TTL),
        )
        .await
}

// ── POST /generate-upload-url ──────────────────────────────────────────────

async fn generate_upload_url(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_upload_request) {
        Ok(input) => input,
        Err(fail) => return crate::answer(Err(fail), ""),
    };
    let Some(user_id) = caller.user_id.clone() else {
        return ApiError::unauthorized().into_response();
    };
    // R2 keys stay under the Clerk org id (workspace-id plan, phase 3).
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let overrides = &caller.storage;
    let Some(bucket) = choose_upload_bucket(overrides, &state, &input) else {
        return ApiError::unavailable("Private storage is not configured").into_response();
    };
    let Some(cache) = overrides.cache(&state) else {
        tracing::error!("storage: no cache for upload tokens");
        return ApiError::internal()
            .with_message("Failed to generate upload URL")
            .into_response();
    };
    let token = generate_upload_token();
    let (file_key, create_only) = build_upload_key(&org_id, &input);
    let pending = PendingUpload {
        file_key: file_key.clone(),
        content_type: input.content_type.clone(),
        file_name: input.file_name.clone(),
        file_size: input.file_size,
        is_public: bucket == "public",
        bucket: Some(bucket.to_owned()),
        user_id,
        created_at: now_millis(),
        create_only: Some(create_only),
        uploaded: Some(false),
        uploaded_at: None,
    };
    if let Err(error) = write_pending(&cache, &token, &pending).await {
        tracing::error!(%error, "storage: generate-upload-url failed");
        return ApiError::internal()
            .with_message("Failed to generate upload URL")
            .into_response();
    }
    json_response(
        StatusCode::OK,
        json!({
            "success": true,
            "uploadUrl": format!("{}/api/storage/upload/{token}", caller.origin),
            "uploadToken": token,
            "fileKey": file_key,
            "bucket": bucket,
        }),
    )
}

/// `chooseUploadBucket`: public uploads (and avatars, logos) to the public
/// bucket; private ones to the private bucket, refused in production
/// without it and put in the public one elsewhere.
fn choose_upload_bucket(
    overrides: &Overrides,
    state: &CoreFilesState,
    input: &upload::UploadRequest,
) -> Option<&'static str> {
    let always_public = input
        .entity_type
        .as_deref()
        .is_some_and(|kind| ALWAYS_PUBLIC_ENTITY_TYPES.contains(&kind));
    if input.is_public || always_public {
        return Some("public");
    }
    if overrides.buckets(state).private.is_some() {
        return Some("private");
    }
    if overrides.environment(state) == "production" {
        return None;
    }
    tracing::warn!("storage: no private bucket; a private upload goes to the public bucket");
    Some("public")
}

// ── PUT /api/storage/upload/:token ─────────────────────────────────────────

/// What the body turned out to be.
enum ExactBody {
    Bytes(Vec<u8>),
    TooLarge,
    SizeMismatch,
}

/// `checkDeclaredLength`: why a `Content-Length` rules the body out, if it
/// does.
fn check_declared_length(header: Option<&str>, expected: u64) -> Option<ExactBody> {
    let header = header?;
    let declared = weldsuite_kit::validation::js_number(header);
    if !declared.is_finite() || declared.fract() != 0.0 || declared < 0.0 {
        return Some(ExactBody::SizeMismatch);
    }
    #[allow(clippy::cast_precision_loss)] // sizes are below 2^53
    let expected_f = expected as f64;
    if declared > expected_f {
        return Some(ExactBody::TooLarge);
    }
    (declared < expected_f).then_some(ExactBody::SizeMismatch)
}

/// `readBodyOfExactSize`: a body of exactly `expected` bytes, cut off as
/// soon as it passes that.
async fn read_exact_body(
    headers: &HeaderMap,
    body: Body,
    expected: u64,
) -> Result<ExactBody, axum::Error> {
    let declared = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok());
    if let Some(refusal) = check_declared_length(declared, expected) {
        return Ok(refusal);
    }
    let limit = usize::try_from(expected).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(limit);
    let mut body = body;
    while let Some(frame) = body.frame().await {
        let Ok(data) = frame?.into_data() else {
            continue;
        };
        if bytes.len() + data.len() > limit {
            return Ok(ExactBody::TooLarge);
        }
        bytes.extend_from_slice(&data);
    }
    if bytes.len() == limit {
        Ok(ExactBody::Bytes(bytes))
    } else {
        Ok(ExactBody::SizeMismatch)
    }
}

async fn upload_object(
    State(state): State<CoreFilesState>,
    visitor: Visitor,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let overrides = &visitor.overrides;
    let Some(cache) = overrides.cache(&state) else {
        tracing::error!("storage: no cache for upload tokens");
        return ApiError::internal().into_response();
    };
    let pending = match read_pending(&cache, &token).await {
        Ok(Some(pending)) => pending,
        Ok(None) => return plain_error(StatusCode::BAD_REQUEST, "Invalid or expired upload token"),
        Err(response) => return *response,
    };
    // One token, one write. The cache flag is the fast path; keys with a
    // random segment are also written create-only, which is atomic.
    if pending.uploaded == Some(true) {
        return plain_error(StatusCode::CONFLICT, "Upload token already used");
    }
    let Some(bucket) = overrides.bucket(&state, pending.bucket()) else {
        return plain_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Storage is not configured",
        );
    };
    // Tokens minted before the cap existed may carry a larger declared size.
    if pending.file_size > MAX_UPLOAD_BYTES {
        return plain_error(StatusCode::PAYLOAD_TOO_LARGE, "File is too large");
    }
    let bytes = match read_exact_body(&headers, body, pending.file_size).await {
        Ok(ExactBody::Bytes(bytes)) => bytes,
        Ok(ExactBody::TooLarge) => {
            return plain_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Upload is larger than the declared file size",
            );
        }
        Ok(ExactBody::SizeMismatch) => {
            return plain_error(
                StatusCode::BAD_REQUEST,
                "Upload size does not match the declared file size",
            );
        }
        Err(error) => {
            tracing::error!(%error, "storage: upload failed");
            return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed");
        }
    };
    // The type declared at mint time, never the PUT's own header, and only
    // allowlisted types as themselves.
    let (content_type, attachment) = resolve_stored_content(&pending.content_type);
    let options = PutOptions {
        content_type: Some(content_type),
        content_disposition: attachment.then(|| "attachment".to_owned()),
        create_only: pending.create_only == Some(true),
        ..PutOptions::default()
    }
    .with_metadata("fileName", pending.file_name.clone());
    let stored = match bucket.put_boxed(&pending.file_key, bytes, &options).await {
        Ok(Some(stored)) => stored,
        // The create-only precondition failed: the key was written already.
        Ok(None) => return plain_error(StatusCode::CONFLICT, "Upload token already used"),
        Err(error) => {
            tracing::error!(%error, "storage: upload failed");
            return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed");
        }
    };
    let done = PendingUpload {
        uploaded: Some(true),
        uploaded_at: Some(now_millis()),
        ..pending
    };
    if let Err(error) = write_pending(&cache, &token, &done).await {
        tracing::error!(%error, "storage: upload failed");
        return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed");
    }
    let mut response = StatusCode::OK.into_response();
    let headers = response.headers_mut();
    headers.insert(
        ETAG,
        header_value(stored.etag.as_deref().unwrap_or_default()),
    );
    headers.insert(
        http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("ETag"),
    );
    response
}

// ── POST /confirm-upload ───────────────────────────────────────────────────

async fn confirm_upload(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        let token = issues
            .text(fields, "uploadToken", Presence::Required, Some(1), None)
            .into_option();
        let key = issues
            .text(fields, "fileKey", Presence::Required, Some(1), None)
            .into_option();
        issues.text(fields, "etag", Presence::Optional, None, None);
        (token.unwrap_or_default(), key.unwrap_or_default())
    });
    let (token, requested_key) = match input {
        Ok(input) => input,
        Err(fail) => return crate::answer(Err(fail), ""),
    };
    let Some(user_id) = caller.user_id.clone() else {
        return ApiError::unauthorized().into_response();
    };
    let overrides = &caller.storage;
    let Some(cache) = overrides.cache(&state) else {
        tracing::error!("storage: no cache for upload tokens");
        return ApiError::internal().into_response();
    };
    let pending = match read_pending(&cache, &token).await {
        Ok(Some(pending)) if pending.user_id == user_id => pending,
        Ok(_) => return unsuccessful(StatusCode::BAD_REQUEST, "Invalid or expired upload token"),
        Err(response) => return *response,
    };
    // The key comes from the token, never from the request: a caller's key
    // would turn this into a size and URL oracle for any object.
    let file_key = pending.file_key.clone();
    if requested_key != file_key {
        return ApiError::bad_request("File key does not match the upload token").into_response();
    }
    if let Err(error) = cache
        .delete_boxed(&format!("{UPLOAD_TOKEN_PREFIX}{token}"))
        .await
    {
        tracing::error!(%error, "storage: deleting an upload token failed");
        return ApiError::internal().into_response();
    }
    let bucket_name = pending.bucket();
    let Some(bucket) = overrides.bucket(&state, bucket_name) else {
        return ApiError::internal()
            .with_message("Storage is not configured")
            .into_response();
    };
    let head = match bucket.head_boxed(&file_key).await {
        Ok(Some(head)) => head,
        Ok(None) => return unsuccessful(StatusCode::BAD_REQUEST, "File not found in storage"),
        Err(error) => {
            tracing::error!(%error, "storage: confirm-upload failed");
            return unsuccessful(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to confirm upload",
            );
        }
    };
    let url = if bucket_name == "private" {
        private_object_url(&caller.origin, &file_key)
    } else {
        resolve_public_url(
            &caller.origin,
            overrides.public_files_url(&state).as_deref(),
            &file_key,
        )
    };
    let (mime_type, _) = resolve_stored_content(&pending.content_type);
    json_response(
        StatusCode::OK,
        json!({
            "success": true,
            "file": {
                "id": generate_id("file"),
                "fileName": pending.file_name,
                "fileKey": file_key,
                "fileSize": head.size,
                "mimeType": mime_type,
                "url": url,
                "isPublic": bucket_name == "public",
                "bucket": bucket_name,
            },
        }),
    )
}

/// `^https?://(localhost|127\.0\.0\.1)(:\d+)?$`, case-insensitive.
fn is_local_origin(origin: &str) -> bool {
    let lower = origin.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    else {
        return false;
    };
    let (host, port) = rest
        .split_once(':')
        .map_or((rest, None), |(h, p)| (h, Some(p)));
    matches!(host, "localhost" | "127.0.0.1")
        && port.is_none_or(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// `resolvePublicUrl`: the public bucket's own URL for a key, or this
/// server's local public read when the request came to localhost.
fn resolve_public_url(origin: &str, public_url: Option<&str>, key: &str) -> String {
    if is_local_origin(origin) {
        return format!("{origin}{PUBLIC_OBJECT_PATH}{key}");
    }
    // The TypeScript route's own fallback, kept for parity; the Kubernetes
    // editions set `S3_PUBLIC_URL`.
    let base = public_url.unwrap_or("https://weldsuite-storage-test.weldsuite.org");
    format!("{base}/{key}")
}

// ── POST /access, DELETE /access ───────────────────────────────────────────

fn files_cookie_header(origin: &str, workspace_id: &str, value: &str, max_age: i64) -> String {
    let secure = if origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{FILES_COOKIE}={value}; Path={}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
        files_cookie_path(workspace_id)
    )
}

async fn grant_access(State(state): State<CoreFilesState>, caller: Caller) -> Response {
    if caller.user_id.is_none() {
        return ApiError::unauthorized().into_response();
    }
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let Some(secret) = caller.storage.signing_key(&state) else {
        return ApiError::unavailable("File access signing is not configured").into_response();
    };
    let (value, expires_at) = sign_files_cookie(&secret, &org_id, now_seconds());
    let cookie = files_cookie_header(&caller.origin, &org_id, &value, expires_at - now_seconds());
    let mut response =
        weldsuite_kit::Data(json!({ "workspaceId": org_id, "expiresAt": expires_at }))
            .into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, header_value(&cookie));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn revoke_access(caller: Caller) -> Response {
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let cookie = files_cookie_header(&caller.origin, &org_id, "", 0);
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, header_value(&cookie));
    response
}

// ── POST /sign ─────────────────────────────────────────────────────────────

async fn sign(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        let files = issues
            .list(
                fields,
                "files",
                Presence::Required,
                Some(1),
                Some(100),
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option();
        let ttl = issues
            .whole_number(
                fields,
                "ttlSeconds",
                Presence::Optional,
                Number {
                    int: true,
                    min: Some(30.0),
                    max: Some(86_400.0),
                    ..Number::default()
                },
            )
            .into_option();
        (files.unwrap_or_default(), ttl)
    });
    let (files, ttl) = match input {
        Ok(input) => input,
        Err(fail) => return crate::answer(Err(fail), ""),
    };
    if caller.user_id.is_none() {
        return ApiError::unauthorized().into_response();
    }
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let Some(secret) = caller.storage.signing_key(&state) else {
        return ApiError::unavailable("File access signing is not configured").into_response();
    };
    let now = now_seconds();
    let mut urls = Map::new();
    for reference in files {
        let key = key_from_private_object_url(&reference)
            .or_else(|| weldsuite_ports::is_safe_key(&reference).then(|| reference.clone()));
        let Some(key) = key.filter(|key| workspace_of_key(key) == Some(org_id.as_str())) else {
            continue;
        };
        let (url, expires_at) = sign_private_object_url(&secret, &caller.origin, &key, ttl, now);
        urls.insert(reference, json!({ "url": url, "expiresAt": expires_at }));
    }
    weldsuite_kit::Data(Value::Object(urls)).into_response()
}

/// `decodeURIComponent`: `None` where JavaScript throws (a bad escape, or
/// bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The key of a private object path (`/api/storage/private/<key>`, already
/// normalised as `new URL(...).pathname` does), or `None`.
fn key_from_private_path(pathname: &str) -> Option<String> {
    let encoded = pathname.strip_prefix(PRIVATE_OBJECT_PATH)?;
    decode_uri_component(encoded).filter(|key| weldsuite_ports::is_safe_key(key))
}

/// `keyFromPrivateObjectUrl`: the key of a private object URL (any host),
/// or `None` for any other URL or a bare key.
fn key_from_private_object_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    key_from_private_path(parsed.path())
}

// ── POST /migrate-private ──────────────────────────────────────────────────

async fn migrate_private(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        let cursor = issues
            .text(fields, "cursor", Presence::Nullish, None, None)
            .into_option();
        let dry_run = issues
            .boolean(fields, "dryRun", Presence::Optional)
            .into_option()
            .unwrap_or(false);
        (cursor, dry_run)
    });
    let (cursor, dry_run) = match input {
        Ok(input) => input,
        Err(fail) => return crate::answer(Err(fail), ""),
    };
    // Stored file keys sit under the org id prefix.
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let buckets = caller.storage.buckets(&state);
    let (Some(public), Some(private)) = (buckets.public, buckets.private) else {
        return ApiError::unavailable("Private storage is not configured").into_response();
    };
    let result = migrate::migrate_private_files_batch(
        &caller.db,
        &migrate::Buckets {
            public: &*public,
            private: &*private,
        },
        &migrate::Batch {
            workspace_id: &org_id,
            api_origin: &caller.origin,
            cursor: cursor.as_deref(),
            dry_run,
        },
    )
    .await;
    match result {
        Ok(batch) => {
            // The moved rows have a new URL and their public object is gone:
            // tell realtime, search and every open drive view.
            for file in &batch.updated {
                caller.publish(
                    &state,
                    FILE_UPDATED,
                    &file.id,
                    &json!({
                        "id": file.id, "name": file.name,
                        "folderId": file.folder_id, "fileType": file.file_type,
                    }),
                );
            }
            weldsuite_kit::Data(batch.to_json()).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "storage: migrate-private failed");
            ApiError::internal()
                .with_message("Failed to move private files")
                .into_response()
        }
    }
}

// ── GET /api/storage/private/* ─────────────────────────────────────────────

/// The request's path as `new URL(c.req.url).pathname` gives it: dot
/// segments (`%2e%2e` included) resolved, as a WHATWG URL parser does.
fn normalised_path(uri: &http::Uri) -> String {
    let path_and_query = uri.path_and_query().map_or("/", |p| p.as_str());
    url::Url::parse(&format!("http://localhost{path_and_query}"))
        .map_or_else(|_| uri.path().to_owned(), |url| url.path().to_owned())
}

/// `authorizePrivateRead`: a signed URL for the key, a files cookie for the
/// workspace, or a session token whose active organisation is it.
async fn authorize_private_read(
    state: &CoreFilesState,
    overrides: &Overrides,
    headers: &HeaderMap,
    query: Option<&str>,
    key: &str,
    workspace_id: &str,
) -> bool {
    let now = now_seconds();
    if let Some(secret) = overrides.signing_key(state) {
        let exp = query_param(query, "exp");
        let sig = query_param(query, "sig");
        if verify_private_object_signature(&secret, key, exp.as_deref(), sig.as_deref(), now) {
            return true;
        }
        let cookie = headers.get(COOKIE).and_then(|v| v.to_str().ok());
        if cookie_values(cookie, FILES_COOKIE)
            .iter()
            .any(|value| verify_files_cookie(&secret, value, workspace_id, now))
        {
            return true;
        }
    }
    let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    let Some(verifier) = overrides.verifier(state) else {
        return false;
    };
    // `verify` checks the signature, the times, `sub` and the `azp` rule.
    match verifier
        .verify(token, u64::try_from(now).unwrap_or_default())
        .await
    {
        Ok(auth) => !auth.user_id.is_empty() && auth.org_id.as_deref() == Some(workspace_id),
        Err(_) => false,
    }
}

/// `isInlineSafeContentType`: what a browser may render from this origin.
fn is_inline_safe(content_type: &str) -> bool {
    const INLINE_TYPES: [&str; 11] = [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "image/heic",
        "image/heif",
        "application/pdf",
        "text/plain",
    ];
    let base = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if INLINE_TYPES.contains(&base.as_str()) {
        return true;
    }
    // `^(?:video|audio)\/[\w.+-]+$`
    base.split_once('/').is_some_and(|(kind, subtype)| {
        matches!(kind, "video" | "audio")
            && !subtype.is_empty()
            && subtype
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
    })
}

/// `privateObjectHeaders`: no shared caching, no script, a filename.
fn private_object_headers(info: &ObjectInfo, key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    // `writeHttpMetadata`
    let content_type = info.content_type.clone().unwrap_or_default();
    if !content_type.is_empty() {
        headers.insert(CONTENT_TYPE, header_value(&content_type));
    }
    if let Some(etag) = &info.etag {
        headers.insert(ETAG, header_value(&format!("\"{etag}\"")));
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Chrome refuses to render a PDF in a sandboxed document.
    let is_pdf = content_type
        .to_ascii_lowercase()
        .strip_prefix("application/pdf")
        .is_some_and(|rest| {
            rest.chars()
                .next()
                .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
        });
    if !is_pdf {
        headers.insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; sandbox"),
        );
    }
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let name = info
        .metadata
        .get("filename")
        .map(String::as_str)
        .or_else(|| key.rsplit('/').next())
        .unwrap_or("file")
        .replace(['"', '\\', '\r', '\n'], "_");
    let disposition = if is_inline_safe(&content_type) {
        "inline"
    } else {
        "attachment"
    };
    headers.insert(
        CONTENT_DISPOSITION,
        header_value(&format!("{disposition}; filename=\"{name}\"")),
    );
    headers
}

/// `GET /api/storage/private/<key>`: the only way to read a private object.
/// No credential is a 401; a wrong one, or an unknown key, a 404, so the
/// route never confirms another workspace's key exists.
async fn private_object(
    State(state): State<CoreFilesState>,
    visitor: Visitor,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let overrides = &visitor.overrides;
    let key = key_from_private_path(&normalised_path(&uri));
    let Some((key, workspace_id)) = key.and_then(|key| {
        let workspace = workspace_of_key(&key)?.to_owned();
        Some((key, workspace))
    }) else {
        return file_not_found();
    };
    let query = uri.query();
    if !authorize_private_read(&state, overrides, &headers, query, &key, &workspace_id).await {
        let cookie = headers.get(COOKIE).and_then(|v| v.to_str().ok());
        let has_credential = query_param(query, "sig").is_some_and(|sig| !sig.is_empty())
            || headers
                .get(AUTHORIZATION)
                .is_some_and(|value| !value.is_empty())
            || !cookie_values(cookie, FILES_COOKIE).is_empty();
        return if has_credential {
            file_not_found()
        } else {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Sign in to open this file",
            )
            .into_response()
        };
    }
    let Some(bucket) = overrides.buckets(&state).private else {
        return ApiError::internal()
            .with_message("Private storage is not configured")
            .into_response();
    };
    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .and_then(ByteRange::parse);
    let object = match range {
        Some(range) => bucket.get_range_boxed(&key, range).await,
        None => bucket.get_boxed(&key).await.map(|object| {
            object.map(|object| weldsuite_ports::RangedObject {
                info: object.info,
                bytes: object.bytes,
                range: None,
            })
        }),
    };
    let object = match object {
        Ok(Some(object)) => object,
        Ok(None) => return file_not_found(),
        Err(error) => {
            tracing::error!(%error, "storage: reading a private object failed");
            return ApiError::internal().into_response();
        }
    };
    let mut response_headers = private_object_headers(&object.info, &key);
    let length = object.bytes.len();
    // A 206 only when a sub-range was served. (TypeScript answers a suffix
    // range, `bytes=-n`, as a 200 with the whole size; this answers 206.)
    let status = match object.range {
        Some((offset, served)) => {
            response_headers.insert(
                CONTENT_RANGE,
                header_value(&format!(
                    "bytes {offset}-{}/{}",
                    offset + served - 1,
                    object.info.size
                )),
            );
            StatusCode::PARTIAL_CONTENT
        }
        None => StatusCode::OK,
    };
    response_headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    let mut response = (status, object.bytes).into_response();
    response.headers_mut().extend(response_headers);
    response
}

// ── GET /api/storage/public/* (local development only) ─────────────────────

/// Streams a public object back for local development, where the bucket's
/// public domain does not serve what was just uploaded. Fails closed: only
/// with `ENVIRONMENT=development` and only for requests to localhost, so it
/// never becomes an open proxy for the bucket.
async fn public_object(
    State(state): State<CoreFilesState>,
    visitor: Visitor,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let overrides = &visitor.overrides;
    if overrides.environment(&state) != "development" || !is_local_origin(&visitor.origin) {
        return plain_error(StatusCode::NOT_FOUND, "Not found");
    }
    let Some(bucket) = overrides.buckets(&state).public else {
        return plain_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Storage is not configured",
        );
    };
    let pathname = normalised_path(&uri);
    let encoded = pathname
        .find(PUBLIC_OBJECT_PATH)
        .map_or("", |at| &pathname[at + PUBLIC_OBJECT_PATH.len()..]);
    let key = decode_uri_component(encoded).unwrap_or_default();
    if key.is_empty() || key.starts_with('/') || key.split('/').any(|s| s == "..") {
        return plain_error(StatusCode::BAD_REQUEST, "Missing or invalid file key");
    }
    let object = match bucket.get_boxed(&key).await {
        Ok(Some(object)) => object,
        Ok(None) => return plain_error(StatusCode::NOT_FOUND, "File not found"),
        Err(error) => {
            tracing::error!(%error, "storage: reading a public object failed");
            return ApiError::internal().into_response();
        }
    };
    let mut response = (StatusCode::OK, object.bytes).into_response();
    let headers = response.headers_mut();
    if let Some(content_type) = &object.info.content_type {
        headers.insert(CONTENT_TYPE, header_value(content_type));
    }
    if let Some(disposition) = &object.info.content_disposition {
        headers.insert(CONTENT_DISPOSITION, header_value(disposition));
    }
    if let Some(etag) = &object.info.etag {
        headers.insert(ETAG, header_value(&format!("\"{etag}\"")));
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    headers.insert(
        http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_origins() {
        for local in [
            "http://localhost",
            "http://localhost:8787",
            "https://127.0.0.1:3000",
            "HTTP://LOCALHOST",
        ] {
            assert!(is_local_origin(local), "{local}");
        }
        for remote in [
            "https://my-tunnel.example",
            "http://localhost.example",
            "http://localhost:",
            "ftp://localhost",
        ] {
            assert!(!is_local_origin(remote), "{remote}");
        }
        assert_eq!(
            resolve_public_url(
                "http://localhost:8787",
                Some("https://files.example"),
                "workspaces/o/a b"
            ),
            "http://localhost:8787/api/storage/public/workspaces/o/a b"
        );
        assert_eq!(
            resolve_public_url(
                "https://api.example",
                Some("https://files.example"),
                "workspaces/o/a"
            ),
            "https://files.example/workspaces/o/a"
        );
    }

    #[test]
    fn private_keys_from_paths_and_urls() {
        assert_eq!(
            key_from_private_path("/api/storage/private/workspaces/org_a/a%20b.pdf").as_deref(),
            Some("workspaces/org_a/a b.pdf")
        );
        assert_eq!(
            key_from_private_path("/api/storage/private/workspaces/org_a/..%2Fx/y"),
            None
        );
        assert_eq!(key_from_private_path("/api/storage/private/%zz"), None);
        assert_eq!(key_from_private_path("/api/storage/private/"), None);
        assert_eq!(
            key_from_private_object_url(
                "https://api.example/api/storage/private/workspaces/org_a/x.pdf?exp=1"
            )
            .as_deref(),
            Some("workspaces/org_a/x.pdf")
        );
        // `new URL` resolves `%2e%2e` segments before the key is read.
        assert_eq!(
            key_from_private_object_url(
                "https://h/api/storage/private/workspaces/org_a/%2e%2e/org_b/x"
            )
            .as_deref(),
            Some("workspaces/org_b/x")
        );
        assert_eq!(key_from_private_object_url("workspaces/org_a/x.pdf"), None);
        assert_eq!(
            key_from_private_object_url("https://h/other/workspaces/org_a/x"),
            None
        );
    }

    #[test]
    fn declared_lengths() {
        assert!(check_declared_length(None, 5).is_none());
        assert!(check_declared_length(Some("5"), 5).is_none());
        assert!(matches!(
            check_declared_length(Some("9999999"), 5),
            Some(ExactBody::TooLarge)
        ));
        assert!(matches!(
            check_declared_length(Some("2"), 5),
            Some(ExactBody::SizeMismatch)
        ));
        assert!(matches!(
            check_declared_length(Some("abc"), 5),
            Some(ExactBody::SizeMismatch)
        ));
        assert!(matches!(
            check_declared_length(Some("-1"), 5),
            Some(ExactBody::SizeMismatch)
        ));
    }

    #[tokio::test]
    async fn bodies_are_read_to_exactly_their_size() {
        let read = |bytes: &'static [u8], expected| async move {
            read_exact_body(&HeaderMap::new(), Body::from(bytes), expected)
                .await
                .expect("a body")
        };
        assert!(matches!(read(b"12345", 5).await, ExactBody::Bytes(b) if b == b"12345"));
        assert!(matches!(read(b"123", 5).await, ExactBody::SizeMismatch));
        assert!(matches!(read(b"123456", 5).await, ExactBody::TooLarge));
        assert!(matches!(read(b"", 0).await, ExactBody::Bytes(b) if b.is_empty()));
    }

    #[test]
    fn served_headers_never_run_script() {
        let html = ObjectInfo {
            content_type: Some("text/html".to_owned()),
            ..ObjectInfo::default()
        };
        let headers = private_object_headers(&html, "workspaces/o/x/page.html");
        assert_eq!(
            headers[CONTENT_DISPOSITION],
            "attachment; filename=\"page.html\""
        );
        assert_eq!(
            headers[CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );
        assert_eq!(headers[X_CONTENT_TYPE_OPTIONS], "nosniff");
        let pdf = ObjectInfo {
            content_type: Some("application/pdf".to_owned()),
            metadata: [("filename".to_owned(), "pay\"roll.pdf".to_owned())].into(),
            ..ObjectInfo::default()
        };
        let headers = private_object_headers(&pdf, "workspaces/o/x/1.pdf");
        assert_eq!(
            headers[CONTENT_DISPOSITION],
            "inline; filename=\"pay_roll.pdf\""
        );
        assert!(!headers.contains_key(CONTENT_SECURITY_POLICY));
        assert!(is_inline_safe("video/webm;codecs=vp9"));
        assert!(!is_inline_safe("image/svg+xml"));
    }

    #[test]
    fn cookie_headers() {
        assert_eq!(
            files_cookie_header("https://api.example", "org_a", "v", 3600),
            "ws_files=v; Path=/api/storage/private/workspaces/org_a/; Max-Age=3600; HttpOnly; SameSite=Lax; Secure"
        );
        assert_eq!(
            files_cookie_header("http://localhost", "org_a", "", 0),
            "ws_files=; Path=/api/storage/private/workspaces/org_a/; Max-Age=0; HttpOnly; SameSite=Lax"
        );
    }
}
