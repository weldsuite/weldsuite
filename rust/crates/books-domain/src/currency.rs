//! Exchange rates (`books-api/src/services/accounting-currency.ts`): the
//! ECB's daily reference rates, kept an hour, persisted into `fx_rates` so a
//! conversion at a transaction date can be reproduced later, and the lookups
//! of stored rates.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::http::now_ms;
use crate::js::math_round;

const ECB_DAILY_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_HISTORY_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const CACHE_TTL_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

/// Rates by currency code, in the order the feed lists them (a JavaScript
/// object's key order).
pub type Rates = Vec<(String, f64)>;

/// The worker's module-level `rateCache`: the live rates, kept an hour. One
/// cache per scope: the server's own is `""`; conformance gives every test
/// file its own, as each runs in its own worker process.
#[derive(Debug, Default)]
pub struct RateCache {
    entries: Mutex<HashMap<String, (Rates, i64)>>,
}

impl RateCache {
    fn get(&self, scope: &str) -> Option<Rates> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries
            .get(scope)
            .filter(|(_, fetched_at)| now_ms() - fetched_at < CACHE_TTL_MS)
            .map(|(rates, _)| rates.clone())
    }

    fn put(&self, scope: &str, rates: Rates) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(scope.to_owned(), (rates, now_ms()));
    }
}

/// `rates[code]`.
pub fn rate_of(rates: &Rates, code: &str) -> Option<f64> {
    rates.iter().find(|(c, _)| c == code).map(|(_, r)| *r)
}

/// The rates as a JSON object.
pub fn rates_json(rates: &Rates) -> Value {
    let mut out = serde_json::Map::new();
    for (code, rate) in rates {
        out.insert(code.clone(), crate::js::number_value(*rate));
    }
    Value::Object(out)
}

/// `parseEcbXml(xml)`: every `<Cube currency='XXX' rate='1.23'/>`.
fn parse_ecb_xml(xml: &str) -> Rates {
    let mut rates: Rates = Vec::new();
    let mut rest = xml;
    let marker = "<Cube currency='";
    while let Some(start) = rest.find(marker) {
        rest = &rest[start + marker.len()..];
        let code: String = rest.chars().take(3).collect();
        let after_code = &rest[code.len()..];
        if code.len() != 3
            || !code.bytes().all(|b| b.is_ascii_uppercase())
            || !after_code.starts_with("' rate='")
        {
            continue;
        }
        let value_start = &after_code["' rate='".len()..];
        let digits: String = value_start
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let tail = &value_start[digits.len()..];
        if digits.is_empty() || !tail.starts_with("'/>") {
            continue;
        }
        let rate = parse_float(&digits);
        match rates.iter_mut().find(|(c, _)| *c == code) {
            Some(entry) => entry.1 = rate,
            None => rates.push((code, rate)),
        }
    }
    rates
}

/// `Number.parseFloat` of a string of digits and dots: the longest prefix
/// that is a decimal number.
fn parse_float(text: &str) -> f64 {
    let mut seen_dot = false;
    let prefix: String = text
        .chars()
        .take_while(|c| {
            if *c == '.' {
                if seen_dot {
                    return false;
                }
                seen_dot = true;
            }
            true
        })
        .collect();
    prefix.parse::<f64>().unwrap_or(f64::NAN)
}

fn fallback_rates() -> Rates {
    [
        ("EUR", 1.0),
        ("USD", 1.08),
        ("GBP", 0.86),
        ("CHF", 0.96),
        ("JPY", 162.5),
        ("CAD", 1.47),
        ("AUD", 1.66),
        ("SEK", 11.2),
        ("NOK", 11.5),
        ("DKK", 7.46),
        ("PLN", 4.31),
        ("CZK", 25.2),
        ("HUF", 395.0),
        ("TRY", 35.0),
        ("CNY", 7.85),
        ("INR", 90.0),
        ("BRL", 6.3),
    ]
    .into_iter()
    .map(|(code, rate)| (code.to_owned(), rate))
    .collect()
}

/// `fetch(url)` and the body as text, when the answer is a 2xx.
async fn fetch_text(http: Option<&OutboundHttp>, url: &str) -> Result<Option<String>, ()> {
    let Some(http) = http else {
        return Err(());
    };
    match http.send(HttpRequest::empty("GET", url)).await {
        Ok(response) if response.ok() => Ok(Some(response.text())),
        Ok(_) => Ok(None),
        Err(_) => Err(()),
    }
}

