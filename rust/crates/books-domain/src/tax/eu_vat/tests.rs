use super::decide::{self, *};
use super::rates::{self, RateError, VatCategory};

const TODAY: &str = "2026-11-21";

fn line(category: VatCategory, unit_price_minor: i64, quantity: i64) -> DestinationLine {
    DestinationLine {
        quantity,
        unit_price_minor,
        discount_minor: 0,
        category,
    }
}

fn input<'a>(
    seller: &'a str,
    buyer: &'a str,
    vat: BuyerVat,
    oss: bool,
    lines: &'a [DestinationLine],
) -> DestinationInput<'a> {
    DestinationInput {
        seller_country: seller,
        buyer_country: buyer,
        buyer_vat: vat,
        oss_registered: oss,
        date: TODAY,
        prices_include_vat: false,
        supply: SupplyKind::Goods,
        zero_rated_gross: ZeroRatedGross::KeepGross,
        lines,
    }
}

#[test]
fn the_table_covers_27_states_and_every_category() {
    let states = rates::member_states();
    assert_eq!(states.len(), 27);
    for country in &states {
        for category in VatCategory::ALL {
            let rate = rates::rate_bps(country, category, TODAY).expect("rate");
            match category {
                VatCategory::Zero | VatCategory::Exempt => assert_eq!(rate, 0),
                VatCategory::Standard => assert!((1500..=2700).contains(&rate), "{country}"),
                // A reduced rate is never above the standard one and never 0.
                _ => {
                    let standard = rates::standard_rate_bps(country, TODAY).expect("standard");
                    assert!(rate > 0 && rate <= standard, "{country} {category:?}");
                }
            }
        }
        // Reduced is never below super-reduced.
        let reduced = rates::rate_bps(country, VatCategory::Reduced, TODAY).expect("reduced");
        let super_reduced =
            rates::rate_bps(country, VatCategory::SuperReduced, TODAY).expect("super reduced");
        assert!(super_reduced <= reduced, "{country}");
    }
    let (source, checked) = rates::source();
    assert!(source.contains("europa.eu") && checked == "2026-11-21");
}

#[test]
fn standard_rates_of_2026() {
    let expected = [
        ("AT", 2000),
        ("BE", 2100),
        ("BG", 2000),
        ("CY", 1900),
        ("CZ", 2100),
        ("DE", 1900),
        ("DK", 2500),
        ("EE", 2400),
        ("ES", 2100),
        ("FI", 2550),
        ("FR", 2000),
        ("GR", 2400),
        ("HR", 2500),
        ("HU", 2700),
        ("IE", 2300),
        ("IT", 2200),
        ("LT", 2100),
        ("LU", 1700),
        ("LV", 2100),
        ("MT", 1800),
        ("NL", 2100),
        ("PL", 2300),
        ("PT", 2300),
        ("RO", 2100),
        ("SE", 2500),
        ("SI", 2200),
        ("SK", 2300),
    ];
    for (country, bps) in expected {
        assert_eq!(
            rates::standard_rate_bps(country, TODAY),
            Ok(bps),
            "{country}"
        );
    }
    // Greece writes EL in a VAT number.
    assert_eq!(rates::standard_rate_bps("EL", TODAY), Ok(2400));
    assert_eq!(rates::vat_prefix("GR"), "EL");
    assert!(rates::is_eu_member("EL") && !rates::is_eu_member("GB"));
}

#[test]
fn rates_switch_on_their_effective_date() {
    let std = |country, date| rates::standard_rate_bps(country, date);
    // Estonia: 22% to 24% on 2025-07-01.
    assert_eq!(std("EE", "2025-06-30"), Ok(2200));
    assert_eq!(std("EE", "2025-07-01"), Ok(2400));
    // Romania: 19% to 21% (reduced 9% to 11%) on 2025-08-01.
    assert_eq!(std("RO", "2025-07-31"), Ok(1900));
    assert_eq!(std("RO", "2025-08-01"), Ok(2100));
    assert_eq!(
        rates::rate_bps("RO", VatCategory::Reduced, "2025-07-31"),
        Ok(900)
    );
    assert_eq!(
        rates::rate_bps("RO", VatCategory::Reduced, "2025-08-01"),
        Ok(1100)
    );
    // Slovakia: 20% to 23% on 2025-01-01.
    assert_eq!(std("SK", "2024-12-31"), Ok(2000));
    assert_eq!(std("SK", "2025-01-01"), Ok(2300));
    // Finland: 24% to 25.5% on 2024-09-01; reduced 14% to 13.5% on 2026-01-01.
    assert_eq!(std("FI", "2024-08-31"), Ok(2400));
    assert_eq!(std("FI", "2024-09-01"), Ok(2550));
    assert_eq!(
        rates::rate_bps("FI", VatCategory::Reduced, "2025-12-31"),
        Ok(1400)
    );
    assert_eq!(
        rates::rate_bps("FI", VatCategory::Reduced, "2026-01-01"),
        Ok(1350)
    );
    // The sale's date picks the version, through the whole calculation.
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let mut sale = input("NL", "EE", BuyerVat::None, true, &lines);
    sale.date = "2025-06-30";
    assert_eq!(
        decide::calculate(&sale)
            .expect("calculation")
            .tax_total_minor,
        2200
    );
    sale.date = "2025-07-01";
    assert_eq!(
        decide::calculate(&sale)
            .expect("calculation")
            .tax_total_minor,
        2400
    );
}

