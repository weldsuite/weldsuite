//! Normalization rules of the bank feeds (`@weldsuite/bank-feeds/normalize`):
//! amounts in minor units, calendar dates, fingerprints, the status roll-up,
//! the re-pull window of date-range providers, and pending matching.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js::{civil_from_days, days_from_civil, math_round};

const ZERO_DECIMAL: &[&str] = &[
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF",
    "XOF", "XPF",
];
const THREE_DECIMAL: &[&str] = &["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// `currencyExponent(currency)`.
pub fn currency_exponent(currency: &str) -> u32 {
    let code = currency.to_uppercase();
    if ZERO_DECIMAL.contains(&code.as_str()) {
        0
    } else if THREE_DECIMAL.contains(&code.as_str()) {
        3
    } else {
        2
    }
}

/// `decimalToMinor(amount, currency)`: a decimal amount to signed minor units.
#[allow(clippy::cast_possible_truncation)]
pub fn decimal_to_minor(amount: f64, currency: &str) -> Result<i64, String> {
    if !amount.is_finite() {
        return Err(format!(
            "Invalid amount: {}",
            crate::js::number_text(amount)
        ));
    }
    let minor =
        math_round(amount * 10f64.powi(i32::try_from(currency_exponent(currency)).unwrap_or(2)));
    Ok(minor as i64)
}

/// `decimalToMinor` of a numeric column's text.
pub fn text_to_minor(amount: &str, currency: &str) -> Result<i64, String> {
    decimal_to_minor(weldsuite_kit::validation::js_number(amount), currency)
}

/// `minorToDecimalString(minor, currency)`.
pub fn minor_to_decimal(minor: i64, currency: &str) -> String {
    let exponent = currency_exponent(currency) as usize;
    let digits = format!("{:0>width$}", minor.unsigned_abs(), width = exponent + 1);
    let (whole, fraction) = digits.split_at(digits.len() - exponent);
    let sign = if minor < 0 { "-" } else { "" };
    if exponent == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

/// `normalizeDate(input)`: a calendar date without time-zone conversion;
/// unix seconds use their UTC date.
pub fn normalize_date(input: &Value) -> Result<String, String> {
    match input {
        Value::String(text) => {
            let b = text.as_bytes();
            let dated = b.len() >= 10
                && b[4] == b'-'
                && b[7] == b'-'
                && [0, 1, 2, 3, 5, 6, 8, 9]
                    .iter()
                    .all(|i| b[*i].is_ascii_digit());
            if dated && b.len() == 10 {
                return Ok(text.clone());
            }
            if dated && matches!(b[10], b'T' | b' ') {
                return Ok(text[..10].to_owned());
            }
            let number = weldsuite_kit::validation::js_number(text);
            if number.is_finite() {
                return normalize_date(&serde_json::json!(number));
            }
            Err(format!("Invalid date: {text}"))
        }
        Value::Number(n) => {
            let seconds = n.as_f64().unwrap_or(f64::NAN);
            #[allow(clippy::cast_possible_truncation)]
            let millis = (seconds * 1000.0) as i64;
            crate::js::iso_from_millis(millis)
                .map(|iso| iso[..10].to_owned())
                .ok_or_else(|| "Invalid time value".to_owned())
        }
        other => Err(format!("Invalid date: {other}")),
    }
}

fn day_number(date: &str) -> i64 {
    let parts: Vec<i64> = date.split('-').map(|p| p.parse().unwrap_or(0)).collect();
    days_from_civil(
        parts.first().copied().unwrap_or(1970),
        parts.get(1).copied().unwrap_or(1),
        1,
    ) + parts.get(2).copied().unwrap_or(1)
        - 1
}

/// `addDays(date, days)`.
pub fn add_days(date: &str, days: i64) -> String {
    let (y, m, d) = civil_from_days(day_number(date) + days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `daysBetween(from, to)`.
pub fn days_between(from: &str, to: &str) -> i64 {
    day_number(to) - day_number(from)
}

/// SHA-256 as lower-case hex.
pub fn sha256_hex(input: &str) -> String {
    hex_of(&Sha256::digest(input.as_bytes()))
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// `slug(value)`: lower-case, runs of anything but `a-z0-9` as one `-`,
/// trimmed of dashes.
pub fn slug(value: Option<&str>) -> String {
    let lower = value.unwrap_or_default().to_lowercase();
    let mut out = String::new();
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// `accountFingerprint(institutionId, mask, subtype)`.
pub fn account_fingerprint(
    institution: Option<&str>,
    mask: Option<&str>,
    subtype: Option<&str>,
) -> String {
    sha256_hex(&format!(
        "acct|{}|{}|{}",
        slug(institution),
        crate::jurisdictions::js_trim(mask.unwrap_or_default()),
        slug(subtype)
    ))
}

/// `persistentAccountFingerprint(persistentId)`.
pub fn persistent_account_fingerprint(id: &str) -> String {
    sha256_hex(&format!("acct-persistent|{id}"))
}

/// `normalizeIban(iban)`.
pub fn normalize_iban(iban: &str) -> String {
    iban.chars()
        .filter(|c| !crate::jurisdictions::is_js_space(*c))
        .collect::<String>()
        .to_uppercase()
}

/// `ibanFingerprint(iban)`.
pub fn iban_fingerprint(iban: &str) -> String {
    sha256_hex(&format!("acct-iban|{}", normalize_iban(iban)))
}

/// `normalizeDescription`: lower-case, letters and digits only, single spaces.
pub fn normalize_description(description: Option<&str>) -> String {
    let lower = description.unwrap_or_default().to_lowercase();
    let spaced: String = lower
        .chars()
        .map(|c| {
            if c.is_alphabetic() || c.is_numeric() {
                c
            } else {
                ' '
            }
        })
        .collect();
    spaced
        .split(crate::jurisdictions::is_js_space)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `transactionFingerprint(date, amountMinor, normalizedDescription, occurrence)`.
pub fn transaction_fingerprint(
    date: &str,
    amount_minor: i64,
    description: &str,
    occurrence: usize,
) -> String {
    sha256_hex(&format!(
        "txn|{date}|{amount_minor}|{description}|{occurrence}"
    ))
}

/// `connectionStatus(statuses)`: ended accounts don't count while another
/// syncs; among live ones the one needing action wins.
pub fn connection_status<S: AsRef<str>>(statuses: &[S]) -> &'static str {
    if statuses.is_empty() {
        return "active";
    }
    let live: Vec<&str> = statuses
        .iter()
        .map(AsRef::as_ref)
        .filter(|s| *s != "revoked" && *s != "disconnected")
        .collect();
    if live.is_empty() {
        return if statuses.iter().any(|s| s.as_ref() == "revoked") {
            "revoked"
        } else {
            "disconnected"
        };
    }
    for status in ["reauth_required", "error", "expiring"] {
        if live.contains(&status) {
            return status;
        }
    }
    "active"
}

/// `rePullWindow({ lastThrough, today, historyDays })`: `(from, to)`.
pub fn re_pull_window(
    last_through: Option<&str>,
    today: &str,
    history_days: i64,
) -> (String, String) {
    let earliest = add_days(today, -history_days);
    let Some(last) = last_through.filter(|l| !l.is_empty()) else {
        return (earliest, today.to_owned());
    };
    let from = add_days(last, -8);
    (
        if from < earliest { earliest } else { from },
        today.to_owned(),
    )
}

/// `PendingCandidate`.
#[derive(Debug, Clone)]
pub struct PendingCandidate {
    pub id: String,
    pub account_id: String,
    pub date: String,
    pub amount_minor: i64,
    pub description: Option<String>,
}

#[allow(clippy::cast_precision_loss)]
fn similarity(a: &str, b: &str) -> f64 {
    let na = normalize_description(Some(a));
    let nb = normalize_description(Some(b));
    if na.is_empty() || nb.is_empty() {
        return 0.5;
    }
    if na == nb {
        return 1.0;
    }
    if na.contains(&nb) || nb.contains(&na) {
        return 0.9;
    }
    let tokens = |s: &str| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for t in s.split(' ').filter(|t| t.chars().count() > 1) {
            if !out.iter().any(|o| o == t) {
                out.push(t.to_owned());
            }
        }
        out
    };
    let ta = tokens(&na);
    let tb = tokens(&nb);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let shared = ta.iter().filter(|t| tb.contains(t)).count();
    shared as f64 / (ta.len() + tb.len() - shared) as f64
}

/// `matchPendingToPosted(posted, candidates)`: the pending row a posted
/// transaction replaces, for providers that give no link between them.
#[allow(clippy::float_cmp)] // `score === best.score`, as the worker compares
pub fn match_pending_to_posted<'a>(
    account_id: &str,
    date: &str,
    amount_minor: i64,
    description: &str,
    candidates: &'a [PendingCandidate],
) -> Option<&'a PendingCandidate> {
    let mut best: Option<(&PendingCandidate, f64, i64)> = None;
    for candidate in candidates {
        if candidate.account_id != account_id || candidate.amount_minor != amount_minor {
            continue;
        }
        let distance = days_between(&candidate.date, date).abs();
        if distance > 10 {
            continue;
        }
        let score = similarity(
            candidate.description.as_deref().unwrap_or_default(),
            description,
        );
        if score < 0.34 {
            continue;
        }
        let better = match best {
            None => true,
            Some((_, s, d)) => score > s || (score == s && distance < d),
        };
        if better {
            best = Some((candidate, score, distance));
        }
    }
    best.map(|(c, _, _)| c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_and_dates() {
        assert_eq!(decimal_to_minor(12.345, "USD"), Ok(1235));
        assert_eq!(decimal_to_minor(-12.0, "JPY"), Ok(-12));
        assert_eq!(minor_to_decimal(-5, "EUR"), "-0.05");
        assert_eq!(minor_to_decimal(123_456, "KWD"), "123.456");
        assert_eq!(minor_to_decimal(7, "JPY"), "7");
        assert_eq!(
            normalize_date(&serde_json::json!("2026-01-05T10:00:00Z")).as_deref(),
            Ok("2026-01-05")
        );
        assert_eq!(
            normalize_date(&serde_json::json!(1_767_225_600)).as_deref(),
            Ok("2026-01-01")
        );
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(days_between("2026-02-27", "2026-03-01"), 2);
    }

    #[test]
    fn fingerprints_and_status() {
        assert_eq!(
            slug(Some("  First Platypus  Bank! ")),
            "first-platypus-bank"
        );
        assert_eq!(
            normalize_description(Some("Coffee, Inc. #42")),
            "coffee inc 42"
        );
        assert_eq!(connection_status(&["active", "revoked"]), "active");
        assert_eq!(connection_status(&["revoked", "disconnected"]), "revoked");
        assert_eq!(connection_status(&["active", "expiring", "error"]), "error");
        assert_eq!(
            re_pull_window(Some("2026-03-10"), "2026-03-12", 540).0,
            "2026-03-02"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
