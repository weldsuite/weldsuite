//! The pure part of EU destination VAT: which treatment a sale gets, and the
//! net, tax and gross of each line. No database, no clock: the caller gives
//! the facts (the buyer's VIES verdict, the OSS registration, the date).

use super::rates::{self, RateError, VatCategory};
use crate::compliance;

/// How the VAT of a sale was worked out. The names are what orders store as
/// `vat_treatment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EuTreatment {
    /// Buyer in the seller's country: the seller's rate.
    Domestic,
    /// Consumer in another member state, seller registered for the One-Stop
    /// Shop: the destination country's rate.
    Oss,
    /// Business in another member state with a VAT number VIES accepted: 0%,
    /// the buyer accounts for the VAT (art. 196 / art. 138 VAT Directive).
    ReverseCharge,
    /// Consumer in another member state, seller not registered for OSS: the
    /// seller's own rate.
    SellerRateCrossBorder,
    /// Buyer outside the EU: no EU VAT (an export or a service outside the
    /// scope).
    OutsideEu,
}

impl EuTreatment {
    pub const ALL: [Self; 5] = [
        Self::Domestic,
        Self::Oss,
        Self::ReverseCharge,
        Self::SellerRateCrossBorder,
        Self::OutsideEu,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Domestic => "domestic",
            Self::Oss => "oss",
            Self::ReverseCharge => "reverse_charge",
            Self::SellerRateCrossBorder => "seller_rate_cross_border",
            Self::OutsideEu => "outside_eu",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == value)
    }
}

/// What is known of the buyer's VAT number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuyerVat {
    /// No VAT number: a consumer.
    None,
    /// VIES registered it, and it is a number of the buyer's country.
    Valid,
    /// VIES rejected it, or it is not a number of the buyer's country:
    /// charged as a consumer.
    Invalid,
    /// VIES could not be asked: charged as a consumer, and the result says
    /// so (`vies_unavailable`). Never reverse charged.
    Unavailable,
}

/// Goods or services; picks the reverse-charge category and the invoice text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupplyKind {
    Goods,
    Services,
}

/// What a zero-rated sale (reverse charge, outside the EU) does to a
/// VAT-inclusive price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ZeroRatedGross {
    /// The price the shopper saw is the price: net equals gross, tax is 0.
    #[default]
    KeepGross,
    /// The seller's own VAT comes off the price (net = gross minus the VAT
    /// the seller's rate would have carried), the buyer pays that net.
    StripSellerVat,
}

/// One line as the sale gives it, in minor units (cents).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DestinationLine {
    pub quantity: i64,
    pub unit_price_minor: i64,
    /// What is taken off the line in total (not per unit).
    pub discount_minor: i64,
    pub category: VatCategory,
}

impl DestinationLine {
    /// The line's amount after its discount: net when prices exclude VAT,
    /// gross when they include it.
    pub fn amount_minor(&self) -> i64 {
        self.quantity * self.unit_price_minor - self.discount_minor
    }
}

/// Everything the pure calculation needs.
#[derive(Debug, Clone, Copy)]
pub struct DestinationInput<'a> {
    /// The seller entity's country (ISO alpha-2): an EU member state.
    pub seller_country: &'a str,
    /// The buyer's country (ISO alpha-2).
    pub buyer_country: &'a str,
    pub buyer_vat: BuyerVat,
    /// The seller is registered for the One-Stop Shop on `date`.
    pub oss_registered: bool,
    /// The tax point, `YYYY-MM-DD`: picks the rate versions.
    pub date: &'a str,
    /// The line prices include VAT.
    pub prices_include_vat: bool,
    pub supply: SupplyKind,
    pub zero_rated_gross: ZeroRatedGross,
    pub lines: &'a [DestinationLine],
}

/// One line's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EuVatLine {
    pub category: VatCategory,
    /// Basis points: 2100 is 21%. 0 when zero-rated.
    pub rate_bps: u32,
    pub net_minor: i64,
    pub tax_minor: i64,
    pub gross_minor: i64,
}

/// The document's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EuVatResult {
    pub treatment: EuTreatment,
    pub seller_country: String,
    pub buyer_country: String,
    /// The country whose rates applied; `None` when zero-rated (reverse
    /// charge, outside the EU).
    pub rate_country: Option<String>,
    /// VIES was needed and could not be reached; the sale was charged as to
    /// a consumer. The caller stores this so the order can be reviewed.
    pub vies_unavailable: bool,
    pub prices_include_vat: bool,
    pub lines: Vec<EuVatLine>,
    pub net_total_minor: i64,
    pub tax_total_minor: i64,
    pub gross_total_minor: i64,
    /// The invoice tax category of a reverse-charge sale: `eu_b2b_goods` or
    /// `eu_b2b_service`.
    pub reverse_charge_category: Option<&'static str>,
    /// The text the invoice prints for a reverse-charge sale (Dutch sellers;
    /// the other countries' adapters add theirs).
    pub invoice_notice: Option<&'static str>,
}

fn iso(country: &str) -> String {
    let upper = country.trim().to_ascii_uppercase();
    if upper == "EL" { "GR".into() } else { upper }
}

