//! `bank_accounts` on the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`): the ledger account a new bank
//! account sits on (the chart's own unlinked "Checking" reused, a card under
//! Credit Card Payable, a fresh asset code otherwise), sealing and revealing
//! an account number with its reveal log, and the refusals.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use serde_json::{Value, json};
use weldsuite_books_domain::bank_accounts::{
    BankAccountError, BankLedgerPlan, create_ledger_account_for_bank, insert_ledger_account,
    plan_bank_ledger_account, reveal_account_number, seal_account_number,
};
use weldsuite_books_domain::tables::BANK_ACCOUNTS;
use weldsuite_db::{Keyring, master_pool};
use weldsuite_kit::generate_id;

async fn account(
    db: &sqlx::PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    subtype: &str,
    role: Option<&str>,
) -> String {
    let id = format!("{entity}_{code}");
    let metadata = role.map(|r| json!({ "systemRole": r }));
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, subtype, normal_side, metadata, tax_line) \
         values ($1, $2, $3, $4, $5, $6, 'debit', $7, $8)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(subtype)
    .bind(metadata)
    .bind((subtype == "bank").then_some("bs_cash"))
    .execute(db)
    .await
    .expect("account");
    id
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn bank_accounts_on_the_real_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let entity = generate_id("ent");
    sqlx::query("insert into entities (id, name, jurisdiction_code, base_currency) values ($1, 'Bank BV', 'US', 'USD')")
        .bind(&entity)
        .execute(&db)
        .await
        .expect("entity");
    let checking = account(&db, &entity, "1000", "Checking", "asset", "bank", None).await;
    let card_payable = account(
        &db,
        &entity,
        "2100",
        "Credit Card Payable",
        "liability",
        "credit_card",
        Some("credit_card_payable"),
    )
    .await;

    // The chart's unlinked Checking is reused.
    let plan = plan_bank_ledger_account(&db, &entity, "Main", "checking", "USD")
        .await
        .expect("plan");
    let BankLedgerPlan::Existing(existing) = plan else {
        panic!("the chart's Checking must be reused");
    };
    assert_eq!(existing["id"], json!(checking));

    // Once linked, a second checking account gets a new asset code with the tax line.
    sqlx::query("insert into bank_accounts (id, entity_id, name, ledger_account_id) values ($1, $2, 'Main', $3)")
        .bind(generate_id("ba"))
        .bind(&entity)
        .bind(&checking)
        .execute(&db)
        .await
        .expect("bank account");
    let BankLedgerPlan::New(row) =
        plan_bank_ledger_account(&db, &entity, "Payroll", "checking", "USD")
            .await
            .expect("plan")
    else {
        panic!("a linked Checking can't be reused");
    };
    assert_eq!(row["code"], json!("1001"));
    assert_eq!(row["type"], json!("asset"));
    assert_eq!(row["subtype"], json!("bank"));
    assert_eq!(row["taxLine"], json!("bs_cash"));
    assert_eq!(row["parentAccountId"], Value::Null);
    insert_ledger_account(&db, &row).await.expect("insert");
    let stored: Option<String> = sqlx::query_scalar("select code from accounts where id = $1")
        .bind(row["id"].as_str())
        .fetch_optional(&db)
        .await
        .expect("read");
    assert_eq!(stored.as_deref(), Some("1001"));

    // A card goes under Credit Card Payable.
    let BankLedgerPlan::New(card) =
        plan_bank_ledger_account(&db, &entity, "Visa", "credit_card", "USD")
            .await
            .expect("plan")
    else {
        panic!("cards are never reused");
    };
    assert_eq!(card["parentAccountId"], json!(card_payable));
    assert_eq!(card["code"], json!("2101"));
    assert_eq!(card["normalSide"], json!("credit"));

    // A feed account's ledger account.
    let feed = create_ledger_account_for_bank(&db, &entity, "Amex", "credit_card", "USD")
        .await
        .expect("feed ledger");
    let (code, parent): (String, Option<String>) =
        sqlx::query_as("select code, parent_account_id from accounts where id = $1")
            .bind(&feed)
            .fetch_one(&db)
            .await
            .expect("read");
    assert_eq!(code, "2101");
    assert_eq!(parent.as_deref(), Some(card_payable.as_str()));

    // Sealing needs a key; revealing logs first.
    assert!(matches!(
        seal_account_number(&Keyring::default(), "123456789"),
        Err(BankAccountError::NoKey)
    ));
    let keyring = Keyring {
        v1: Some(format!("{}1", "0".repeat(63))),
        v2: None,
    };
    let sealed = seal_account_number(&keyring, "123456789").expect("seal");
    assert_eq!(sealed.last4, "6789");
    let bank_id = generate_id("ba");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, routing_number, account_number_encrypted, account_number_last4) \
         values ($1, $2, 'Ops', '021000021', $3, $4)",
    )
    .bind(&bank_id)
    .bind(&entity)
    .bind(&sealed.encrypted)
    .bind(&sealed.last4)
    .execute(&db)
    .await
    .expect("sealed bank account");
    let row = BANK_ACCOUNTS
        .find_live(&db, &bank_id)
        .await
        .expect("read")
        .expect("row");
    let revealed = reveal_account_number(&db, &keyring, &row, "user_1", Some("audit"))
        .await
        .expect("reveal");
    assert_eq!(revealed.account_number, "123456789");
    assert_eq!(revealed.routing_number.as_deref(), Some("021000021"));
    let reveals: i64 = sqlx::query_scalar(
        "select count(*) from tax_id_reveals where subject_id = $1 and field = 'account_number' and revealed_by = 'user_1' and reason = 'audit'",
    )
    .bind(&bank_id)
    .fetch_one(&db)
    .await
    .expect("count");
    assert_eq!(reveals, 1);

    let bare = BANK_ACCOUNTS.js(json!({ "id": "ba_none", "entity_id": entity }));
    let Err(BankAccountError::Posting(message)) =
        reveal_account_number(&db, &keyring, &bare, "user_1", None).await
    else {
        panic!("no number on file must be refused");
    };
    assert_eq!(message, "This bank account has no account number on file");
}
