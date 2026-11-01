//! Shared payroll helpers (`services/weldhr/payroll/{common,dates,issues,
//! format,validators}.ts`).

use serde_json::{Map, Value, json};

use crate::{HrError, js_to_fixed};

/// `num(value)`: a finite number from a number or numeric text.
pub(crate) fn num(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(weldsuite_kit::validation::js_number(s)).filter(|v| v.is_finite()),
        _ => None,
    }
}

/// `decimal2(value)`: two decimals, half away from zero.
pub(crate) fn decimal2(value: f64) -> String {
    let nudged = value * 100.0 + if value >= 0.0 { 1e-9 } else { -1e-9 };
    js_to_fixed(crate::js_round(nudged) / 100.0, 2)
}

/// `decimal4(value)`: `toFixed(4)`.
pub(crate) fn decimal4(value: f64) -> String {
    js_to_fixed(value, 4)
}

/// `hasError(issues)`.
pub(crate) fn has_error(issues: &[Value]) -> bool {
    issues.iter().any(|i| i["severity"] == "error")
}

/// `sortIssues(issues)`: errors first, otherwise as they were.
pub(crate) fn sort_issues(mut issues: Vec<Value>) -> Vec<Value> {
    issues.sort_by_key(|i| i["severity"] != "error");
    issues
}

/// `JSON.stringify` of a value as JavaScript writes it.
pub(crate) fn js_json(value: &Value) -> String {
    weldsuite_core_domain::js::stringify(&weldsuite_core_domain::js::Js::from_jsonb(value))
}

fn issue_key(issue: &Value) -> String {
    format!(
        "{}|{}|{}|{}",
        issue["severity"].as_str().unwrap_or(""),
        issue["code"].as_str().unwrap_or(""),
        issue["employeeId"].as_str().unwrap_or(""),
        js_json(issue.get("params").unwrap_or(&json!({})))
    )
}

/// `pushIssue(issues, issue)`: once.
pub(crate) fn push_issue(issues: &mut Vec<Value>, issue: Value) {
    let key = issue_key(&issue);
    if !issues.iter().any(|i| issue_key(i) == key) {
        issues.push(issue);
    }
}

/// An issue with optional params, as the services build them.
pub(crate) fn issue(severity: &str, code: &str, params: Option<Value>) -> Value {
    let mut out = Map::new();
    out.insert("severity".into(), json!(severity));
    out.insert("code".into(), json!(code));
    if let Some(params) = params {
        out.insert("params".into(), params);
    }
    Value::Object(out)
}

/// An issue on an employee.
pub(crate) fn employee_issue(severity: &str, code: &str, employee_id: &str, params: Option<Value>) -> Value {
    let mut out = Map::new();
    out.insert("severity".into(), json!(severity));
    out.insert("code".into(), json!(code));
    out.insert("employeeId".into(), json!(employee_id));
    if let Some(params) = params {
        out.insert("params".into(), params);
    }
    Value::Object(out)
}

/// `invalidWith(code, message, issues)`: 422 with the issues.
pub(crate) fn invalid_with(code: &str, message: impl Into<String>, issues: Vec<Value>) -> HrError {
    HrError::Payroll { code: code.to_owned(), message: message.into(), status: 422, details: Some(json!({ "issues": issues })) }
}

/// `incomplete(message, field)`: 409 `EMPLOYER_INCOMPLETE`.
pub(crate) fn incomplete(message: impl Into<String>, field: &str) -> HrError {
    HrError::Payroll {
        code: "EMPLOYER_INCOMPLETE".into(),
        message: message.into(),
        status: 409,
        details: Some(json!({ "issues": [{ "severity": "error", "code": "employer_incomplete", "params": { "field": field } }] })),
    }
}

