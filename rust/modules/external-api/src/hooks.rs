//! What the client packages' Zod schemas compute in JavaScript: the
//! `.refine()`, `.transform()` and `z.preprocess()` functions the generated
//! schemas (`schemas_gen.rs`) call, each named after its schema and field.

use serde_json::Value;
use weldsuite_core_domain::js::js_date;

use crate::zod::Hook;

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/// `normalizeWebsiteValue(raw)` / `normalizeUrlValue(raw)`: `https://` in
/// front unless it has an http(s) scheme.
fn normalize_url(raw: &str) -> String {
    let lower = raw.get(..8).unwrap_or(raw).to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    }
}

/// `isValidWebsiteValue(raw)`: `new URL(normalised).hostname.includes('.')`.
fn valid_url(raw: &str) -> bool {
    url::Url::parse(&normalize_url(raw))
        .ok()
        .and_then(|url| url.host_str().map(|host| host.contains('.')))
        .unwrap_or(false)
}

/// `.refine((v) => v === '' || isValid(v), { message })`.
fn url_refine(value: Option<&Value>, hook: &mut Hook, message: &str) {
    if let Some(Value::String(raw)) = value
        && !raw.is_empty()
        && !valid_url(raw)
    {
        hook.fail(message);
    }
}

/// `.transform((v) => (v === '' ? v : normalize(v)))`.
pub(crate) fn url_transform(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::String(raw)) if !raw.is_empty() => Some(Value::String(normalize_url(&raw))),
        other => other,
    }
}

const LINKEDIN_MESSAGE: &str = "LinkedIn must be a valid URL (e.g. linkedin.com/in/jane)";
const WEBSITE_MESSAGE: &str = "Website must be a valid URL (e.g. acme.com or https://acme.com)";
const EMPLOYEES_MESSAGE: &str = "Employees must be a number or a range (e.g. 42 or 11-50)";

/// `/^\d+(-\d+)?\+?$/`.
fn employee_range(text: &str) -> bool {
    let body = text.strip_suffix('+').unwrap_or(text);
    let mut parts = body.splitn(2, '-');
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let first = parts.next().is_some_and(digits);
    first && parts.next().is_none_or(digits)
}

pub(crate) fn employee_count(value: Option<&Value>, hook: &mut Hook) {
    if let Some(Value::String(text)) = value
        && !text.is_empty()
        && !employee_range(text)
    {
        hook.fail(EMPLOYEES_MESSAGE);
    }
}

/// ISO 4217 codes (`ISO_4217_CURRENCY_CODES`).
const CURRENCIES: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
    "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD",
    "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP",
    "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF",
    "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
    "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK",
    "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU",
    "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR",
    "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR",
    "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC",
    "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
    "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER",
    "ZAR", "ZMW", "ZWG", "ZWL",
];

/// `nonNegativeAmountSchema`'s refinement: absent, or a number (or numeric
/// string) of at least zero.
pub(crate) fn non_negative_amount(value: Option<&Value>, hook: &mut Hook) {
    let ok = match value {
        None => true,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n >= 0.0),
        Some(Value::String(text)) => {
            let n = weldsuite_kit::validation::js_number(text);
            !n.is_nan() && n >= 0.0
        }
        Some(_) => false,
    };
    if !ok {
        hook.fail("Amount must be zero or greater");
    }
}

/// `currencySchema`: empty or a real ISO 4217 code.
pub(crate) fn iso_currency(value: Option<&Value>, hook: &mut Hook) {
    if let Some(Value::String(code)) = value
        && !code.is_empty()
        && !CURRENCIES.contains(&code.as_str())
    {
        hook.fail("Currency must be a valid 3-letter ISO 4217 code (e.g. USD, EUR)");
    }
}

/// `closeDate`: empty, or `Date.parse` succeeds.
pub(crate) fn close_date(value: Option<&Value>, hook: &mut Hook) {
    if let Some(Value::String(text)) = value
        && !text.is_empty()
        && js_date(text).is_none()
    {
        hook.fail("closeDate must be a valid date");
    }
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

pub(crate) fn refine_create_person_linkedin_url(value: Option<&Value>, hook: &mut Hook) {
    url_refine(value, hook, LINKEDIN_MESSAGE);
}
pub(crate) use refine_create_person_linkedin_url as refine_update_person_linkedin_url;
pub(crate) use url_transform as transform_create_person_linkedin_url;
pub(crate) use url_transform as transform_update_person_linkedin_url;

pub(crate) fn refine_create_company_website(value: Option<&Value>, hook: &mut Hook) {
    url_refine(value, hook, WEBSITE_MESSAGE);
}
pub(crate) use refine_create_company_website as refine_update_company_website;
pub(crate) use url_transform as transform_create_company_website;
pub(crate) use url_transform as transform_update_company_website;

pub(crate) use close_date as refine_create_opportunity_close_date;
pub(crate) use close_date as refine_update_opportunity_close_date;
pub(crate) use employee_count as refine_create_company_employee_count;
pub(crate) use employee_count as refine_update_company_employee_count;
pub(crate) use iso_currency as refine_create_opportunity_currency;
pub(crate) use iso_currency as refine_update_opportunity_currency;
pub(crate) use non_negative_amount as refine_create_opportunity_amount;
pub(crate) use non_negative_amount as refine_update_opportunity_amount;

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/// `normalizeProjectStatus`: any spelling of a canonical status to its
/// stored form; unknown values unchanged.
pub(crate) fn transform_create_project_status(value: Option<Value>) -> Option<Value> {
    let Some(Value::String(text)) = value else {
        return value;
    };
    let key: String = weldsuite_kit::validation::js_trim(&text)
        .to_lowercase()
        .chars()
        .filter(|c| !(c.is_whitespace() || *c == '_' || *c == '-'))
        .collect();
    let canonical = match key.as_str() {
        "planning" => "Planning",
        "active" => "Active",
        "onhold" => "On Hold",
        "completed" => "Completed",
        "cancelled" | "canceled" => "Cancelled",
        _ => return Some(Value::String(text)),
    };
    Some(Value::String(canonical.to_owned()))
}
pub(crate) use transform_create_project_status as transform_update_project_status;

/// `normalizeTaskStatus`: legacy `in_review` is `review`.
pub(crate) fn transform_create_task_status(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) if text == "in_review" => Some(Value::String("review".into())),
        other => other,
    }
}
pub(crate) use transform_create_task_status as transform_update_task_status;
