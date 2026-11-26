//! Matching one bank line to several documents (Rust only, edition feature
//! `books-bank-links`) on the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`): a customer pays two invoices in
//! one transfer, €0.50 short; the shortfall is refused without an account and
//! booked as bank costs with one; undoing the match opens both invoices
//! again; and money beyond the invoices stays on the contact as credit.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_matching::{
    DifferenceAccount, DocumentShare, reconcile_to_documents, score_line_for_document, unreconcile,
};
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;

async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
) -> String {
    let id = generate_id("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(side)
    .execute(db)
    .await
    .expect("account");
    id
}

/// A Dutch company with debtors, a bank account and a bank costs account:
/// (entity, bank account, bank costs account).
async fn company(db: &PgPool) -> (String, String, String) {
    let entity = generate_id("ent");
    sqlx::query(
        r#"insert into entities (id, name, jurisdiction_code, base_currency, is_active,
             tax_identifiers, bank_details, address)
           values ($1, 'Bank links test', 'NL', 'EUR', true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb,
             '{"iban": "NL91ABNA0417164300"}'::jsonb,
             '{"street": "Main 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb)"#,
    )
    .bind(&entity)
    .execute(db)
    .await
    .expect("entity");
    account(db, &entity, "1300", "Debtors", "asset", "debit").await;
    account(db, &entity, "1600", "Creditors", "liability", "credit").await;
    let costs = account(db, &entity, "4610", "Bank costs", "expense", "debit").await;
    let ledger = account(db, &entity, "1100", "Bank", "asset", "debit").await;
    let bank = generate_id("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency, ledger_account_id, is_default) \
         values ($1, $2, 'Current account', 'EUR', $3, true)",
    )
    .bind(&bank)
    .bind(&entity)
    .bind(&ledger)
    .execute(db)
    .await
    .expect("bank account");
    (entity, bank, costs)
}

async fn customer(db: &PgPool) -> String {
    let id = generate_id("acn");
    sqlx::query(
        "insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme Trading', 'customer')",
    )
    .bind(&id)
    .execute(db)
    .await
    .expect("customer");
    id
}

/// A sent invoice of `total` that nothing has paid yet.
async fn invoice(db: &PgPool, entity: &str, party: &str, number: &str, total: &str) -> String {
    let id = generate_id("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
           issue_date, due_date, currency, total, amount_paid, balance_due) \
         values ($1, $2, $3, 'invoice', 'sent', $4, 'Acme Trading', '2026-11-01', '2026-12-01', 'EUR', \
           $5::numeric, 0, $5::numeric)",
    )
    .bind(&id)
    .bind(entity)
    .bind(number)
    .bind(party)
    .bind(total)
    .execute(db)
    .await
    .expect("invoice");
    id
}

async fn bank_line(
    db: &PgPool,
    entity: &str,
    bank: &str,
    amount: &str,
    description: &str,
) -> Value {
    let id = generate_id("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
           counterparty_name, status) \
         values ($1, $2, $3, '2026-11-20', $4::numeric, $5, 'ACME TRADING BV', 'unreconciled')",
    )
    .bind(&id)
    .bind(entity)
    .bind(bank)
    .bind(amount)
    .bind(description)
    .execute(db)
    .await
    .expect("bank line");
    reload(db, &id).await
}

async fn reload(db: &PgPool, id: &str) -> Value {
    BANK_TRANSACTIONS
        .find_live(db, id)
        .await
        .expect("line")
        .expect("line exists")
}

/// (status, balance due) of an invoice.
async fn invoice_state(db: &PgPool, id: &str) -> (String, String) {
    sqlx::query_as("select status, balance_due::text from invoices where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("invoice state")
}

/// The live lines of a journal entry: (account, debit, credit) as text.
async fn entry_lines(db: &PgPool, entry: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "select account_id, coalesce(debit, 0)::numeric(18,2)::text, coalesce(credit, 0)::numeric(18,2)::text \
         from journal_lines where journal_entry_id = $1 and deleted_at is null order by account_id",
    )
    .bind(entry)
    .fetch_all(db)
    .await
    .expect("entry lines")
}

fn share(id: &str, amount: f64) -> DocumentShare {
    DocumentShare {
        invoice: true,
        id: id.to_owned(),
        amount,
    }
}

