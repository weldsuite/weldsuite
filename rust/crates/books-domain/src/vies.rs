//! VIES, the EU's VAT Information Exchange System
//! (`@weldsuite/books-domain/vies`): whether a buyer's VAT number is
//! registered, which a 0% intra-community supply or a reverse-charge invoice
//! needs.
//!
//! Results are cached in `vies_checks` (tenant database): valid answers for
//! 30 days, invalid ones for a day. When VIES itself is down the result says
//! `available: false`, so callers warn and proceed. The call goes through
//! the outbound HTTP port ([`OutboundHttp`]); without one, VIES reads as
//! unavailable.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::http::{now, now_ms};
use crate::vendor_tax::iso_millis;

/// `VIES_API_URL`.
pub const VIES_API_URL: &str =
    "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

const VALID_TTL_MS: i64 = 30 * 24 * 3600 * 1000;
const INVALID_TTL_MS: i64 = 24 * 3600 * 1000;

/// `ViesResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViesResult {
    /// Whether VIES could be consulted (a cache hit counts).
    pub available: bool,
    pub valid: bool,
    pub vat_number: String,
    pub country_code: String,
    pub trader_name: Option<String>,
    pub trader_address: Option<String>,
    pub consultation_number: Option<String>,
    /// `toISOString()`.
    pub checked_at: String,
    pub from_cache: bool,
}

/// `normalizeVatNumber(raw)`: `{ countryCode, number, full }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedVat {
    pub country_code: String,
    pub number: String,
    pub full: String,
}

/// `normalizeVatNumber(raw)`: two letters and 2 to 15 characters, without
/// whitespace, dots and dashes, upper case.
pub fn normalize_vat_number(raw: &str) -> Option<NormalizedVat> {
    let full: String = raw
        .chars()
        .filter(|c| !(crate::jurisdictions::is_js_space(*c) || matches!(c, '.' | '-')))
        .collect::<String>()
        .to_uppercase();
    let b = full.as_bytes();
    let country_ok = b.len() >= 2 && b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase();
    let rest = b.get(2..).unwrap_or_default();
    let number_ok = (2..=15).contains(&rest.len())
        && rest
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, b'+' | b'*'));
    (country_ok && number_ok).then(|| NormalizedVat {
        country_code: full[..2].to_owned(),
        number: full[2..].to_owned(),
        full: full.clone(),
    })
}

/// `ViesVerdict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViesVerdict {
    Verdict { valid: bool },
    Unavailable { reason: String, retryable: bool },
}

fn retryable_code(code: &str) -> bool {
    matches!(code, "MS_MAX_CONCURRENT_REQ" | "GLOBAL_MAX_CONCURRENT_REQ")
}

/// A JavaScript truthy string (`if (body.userError)`).
fn truthy_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Null | Value::String(_) | Value::Bool(false) => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        other => Some(other.to_string()),
    }
}

/// `interpretViesBody(body)`: the REST endpoint reports member-state and
/// service failures as HTTP 200 (`errorWrappers`, `userError`,
/// `actionSucceed: false`), all with `valid: false`, which is no verdict.
pub fn interpret_vies_body(body: &Value) -> ViesVerdict {
    let Value::Object(fields) = body else {
        return ViesVerdict::Unavailable {
            reason: "empty response".to_owned(),
            retryable: false,
        };
    };
    let codes: Vec<String> = fields
        .get("errorWrappers")
        .and_then(Value::as_array)
        .map(|wrappers| {
            wrappers
                .iter()
                .filter_map(|wrapper| {
                    let pick = |key: &str| wrapper.get(key).filter(|v| !v.is_null());
                    let code = pick("error").or_else(|| pick("message")).map_or_else(
                        || "UNKNOWN".to_owned(),
                        |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned),
                    );
                    (!code.is_empty()).then_some(code)
                })
                .collect()
        })
        .unwrap_or_default();
    if !codes.is_empty() {
        if codes.iter().all(|code| code == "INVALID_INPUT") {
            return ViesVerdict::Verdict { valid: false };
        }
        return ViesVerdict::Unavailable {
            reason: codes.join(", "),
            retryable: codes.iter().any(|code| retryable_code(code)),
        };
    }
    if let Some(user_error) = truthy_text(fields.get("userError"))
        && user_error != "VALID"
        && user_error != "INVALID"
    {
        return ViesVerdict::Unavailable {
            retryable: retryable_code(&user_error),
            reason: user_error,
        };
    }
    if fields.get("actionSucceed") == Some(&Value::Bool(false)) {
        return ViesVerdict::Unavailable {
            reason: "actionSucceed=false".to_owned(),
            retryable: false,
        };
    }
    match fields.get("valid") {
        Some(Value::Bool(valid)) => ViesVerdict::Verdict { valid: *valid },
        _ => ViesVerdict::Unavailable {
            reason: "response has no validity flag".to_owned(),
            retryable: false,
        },
    }
}

