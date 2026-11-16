//! An OIDC session (Zitadel-shaped, from the auth crate's fixture) through
//! the real middleware chain: `session_auth` → `workspace_db` → handler.
//!
//! On Kubernetes installs the identity provider's organization id is stored
//! where Global stores the Clerk org id, `workspaces.clerk_org_id`, so the
//! existing lookup (`w.id = $1 or w.clerk_org_id = $1`) resolves a Zitadel
//! organization without a schema change.
//!
//! In membership mode (`OIDC_WORKSPACE_SOURCE=header`) the same session
//! names its workspace in `X-Weld-Workspace` instead, checked against the
//! master `user_workspaces` by `workspace_from_header`.
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
use weldsuite_auth::{AuthContext, OidcSettings, SessionVerifier, WorkspaceSource, session_auth};
use weldsuite_db::{
    Keyring, MembershipLookup, Tenant, WorkspaceConfig, WorkspaceSelector, Workspaces, master_pool,
    workspace_db, workspace_from_header,
};

const SCHEMA: &str = "
drop table if exists workspaces, workspace_licences, partners, workspace_database_moves, user_workspaces cascade;
create table partners (id varchar(30) primary key, status varchar(20) not null default 'active');
create table workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    slug varchar(255) not null unique,
    database_url text,
    is_active boolean not null default true,
    billing_mode varchar(20) not null default 'direct',
    partner_id varchar(30),
    deleted_at timestamp
);
create table user_workspaces (
    id varchar(30) primary key,
    user_id varchar(255) not null,
    workspace_id varchar(255) not null references workspaces (id) on delete cascade,
    role varchar(50) not null default 'org:member',
    status varchar(20) not null default 'ACTIVE',
    unique (user_id, workspace_id)
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

async fn call(app: &Router, token: &str, workspace: Option<&str>) -> (u16, String) {
    let mut request = http::Request::builder()
        .uri("/api/whoami")
        .header("authorization", format!("Bearer {token}"));
    if let Some(workspace) = workspace {
        request = request.header("x-weld-workspace", workspace);
    }
    let request = request.body(Body::empty()).expect("request");
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8(body.to_vec()).expect("utf-8"))
}

#[tokio::test]
async fn a_zitadel_session_reaches_its_workspace() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let fixture = fixture();
    let org = fixture["org"].as_str().expect("org");
    let user = fixture["user"].as_str().expect("user");

    let master = master_pool(&url, 2).expect("pool");
    sqlx::raw_sql(SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    // The workspace's Zitadel organization sits where the Clerk org id would.
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, slug, database_url) values ('ws_eu', $1, 'eu', $2)",
    )
    .bind(org)
    .bind(&url)
    .execute(&master)
    .await
    .expect("seed");
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig::default(),
    ));

    let settings = OidcSettings::new(
        fixture["issuer"].as_str().expect("issuer"),
        vec![fixture["project"].as_str().expect("project").to_owned()],
    );
    let jwks = fixture["jwks"].to_string();
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
            Arc::clone(&workspaces),
            workspace_db,
        ));
    let claim_verifier =
        Arc::new(SessionVerifier::oidc_with_jwks(settings.clone(), &jwks).expect("jwks"));
    let claim_mode = app.clone().layer(axum::middleware::from_fn_with_state(
        claim_verifier,
        session_auth,
    ));

    // `longLived` is valid on the real clock until 2096.
    let token = fixture["tokens"]["longLived"].as_str().expect("token");
    let (status, body) = call(&claim_mode, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, format!("{user}|ws_eu|{org}"));

    // Membership mode: the claim is ignored, the header names the workspace.
    let header_settings = OidcSettings {
        workspace_source: WorkspaceSource::Header,
        ..settings
    };
    let header_verifier =
        Arc::new(SessionVerifier::oidc_with_jwks(header_settings, &jwks).expect("jwks"));
    let lookup: Arc<dyn MembershipLookup> = workspaces.clone();
    let header_mode = app
        .layer(axum::middleware::from_fn_with_state(
            WorkspaceSelector::new(lookup),
            workspace_from_header,
        ))
        .layer(axum::middleware::from_fn_with_state(
            header_verifier,
            session_auth,
        ));
    // No membership yet: refused, whatever the workspace is called by.
    for reference in ["ws_eu", "eu", org] {
        let (status, body) = call(&header_mode, token, Some(reference)).await;
        assert_eq!(status, 403, "{reference}: {body}");
    }
    sqlx::query(
        "insert into user_workspaces (id, user_id, workspace_id) values ('uw_1', $1, 'ws_eu')",
    )
    .bind(user)
    .execute(&master)
    .await
    .expect("membership");
    for reference in ["ws_eu", "eu", org] {
        let (status, body) = call(&header_mode, token, Some(reference)).await;
        assert_eq!(status, 200, "{reference}: {body}");
        assert_eq!(body, format!("{user}|ws_eu|{org}"));
    }
    // Without the header there is no workspace, as without an org claim.
    let (status, body) = call(&header_mode, token, None).await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains("ORG_REQUIRED"), "{body}");
}
