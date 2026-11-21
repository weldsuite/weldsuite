//! EU destination VAT for a document of a legal entity: the database side of
//! [`super::decide`]. It reads the seller's country and OSS registration,
//! asks VIES about the buyer's VAT number, and calculates.
//!
//! It sits next to `calculate_document_tax` and is used for a sales
//! document of an EU entity whose buyer is given (WeldCommerce orders and
//! carts; an invoice built from an order). `calculate_document_tax` itself
//! keeps its rate-table, US, India and Brazil behaviour.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::OutboundHttp;

use super::decide::{
    self, BuyerVat, DestinationInput, DestinationLine, EuVatResult, SupplyKind, ZeroRatedGross,
};
use super::rates::{self, RateError};
use crate::tax::{CalculatedDocumentTax, CalculatedLine, TaxError};

/// Why an EU destination calculation failed. Every variant is an error the
/// caller answers (503 `TAX_ENGINE_UNAVAILABLE` for the engine ones): it
/// never becomes zero tax.
#[derive(Debug)]
pub enum EuVatError {
    /// No such (live) entity.
    EntityNotFound(String),
    /// The entity is not in the EU: use `calculate_document_tax`.
    SellerNotEu(String),
    /// The buyer's country is missing or not an ISO alpha-2 code.
    InvalidBuyerCountry(String),
    Rate(RateError),
    Database(sqlx::Error),
}

impl std::fmt::Display for EuVatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EntityNotFound(id) => write!(f, "accounting entity {id} not found"),
            Self::SellerNotEu(code) => {
                write!(f, "the entity's jurisdiction {code} is not in the EU")
            }
            Self::InvalidBuyerCountry(country) => {
                write!(f, "the buyer's country {country:?} is not a country code")
            }
            Self::Rate(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for EuVatError {}

impl From<RateError> for EuVatError {
    fn from(error: RateError) -> Self {
        Self::Rate(error)
    }
}

impl From<sqlx::Error> for EuVatError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<EuVatError> for TaxError {
    fn from(error: EuVatError) -> Self {
        match error {
            EuVatError::EntityNotFound(_)
            | EuVatError::SellerNotEu(_)
            | EuVatError::InvalidBuyerCountry(_) => Self::Calculation(error.to_string()),
            EuVatError::Rate(_) => Self::Internal(error.to_string()),
            EuVatError::Database(error) => Self::Database(error),
        }
    }
}

/// What [`calculate_eu_destination_tax`] is given.
#[derive(Debug, Clone, Copy)]
pub struct EuTaxArgs<'a> {
    /// The seller: the workspace's default legal entity.
    pub entity_id: &'a str,
    /// The buyer's country (ISO alpha-2).
    pub buyer_country: &'a str,
    /// The buyer's VAT number as typed; a business when present.
    pub buyer_vat_number: Option<&'a str>,
    pub prices_include_vat: bool,
    pub supply: SupplyKind,
    pub zero_rated_gross: ZeroRatedGross,
    /// The tax point (`YYYY-MM-DD`); today when `None`.
    pub date: Option<&'a str>,
    pub lines: &'a [DestinationLine],
}

/// The entity's country, from `entities.jurisdiction_code`.
async fn seller_country(db: &PgPool, entity_id: &str) -> Result<String, EuVatError> {
    let code: Option<String> = sqlx::query_scalar(
        "select jurisdiction_code from entities where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let code = code.ok_or_else(|| EuVatError::EntityNotFound(entity_id.to_owned()))?;
    if rates::is_eu_member(&code) {
        Ok(code.to_ascii_uppercase())
    } else {
        Err(EuVatError::SellerNotEu(code))
    }
}

/// Whether the entity has a live `oss` registration on `date`.
async fn oss_registered(db: &PgPool, entity_id: &str, date: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(select 1 from legal_entity_registrations \
         where entity_id = $1 and type = 'oss' and deleted_at is null \
         and (valid_from is null or valid_from <= $2::date) \
         and (valid_to is null or valid_to >= $2::date))",
    )
    .bind(entity_id)
    .bind(date)
    .fetch_one(db)
    .await
}

/// What VIES says about the buyer, for a sale to another member state.
async fn buyer_vat(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    seller: &str,
    buyer_country: &str,
    vat_number: Option<&str>,
) -> Result<BuyerVat, sqlx::Error> {
    let Some(number) = vat_number.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(BuyerVat::None);
    };
    // VIES is only needed where reverse charge is possible.
    if !rates::is_eu_member(buyer_country)
        || rates::vat_prefix(seller) == rates::vat_prefix(buyer_country)
    {
        return Ok(BuyerVat::None);
    }
    let Some(normalized) = crate::vies::normalize_vat_number(number) else {
        return Ok(BuyerVat::Invalid);
    };
    if normalized.country_code != rates::vat_prefix(buyer_country) {
        return Ok(BuyerVat::Invalid);
    }
    let check = crate::compliance::check_vat_number(db, http, &normalized.full).await?;
    Ok(match (check.available, check.valid) {
        (false, _) => BuyerVat::Unavailable,
        (true, true) => BuyerVat::Valid,
        (true, false) => BuyerVat::Invalid,
    })
}