/// `consultVies(normalized)`: the response body and its verdict, or why
/// VIES gave none (after one retry when it says it is throttling).
pub async fn consult_vies(
    http: Option<&OutboundHttp>,
    normalized: &NormalizedVat,
) -> Result<(Value, bool), String> {
    let Some(http) = http else {
        return Err("no outbound HTTP".to_owned());
    };
    let request_body = json!({
        "countryCode": normalized.country_code,
        "vatNumber": normalized.number,
    });
    for attempt in 0.. {
        let response = http
            .send(HttpRequest::json("POST", VIES_API_URL, &request_body))
            .await
            .map_err(|error| format!("{error:?}"))?;
        if !response.ok() {
            return Err(format!("VIES HTTP {}", response.status));
        }
        let body: Value = serde_json::from_slice(&response.body)
            .map_err(|_| "VIES returned an unreadable response".to_owned())?;
        match interpret_vies_body(&body) {
            ViesVerdict::Verdict { valid } => return Ok((body, valid)),
            ViesVerdict::Unavailable { retryable, .. } if retryable && attempt == 0 => {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            }
            ViesVerdict::Unavailable { reason, .. } => {
                return Err(format!("VIES unavailable: {reason}"));
            }
        }
    }
    Err("VIES unavailable".to_owned())
}

