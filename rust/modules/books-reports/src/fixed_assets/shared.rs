//! Shared pieces of the fixed-asset services (`services/fixed-assets/shared.ts`):
//! the error the routes map to statuses, money in cents, the fiscal-year axis
//! depreciation runs on, and the conversions from rows to the depreciation
//! domain's inputs. Rows are `Value`s as Drizzle returns them.

use std::collections::HashMap;

use axum::response::Response;
use serde_json::Value;
use weldsuite_books_domain::depreciation::{DepreciationAsset, DepreciationBook, FiscalPeriod};
use weldsuite_books_domain::fiscal_year::{FiscalYearConfig, fiscal_year_for, fiscal_year_range};
use weldsuite_books_domain::guards::GuardError;
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::js::{math_round, to_fixed};
use weldsuite_books_domain::posting::PostError;
use weldsuite_kit::ApiError;

/// `FixedAssetError` (by kind), a ledger error (`isLedgerError`: posting,
/// closed or locked period) or a failure.
#[derive(Debug)]
pub(crate) enum Fail {
    BadRequest(String),
    /// The message ends in ` not found`; the route answers `error.notFound`
    /// with what comes before it.
    NotFound(String),
    Conflict(String),
    Ledger(String),
    Database(sqlx::Error),
    Internal(String),
}

pub(crate) fn bad(message: impl Into<String>) -> Fail {
    Fail::BadRequest(message.into())
}

pub(crate) fn conflict(message: impl Into<String>) -> Fail {
    Fail::Conflict(message.into())
}

pub(crate) fn not_found(message: impl Into<String>) -> Fail {
    Fail::NotFound(message.into())
}

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PostError> for Fail {
    fn from(error: PostError) -> Self {
        match error {
            PostError::Database(error) => Self::Database(error),
            other => Self::Ledger(other.to_string()),
        }
    }
}

impl From<GuardError> for Fail {
    fn from(error: GuardError) -> Self {
        match error {
            GuardError::Database(error) => Self::Database(error),
            other => Self::Ledger(other.to_string()),
        }
    }
}

impl From<Refusal> for Fail {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Database(error) => Self::Database(error),
            Refusal::Internal(error) => Self::Internal(error),
            Refusal::Response(_) => Self::Internal("unexpected response".to_owned()),
        }
    }
}

impl Fail {
    /// The route's `fail(c, err, what)`.
    pub(crate) fn respond(self, what: &str) -> Response {
        use axum::response::IntoResponse;
        let fallback = format!("Failed to {what}");
        match self {
            Self::BadRequest(message) | Self::Ledger(message) => {
                ApiError::bad_request(message).into_response()
            }
            Self::NotFound(message) => {
                let resource = message.strip_suffix(" not found").unwrap_or(&message);
                ApiError::not_found(resource, None).into_response()
            }
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Database(error) => Refusal::Database(error).respond(&fallback),
            Self::Internal(error) => Refusal::Internal(error).respond(&fallback),
        }
    }
}

// ---------------------------------------------------------------------------
// Money and rows

/// `toCents(value)`.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn to_cents(value: f64) -> i64 {
    math_round(value * 100.0 + if value >= 0.0 { 1e-9 } else { -1e-9 }) as i64
}

/// `fromCents(cents)`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn from_cents(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// `money(cents)`: `(cents / 100).toFixed(2)`.
pub(crate) fn money(cents: i64) -> String {
    to_fixed(from_cents(cents), 2)
}

/// `asNumber(value, fallback)`: null, absent and `''` are the fallback, as
/// is anything that isn't a finite number.
pub(crate) fn as_number(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        Some(value) => {
            let parsed = weldsuite_books_domain::js::js_number_value(Some(value));
            if parsed.is_finite() { parsed } else { fallback }
        }
    }
}

/// A row's number column (`asNumber(row[key])`).
pub(crate) fn num(row: &Value, key: &str) -> f64 {
    as_number(row.get(key), 0.0)
}

/// A row's text column, `''` when null.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A row's nullable text column.
pub(crate) fn opt<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A nullable text column with `''` as null too (`if (row.x)`).
pub(crate) fn present<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    opt(row, key).filter(|value| !value.is_empty())
}

/// `isoDay(value)`: the day of a `Date` (or of a date string).
pub(crate) fn iso_day(value: &str) -> String {
    value.chars().take(10).collect()
}

// ---------------------------------------------------------------------------
// Fiscal axis

/// `fiscalYearLabel(config, year)`: `2026` for a calendar year, `FY2026` for
/// any other fiscal year.
#[allow(clippy::float_cmp)] // `startMonth === 1`
pub(crate) fn fiscal_year_label(config: &FiscalYearConfig, year: i64) -> String {
    match config {
        FiscalYearConfig::Month { start_month } if *start_month == 1.0 => year.to_string(),
        _ => format!("FY{year}"),
    }
}