/// The VAT of a sale of the entity to a buyer in `buyer_country`, by the
/// EU destination rules (ADR COM-014).
///
/// - domestic: the seller's rate of each line's category;
/// - a business in another member state with a VIES-valid VAT number:
///   reverse charge at 0%;
/// - a consumer in another member state: the destination rate when the
///   entity has an active `oss` registration, else the seller's rate;
/// - VIES unreachable: charged as for a consumer, `vies_unavailable` set;
/// - a buyer outside the EU: 0%.
///
/// Errors (database, rates, an entity outside the EU) are returned, never
/// turned into zero tax.
pub async fn calculate_eu_destination_tax(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    args: &EuTaxArgs<'_>,
) -> Result<EuVatResult, EuVatError> {
    let buyer_country = args.buyer_country.trim();
    if buyer_country.len() != 2 || !buyer_country.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(EuVatError::InvalidBuyerCountry(
            args.buyer_country.to_owned(),
        ));
    }
    let seller = seller_country(db, args.entity_id).await?;
    let today = rates::today();
    let date = args.date.unwrap_or(&today);
    // Monaco is French VAT territory: its buyers hold French VAT numbers.
    let territory = rates::territory(buyer_country);
    let vat = buyer_vat(db, http, &seller, &territory, args.buyer_vat_number).await?;
    let oss = oss_registered(db, args.entity_id, date).await?;
    Ok(decide::calculate(&DestinationInput {
        seller_country: &seller,
        buyer_country,
        buyer_vat: vat,
        oss_registered: oss,
        date,
        prices_include_vat: args.prices_include_vat,
        supply: args.supply,
        zero_rated_gross: args.zero_rated_gross,
        lines: args.lines,
    })?)
}

/// `1234` as `12.34`.
fn money(minor: i64) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let abs = minor.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// `2100` as `21`, `2550` as `25.5`.
fn rate_text(rate_bps: u32) -> String {
    let (whole, part) = (rate_bps / 100, rate_bps % 100);
    match part {
        0 => whole.to_string(),
        p if p % 10 == 0 => format!("{whole}.{}", p / 10),
        p => format!("{whole}.{p:02}"),
    }
}

impl EuVatResult {
    /// The result as the shape invoices use (`CalculatedDocumentTax`), for
    /// an invoice built from an order. `discount_total_minor` is what the
    /// lines were already reduced by (informational, as on invoices).
    pub fn to_calculated(&self, discount_total_minor: i64) -> CalculatedDocumentTax {
        let mut breakdown: Vec<(u32, i64, i64)> = Vec::new();
        for line in &self.lines {
            match breakdown
                .iter_mut()
                .find(|(rate, _, _)| *rate == line.rate_bps)
            {
                Some((_, net, tax)) => {
                    *net += line.net_minor;
                    *tax += line.tax_minor;
                }
                None => breakdown.push((line.rate_bps, line.net_minor, line.tax_minor)),
            }
        }
        let tax_breakdown: Vec<Value> = breakdown
            .into_iter()
            .map(|(rate, net, tax)| {
                let mut row = json!({
                    "taxRateId": "",
                    "taxRateName": match &self.rate_country {
                        Some(country) => format!("VAT {}% {country}", rate_text(rate)),
                        None => format!("VAT {}%", rate_text(rate)),
                    },
                    "taxRate": f64::from(rate) / 100.0,
                    "taxableAmount": amount_number(net),
                    "taxAmount": amount_number(tax),
                });
                if let Some(code) = self.reverse_charge_category {
                    row["taxCategoryCode"] = Value::String(code.to_owned());
                }
                row
            })
            .collect();
        CalculatedDocumentTax {
            subtotal: money(self.net_total_minor),
            discount_total: money(discount_total_minor),
            tax_total: money(self.tax_total_minor),
            total: money(self.gross_total_minor),
            balance_due: money(self.gross_total_minor),
            tax_breakdown,
            processed_items: self
                .lines
                .iter()
                .map(|line| CalculatedLine {
                    line_total: money(line.net_minor),
                    line_total_with_tax: money(line.gross_minor),
                    tax_amount: money(line.tax_minor),
                    tax_rate_id: None,
                    tax_rate: Some(rate_text(line.rate_bps)),
                    tax_code: self.reverse_charge_category.map(str::to_owned),
                })
                .collect(),
            sales_tax: None,
            tax_warnings: self
                .vies_unavailable
                .then(|| vec!["VIES could not be reached; charged as for a consumer".to_owned()]),
        }
    }
}

/// A money amount as the breakdown rows hold it: a JSON number of two decimals.
fn amount_number(minor: i64) -> Value {
    money(minor)
        .parse::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}
