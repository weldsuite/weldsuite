//! The gate layers end to end: 401 without a session, 403 without the key,
//! the per-app check driven by `X-Weld-App`, and the log-only rollout mode.
// The fakes answer synchronously; the trait is async for the database.
#![allow(clippy::unused_async_trait_impl)]

use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::routing::get;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, app_context,
};

/// One member, granted companies in WeldCRM only.
struct OneMember;

impl PermissionQueries for OneMember {
    type Error = Infallible;

    async fn get_member(&self, user_id: &str) -> Result<Option<MemberRow>, Infallible> {
        Ok((user_id == "user_1").then(|| MemberRow {
            id: "mem_1".to_owned(),
            role: "MEMBER".to_owned(),
            role_id: Some("role_1".to_owned()),
            ..MemberRow::default()
        }))
    }

    async fn get_role_permissions(&self, _: &str) -> Result<Option<Vec<String>>, Infallible> {
        Ok(Some(vec!["weldcrm:companies:read".to_owned()]))
    }

    async fn get_team_permissions(&self, _: &str) -> Result<Vec<Vec<String>>, Infallible> {
        Ok(Vec::new())
    }
}

fn app(enforced: bool, user: Option<&str>) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(OneMember)).app_enforced(enforced));
    let router = Router::new()
        .route(
            "/companies",
            get(|permissions: Permissions| async move { format!("app={:?}", permissions.app()) })
                .route_layer(gate.require(["companies:read"])),
        )
        .route(
            "/team",
            get(|| async { "team" }).route_layer(gate.require(["team:read"])),
        )
        .route(
            "/check",
            get(|permissions: Permissions| async move {
                permissions.has_any(&["companies:read"]).to_string()
            })
            .route_layer(gate.resolve()),
        )
        .layer(axum::middleware::from_fn(app_context));
    match user {
        Some(user) => router.layer(axum::Extension(AuthContext {
            user_id: user.to_owned(),
            org_id: Some("org_1".to_owned()),
            session_id: String::new(),
            factor_verification_age: None,
        })),
        None => router,
    }
}

async fn call(router: Router, path: &str, weld_app: Option<&str>) -> (StatusCode, String) {
    let mut request = Request::builder().uri(path);
    if let Some(weld_app) = weld_app {
        request = request.header("X-Weld-App", weld_app);
    }
    let response = router
        .oneshot(request.body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8(body.to_vec()).expect("utf-8"))
}

#[tokio::test]
async fn without_a_session_it_is_401() {
    let (status, body) = call(app(true, None), "/companies", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body,
        r#"{"error":{"code":"UNAUTHORIZED","message":"Authentication required"},"success":false}"#
    );
}

#[tokio::test]
async fn a_missing_key_is_403() {
    let (status, body) = call(app(true, Some("user_1")), "/team", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains(r#""code":"FORBIDDEN""#), "{body}");

    let (status, _) = call(app(true, Some("user_nobody")), "/companies", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn keys_are_checked_in_the_request_app() {
    let (status, body) = call(app(true, Some("user_1")), "/companies", Some("crm")).await;
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::OK, r#"app=Some("weldcrm")"#)
    );

    // No app or `workspace`: allowed when any app grants it.
    let (status, _) = call(app(true, Some("user_1")), "/companies", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(app(true, Some("user_1")), "/companies", Some("workspace")).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "app=None"));

    // WeldDesk exposes companies but this member has them in WeldCRM only.
    let (status, _) = call(app(true, Some("user_1")), "/companies", Some("welddesk")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn log_only_mode_lets_a_per_app_refusal_through() {
    let (status, _) = call(app(false, Some("user_1")), "/companies", Some("welddesk")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn handlers_can_check_behind_the_resolve_layer() {
    let (status, body) = call(app(true, Some("user_1")), "/check", Some("weldcrm")).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "true"));
    let (_, body) = call(app(true, Some("user_1")), "/check", Some("welddesk")).await;
    assert_eq!(body, "false");
}
