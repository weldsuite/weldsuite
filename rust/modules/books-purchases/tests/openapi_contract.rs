//! What the native WeldBooks apps read from the purchases area (bills, the
//! document inbox and the accounting contacts), held against the file they
//! generate their client from (`apps/mobile-shared/openapi/weldbooks.yaml`):
//! every operation of the file this crate serves, sent as the file describes
//! it through the routers as the server mounts them, on the real tenant
//! schema (`weldsuite_kit::openapi_contract`). A change to these routes that
//! would break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says. The file's
//! other operations are checked by the other books crates' tests.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! tenant database is shared with every other crate's tests and isn't wiped
//! between runs, so every row the test seeds carries a tag of its own run
//! (`bkp<run>_…`) and nothing is cleaned. The receipt is read by a scripted
//! model (`weldsuite_ai::FakeProvider`) from an in-memory bucket.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use serde_json::{Value, json};
use weldsuite_ai::config::Endpoint;
use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};
use weldsuite_auth::AuthContext;
use weldsuite_books_domain::contacts::set_billing_contact;
use weldsuite_books_domain::http::BooksState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynFileStore, FileStores, MemoryFileStore, PutOptions};

const USER: &str = "user_books_purchases_contract";
/// The organization id: uploaded files live under `workspaces/<it>/`.
const ORG: &str = "org_books_purchases_contract";
const WORKSPACE: &str = "ws_books_purchases_contract";

/// The operations of weldbooks.yaml this crate serves.
const PURCHASES_OPERATIONS: &[&str] = &[
    "listBills",
    "createBill",
    "getBill",
    "deleteBill",
    "approveBill",
    "rejectBill",
    "billFromDocument",
    "createAccountingDocument",
    "getAccountingDocument",
    "processAccountingDocument",
    "listAccountingContacts",
    "createAccountingContact",
    "getAccountingContact",
    "deleteAccountingContact",
    "getContactBalance",
    "listContactInvoices",
    "listContactBills",
];

/// The run's rows, `RUN` being its tag and `ORG_ID` the organization: a
/// Dutch company with WeldBooks on and the accounts a bill posts to; a
/// supplier (a CRM company with a billing contact, a 1099 vendor) and a
/// customer (a CRM person, no name of its own); two invoices of the
/// customer, one booked and one a bare draft credit note; and a receipt
/// already read, with nothing but a total.
const FIXTURES: &str = r#"
insert into entities (id, name, legal_name, jurisdiction_code, base_currency, is_active, is_default, timezone, tax_identifiers, bank_details, address) values
    ('bkpRUN_ent', 'Purchases contract RUN', 'Purchases Contract B.V.', 'NL', 'EUR', true, false, 'Europe/Amsterdam',
     '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}',
     '{"iban": "NL91ABNA0417164300", "bic": "ABNANL2A"}',
     '{"line1": "Herengracht 1", "city": "Amsterdam", "postalCode": "1015BA", "country": "NL"}');
insert into accounting_entity_settings (entity_id) values ('bkpRUN_ent');
insert into accounts (id, entity_id, code, name, type, subtype, normal_side) values
    ('bkpRUN_a1100', 'bkpRUN_ent', '1100', 'Bank', 'asset', 'bank', 'debit'),
    ('bkpRUN_a1300', 'bkpRUN_ent', '1300', 'Debtors', 'asset', null, 'debit'),
    ('bkpRUN_a1600', 'bkpRUN_ent', '1600', 'Creditors', 'liability', null, 'credit'),
    ('bkpRUN_a1700', 'bkpRUN_ent', '1700', 'VAT payable', 'liability', null, 'credit'),
    ('bkpRUN_a1730', 'bkpRUN_ent', '1730', 'VAT receivable', 'asset', null, 'debit'),
    ('bkpRUN_a4600', 'bkpRUN_ent', '4600', 'General expenses', 'expense', null, 'debit'),
    ('bkpRUN_a8000', 'bkpRUN_ent', '8000', 'Revenue', 'revenue', null, 'credit');

insert into companies (id, name, display_name, vat_number, registration_number, email, phone, status) values
    ('bkpRUN_cmp', 'Paper Supplier RUN B.V.', 'Paper Supplier RUN', 'NL123456789B01', '12345678', 'invoices@paper-RUN.test', '+31 20 555 0100', 'active');
insert into people (id, first_name, last_name, full_name, display_name, email, direct_phone, in_crm) values
    ('bkpRUN_bc', 'Ann', 'Billing', 'Ann Billing', 'Ann Billing RUN', 'ann.billing.RUN@paper.test', '+31 6 1234 5678', true),
    ('bkpRUN_per', 'Ada', 'Lovelace', 'Ada Lovelace', 'Ada Lovelace RUN', 'ada.RUN@example.test', null, true);