/// The treatment of a sale, and the country whose rates apply.
pub fn decide_treatment(
    seller_country: &str,
    buyer_country: &str,
    buyer_vat: BuyerVat,
    oss_registered: bool,
) -> (EuTreatment, Option<String>) {
    if !rates::is_eu_member(buyer_country) {
        return (EuTreatment::OutsideEu, None);
    }
    if iso(seller_country) == iso(buyer_country) {
        return (EuTreatment::Domestic, Some(iso(seller_country)));
    }
    if buyer_vat == BuyerVat::Valid {
        return (EuTreatment::ReverseCharge, None);
    }
    if oss_registered {
        (EuTreatment::Oss, Some(iso(buyer_country)))
    } else {
        (
            EuTreatment::SellerRateCrossBorder,
            Some(iso(seller_country)),
        )
    }
}

/// `amount * numerator / denominator`, rounded half away from zero to a
/// whole minor unit.
fn mul_div_round(amount: i64, numerator: i64, denominator: i64) -> i64 {
    let value = i128::from(amount) * i128::from(numerator);
    let denominator = i128::from(denominator);
    let half = denominator / 2;
    let rounded = if value >= 0 {
        (value + half) / denominator
    } else {
        (value - half) / denominator
    };
    i64::try_from(rounded).unwrap_or(0)
}

/// The VAT inside a gross amount at `rate_bps`, rounded to the minor unit.
pub fn tax_in_gross(gross_minor: i64, rate_bps: u32) -> i64 {
    mul_div_round(
        gross_minor,
        i64::from(rate_bps),
        10_000 + i64::from(rate_bps),
    )
}

/// The VAT on a net amount at `rate_bps`, rounded to the minor unit.
pub fn tax_on_net(net_minor: i64, rate_bps: u32) -> i64 {
    mul_div_round(net_minor, i64::from(rate_bps), 10_000)
}

/// Net, tax and gross of every line, and the totals, for a sale of a seller
/// in `seller_country` to a buyer in `buyer_country`.
///
/// Rounding: tax is rounded half away from zero to the minor unit **per
/// line**, and the document total is the sum of the lines. With prices
/// including VAT the gross of a line is its price and the net is gross minus
/// that tax; with prices excluding VAT the net is its price and the gross is
/// net plus tax.
///
/// Errors when the seller is not in the EU or a rate is missing: never zero
/// tax.
pub fn calculate(input: &DestinationInput<'_>) -> Result<EuVatResult, RateError> {
    if !rates::is_eu_member(input.seller_country) {
        return Err(RateError::NotEuCountry(input.seller_country.to_owned()));
    }
    let (treatment, rate_country) = decide_treatment(
        input.seller_country,
        input.buyer_country,
        input.buyer_vat,
        input.oss_registered,
    );
    let mut lines = Vec::with_capacity(input.lines.len());
    for line in input.lines {
        lines.push(line_result(input, rate_country.as_deref(), line)?);
    }
    let sum = |pick: fn(&EuVatLine) -> i64| lines.iter().map(pick).sum::<i64>();
    let (net_total_minor, tax_total_minor, gross_total_minor) = (
        sum(|l| l.net_minor),
        sum(|l| l.tax_minor),
        sum(|l| l.gross_minor),
    );
    let (reverse_charge_category, invoice_notice) = reverse_charge_text(input, treatment);
    Ok(EuVatResult {
        treatment,
        seller_country: iso(input.seller_country),
        buyer_country: iso(input.buyer_country),
        rate_country,
        vies_unavailable: input.buyer_vat == BuyerVat::Unavailable
            && rates::is_eu_member(input.buyer_country)
            && treatment != EuTreatment::Domestic,
        prices_include_vat: input.prices_include_vat,
        lines,
        net_total_minor,
        tax_total_minor,
        gross_total_minor,
        reverse_charge_category,
        invoice_notice,
    })
}

fn reverse_charge_text(
    input: &DestinationInput<'_>,
    treatment: EuTreatment,
) -> (Option<&'static str>, Option<&'static str>) {
    if treatment != EuTreatment::ReverseCharge {
        return (None, None);
    }
    let (category, notice_name) = match input.supply {
        SupplyKind::Goods => ("eu_b2b_goods", "NL_NOTICE_ICL"),
        SupplyKind::Services => ("eu_b2b_service", "NL_NOTICE_REVERSE_CHARGE_EU"),
    };
    let notice = (iso(input.seller_country) == "NL").then(|| compliance::notice(notice_name));
    (Some(category), notice)
}

fn line_result(
    input: &DestinationInput<'_>,
    rate_country: Option<&str>,
    line: &DestinationLine,
) -> Result<EuVatLine, RateError> {
    let amount = line.amount_minor();
    let Some(country) = rate_country else {
        // Zero-rated: there is no destination rate. A VAT-inclusive price
        // either stays as it is or loses the seller's own VAT.
        let net = if input.prices_include_vat
            && input.zero_rated_gross == ZeroRatedGross::StripSellerVat
        {
            let seller_rate = rates::rate_bps(input.seller_country, line.category, input.date)?;
            amount - tax_in_gross(amount, seller_rate)
        } else {
            amount
        };
        return Ok(EuVatLine {
            category: line.category,
            rate_bps: 0,
            net_minor: net,
            tax_minor: 0,
            gross_minor: net,
        });
    };
    let rate_bps = rates::rate_bps(country, line.category, input.date)?;
    Ok(if input.prices_include_vat {
        let tax = tax_in_gross(amount, rate_bps);
        EuVatLine {
            category: line.category,
            rate_bps,
            net_minor: amount - tax,
            tax_minor: tax,
            gross_minor: amount,
        }
    } else {
        let tax = tax_on_net(amount, rate_bps);
        EuVatLine {
            category: line.category,
            rate_bps,
            net_minor: amount,
            tax_minor: tax,
            gross_minor: amount + tax,
        }
    })
}
