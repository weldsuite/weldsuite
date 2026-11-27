//! What the native WeldBooks apps read from the sales routes, held against
//! the file they generate their client from
//! (`apps/mobile-shared/openapi/weldbooks.yaml`): the invoices (list,
//! create, detail, delete, finalize, send, cancel, payment, duplicate, credit
//! note) and a payment on a bill, sent as the file describes them through the
//! router as the server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's other operations are
//! checked by the other books crates' tests. A change to these routes that
//! would break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with the other crates' tests and kept between
//! local runs, so every fixture id carries a tag of its own run: a Dutch
//! company with its chart, a 21% rate and a bank account, a customer and a
//! supplier, and an approved bill. The company is named by the
//! `X-Accounting-Entity-Id` header the apps send.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use http::HeaderValue;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_books_sales::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_books_sales_openapi";
const ORG: &str = "org_books_sales_openapi";
const WORKSPACE: &str = "ws_books_sales_openapi";

/// The operations of weldbooks.yaml this crate serves.
const SALES_OPERATIONS: &[&str] = &[
    "listInvoices",
    "createInvoice",
    "getInvoice",
    "deleteInvoice",
    "finalizeInvoice",
    "sendInvoice",
    "setInvoiceStatus",
    "recordInvoicePayment",
    "duplicateInvoice",
    "createCreditNote",
    "createPayment",
];

/// The fixtures; `@P` is the run's id prefix. Everything an invoice needs to
/// be booked in the Netherlands: the company's VAT and `KvK` numbers, IBAN and
/// address, receivable, revenue, VAT, payable and bank accounts, and a bank
/// account linked to the ledger for the payments.
const FIXTURES: &str = r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, timezone,
    is_default, is_active, tax_identifiers, bank_details, address) values
    ('@P_ent', 'Books sales contract test', 'Books Sales Contract B.V.', 'NL', 'EUR', 'nl-NL',
     'Europe/Amsterdam', false, true,
     '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}',
     '{"iban": "NL91ABNA0417164300", "bic": "ABNANL2A", "bankName": "ABN AMRO"}',
     '{"line1": "Damrak 1", "city": "Amsterdam", "postalCode": "1012 LG", "country": "NL"}');
insert into accounting_entity_settings (entity_id) values ('@P_ent');
insert into accounts (id, entity_id, code, name, type, subtype, normal_side) values
    ('@P_bank', '@P_ent', '1100', 'Bank', 'asset', 'bank', 'debit'),
    ('@P_ar', '@P_ent', '1300', 'Debiteuren', 'asset', null, 'debit'),
    ('@P_ap', '@P_ent', '1600', 'Crediteuren', 'liability', null, 'credit'),
    ('@P_vat', '@P_ent', '1700', 'Af te dragen BTW', 'liability', null, 'credit'),
    ('@P_vatin', '@P_ent', '1730', 'Voorbelasting', 'asset', null, 'debit'),
    ('@P_exp', '@P_ent', '4600', 'Algemene kosten', 'expense', null, 'debit'),
    ('@P_rev', '@P_ent', '8000', 'Omzet', 'revenue', null, 'credit');
insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type, tax_category_code,
    is_default, is_active, jurisdiction_metadata) values
    ('@P_rate', '@P_ent', 'NL', 'BTW Hoog 21%', 21.00, 'both', 'standard', true, true,
     '{"btwRubriek": "1a"}');
insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id, is_default, is_active) values
    ('@P_bacc', '@P_ent', 'Zakelijke rekening', 'NL91ABNA0417164300', 'EUR', '@P_bank', true, true);
insert into companies (id, name, display_name, email, vat_number) values
    ('@P_cust', 'Contract Customer B.V.', 'Contract Customer', 'billing@customer.example', 'NL987654321B01'),
    ('@P_supp', 'Contract Supplier B.V.', 'Contract Supplier', 'ap@supplier.example', null);
insert into parties (id, kind, company_id, display_name, role) values
    ('@P_pcust', 'company', '@P_cust', 'Contract Customer', 'customer'),
    ('@P_psupp', 'company', '@P_supp', 'Contract Supplier', 'supplier');
insert into bills (id, entity_id, bill_number, status, approval_status, contact_id, contact_name,
    issue_date, due_date, currency, subtotal, tax_total, total, amount_paid, balance_due) values
    ('@P_bill', '@P_ent', 'SUP-2026-17', 'approved', 'approved', '@P_psupp', 'Contract Supplier',
     '2026-11-03', '2026-12-03', 'EUR', 100.00, 21.00, 121.00, 0, 121.00);
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

/// The sales routes under `/api` behind the session, tenant and permission
/// layers, for the workspace owner, about `entity` (the
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
    weldsuite_books_sales::routers(&books, &gate)
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
                    session_id: "sess_books_sales_openapi".to_owned(),
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

