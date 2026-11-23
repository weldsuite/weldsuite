//! The EU VAT rate table (`data/eu_vat_rates.json`): the rate of each
//! member state per [`VatCategory`], with the date each rate took effect.
//!
//! One table serves WeldBooks documents, WeldCommerce orders and carts, and
//! WeldSuite's own plan billing (`core-billing`'s `vat::decide`). A rate
//! change is a new version in the JSON with its effective date; the file
//! records where the rates were checked and on which day.
//!
//! The table starts on 2024-01-01: a date before that is an error, never a
//! guess. A date after the newest version of a country uses that version.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

/// How a product is taxed. Stored as `products.vat_category` (and the
/// variant's, which inherits the product's when null).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VatCategory {
    /// The standard rate.
    Standard,
    /// The country's upper reduced rate; its standard rate where it has none.
    Reduced,
    /// The lowest reduced rate that applies broadly to goods (basic food,
    /// books); the reduced rate where the country has one reduced rate only.
    SuperReduced,
    /// 0%, asserted by the merchant.
    Zero,
    /// 0%, an exempt supply asserted by the merchant.
    Exempt,
}

impl VatCategory {
    pub const ALL: [Self; 5] = [
        Self::Standard,
        Self::Reduced,
        Self::SuperReduced,
        Self::Zero,
        Self::Exempt,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Reduced => "reduced",
            Self::SuperReduced => "super_reduced",
            Self::Zero => "zero",
            Self::Exempt => "exempt",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }
}

/// Why a rate could not be given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RateError {
    /// Not an EU member state.
    NotEuCountry(String),
    /// A destination whose VAT treatment is not modelled: `XI` (Northern
    /// Ireland follows EU VAT rules for goods, UK rules otherwise). The
    /// caller refuses the sale instead of zero-rating it.
    UnsupportedDestination(String),
    /// Not `YYYY-MM-DD`.
    InvalidDate(String),
    /// The table has no rate for the country on that date (before it starts).
    NoRateOnDate { country: String, date: String },
    /// `data/eu_vat_rates.json` does not parse (a build defect).
    TableCorrupt(String),
}

impl std::fmt::Display for RateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEuCountry(country) => write!(f, "{country} is not an EU member state"),
            Self::UnsupportedDestination(country) => {
                write!(f, "VAT to {country} is not supported")
            }
            Self::InvalidDate(date) => write!(f, "{date} is not a YYYY-MM-DD date"),
            Self::NoRateOnDate { country, date } => {
                write!(f, "no VAT rate for {country} on {date}")
            }
            Self::TableCorrupt(why) => write!(f, "the EU VAT rate table is unreadable: {why}"),
        }
    }
}

impl std::error::Error for RateError {}

#[derive(Debug, Deserialize)]
struct Version {
    from: String,
    standard: u32,
    reduced: u32,
    super_reduced: u32,
}

#[derive(Debug, Deserialize)]
struct Table {
    source: String,
    checked_on: String,
    countries: BTreeMap<String, Vec<Version>>,
}

static TABLE: LazyLock<Result<Table, String>> = LazyLock::new(|| {
    let mut table: Table = serde_json::from_str(include_str!("../../../data/eu_vat_rates.json"))
        .map_err(|e| e.to_string())?;
    for versions in table.countries.values_mut() {
        versions.sort_by(|a, b| a.from.cmp(&b.from));
    }
    Ok(table)
});

fn table() -> Result<&'static Table, RateError> {
    TABLE
        .as_ref()
        .map_err(|why| RateError::TableCorrupt(why.clone()))
}

/// The ISO code of a country given as a VAT prefix (`EL` is Greece).
fn normalize(country: &str) -> String {
    let upper = country.trim().to_ascii_uppercase();
    if upper == "EL" {
        "GR".to_owned()
    } else {
        upper
    }
}

/// The country whose VAT rules apply to a buyer in `country`: Monaco is
/// French VAT territory, so `MC` is `FR`; Greece's `EL` is `GR`.
pub fn territory(country: &str) -> String {
    let iso = normalize(country);
    if iso == "MC" { "FR".to_owned() } else { iso }
}

/// Whether `country` (ISO 3166-1 alpha-2, or Greece's `EL`) is an EU member state.
pub fn is_eu_member(country: &str) -> bool {
    table().is_ok_and(|t| t.countries.contains_key(&normalize(country)))
}

/// The 27 member states, ISO codes, in alphabetical order.
pub fn member_states() -> Vec<&'static str> {
    table().map_or_else(
        |_| Vec::new(),
        |t| t.countries.keys().map(String::as_str).collect(),
    )
}

/// The VAT number prefix of a member state (Greece writes `EL`).
pub fn vat_prefix(country: &str) -> String {
    let iso = normalize(country);
    if iso == "GR" { "EL".to_owned() } else { iso }
}

/// Where the rates come from and the day they were checked.
pub fn source() -> (&'static str, &'static str) {
    table().map_or(("", ""), |t| (t.source.as_str(), t.checked_on.as_str()))
}

fn is_iso_date(value: &str) -> bool {
    crate::dates::is_iso_date(value)
}

fn pick(version: &Version, category: VatCategory) -> u32 {
    match category {
        VatCategory::Standard => version.standard,
        VatCategory::Reduced => version.reduced,
        VatCategory::SuperReduced => version.super_reduced,
        VatCategory::Zero | VatCategory::Exempt => 0,
    }
}

/// The rate in basis points (2100 is 21%) of `category` in `country` on
/// `date` (`YYYY-MM-DD`).
pub fn rate_bps(country: &str, category: VatCategory, date: &str) -> Result<u32, RateError> {
    if !is_iso_date(date) {
        return Err(RateError::InvalidDate(date.to_owned()));
    }
    let iso = normalize(country);
    let versions = table()?
        .countries
        .get(&iso)
        .ok_or_else(|| RateError::NotEuCountry(country.to_owned()))?;
    versions
        .iter()
        .rev()
        .find(|v| v.from.as_str() <= date)
        .map(|v| pick(v, category))
        .ok_or(RateError::NoRateOnDate {
            country: iso,
            date: date.to_owned(),
        })
}

/// The standard rate of `country` on `date`.
pub fn standard_rate_bps(country: &str, date: &str) -> Result<u32, RateError> {
    rate_bps(country, VatCategory::Standard, date)
}

/// The newest rate of `category` in `country`, whatever the date.
pub fn latest_rate_bps(country: &str, category: VatCategory) -> Result<u32, RateError> {
    let iso = normalize(country);
    table()?
        .countries
        .get(&iso)
        .and_then(|versions| versions.last())
        .map(|v| pick(v, category))
        .ok_or_else(|| RateError::NotEuCountry(country.to_owned()))
}

/// Today (UTC) as `YYYY-MM-DD`.
pub fn today() -> String {
    crate::http::now().chars().take(10).collect()
}