#[allow(clippy::too_many_lines)] // one scenario, read top to bottom
#[tokio::test]
async fn one_transfer_settles_two_invoices_and_books_the_shortfall() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let (entity, bank, costs) = company(&db).await;
    let acme = customer(&db).await;
    let first = invoice(&db, &entity, &acme, "BL-2026-001", "100.00").await;
    let second = invoice(&db, &entity, &acme, "BL-2026-002", "50.00").await;
    let line = bank_line(
        &db,
        &entity,
        &bank,
        "149.50",
        "Payment BL-2026-001 BL-2026-002",
    )
    .await;

    // The line names the first invoice and its customer.
    let (confidence, reasons) = score_line_for_document(
        &line,
        &json!({
            "invoiceNumber": "BL-2026-001",
            "contactName": "Acme Trading",
            "balanceDue": "100.00",
            "issueDate": "2026-11-01T00:00:00.000Z",
            "dueDate": "2026-12-01T00:00:00.000Z",
        }),
        true,
        Some(("Acme Trading", None)),
    );
    assert!(confidence >= 0.4, "confidence {confidence}");
    assert!(
        reasons.iter().any(|r| r == "invoice number in reference"),
        "{reasons:?}"
    );

    // The invoices take €0.50 more than came in: refused without an account.
    let shares = [share(&first, 100.0), share(&second, 50.0)];
    let refused = reconcile_to_documents(&db, None, &line, &shares, None, None)
        .await
        .expect_err("a shortfall needs an account");
    assert!(
        refused.to_string().contains("add up to 150.00"),
        "{refused}"
    );

    // With bank costs as the account: one payment of 149.50 settles both.
    let matched = reconcile_to_documents(
        &db,
        None,
        &line,
        &shares,
        Some(DifferenceAccount {
            account_id: costs.clone(),
            description: Some("Bank costs".to_owned()),
        }),
        None,
    )
    .await
    .expect("matched");
    assert_eq!(
        invoice_state(&db, &first).await,
        ("paid".to_owned(), "0.00".to_owned())
    );
    assert_eq!(
        invoice_state(&db, &second).await,
        ("paid".to_owned(), "0.00".to_owned())
    );
    let reconciled = reload(&db, line["id"].as_str().expect("id")).await;
    assert_eq!(reconciled["status"], "reconciled");
    assert_eq!(reconciled["reconciledPaymentId"], json!(matched.id));
    let (amount, allocations): (String, i64) = sqlx::query_as(
        "select amount::text, (select count(*) from payment_allocations a where a.payment_id = p.id) \
         from payments p where id = $1",
    )
    .bind(&matched.id)
    .fetch_one(&db)
    .await
    .expect("payment");
    assert_eq!((amount.as_str(), allocations), ("149.50", 2));
    let lines = entry_lines(&db, matched.journal_entry_id.as_deref().expect("entry")).await;
    let total = |pick: fn(&(String, String, String)) -> &String| -> f64 {
        lines
            .iter()
            .map(|l| pick(l).parse::<f64>().expect("amount"))
            .sum()
    };
    assert!(
        (total(|l| &l.1) - total(|l| &l.2)).abs() < 0.001,
        "{lines:?}"
    );
    assert!(
        lines
            .iter()
            .any(|(account, debit, _)| account == &costs && debit == "0.50"),
        "the shortfall is a bank cost: {lines:?}"
    );

    // Undoing the match voids the payment: both invoices are open again.
    unreconcile(&db, &reconciled, None).await.expect("undone");
    assert_eq!(invoice_state(&db, &first).await.1, "100.00");
    assert_eq!(invoice_state(&db, &second).await.1, "50.00");
    let undone = reload(&db, line["id"].as_str().expect("id")).await;
    assert_eq!(undone["status"], "unreconciled");

    // €120 in against the €100 invoice, without an account: the €20 stays as credit.
    let over = bank_line(&db, &entity, &bank, "120.00", "Acme").await;
    let matched = reconcile_to_documents(&db, None, &over, &[share(&first, 100.0)], None, None)
        .await
        .expect("overpaid");
    assert_eq!(invoice_state(&db, &first).await.1, "0.00");
    let (amount, partial): (String, Option<bool>) =
        sqlx::query_as("select amount::text, is_partial from payments where id = $1")
            .bind(&matched.id)
            .fetch_one(&db)
            .await
            .expect("payment");
    assert_eq!((amount.as_str(), partial), ("120.00", Some(true)));
}