/// `fiscalYearPeriods(config, firstYear, count)`.
pub(crate) fn fiscal_year_periods(
    config: &FiscalYearConfig,
    first_year: i64,
    count: i64,
) -> Vec<FiscalPeriod> {
    (0..count.max(0))
        .filter_map(|index| {
            let year = fiscal_year_for(config, first_year + index)?;
            Some(FiscalPeriod {
                label: fiscal_year_label(config, year.year),
                start: year.start,
                end: year.end,
            })
        })
        .collect()
}

/// `fiscalYearPeriodsFrom(config, date, count)`.
pub(crate) fn fiscal_year_periods_from(
    config: &FiscalYearConfig,
    date: &str,
    count: i64,
) -> Vec<FiscalPeriod> {
    fiscal_year_range(config, date).map_or_else(Vec::new, |year| {
        fiscal_year_periods(config, year.year, count)
    })
}

/// `yearsNeeded(recoveryYears)`.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn years_needed(recovery_years: f64) -> i64 {
    (if recovery_years > 0.0 {
        recovery_years
    } else {
        1.0
    })
    .ceil() as i64
        + 3
}

// ---------------------------------------------------------------------------
// Domain conversions

pub(crate) fn is_macrs_method(method: &str) -> bool {
    method == "macrs_gds" || method == "macrs_ads"
}

/// `isMacrsBook(book)`.
pub(crate) fn is_macrs_book(book: &Value) -> bool {
    is_macrs_method(text(book, "method"))
}

#[allow(clippy::float_cmp)] // the classes are exact
fn real_property_years(years: f64) -> bool {
    [27.5, 30.0, 31.5, 39.0, 40.0].contains(&years)
}

/// `isRealPropertyBook(book)`.
pub(crate) fn is_real_property_book(book: &Value) -> bool {
    is_macrs_book(book) && real_property_years(num(book, "recoveryYears"))
}

/// `toDepreciationAsset(asset, { disposalDate }, book)`: the ledger book
/// carries the whole cost; the tax books only the business share.
pub(crate) fn to_depreciation_asset(
    asset: &Value,
    disposal_override: Option<Option<&str>>,
    book: Option<&Value>,
) -> DepreciationAsset {
    let disposal = match disposal_override {
        Some(value) => value.map(str::to_owned),
        None => opt(asset, "disposalDate").map(str::to_owned),
    };
    DepreciationAsset {
        cost: num(asset, "cost"),
        salvage_value: Some(num(asset, "salvageValue")),
        business_use_percent: Some(if book.is_some_and(|b| text(b, "book") == "book") {
            100.0
        } else {
            as_number(asset.get("businessUsePercent"), 100.0)
        }),
        acquisition_date: text(asset, "acquisitionDate").to_owned(),
        placed_in_service_date: text(asset, "placedInServiceDate").to_owned(),
        disposal_date: disposal,
        listed_property: false,
    }
}

/// `defaultConvention(book)`.
pub(crate) fn default_convention(method: &str, recovery_years: f64) -> &'static str {
    if is_macrs_method(method) {
        if real_property_years(recovery_years) {
            "mid_month"
        } else {
            "half_year"
        }
    } else {
        "full_month"
    }
}

/// `toDepreciationBook(book, convention)`.
pub(crate) fn to_depreciation_book(book: &Value, convention: Option<&str>) -> DepreciationBook {
    DepreciationBook {
        method: text(book, "method").to_owned(),
        convention: convention
            .unwrap_or_else(|| text(book, "convention"))
            .to_owned(),
        recovery_years: num(book, "recoveryYears"),
        section_179_amount: Some(num(book, "section179Amount")),
        bonus_percent: Some(num(book, "bonusPercent")),
        ..DepreciationBook::default()
    }
}

/// The mid-quarter test's convention of each federal MACRS asset.
pub(crate) type Conventions = HashMap<String, &'static str>;

/// `effectiveConvention(book, assetId, conventions)`.
pub(crate) fn effective_convention(
    book: &Value,
    asset_id: &str,
    conventions: &Conventions,
) -> String {
    if !is_macrs_book(book) {
        return text(book, "convention").to_owned();
    }
    conventions
        .get(asset_id)
        .copied()
        .unwrap_or_else(|| default_convention(text(book, "method"), num(book, "recoveryYears")))
        .to_owned()
}

/// `MACRS_CLASSES`: the US property classes with tables.
pub(crate) const MACRS_CLASSES: [&str; 9] = ["3", "5", "7", "10", "15", "20", "25", "27.5", "39"];

/// `isMacrsClass(assetClass)`.
pub(crate) fn is_macrs_class(asset_class: Option<&str>) -> bool {
    asset_class.is_some_and(|class| MACRS_CLASSES.contains(&class))
}