#[test]
fn dates_outside_the_table_are_errors() {
    assert!(matches!(
        rates::standard_rate_bps("NL", "2023-12-31"),
        Err(RateError::NoRateOnDate { .. })
    ));
    assert!(matches!(
        rates::standard_rate_bps("NL", "21-11-2026"),
        Err(RateError::InvalidDate(_))
    ));
    assert!(matches!(
        rates::standard_rate_bps("US", TODAY),
        Err(RateError::NotEuCountry(_))
    ));
    // After the newest version the newest applies.
    assert_eq!(rates::standard_rate_bps("NL", "2040-01-01"), Ok(2100));
}

#[test]
fn domestic_nl_uses_the_sellers_rate_per_category() {
    let lines = [
        line(VatCategory::Standard, 10_000, 1),
        line(VatCategory::Reduced, 10_000, 1),
        line(VatCategory::SuperReduced, 10_000, 1),
        line(VatCategory::Zero, 10_000, 1),
        line(VatCategory::Exempt, 10_000, 1),
    ];
    // Even with an OSS registration a domestic sale is domestic.
    let result =
        decide::calculate(&input("NL", "NL", BuyerVat::None, true, &lines)).expect("calculation");
    assert_eq!(result.treatment, EuTreatment::Domestic);
    assert_eq!(result.rate_country.as_deref(), Some("NL"));
    let rates: Vec<u32> = result.lines.iter().map(|l| l.rate_bps).collect();
    assert_eq!(rates, [2100, 900, 900, 0, 0]);
    let taxes: Vec<i64> = result.lines.iter().map(|l| l.tax_minor).collect();
    assert_eq!(taxes, [2100, 900, 900, 0, 0]);
    assert_eq!(result.net_total_minor, 50_000);
    assert_eq!(result.tax_total_minor, 3900);
    assert_eq!(result.gross_total_minor, 53_900);
    assert!(!result.vies_unavailable);
    assert_eq!(result.reverse_charge_category, None);
    // A domestic business needs no VIES verdict.
    let business =
        decide::calculate(&input("NL", "NL", BuyerVat::Valid, false, &lines)).expect("calculation");
    assert_eq!(business.treatment, EuTreatment::Domestic);
}

#[test]
fn consumer_nl_to_de_with_and_without_oss() {
    let lines = [line(VatCategory::Standard, 10_000, 2)];
    let oss =
        decide::calculate(&input("NL", "DE", BuyerVat::None, true, &lines)).expect("calculation");
    assert_eq!(oss.treatment, EuTreatment::Oss);
    assert_eq!(oss.rate_country.as_deref(), Some("DE"));
    assert_eq!(oss.lines[0].rate_bps, 1900);
    assert_eq!(oss.tax_total_minor, 3800);
    assert_eq!(oss.gross_total_minor, 23_800);

    let plain =
        decide::calculate(&input("NL", "DE", BuyerVat::None, false, &lines)).expect("calculation");
    assert_eq!(plain.treatment, EuTreatment::SellerRateCrossBorder);
    assert_eq!(plain.rate_country.as_deref(), Some("NL"));
    assert_eq!(plain.lines[0].rate_bps, 2100);
    assert_eq!(plain.tax_total_minor, 4200);

    // A reduced line takes the destination's reduced rate.
    let reduced = [line(VatCategory::Reduced, 10_000, 1)];
    let oss_reduced =
        decide::calculate(&input("NL", "DE", BuyerVat::None, true, &reduced)).expect("calculation");
    assert_eq!(oss_reduced.lines[0].rate_bps, 700);
}

