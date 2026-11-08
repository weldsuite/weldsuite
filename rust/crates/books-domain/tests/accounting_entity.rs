//! `accounting_entity` on the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`): the merged entity (extension
//! values over the old columns, registrations over the old tax identifiers,
//! document texts in the branding), the lock dates and sales tax engine
//! loaders, the extension upsert, and the invoice entity's bank details.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::accounting_entity::{
    EntityLockDates, load_accounting_entities, load_accounting_entity, load_entity_lock_dates,
    load_invoice_entity, load_sales_tax_engine_settings, upsert_accounting_entity_settings,
};
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;

fn values(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn the_accounting_view_of_a_legal_entity() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let entity = generate_id("ent");
    let core_only = generate_id("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, tax_identifiers, branding, \
           bank_details, sales_lock_date, hard_lock_date, sales_tax_engine) \
         values ($1, 'Merged BV', 'NL', 'EUR', $2, $3, $4, '2026-01-31', '2025-12-31', 'manual'), \
                ($5, 'Core only BV', 'NL', 'EUR', null, null, null, null, null, null)",
    )
    .bind(&entity)
    .bind(json!({ "vatNumber": "NL000000000B00", "registrationNumber": "111" }))
    .bind(json!({ "logoUrl": "https://logo", "footerText": "old footer" }))
    .bind(json!({ "iban": "NL00OLD", "bankName": "Old bank" }))
    .bind(&core_only)
    .execute(&db)
    .await
    .expect("entities");
    sqlx::query(
        "insert into legal_entity_registrations (id, entity_id, type, number, is_primary) \
         values ($1, $2, 'vat', 'NL123456789B01', true), ($3, $2, 'company_registration', '999', false)",
    )
    .bind(generate_id("ler"))
    .bind(&entity)
    .bind(generate_id("ler"))
    .execute(&db)
    .await
    .expect("registrations");

    // Without an extension row: WeldBooks is not enabled, the old columns stand.
    let before = load_accounting_entity(&db, &entity)
        .await
        .expect("load")
        .expect("entity");
    assert_eq!(before["weldbooksEnabled"], json!(false));
    assert_eq!(before["invoiceBankAccountId"], Value::Null);
    assert_eq!(before["salesLockDate"], json!("2026-01-31"));
    assert_eq!(
        before["taxIdentifiers"],
        json!({ "vatNumber": "NL123456789B01", "registrationNumber": "111" })
    );
    assert_eq!(before["accessRestricted"], json!(false));

    // The extension wins where it holds a value.
    upsert_accounting_entity_settings(
        &db,
        &entity,
        &values(json!({
            "salesLockDate": "2026-02-28",
            "salesTaxEngine": "avalara",
            "documentTexts": { "footerText": "new footer" },
        })),
    )
    .await
    .expect("upsert");
    // A second upsert keeps what it leaves out.
    upsert_accounting_entity_settings(
        &db,
        &entity,
        &values(json!({ "hardLockDate": null, "accountingMethod": "cash" })),
    )
    .await
    .expect("upsert again");
    let merged = load_accounting_entity(&db, &entity)
        .await
        .expect("load")
        .expect("entity");
    assert_eq!(merged["weldbooksEnabled"], json!(true));
    assert_eq!(merged["salesLockDate"], json!("2026-02-28"));
    assert_eq!(merged["hardLockDate"], json!("2025-12-31"));
    assert_eq!(merged["accountingMethod"], json!("cash"));
    assert_eq!(merged["salesTaxEngine"], json!("avalara"));
    assert_eq!(
        merged["branding"],
        json!({ "logoUrl": "https://logo", "footerText": "new footer" })
    );
    assert_eq!(
        load_entity_lock_dates(&db, &entity).await.expect("locks"),
        Some(EntityLockDates {
            sales_lock_date: Some("2026-02-28".to_owned()),
            hard_lock_date: Some("2025-12-31".to_owned()),
            ..EntityLockDates::default()
        })
    );
    let engine = load_sales_tax_engine_settings(&db, &entity)
        .await
        .expect("engine")
        .expect("settings");
    assert_eq!(engine.engine.as_deref(), Some("avalara"));
    assert_eq!(
        load_entity_lock_dates(&db, "ent_missing")
            .await
            .expect("locks"),
        None
    );

    // Order follows the ids; unknown ids are left out.
    let both = load_accounting_entities(
        &db,
        &[core_only.clone(), "ent_missing".to_owned(), entity.clone()],
        false,
    )
    .await
    .expect("both");
    let ids: Vec<&str> = both.iter().filter_map(|e| e["id"].as_str()).collect();
    assert_eq!(ids, [core_only.as_str(), entity.as_str()]);

    // Invoices print the chosen core bank account, else `bank_details`.
    let plain = load_invoice_entity(&db, &entity, None)
        .await
        .expect("invoice entity")
        .expect("entity");
    assert_eq!(
        plain["bankDetails"],
        json!({ "iban": "NL00OLD", "bankName": "Old bank" })
    );
    let account = generate_id("ba");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, iban, bic, bank_name, account_number_encrypted) \
         values ($1, $2, 'Main', 'NL91ABNA0417164300', 'ABNANL2A', '', 'not-decrypted-without-keys')",
    )
    .bind(&account)
    .bind(&entity)
    .execute(&db)
    .await
    .expect("bank account");
    upsert_accounting_entity_settings(
        &db,
        &entity,
        &values(json!({ "invoiceBankAccountId": account })),
    )
    .await
    .expect("invoice account");
    let chosen = load_invoice_entity(&db, &entity, None)
        .await
        .expect("invoice entity")
        .expect("entity");
    assert_eq!(
        chosen["bankDetails"],
        json!({ "iban": "NL91ABNA0417164300", "bic": "ABNANL2A" })
    );
    assert_eq!(chosen["invoiceBankAccountId"], json!(account));
}
