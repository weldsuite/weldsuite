//! Backup withholding on the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`): a 1099 vendor without a TIN is
//! withheld 24% from the payment that brings the year to its box's
//! threshold, never from card payments, and an exempt payee never.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use weldsuite_books_domain::backup_withholding::{
    ComputeBackupWithholdingInput, compute_backup_withholding,
};
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;

async fn vendor(db: &sqlx::PgPool, w9: Option<serde_json::Value>) -> String {
    let id = generate_id("acn");
    sqlx::query(
        "insert into parties (id, kind, display_name, role, is_1099_vendor, default_1099_form, default_1099_box, w9) \
         values ($1, 'company', 'Echo Freelance', 'supplier', true, 'nec', 'nec_1', $2)",
    )
    .bind(&id)
    .bind(w9)
    .execute(db)
    .await
    .expect("vendor");
    id
}

async fn paid(
    db: &sqlx::PgPool,
    entity: &str,
    party: &str,
    amount: &str,
    date: &str,
    method: &str,
) {
    sqlx::query(
        "insert into payments (id, entity_id, type, amount, date, contact_id, payment_method) \
         values ($1, $2, 'sent', $3::numeric, $4::timestamp, $5, $6)",
    )
    .bind(generate_id("pay"))
    .bind(entity)
    .bind(amount)
    .bind(date)
    .bind(party)
    .bind(method)
    .execute(db)
    .await
    .expect("payment");
}

#[tokio::test]
async fn withholding_follows_the_threshold_of_the_vendors_box() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let entity = generate_id("ent");
    let echo = vendor(&db, None).await;
    let input = |gross: f64| ComputeBackupWithholdingInput {
        entity_id: &entity,
        party_id: &echo,
        gross_amount: gross,
        day: "2026-11-02",
        payment_method: Some("ach"),
        ..ComputeBackupWithholdingInput::default()
    };

    // $500 of $2,000 (nec_1 from 2026): below the threshold, nothing kept back.
    let below = compute_backup_withholding(&db, input(500.0))
        .await
        .expect("below");
    assert_eq!((below.amount, below.reason), (0.0, None));

    // Earlier payments this year bring the total to the threshold: this whole payment is withheld.
    paid(
        &db,
        &entity,
        &echo,
        "1600.00",
        "2026-03-01T00:00:00Z",
        "check",
    )
    .await;
    // Card payments are reported on a 1099-K and don't count.
    paid(
        &db,
        &entity,
        &echo,
        "5000.00",
        "2026-04-01T00:00:00Z",
        "credit_card",
    )
    .await;
    let reached = compute_backup_withholding(&db, input(500.0))
        .await
        .expect("reached");
    assert_eq!(reached.amount, 120.0);
    assert_eq!(reached.net, 380.0);
    assert_eq!(reached.reason, Some("no_tin"));

    // Paid by card: never withheld.
    let card = compute_backup_withholding(
        &db,
        ComputeBackupWithholdingInput {
            payment_method: Some("credit_card"),
            ..input(500.0)
        },
    )
    .await
    .expect("card");
    assert_eq!(card.amount, 0.0);

    // A corporation (not an attorney) is an exempt payee.
    let corp = vendor(
        &db,
        Some(serde_json::json!({ "federalTaxClassification": "c_corporation" })),
    )
    .await;
    let exempt = compute_backup_withholding(
        &db,
        ComputeBackupWithholdingInput {
            party_id: &corp,
            ..input(5000.0)
        },
    )
    .await
    .expect("exempt");
    assert_eq!(exempt.amount, 0.0);
}
