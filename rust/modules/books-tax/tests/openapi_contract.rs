//! What the native WeldBooks apps read from the VAT returns, held against
//! the file they generate their client from
//! (`apps/mobile-shared/openapi/weldbooks.yaml`): its VAT return operations,
//! sent as the file describes them through this crate's routers as the
//! server mounts them, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's other operations are
//! checked by the other books crates' tests. A change to these routes that
//! would break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with every other crate's tests and is not
//! wiped between runs, so every row here has an id unique to the run (`bkt`
//! and a tag from the clock). The company is named by the
//! `X-Accounting-Entity-Id` header, as the apps name it. Without a Digipoort
//! connection filing is the simulated submission, recorded as filed.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use http::HeaderValue;
use weldsuite_auth::AuthContext;
use weldsuite_books_tax::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_tax_openapi";
const ORG: &str = "org_books_tax_openapi";
const WORKSPACE: &str = "ws_books_tax_openapi";

/// The operations of weldbooks.yaml this crate serves.
const TAX_OPERATIONS: &[&str] = &["listVatReturns", "getVatReturn", "fileVatReturn"];

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

/// The tax routers under `/api`, behind the session, tenant and permission
/// layers, for the workspace owner; `entity` is the company the requests
/// name.
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
    weldsuite_books_tax::routers(&books, &gate)
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
                    session_id: "sess_books_tax_openapi".to_owned(),
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

/// A tag unique to this run, for the fixtures' ids.
fn run_tag() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{:x}", nanos & 0xff_ffff_ffff)
}

/// A Dutch company with WeldBooks on, its BTW number and a phone number (the
/// aangifte message needs both), and three returns of `year`: Q1 calculated,
/// last year's Q4 filed (its boxes stored in the old layout), and an April
/// return not calculated yet.
fn fixtures(p: &str, year: i32) -> String {
    let last = year - 1;
    format!(
        r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, timezone,
    tax_identifiers, address, bank_details, contact, accounting_method, is_default, is_active)
values ('{p}_ent', 'Tax contract test', 'Tax contract test B.V.', 'NL', 'EUR', 'nl-NL',
    'Europe/Amsterdam',
    '{{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}}',
    '{{"line1": "Lange Voorhout 9", "city": "Den Haag", "postalCode": "2514 EA", "country": "NL"}}',
    '{{"iban": "NL91ABNA0417164300", "bic": "ABNANL2A"}}',
    '{{"phone": "+31 70 123 4567", "email": "finance@example.test"}}',
    'accrual', false, true);
insert into accounting_entity_settings (entity_id, accounting_method) values ('{p}_ent', 'accrual');

insert into vat_returns (id, entity_id, period_type, period_start, period_end, period_label,
    status, rubrieken, filed_at, filing_reference) values
    ('{p}_q1', '{p}_ent', 'quarterly', '{year}-01-01', '{year}-03-31', 'Q1 {year}', 'calculated',
        '{{"r1a": 1000, "r1aBtw": 210, "r1b": 100, "r1bBtw": 9, "r1c": 0, "r1cBtw": 0,
           "r1d": 0, "r1dBtw": 0, "r1e": 0, "r2a": 0, "r2aBtw": 0, "r3a": 0, "r3b": 250.5,
           "r3c": 0, "r4a": 0, "r4aBtw": 0, "r4b": 0, "r4bBtw": 0, "r5a": 219, "r5b": 42.35,
           "r5c": 176.65, "r5d": 0, "r5e": 0, "r5f": 0, "r5g": 176.65}}',
        null, null),
    ('{p}_q4', '{p}_ent', 'quarterly', '{last}-10-01', '{last}-12-31', 'Q4 {last}', 'filed',
        '{{"r1a": 500, "r1b": 105, "r5a": 105, "r5b": 20, "r5c": 85, "r5f": 85}}',
        '{year}-01-20 10:00:00', 'WS-legacy-{p}'),
    ('{p}_apr', '{p}_ent', 'monthly', '{year}-04-01', '{year}-04-30', null, 'draft', null, null,
        null);
"#
    )
}

/// Every VAT return operation of weldbooks.yaml: a calculated, a filed and
/// an empty return listed and read, the calculated one filed (simulated)
/// and read again, and the refusals of filing what can't be filed.
#[tokio::test]
async fn books_tax_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let p = format!("bkt{}", run_tag());
    let year = time::OffsetDateTime::now_utc().year();
    // The SQL is the test's own, with only the run's tag and year put in.
    sqlx::raw_sql(sqlx::AssertSqlSafe(fixtures(&p, year)))
        .execute(&db)
        .await
        .expect("fixtures");
    let entity = format!("{p}_ent");
    let app = app(&db, Some(&entity));
    let contract = Contract::load("weldbooks");
    let (q1, q4, april) = (format!("{p}_q1"), format!("{p}_q4"), format!("{p}_apr"));

    let returns = contract
        .success(&app, "listVatReturns", &[], &[], None)
        .await;
    assert_eq!(
        returns["data"].as_array().map(Vec::len),
        Some(3),
        "{returns}"
    );
    for id in [&q1, &q4, &april] {
        contract
            .success(&app, "getVatReturn", &[("id", id.as_str())], &[], None)
            .await;
    }

    let filed = contract
        .success(&app, "fileVatReturn", &[("id", q1.as_str())], &[], None)
        .await;
    assert_eq!(filed["data"]["status"], "filed", "{filed}");
    assert_eq!(filed["data"]["simulated"], true, "{filed}");
    let after = contract
        .success(&app, "getVatReturn", &[("id", q1.as_str())], &[], None)
        .await;
    assert!(after["data"]["filingReference"].is_string(), "{after}");
    contract
        .success(&app, "listVatReturns", &[], &[], None)
        .await;

    // Refusals decode as the file's error: filed already, nothing
    // calculated yet, and a return that doesn't exist.
    for id in [&q4, &april] {
        let refused = contract
            .failure(&app, "fileVatReturn", &[("id", id.as_str())], None)
            .await;
        assert_eq!(refused.status, 400, "{id}: {:?}", refused.body);
    }
    let gone = format!("{p}_gone");
    let missing = contract
        .failure(&app, "getVatReturn", &[("id", gone.as_str())], None)
        .await;
    assert_eq!(missing.status, 404);

    contract.finish_only(TAX_OPERATIONS);
}
