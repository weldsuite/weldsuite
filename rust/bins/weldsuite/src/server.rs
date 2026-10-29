//! `weldsuite serve`: the HTTP API.
//!
//! Global middleware, outermost first: request id, request tracing, CORS and
//! the `X-Weld-App` app context, as in worker-kit's `createModuleApi`. Under
//! `/api` every request is authenticated (session token → tenant database),
//! as `apiAuth()` does.
//!
//! Probes for Kubernetes: `/livez` (the process answers), `/readyz` (the
//! master database answers and the pod is not draining). `/health` keeps the
//! workers' JSON shape.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::extract::{OriginalUri, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use weldsuite_auth::SessionVerifier;
use weldsuite_db::{TenantPermissionQueries, Workspaces};
use weldsuite_kit::{ApiError, api_cors, request_id};
use weldsuite_permissions::{PermissionGate, app_context};
use weldsuite_pipeline::FlagGate;

use crate::infra::Infra;

/// What the handlers share.
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) service: &'static str,
    pub(crate) environment: String,
    pub(crate) workspaces: Arc<Workspaces>,
    /// Unused by conformance builds, which take the test's context instead.
    #[cfg_attr(feature = "conformance", allow(dead_code))]
    pub(crate) verifier: Arc<SessionVerifier>,
    /// `PERMISSIONS_APP_ENFORCE`, reported to clients by `/api/me/permissions`.
    pub(crate) permissions_app_enforce: bool,
    /// Set on SIGTERM: `/readyz` fails so the pod leaves the Service first.
    pub(crate) draining: Arc<AtomicBool>,
    /// Events, realtime, cache and flag source.
    pub(crate) infra: Infra,
    /// `requirePermission(...)` for the routes.
    pub(crate) permissions: Arc<PermissionGate<TenantPermissionQueries>>,
    pub(crate) flags: Arc<FlagGate>,
    /// `SIGN_SESSION_SECRET`, for WeldSign.
    pub(crate) sign_session_secret: Option<Arc<str>>,
    /// What conformance builds record instead of publishing.
    #[cfg(feature = "conformance")]
    pub(crate) recorders: crate::conformance::Recorders,
}

impl AppState {
    /// The permission gate on the request's tenant database.
    pub(crate) fn permission_gate(
        app_enforced: bool,
    ) -> Arc<PermissionGate<TenantPermissionQueries>> {
        Arc::new(
            PermissionGate::new(|extensions| {
                extensions
                    .get::<weldsuite_db::Tenant>()
                    .map(|tenant| TenantPermissionQueries::new(tenant.db.clone()))
                    .ok_or_else(|| {
                        tracing::error!("permissions: no tenant database on the request");
                        ApiError::internal()
                    })
            })
            .app_enforced(app_enforced),
        )
    }
}

/// A per-request `PERMISSIONS_APP_ENFORCE`, set by conformance mode so a test
/// can run with enforcement on, as the workers read it per request.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AppEnforcedOverride(pub(crate) bool);

pub(crate) fn router(state: AppState) -> Router {
    // Layers run outside in, in `apiAuth()`'s order: session → tenant
    // database → licence and read-only → feature flags.
    // Hono answers a known path with the wrong method like an unknown path.
    let api = crate::routes::api(&state)
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.flags),
            weldsuite_pipeline::feature_flags,
        ))
        .layer(axum::middleware::from_fn(weldsuite_pipeline::licence_gate));
    let api = authenticated(api, &state);

    let root = Router::new();
    #[cfg(feature = "conformance")]
    let root = root.route(
        "/__conformance/side-effects",
        get(crate::conformance::side_effects),
    );
    root.route("/livez", get(livez))
        .route("/readyz", get(readyz))
        .route("/health", get(health))
        .route("/robots.txt", get(robots))
        .route("/config.json", get(config_json))
        .nest("/api", api)
        .fallback(not_found)
        .with_state(state)
        .layer(axum::middleware::from_fn(app_context))
        .layer(api_cors())
        // One INFO span per request, so the default `info` filter keeps it
        // for the trace exporter.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(tracing::Level::INFO)),
        )
        .layer(axum::middleware::from_fn(request_id))
}