insert into parties (id, kind, company_id, person_id, display_name, role, billing_address, iban, is_1099_vendor, tin_type, tin_last4) values
    ('bkpRUN_sup', 'company', 'bkpRUN_cmp', null, 'Paper Supplier RUN', 'supplier',
     '{"line1": "Damrak 5", "city": "Amsterdam", "postalCode": "1012LG", "country": "NL"}',
     'NL91ABNA0417164300', true, 'ein', '6789'),
    ('bkpRUN_cus', 'person', null, 'bkpRUN_per', null, 'customer', null, null, null, null, null);

insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, contact_email, issue_date, due_date, currency, exchange_rate, subtotal, tax_total, total, amount_paid, balance_due, notes, reference, billing_address, tax_breakdown, tax_warnings, credit_note_for_invoice_id) values
    ('bkpRUN_inv1', 'bkpRUN_ent', 'INV-RUN-1', 'standard', 'sent', 'bkpRUN_cus', 'Ada Lovelace RUN', 'ada.RUN@example.test',
     '2026-10-01', '2026-10-31', 'EUR', 1, 100.00, 21.00, 121.00, 21.00, 100.00, 'Consulting, October', 'PO-1',
     '{"line1": "Prinsengracht 2", "city": "Amsterdam", "postalCode": "1015DV", "country": "NL"}',
     '[{"taxRateName": "21%", "taxRate": 21, "taxableAmount": 100, "taxAmount": 21}]', '[]', null),
    ('bkpRUN_inv2', 'bkpRUN_ent', null, 'credit_note', 'draft', 'bkpRUN_cus', null, null,
     '2026-11-01', '2026-11-01', null, null, null, null, null, null, null, null, null,
     null, null, null, 'bkpRUN_inv1');

insert into documents (id, entity_id, type, file_name, file_key, mime_type, source, status, ocr_result, ocr_processed_at) values
    ('bkpRUN_doc', null, 'receipt', 'parking.jpg', 'workspaces/ORG_ID/accounting/RUN/parking.jpg', null, 'scan', 'processed',
     '{"total": 12.5}', now());
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

/// The purchases routers under `/api`, behind the session, tenant and
/// permission layers, for the workspace owner, with `entity` named in
/// `X-Accounting-Entity-Id` (the legal-entity layer resolves it).
fn app(db: &PgPool, entity: Option<&str>, books: &BooksState) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let router = weldsuite_books_purchases::routers(books, &gate)
        .into_iter()
        .fold(Router::new(), |router, (prefix, routes)| {
            router.nest(&format!("/api{prefix}"), routes)
        });
    let owner = ResolvedPermissions {
        permissions: vec!["*".to_owned()],
        role: "OWNER".to_owned(),
        is_owner: true,
        ..ResolvedPermissions::default()
    };
    let entity = entity.map(|id| http::HeaderValue::from_str(id).expect("an entity id"));
    let db = db.clone();
    router.layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            if let Some(entity) = &entity {
                request
                    .headers_mut()
                    .insert("x-accounting-entity-id", entity.clone());
            }
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some(ORG.to_owned()),
                session_id: "sess_books_purchases_contract".to_owned(),
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
                owner.clone(),
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

/// This run's tag: the low 40 bits of the clock's nanoseconds, in hex.
fn run_tag() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{:010x}", nanos & 0xff_ffff_ffff)
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// A one-page PDF, as the bucket holds the photographed receipt.
fn pdf() -> Vec<u8> {
    b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n".to_vec()
}

/// Mistral as the install provider, answered by `fake`.
fn ai(fake: &FakeProvider) -> Ai {
    let config = AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: Endpoint {
            base_url: "https://api.mistral.ai/v1".to_owned(),
            api_key: Some("key".to_owned()),
        },
        ..AiConfig::default()
    };
    Ai::fake(config, fake.clone())
}

