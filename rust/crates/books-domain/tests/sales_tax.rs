//! `sales_tax::document_tax` on the real tenant schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`): a Texas invoice is
//! taxed by the manual engine at the seller's zone (origin sourcing), a
//! resale certificate exempts a sale, a sale to an unregistered state is
//! untaxed with a warning, use tax on a bill is accrued at the delivery
//! address, and a credit memo reverses its invoice's rows.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, DocumentKind, IssueDate, SalesTaxEntity, TaxItem, accrue_use_tax,
    calculate_us_document_tax,
};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_kit::generate_id;

async fn exec(db: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.execute(db).await.expect(sql);
}

async fn seed(db: &PgPool) -> (String, String) {
    let entity = generate_id("ent");
    exec(
        db,
        "insert into entities (id, name, jurisdiction_code, base_currency, address) \
         values ($1, 'Austin LLC', 'US', 'USD', '{\"line1\":\"1 Congress Ave\",\"city\":\"Austin\",\"state\":\"TX\",\"postalCode\":\"78701\"}')",
        &[&entity],
    )
    .await;
    let agency = generate_id("sta");
    exec(
        db,
        "insert into sales_tax_agencies (id, entity_id, state_code, name, registered_from) \
         values ($1, $2, 'TX', 'Texas Comptroller', '2020-01-01')",
        &[&agency, &entity],
    )
    .await;
    let state = generate_id("stj");
    let city = generate_id("stj");
    for (id, level, name, code) in [
        (&state, "state", "Texas", "48"),
        (&city, "city", "Austin", "2227"),
    ] {
        exec(
            db,
            "insert into sales_tax_jurisdictions (id, entity_id, agency_id, state_code, level, name, code) \
             values ($1, $2, $3, 'TX', $4, $5, $6)",
            &[id, &entity, &agency, level, name, code],
        )
        .await;
    }
    for (id, rate) in [(&state, "6.25"), (&city, "2")] {
        exec(
            db,
            "insert into sales_tax_jurisdiction_rates (id, entity_id, jurisdiction_id, rate, effective_from) \
             values ($1, $2, $3, $4::numeric, '2000-01-01')",
            &[&generate_id("stjr"), &entity, id, rate],
        )
        .await;
    }
    exec(
        db,
        "insert into sales_tax_zones (id, entity_id, agency_id, state_code, name, jurisdiction_ids, postal_codes, is_origin) \
         values ($1, $2, $3, 'TX', 'Austin', $4::jsonb, '[\"78701\"]', true)",
        &[&generate_id("stz"), &entity, &agency, &json!([state, city]).to_string()],
    )
    .await;
    exec(
        db,
        "insert into parties (id, display_name, role) values ($1, 'Reseller', 'customer')",
        &[&format!("pty_{entity}")],
    )
    .await;
    (entity, agency)
}

fn doc(kind: DocumentKind, contact: Option<String>, ship_to: Value) -> DocumentContext {
    DocumentContext {
        kind,
        document_id: Some(generate_id("inv")),
        document_number: Some("INV-1".into()),
        contact_id: contact,
        issue_date: IssueDate::Text("2026-05-04".into()),
        currency: Some("USD".into()),
        billing_address: None,
        shipping_address: Some(ship_to.clone()),
        delivery_address: Some(ship_to),
        ship_from_address: None,
        marketplace_facilitated: None,
        fiscal_data: None,
        original_invoice_id: None,
    }
}

