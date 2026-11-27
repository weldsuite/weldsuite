//! `POST /api/search` against the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`): WeldBooks invoices and bills are
//! found only in the legal entities the caller may read them in (ADR SEC-015,
//! `weldsuite_legal_entities::access`). A restricted entity's records stay
//! hidden from a member who is not listed on it, admins included; a listed
//! member and the owner find them; an entity where the member's entity role
//! doesn't grant the type is left out.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
//! The tenant database is shared with other crates' tests, so every row here
//! has a `_sea_` id and is removed before and after, and the search term
//! (`seaq7`) matches only these rows.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use http::{Extensions, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_core_files::{CoreFilesState, StorageState, search_router};
use weldsuite_db::{Tenant, TenantPermissionQueries, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::ApiError;
use weldsuite_permissions::PermissionGate;

const CLEANUP: &str = "
    delete from invoices where id like '%\\_sea\\_%';
    delete from bills where id like '%\\_sea\\_%';
    delete from legal_entity_members where id like '%\\_sea\\_%';
    delete from entities where id like '%\\_sea\\_%';
    delete from workspace_members where id like '%\\_sea\\_%';
    delete from roles where id like '%\\_sea\\_%';
";

/// Two entities open to everyone, one restricted; a workspace role that reads
/// invoices and bills, and an entity role that doesn't.
const SEED: &str = r#"
    insert into roles (id, name, is_system, permissions) values
        ('role_sea_books', 'Bookkeeper', false, '["invoices:read","bills:read"]'),
        ('role_sea_hr', 'HR only', false, '["weldhr:employees:read"]');
    insert into workspace_members (id, user_id, role, role_id, permissions, member_type) values
        ('wm_sea_member', 'u_sea_member', 'MEMBER', 'role_sea_books', '[]', 'INTERNAL'),
        ('wm_sea_listed', 'u_sea_listed', 'MEMBER', 'role_sea_books', '[]', 'INTERNAL'),
        ('wm_sea_admin', 'u_sea_admin', 'ADMIN', null, '[]', 'INTERNAL'),
        ('wm_sea_owner', 'u_sea_owner', 'OWNER', null, '[]', 'INTERNAL');
    insert into entities (id, name, jurisdiction_code, base_currency, is_default, access_restricted) values
        ('ent_sea_open', 'Open BV', 'NL', 'EUR', false, false),
        ('ent_sea_secret', 'Secret BV', 'NL', 'EUR', false, true),
        ('ent_sea_role', 'HR BV', 'NL', 'EUR', false, false);
    insert into legal_entity_members (id, entity_id, user_id, role_id) values
        ('lem_sea_listed', 'ent_sea_secret', 'u_sea_listed', null),
        ('lem_sea_role', 'ent_sea_role', 'u_sea_member', 'role_sea_hr');
    insert into invoices (id, invoice_number, contact_id, contact_name, status, issue_date, due_date, entity_id) values
        ('inv_sea_open', 'SEAQ7-OPEN', 'con_sea', 'Acme', 'sent', '2026-11-01', '2026-12-01', 'ent_sea_open'),
        ('inv_sea_secret', 'SEAQ7-SECRET', 'con_sea', 'Acme', 'sent', '2026-11-01', '2026-12-01', 'ent_sea_secret'),
        ('inv_sea_role', 'SEAQ7-ROLE', 'con_sea', 'Acme', 'sent', '2026-11-01', '2026-12-01', 'ent_sea_role');
    insert into bills (id, bill_number, contact_id, contact_name, status, issue_date, due_date, entity_id) values
        ('bill_sea_open', 'SEAQ7-OPEN', 'con_sea', 'Acme', 'open', '2026-11-01', '2026-12-01', 'ent_sea_open'),
        ('bill_sea_secret', 'SEAQ7-SECRET', 'con_sea', 'Acme', 'open', '2026-11-01', '2026-12-01', 'ent_sea_secret'),
        ('bill_sea_role', 'SEAQ7-ROLE', 'con_sea', 'Acme', 'open', '2026-11-01', '2026-12-01', 'ent_sea_role');
"#;

#[tokio::test]
async fn search_finds_invoices_and_bills_only_in_entities_the_caller_may_read() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");
    sqlx::raw_sql(SEED).execute(&db).await.expect("seed");
    let app = app(&db);

    // Not listed on the restricted entity, and an entity role without
    // invoices or bills in the third: only the open entity's records.
    assert_eq!(
        found(&app, "u_sea_member").await,
        expected(&["inv_sea_open"], &["bill_sea_open"])
    );
    // Listed on the restricted entity (with the workspace role).
    assert_eq!(
        found(&app, "u_sea_listed").await,
        expected(
            &["inv_sea_open", "inv_sea_role", "inv_sea_secret"],
            &["bill_sea_open", "bill_sea_role", "bill_sea_secret"]
        )
    );
    // An admin manages access but sees a restricted entity only when listed.
    assert_eq!(
        found(&app, "u_sea_admin").await,
        expected(
            &["inv_sea_open", "inv_sea_role"],
            &["bill_sea_open", "bill_sea_role"]
        )
    );
    // The owner sees every entity.
    assert_eq!(
        found(&app, "u_sea_owner").await,
        expected(
            &["inv_sea_open", "inv_sea_role", "inv_sea_secret"],
            &["bill_sea_open", "bill_sea_role", "bill_sea_secret"]
        )
    );

    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");
}

fn expected(invoices: &[&str], bills: &[&str]) -> (Vec<String>, Vec<String>) {
    let owned = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect();
    (owned(invoices), owned(bills))
}

/// `/api/search` behind a session (the `x-user` header) and the tenant
/// database, its permissions resolved from the tenant's roles.
fn app(db: &PgPool) -> Router {
    let gate = Arc::new(PermissionGate::new(|extensions: &Extensions| {
        extensions
            .get::<Tenant>()
            .map(|tenant| TenantPermissionQueries::new(tenant.db.clone()))
            .ok_or_else(ApiError::internal)
    }));
    let state = CoreFilesState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        files: None,
        public_files_url: None,
        storage: StorageState::default(),
        ai: None,
        master: None,
    };
    let db = db.clone();
    Router::new()
        .nest("/api/search", search_router(state, &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: Request, next: Next| {
                let db = db.clone();
                async move {
                    let user = request
                        .headers()
                        .get("x-user")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    request.extensions_mut().insert(AuthContext {
                        user_id: user,
                        org_id: None,
                        session_id: String::new(),
                        factor_verification_age: None,
                    });
                    request.extensions_mut().insert(Tenant {
                        workspace_id: "ws_sea".to_owned(),
                        clerk_org_id: None,
                        db,
                        suspended: false,
                        restrictions: WorkspaceRestrictions::default(),
                    });
                    next.run(request).await
                }
            },
        ))
}

/// The ids of the invoices and the bills `user` finds for `seaq7`, sorted.
async fn found(app: &Router, user: &str) -> (Vec<String>, Vec<String>) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("x-user", user)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "q": "seaq7", "types": ["invoice", "bill"], "limit": 10 }).to_string(),
        ))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("infallible");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::OK, "{user}: {body}");
    let ids = |kind: &str| -> Vec<String> {
        let mut ids: Vec<String> = body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|group| group["type"] == kind)
            .flat_map(|group| group["items"].as_array().cloned().unwrap_or_default())
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect();
        ids.sort();
        ids
    };
    (ids("invoice"), ids("bill"))
}