/// `value.slice(0, n)` in UTF-16 units.
fn js_prefix(value: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in value.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// One `vies_checks` row.
#[derive(Debug, sqlx::FromRow)]
struct Cached {
    valid: bool,
    country_code: String,
    trader_name: Option<String>,
    trader_address: Option<String>,
    consultation_number: Option<String>,
    checked_at: String,
}

fn from_cache(cached: &Cached, vat_number: &str) -> ViesResult {
    ViesResult {
        available: true,
        valid: cached.valid,
        vat_number: vat_number.to_owned(),
        country_code: cached.country_code.clone(),
        trader_name: cached.trader_name.clone(),
        trader_address: cached.trader_address.clone(),
        consultation_number: cached.consultation_number.clone(),
        checked_at: cached.checked_at.clone(),
        from_cache: true,
    }
}

/// `checkVatNumber(db, raw)`: an EU VAT number against VIES, through the
/// tenant's cache.
pub async fn check_vat_number(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    raw: &str,
) -> Result<ViesResult, sqlx::Error> {
    let checked_now = now();
    let Some(normalized) = normalize_vat_number(raw) else {
        return Ok(ViesResult {
            available: true,
            valid: false,
            vat_number: raw.to_owned(),
            country_code: String::new(),
            trader_name: None,
            trader_address: None,
            consultation_number: None,
            checked_at: checked_now,
            from_cache: false,
        });
    };

    let cached: Option<Cached> = sqlx::query_as(
        "select valid, country_code, trader_name, trader_address, consultation_number, \
         to_char(checked_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as checked_at \
         from vies_checks where vat_number = $1 limit 1",
    )
    .bind(&normalized.full)
    .fetch_optional(db)
    .await?;
    if let Some(cached) = &cached {
        let age = now_ms() - iso_millis(&cached.checked_at).unwrap_or(0);
        let ttl = if cached.valid {
            VALID_TTL_MS
        } else {
            INVALID_TTL_MS
        };
        if age < ttl {
            return Ok(from_cache(cached, &normalized.full));
        }
    }

    let (body, valid) = match consult_vies(http, &normalized).await {
        Ok(answer) => answer,
        Err(error) => {
            tracing::warn!(error, "[vies] lookup failed");
            // A stale positive answer beats nothing; a stale "invalid" does
            // not, and an outage is never cached.
            if let Some(cached) = cached.as_ref().filter(|c| c.valid) {
                return Ok(from_cache(cached, &normalized.full));
            }
            return Ok(ViesResult {
                available: false,
                valid: false,
                vat_number: normalized.full.clone(),
                country_code: normalized.country_code.clone(),
                trader_name: None,
                trader_address: None,
                consultation_number: None,
                checked_at: checked_now,
                from_cache: false,
            });
        }
    };

    let disclosed = |key: &str, max: usize| {
        body.get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty() && *v != "---")
            .map(|v| js_prefix(v, max))
    };
    let trader_name = disclosed("name", 255);
    let trader_address = disclosed("address", 500);
    let consultation_number = body
        .get("requestIdentifier")
        .and_then(Value::as_str)
        .map(|v| js_prefix(v, 50));

    sqlx::query(
        "insert into vies_checks (id, vat_number, country_code, valid, trader_name, trader_address, consultation_number, checked_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp) \
         on conflict (vat_number) do update set valid = excluded.valid, trader_name = excluded.trader_name, \
         trader_address = excluded.trader_address, consultation_number = excluded.consultation_number, \
         checked_at = excluded.checked_at, updated_at = $8::timestamp",
    )
    .bind(generate_id("vies"))
    .bind(&normalized.full)
    .bind(&normalized.country_code)
    .bind(valid)
    .bind(&trader_name)
    .bind(&trader_address)
    .bind(&consultation_number)
    .bind(&checked_now)
    .execute(db)
    .await?;

    Ok(ViesResult {
        available: true,
        valid,
        vat_number: normalized.full,
        country_code: normalized.country_code,
        trader_name,
        trader_address,
        consultation_number,
        checked_at: checked_now,
        from_cache: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        let vat = normalize_vat_number("nl 1234.56.789 b01").expect("vat");
        assert_eq!(vat.full, "NL123456789B01");
        assert_eq!(vat.country_code, "NL");
        assert!(normalize_vat_number("1234").is_none());
    }

    #[test]
    fn verdicts() {
        assert_eq!(
            interpret_vies_body(&json!({ "valid": true })),
            ViesVerdict::Verdict { valid: true }
        );
        assert_eq!(
            interpret_vies_body(
                &json!({ "valid": false, "errorWrappers": [{ "error": "INVALID_INPUT" }] })
            ),
            ViesVerdict::Verdict { valid: false }
        );
        assert_eq!(
            interpret_vies_body(
                &json!({ "valid": false, "errorWrappers": [{ "error": "MS_MAX_CONCURRENT_REQ" }] })
            ),
            ViesVerdict::Unavailable {
                reason: "MS_MAX_CONCURRENT_REQ".to_owned(),
                retryable: true
            }
        );
        assert_eq!(
            interpret_vies_body(&json!({ "valid": false, "userError": "MS_UNAVAILABLE" })),
            ViesVerdict::Unavailable {
                reason: "MS_UNAVAILABLE".to_owned(),
                retryable: false
            }
        );
        assert_eq!(
            interpret_vies_body(&json!({ "valid": false, "actionSucceed": false })),
            ViesVerdict::Unavailable {
                reason: "actionSucceed=false".to_owned(),
                retryable: false
            }
        );
        assert_eq!(
            interpret_vies_body(&Value::Null),
            ViesVerdict::Unavailable {
                reason: "empty response".to_owned(),
                retryable: false
            }
        );
    }

    #[test]
    fn prefixes_count_utf16_units() {
        assert_eq!(js_prefix("abcdef", 3), "abc");
        assert_eq!(js_prefix("a😀b", 2), "a");
    }
}
