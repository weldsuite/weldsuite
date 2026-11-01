//! `tax::calculate_document_tax` and `tax::resolve_gst_supply` on the real
//! tenant schema (built from the journaled migrations by
//! `scripts/rust-test-db.ts`): a Dutch invoice takes its rates from the
//! entity's own rate rows, a rate of another entity or of the wrong direction
//! is refused, a self-assessed purchase stays out of the bill total, and an
//! Indian invoice splits its GST slab by place of supply.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use serde_json::json;
use weldsuite_books_domain::tax::{
    Direction, DocumentTaxItem, SupplyArgs, TaxArgs, TaxError, calculate_document_tax,
    resolve_gst_supply,
};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_kit::generate_id;

async fn entity(db: &PgPool, code: &str, settings: serde_json::Value) -> String {
    let id = generate_id("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, jurisdiction_settings) \
         values ($1, 'Tax Co', $2, 'EUR', $3)",
    )
    .bind(&id)
    .bind(code)
    .bind(settings)
    .execute(db)
    .await
    .expect("entity");
    id
}

async fn rate(
    db: &PgPool,
    entity: &str,
    name: &str,
    kind: &str,
    rate: &str,
    category: Option<&str>,
    metadata: Option<serde_json::Value>,
) -> String {
    let id = generate_id("trt");
    sqlx::query(
        "insert into tax_rates (id, entity_id, jurisdiction_code, name, type, rate, tax_category_code, jurisdiction_metadata) \
         values ($1, $2, 'NL', $3, $4, $5::numeric, $6, $7)",
    )
    .bind(&id)
    .bind(entity)
    .bind(name)
    .bind(kind)
    .bind(rate)
    .bind(category)
    .bind(metadata)
    .execute(db)
    .await
    .expect("tax rate");
    id
}

