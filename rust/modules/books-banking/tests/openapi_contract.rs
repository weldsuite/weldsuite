//! What the native WeldBooks apps read from banking, held against the file
//! they generate their client from (`apps/mobile-shared/openapi/weldbooks.yaml`):
//! its bank account and bank transaction operations, sent as the file
//! describes them through this crate's routers as the server mounts them, on
//! the real tenant schema (`weldsuite_kit::openapi_contract`). The file's
//! other operations are checked by the other books crates' tests. A change
//! to these routes that would break the apps fails here; change the file
//! with it, as `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with every other crate's tests and is not
//! wiped between runs, so every row here has an id unique to the run (`bkb`
//! and a tag from the clock). The company is named by the
//! `X-Accounting-Entity-Id` header, as the apps name it.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use http::HeaderValue;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_books_banking::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_banking_openapi";
const ORG: &str = "org_books_banking_openapi";
const WORKSPACE: &str = "ws_books_banking_openapi";

/// The operations of weldbooks.yaml this crate serves.
const BANKING_OPERATIONS: &[&str] = &[
    "listBankAccounts",
    "getBankAccount",
    "listBankTransactions",
    "listMatchSuggestions",
    "reconcileTransaction",
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

/// The banking routers under `/api`, behind the session, tenant and
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
    weldsuite_books_banking::routers(&books, &gate)
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
                    session_id: "sess_books_banking_openapi".to_owned(),
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

/// A Dutch company with WeldBooks on, its chart, two bank accounts (one
/// linked to the ledger with every detail, one bare), an open invoice and an
/// approved bill, and four statement lines: money in for the invoice, money
/// out for the bill, interest to categorize, and one already reconciled.
fn fixtures(p: &str) -> String {
    format!(
        r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, timezone,
    tax_identifiers, address, bank_details, accounting_method, is_default, is_active)
values ('{p}_ent', 'Banking contract test B.V.', 'Banking contract test B.V.', 'NL', 'EUR', 'nl-NL',
    'Europe/Amsterdam',
    '{{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}}',
    '{{"line1": "Damrak 1", "city": "Amsterdam", "postalCode": "1012 LG", "country": "NL"}}',
    '{{"iban": "NL91ABNA0417164300", "bic": "ABNANL2A"}}',
    'accrual', false, true);
insert into accounting_entity_settings (entity_id, accounting_method) values ('{p}_ent', 'accrual');

insert into accounts (id, entity_id, code, name, type, subtype, normal_side, is_active) values
    ('{p}_bank', '{p}_ent', '1100', 'Bank', 'asset', 'bank', 'debit', true),
    ('{p}_ar', '{p}_ent', '1300', 'Debtors', 'asset', 'accounts_receivable', 'debit', true),
    ('{p}_ap', '{p}_ent', '1600', 'Creditors', 'liability', 'accounts_payable', 'credit', true),
    ('{p}_vat', '{p}_ent', '1700', 'VAT payable', 'liability', 'tax', 'credit', true),
    ('{p}_rev', '{p}_ent', '8000', 'Revenue', 'revenue', 'sales', 'credit', true),
    ('{p}_int', '{p}_ent', '8100', 'Interest income', 'revenue', 'interest_income', 'credit', true),
    ('{p}_exp', '{p}_ent', '4000', 'General expenses', 'expense', 'operating_expense', 'debit', true);

insert into bank_accounts (id, entity_id, name, iban, bic, bank_name, currency, ledger_account_id,
    current_balance, is_default, is_active, account_type, last_import_date) values
    ('{p}_ba1', '{p}_ent', 'Business account', 'NL91ABNA0417164300', 'ABNANL2A', 'ABN AMRO', 'EUR',
        '{p}_bank', 1234.56, false, true, 'checking', now() - interval '1 day'),
    ('{p}_ba2', '{p}_ent', 'Savings', null, null, null, null, null, null, false, null, null, null);
insert into accounting_bank_account_settings (bank_account_id, entity_id, ledger_account_id,
    current_balance, auto_reconcile) values
    ('{p}_ba1', '{p}_ent', '{p}_bank', 1234.56, true),
    ('{p}_ba2', '{p}_ent', null, 0, true);

insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name,
    issue_date, due_date, currency, subtotal, tax_total, total, amount_paid, balance_due) values
    ('{p}_inv', '{p}_ent', 'INV-{p}', 'standard', 'finalized', '{p}_customer', 'Acme Retail',
        now() - interval '10 days', now() + interval '20 days', 'EUR', 100.00, 21.00, 121.00, 0, 121.00);
insert into bills (id, entity_id, bill_number, type, status, approval_status, contact_id,
    contact_name, issue_date, due_date, currency, subtotal, tax_total, total, amount_paid,
    balance_due, external_reference) values
    ('{p}_bill', '{p}_ent', null, 'standard', 'approved', 'approved', '{p}_supplier', null,
        now() - interval '5 days', now() + interval '25 days', 'EUR', 50.00, 10.50, 60.50, 0, 60.50,
        'SUP-{p}');

insert into bank_transactions (id, entity_id, bank_account_id, date, description, amount,
    running_balance, counterparty_name, counterparty_iban, reference, status, source) values
    ('{p}_t_in', '{p}_ent', '{p}_ba1', now() - interval '2 days', 'Payment INV-{p}', 121.00,
        1355.56, 'Acme Retail', 'NL02RABO0123456789', 'INV-{p}', 'unreconciled', 'manual'),
    ('{p}_t_out', '{p}_ent', '{p}_ba1', now() - interval '1 day', null, -60.50, null, null, null,
        null, 'unreconciled', 'manual'),
    ('{p}_t_int', '{p}_ent', '{p}_ba1', now(), 'Interest', 15.00, 1310.06, 'ABN AMRO', null, null,
        'unreconciled', 'manual'),
    ('{p}_t_done', '{p}_ent', '{p}_ba2', now() - interval '30 days', 'Opening deposit', 500.00,
        500.00, null, null, 'OPEN', 'reconciled', 'manual');
"#
    )
}

