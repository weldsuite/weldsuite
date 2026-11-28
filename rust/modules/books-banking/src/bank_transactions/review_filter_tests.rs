//! `GET /api/bank-transactions?processedAutomatically=true&reviewed=` against
//! the real tenant schema (`WELDSUITE_TEST_TENANT_URL`; the test returns early
//! without it).

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "test fixtures are written in SQL; one scenario read top to bottom"
)]

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_books_domain::http::Caller;
use weldsuite_kit::generate_id;

use super::list_lines;

async fn run(db: &PgPool, entity: &str, query: &str) -> Value {
    let caller = Caller::in_process(
        db.clone(),
        "ws_review_filter",
        "ws_review_filter",
        "user",
        entity,
        None,
    )
    .with_query(query);
    let response = match list_lines(&caller).await {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed"),
    };
    assert_eq!(response.status().as_u16(), 200);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn ids(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn reviewed_is_the_mark_on_the_journal_entry_of_an_automatic_line() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let db = weldsuite_db::master_pool(&url, 2).unwrap();
    let entity = generate_id("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
         values ($1, 'Review filter', 'NL', 'EUR', true)",
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
    let entry = async |marked: bool| {
        let id = generate_id("je");
        sqlx::query(
            "insert into journal_entries (id, entity_id, entry_number, date, status, reviewed_at, reviewed_by) \
             values ($1, $2, $1, now(), 'posted', case when $3 then now() end, case when $3 then 'user_a' end)",
        )
        .bind(&id)
        .bind(&entity)
        .bind(marked)
        .execute(&db)
        .await
        .unwrap();
        id
    };
    let line = async |kind: &str, entry: Option<&str>| {
        let id = generate_id("btx");
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, status, \
               reconciliation_type, journal_entry_id) \
             values ($1, $2, $3, now(), '10.00', 'reconciled', $4, $5)",
        )
        .bind(&id)
        .bind(&entity)
        .bind(&bank)
        .bind(kind)
        .bind(entry)
        .execute(&db)
        .await
        .unwrap();
        id
    };
    let marked_entry = entry(true).await;
    let open_entry = entry(false).await;
    let marked = line("auto", Some(&marked_entry)).await;
    let open = line("auto", Some(&open_entry)).await;
    let linked_only = line("auto", None).await;
    // A manual booking is not an automatic one, marked or not.
    let manual = line("manual", Some(&open_entry)).await;

    let automatic = run(&db, &entity, "processedAutomatically=true").await;
    let mut all = vec![marked.clone(), open.clone(), linked_only];
    all.sort();
    assert_eq!(ids(&automatic), all);
    let row = |body: &Value, id: &str| {
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(row(&automatic, &marked)["reviewedBy"], "user_a");
    assert!(row(&automatic, &marked)["reviewedAt"].is_string());
    assert!(row(&automatic, &open)["reviewedAt"].is_null());

    let unreviewed = run(&db, &entity, "processedAutomatically=true&reviewed=false").await;
    assert_eq!(ids(&unreviewed), [open]);
    assert_eq!(unreviewed["pagination"]["totalCount"], 1);
    let reviewed = run(&db, &entity, "processedAutomatically=true&reviewed=true").await;
    assert_eq!(ids(&reviewed), [marked]);

    // Without either parameter a line is the TypeScript route's: no mark keys.
    let plain = run(&db, &entity, "").await;
    assert_eq!(plain["data"].as_array().unwrap().len(), 4);
    assert!(plain["data"][0].get("reviewedAt").is_none());
    let _ = manual;
}