/// `getExchangeRates()`: the ECB's latest rates against EUR (with `EUR: 1`),
/// cached an hour; the fallback table when the feed fails.
pub async fn get_exchange_rates(
    cache: &RateCache,
    scope: &str,
    http: Option<&OutboundHttp>,
) -> Rates {
    if let Some(rates) = cache.get(scope) {
        return rates;
    }
    match fetch_text(http, ECB_DAILY_URL).await {
        Ok(Some(xml)) => {
            let mut rates = parse_ecb_xml(&xml);
            match rates.iter_mut().find(|(c, _)| c == "EUR") {
                Some(entry) => entry.1 = 1.0,
                None => rates.push(("EUR".to_owned(), 1.0)),
            }
            cache.put(scope, rates.clone());
            rates
        }
        Ok(None) => {
            tracing::warn!("[Currency] ECB API error, using fallback rates");
            fallback_rates()
        }
        Err(()) => {
            tracing::error!("[Currency] Failed to fetch ECB rates");
            fallback_rates()
        }
    }
}

/// `persistDailyEcbRates(db, date)`: today's ECB rates into `fx_rates`
/// (the unique index deduplicates). The number of rates.
pub async fn persist_daily_ecb_rates(
    db: &PgPool,
    cache: &RateCache,
    scope: &str,
    http: Option<&OutboundHttp>,
    iso_date: &str,
) -> Result<usize, sqlx::Error> {
    let rates = get_exchange_rates(cache, scope, http).await;
    store_ecb_rates(db, iso_date, &rates).await
}

async fn store_ecb_rates(db: &PgPool, iso_date: &str, rates: &Rates) -> Result<usize, sqlx::Error> {
    let rows: Vec<&(String, f64)> = rates.iter().filter(|(code, _)| code != "EUR").collect();
    if rows.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = rows.iter().map(|_| generate_id("fxr")).collect();
    let codes: Vec<String> = rows.iter().map(|(code, _)| code.clone()).collect();
    let values: Vec<String> = rows
        .iter()
        .map(|(_, rate)| crate::js::number_text(*rate))
        .collect();
    sqlx::query(
        "insert into fx_rates (id, date, from_currency, to_currency, rate, source) \
         select id, $2::date, 'EUR', code, rate::numeric, 'ecb' \
         from unnest($1::varchar[], $3::varchar[], $4::text[]) as r(id, code, rate) \
         on conflict do nothing",
    )
    .bind(&ids)
    .bind(iso_date)
    .bind(&codes)
    .bind(&values)
    .execute(db)
    .await?;
    Ok(rows.len())
}

/// The latest stored EUR→`counter` rate on or before `iso_date`.
async fn latest_eur(
    db: &PgPool,
    counter: &str,
    iso_date: &str,
) -> Result<Option<f64>, sqlx::Error> {
    let rate: Option<String> = sqlx::query_scalar(
        "select rate::text from fx_rates where from_currency = 'EUR' and to_currency = $1 \
         and date <= $2::date order by date desc limit 1",
    )
    .bind(counter)
    .bind(iso_date)
    .fetch_optional(db)
    .await?;
    Ok(rate.map(|r| weldsuite_kit::validation::js_number(&r)))
}

/// `lookupHistoricalRate`: a stored rate crossed over EUR.
async fn lookup_historical_rate(
    db: &PgPool,
    from: &str,
    to: &str,
    iso_date: &str,
) -> Result<Option<f64>, sqlx::Error> {
    if from == "EUR" {
        return latest_eur(db, to, iso_date).await;
    }
    if to == "EUR" {
        return Ok(latest_eur(db, from, iso_date).await?.map(|rate| 1.0 / rate));
    }
    let (from_rate, to_rate) = (
        latest_eur(db, from, iso_date).await?,
        latest_eur(db, to, iso_date).await?,
    );
    Ok(match (from_rate, to_rate) {
        (Some(from_rate), Some(to_rate)) => Some(to_rate / from_rate),
        _ => None,
    })
}

/// Why [`get_exchange_rate`] has no rate: `Exchange rate not available for
/// FROM/TO`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateUnavailable(pub String);

