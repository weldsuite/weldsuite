//! The exchange rate a foreign-currency document is booked at
//! (`books-api/src/services/accounting-fx.ts`): foreign units per base unit,
//! from the rate typed on the document, a stored `fx_rates` row on or before
//! the date, or the ECB feed (stored too). None: the posting is refused.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_ports::OutboundHttp;

use crate::currency::{fetch_feed_rate, lookup_stored_rate};
use crate::js::to_fixed;
use crate::posting::PostError;

/// Where a rate came from (`RateSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateSource {
    SameCurrency,
    Override,
    Stored,
    Feed,
}

/// `ResolvedRate`: the rate as stored (6 decimals) and its source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRate {
    pub rate: String,
    pub source: RateSource,
}

/// `MissingExchangeRateError`'s message.
pub fn missing_rate_message(currency: &str, base_currency: &str, iso_date: &str) -> String {
    format!(
        "No exchange rate found for {currency} against {base_currency} on {}. Add the rate under FX rates, or enter an exchange rate on the document, and try again.",
        iso_date.get(..10).unwrap_or(iso_date)
    )
}

/// `parseRate(value)`: a finite number above zero, else `None`. Strings
/// are read with `Number.parseFloat`.
pub fn parse_rate(value: &Value) -> Option<f64> {
    let n = match value {
        Value::Null => return None,
        Value::String(text) if text.is_empty() => return None,
        Value::String(text) => crate::js::parse_float(text),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    (n.is_finite() && n > 0.0).then_some(n)
}

/// `formatRate(rate)`: the column format (`numeric(12,6)`).
pub fn format_rate(rate: f64) -> String {
    to_fixed(rate, 6)
}

/// `isForeignCurrency(base, currency)`.
pub fn is_foreign_currency(base_currency: &str, currency: Option<&str>) -> bool {
    currency.is_some_and(|c| !c.is_empty() && c.to_uppercase() != base_currency.to_uppercase())
}

/// The arguments of [`resolve_rate`].
#[derive(Debug, Clone, Copy)]
pub struct RateQuery<'a> {
    pub base_currency: &'a str,
    pub currency: &'a str,
    /// The document date as milliseconds since the epoch.
    pub at_millis: i64,
    /// A rate the user typed (`override`).
    pub typed: Option<&'a Value>,
    /// Ask the ECB feed when nothing is stored (default true).
    pub use_feed: bool,
}

/// `resolveRate(db, args)`: the rate for `currency` against the entity's base
/// on the date, or `None`. A typed rate wins.
pub async fn resolve_rate(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    query: RateQuery<'_>,
) -> Result<Option<ResolvedRate>, sqlx::Error> {
    if !is_foreign_currency(query.base_currency, Some(query.currency)) {
        return Ok(Some(ResolvedRate {
            rate: "1.000000".to_owned(),
            source: RateSource::SameCurrency,
        }));
    }
    if let Some(typed) = query.typed.and_then(parse_rate) {
        return Ok(Some(ResolvedRate {
            rate: format_rate(typed),
            source: RateSource::Override,
        }));
    }
    let iso_date = crate::js::iso_from_millis(query.at_millis)
        .and_then(|iso| iso.get(..10).map(str::to_owned))
        .unwrap_or_default();
    if let Some(stored) =
        lookup_stored_rate(db, query.base_currency, query.currency, &iso_date).await?
        && stored != 0.0
    {
        return Ok(Some(ResolvedRate {
            rate: format_rate(stored),
            source: RateSource::Stored,
        }));
    }
    if query.use_feed
        && let Some(fed) = fetch_feed_rate(
            Some(db),
            http,
            query.base_currency,
            query.currency,
            query.at_millis,
        )
        .await
        && fed != 0.0
        && !fed.is_nan()
    {
        return Ok(Some(ResolvedRate {
            rate: format_rate(fed),
            source: RateSource::Feed,
        }));
    }
    Ok(None)
}

/// `draftRate(db, args)`: 1 for a base-currency document, the typed or
/// looked-up rate for a foreign one, `None` when there is none yet.
pub async fn draft_rate(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    query: RateQuery<'_>,
) -> Result<Option<String>, sqlx::Error> {
    Ok(resolve_rate(db, http, query).await?.map(|r| r.rate))
}

/// `requireBookingRate(db, args)`: the rate a document posts at. A stored
/// real rate stays; a missing or default 1 on a foreign document is looked up
/// now; none is a [`PostError::Posting`] (`MissingExchangeRateError`).
pub async fn require_booking_rate(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    base_currency: &str,
    currency: Option<&str>,
    at_millis: i64,
    stored: Option<&Value>,
) -> Result<String, PostError> {
    let Some(currency) = currency.filter(|c| !c.is_empty()) else {
        return Ok("1.000000".to_owned());
    };
    if !is_foreign_currency(base_currency, Some(currency)) {
        return Ok("1.000000".to_owned());
    }
    #[allow(clippy::float_cmp)]
    if let Some(stored) = stored.and_then(parse_rate)
        && stored != 1.0
    {
        return Ok(format_rate(stored));
    }
    let resolved = resolve_rate(
        db,
        http,
        RateQuery {
            base_currency,
            currency,
            at_millis,
            typed: None,
            use_feed: true,
        },
    )
    .await?;
    match resolved {
        Some(resolved) => Ok(resolved.rate),
        None => {
            let iso = crate::js::iso_from_millis(at_millis).unwrap_or_default();
            Err(PostError::Posting(missing_rate_message(
                currency,
                base_currency,
                &iso,
            )))
        }
    }
}

/// `baseCurrencyOf(entity)`: EUR when somehow unset.
pub fn base_currency_of(base_currency: Option<&str>) -> String {
    base_currency
        .filter(|c| !c.is_empty())
        .unwrap_or("EUR")
        .to_owned()
}