fn line(price: &str, rate_id: Option<&str>) -> DocumentTaxItem {
    DocumentTaxItem {
        quantity: Some("2".into()),
        unit_price: price.into(),
        discount_percent: Some("0".into()),
        tax_rate_id: rate_id.map(str::to_owned),
        ..DocumentTaxItem::default()
    }
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one scenario per jurisdiction, step by step"
)]
async fn documents_take_the_entity_rates() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");

    // The Netherlands: the rate row wins over the client's percentage.
    let nl = entity(&db, "NL", json!({})).await;
    let other = entity(&db, "NL", json!({})).await;
    let sales = rate(&db, &nl, "BTW hoog", "sales", "21", Some("standard"), None).await;
    let purchase = rate(
        &db,
        &nl,
        "Voorbelasting",
        "purchase",
        "21",
        Some("eu_b2b_service"),
        None,
    )
    .await;
    let foreign = rate(&db, &other, "Elders", "sales", "9", None, None).await;

    let mut items = vec![line("50.00", Some(&sales)), line("10", Some("none"))];
    items[0].tax_rate = Some("99".into());
    let calc = calculate_document_tax(&db, &TaxArgs::new(&nl, Direction::Sales, &items))
        .await
        .expect("calculation");
    assert_eq!(calc.subtotal, "120.00");
    assert_eq!(calc.tax_total, "21.00");
    assert_eq!(calc.total, "141.00");
    assert_eq!(calc.processed_items[0].tax_rate.as_deref(), Some("21.0000"));
    assert_eq!(
        calc.processed_items[0].tax_rate_id.as_deref(),
        Some(sales.as_str())
    );
    assert_eq!(calc.processed_items[1].tax_rate_id, None);
    assert_eq!(calc.processed_items[1].tax_rate.as_deref(), Some("0"));
    assert_eq!(calc.tax_breakdown[0]["taxRateName"], "BTW hoog");
    assert_eq!(calc.tax_breakdown[0]["taxCategoryCode"], "standard");
    assert_eq!(calc.tax_breakdown[1]["taxRateName"], "0%");

    let refused = calculate_document_tax(
        &db,
        &TaxArgs::new(&nl, Direction::Sales, &[line("1", Some(&foreign))]),
    )
    .await;
    assert!(
        matches!(&refused, Err(TaxError::Calculation(m)) if *m == format!("Tax rate {foreign} does not belong to this accounting entity")),
        "{refused:?}"
    );
    let wrong_way = calculate_document_tax(
        &db,
        &TaxArgs::new(&nl, Direction::Sales, &[line("1", Some(&purchase))]),
    )
    .await;
    assert!(
        matches!(&wrong_way, Err(TaxError::Calculation(m)) if m.starts_with("Tax rate \"Voorbelasting\" is a purchase rate")),
        "{wrong_way:?}"
    );

    // A reverse-charged purchase: self-assessed, out of the bill total.
    let bill = calculate_document_tax(
        &db,
        &TaxArgs::new(&nl, Direction::Purchase, &[line("50", Some(&purchase))]),
    )
    .await
    .expect("bill");
    assert_eq!(bill.tax_total, "0.00");
    assert_eq!(bill.total, "100.00");
    assert_eq!(bill.tax_breakdown[0]["selfAssessed"], json!(true));

    // India: CGST + SGST within Maharashtra, IGST to Karnataka.
    let india = entity(&db, "IN", json!({ "stateCode": "27" })).await;
    let slab = rate(
        &db,
        &india,
        "GST 18%",
        "sales",
        "18",
        Some("standard"),
        Some(json!({
            "gstSlab": "18",
            "components": {
                "intrastate": [
                    { "code": "cgst", "rate": "9", "accountRole": "tax_output_cgst" },
                    { "code": "sgst", "rate": "9", "accountRole": "tax_output_sgst" },
                ],
                "interstate": [{ "code": "igst", "rate": "18", "accountRole": "tax_output_igst" }],
            },
        })),
    )
    .await;
    let items = [line("500", Some(&slab))];
    let supply = resolve_gst_supply(
        &db,
        SupplyArgs {
            entity_id: &india,
            contact_id: None,
            place_of_supply: None,
            shipping_address: Some(&json!({ "state": "Maharashtra", "country": "India" })),
            billing_address: None,
        },
    )
    .await
    .expect("supply")
    .expect("an Indian entity");
    assert_eq!(supply.place_of_supply.as_deref(), Some("27"));
    let intra = calculate_document_tax(
        &db,
        &TaxArgs::new(&india, Direction::Sales, &items).with_gst(Some(&supply)),
    )
    .await
    .expect("intra-state");
    assert_eq!(intra.tax_total, "180.00");
    assert_eq!(intra.tax_breakdown.len(), 2);
    assert_eq!(intra.tax_breakdown[0]["taxRateName"], "CGST 9%");
    assert_eq!(intra.tax_breakdown[0]["accountRole"], "tax_output_cgst");

    let karnataka = resolve_gst_supply(
        &db,
        SupplyArgs {
            entity_id: &india,
            place_of_supply: Some("29"),
            ..SupplyArgs::default()
        },
    )
    .await
    .expect("supply")
    .expect("an Indian entity");
    let inter = calculate_document_tax(
        &db,
        &TaxArgs::new(&india, Direction::Sales, &items).with_gst(Some(&karnataka)),
    )
    .await
    .expect("inter-state");
    assert_eq!(inter.tax_breakdown.len(), 1);
    assert_eq!(inter.tax_breakdown[0]["taxRateName"], "IGST 18%");

    let abroad = resolve_gst_supply(
        &db,
        SupplyArgs {
            entity_id: &india,
            billing_address: Some(&json!({ "country": "de" })),
            ..SupplyArgs::default()
        },
    )
    .await
    .expect("supply")
    .expect("an Indian entity");
    assert_eq!(abroad.place_of_supply.as_deref(), Some("96"));
    assert_eq!(abroad.buyer_country.as_deref(), Some("DE"));
    let export = calculate_document_tax(
        &db,
        &TaxArgs::new(&india, Direction::Sales, &items).with_gst(Some(&abroad)),
    )
    .await
    .expect("export");
    assert_eq!(export.tax_total, "0.00");
    assert_eq!(export.tax_breakdown[0]["component"], "export");

    // Not an Indian entity: no place of supply.
    let none = resolve_gst_supply(
        &db,
        SupplyArgs {
            entity_id: &nl,
            ..SupplyArgs::default()
        },
    )
    .await
    .expect("supply");
    assert_eq!(none, None);
}
