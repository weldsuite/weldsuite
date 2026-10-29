//! The public bundle host, `/public/user-apps/:code/*`
//! (`routes/public-user-apps/index.ts`). Unauthenticated: serves the live
//! version of an app's bundle from the public bucket so the platform can
//! iframe it at `/apps/{code}`.
//!
//! A public, approved app is open at its plain URL; every other bundle only
//! behind a signed, workspace-bound link in the path
//! (`/public/user-apps/:code/s/<link>/<asset>`, see [`crate::bundle_access`]).
//! Without a valid link the answer is the 404 of an unknown app.
//!
//! Responses never set `X-Frame-Options`; they carry `frame-ancestors` for
//! the platform origins only, `nosniff`, and `Access-Control-Allow-Origin: *`
//! so sandboxed iframes can load sibling assets. Service worker scripts are
//! refused.

use axum::Router;
use axum::body::Body;
use axum::extract::{OriginalUri, Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use aws_lc_rs::digest;
use http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, HOST};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::Value;
use weldsuite_kit::ApiError;

use crate::CoreAppsState;
use crate::access::{Public, now_ms};
use crate::bundle_access::{
    LinkRefusal, bundle_frame_ancestors, is_bundle_host_request, split_bundle_path,
    verify_bundle_capability, workspace_may_use_bundle_cached,
};
use crate::code_routes::decode_uri_component;
use crate::publish::resolve_bundle_for_code;
use crate::scopes::{content_type_for, has_file_extension, is_hashed_asset};

const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";
/// The browser never keeps a gated asset longer than this.
const MAX_PRIVATE_CACHE_SECONDS: i64 = 24 * 60 * 60;

pub(crate) fn router() -> Router<CoreAppsState> {
    Router::new()
        .route("/{code}", get(bare))
        .route("/{code}/", get(nested))
        .route("/{code}/{*rest}", get(nested))
}

fn json_error(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    ApiError::new(status, code, message).into_response()
}

fn not_found(message: impl Into<String>) -> Response {
    json_error(StatusCode::NOT_FOUND, "NOT_FOUND", message)
}

fn app_not_found(code: &str) -> Response {
    not_found(format!("App '{code}' not found"))
}

async fn bare(
    State(state): State<CoreAppsState>,
    public: Public,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Response {
    handle(&state, &public, &headers, &code, "").await
}

async fn nested(
    State(state): State<CoreAppsState>,
    public: Public,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    // `/public/user-apps/<code>/<rest>`: the code as Hono decodes a param
    // (kept as is when it doesn't decode), the rest with
    // `decodeURIComponent`.
    let path = uri.path();
    let after = path
        .find("/public/user-apps/")
        .map_or("", |at| &path[at + "/public/user-apps/".len()..]);
    let (segment, rest) = after.split_once('/').unwrap_or((after, ""));
    let code = decode_uri_component(segment).unwrap_or_else(|| segment.to_owned());
    let Some(rest) = decode_uri_component(rest) else {
        return not_found("Asset not found");
    };
    handle(&state, &public, &headers, &code, &rest).await
}

/// The request's origin as the client reached it.
pub(crate) fn request_origin(headers: &HeaderMap) -> String {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let host = header("x-forwarded-host")
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("localhost");
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    let host = match (scheme, host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name,
        _ => host,
    };
    format!("{scheme}://{}", host.to_ascii_lowercase())
}

async fn handle(state: &CoreAppsState, public: &Public, headers: &HeaderMap, code: &str, rest: &str) -> Response {
    match serve(state, public, headers, code, rest).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(error, "core-apps: bundle serve failed");
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Failed to serve app asset",
            )
        }
    }
}