/// `yearOfDate(isoDate)`.
pub(crate) fn year_of_date(iso: &str) -> i64 {
    iso.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

/// `monthBounds(year, month)`.
pub(crate) fn month_bounds(year: i64, month: i64) -> (String, String) {
    let start = format!("{year}-{month:02}-01");
    let last = weldsuite_payroll_domain::js::last_day_of_month(year, month);
    let total = year * 12 + month - 1;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    (start, format!("{y}-{m:02}-{last:02}"))
}

/// `quarterBounds(year, quarter)`.
pub(crate) fn quarter_bounds(year: i64, quarter: i64) -> (String, String) {
    let first = (quarter - 1) * 3 + 1;
    (month_bounds(year, first).0, month_bounds(year, first + 2).1)
}

/// `endOfNextMonth(isoDate)`.
pub(crate) fn end_of_next_month(iso: &str) -> String {
    let year = year_of_date(iso);
    let month: i64 = iso.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(0);
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    month_bounds(y, m).1
}

/// `csvField(value)` of text.
pub(crate) fn csv_text(text: &str) -> String {
    let mut text = text.to_owned();
    let starts_risky = text.starts_with(['=', '+', '-', '@', '\t', '\r']);
    if starts_risky && !is_signed_decimal(&text) {
        text = format!("'{text}");
    }
    if text.contains(['"', ',', '\r', '\n', ';']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
}

/// `/^[+-]?\d+(\.\d+)?$/`.
fn is_signed_decimal(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `csvField(n)` of a number.
pub(crate) fn csv_number(n: f64) -> String {
    let text = weldsuite_core_domain::js::number_text(n);
    if text.contains(['"', ',', '\r', '\n', ';']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
}

/// `fileSafe(value)`.
pub(crate) fn file_safe(value: &str) -> String {
    let mut out = String::new();
    let mut run = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
            run = false;
        } else if !run {
            out.push('_');
            run = true;
        }
    }
    let trimmed = out.trim_matches('_');
    let cut: String = trimmed.chars().take(80).collect();
    if cut.is_empty() { "file".into() } else { cut }
}

// ── dates ───────────────────────────────────────────────────────────────────

/// `isIsoDate(value)`: the shape and a real calendar day (or one that
/// rolls over: `Date.parse` accepts day 29–31 of any month).
pub(crate) fn is_iso_date(value: &str) -> bool {
    super::schema::is_iso_date_shape(value) && weldsuite_payroll_domain::js::parse_days(value).is_ok()
}

/// `rangesOverlap(aStart, aEnd, bStart, bEnd)`.
pub(crate) fn ranges_overlap(a_start: &str, a_end: Option<&str>, b_start: &str, b_end: Option<&str>) -> bool {
    let a_last = a_end.unwrap_or("9999-12-31");
    let b_last = b_end.unwrap_or("9999-12-31");
    a_start <= b_last && b_start <= a_last
}

/// `ageOnDate(dateOfBirth, onDate)`.
pub(crate) fn age_on_date(date_of_birth: &str, on: &str) -> i64 {
    weldsuite_payroll_domain::periods::age_on(date_of_birth, on).unwrap_or(0)
}

// ── format ──────────────────────────────────────────────────────────────────

/// `addressLines(address, country)`.
pub(crate) fn address_lines(address: &Value, country: &str) -> Vec<String> {
    if !address.is_object() {
        return vec![];
    }
    let t = |k: &str| address.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let house = t("houseNumber").map(|n| format!("{n}{}", address.get("houseNumberAddition").and_then(Value::as_str).unwrap_or("")));
    let street: String = [t("line1").map(str::to_owned), house].into_iter().flatten().collect::<Vec<_>>().join(" ");
    let street = weldsuite_kit::validation::js_trim(&street).to_owned();
    let mut lines = vec![];
    if !street.is_empty() {
        lines.push(street);
    }
    if let Some(line2) = t("line2") {
        lines.push(line2.to_owned());
    }
    if country == "NL" {
        let city = [t("postalCode"), t("city")].into_iter().flatten().collect::<Vec<_>>().join(" ");
        if !city.is_empty() {
            lines.push(city);
        }
    } else {
        let region = [t("region"), t("postalCode")].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let city_line = [t("city").map(str::to_owned), Some(region).filter(|r| !r.is_empty())]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
        if !city_line.is_empty() {
            lines.push(city_line);
        }
    }
    lines
}

const MONTHS_NL: [&str; 12] =
    ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const MONTHS_EN: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// `monthName(month, lang)`.
pub(crate) fn month_name(month: i64, nl: bool) -> String {
    let table = if nl { MONTHS_NL } else { MONTHS_EN };
    usize::try_from(month - 1).ok().and_then(|i| table.get(i)).map_or_else(|| month.to_string(), |m| (*m).to_owned())
}

/// `salaryRemittance(periodStart, lang)`.
pub(crate) fn salary_remittance(period_start: &str, nl: bool) -> String {
    let month: i64 = period_start.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(0);
    format!("{} {} {}", if nl { "Salaris" } else { "Salary" }, month_name(month, nl), period_start.get(..4).unwrap_or(""))
}

/// `payslipFileName(country, period)`.
pub(crate) fn payslip_file_name(country: &str, period_start: &str, pay_date: &str) -> String {
    if country == "NL" {
        format!("loonstrook-{}.pdf", period_start.get(..7).unwrap_or(""))
    } else {
        format!("payslip-{pay_date}.pdf")
    }
}

/// `annualStatementFileName(country, year)`.
pub(crate) fn annual_statement_file_name(country: &str, year: i64) -> String {
    if country == "NL" { format!("jaaropgaaf-{year}.pdf") } else { format!("w2-{year}.pdf") }
}

/// `safeId(value)`.
pub(crate) fn safe_id(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

/// `attachment(fileName)`.
pub(crate) fn attachment(file_name: &str) -> String {
    let safe: String = file_name
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';
            let n = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, n)
        })
        .collect();
    format!("attachment; filename=\"{safe}\"")
}

