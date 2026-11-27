//! Per-entity access in the document inbox (ADR SEC-015), through the
//! books-purchases routers with the legal entity layer and real permission
//! resolution, on the real tenant schema (`WELDSUITE_TEST_TENANT_URL`, built
//! by `scripts/rust-test-db.ts`; returns early without it): a document is
//! filed under the entity of the bill created from it or of the record it is
//! linked to, and a member who is not listed on a restricted entity neither
//! lists, counts nor opens the documents filed under it, nor files one there.
//!
//! The database is shared with other crates' tests, so every row here has a
//! `_dent_` id and is removed before and after, every request names its
//! entity (the default entity is one per database), and the lists are read
//! for this test's rows only.

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
use weldsuite_books_domain::http::BooksState;
use weldsuite_db::{Tenant, TenantPermissionQueries, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::ApiError;
use weldsuite_permissions::PermissionGate;

const CLEANUP: &str = "
    delete from documents where id like '%\\_dent\\_%';
    delete from bills where entity_id like '%\\_dent\\_%';
    delete from entity_number_sequences where entity_id like '%\\_dent\\_%';
    delete from audit_log where accounting_entity_id like '%\\_dent\\_%' or entity_id like '%\\_dent\\_%';
    delete from accounting_entity_settings where entity_id like '%\\_dent\\_%';
    delete from legal_entity_members where entity_id like '%\\_dent\\_%' or user_id like '%\\_dent\\_%';
    delete from entities where id like '%\\_dent\\_%';
    delete from parties where id like '%\\_dent\\_%';
    delete from workspace_members where id like '%\\_dent\\_%';
";

/// Two entities, the second restricted to u_dent_admin; inbox documents in
/// no entity, and one already filed under the restricted entity with a status
/// no other test uses, so its count is this test's alone.
const SEED: &str = "
    insert into workspace_members (id, user_id, role, permissions, member_type) values
        ('wm_dent_admin', 'u_dent_admin', 'ADMIN', '[]', 'INTERNAL'),
        ('wm_dent_member', 'u_dent_member', 'MEMBER', '[]', 'INTERNAL');
    insert into entities (id, name, jurisdiction_code, base_currency, is_default, access_restricted) values
        ('ent_dent_open', 'Open BV', 'NL', 'EUR', false, false),
        ('ent_dent_secret', 'Secret BV', 'NL', 'EUR', false, true);
    insert into accounting_entity_settings (entity_id) values ('ent_dent_open'), ('ent_dent_secret');
    insert into legal_entity_members (id, entity_id, user_id, role_id) values
        ('lem_dent_admin', 'ent_dent_secret', 'u_dent_admin', null);
    insert into parties (id, display_name, role) values ('pty_dent_vendor', 'Supplier BV', 'supplier');
    insert into documents (id, file_name, file_key, status, entity_id) values
        ('doc_dent_inbox', 'inbox.pdf', 'workspaces/org_dent/accounting/inbox.pdf', 'pending', null),
        ('doc_dent_scan', 'scan.pdf', 'workspaces/org_dent/accounting/scan.pdf', 'processed', null),
        ('doc_dent_upload', 'upload.pdf', 'workspaces/org_dent/accounting/upload.pdf', 'pending', null),
        ('doc_dent_filed', 'filed.pdf', 'workspaces/org_dent/accounting/filed.pdf', 'dent_review', 'ent_dent_secret');
";

/// The books-purchases routers under `/api`, behind the legal entity layer
/// they carry, a permission gate on the tenant database and the test's
/// session (the `x-user` header).
fn app(db: &PgPool) -> Router {
    let gate = Arc::new(PermissionGate::new(|extensions: &Extensions| {
        extensions
            .get::<Tenant>()
            .map(|tenant| TenantPermissionQueries::new(tenant.db.clone()))
            .ok_or_else(ApiError::internal)
    }));
    let state = BooksState::new(EntityEventPublisher::new(None, TaskTracker::new()));
    let api = weldsuite_books_purchases::routers(&state, &gate)
        .into_iter()
        .fold(Router::new(), |api, (prefix, router)| {
            api.nest(prefix, router)
        });
    let db = db.clone();
    Router::new()
        .nest("/api", api)
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
                        workspace_id: "ws_dent".to_owned(),
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

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    user: &str,
    entity: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-user", user)
        .header("x-legal-entity-id", entity)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("infallible");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// This test's documents in the inbox list.
async fn listed(app: &Router, user: &str, entity: &str) -> Vec<String> {
    let (status, body) = call(app, "GET", "/api/accounting-documents", user, entity, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .expect("a list")
        .iter()
        .filter_map(|doc| doc["id"].as_str())
        .filter(|id| id.contains("_dent_"))
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids
}

/// The inbox counts, per status.
async fn counted(app: &Router, user: &str, entity: &str) -> Vec<Value> {
    let (status, body) = call(
        app,
        "GET",
        "/api/accounting-documents/stats",
        user,
        entity,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["data"].as_array().expect("counts").clone()
}

fn count_of(counts: &[Value], status: &str) -> Option<i64> {
    counts
        .iter()
        .find(|row| row["status"] == status)
        .and_then(|row| row["count"].as_i64())
}

/// The document's entity, status and linked record.
async fn document(db: &PgPool, id: &str) -> (Option<String>, String, Option<String>) {
    sqlx::query_as("select entity_id, status, linked_entity_id from documents where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("document")
}

fn bill(source_document: Option<&str>) -> Value {
    let mut body = json!({
        "contactId": "pty_dent_vendor",
        "contactName": "Supplier BV",
        "issueDate": "2026-03-01",
        "dueDate": "2026-03-31",
        "currency": "EUR",
    });
    if let Some(document) = source_document {
        body["sourceDocumentId"] = json!(document);
    }
    body
}

#[tokio::test]
async fn documents_follow_the_entity_of_what_they_are_linked_to() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&url, 4).expect("tenant pool");
    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");
    sqlx::raw_sql(SEED).execute(&db).await.expect("seed");
    scenario(&db).await;
    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");
}

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn scenario(db: &PgPool) {
    let app = app(db);
    let (admin, member) = ("u_dent_admin", "u_dent_member");
    let (open, secret) = ("ent_dent_open", "ent_dent_secret");

    // A bill created from a document files it under the bill's entity.
    let (status, created) = call(
        &app,
        "POST",
        "/api/bills",
        admin,
        secret,
        Some(bill(Some("doc_dent_scan"))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let secret_bill = created["data"]["id"].as_str().expect("bill id").to_owned();
    assert_eq!(
        document(db, "doc_dent_scan").await,
        (
            Some(secret.to_owned()),
            "linked".to_owned(),
            Some(secret_bill.clone())
        )
    );

    // Linking files it under the linked record's entity.
    let (status, linked) = call(
        &app,
        "PATCH",
        "/api/accounting-documents/doc_dent_upload/link",
        admin,
        secret,
        Some(json!({ "linkedEntityType": "bill", "linkedEntityId": secret_bill })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{linked}");
    assert_eq!(
        document(db, "doc_dent_upload").await.0.as_deref(),
        Some(secret)
    );

    // A member who is not listed on the restricted entity: its documents are
    // neither listed nor counted; the unfiled inbox stays theirs.
    assert_eq!(listed(&app, member, open).await, ["doc_dent_inbox"]);
    assert_eq!(
        count_of(&counted(&app, member, open).await, "dent_review"),
        None
    );
    // Naming the restricted entity resolves to none: nothing at all.
    let (status, none) = call(
        &app,
        "GET",
        "/api/accounting-documents",
        member,
        secret,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(none["data"], json!([]));
    assert_eq!(counted(&app, member, secret).await, Vec::<Value>::new());
    // By id: 404, whichever entity the header names.
    for entity in [open, secret] {
        for id in ["doc_dent_scan", "doc_dent_filed"] {
            let path = format!("/api/accounting-documents/{id}");
            let (status, _) = call(&app, "GET", &path, member, entity, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{id} in {entity}");
        }
    }
    let (status, _) = call(
        &app,
        "GET",
        "/api/accounting-documents/doc_dent_inbox",
        member,
        open,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Nor can they file a document under it by linking…
    let (status, _) = call(
        &app,
        "PATCH",
        "/api/accounting-documents/doc_dent_inbox/link",
        member,
        open,
        Some(json!({ "linkedEntityType": "bill", "linkedEntityId": secret_bill })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        document(db, "doc_dent_inbox").await,
        (None, "pending".to_owned(), None)
    );
    // …or move one out of it by creating a bill from it.
    let (status, _) = call(
        &app,
        "POST",
        "/api/bills",
        member,
        open,
        Some(bill(Some("doc_dent_scan"))),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        document(db, "doc_dent_scan").await.2.as_deref(),
        Some(secret_bill.as_str())
    );
    let open_bills: i64 = sqlx::query_scalar("select count(*) from bills where entity_id = $1")
        .bind(open)
        .fetch_one(db)
        .await
        .expect("bills");
    assert_eq!(open_bills, 0);

    // Their own bill files an inbox document under their entity.
    let (status, created) = call(&app, "POST", "/api/bills", member, open, Some(bill(None))).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, _) = call(
        &app,
        "PATCH",
        "/api/accounting-documents/doc_dent_inbox/link",
        member,
        open,
        Some(json!({ "linkedEntityType": "bill", "linkedEntityId": created["data"]["id"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        document(db, "doc_dent_inbox").await.0.as_deref(),
        Some(open)
    );
    assert_eq!(listed(&app, member, open).await, ["doc_dent_inbox"]);

    // The member listed on it sees its documents there, and the open
    // entity's there.
    assert_eq!(
        listed(&app, admin, secret).await,
        ["doc_dent_filed", "doc_dent_scan", "doc_dent_upload"]
    );
    assert_eq!(
        count_of(&counted(&app, admin, secret).await, "dent_review"),
        Some(1)
    );
    assert_eq!(listed(&app, admin, open).await, ["doc_dent_inbox"]);
    let (status, _) = call(
        &app,
        "GET",
        "/api/accounting-documents/doc_dent_scan",
        admin,
        secret,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