/// `getExchangeRate(from, to, { db, atDate })`: units of `to` per `from`.
/// A stored rate on or before `at` (when given), else the live feed.
pub async fn get_exchange_rate(
    cache: &RateCache,
    scope: &str,
    http: Option<&OutboundHttp>,
    from: &str,
    to: &str,
    stored: Option<(&PgPool, &str)>,
) -> Result<Result<f64, RateUnavailable>, sqlx::Error> {
    if from == to {
        return Ok(Ok(1.0));
    }
    let from_code = from.to_uppercase();
    let to_code = to.to_uppercase();
    if let Some((db, iso_date)) = stored
        && let Some(rate) = lookup_historical_rate(db, &from_code, &to_code, iso_date).await?
    {
        return Ok(Ok(rate));
    }
    let rates = get_exchange_rates(cache, scope, http).await;
    match (rate_of(&rates, &from_code), rate_of(&rates, &to_code)) {
        (Some(from_rate), Some(to_rate))
            if from_rate != 0.0 && to_rate != 0.0 && !from_rate.is_nan() && !to_rate.is_nan() =>
        {
            Ok(Ok(to_rate / from_rate))
        }
        _ => Ok(Err(RateUnavailable(format!(
            "Exchange rate not available for {from}/{to}"
        )))),
    }
}

/// `lookupStoredRate(db, from, to, atDate)`: the latest stored rate on or
/// before the date, as units of `to` per `from`: the pair, its inverse, then
/// crossed over EUR. Never the live feed.
pub async fn lookup_stored_rate(
    db: &PgPool,
    from: &str,
    to: &str,
    iso_date: &str,
) -> Result<Option<f64>, sqlx::Error> {
    let from_code = from.to_uppercase();
    let to_code = to.to_uppercase();
    if from_code == to_code {
        return Ok(Some(1.0));
    }
    let latest = |a: String, b: String| async move {
        let row: Option<(String, String)> = sqlx::query_as(
            "select date::text, rate::text from fx_rates where from_currency = $1 and to_currency = $2 \
             and date <= $3::date order by date desc limit 1",
        )
        .bind(&a)
        .bind(&b)
        .bind(iso_date)
        .fetch_optional(db)
        .await?;
        Ok::<_, sqlx::Error>(row.and_then(|(date, rate)| {
            let rate = weldsuite_kit::validation::js_number(&rate);
            (rate.is_finite() && rate > 0.0).then_some((date, rate))
        }))
    };
    let direct = latest(from_code.clone(), to_code.clone()).await?;
    let inverse = latest(to_code.clone(), from_code.clone()).await?;
    if let Some((date, rate)) = &direct
        && inverse
            .as_ref()
            .is_none_or(|(inverse_date, _)| date >= inverse_date)
    {
        return Ok(Some(*rate));
    }
    if let Some((_, rate)) = inverse {
        return Ok(Some(1.0 / rate));
    }
    let crossed = lookup_historical_rate(db, &from_code, &to_code, iso_date).await?;
    Ok(crossed.filter(|rate| rate.is_finite() && *rate > 0.0))
}

/// `fetchEcbRatesOn(atDate)`: one day of ECB rates, the latest on or before
/// the date, from the daily file (up to 4 days back) or the 90-day history.
async fn fetch_ecb_rates_on(
    http: Option<&OutboundHttp>,
    at_millis: i64,
) -> Option<(String, Rates)> {
    let iso_date = crate::js::iso_from_millis(at_millis)?.get(..10)?.to_owned();
    let days_ago = (now_ms() - at_millis).div_euclid(DAY_MS);
    if days_ago > 90 {
        return None;
    }
    let url = if days_ago <= 4 {
        ECB_DAILY_URL
    } else {
        ECB_HISTORY_URL
    };
    let xml = fetch_text(http, url).await.ok().flatten()?;
    let mut days: Vec<(String, Rates)> = Vec::new();
    let mut rest = xml.as_str();
    while let Some(start) = rest.find("<Cube time=") {
        rest = &rest[start + "<Cube time=".len()..];
        let quote = rest.chars().next()?;
        if quote != '\'' && quote != '"' {
            continue;
        }
        let date: String = rest[1..].chars().take(10).collect();
        let after = &rest[1 + date.len()..];
        if !after.starts_with('\'') && !after.starts_with('"') {
            continue;
        }
        let after = &after[1..];
        let Some(body) = after.strip_prefix('>') else {
            continue;
        };
        let Some(end) = body.find("</Cube>") else {
            break;
        };
        let rates = parse_ecb_xml(&body[..end]);
        rest = &body[end..];
        let shaped = date.len() == 10
            && date.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            });
        if shaped && date.as_str() <= iso_date.as_str() && !rates.is_empty() {
            days.push((date, rates));
        }
    }
    days.sort_by(|a, b| b.0.cmp(&a.0));
    let (date, mut rates) = days.into_iter().next()?;
    match rates.iter_mut().find(|(c, _)| c == "EUR") {
        Some(entry) => entry.1 = 1.0,
        None => rates.push(("EUR".to_owned(), 1.0)),
    }
    Some((date, rates))
}