/// `engineCall(what, fn)`: a failing engine is 503 `ENGINE_UNAVAILABLE`.
pub(crate) fn engine_error(what: &str, error: &weldsuite_payroll_domain::PayrollError) -> HrError {
    HrError::payroll("ENGINE_UNAVAILABLE", format!("{what} is not available: {}", error.0), 503)
}

// ── validators ──────────────────────────────────────────────────────────────

pub(crate) fn digits_only(value: &str) -> String {
    value.chars().filter(char::is_ascii_digit).collect()
}

/// `normalizeBsn(value)`.
pub(crate) fn normalize_bsn(value: &str) -> Option<String> {
    let digits = digits_only(value);
    if !(8..=9).contains(&digits.len()) {
        return None;
    }
    let padded = format!("{digits:0>9}");
    let d: Vec<i64> = padded.bytes().map(|b| i64::from(b - b'0')).collect();
    let total: i64 = (0..9).map(|i| d[i] * if i == 8 { -1 } else { 9 - i as i64 }).sum();
    if total == 0 || total % 11 != 0 {
        return None;
    }
    Some(padded)
}

/// `normalizeSsn(value)`.
pub(crate) fn normalize_ssn(value: &str) -> Option<String> {
    let t = weldsuite_kit::validation::js_trim(value);
    let b = t.as_bytes();
    let all = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    let shape = match b.len() {
        9 => all(b),
        10 => (b[3] == b'-' && all(&b[..3]) && all(&b[4..])) || (b[5] == b'-' && all(&b[..5]) && all(&b[6..])),
        11 => b[3] == b'-' && b[6] == b'-' && all(&b[..3]) && all(&b[4..6]) && all(&b[7..]),
        _ => false,
    };
    if !shape {
        return None;
    }
    let digits = digits_only(value);
    let area = &digits[..3];
    if area == "000" || area == "666" || area.starts_with('9') || &digits[3..5] == "00" || &digits[5..] == "0000" {
        return None;
    }
    Some(digits)
}