/// Session token → tenant database, as `apiAuth()` does.
#[cfg(not(feature = "conformance"))]
fn authenticated(api: Router<AppState>, state: &AppState) -> Router<AppState> {
    api.layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.workspaces),
        weldsuite_db::workspace_db,
    ))
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.verifier),
        weldsuite_auth::clerk_auth,
    ))
}

/// Conformance builds take the test's context from a header instead.
#[cfg(feature = "conformance")]
fn authenticated(api: Router<AppState>, _state: &AppState) -> Router<AppState> {
    api.layer(axum::middleware::from_fn_with_state(
        Arc::new(crate::conformance::Pools::default()),
        crate::conformance::auth,
    ))
}

async fn livez() -> &'static str {
    "ok"
}

async fn readyz(State(state): State<AppState>) -> Response {
    if state.draining.load(Ordering::Relaxed) {
        return (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response();
    }
    match tokio::time::timeout(Duration::from_secs(2), state.workspaces.ping_master()).await {
        Ok(Ok(())) => "ok".into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "master database unavailable",
        )
            .into_response(),
    }
}

/// The workers' `/health`: a master-DB ping with its time.
async fn health(State(state): State<AppState>) -> Response {
    let start = Instant::now();
    let ping = tokio::time::timeout(Duration::from_secs(3), state.workspaces.ping_master()).await;
    let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    let (status, db_status, error) = match ping {
        Ok(Ok(())) if elapsed > 1000 => (StatusCode::OK, "warn", None),
        Ok(Ok(())) => (StatusCode::OK, "pass", None),
        Ok(Err(error)) => {
            tracing::warn!(%error, "health: master database ping failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "fail",
                Some("database error"),
            )
        }
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "fail", Some("timeout")),
    };
    let mut master_db = json!({
        "status": db_status,
        "componentType": "datastore",
        "observedValue": if status == StatusCode::OK { elapsed } else { 0 },
        "observedUnit": "ms",
    });
    if let Some(error) = error {
        master_db["error"] = json!(error);
    }
    let body = json!({
        "status": if status == StatusCode::OK { db_status } else { "fail" },
        "service": state.service,
        "environment": state.environment,
        "timestamp": iso_timestamp(),
        "checks": { "master_db": master_db },
    });
    (
        status,
        [(header::CACHE_CONTROL, "no-cache, no-store")],
        Json(body),
    )
        .into_response()
}

/// `GET /config.json`: what this backend offers, for the EU and self-hosted
/// frontends. `modules` is the core platform plus every module ported to Rust
/// (`RUST_PORTED_MODULES` in `@weldsuite/api-modules`); a client hides the
/// apps of any other module. Global never asks: it runs every module in
/// TypeScript.
async fn config_json() -> Response {
    let modules: Vec<&str> = std::iter::once("core")
        .chain(
            weldsuite_catalogs::api_modules()
                .iter()
                .filter(|module| module.rust && module.id != "core")
                .map(|module| module.id.as_str()),
        )
        .collect();
    (
        [(header::CACHE_CONTROL, "no-cache")],
        Json(json!({
            "backend": "rust",
            "version": env!("CARGO_PKG_VERSION"),
            "modules": modules,
        })),
    )
        .into_response()
}

async fn robots() -> &'static str {
    "User-agent: *\nDisallow: /\n"
}

/// `{ error: { code: 'NOT_FOUND', message: '<path> not found' } }`, with the
/// full path even inside `/api`.
async fn not_found(OriginalUri(uri): OriginalUri) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{} not found", uri.path()),
    )
}

