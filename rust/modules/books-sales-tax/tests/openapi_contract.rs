//! What the native WeldBooks apps read from the sales tax routes, held
//! against the file they generate their client from
//! (`apps/mobile-shared/openapi/weldbooks.yaml`): the tax preview of an
//! invoice or bill form (`calculateSalesTax`), sent as the file describes it
//! through the router as the server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's other operations are
//! checked by the other books crates' tests. A change to this route that
//! would break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with the other crates' tests and kept between
//! local runs, so every fixture id carries a tag of its own run: a Dutch
//! company and a customer. The company is named by the
//! `X-Accounting-Entity-Id` header the apps send.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use http::HeaderValue;
use serde_json::json;
use weldsuite_auth::AuthContext;
use weldsuite_books_sales_tax::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_sales_tax_openapi";
const ORG: &str = "org_books_sales_tax_openapi";
const WORKSPACE: &str = "ws_books_sales_tax_openapi";

/// The operations of weldbooks.yaml this crate serves.
const SALES_TAX_OPERATIONS: &[&str] = &["calculateSalesTax"];

/// The fixtures; `@P` is the run's id prefix.
const FIXTURES: &str = r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, timezone,
    is_default, is_active, tax_identifiers, bank_details, address) values
    ('@P_ent', 'Books sales tax contract test', 'Books Sales Tax Contract B.V.', 'NL', 'EUR',
     'nl-NL', 'Europe/Amsterdam', false, true,
     '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}',
     '{"iban": "NL91ABNA0417164300"}',
     '{"line1": "Damrak 1", "city": "Amsterdam", "postalCode": "1012 LG", "country": "NL"}');
insert into accounting_entity_settings (entity_id) values ('@P_ent');
insert into companies (id, name, display_name, email) values
    ('@P_cust', 'Tax Preview Customer B.V.', 'Tax Preview Customer', 'billing@preview.example');
insert into parties (id, kind, company_id, display_name, role) values
    ('@P_pcust', 'company', '@P_cust', 'Tax Preview Customer', 'customer');
"#;

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

/// The sales tax routes under `/api` behind the session, tenant and
/// permission layers, for the workspace owner, about `entity` (the
/// `X-Accounting-Entity-Id` header the apps send) when given.
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
    weldsuite_books_sales_tax::routers(&books, &gate)
        .into_iter()
        .fold(Router::new(), |router, (prefix, routes)| {
            router.nest(&format!("/api{prefix}"), routes)
        })
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                if let Some(entity) = &entity {
                    request
                        .headers_mut()
                        .insert("x-accounting-entity-id", entity.clone());
                }
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_books_sales_tax_openapi".to_owned(),
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

/// The prefix of this run's fixture ids: `bst` and 40 bits of the clock.
fn run_prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("bst{:010x}", nanos & 0xff_ffff_ffff)
}

/// `calculateSalesTax` for an invoice form (a customer, addresses, three
/// lines at 21%, 9% and no tax) and a bill form (one line, a delivery
/// address); a body without lines is refused.
#[tokio::test]
async fn books_sales_tax_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let prefix = run_prefix();
    sqlx::raw_sql(sqlx::AssertSqlSafe(FIXTURES.replace("@P", &prefix)))
        .execute(&db)
        .await
        .expect("fixtures");
    let entity = format!("{prefix}_ent");
    let customer = format!("{prefix}_pcust");
    let app = app(&db, Some(&entity));
    let contract = Contract::load("weldbooks");

    let invoice = json!({
        "kind": "invoice",
        "contactId": customer,
        "issueDate": "2026-11-02",
        "currency": "EUR",
        "billingAddress": {
            "line1": "Keizersgracht 100",
            "city": "Amsterdam",
            "postalCode": "1015 AA",
            "country": "NL",
        },
        "shippingAddress": {
            "line1": "Stationsplein 1",
            "city": "Utrecht",
            "postalCode": "3511 AB",
            "country": "NL",
        },
        "items": [
            {
                "id": "line-1",
                "description": "Consulting",
                "quantity": "2",
                "unitPrice": "100",
                "taxRate": "21",
            },
            { "description": "Books", "unitPrice": "15.50", "taxRate": "9" },
            { "unitPrice": "10" },
        ],
    });
    let preview = contract
        .success(&app, "calculateSalesTax", &[], &[], Some(&invoice))
        .await;
    assert_eq!(preview["data"]["subtotal"], "225.50");

    let bill = json!({
        "kind": "bill",
        "deliveryAddress": { "line1": "Damrak 1", "city": "Amsterdam", "country": "NL" },
        "items": [{ "description": "Office chairs", "quantity": "1", "unitPrice": "121", "taxRate": "21" }],
    });
    contract
        .success(&app, "calculateSalesTax", &[], &[], Some(&bill))
        .await;

    // A form without lines decodes as the file's error (Zod's shape).
    let invalid = contract
        .failure(
            &app,
            "calculateSalesTax",
            &[],
            Some(&json!({ "items": [] })),
        )
        .await;
    assert_eq!(invalid.status, 400);

    contract.finish_only(SALES_TAX_OPERATIONS);
}
