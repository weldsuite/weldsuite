//! What the native WeldBooks apps read from the reports, held against the
//! file they generate their client from
//! (`apps/mobile-shared/openapi/weldbooks.yaml`): its dashboard, profit and
//! loss and balance sheet operations, sent as the file describes them
//! through this crate's routers as the server mounts them, on the real
//! tenant schema (`weldsuite_kit::openapi_contract`). The file's other
//! operations are checked by the other books crates' tests. A change to
//! these routes that would break the apps fails here; change the file with
//! it, as `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with every other crate's tests and is not
//! wiped between runs, so every row here has an id unique to the run (`bkr`
//! and a tag from the clock). The company is named by the
//! `X-Accounting-Entity-Id` header, as the apps name it.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use http::HeaderValue;
use weldsuite_auth::AuthContext;
use weldsuite_books_reports::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_reports_openapi";
const ORG: &str = "org_books_reports_openapi";
const WORKSPACE: &str = "ws_books_reports_openapi";

/// The operations of weldbooks.yaml this crate serves.
const REPORT_OPERATIONS: &[&str] = &["getAccountingDashboard", "getProfitLoss", "getBalanceSheet"];

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

/// The reports routers under `/api`, behind the session, tenant and
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
    weldsuite_books_reports::routers(&books, &gate)
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
                    session_id: "sess_books_reports_openapi".to_owned(),
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

/// A Dutch company with WeldBooks on and a year of books: the owner's
/// capital in the bank, a sale and an expense this month and a sale last
/// year (posted), an open and an overdue invoice, an open bill, a receipt
/// waiting to be processed, and two bank accounts (one bare).
fn fixtures(p: &str) -> String {
    format!(
        r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, timezone,
    tax_identifiers, address, bank_details, accounting_method, fiscal_year_start, is_default,
    is_active)
values ('{p}_ent', 'Reports contract test B.V.', null, 'NL', 'EUR', 'nl-NL', 'Europe/Amsterdam',
    '{{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}}',
    '{{"line1": "Coolsingel 40", "city": "Rotterdam", "postalCode": "3011 AD", "country": "NL"}}',
    '{{"iban": "NL91ABNA0417164300"}}',
    'accrual', 1, false, true);
insert into accounting_entity_settings (entity_id, accounting_method) values ('{p}_ent', 'accrual');

insert into accounts (id, entity_id, code, name, type, subtype, normal_side, is_active) values
    ('{p}_bank', '{p}_ent', '1100', 'Bank', 'asset', 'bank', 'debit', true),
    ('{p}_ar', '{p}_ent', '1300', 'Debtors', 'asset', 'accounts_receivable', 'debit', true),
    ('{p}_ap', '{p}_ent', '1600', 'Creditors', 'liability', 'accounts_payable', 'credit', true),
    ('{p}_eq', '{p}_ent', '0500', 'Share capital', 'equity', 'owners_equity', 'credit', true),
    ('{p}_rev', '{p}_ent', '8000', 'Revenue', 'revenue', 'sales', 'credit', true),
    ('{p}_exp', '{p}_ent', '4000', 'General expenses', 'expense', 'operating_expense', 'debit', true);

insert into journal_entries (id, entity_id, entry_number, date, status, description, total_debit,
    total_credit, source_type, is_automatic) values
    ('{p}_je1', '{p}_ent', 'JE-0001', now() - interval '400 days', 'posted', 'Capital', 1000.00,
        1000.00, 'manual', false),
    ('{p}_je2', '{p}_ent', 'JE-0002', now() - interval '400 days', 'posted', 'Sale last year',
        200.00, 200.00, 'manual', false),
    ('{p}_je3', '{p}_ent', 'JE-0003', now(), 'posted', 'Sale', 121.00, 121.00, 'manual', false),
    ('{p}_je4', '{p}_ent', 'JE-0004', now(), 'posted', 'Office supplies', 60.50, 60.50, 'manual',
        false);
insert into journal_lines (id, entity_id, journal_entry_id, account_id, description, debit, credit,
    sort_order) values
    ('{p}_jl1', '{p}_ent', '{p}_je1', '{p}_bank', 'Capital', 1000.00, 0, 0),
    ('{p}_jl2', '{p}_ent', '{p}_je1', '{p}_eq', 'Capital', 0, 1000.00, 1),
    ('{p}_jl3', '{p}_ent', '{p}_je2', '{p}_ar', 'Sale last year', 200.00, 0, 0),
    ('{p}_jl4', '{p}_ent', '{p}_je2', '{p}_rev', 'Sale last year', 0, 200.00, 1),
    ('{p}_jl5', '{p}_ent', '{p}_je3', '{p}_ar', 'Sale', 121.00, 0, 0),
    ('{p}_jl6', '{p}_ent', '{p}_je3', '{p}_rev', 'Sale', 0, 121.00, 1),
    ('{p}_jl7', '{p}_ent', '{p}_je4', '{p}_exp', 'Office supplies', 60.50, 0, 0),
    ('{p}_jl8', '{p}_ent', '{p}_je4', '{p}_ap', 'Office supplies', 0, 60.50, 1);

insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name,
    issue_date, due_date, currency, subtotal, tax_total, total, amount_paid, balance_due) values
    ('{p}_inv1', '{p}_ent', 'INV-{p}-1', 'standard', 'finalized', '{p}_customer', 'Acme Retail',
        now(), now() + interval '14 days', 'EUR', 121.00, 0, 121.00, 0, 121.00),
    ('{p}_inv2', '{p}_ent', 'INV-{p}-2', 'standard', 'overdue', '{p}_customer', null,
        now() - interval '40 days', now() - interval '10 days', 'EUR', 200.00, 0, 200.00, 150.00,
        50.00);