/// The IBAN lengths per country (`IBAN_LENGTHS`).
const IBAN_LENGTHS: [(&str, usize); 77] = [
    ("AD", 24), ("AE", 23), ("AL", 28), ("AT", 20), ("AZ", 28), ("BA", 20), ("BE", 16), ("BG", 22), ("BH", 22), ("BR", 29),
    ("BY", 28), ("CH", 21), ("CR", 22), ("CY", 28), ("CZ", 24), ("DE", 22), ("DK", 18), ("DO", 28), ("EE", 20), ("EG", 29),
    ("ES", 24), ("FI", 18), ("FO", 18), ("FR", 27), ("GB", 22), ("GE", 22), ("GI", 23), ("GL", 18), ("GR", 27), ("GT", 28),
    ("HR", 21), ("HU", 28), ("IE", 22), ("IL", 23), ("IQ", 23), ("IS", 26), ("IT", 27), ("JO", 30), ("KW", 30), ("KZ", 20),
    ("LB", 28), ("LC", 32), ("LI", 21), ("LT", 20), ("LU", 20), ("LV", 21), ("MC", 27), ("MD", 24), ("ME", 22), ("MK", 19),
    ("MR", 27), ("MT", 31), ("MU", 30), ("NL", 18), ("NO", 15), ("PK", 24), ("PL", 28), ("PS", 29), ("PT", 25), ("QA", 29),
    ("RO", 24), ("RS", 22), ("SA", 24), ("SC", 31), ("SE", 24), ("SI", 19), ("SK", 24), ("SM", 27), ("ST", 25), ("SV", 28),
    ("TL", 23), ("TN", 24), ("TR", 26), ("UA", 29), ("VA", 22), ("VG", 24), ("XK", 20),
];

/// `normalizeIban(value)`.
pub(crate) fn normalize_iban(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace() && *c != '\u{feff}').collect::<String>().to_uppercase()
}

/// `isValidIban(raw)`.
pub(crate) fn is_valid_iban(raw: &str) -> bool {
    let iban = normalize_iban(raw);
    let b = iban.as_bytes();
    let shape = (5..=34).contains(&b.len())
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..4].iter().all(u8::is_ascii_digit)
        && b[4..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !shape {
        return false;
    }
    let Some((_, expected)) = IBAN_LENGTHS.iter().find(|(cc, _)| *cc == &iban[..2]) else {
        return false;
    };
    if iban.len() != *expected {
        return false;
    }
    let rearranged = format!("{}{}", &iban[4..], &iban[..4]);
    let mut remainder: u32 = 0;
    for ch in rearranged.chars() {
        let code = if ch.is_ascii_uppercase() { (u32::from(ch) - 55).to_string() } else { ch.to_string() };
        for d in code.chars() {
            remainder = (remainder * 10 + d.to_digit(10).unwrap_or(0)) % 97;
        }
    }
    remainder == 1
}

/// `normalizeBic(value)`.
pub(crate) fn normalize_bic(value: &str) -> Option<String> {
    let bic: String = value.chars().filter(|c| !c.is_whitespace() && *c != '\u{feff}').collect::<String>().to_uppercase();
    let b = bic.as_bytes();
    let ok = (b.len() == 8 || b.len() == 11)
        && b[..6].iter().all(u8::is_ascii_uppercase)
        && b[6..8].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && b[8..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    ok.then_some(bic)
}

/// `isValidRoutingNumber(value)` (checksum only).
pub(crate) fn is_valid_routing_number(value: &str) -> bool {
    if value.len() != 9 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let d: Vec<u32> = value.bytes().map(|b| u32::from(b - b'0')).collect();
    let sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    sum % 10 == 0
}

/// `maskNationalId(value)`.
pub(crate) fn mask_national_id(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let digits = digits_only(value);
    let tail: String = digits.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    Some(format!("•••••{tail}"))
}

/// `maskIban(value)`.
pub(crate) fn mask_iban(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let iban = normalize_iban(value);
    let chars: Vec<char> = iban.chars().collect();
    if chars.len() <= 8 {
        return Some(format!("{}••", chars.iter().take(2).collect::<String>()));
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    let groups = ((chars.len() - 8) / 4).max(1);
    let mut parts = vec![head];
    parts.extend(std::iter::repeat_n("••••".to_owned(), groups));
    parts.push(tail);
    Some(parts.join(" "))
}

/// `maskAccountNumber(value)`.
pub(crate) fn mask_account_number(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let chars: Vec<char> = value.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    Some(format!("•••• {tail}"))
}

/// `maskSsn(value)`.
pub(crate) fn mask_ssn(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let digits = digits_only(value);
    (digits.len() == 9).then(|| format!("***-**-{}", &digits[5..]))
}

/// A string member of a JSON object, `None` when missing, null or empty
/// (JavaScript's falsy string).
pub(crate) fn truthy_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
