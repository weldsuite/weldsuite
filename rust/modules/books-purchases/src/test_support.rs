//! What the phase 3 tests share (`WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; each test returns early without it): a world
//! with a recording event bus, fresh entities with a chart of accounts, VAT,
//! a bank account and suppliers, and the rows a booking starts from. Every
//! row carries fresh ids, so runs share the database.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::sync::Arc;

use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::{BooksState, Caller, Reply};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

/// Tests that move the workspace's default entity or its one settings row
/// take this first: they would trip over each other.
pub(crate) static DEFAULT_ENTITY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct World {
    pub db: PgPool,
    pub state: BooksState,
    pub bus: Arc<RecordingEventBus>,
}

impl World {
    pub(crate) fn new() -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        let db = weldsuite_db::master_pool(&url, 2).unwrap();
        let bus = Arc::new(RecordingEventBus::new());
        let state = BooksState::new(EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            TaskTracker::new(),
        ));
        Some(Self { db, state, bus })
    }

    pub(crate) fn caller(&self, entity: &str) -> Caller {
        Caller::in_process(
            self.db.clone(),
            "ws_p3_test",
            "ws_p3_test",
            "user_p3",
            entity,
            None,
        )
    }

    /// The events published since the last call, as `entityType.action` with
    /// their data, in order.
    pub(crate) async fn events(&self) -> Vec<(String, Value)> {
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                (
                    format!(
                        "{}.{}",
                        payload["entityType"].as_str().unwrap_or_default(),
                        payload["action"].as_str().unwrap_or_default()
                    ),
                    payload["data"].clone(),
                )
            })
            .collect();
        self.bus.clear();
        events
    }
}

pub(crate) fn fresh(prefix: &str) -> String {
    weldsuite_kit::generate_id(prefix)
}

pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// A handler's answer as (status, body).
pub(crate) async fn answer(reply: Reply) -> (u16, Value) {
    let response: Response = match reply {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed"),
    };
    answer_of(response).await
}