#[test]
fn business_nl_to_be_with_valid_vies_is_reverse_charged() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let goods =
        decide::calculate(&input("NL", "BE", BuyerVat::Valid, true, &lines)).expect("calculation");
    assert_eq!(goods.treatment, EuTreatment::ReverseCharge);
    assert_eq!(goods.rate_country, None);
    assert_eq!(goods.lines[0].rate_bps, 0);
    assert_eq!(goods.tax_total_minor, 0);
    assert_eq!(goods.gross_total_minor, 10_000);
    assert_eq!(goods.reverse_charge_category, Some("eu_b2b_goods"));
    assert!(
        goods
            .invoice_notice
            .is_some_and(|n| n.contains("intracommunautaire"))
    );
    assert!(!goods.vies_unavailable);

    let mut services = input("NL", "BE", BuyerVat::Valid, false, &lines);
    services.supply = SupplyKind::Services;
    let services = decide::calculate(&services).expect("calculation");
    assert_eq!(services.reverse_charge_category, Some("eu_b2b_service"));
    assert!(
        services
            .invoice_notice
            .is_some_and(|n| n.contains("art. 196"))
    );

    // A number VIES rejected is a consumer.
    let invalid = decide::calculate(&input("NL", "BE", BuyerVat::Invalid, true, &lines))
        .expect("calculation");
    assert_eq!(invalid.treatment, EuTreatment::Oss);
    assert_eq!(invalid.tax_total_minor, 2100);
}

#[test]
fn vies_down_charges_vat_and_flags_it() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let oss = decide::calculate(&input("NL", "BE", BuyerVat::Unavailable, true, &lines))
        .expect("calculation");
    assert_eq!(oss.treatment, EuTreatment::Oss);
    assert!(oss.vies_unavailable);
    assert_eq!(oss.tax_total_minor, 2100);
    assert_eq!(oss.reverse_charge_category, None);
    let plain = decide::calculate(&input("NL", "BE", BuyerVat::Unavailable, false, &lines))
        .expect("calculation");
    assert_eq!(plain.treatment, EuTreatment::SellerRateCrossBorder);
    assert!(plain.vies_unavailable);
    assert_eq!(plain.tax_total_minor, 2100);
}

#[test]
fn buyer_outside_the_eu_carries_no_eu_vat() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    for country in ["US", "GB", "CH"] {
        let result = decide::calculate(&input("NL", country, BuyerVat::None, true, &lines))
            .expect("calculation");
        assert_eq!(result.treatment, EuTreatment::OutsideEu, "{country}");
        assert_eq!(result.tax_total_minor, 0);
        assert_eq!(result.rate_country, None);
        assert_eq!(result.reverse_charge_category, None);
    }
}

#[test]
fn monaco_is_taxed_as_france() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let oss = decide::calculate(&input("NL", "MC", BuyerVat::None, true, &lines)).expect("oss");
    assert_eq!(oss.treatment, EuTreatment::Oss);
    assert_eq!(oss.rate_country.as_deref(), Some("FR"));
    assert_eq!(oss.tax_total_minor, 2000);
    let home = decide::calculate(&input("FR", "MC", BuyerVat::None, false, &lines)).expect("home");
    assert_eq!(home.treatment, EuTreatment::Domestic);
    let business =
        decide::calculate(&input("NL", "mc", BuyerVat::Valid, true, &lines)).expect("b2b");
    assert_eq!(business.treatment, EuTreatment::ReverseCharge);
}

#[test]
fn northern_ireland_is_refused_not_zero_rated() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let error =
        decide::calculate(&input("NL", "XI", BuyerVat::None, true, &lines)).expect_err("error");
    assert_eq!(error, RateError::UnsupportedDestination("XI".to_owned()));
    // Great Britain stays outside the EU.
    assert!(decide::calculate(&input("NL", "GB", BuyerVat::None, true, &lines)).is_ok());
}

#[test]
fn a_seller_outside_the_eu_is_an_error_not_zero_tax() {
    let lines = [line(VatCategory::Standard, 10_000, 1)];
    let error =
        decide::calculate(&input("US", "DE", BuyerVat::None, true, &lines)).expect_err("error");
    assert!(matches!(error, RateError::NotEuCountry(_)));
    let mut old = input("NL", "DE", BuyerVat::None, true, &lines);
    old.date = "2001-01-01";
    assert!(decide::calculate(&old).is_err());
}

