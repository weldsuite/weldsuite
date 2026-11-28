//! What the native WeldBooks apps read from the ledger, held against the
//! file they generate their client from
//! (`apps/mobile-shared/openapi/weldbooks.yaml`): its company and chart of
//! accounts operations, sent as the file describes them through this crate's
//! routers as the server mounts them, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's other operations are
//! checked by the other books crates' tests (`books-banking`,
//! `books-purchases`, `books-reports`, `books-sales`, `books-sales-tax`,
//! `books-tax`). A change to these routes that would break the apps fails
//! here; change the file with it, as `apps/mobile-shared/README.md`
//! ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with every other crate's tests and is not wiped
//! between runs, so the companies are created through the API (new ids each
//! run) with names carrying a tag from the clock. The company is named by
//! the `X-Accounting-Entity-Id` header, as the apps name it.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use http::HeaderValue;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_books::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_ledger_openapi";
const ORG: &str = "org_books_ledger_openapi";
const WORKSPACE: &str = "ws_books_ledger_openapi";

/// The operations of weldbooks.yaml this crate serves.
const LEDGER_OPERATIONS: &[&str] = &[
    "listAccountingEntities",
    "createAccountingEntity",
    "listJurisdictions",
    "getAccountingEntity",
    "updateAccountingEntity",
    "listGlAccounts",
];

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

