//! `tax::eu_vat::calculate_eu_destination_tax` on the real tenant schema
//! (built by `scripts/rust-test-db.ts`): the seller's country and OSS
//! registration come from the database, and VIES from its cache table (the
//! outbound HTTP port is absent, so an uncached number reads as VIES down).
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use weldsuite_books_domain::tax::TaxError;
use weldsuite_books_domain::tax::eu_vat::{
    DestinationLine, EuTaxArgs, EuTreatment, EuVatError, SupplyKind, VatCategory, ZeroRatedGross,
    calculate_eu_destination_tax,
};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_kit::generate_id;

async fn entity(db: &PgPool, code: &str) -> String {
    let id = generate_id("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency) \
         values ($1, 'Shop B.V.', $2, 'EUR')",
    )
    .bind(&id)
    .bind(code)
    .execute(db)
    .await
    .expect("entity");
    id
}

async fn oss(db: &PgPool, entity: &str, valid_from: Option<&str>, deleted: bool) {
    sqlx::query(
        "insert into legal_entity_registrations (id, entity_id, type, country, number, valid_from, deleted_at) \
         values ($1, $2, 'oss', 'NL', 'NL123456789', $3::date, case when $4 then now() end)",
    )
    .bind(generate_id("ler"))
    .bind(entity)
    .bind(valid_from)
    .bind(deleted)
    .execute(db)
    .await
    .expect("registration");
}

async fn vies_cache(db: &PgPool, number: &str, valid: bool) {
    sqlx::query(
        "insert into vies_checks (id, vat_number, country_code, valid, checked_at) \
         values ($1, $2, $3, $4, now()) \n         on conflict (vat_number) do update set valid = excluded.valid, checked_at = now()",
    )
    .bind(generate_id("vies"))
    .bind(number)
    .bind(&number[..2])
    .bind(valid)
    .execute(db)
    .await
    .expect("vies cache");
}

fn args<'a>(
    entity_id: &'a str,
    buyer_country: &'a str,
    vat: Option<&'a str>,
    lines: &'a [DestinationLine],
) -> EuTaxArgs<'a> {
    EuTaxArgs {
        entity_id,
        buyer_country,
        buyer_vat_number: vat,
        prices_include_vat: true,
        supply: SupplyKind::Goods,
        zero_rated_gross: ZeroRatedGross::KeepGross,
        date: Some("2026-11-21"),
        lines,
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one scenario per treatment")]
async fn destination_vat_reads_the_entity_oss_and_vies() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let lines = [DestinationLine {
        quantity: 1,
        unit_price_minor: 11_900,
        discount_minor: 0,
        category: VatCategory::Standard,
    }];

    // Without an OSS registration a German consumer pays the Dutch rate.
    let nl = entity(&db, "NL").await;
    let plain = calculate_eu_destination_tax(&db, None, &args(&nl, "DE", None, &lines))
        .await
        .expect("plain");
    assert_eq!(plain.treatment, EuTreatment::SellerRateCrossBorder);
    assert_eq!(plain.lines[0].rate_bps, 2100);
    assert_eq!(plain.gross_total_minor, 11_900);

    // A deleted registration and one starting in the future do not count.
    oss(&db, &nl, None, true).await;
    oss(&db, &nl, Some("2027-01-01"), false).await;
    let still_plain = calculate_eu_destination_tax(&db, None, &args(&nl, "DE", None, &lines))
        .await
        .expect("still plain");
    assert_eq!(still_plain.treatment, EuTreatment::SellerRateCrossBorder);

    // An active one: the destination rate, the price the shopper saw.
    oss(&db, &nl, Some("2026-07-01"), false).await;
    let with_oss = calculate_eu_destination_tax(&db, None, &args(&nl, "DE", None, &lines))
        .await
        .expect("oss");
    assert_eq!(with_oss.treatment, EuTreatment::Oss);
    assert_eq!(with_oss.lines[0].rate_bps, 1900);
    assert_eq!(with_oss.gross_total_minor, 11_900);
    assert_eq!(with_oss.tax_total_minor, 1900);

    // Domestic ignores the number and VIES.
    let domestic = calculate_eu_destination_tax(&db, None, &args(&nl, "NL", Some("NL999"), &lines))
        .await
        .expect("domestic");
    assert_eq!(domestic.treatment, EuTreatment::Domestic);
    assert_eq!(domestic.tax_total_minor, 2065);

    // VIES says valid (cached): reverse charge.
    vies_cache(&db, "BE0123456749", true).await;
    let reverse =
        calculate_eu_destination_tax(&db, None, &args(&nl, "BE", Some("be 0123.456.749"), &lines))
            .await
            .expect("reverse charge");
    assert_eq!(reverse.treatment, EuTreatment::ReverseCharge);
    assert_eq!(reverse.tax_total_minor, 0);
    assert!(!reverse.vies_unavailable);
    let calculated = reverse.to_calculated(0);
    assert_eq!(calculated.tax_total, "0.00");
    assert_eq!(
        calculated.processed_items[0].tax_code.as_deref(),
        Some("eu_b2b_goods")
    );

    // VIES says invalid (cached), or the number is another country's: a consumer.
    vies_cache(&db, "BE0999999999", false).await;
    let invalid =
        calculate_eu_destination_tax(&db, None, &args(&nl, "BE", Some("BE0999999999"), &lines))
            .await
            .expect("invalid");
    assert_eq!(invalid.treatment, EuTreatment::Oss);
    let foreign_number =
        calculate_eu_destination_tax(&db, None, &args(&nl, "BE", Some("DE123456789"), &lines))
            .await
            .expect("foreign number");
    assert_eq!(foreign_number.treatment, EuTreatment::Oss);

    // VIES unreachable (no HTTP port, nothing cached): charged, flagged.
    let down =
        calculate_eu_destination_tax(&db, None, &args(&nl, "FR", Some("FR12345678901"), &lines))
            .await
            .expect("vies down");
    assert_eq!(down.treatment, EuTreatment::Oss);
    assert!(down.vies_unavailable);
    assert_eq!(down.lines[0].rate_bps, 2000);
    assert!(down.to_calculated(0).tax_warnings.is_some());

    // Outside the EU.
    let export = calculate_eu_destination_tax(&db, None, &args(&nl, "US", None, &lines))
        .await
        .expect("export");
    assert_eq!(export.treatment, EuTreatment::OutsideEu);

    // Errors stay errors: an unknown entity, a non-EU seller, a bad country.
    let missing =
        calculate_eu_destination_tax(&db, None, &args("ent_nope", "DE", None, &lines)).await;
    assert!(matches!(missing, Err(EuVatError::EntityNotFound(_))));
    let us = entity(&db, "US").await;
    let not_eu = calculate_eu_destination_tax(&db, None, &args(&us, "DE", None, &lines)).await;
    assert!(matches!(not_eu, Err(EuVatError::SellerNotEu(_))));
    assert!(matches!(
        TaxError::from(not_eu.expect_err("error")),
        TaxError::Calculation(_)
    ));
    let bad = calculate_eu_destination_tax(&db, None, &args(&nl, "", None, &lines)).await;
    assert!(matches!(bad, Err(EuVatError::InvalidBuyerCountry(_))));
}