/// Every operation of weldbooks.yaml the purchases crate serves, with data
/// that gives the nullable fields more than one value: a company supplier
/// with a billing contact and one without, a person customer without a
/// name of its own; a bill with lines from a read receipt, one without
/// lines (deleted) and one rejected; a receipt read now and one read before.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn books_purchases_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    let run = run_tag();
    let tag = format!("bkp{run}");
    // The run tag is hex and the organization a constant: nothing to escape.
    sqlx::raw_sql(sqlx::AssertSqlSafe(
        FIXTURES.replace("RUN", &run).replace("ORG_ID", ORG),
    ))
    .execute(&db)
    .await
    .expect("fixtures");
    set_billing_contact(&db, &format!("{tag}_cmp"), &format!("{tag}_bc"))
        .await
        .expect("billing contact");

    // The receipt the phone uploaded, and the model that reads it.
    let store = Arc::new(MemoryFileStore::default());
    let receipt_key = format!("workspaces/{ORG}/accounting/{run}/receipt.pdf");
    store
        .put_boxed(&receipt_key, pdf(), &PutOptions::default())
        .await
        .expect("upload");
    let fake = FakeProvider::new().reply_json(&json!({
        "vendor": { "name": format!("Office Goods {run}") },
        "invoiceNumber": "OG-2026-118",
        "invoiceDate": "2026-11-03",
        "dueDate": "2026-11-17",
        "currency": "EUR",
        "lineItems": [
            { "description": "Printer paper", "quantity": 10, "unitPrice": 4.5, "taxRate": 21, "total": 45 },
            { "description": "Delivery", "quantity": 1, "unitPrice": 5, "total": 5 },
        ],
        "subtotal": 50,
        "taxBreakdown": [{ "rate": 21, "taxableAmount": 45, "taxAmount": 9.45 }],
        "totalTax": 9.45,
        "total": 59.45,
        "confidence": { "overall": 0.93 },
    }));
    let mut books = BooksState::new(EntityEventPublisher::new(None, TaskTracker::new()));
    books.files = Some(FileStores {
        private: store as Arc<dyn DynFileStore>,
        public: None,
    });
    books.ai = Some(ai(&fake));
    let entity = format!("{tag}_ent");
    let app = app(&db, Some(&entity), &books);
    let contract = Contract::load("weldbooks");

    // Contacts: a company supplier and a person to delete again.
    let supplier = id(&contract
        .success(
            &app,
            "createAccountingContact",
            &[],
            &[],
            Some(&json!({
                "kind": "company",
                "fullName": format!("Office Goods {run}"),
                "companyName": format!("Office Goods {run} B.V."),
                "email": format!("billing.{run}@office-goods.test"),
                "phone": "+31 20 555 0199",
                "vatNumber": "NL123456789B01",
                "role": "supplier",
                "billingAddress": {
                    "line1": "Kalverstraat 10",
                    "city": "Amsterdam",
                    "postalCode": "1012PC",
                    "country": "NL",
                },
            })),
        )
        .await);
    let temporary = id(&contract
        .success(
            &app,
            "createAccountingContact",
            &[],
            &[],
            Some(&json!({
                "kind": "person",
                "fullName": format!("Temp Contact {run}"),
                "firstName": "Temp",
                "lastName": "Contact",
                "email": format!("temp.{run}@example.test"),
                "role": "none",
            })),
        )
        .await);
    let paper = format!("{tag}_sup");
    let customer = format!("{tag}_cus");
    for contact in [&supplier, &temporary, &paper, &customer] {
        contract
            .success(
                &app,
                "getAccountingContact",
                &[("id", contact.as_str())],
                &[],
                None,
            )
            .await;
    }
    let listed = contract
        .success(
            &app,
            "listAccountingContacts",
            &[],
            &[("search", run.as_str())],
            None,
        )
        .await;
    assert!(
        listed["data"]
            .as_array()
            .is_some_and(|rows| rows.len() >= 2),
        "the run's contacts are found: {listed}"
    );
    contract
        .success(
            &app,
            "listAccountingContacts",
            &[],
            &[
                ("search", run.as_str()),
                ("role", "supplier"),
                ("page", "1"),
                ("pageSize", "1"),
            ],
            None,
        )
        .await;

    // The document inbox: the receipt registered, read, and the receipt
    // read before.
    let receipt = id(&contract
        .success(
            &app,
            "createAccountingDocument",
            &[],
            &[],
            Some(&json!({
                "type": "receipt",
                "fileName": "receipt.pdf",
                "originalFileName": "IMG_0042.pdf",
                "fileKey": receipt_key,
                "mimeType": "application/pdf",
                "source": "scan",
            })),
        )
        .await);
    let parking = format!("{tag}_doc");
    for document in [&receipt, &parking] {
        contract
            .success(
                &app,
                "getAccountingDocument",
                &[("id", document.as_str())],
                &[],
                None,
            )
            .await;
    }
    let processed = contract
        .success(
            &app,
            "processAccountingDocument",
            &[("id", receipt.as_str())],
            &[],
            None,
        )
        .await;
    assert_eq!(processed["data"]["status"], "processed");
    contract
        .success(
            &app,
            "getAccountingDocument",
            &[("id", receipt.as_str())],
            &[],
            None,
        )
        .await;
    let prefill = contract
        .success(
            &app,
            "billFromDocument",
            &[("id", receipt.as_str())],
            &[],
            None,
        )
        .await;
    assert_eq!(prefill["data"]["items"].as_array().map(Vec::len), Some(2));
    contract
        .success(
            &app,
            "billFromDocument",
            &[("id", parking.as_str())],
            &[],
            None,
        )
        .await;

    // Bills: the receipt's, with lines; a bare one (deleted); one rejected.
    let expense_account = format!("{tag}_a4600");
    let bill = id(&contract
        .success(
            &app,
            "createBill",
            &[],
            &[],
            Some(&json!({
                "contactId": supplier,
                "contactName": format!("Office Goods {run}"),
                "issueDate": "2026-11-03",
                "dueDate": "2026-11-17",
                "currency": "EUR",
                "notes": "Paper for the office",
                "reference": format!("PO-{run}"),
                "externalReference": "OG-2026-118",
                "sourceDocumentId": receipt,
                "deliveryAddress": {
                    "line1": "Herengracht 1",
                    "city": "Amsterdam",
                    "postalCode": "1015BA",
                    "country": "NL",
                },
                "items": [
                    { "description": "Printer paper", "quantity": "10", "unitPrice": "4.50", "taxRate": "21", "sortOrder": 0 },
                    { "description": "Delivery", "quantity": "1", "unitPrice": "5.00", "taxRate": "9", "accountId": expense_account, "sortOrder": 1 },
                ],
            })),
        )
        .await);
    let bare = id(&contract
        .success(
            &app,
            "createBill",
            &[],
            &[],
            Some(&json!({
                "contactId": paper,
                "issueDate": "2026-11-20",
                "dueDate": "2026-12-20",
            })),
        )
        .await);
    let doubtful = id(&contract
        .success(
            &app,
            "createBill",
            &[],
            &[],
            Some(&json!({
                "contactId": paper,
                "billNumber": format!("PS-{run}"),
                "issueDate": "2026-11-21",
                "dueDate": "2026-12-21",
                "items": [{ "description": "Coffee beans", "unitPrice": "18.00" }],
            })),
        )
        .await);
    contract.success(&app, "listBills", &[], &[], None).await;
    contract
        .success(
            &app,
            "listBills",
            &[],
            &[("status", "draft"), ("page", "1"), ("pageSize", "2")],
            None,
        )
        .await;
    let found = contract
        .success(&app, "listBills", &[], &[("search", "OG-2026-118")], None)
        .await;
    assert_eq!(found["data"].as_array().map(Vec::len), Some(1));
    for shown in [&bill, &bare] {
        contract
            .success(&app, "getBill", &[("id", shown.as_str())], &[], None)
            .await;
    }
    contract
        .success(&app, "approveBill", &[("id", bill.as_str())], &[], None)
        .await;
    contract
        .success(&app, "getBill", &[("id", bill.as_str())], &[], None)
        .await;
    contract
        .success(
            &app,
            "rejectBill",
            &[("id", doubtful.as_str())],
            &[],
            Some(&json!({ "reason": "Ordered twice" })),
        )
        .await;
    contract
        .success(&app, "deleteBill", &[("id", bare.as_str())], &[], None)
        .await;

    // What each contact owes and is owed, and its documents.
    for contact in [&supplier, &paper, &customer] {
        contract
            .success(
                &app,
                "getContactBalance",
                &[("id", contact.as_str())],
                &[],
                None,
            )
            .await;
        contract
            .success(
                &app,
                "listContactBills",
                &[("id", contact.as_str())],
                &[],
                None,
            )
            .await;
    }
    let invoices = contract
        .success(
            &app,
            "listContactInvoices",
            &[("id", customer.as_str())],
            &[],
            None,
        )
        .await;
    assert_eq!(invoices["data"].as_array().map(Vec::len), Some(2));
    contract
        .success(
            &app,
            "deleteAccountingContact",
            &[("id", temporary.as_str())],
            &[],
            None,
        )
        .await;

    // Refusals decode as the file's error: a body that fails validation, a
    // bill without its supplier, and records that aren't there.
    let invalid = contract
        .failure(&app, "createAccountingDocument", &[], Some(&json!({})))
        .await;
    assert_eq!(invalid.status, 400);
    let invalid = contract
        .failure(
            &app,
            "createBill",
            &[],
            Some(&json!({ "issueDate": "2026-11-03", "dueDate": "2026-11-17" })),
        )
        .await;
    assert_eq!(invalid.status, 400);
    let missing = contract
        .failure(&app, "getBill", &[("id", "bil_missing")], None)
        .await;
    assert_eq!(missing.status, 404);
    let missing = contract
        .failure(
            &app,
            "processAccountingDocument",
            &[("id", "doc_missing")],
            None,
        )
        .await;
    assert_eq!(missing.status, 404);

    contract.finish_only(PURCHASES_OPERATIONS);
}
