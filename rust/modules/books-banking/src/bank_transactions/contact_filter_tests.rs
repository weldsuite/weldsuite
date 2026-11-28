//! `GET /api/bank-transactions?contactId=` against the real tenant schema
//! (`WELDSUITE_TEST_TENANT_URL`; the test returns early without it).

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::assert_is_empty,
    reason = "test fixtures are written in SQL; one scenario read top to bottom"
)]

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_books_domain::http::Caller;
use weldsuite_kit::generate_id;

use super::list_lines;

async fn run(db: &PgPool, entity: &str, query: &str) -> (u16, Value) {
    let caller = Caller::in_process(
        db.clone(),
        "ws_filter_test",
        "ws_filter_test",
        "user",
        entity,
        None,
    )
    .with_query(query);
    let response = match list_lines(&caller).await {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed"),
    };
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn line(db: &PgPool, entity: &str, bank: &str, description: &str) -> String {
    let id = generate_id("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, status) \
         values ($1, $2, $3, now(), '10.00', $4, 'unreconciled')",
    )
    .bind(&id)
    .bind(entity)
    .bind(bank)
    .bind(description)
    .execute(db)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn the_contact_filter_picks_the_lines_of_a_contact_and_leaves_the_default_alone() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let db = weldsuite_db::master_pool(&url, 2).unwrap();
    let entity = generate_id("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active) values ($1, 'Filter test', 'NL', 'EUR', true)",
    )
    .bind(&entity)
    .execute(&db)
    .await
    .unwrap();
    let bank = generate_id("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')",
    )
    .bind(&bank)
    .bind(&entity)
    .execute(&db)
    .await
    .unwrap();
    let contact = generate_id("pty");
    sqlx::query("insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme', 'customer')")
        .bind(&contact)
        .execute(&db)
        .await
        .unwrap();
    let direct = line(&db, &entity, &bank, "direct").await;
    let by_invoice = line(&db, &entity, &bank, "by invoice").await;
    let unrelated = line(&db, &entity, &bank, "unrelated").await;
    sqlx::query("update bank_transactions set contact_id = $2 where id = $1")
        .bind(&direct)
        .bind(&contact)
        .execute(&db)
        .await
        .unwrap();
    let invoice = generate_id("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, type, status, contact_id, issue_date, due_date) \
         values ($1, $2, 'standard', 'sent', $3, now(), now())",
    )
    .bind(&invoice)
    .bind(&entity)
    .bind(&contact)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("update bank_transactions set reconciled_invoice_id = $2 where id = $1")
        .bind(&by_invoice)
        .bind(&invoice)
        .execute(&db)
        .await
        .unwrap();

    // Without the filter the answer is what it was: every line of the entity.
    let (status, all) = run(&db, &entity, "").await;
    assert_eq!(status, 200, "{all}");
    assert_eq!(all["data"].as_array().unwrap().len(), 3);
    assert_eq!(all["pagination"]["totalCount"], 3);

    // With it, the contact's lines, and the count follows.
    let (_, mine) = run(&db, &entity, &format!("contactId={contact}")).await;
    let ids: Vec<&str> = mine["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{mine}");
    assert!(ids.contains(&direct.as_str()) && ids.contains(&by_invoice.as_str()));
    assert!(!ids.contains(&unrelated.as_str()));
    assert_eq!(mine["pagination"]["totalCount"], 2);
    let (_, none) = run(&db, &entity, "contactId=pty_nobody").await;
    assert!(none["data"].as_array().unwrap().is_empty());
}
