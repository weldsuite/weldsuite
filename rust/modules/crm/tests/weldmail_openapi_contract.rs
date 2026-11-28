//! The contacts the native WeldMail apps read (`/api/people`: recipient
//! suggestions in the composer, the sender's contact card), held against the
//! file they generate their client from (`apps/mobile-shared/openapi/weldmail.yaml`).
//! The file's mail operations are checked in
//! `rust/modules/mail/tests/openapi_contract.rs`; these four here, through the
//! CRM router as the server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). Change the file with the routes, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test's contacts are on their own domain, cleaned at its start.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys::{
    PEOPLE_CREATE, PEOPLE_READ, PEOPLE_SCOPE_ALL, PEOPLE_UPDATE,
};
use weldsuite_crm::{CrmServices, CrmState};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const ORG: &str = "org_mail_native_people";
const USER: &str = "user_mail_native_people";

/// The operations of weldmail.yaml checked here.
const PEOPLE_OPERATIONS: &[&str] = &["listPeople", "createPerson", "getPerson", "updatePerson"];

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

/// `/api/people` behind the session, tenant and permission layers, for a
/// member who may read, add and change every contact.
fn app(db: PgPool) -> Router {
    let state = CrmState {
        services: CrmServices {
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            realtime: None,
            files: None,
            cache: None,
            jobs: None,
            env: Arc::default(),
        },
        chat_api: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [PEOPLE_READ, PEOPLE_CREATE, PEOPLE_UPDATE, PEOPLE_SCOPE_ALL]
            .map(str::to_owned)
            .to_vec(),
        ..ResolvedPermissions::default()
    };
    let api: Router = weldsuite_crm::router(state, &gate);
    Router::new()
        .nest("/api", api)
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_mail_native_people".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_mail_native_people".to_owned(),
                    clerk_org_id: Some(ORG.to_owned()),
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

/// Drop the contacts an earlier run left, and make the caller a member of the
/// workspace: a new contact's owner is the caller, who must be one.
async fn clean(db: &PgPool) {
    sqlx::query("delete from people where email like '%@people.native-contract.test'")
        .execute(db)
        .await
        .expect("clean");
    sqlx::query("delete from workspace_members where id = 'wm_mail_native_people' or user_id = $1")
        .bind(USER)
        .execute(db)
        .await
        .expect("clean the member");
    sqlx::query(
        "insert into workspace_members (id, user_id, email, name, role, status, member_type) \
         values ('wm_mail_native_people', $1, 'owner@people.native-contract.test', 'Mail Owner', 'ADMIN', 'ACTIVE', 'INTERNAL')",
    )
    .bind(USER)
    .execute(db)
    .await
    .expect("the caller as a member");
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// Each contact operation of weldmail.yaml: a contact added by address (as
/// the composer adds a new recipient), found by searching for it, read, and
/// given a name, phone and note on the contact card.
#[tokio::test]
async fn people_answer_what_the_native_mail_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    clean(&db).await;
    let app = app(db.clone());
    let contract = Contract::load("weldmail");

    contract
        .success(&app, "listPeople", &[], &[("limit", "10")], None)
        .await;
    let person = id(&contract
        .success(
            &app,
            "createPerson",
            &[],
            &[],
            Some(&json!({ "email": "grace@people.native-contract.test" })),
        )
        .await);
    let found = contract
        .success(
            &app,
            "listPeople",
            &[],
            &[("search", "grace"), ("limit", "10")],
            None,
        )
        .await;
    assert!(
        found["data"]
            .as_array()
            .is_some_and(|people| people.iter().any(|p| p["id"] == person.as_str())),
        "{found}"
    );
    contract
        .success(
            &app,
            "getPerson",
            &[("personId", person.as_str())],
            &[],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "updatePerson",
            &[("personId", person.as_str())],
            &[],
            Some(&json!({
                "firstName": "Grace",
                "lastName": "Hopper",
                "directPhone": "+31 20 123 4567",
                "notes": "Met at the conference",
            })),
        )
        .await;
    contract
        .success(
            &app,
            "getPerson",
            &[("personId", person.as_str())],
            &[],
            None,
        )
        .await;

    clean(&db).await;
    contract.finish_only(PEOPLE_OPERATIONS);
}