/// The ledger routers under `/api`, behind the session, tenant and
/// permission layers, for the workspace owner; `entity` is the company the
/// requests name.
fn app(db: &PgPool, entity: Option<&str>) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let books = BooksState::new(EntityEventPublisher::new(None, TaskTracker::new()));
    let resolved = ResolvedPermissions {
        permissions: vec!["*".to_owned()],
        role: "OWNER".to_owned(),
        is_owner: true,
        ..ResolvedPermissions::default()
    };
    let entity = entity.map(|id| HeaderValue::from_str(id).expect("an entity id"));
    let db = db.clone();
    weldsuite_books::routers(&books, &gate)
        .into_iter()
        .fold(Router::new(), |router, (prefix, routes)| {
            router.nest(&format!("/api{prefix}"), routes)
        })
        .layer(axum::middleware::from_fn(
            move |mut request: Request, next: Next| {
                if let Some(entity) = &entity {
                    request
                        .headers_mut()
                        .insert("x-accounting-entity-id", entity.clone());
                }
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_books_ledger_openapi".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: WORKSPACE.to_owned(),
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

/// A tag unique to this run, for the companies' names.
fn run_tag() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{:x}", nanos & 0xff_ffff_ffff)
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// Every ledger operation of weldbooks.yaml: the countries, three companies
/// (a Dutch one with every invoice field and the seeded chart, a bare Dutch
/// one, an American LLC with its entity type and tax classification) listed,
/// read and one of them changed, and the chart of accounts, whole and by
/// type; then the refusals of an unknown country and an unknown company.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn books_ledger_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let run = run_tag();
    let workspace = app(&db, None);
    let contract = Contract::load("weldbooks");

    let jurisdictions = contract
        .success(&workspace, "listJurisdictions", &[], &[], None)
        .await;
    let codes: Vec<&str> = jurisdictions["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|jurisdiction| jurisdiction["code"].as_str())
        .collect();
    assert!(codes.contains(&"NL") && codes.contains(&"US"), "{codes:?}");

    // A Dutch company with everything an invoice needs, and its chart.
    let dutch = json!({
        "name": format!("Ledger contract {run}"),
        "legalName": format!("Ledger contract {run} B.V."),
        "jurisdictionCode": "NL",
        "baseCurrency": "EUR",
        "taxIdentifiers": { "vatNumber": "NL123456789B01", "registrationNumber": "12345678" },
        "bankDetails": { "iban": "NL91ABNA0417164300", "bic": "ABNANL2A", "bankName": "ABN AMRO" },
        "address": {
            "line1": "Damrak 1",
            "city": "Amsterdam",
            "postalCode": "1012 LG",
            "country": "nl",
        },
        "seedDefaults": true,
    });
    let created = contract
        .success(&workspace, "createAccountingEntity", &[], &[], Some(&dutch))
        .await;
    assert!(
        created["data"]["accountsCreated"]
            .as_u64()
            .is_some_and(|count| count > 0),
        "the chart was seeded: {created}"
    );
    let dutch_id = id(&created);
    // A bare one: no tax ids, bank details or address, no chart.
    let bare = json!({
        "name": format!("Ledger contract {run} bare"),
        "jurisdictionCode": "NL",
        "seedDefaults": false,
    });
    let bare_id = id(&contract
        .success(&workspace, "createAccountingEntity", &[], &[], Some(&bare))
        .await);
    // An American LLC: an entity type, its default tax classification.
    let american = json!({
        "name": format!("Ledger contract {run} LLC"),
        "jurisdictionCode": "US",
        "entityType": "single_member_llc",
        "dba": "Ledger Coffee",
        "address": {
            "line1": "100 Congress Ave",
            "city": "Austin",
            "state": "tx",
            "postalCode": "78701",
            "country": "US",
        },
        "seedDefaults": false,
    });
    let american_id = id(&contract
        .success(
            &workspace,
            "createAccountingEntity",
            &[],
            &[],
            Some(&american),
        )
        .await);

    let entities = contract
        .success(&workspace, "listAccountingEntities", &[], &[], None)
        .await;
    for created in [&dutch_id, &bare_id, &american_id] {
        assert!(
            entities["data"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["id"] == created.as_str())),
            "{created} is listed: {entities}"
        );
    }

    // Each company read with the header naming it.
    for entity in [&dutch_id, &bare_id, &american_id] {
        let scoped = app(&db, Some(entity));
        let read = contract
            .success(
                &scoped,
                "getAccountingEntity",
                &[("id", entity.as_str())],
                &[],
                None,
            )
            .await;
        assert_eq!(read["data"]["id"], entity.as_str());
    }

    let ledger = app(&db, Some(&dutch_id));
    let changes = json!({
        "name": format!("Ledger contract {run} renamed"),
        "taxIdentifiers": { "vatNumber": "NL987654321B02" },
        "bankDetails": { "iban": "NL91ABNA0417164300", "bic": "ABNANL2A", "bankName": "ABN AMRO Bank" },
        "address": {
            "line1": "Herengracht 100",
            "line2": "3rd floor",
            "city": "Amsterdam",
            "postalCode": "1015 BS",
            "country": "NL",
        },
    });
    let updated = contract
        .success(
            &ledger,
            "updateAccountingEntity",
            &[("id", dutch_id.as_str())],
            &[],
            Some(&changes),
        )
        .await;
    assert_eq!(
        updated["data"]["taxIdentifiers"]["vatNumber"], "NL987654321B02",
        "{updated}"
    );
    let bare_ledger = app(&db, Some(&bare_id));
    contract
        .success(
            &bare_ledger,
            "updateAccountingEntity",
            &[("id", bare_id.as_str())],
            &[],
            Some(&json!({ "name": format!("Ledger contract {run} bare, renamed") })),
        )
        .await;

    // The chart: whole, by type, and the bare company's empty one.
    let chart = contract
        .success(&ledger, "listGlAccounts", &[], &[], None)
        .await;
    assert!(
        chart["data"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()),
        "{chart}"
    );
    let revenue = contract
        .success(&ledger, "listGlAccounts", &[], &[("type", "revenue")], None)
        .await;
    assert!(
        revenue["data"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty() && rows.iter().all(|row| row["type"] == "revenue")),
        "{revenue}"
    );
    let empty = contract
        .success(&bare_ledger, "listGlAccounts", &[], &[], None)
        .await;
    assert_eq!(empty["data"], json!([]));

    // Refusals decode as the file's error: a country without an adapter, a
    // body that fails validation, and a company that doesn't exist.
    let unsupported = contract
        .failure(
            &workspace,
            "createAccountingEntity",
            &[],
            Some(&json!({ "name": "Nowhere", "jurisdictionCode": "XX" })),
        )
        .await;
    assert_eq!(unsupported.status, 400, "{:?}", unsupported.body);
    let invalid = contract
        .failure(
            &ledger,
            "updateAccountingEntity",
            &[("id", dutch_id.as_str())],
            Some(&json!({ "bankDetails": { "iban": "NL00NOTANIBAN" } })),
        )
        .await;
    assert_eq!(invalid.status, 400, "{:?}", invalid.body);
    let gone = format!("ent_gone_{run}");
    let missing = contract
        .failure(
            &ledger,
            "getAccountingEntity",
            &[("id", gone.as_str())],
            None,
        )
        .await;
    assert_eq!(missing.status, 404, "{:?}", missing.body);

    contract.finish_only(LEDGER_OPERATIONS);
}
