//! WeldBooks for WeldCommerce's payments (`CommerceInvoicing`), on the real
//! tenant schema (`WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; returns early without it): a paid order becomes
//! a finalised invoice with its payment recorded, and a partial refund a
//! credit note scaled to the refunded amount, both once.

use serde_json::Value;
use weldsuite_books_domain::http::BooksState;
use weldsuite_books_sales::CommerceInvoicing;
use weldsuite_commerce_domain::payments::books::{
    Actor, CreditNoteRequest, InvoiceRequest, Invoicing, PaymentFacts,
};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};

fn fresh(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{prefix}{nanos:x}")
}

async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
) -> String {
    let id = fresh("acc_");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side) \
         values ($1, $2, $3, $4, $5, $6)",
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

/// A Dutch seller with the accounts an invoice posts to; its id.
async fn seller(db: &PgPool) -> String {
    let id = fresh("ent_bs_");
    sqlx::query(
        r#"insert into entities (id, name, jurisdiction_code, base_currency, is_active,
             tax_identifiers, bank_details, address)
           values ($1, 'Books test seller', 'NL', 'EUR', true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb,
             '{"iban": "NL91ABNA0417164300"}'::jsonb,
             '{"street": "Main 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb)"#,
    )
    .bind(&id)
    .execute(db)
    .await
    .expect("entity");
    account(db, &id, "1300", "Debtors", "asset", "debit").await;
    account(db, &id, "8000", "Revenue", "revenue", "credit").await;
    account(db, &id, "1600", "Creditors", "liability", "credit").await;
    account(db, &id, "1700", "VAT payable", "liability", "credit").await;
    let ledger = account(db, &id, "1100", "Bank", "asset", "debit").await;
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, ledger_account_id, is_default) \n         values ($1, $2, 'Bank', $3, true)",
    )
    .bind(fresh("bank_"))
    .bind(&id)
    .bind(&ledger)
    .execute(db)
    .await
    .expect("bank account");
    id
}

/// An order of one 2 x 12.10 line, VAT inclusive at 21%, for a customer.
async fn order(db: &PgPool) -> String {
    let person = fresh("per_");
    sqlx::query("insert into people (id, display_name, email, in_crm) values ($1, 'Sam Shopper', 'sam@example.com', false)")
        .bind(&person)
        .execute(db)
        .await
        .expect("person");
    let party = fresh("party_");
    sqlx::query("insert into parties (id, kind, person_id, role, display_name) values ($1, 'person', $2, 'customer', 'Sam Shopper')")
        .bind(&party)
        .bind(&person)
        .execute(db)
        .await
        .expect("party");
    let id = fresh("ord_");
    sqlx::query(
        "insert into orders (id, order_number, status, payment_status, currency, customer_name, \
           customer_email, person_id, counterparty_id, prices_include_tax, subtotal, discount_total, \
           tax_total, total, vat_treatment, destination_country, source) \
         values ($1, $2, 'confirmed', 'paid', 'EUR', 'Sam Shopper', 'sam@example.com', $3, $4, true, \
           20.00, 0, 4.20, 24.20, 'domestic', 'NL', 'manual')",
    )
    .bind(&id)
    .bind(fresh("BK-"))
    .bind(&person)
    .bind(&party)
    .execute(db)
    .await
    .expect("order");
    sqlx::query(
        "insert into order_items (id, order_id, name, quantity, unit_price, tax_rate, tax_amount, total, vat_category) \
         values ($1, $2, 'Widget', 2, 12.10, 21.00, 4.20, 24.20, 'standard')",
    )
    .bind(fresh("oitm_"))
    .bind(&id)
    .execute(db)
    .await
    .expect("item");
    id
}