fn item(id: &str, price: &str) -> TaxItem {
    TaxItem {
        id: id.into(),
        description: Some("Widget".into()),
        quantity: Some("1".into()),
        unit_price: price.into(),
        discount_percent: Some("0".into()),
        ..TaxItem::default()
    }
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one scenario after the other on one entity"
)]
async fn us_documents_are_taxed_by_the_manual_engine() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let (entity_id, agency_id) = seed(&db).await;
    let entity = SalesTaxEntity {
        id: entity_id.clone(),
        jurisdiction_code: "US".into(),
        base_currency: Some("USD".into()),
        address: Some(
            json!({ "line1": "1 Congress Ave", "city": "Austin", "state": "TX", "postalCode": "78701" }),
        ),
    };
    let austin =
        json!({ "line1": "2 Main St", "city": "Austin", "state": "TX", "postalCode": "78701" });

    // Origin-sourced: state and city at the seller's zone.
    let calc = calculate_us_document_tax(
        &db,
        &entity,
        &doc(DocumentKind::Invoice, None, austin.clone()),
        &[item("ii_1", "100"), item("ii_2", "33.33")],
        None,
    )
    .await
    .expect("a calculation");
    assert_eq!(calc.tax_total, "11.00");
    assert_eq!(calc.total, "144.33");
    assert_eq!(calc.sales_tax.engine, "manual");
    assert_eq!(calc.processed_items[0].tax_rate.as_deref(), Some("8.2500"));
    assert_eq!(calc.tax_breakdown.len(), 4);
    assert_eq!(calc.tax_breakdown[0]["agencyId"], json!(agency_id));
    assert!(!calc.sales_tax.address_incomplete);

    // A valid resale certificate exempts the sale.
    let party = format!("pty_{entity_id}");
    sqlx::query(
        "insert into exemption_certificates (id, entity_id, party_id, states, reason) \
         values ($1, $2, $3, '[\"TX\"]', 'resale')",
    )
    .bind(generate_id("exc"))
    .bind(&entity_id)
    .bind(&party)
    .execute(&db)
    .await
    .expect("certificate");
    let exempt = calculate_us_document_tax(
        &db,
        &entity,
        &doc(DocumentKind::Invoice, Some(party.clone()), austin.clone()),
        &[item("ii_3", "50")],
        None,
    )
    .await
    .expect("an exempt calculation");
    assert_eq!(exempt.tax_total, "0.00");
    assert_eq!(exempt.tax_breakdown[0]["exemptReason"], "resale");
    assert_eq!(exempt.tax_breakdown[0]["exemptAmount"], json!(50));

    // Not registered in Nevada: untaxed, warned, one zero row for nexus.
    let nevada = calculate_us_document_tax(
        &db,
        &entity,
        &doc(
            DocumentKind::Invoice,
            None,
            json!({ "city": "Reno", "state": "NV", "postalCode": "89501" }),
        ),
        &[item("ii_4", "10")],
        None,
    )
    .await
    .expect("an untaxed calculation");
    assert_eq!(
        nevada.sales_tax.warnings,
        vec!["not_registered_in_state".to_owned()]
    );
    assert_eq!(nevada.tax_breakdown.len(), 1);
    assert_eq!(nevada.tax_breakdown[0]["jurisdictionName"], "Nevada");

    // Use tax on a bill line, at the delivery address.
    let mut accrue = item("bi_1", "200");
    accrue.accrue_use_tax = Some(true);
    let nets: HashMap<String, f64> = [("bi_1".to_owned(), 200.0)].into_iter().collect();
    let accrual = accrue_use_tax(
        &db,
        &entity,
        &doc(DocumentKind::Bill, None, austin.clone()),
        &[accrue],
        &nets,
        None,
    )
    .await
    .expect("an accrual")
    .expect("use tax");
    assert_eq!(accrual.rows.len(), 2);
    assert!(
        accrual
            .rows
            .iter()
            .all(|r| r["kind"] == "use" && r["selfAssessed"] == true)
    );
    let use_tax: f64 = accrual
        .rows
        .iter()
        .filter_map(|r| r["taxAmount"].as_f64())
        .sum();
    assert!((use_tax - 16.5).abs() < 1e-9, "{use_tax}");

    // A credit memo of half the first line reverses half its tax.
    let invoice_id = generate_id("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, contact_id, issue_date, due_date, tax_breakdown, tax_engine) \
         values ($1, $2, $3, '2026-05-04', '2026-06-04', $4, 'manual')",
    )
    .bind(&invoice_id)
    .bind(&entity_id)
    .bind(&party)
    .bind(json!(calc.tax_breakdown))
    .execute(&db)
    .await
    .expect("invoice");
    sqlx::query(
        "insert into invoice_items (id, entity_id, invoice_id, description, quantity, unit_price, sort_order) \
         values ('ii_1', $1, $2, 'Widget', 1, 100, 0)",
    )
    .bind(&entity_id)
    .bind(&invoice_id)
    .execute(&db)
    .await
    .expect("invoice item");
    let mut memo = doc(DocumentKind::CreditMemo, Some(party), austin);
    memo.original_invoice_id = Some(invoice_id);
    let mut credit = item("cm_1", "50");
    credit.sort_order = Some(0.0);
    let reversed = calculate_us_document_tax(&db, &entity, &memo, &[credit], None)
        .await
        .expect("a credit memo");
    assert_eq!(reversed.tax_total, "4.13");
    assert!(reversed.tax_breakdown.iter().all(|r| r["lineId"] == "cm_1"));
}