async fn serve(
    state: &CoreAppsState,
    public: &Public,
    headers: &HeaderMap,
    code: &str,
    rest: &str,
) -> Result<Response, String> {
    let overrides = &public.overrides;
    let env = |key: &str| overrides.env(state, key);
    let Some(storage) = overrides.storage(state) else {
        return Ok(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Storage is not configured",
        ));
    };
    // A service worker would outlive the bundle on this origin.
    if headers
        .get("service-worker")
        .and_then(|v| v.to_str().ok())
        == Some("script")
    {
        return Ok(json_error(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Service workers are not available for WeldApps",
        ));
    }
    if !is_bundle_host_request(env, code, &request_origin(headers)) {
        return Ok(app_not_found(code));
    }
    let (token, asset_path) = split_bundle_path(rest);
    if asset_path.split('/').any(|segment| segment == "..") {
        return Ok(not_found("Asset not found"));
    }

    let master = overrides.master(state);
    let cache = overrides.cache(state).map_err(|_| "no cache".to_owned())?;
    let Some(bundle) = resolve_bundle_for_code(&master, cache.as_ref(), code)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(app_not_found(code));
    };
    let field = |key: &str| match bundle.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(other) => other.to_string(),
        None => "undefined".to_owned(),
    };

    let mut gated_until: Option<i64> = None;
    if bundle.get("requiresToken") != Some(&Value::Bool(false)) {
        let Some(token) = token else {
            return Ok(app_not_found(code));
        };
        let app_id = field("appId");
        let (workspace_id, expires_at) = match verify_bundle_capability(env, &app_id, token, now_ms()) {
            Ok(verdict) => verdict,
            Err(LinkRefusal::Expired) => {
                return Ok(json_error(
                    StatusCode::FORBIDDEN,
                    "BUNDLE_LINK_EXPIRED",
                    "This app link has expired. Reload the app.",
                ));
            }
            Err(refusal) => {
                if refusal == LinkRefusal::Unconfigured {
                    tracing::error!("core-apps: no bundle signing secret configured; refusing a gated bundle");
                }
                return Ok(app_not_found(code));
            }
        };
        let allowed = workspace_may_use_bundle_cached(&master, cache.as_ref(), &app_id, &workspace_id)
            .await
            .map_err(|error| error.to_string())?;
        if !allowed {
            return Ok(app_not_found(code));
        }
        gated_until = Some(expires_at);
    }

    // SPA fallback: no path, or one without an extension, is the entrypoint.
    let serve_path = if !asset_path.is_empty() && has_file_extension(asset_path) {
        asset_path.to_owned()
    } else {
        field("entrypoint")
    };
    let key = format!("{}/{serve_path}", field("bundleKey"));
    // A key no upload could have written is simply not there.
    if !weldsuite_ports::files::is_safe_key(&key) {
        return Ok(not_found("Asset not found"));
    }
    let Some(object) = storage.get_boxed(&key).await.map_err(|error| error.to_string())? else {
        return Ok(not_found("Asset not found"));
    };

    let content_type = object
        .info
        .content_type
        .clone()
        .or_else(|| content_type_for(&serve_path).map(str::to_owned))
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let etag = format!(
        "\"{}\"",
        &hex::encode(digest::digest(&digest::SHA256, &object.bytes))[..32]
    );
    let mut response = Response::new(Body::from(object.bytes));
    let out = response.headers_mut();
    let mut set = |name: http::HeaderName, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            out.insert(name, value);
        }
    };
    set(CONTENT_TYPE, &content_type);
    set(ETAG, &etag);
    // Embedding is the point, but only by the platform.
    set(
        http::header::CONTENT_SECURITY_POLICY,
        &bundle_frame_ancestors(env),
    );
    set(http::header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    set(
        http::HeaderName::from_static("cross-origin-resource-policy"),
        "cross-origin",
    );
    match gated_until {
        None => set(
            CACHE_CONTROL,
            if is_hashed_asset(&serve_path) {
                IMMUTABLE_CACHE
            } else {
                "no-cache"
            },
        ),
        Some(until) => {
            // The URL carries a capability: no shared caches, never past the
            // link's expiry, and only the origin as Referer.
            let remaining = ((until - now_ms()).div_euclid(1000)).max(0);
            let value = if is_hashed_asset(&serve_path) {
                format!("private, max-age={}", remaining.min(MAX_PRIVATE_CACHE_SECONDS))
            } else {
                "private, no-cache".to_owned()
            };
            set(CACHE_CONTROL, &value);
            set(http::header::REFERRER_POLICY, "strict-origin");
        }
    }
    Ok(response)
}