fn ids(list: &Value) -> Vec<&str> {
    list["data"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|row| row["id"].as_str()).collect())
        .unwrap_or_default()
}

/// Every banking operation of weldbooks.yaml, with data that gives the
/// nullable fields a value and none: two bank accounts, statement lines in
/// and out, suggestions with and without a number and contact, and a line
/// categorized to an income account.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn books_banking_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let run = run_tag();
    let p = format!("bkb{run}");
    // The SQL is the test's own, with only the run's tag put in.
    sqlx::raw_sql(sqlx::AssertSqlSafe(fixtures(&p)))
        .execute(&db)
        .await
        .expect("fixtures");
    let entity = format!("{p}_ent");
    let app = app(&db, Some(&entity));
    let contract = Contract::load("weldbooks");
    let id = |suffix: &str| format!("{p}_{suffix}");

    // Bank accounts.
    let accounts = contract
        .success(&app, "listBankAccounts", &[], &[], None)
        .await;
    assert_eq!(ids(&accounts).len(), 2, "{accounts}");
    for account in [id("ba1"), id("ba2")] {
        contract
            .success(
                &app,
                "getBankAccount",
                &[("id", account.as_str())],
                &[],
                None,
            )
            .await;
    }

    // Statement lines: all, then one account's open lines a page at a time.
    let lines = contract
        .success(&app, "listBankTransactions", &[], &[], None)
        .await;
    assert_eq!(ids(&lines).len(), 4, "{lines}");
    let ba1 = id("ba1");
    let page = contract
        .success(
            &app,
            "listBankTransactions",
            &[],
            &[
                ("bankAccountId", ba1.as_str()),
                ("status", "unreconciled"),
                ("page", "1"),
                ("pageSize", "2"),
            ],
            None,
        )
        .await;
    assert_eq!(ids(&page).len(), 2, "{page}");
    assert_eq!(page["pagination"]["hasMore"], true, "{page}");

    // Suggestions: the invoice for the money in, the bill (no number, no
    // contact name) for the money out.
    let (money_in, money_out, interest) = (id("t_in"), id("t_out"), id("t_int"));
    let for_invoice = contract
        .success(
            &app,
            "listMatchSuggestions",
            &[("id", money_in.as_str())],
            &[],
            None,
        )
        .await;
    assert!(
        for_invoice["data"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["id"] == id("inv"))),
        "the invoice is suggested: {for_invoice}"
    );
    let for_bill = contract
        .success(
            &app,
            "listMatchSuggestions",
            &[("id", money_out.as_str())],
            &[],
            None,
        )
        .await;
    assert!(
        for_bill["data"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["id"] == id("bill"))),
        "the bill is suggested: {for_bill}"
    );

    // Interest, booked to an income account.
    let reconciled = contract
        .success(
            &app,
            "reconcileTransaction",
            &[("id", interest.as_str())],
            &[],
            Some(&json!({ "type": "manual", "categoryAccountId": id("int") })),
        )
        .await;
    assert_eq!(reconciled["data"]["status"], "reconciled", "{reconciled}");

    // Refusals decode as the file's error: a manual match without an
    // account, an unknown type, and a line that doesn't exist.
    let refused = contract
        .failure(
            &app,
            "reconcileTransaction",
            &[("id", money_out.as_str())],
            Some(&json!({ "type": "manual" })),
        )
        .await;
    assert_eq!(refused.status, 400);
    let invalid = contract
        .failure(
            &app,
            "reconcileTransaction",
            &[("id", money_out.as_str())],
            Some(&json!({ "type": "cheque" })),
        )
        .await;
    assert_eq!(invalid.status, 400);
    let gone = id("gone");
    let missing = contract
        .failure(&app, "getBankAccount", &[("id", gone.as_str())], None)
        .await;
    assert_eq!(missing.status, 404);

    contract.finish_only(BANKING_OPERATIONS);
}
