//! An OIDC session (Zitadel-shaped, from the auth crate's fixture) through
//! the real middleware chain: `session_auth` → `workspace_db` → handler.
//!
//! On Kubernetes installs the identity provider's organization id is stored
//! where Global stores the Clerk org id, `workspaces.clerk_org_id`, so the
//! existing lookup (`w.id = $1 or w.clerk_org_id = $1`) resolves a Zitadel
//! organization without a schema change.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a throwaway database;
//! otherwise it returns early.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::routing::get;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;
use weldsuite_auth::{AuthContext, OidcSettings, SessionVerifier, session_auth};
use weldsuite_db::{Keyring, Tenant, WorkspaceConfig, Workspaces, master_pool, workspace_db};

const SCHEMA: &str = "
drop table if exists workspaces, workspace_licences, partners, workspace_database_moves cascade;
create table partners (id varchar(30) primary key, status varchar(20) not null default 'active');
create table workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    database_url text,
    is_active boolean not null default true,
    billing_mode varchar(20) not null default 'direct',
    partner_id varchar(30)
);
create table workspace_licences (
    workspace_id varchar(255) not null unique,
    allowed_apps jsonb not null default '[]',
    status varchar(20) not null default 'active'
);
create table workspace_database_moves (
    workspace_id varchar(255) not null,
    status varchar(20) not null default 'queued'
);
";

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../auth/tests/fixtures/oidc-tokens.json"))
        .expect("fixture parses")
}

#[tokio::test]
async fn a_zitadel_session_reaches_its_workspace() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let fixture = fixture();
    let org = fixture["org"].as_str().expect("org");

    let master = master_pool(&url, 2).expect("pool");
    sqlx::raw_sql(SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    // The workspace's Zitadel organization sits where the Clerk org id would.
    sqlx::query("insert into workspaces (id, clerk_org_id, database_url) values ('ws_eu', $1, $2)")
        .bind(org)
        .bind(&url)
        .execute(&master)
        .await
        .expect("seed");
    let workspaces = Arc::new(Workspaces::new(
        master,
        Keyring::default(),
        WorkspaceConfig::default(),
    ));

    let settings = OidcSettings::new(
        fixture["issuer"].as_str().expect("issuer"),
        vec![fixture["project"].as_str().expect("project").to_owned()],
    );
    let verifier = Arc::new(
        SessionVerifier::oidc_with_jwks(settings, &fixture["jwks"].to_string()).expect("jwks"),
    );
    let app = Router::new()
        .route(
            "/api/whoami",
            get(|auth: AuthContext, tenant: Tenant| async move {
                format!(
                    "{}|{}|{}",
                    auth.user_id,
                    tenant.workspace_id,
                    tenant.clerk_org_id.unwrap_or_default()
                )
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            workspaces,
            workspace_db,
        ))
        .layer(axum::middleware::from_fn_with_state(verifier, session_auth));

    let call = |token: &str| {
        let app = app.clone();
        let request = http::Request::builder()
            .uri("/api/whoami")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .expect("request");
        async move {
            let response = app.oneshot(request).await.expect("response");
            let status = response.status().as_u16();
            let body = response
                .into_body()
                .collect()
                .await
                .expect("body")
                .to_bytes();
            (status, String::from_utf8(body.to_vec()).expect("utf-8"))
        }
    };

    // `longLived` is valid on the real clock until 2096.
    let (status, body) = call(fixture["tokens"]["longLived"].as_str().expect("token")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        format!("{}|ws_eu|{org}", fixture["user"].as_str().expect("user"))
    );
}