/// The prefix of this run's fixture ids: `bks` and 40 bits of the clock.
fn run_prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("bks{:010x}", nanos & 0xff_ffff_ffff)
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// Every sales operation of weldbooks.yaml, with data that gives the
/// nullable fields more than one value: a full invoice (notes, reference,
/// addresses, a line on the company's 21% rate and one at 9%) and a bare
/// one without tax; booked, sent, part paid, duplicated, credited,
/// cancelled and deleted.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn books_sales_answers_what_the_native_apps_read() {
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
    let supplier = format!("{prefix}_psupp");
    let rate = format!("{prefix}_rate");
    let bill = format!("{prefix}_bill");
    let app = app(&db, Some(&entity));
    let contract = Contract::load("weldbooks");

    // Two drafts: everything filled in, and only what is required.
    let full = json!({
        "contactId": customer,
        "contactName": "Contract Customer B.V.",
        "contactEmail": "billing@customer.example",
        "issueDate": "2026-11-02",
        "dueDate": "2026-12-02",
        "currency": "EUR",
        "notes": "Thank you for your business.",
        "reference": "PO-4711",
        "billingAddress": {
            "line1": "Keizersgracht 100",
            "line2": "3rd floor",
            "city": "Amsterdam",
            "postalCode": "1015 AA",
            "country": "nl",
        },
        "shippingAddress": {
            "line1": "Stationsplein 1",
            "city": "Utrecht",
            "postalCode": "3511 AB",
            "country": "NL",
        },
        "items": [
            {
                "description": "Consulting",
                "quantity": "2",
                "unitPrice": "100.00",
                "taxRateId": rate,
                "sortOrder": 0,
            },
            {
                "description": "Books",
                "quantity": "1.5",
                "unitPrice": "20",
                "taxRate": "9",
                "sortOrder": 1,
            },
        ],
    });
    let booked = id(&contract
        .success(&app, "createInvoice", &[], &[], Some(&full))
        .await);
    let bare = json!({
        "contactId": customer,
        "issueDate": "2026-11-05",
        "dueDate": "2026-11-19",
        "items": [{ "description": "Support hours", "unitPrice": "75" }],
    });
    let sent = id(&contract
        .success(&app, "createInvoice", &[], &[], Some(&bare))
        .await);

    let page = contract.success(&app, "listInvoices", &[], &[], None).await;
    assert_eq!(page["data"].as_array().map(Vec::len), Some(2));
    contract
        .success(
            &app,
            "listInvoices",
            &[],
            &[
                ("page", "1"),
                ("pageSize", "10"),
                ("status", "draft"),
                ("search", "PO-4711"),
                ("contactId", customer.as_str()),
                ("from", "2026-11-01"),
                ("to", "2026-11-30"),
            ],
            None,
        )
        .await;
    contract
        .success(&app, "getInvoice", &[("id", booked.as_str())], &[], None)
        .await;
    contract
        .success(&app, "getInvoice", &[("id", sent.as_str())], &[], None)
        .await;

    // Booked, then sent (the other draft is booked on the way).
    let finalized = contract
        .success(
            &app,
            "finalizeInvoice",
            &[("id", booked.as_str())],
            &[],
            None,
        )
        .await;
    assert_eq!(finalized["data"]["status"], "finalized");
    assert!(finalized["data"]["journalEntryId"].is_string());
    let sending = contract
        .success(&app, "sendInvoice", &[("id", sent.as_str())], &[], None)
        .await;
    assert_eq!(sending["data"]["status"], "sent");
    contract
        .success(&app, "sendInvoice", &[("id", booked.as_str())], &[], None)
        .await;

    // Part of the booked invoice is paid.
    let paid = contract
        .success(
            &app,
            "recordInvoicePayment",
            &[("id", booked.as_str())],
            &[],
            Some(&json!({
                "amount": "50.00",
                "date": "2026-11-20",
                "paymentMethod": "bank_transfer",
                "reference": "NL-TRX-0001",
                "depositTo": "bank",
            })),
        )
        .await;
    assert_eq!(paid["data"]["amountPaid"], "50.00");
    contract
        .success(&app, "getInvoice", &[("id", booked.as_str())], &[], None)
        .await;

    // A copy, a credit note of the sent invoice; the note is cancelled and
    // the copy deleted.
    let copy = id(&contract
        .success(
            &app,
            "duplicateInvoice",
            &[("id", booked.as_str())],
            &[],
            None,
        )
        .await);
    let note = id(&contract
        .success(
            &app,
            "createCreditNote",
            &[("id", sent.as_str())],
            &[],
            None,
        )
        .await);
    contract
        .success(&app, "getInvoice", &[("id", note.as_str())], &[], None)
        .await;
    contract
        .success(&app, "listInvoices", &[], &[("status", "draft")], None)
        .await;
    let cancelled = contract
        .success(
            &app,
            "setInvoiceStatus",
            &[("id", note.as_str())],
            &[],
            Some(&json!({ "status": "cancelled" })),
        )
        .await;
    assert_eq!(cancelled["data"]["status"], "cancelled");
    contract
        .success(&app, "deleteInvoice", &[("id", copy.as_str())], &[], None)
        .await;
    let all = contract
        .success(&app, "listInvoices", &[], &[("pageSize", "100")], None)
        .await;
    assert_eq!(all["data"].as_array().map(Vec::len), Some(3));

    // Money paid on the supplier's bill.
    let payment = contract
        .success(
            &app,
            "createPayment",
            &[],
            &[],
            Some(&json!({
                "type": "sent",
                "amount": "121.00",
                "date": "2026-11-21",
                "billId": bill,
                "contactId": supplier,
                "paymentMethod": "bank_transfer",
                "reference": "SUP-2026-17",
            })),
        )
        .await;
    assert!(payment["data"]["id"].is_string());

    // Refusals decode as the file's error: a body that fails validation
    // (Zod's shape, without `code`), a second booking and a missing invoice.
    let invalid = contract
        .failure(&app, "createInvoice", &[], Some(&json!({})))
        .await;
    assert_eq!(invalid.status, 400);
    let again = contract
        .failure(&app, "finalizeInvoice", &[("id", booked.as_str())], None)
        .await;
    assert_eq!(again.status, 400);
    let missing = contract
        .failure(&app, "getInvoice", &[("id", "inv_missing")], None)
        .await;
    assert_eq!(missing.status, 404);

    contract.finish_only(SALES_OPERATIONS);
}