// One scenario, read top to bottom: invoice, payment, credit note, retries.
#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn a_paid_order_is_invoiced_once_and_a_partial_refund_credited() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = weldsuite_db::master_pool(&url, 1).expect("pool");
    let entity = seller(&db).await;
    let order = order(&db).await;
    let books = CommerceInvoicing::new(BooksState::new(EntityEventPublisher::new(
        None,
        TaskTracker::new(),
    )));
    let actor = Actor {
        db: &db,
        workspace_id: "ws_books_test",
        clerk_org_id: None,
        user_id: "user_books_test",
    };

    let request = InvoiceRequest {
        actor,
        order_id: &order,
        entity_id: &entity,
        payment: Some(PaymentFacts {
            amount: 2420,
            currency: "EUR".to_owned(),
            method: Some("ideal".to_owned()),
            reference: Some("tr_books".to_owned()),
            paid_at: None,
        }),
    };
    let invoice = books.invoice_order(&request).await.expect("invoiced");
    assert_ne!(invoice.number, "");
    let row: Value = sqlx::query_scalar(
        "select jsonb_build_object('status', status, 'type', type, 'total', total::text, \
           'taxTotal', tax_total::text, 'paid', amount_paid::text, 'balance', balance_due::text, \
           'journal', journal_entry_id, 'order', commerce_order_id) from invoices where id = $1",
    )
    .bind(&invoice.id)
    .fetch_one(&db)
    .await
    .expect("invoice row");
    assert_eq!(row["order"], order.as_str());
    assert_eq!(row["total"], "24.20");
    assert_eq!(row["taxTotal"], "4.20");
    assert_eq!(row["paid"], "24.20");
    assert_eq!(row["balance"], "0.00");
    assert_eq!(row["status"], "paid");
    assert!(row["journal"].is_string(), "the invoice was posted");

    // Again: the same invoice, the payment not recorded twice.
    let again = books.invoice_order(&request).await.expect("again");
    assert_eq!(again.id, invoice.id);
    let payments: i64 =
        sqlx::query_scalar("select count(*) from payment_allocations where invoice_id = $1")
            .bind(&invoice.id)
            .fetch_one(&db)
            .await
            .expect("allocations");
    assert_eq!(payments, 1);

    // A partial refund: a credit note for 10.00, its VAT in proportion.
    let refund = CreditNoteRequest {
        actor,
        order_id: &order,
        refund_id: "cref_books_test",
        invoice_id: &invoice.id,
        entity_id: &entity,
        amount: 1000,
        currency: "EUR",
        reason: Some("Return"),
        reference: Some("re_books"),
    };
    let credit = books.credit_note(&refund).await.expect("credit note");
    // Again for the same refund (a retry after a failure part-way): the same
    // note, its payment out recorded once.
    let again = books.credit_note(&refund).await.expect("credit note again");
    assert_eq!(again.id, credit.id);
    let notes: i64 = sqlx::query_scalar(
        "select count(*) from invoices where credit_note_for_invoice_id = $1 and deleted_at is null",
    )
    .bind(&invoice.id)
    .fetch_one(&db)
    .await
    .expect("notes");
    assert_eq!(notes, 1);
    let outs: i64 =
        sqlx::query_scalar("select count(*) from payment_allocations where invoice_id = $1")
            .bind(&credit.id)
            .fetch_one(&db)
            .await
            .expect("note allocations");
    assert_eq!(outs, 1);
    let note: Value = sqlx::query_scalar(
        "select jsonb_build_object('type', type, 'total', total::text, 'taxTotal', tax_total::text, \
           'subtotal', subtotal::text, 'for', credit_note_for_invoice_id, 'journal', journal_entry_id) \
         from invoices where id = $1",
    )
    .bind(&credit.id)
    .fetch_one(&db)
    .await
    .expect("note row");
    assert_eq!(note["type"], "credit_note");
    // The customer sees the order's reference on the note; the refund tag
    // stays in the internal notes.
    let (invoice_ref, note_ref, note_internal): (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as(
            "select i.reference, n.reference, n.internal_notes from invoices i, invoices n              where i.id = $1 and n.id = $2",
        )
        .bind(&invoice.id)
        .bind(&credit.id)
        .fetch_one(&db)
        .await
        .expect("references");
    assert_eq!(note_ref, invoice_ref);
    assert!(
        note_internal
            .as_deref()
            .is_some_and(|notes| notes.contains("WeldCommerce refund cref_books_test"))
    );
    assert_eq!(note["total"], "10.00");
    assert_eq!(note["taxTotal"], "1.74");
    assert_eq!(note["subtotal"], "8.26");
    assert_eq!(note["for"], invoice.id.as_str());
    assert!(note["journal"].is_string(), "the credit note was posted");
    let lines: Vec<(String, String)> = sqlx::query_as(
        "select line_total::text, line_total_with_tax::text from invoice_items where invoice_id = $1",
    )
    .bind(&credit.id)
    .fetch_all(&db)
    .await
    .expect("lines");
    assert_eq!(lines, vec![("8.26".to_owned(), "10.00".to_owned())]);
}
