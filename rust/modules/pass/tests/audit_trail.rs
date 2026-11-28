//! A read that discloses a value always leaves its trail row, whatever the
//! caller sends: a forged `CF-Connecting-IP` or an over-long
//! `X-Forwarded-For` once failed the row's insert (the `ip` column holds 45
//! characters), the failure was swallowed and the password went out anyway.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test has its own workspace, cleaned at its start.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_pass::{PassState, ReqwestTransport, RootKeyring};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const ROOT: &str = "7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
/// `weldpass_*.workspace_id`: the organization id.
const WORKSPACE: &str = "org_pass_audit_trail";
const USER: &str = "user_pass_audit_trail";

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// `/api/weldpass` behind the session, tenant and permission layers, one
/// proxy in front.
fn app(db: PgPool) -> Router {
    let state = PassState {
        root_keys: RootKeyring::from_values(Some(ROOT), None),
        http: Arc::new(ReqwestTransport::new()),
        sync: false,
        trusted_proxies: 1,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: ["passwords:use", "secrets:read", "secrets:reveal"]
            .map(str::to_owned)
            .to_vec(),
        ..ResolvedPermissions::default()
    };
    Router::new()
        .nest("/api/weldpass", weldsuite_pass::router(state, &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(WORKSPACE.to_owned()),
                    session_id: "sess_pass_audit_trail".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_pass_audit_trail".to_owned(),
                    clerk_org_id: Some(WORKSPACE.to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                request.extensions_mut().insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    USER.to_owned(),
                ));
                next.run(request)
            },
        ))
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 2).expect("tenant pool"))
}

/// Drop what an earlier run left in the test's workspace.
async fn clean(db: &PgPool) {
    for statement in [
        "delete from weldpass_vault_events where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_item_versions where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_items where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vault_members where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vaults where workspace_id = $1",
    ] {
        sqlx::query(statement)
            .bind(WORKSPACE)
            .execute(db)
            .await
            .expect("clean");
    }
}

/// One request: its status and JSON body (`Null` when there is none).
async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = match body {
        Some(body) => request
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .expect("a request");
    let response = app.clone().oneshot(request).await.expect("an answer");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("a body");
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

/// The `ip` of each `item.revealed` row of `vault_id`, oldest first.
async fn reveal_rows(db: &PgPool, vault_id: &str) -> Vec<Option<String>> {
    sqlx::query_scalar(
        "select ip from weldpass_vault_events \
         where vault_id = $1 and action = 'item.revealed' order by created_at, id",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await
    .expect("the trail")
}

#[tokio::test]
async fn a_reveal_always_leaves_its_row() {
    let Some(db) = tenant() else {
        return;
    };
    clean(&db).await;
    let app = app(db.clone());

    let (status, vaults) = send(&app, "GET", "/api/weldpass/vaults", &[], None).await;
    assert_eq!(status, StatusCode::OK, "{vaults}");
    let vault = vaults["data"][0]["id"]
        .as_str()
        .expect("the personal vault")
        .to_owned();
    let (status, item) = send(
        &app,
        "POST",
        &format!("/api/weldpass/vaults/{vault}/items"),
        &[],
        Some(&json!({
            "type": "login",
            "title": "Router",
            "url": "https://router.example",
            "fields": { "username": "admin", "password": "correct horse" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{item}");
    let item = item["data"]["id"].as_str().expect("the item").to_owned();
    let reveal = format!("/api/weldpass/vaults/{vault}/items/{item}/reveal");

    // Headers a client can write, far longer than the `ip` column.
    let long = "a".repeat(200);
    let (status, revealed) = send(
        &app,
        "GET",
        &reveal,
        &[("cf-connecting-ip", &long), ("x-forwarded-for", &long)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revealed}");
    assert_eq!(revealed["data"]["fields"]["password"], "correct horse");
    assert_eq!(reveal_rows(&db, &vault).await, vec![None]);

    // The address the proxy appended, never the client's own claim.
    let (status, _) = send(
        &app,
        "GET",
        &reveal,
        &[
            ("cf-connecting-ip", "192.0.2.1"),
            ("x-forwarded-for", "192.0.2.2, 203.0.113.9"),
        ],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        reveal_rows(&db, &vault).await,
        vec![None, Some("203.0.113.9".to_owned())]
    );
}

/// `?format=` with a NUL once failed the export's trail row (jsonb holds no
/// `\u0000`), and every value went out as JSON anyway.
#[tokio::test]
async fn an_export_takes_only_its_two_formats() {
    let Some(db) = tenant() else {
        return;
    };
    let app = app(db);
    for format in ["%00", "xml"] {
        let (status, body) = send(
            &app,
            "GET",
            &format!("/api/weldpass/projects/wpp_none/environments/wpe_none/secrets/export?format={format}"),
            &[],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{format}: {body}");
    }
}
