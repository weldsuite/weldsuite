//! What the phase 4 tests share (`WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; each test returns early without it): a world
//! with a recording event bus and a recording mail transport, fresh legal
//! entities, contacts, invoices and quotes. Every row carries fresh ids, so
//! runs share the database.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    dead_code,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::{BooksState, Caller, Reply};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{DynEventBus, DynSystemMail, RecordingEventBus, RecordingSystemMail};

/// Tests that move the workspace's default entity take this first.
pub(crate) static DEFAULT_ENTITY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) const PORTAL: &str = "https://pay.example.test";
pub(crate) const WORKSPACE: &str = "ws_p4_test";

pub(crate) struct World {
    pub db: PgPool,
    pub state: BooksState,
    pub bus: Arc<RecordingEventBus>,
    pub mail: Arc<RecordingSystemMail>,
}

impl World {
    /// A world whose mail goes to a recording transport and whose links are on.
    pub(crate) fn new() -> Option<Self> {
        Self::with_mail(Arc::new(RecordingSystemMail::new()))
    }

    pub(crate) fn with_mail(mail: Arc<RecordingSystemMail>) -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        let db = weldsuite_db::master_pool(&url, 2).unwrap();
        let bus = Arc::new(RecordingEventBus::new());
        let mut state = BooksState::new(EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            TaskTracker::new(),
        ));
        state.mail = Some(Arc::clone(&mail) as Arc<dyn DynSystemMail>);
        state.env = Arc::new(HashMap::from([
            ("PAY_PORTAL_PUBLIC_URL".to_owned(), PORTAL.to_owned()),
            (
                "BOOKS_DOCUMENT_TOKEN_SECRET".to_owned(),
                "p4-test-secret".to_owned(),
            ),
        ]));
        Some(Self {
            db,
            state,
            bus,
            mail,
        })
    }

    pub(crate) fn caller(&self, entity: &str) -> Caller {
        Caller::in_process(
            self.db.clone(),
            WORKSPACE,
            WORKSPACE,
            "user_p4",
            entity,
            None,
        )
    }

    /// A caller with no member behind it (a trusted in-process caller): it
    /// may name any live entity.
    pub(crate) fn system(&self, entity: &str) -> Caller {
        Caller::in_process(self.db.clone(), WORKSPACE, WORKSPACE, "", entity, None)
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

/// `caller` holding exactly `keys` (the in-process caller holds none).
pub(crate) fn with_permissions(mut caller: Caller, keys: &[&str]) -> Caller {
    caller.permissions = weldsuite_permissions::Permissions::new(
        weldsuite_permissions::ResolvedPermissions {
            permissions: keys.iter().map(|k| (*k).to_owned()).collect(),
            ..weldsuite_permissions::ResolvedPermissions::default()
        },
        None,
        false,
        "user_perm".to_owned(),
    );
    caller
}

pub(crate) fn fresh(prefix: &str) -> String {
    weldsuite_kit::generate_id(prefix)
}

/// A handler's answer as (status, body).
pub(crate) async fn answer(reply: Reply) -> (u16, Value) {
    let response: Response = match reply {
        Ok(response) => response,
        Err(refusal) => {
            eprintln!("refused: {refusal:?}");
            refusal.respond("Failed")
        }
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

/// A Dutch legal entity with an address, VAT and `KvK` numbers, an IBAN, a
/// logo and an e-mail address, in WeldBooks.
pub(crate) async fn entity(
    db: &PgPool,
    name: &str,
    locale: &str,
    settings: Option<Value>,
) -> String {
    let id = fresh("ent");
    sqlx::query(
        r#"insert into entities (id, name, legal_name, jurisdiction_code, base_currency, locale, entity_type,
             is_active, tax_identifiers, bank_details, address, contact, branding, jurisdiction_settings)
           values ($1, $2, $2, 'NL', 'EUR', $3, 'bv', true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb,
             '{"iban": "NL91ABNA0417164300", "bic": "ABNANL2A"}'::jsonb,
             '{"line1": "Hoofdstraat 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb,
             '{"email": "facturen@acme.test", "phone": "+31201234567"}'::jsonb,
             '{"logoUrl": "https://cdn.example.test/logo.png"}'::jsonb, $4)"#,
    )
    .bind(&id)
    .bind(name)
    .bind(locale)
    .bind(settings)
    .execute(db)
    .await
    .unwrap();
    sqlx::query("insert into accounting_entity_settings (entity_id) values ($1)")
        .bind(&id)
        .execute(db)
        .await
        .unwrap();
    id
}

/// A customer: a party that wraps a company (a business) or only a person
/// (a consumer).
pub(crate) async fn customer(db: &PgPool, name: &str, consumer: bool) -> String {
    let id = fresh("pty");
    let (company, person) = if consumer {
        (None, Some(fresh("per")))
    } else {
        (Some(fresh("cmp")), None)
    };
    sqlx::query(
        "insert into parties (id, kind, display_name, role, company_id, person_id, payment_terms) \
         values ($1, $2, $3, 'customer', $4, $5, 'net30')",
    )
    .bind(&id)
    .bind(if consumer { "person" } else { "company" })
    .bind(name)
    .bind(company)
    .bind(person)
    .execute(db)
    .await
    .unwrap();
    id
}

/// An invoice of `entity` for `contact` with one line of 100.00 plus 21%.
pub(crate) async fn invoice(
    db: &PgPool,
    entity: &str,
    contact: &str,
    number: &str,
    status: &str,
    due_days_ago: i64,
    email: Option<&str>,
) -> String {
    let id = fresh("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, contact_email, \
           issue_date, due_date, currency, subtotal, tax_total, total, amount_paid, balance_due, billing_address, notes) \
         values ($1, $2, $3, 'standard', $4, $5, 'Klant BV', $6, now() - interval '60 days', \
           now() - ($7 || ' days')::interval, 'EUR', '100.00', '21.00', '121.00', '0.00', '121.00', \
           '{\"line1\": \"Klantweg 2\", \"city\": \"Utrecht\", \"postalCode\": \"3511AB\", \"country\": \"NL\"}'::jsonb, 'Dank u wel')",
    )
    .bind(&id)
    .bind(entity)
    .bind(number)
    .bind(status)
    .bind(contact)
    .bind(email)
    .bind(due_days_ago.to_string())
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "insert into invoice_items (id, entity_id, invoice_id, description, quantity, unit_price, discount_percent, \
           tax_rate, tax_amount, line_total, line_total_with_tax, sort_order) \
         values ($1, $2, $3, 'Consultancy', '1', '100.00', '0', '21', '21.00', '100.00', '121.00', 0)",
    )
    .bind(fresh("ili"))
    .bind(entity)
    .bind(&id)
    .execute(db)
    .await
    .unwrap();
    id
}

pub(crate) async fn row_of(db: &PgPool, table: &'static str, id: &str) -> Value {
    let query = format!("select to_jsonb(t) from {table} t where id = $1");
    sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(query))
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

/// A WeldCRM quote for `contact` (a party) with two lines (200.00 and 100.00
/// before 21%), valid for `valid_days` more days.
pub(crate) async fn quote(db: &PgPool, contact: &str, status: &str, valid_days: i64) -> String {
    let id = fresh("quote");
    sqlx::query(
        "insert into crm_quotes (id, quote_number, name, customer_id, line_items, subtotal, discount, tax, shipping, total, \
           currency, valid_from, valid_until, status, payment_terms) \
         values ($1, $2, 'Website', $3, $4, '300.00', '0', '63.00', '0', '363.00', 'EUR', now(), \
           now() + ($5 || ' days')::interval, $6, 'net30')",
    )
    .bind(&id)
    .bind(format!("Q-T-{}", &id[id.len() - 6..]))
    .bind(contact)
    .bind(json!([
        { "description": "Design", "quantity": "2", "unitPrice": "100.00", "discountPercent": "0", "taxRate": "21", "lineTotal": "200.00" },
        { "description": "Hosting", "quantity": "1", "unitPrice": "100.00", "discountPercent": "0", "taxRate": "21", "lineTotal": "100.00" },
    ]))
    .bind(valid_days.to_string())
    .bind(status)
    .execute(db)
    .await
    .unwrap();
    id
}

/// Make `entity` the workspace's default legal entity.
pub(crate) async fn make_default(db: &PgPool, entity: &str) {
    sqlx::query("update entities set is_default = false where is_default")
        .execute(db)
        .await
        .unwrap();
    sqlx::query("update entities set is_default = true where id = $1")
        .bind(entity)
        .execute(db)
        .await
        .unwrap();
}