/// `fetchFeedRate(db, from, to, atDate)`: the ECB reference rate of a pair
/// on a date, stored in `fx_rates` so the booking can be reproduced. `None`
/// when the feed can't say.
pub async fn fetch_feed_rate(
    db: Option<&PgPool>,
    http: Option<&OutboundHttp>,
    from: &str,
    to: &str,
    at_millis: i64,
) -> Option<f64> {
    let (date, rates) = fetch_ecb_rates_on(http, at_millis).await?;
    let from_rate = rate_of(&rates, &from.to_uppercase()).filter(|r| *r != 0.0)?;
    let to_rate = rate_of(&rates, &to.to_uppercase()).filter(|r| *r != 0.0)?;
    if let Some(db) = db
        && let Err(error) = store_ecb_rates(db, &date, &rates).await
    {
        tracing::warn!(%error, "[Currency] could not store ECB rates");
    }
    Some(to_rate / from_rate)
}

/// `toBaseCurrency(amount, exchangeRate)`.
#[allow(clippy::float_cmp)]
pub fn to_base_currency(amount: f64, exchange_rate: f64) -> f64 {
    if exchange_rate == 0.0 || exchange_rate == 1.0 {
        return amount;
    }
    math_round((amount / exchange_rate) * 100.0) / 100.0
}

/// `calculateFxGainLoss(foreign, paymentRate, invoiceRate)`: positive is a gain.
pub fn calculate_fx_gain_loss(foreign: f64, payment_rate: f64, invoice_rate: f64) -> f64 {
    let payment_base = to_base_currency(foreign, payment_rate);
    let expected_base = to_base_currency(foreign, invoice_rate);
    math_round((payment_base - expected_base) * 100.0) / 100.0
}

const SUPPORTED_CURRENCIES: [(&str, &str, &str); 15] = [
    ("EUR", "Euro", "€"),
    ("USD", "US Dollar", "$"),
    ("GBP", "British Pound", "£"),
    ("CHF", "Swiss Franc", "CHF"),
    ("SEK", "Swedish Krona", "kr"),
    ("NOK", "Norwegian Krone", "kr"),
    ("DKK", "Danish Krone", "kr"),
    ("PLN", "Polish Zloty", "zł"),
    ("CZK", "Czech Koruna", "Kč"),
    ("CAD", "Canadian Dollar", "CA$"),
    ("AUD", "Australian Dollar", "A$"),
    ("JPY", "Japanese Yen", "¥"),
    ("CNY", "Chinese Yuan", "¥"),
    ("INR", "INR", "₹"),
    ("BRL", "Brazilian Real", "R$"),
];

/// `getSupportedCurrencies(locale)`: the currency list, INR and BRL named
/// in the locale's language.
pub fn supported_currencies(locale: &str) -> Value {
    let lang: String = locale.chars().take(2).collect::<String>().to_lowercase();
    let inr = match lang.as_str() {
        "nl" => "Indiase Roepie",
        _ => "Indian Rupee",
    };
    let brl = match lang.as_str() {
        "nl" => "Braziliaanse real",
        "pt" => "Real brasileiro",
        _ => "Brazilian Real",
    };
    Value::Array(
        SUPPORTED_CURRENCIES
            .iter()
            .map(|(code, name, symbol)| {
                let name = match *code {
                    "INR" => inr,
                    "BRL" => brl,
                    _ => name,
                };
                json!({ "code": code, "name": name, "symbol": symbol })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ecb_cubes() {
        let xml = "<Cube><Cube time='2026-10-30'><Cube currency='USD' rate='1.0815'/><Cube currency='JPY' rate='162.5'/></Cube></Cube>";
        assert_eq!(
            parse_ecb_xml(xml),
            vec![("USD".to_owned(), 1.0815), ("JPY".to_owned(), 162.5)]
        );
    }

    #[test]
    fn base_amounts_round_to_cents() {
        assert!((to_base_currency(100.0, 1.08) - 92.59).abs() < 1e-9);
        assert!((to_base_currency(100.0, 1.0) - 100.0).abs() < 1e-9);
    }
}
