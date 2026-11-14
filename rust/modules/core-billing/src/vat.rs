//! Which VAT a plan invoice carries (ADR BILL-014, "Invoices and VAT").
//!
//! A WeldSuite plan is an electronically supplied service, sold by the
//! issuer entity (WeldSuite B.V., the Netherlands) on the EU edition:
//!
//! | Customer | Treatment | Rate |
//! |---|---|---|
//! | In the seller's country, business or consumer | domestic | the seller country's standard rate |
//! | EU business elsewhere, VAT number valid in VIES | reverse charge | 0% |
//! | EU customer elsewhere without a valid VAT number | OSS | the customer country's standard rate |
//! | Outside the EU | outside the EU | 0% |
//!
//! A VAT number VIES can't check right now (VIES down) counts as valid when
//! its format matches the customer's country, and the invoice says so in its
//! log line; a number VIES rejects does not.
//!
//! The rates are the EU standard rates in force on 2026-11-01; a change is
//! a change here, with its date.

use serde::{Deserialize, Serialize};

/// EU member states and their standard VAT rate, in basis points.
pub const EU_STANDARD_RATES: &[(&str, u32)] = &[
    ("AT", 2000),
    ("BE", 2100),
    ("BG", 2000),
    ("CY", 1900),
    ("CZ", 2100),
    ("DE", 1900),
    ("DK", 2500),
    // Estonia: 24% since 2025-07-01.
    ("EE", 2400),
    ("ES", 2100),
    // Finland: 25.5% since 2024-09-01.
    ("FI", 2550),
    ("FR", 2000),
    // Greece: ISO GR, VAT prefix EL.
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
    // Romania: 21% since 2025-08-01.
    ("RO", 2100),
    ("SE", 2500),
    ("SI", 2200),
    // Slovakia: 23% since 2025-01-01.
    ("SK", 2300),
];

/// The standard rate of an EU member state, `None` outside the EU.
pub fn standard_rate(country: &str) -> Option<u32> {
    EU_STANDARD_RATES
        .iter()
        .find(|(code, _)| *code == country)
        .map(|(_, rate)| *rate)
}

/// Whether `country` (ISO 3166-1 alpha-2) is an EU member state.
pub fn is_eu(country: &str) -> bool {
    standard_rate(country).is_some()
}

/// The VAT number prefix of a country (Greece writes `EL`).
pub fn vat_prefix(country: &str) -> &str {
    if country == "GR" { "EL" } else { country }
}

/// How the VAT on an invoice is worked out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Treatment {
    /// The seller's own country: its standard rate.
    Domestic,
    /// An EU business in another member state: 0%, the customer accounts
    /// for the VAT (Article 196 of the VAT Directive).
    ReverseCharge,
    /// An EU customer elsewhere without a valid VAT number: the customer
    /// country's rate, declared through the One-Stop Shop.
    Oss,
    /// Outside the EU: not subject to EU VAT.
    OutsideEu,
}

impl Treatment {
    /// `billing_invoices.customer_tax_exempt`, as Stripe Tax writes it on
    /// Global: `none`, `reverse` or `exempt`.
    pub fn tax_exempt(self) -> &'static str {
        match self {
            Self::Domestic | Self::Oss => "none",
            Self::ReverseCharge => "reverse",
            Self::OutsideEu => "exempt",
        }
    }
}

/// What VIES said about the customer's VAT number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VatCheck {
    /// No VAT number given.
    None,
    /// VIES registered it (or VIES was down and the format fits).
    Valid,
    /// VIES says it isn't registered, or it isn't a VAT number of the
    /// customer's country.
    Invalid,
}

/// The VAT an invoice carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VatDecision {
    pub treatment: Treatment,
    /// Basis points: 2100 is 21%.
    pub rate_bps: u32,
    /// The customer's country (ISO alpha-2).
    pub country: String,
}

/// Decides the treatment for a customer in `buyer_country` (ISO alpha-2,
/// upper case) of a seller in `seller_country`.
pub fn decide(seller_country: &str, buyer_country: &str, vat: VatCheck) -> VatDecision {
    let decision = |treatment, rate_bps| VatDecision {
        treatment,
        rate_bps,
        country: buyer_country.to_owned(),
    };
    if buyer_country == seller_country {
        return decision(
            Treatment::Domestic,
            standard_rate(seller_country).unwrap_or(0),
        );
    }
    match standard_rate(buyer_country) {
        None => decision(Treatment::OutsideEu, 0),
        Some(_) if vat == VatCheck::Valid => decision(Treatment::ReverseCharge, 0),
        Some(rate) => decision(Treatment::Oss, rate),
    }
}