/// `Date#toISOString()`: UTC, milliseconds, `Z`.
fn iso_timestamp() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// Resolves on SIGTERM or Ctrl-C: marks the pod as draining, waits
/// `delay` for the endpoints to update, then lets the server stop accepting
/// connections and finish the requests in flight.
pub(crate) async fn shutdown_signal(draining: Arc<AtomicBool>, delay: Duration) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "cannot listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!(delay_seconds = delay.as_secs(), "shutting down: draining");
    draining.store(true, Ordering::Relaxed);
    tokio::time::sleep(delay).await;
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;
    use weldsuite_db::{Keyring, WorkspaceConfig};

    use super::*;

    /// A master database nobody listens on, failing fast.
    fn unreachable_master() -> weldsuite_db::PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy("postgres://weldsuite:x@127.0.0.1:1/master")
            .expect("valid url")
    }

    fn state() -> AppState {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../crates/auth/tests/fixtures/clerk-tokens.json"
        ))
        .expect("fixture");
        let verifier = weldsuite_auth::ClerkVerifier::from_pem(
            fixture["publicKeyPem"].as_str().expect("pem"),
            None,
        )
        .expect("key");
        AppState {
            service: "weldsuite",
            environment: "test".to_owned(),
            workspaces: Arc::new(Workspaces::new(
                unreachable_master(),
                Keyring::default(),
                WorkspaceConfig::default(),
            )),
            verifier: Arc::new(verifier.into()),
            permissions_app_enforce: false,
            draining: Arc::new(AtomicBool::new(false)),
            infra: crate::infra::Infra::disconnected(weldsuite_events::TaskTracker::new()),
            permissions: AppState::permission_gate(false),
            flags: Arc::new(weldsuite_pipeline::FlagGate::new(
                Arc::new(weldsuite_ports::DefaultFlags),
                "test",
                None,
            )),
            sign_session_secret: None,
            #[cfg(feature = "conformance")]
            recorders: crate::conformance::Recorders::default(),
        }
    }

    async fn call(
        state: AppState,
        request: Request<Body>,
    ) -> (StatusCode, http::HeaderMap, String) {
        let response = router(state).oneshot(request).await.expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (
            status,
            headers,
            String::from_utf8(body.to_vec()).expect("utf-8"),
        )
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("request")
    }

    #[tokio::test]
    async fn liveness_needs_nothing() {
        let (status, headers, body) = call(state(), get("/livez")).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "ok"));
        assert!(headers.contains_key("x-request-id"));
    }

    #[tokio::test]
    async fn readiness_and_health_follow_the_master_database() {
        let (status, _, _) = call(state(), get("/readyz")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        let (status, headers, body) = call(state(), get("/health")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache, no-store");
        let body: Value = serde_json::from_str(&body).expect("json");
        assert_eq!(body["status"], "fail");
        assert_eq!(body["service"], "weldsuite");
        assert_eq!(body["checks"]["master_db"]["status"], "fail");
        assert_eq!(body["timestamp"].as_str().map(str::len), Some(24));
    }

    #[tokio::test]
    async fn a_draining_pod_is_not_ready() {
        let state = state();
        state.draining.store(true, Ordering::Relaxed);
        let (status, _, body) = call(state, get("/readyz")).await;
        assert_eq!(
            (status, body.as_str()),
            (StatusCode::SERVICE_UNAVAILABLE, "draining")
        );
    }

    #[tokio::test]
    async fn config_offers_core_and_the_ported_modules() {
        let (status, _, body) = call(state(), get("/config.json")).await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_str(&body).expect("json");
        assert_eq!(body["backend"], "rust");
        assert_eq!(body["modules"][0], "core");
        let ported = weldsuite_catalogs::api_modules()
            .iter()
            .filter(|m| m.rust)
            .count();
        assert_eq!(body["modules"].as_array().map(Vec::len), Some(ported + 1));
    }

    #[tokio::test]
    async fn unknown_paths_get_the_json_404() {
        let (status, _, body) = call(state(), get("/nope")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body,
            r#"{"error":{"code":"NOT_FOUND","message":"/nope not found"}}"#
        );
    }

    #[tokio::test]
    async fn the_api_needs_a_session() {
        for path in ["/api/me/permissions", "/api/not-a-route"] {
            let (status, _, body) = call(state(), get(path)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
            assert!(
                body.contains("Missing or invalid Authorization header"),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn first_party_origins_pass_cors() {
        let request = Request::builder()
            .method("OPTIONS")
            .uri("/api/me/permissions")
            .header("Origin", "https://app.weldsuite.org")
            .header("Access-Control-Request-Method", "GET")
            .body(Body::empty())
            .expect("request");
        let (status, headers, _) = call(state(), request).await;
        assert!(status.is_success(), "{status}");
        assert_eq!(
            headers["access-control-allow-origin"],
            "https://app.weldsuite.org"
        );
    }

    #[test]
    fn timestamps_look_like_to_iso_string() {
        let stamp = iso_timestamp();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'));
    }
}