pub(crate) async fn answer_of(response: Response) -> (u16, Value) {
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

pub(crate) async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
    role: Option<&str>,
) -> String {
    let id = fresh("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side, metadata) \
         values ($1, $2, $3, $4, $5, $6, case when $7::text is null then null else jsonb_build_object('systemRole', $7::text) end)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(side)
    .bind(role)
    .execute(db)
    .await
    .unwrap();
    id
}

/// A Dutch BV that books bills: creditors, VAT input at 21%, two expense
/// accounts, a bank account with a ledger account.
pub(crate) struct Company {
    pub entity: String,
    pub bank: String,
    pub bank_ledger: String,
    pub rent: String,
    pub office: String,
    pub vat21: String,
}

pub(crate) async fn company(db: &PgPool, iban: &str) -> Company {
    let entity = fresh("ent");
    sqlx::query(
        r#"insert into entities (id, name, jurisdiction_code, base_currency, entity_type, is_active,
             tax_identifiers, bank_details, address)
           values ($1, 'Phase 3 test', 'NL', 'EUR', 'bv', true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb, '{}'::jsonb,
             '{"street": "Main 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb)"#,
    )
    .bind(&entity)
    .execute(db)
    .await
    .unwrap();
    // WeldBooks is on for the entity (what makes it a candidate for the default).
    sqlx::query("insert into accounting_entity_settings (entity_id) values ($1)")
        .bind(&entity)
        .execute(db)
        .await
        .unwrap();
    account(db, &entity, "1300", "Debtors", "asset", "debit", None).await;
    account(
        db,
        &entity,
        "1600",
        "Creditors",
        "liability",
        "credit",
        None,
    )
    .await;
    let input = account(
        db,
        &entity,
        "1730",
        "VAT input",
        "asset",
        "debit",
        Some("tax_input"),
    )
    .await;
    let bank_ledger = account(db, &entity, "1100", "Bank", "asset", "debit", None).await;
    let rent = account(db, &entity, "4210", "Rent", "expense", "debit", None).await;
    let office = account(db, &entity, "4300", "Office", "expense", "debit", None).await;
    let vat21 = fresh("tax");
    sqlx::query(
        "insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type, ledger_account_id) \
         values ($1, $2, 'NL', 'VAT 21%', 21, 'purchase', $3)",
    )
    .bind(&vat21)
    .bind(&entity)
    .bind(&input)
    .execute(db)
    .await
    .unwrap();
    let bank = fresh("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id) \
         values ($1, $2, 'Bank', $3, 'EUR', $4)",
    )
    .bind(&bank)
    .bind(&entity)
    .bind(iban)
    .bind(&bank_ledger)
    .execute(db)
    .await
    .unwrap();
    Company {
        entity,
        bank,
        bank_ledger,
        rent,
        office,
        vat21,
    }
}

pub(crate) async fn supplier(db: &PgPool, name: &str, iban: Option<&str>) -> String {
    let id = fresh("pty");
    sqlx::query(
        "insert into parties (id, kind, display_name, role, iban) values ($1, 'company', $2, 'supplier', $3)",
    )
    .bind(&id)
    .bind(name)
    .bind(iban)
    .execute(db)
    .await
    .unwrap();
    id
}

/// An inbox document of `entity` that was read (`ocr`), by file name and size.
pub(crate) async fn document(
    db: &PgPool,
    entity: Option<&str>,
    name: &str,
    size: i32,
    status: &str,
    ocr: Option<&Value>,
) -> String {
    let id = fresh("doc");
    sqlx::query(
        "insert into documents (id, entity_id, type, file_name, original_file_name, file_key, file_size, \
           mime_type, source, status, ocr_result) \
         values ($1, $2, 'purchase_invoice', $3, $3, 'workspaces/ws_p3_test/accounting/inbox/x/a.pdf', $4, \
           'application/pdf', 'upload', $5, $6)",
    )
    .bind(&id)
    .bind(entity)
    .bind(name)
    .bind(size)
    .bind(status)
    .bind(ocr)
    .execute(db)
    .await
    .unwrap();
    id
}

pub(crate) async fn bank_line(
    db: &PgPool,
    entity: &str,
    bank: &str,
    date: &str,
    amount: &str,
    description: &str,
    counterparty: (Option<&str>, Option<&str>),
) -> String {
    let id = fresh("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
           counterparty_name, counterparty_iban, status) \
         values ($1, $2, $3, $4::timestamp, $5::numeric, $6, $7, $8, 'unreconciled')",
    )
    .bind(&id)
    .bind(entity)
    .bind(bank)
    .bind(date)
    .bind(amount)
    .bind(description)
    .bind(counterparty.0)
    .bind(counterparty.1)
    .execute(db)
    .await
    .unwrap();
    id
}

pub(crate) async fn row_of(db: &PgPool, table: &str, id: &str) -> Value {
    let query = format!("select to_jsonb(t) from {table} t where id = $1");
    sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(query))
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

pub(crate) async fn count(db: &PgPool, sql: &'static str, bind: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(bind)
        .fetch_one(db)
        .await
        .unwrap()
}

/// The request body of `POST /:id/book`, read as the route reads it.
pub(crate) fn book_body(body: &Value) -> crate::document_booking::BookBody {
    weldsuite_books_domain::http::validate_value(body, crate::document_booking::read_book)
        .unwrap()
        .unwrap()
}

/// A scanned supplier invoice: what OCR leaves on a document.
pub(crate) fn ocr_result(name: &str, iban: &str, number: &str, date: &str, total: f64) -> Value {
    json!({
        "vendor": { "name": name, "iban": iban, "address": null, "taxNumber": null, "kvkNumber": null, "bic": null },
        "invoiceNumber": number,
        "invoiceDate": date,
        "dueDate": null,
        "currency": "EUR",
        "lineItems": [],
        "subtotal": null,
        "taxBreakdown": [{ "rate": 21, "taxableAmount": 0, "taxAmount": 0 }],
        "totalTax": null,
        "total": total,
        "paymentReference": null,
        "iban": iban,
        "documentKind": "receipt",
        "paid": true,
        "paymentMethod": "card",
        "confidence": { "overall": 0.9, "fields": {} },
        "rawText": null,
    })
}