/// The VAT on `net` cents at `rate_bps`, rounded half up to the cent.
pub fn vat_of(net: i64, rate_bps: u32) -> i64 {
    if net <= 0 || rate_bps == 0 {
        return 0;
    }
    (net * i64::from(rate_bps) + 5_000) / 10_000
}

/// `21`, `25.5`: a rate for an invoice line or a description.
pub fn rate_text(rate_bps: u32) -> String {
    let whole = rate_bps / 100;
    match rate_bps % 100 {
        0 => whole.to_string(),
        fraction if fraction % 10 == 0 => format!("{whole}.{}", fraction / 10),
        fraction => format!("{whole}.{fraction:02}"),
    }
}

/// A VAT number reduced to letters and digits, upper case, with its
/// country prefix (`NL123456789B01`), or `None` when it isn't one.
pub fn normalize_vat_number(raw: &str) -> Option<(String, String)> {
    weldsuite_books_domain::vies::normalize_vat_number(raw)
        .map(|normalized| (normalized.country_code, normalized.full))
}

/// Whether a normalized number's prefix belongs to `country`.
pub fn vat_number_matches_country(prefix: &str, country: &str) -> bool {
    prefix == vat_prefix(country)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_of_the_vat_table() {
        let nl_business = decide("NL", "NL", VatCheck::Valid);
        assert_eq!(nl_business.treatment, Treatment::Domestic);
        assert_eq!(nl_business.rate_bps, 2100);
        let nl_consumer = decide("NL", "NL", VatCheck::None);
        assert_eq!(nl_consumer.treatment, Treatment::Domestic);

        let be_business = decide("NL", "BE", VatCheck::Valid);
        assert_eq!(be_business.treatment, Treatment::ReverseCharge);
        assert_eq!(be_business.rate_bps, 0);
        assert_eq!(be_business.treatment.tax_exempt(), "reverse");

        let de_consumer = decide("NL", "DE", VatCheck::None);
        assert_eq!(de_consumer.treatment, Treatment::Oss);
        assert_eq!(de_consumer.rate_bps, 1900);
        let de_bad_number = decide("NL", "DE", VatCheck::Invalid);
        assert_eq!(de_bad_number.treatment, Treatment::Oss);

        let us = decide("NL", "US", VatCheck::Valid);
        assert_eq!(us.treatment, Treatment::OutsideEu);
        assert_eq!(us.rate_bps, 0);
        assert_eq!(us.treatment.tax_exempt(), "exempt");
        let ch = decide("NL", "CH", VatCheck::None);
        assert_eq!(ch.treatment, Treatment::OutsideEu);
    }

    #[test]
    fn vat_rounds_half_up_to_the_cent() {
        // €65.33 at 21% is €13.7193.
        assert_eq!(vat_of(6533, 2100), 1372);
        // 0.5 cent rounds up.
        assert_eq!(vat_of(50, 1000), 5);
        assert_eq!(vat_of(10_000, 2550), 2550);
        assert_eq!(vat_of(0, 2100), 0);
        assert_eq!(vat_of(-100, 2100), 0);
    }

    #[test]
    fn rates_read_as_people_write_them() {
        assert_eq!(rate_text(2100), "21");
        assert_eq!(rate_text(2550), "25.5");
        assert_eq!(rate_text(0), "0");
        assert_eq!(rate_text(1725), "17.25");
    }

    #[test]
    fn the_table_is_the_27_member_states() {
        assert_eq!(EU_STANDARD_RATES.len(), 27);
        assert!(is_eu("FI"));
        assert!(!is_eu("GB"));
        assert_eq!(vat_prefix("GR"), "EL");
        assert!(vat_number_matches_country("EL", "GR"));
        assert!(!vat_number_matches_country("DE", "NL"));
        assert_eq!(
            normalize_vat_number("nl 1234.567-89 b01"),
            Some(("NL".to_owned(), "NL123456789B01".to_owned()))
        );
    }
}