#[test]
fn gross_prices_stay_gross_and_net_is_derived() {
    // (country, bps, gross, expected tax): tax = round(gross * rate / (1 + rate)).
    let cases = [
        ("DE", 1900, 1999, 319), // 319.2
        ("NL", 2100, 1000, 174), // 173.55
        ("FI", 2550, 1000, 203), // 203.19
        ("HU", 2700, 1000, 213), // 212.6
        ("LU", 1700, 1000, 145), // 145.30
        ("DK", 2500, 999, 200),  // 199.8
    ];
    for (country, bps, gross, tax) in cases {
        let lines = [line(VatCategory::Standard, gross, 1)];
        // A Dutch seller with OSS: the shopper in `country` pays the price
        // they saw, the net comes from their country's rate.
        let mut sale = input("NL", country, BuyerVat::None, true, &lines);
        sale.prices_include_vat = true;
        let result = decide::calculate(&sale).expect("calculation");
        let line = &result.lines[0];
        assert_eq!(line.rate_bps, bps, "{country}");
        assert_eq!(line.gross_minor, gross, "{country} gross stays");
        assert_eq!(line.tax_minor, tax, "{country} tax");
        assert_eq!(line.net_minor, gross - tax, "{country} net");
        assert_eq!(result.gross_total_minor, gross);
    }
}

#[test]
fn gross_mode_rounds_per_line_and_sums_the_lines() {
    // Three lines of 3.33 at 21%: each rounds on its own (0.578 -> 0.58),
    // and the total is the sum of the lines, not the tax of the total.
    let lines = [line(VatCategory::Standard, 333, 1); 3];
    let mut sale = input("NL", "NL", BuyerVat::None, false, &lines);
    sale.prices_include_vat = true;
    let result = decide::calculate(&sale).expect("calculation");
    assert!(result.lines.iter().all(|l| l.tax_minor == 58));
    assert_eq!(result.tax_total_minor, 174);
    assert_eq!(result.gross_total_minor, 999);
    assert_eq!(result.net_total_minor, 825);
    // Quantity and discount: 3 x 10.00 - 5.00 = 25.00 gross.
    let discounted = [DestinationLine {
        quantity: 3,
        unit_price_minor: 1000,
        discount_minor: 500,
        category: VatCategory::Standard,
    }];
    let mut sale = input("NL", "NL", BuyerVat::None, false, &discounted);
    sale.prices_include_vat = true;
    let result = decide::calculate(&sale).expect("calculation");
    assert_eq!(result.gross_total_minor, 2500);
    assert_eq!(result.tax_total_minor, 434); // 2500 * 21 / 121 = 433.88
}

#[test]
fn net_mode_rounds_half_up_per_line() {
    let lines = [line(VatCategory::Standard, 6533, 1)];
    let result =
        decide::calculate(&input("NL", "NL", BuyerVat::None, false, &lines)).expect("calculation");
    assert_eq!(result.tax_total_minor, 1372); // 13.7193
    // 0.5 of a cent rounds away from zero, for a refund line too.
    assert_eq!(decide::tax_on_net(50, 1000), 5);
    assert_eq!(decide::tax_on_net(-50, 1000), -5);
    assert_eq!(decide::tax_in_gross(-1000, 2100), -174);
}

#[test]
fn zero_rated_gross_prices() {
    let lines = [line(VatCategory::Standard, 12_100, 1)];
    let mut keep = input("NL", "BE", BuyerVat::Valid, true, &lines);
    keep.prices_include_vat = true;
    let kept = decide::calculate(&keep).expect("calculation");
    assert_eq!(kept.lines[0].net_minor, 12_100);
    assert_eq!(kept.gross_total_minor, 12_100);
    keep.zero_rated_gross = ZeroRatedGross::StripSellerVat;
    let stripped = decide::calculate(&keep).expect("calculation");
    assert_eq!(stripped.lines[0].net_minor, 10_000);
    assert_eq!(stripped.gross_total_minor, 10_000);
    assert_eq!(stripped.tax_total_minor, 0);
}

#[test]
fn categories_and_treatments_round_trip() {
    for category in VatCategory::ALL {
        assert_eq!(VatCategory::parse(category.as_str()), Some(category));
    }
    for treatment in EuTreatment::ALL {
        assert_eq!(EuTreatment::parse(treatment.as_str()), Some(treatment));
    }
    assert_eq!(VatCategory::parse("food"), None);
    // A variant's category wins; without one the product's applies.
    assert_eq!(
        super::effective_category("standard", Some("reduced")),
        Some(VatCategory::Reduced)
    );
    assert_eq!(
        super::effective_category("super_reduced", None),
        Some(VatCategory::SuperReduced)
    );
    assert_eq!(
        super::effective_category("standard", Some("")),
        Some(VatCategory::Standard)
    );
    assert_eq!(super::effective_category("bogus", None), None);
}