insert into bills (id, entity_id, bill_number, type, status, approval_status, contact_id,
    contact_name, issue_date, due_date, currency, subtotal, tax_total, total, amount_paid,
    balance_due) values
    ('{p}_bill', '{p}_ent', 'BILL-{p}', 'standard', 'approved', 'approved', '{p}_supplier',
        'Office Depot', now(), now() + interval '30 days', 'EUR', 60.50, 0, 60.50, 0, 60.50);

insert into documents (id, entity_id, type, file_name, file_key, mime_type, source, status) values
    ('{p}_doc', '{p}_ent', 'receipt', 'receipt.jpg', 'workspaces/{p}/books/receipt.jpg',
        'image/jpeg', 'upload', 'pending');

insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id, current_balance,
    is_default, is_active) values
    ('{p}_ba1', '{p}_ent', 'Business account', 'NL91ABNA0417164300', 'EUR', '{p}_bank', 1000.00,
        false, true),
    ('{p}_ba2', '{p}_ent', 'Cash box', null, null, null, null, false, true);
"#
    )
}

/// Every report operation of weldbooks.yaml on books with figures in them,
/// and refusals that decode as the file's error.
#[tokio::test]
async fn books_reports_answer_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let p = format!("bkr{}", run_tag());
    // The SQL is the test's own, with only the run's tag put in.
    sqlx::raw_sql(sqlx::AssertSqlSafe(fixtures(&p)))
        .execute(&db)
        .await
        .expect("fixtures");
    let entity = format!("{p}_ent");
    // A company that doesn't exist: the requests resolve none.
    let nobody = app(&db, Some(&format!("{p}_gone")));
    let app = app(&db, Some(&entity));
    let contract = Contract::load("weldbooks");

    let dashboard = contract
        .success(&app, "getAccountingDashboard", &[], &[], None)
        .await;
    assert_eq!(
        dashboard["data"]["bankAccounts"].as_array().map(Vec::len),
        Some(2),
        "{dashboard}"
    );
    // The receipt, and any document of the database's that names no entity.
    assert!(
        dashboard["data"]["pendingDocuments"]
            .as_i64()
            .is_some_and(|count| count >= 1),
        "{dashboard}"
    );

    // This year, and the fiscal year to date (no period given).
    let year = time::OffsetDateTime::now_utc().year();
    let (from, to) = (format!("{year}-01-01"), format!("{year}-12-31"));
    let profit_loss = contract
        .success(
            &app,
            "getProfitLoss",
            &[],
            &[("from", from.as_str()), ("to", to.as_str())],
            None,
        )
        .await;
    assert_eq!(profit_loss["data"]["period"]["from"], from.as_str());
    contract
        .success(&app, "getProfitLoss", &[], &[], None)
        .await;

    let sheet = contract
        .success(&app, "getBalanceSheet", &[], &[], None)
        .await;
    assert!(
        sheet["data"]["equity"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["accountId"].is_null())),
        "the calculated equity rows have no account: {sheet}"
    );

    // Refusals: no company resolved, and a period that ends before it starts.
    let unresolved = contract
        .failure(&nobody, "getAccountingDashboard", &[], None)
        .await;
    assert_eq!(unresolved.status, 400);
    let backwards = contract.endpoint(
        "getProfitLoss",
        &[],
        &[("from", to.as_str()), ("to", from.as_str())],
    );
    let refused = contract.send(&app, &backwards, None).await;
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    let problems = contract.answer_problems("getProfitLoss", &refused);
    assert!(problems.is_empty(), "{problems:?}");

    contract.finish_only(REPORT_OPERATIONS);
}
