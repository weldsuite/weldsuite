//! CSV statements with an explicit layout (`bank-parsers/csv-format.ts`):
//! the confirmed `CsvFormat` (date order, separators, negatives, columns)
//! reads the file; `detect_csv_format` proposes one for the user to confirm.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::{ParseIssue, ParseResult, Txn, clean_text, is_space, js_trim, strip_bom};

static TIME_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?\s*([AaPp][Mm])?\s*(Z|[+-][0-9]{2}:?[0-9]{2})?$",
    )
    .expect("time pattern")
});
static TIME_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ T][0-9]{1,2}:[0-9]{2}.*$").expect("time tail pattern"));
static COMPACT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{4})([0-9]{2})([0-9]{2})$").expect("compact"));
static ISO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})$").expect("iso"));
static NUMERIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{2}|[0-9]{4})$").expect("numeric")
});
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:[A-Za-z]+,?\s+)?([0-9]{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-]([0-9]{2}|[0-9]{4})$",
    )
    .expect("named")
});
static NAMED_FIRST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z]{3,9})\.?\s+([0-9]{1,2}),?\s+([0-9]{2}|[0-9]{4})$").expect("named first")
});
static CURRENCY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[$€£¥]|USD|EUR|GBP|CAD").expect("currency"));
static YEAR_FIRST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}$|^[0-9]{8}$").expect("year first")
});

const DELIMITERS: [char; 4] = [',', ';', '\t', '|'];

/// One CSV record: its cells and the 1-based line it starts on.
pub(crate) struct Record {
    pub(crate) cells: Vec<String>,
    pub(crate) line: usize,
}

/// `readCsvRecords(content, delimiter)`: quotes, doubled quotes and line
/// breaks inside quotes honoured; blank records dropped.
pub(crate) fn read_records(content: &str, delimiter: char) -> Vec<Record> {
    let chars: Vec<char> = strip_bom(content).chars().collect();
    let mut records = Vec::new();
    let mut cells: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut line = 1;
    let mut record_line = 1;
    let mut touched = false;
    let end_record =
        |cells: &mut Vec<String>, cell: &mut String, records: &mut Vec<Record>, at: usize| {
            cells.push(std::mem::take(cell));
            if cells.iter().any(|c| !js_trim(c).is_empty()) {
                records.push(Record {
                    cells: std::mem::take(cells),
                    line: at,
                });
            } else {
                cells.clear();
            }
        };
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if !touched {
            record_line = line;
            touched = true;
        }
        if quoted {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                if ch == '\n' {
                    line += 1;
                }
                cell.push(ch);
            }
        } else if ch == '"' && cell.is_empty() {
            quoted = true;
        } else if ch == delimiter {
            cells.push(std::mem::take(&mut cell));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            line += 1;
            end_record(&mut cells, &mut cell, &mut records, record_line);
            touched = false;
        } else {
            cell.push(ch);
        }
        i += 1;
    }
    if touched || !cell.is_empty() || !cells.is_empty() {
        end_record(&mut cells, &mut cell, &mut records, record_line);
    }
    records
}

/// `detectDelimiter(content)`: the one that splits the first lines into the
/// most consistent number of cells.
pub(crate) fn detect_delimiter(content: &str) -> char {
    let text = strip_bom(content);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !js_trim(l).is_empty())
        .take(12)
        .collect();
    let mut best = ',';
    let mut best_score = 0;
    for delimiter in DELIMITERS {
        let mut tally: BTreeMap<usize, usize> = BTreeMap::new();
        for line in &lines {
            let count = read_records(line, delimiter)
                .first()
                .map_or(1, |r| r.cells.len());
            *tally.entry(count).or_insert(0) += 1;
        }
        let (modal, agreeing) = modal_of(&tally);
        let score = if modal > 1 { agreeing * 100 + modal } else { 0 };
        if score > best_score {
            best = delimiter;
            best_score = score;
        }
    }
    best
}

/// The most frequent value of a tally, the larger value on a tie.
fn modal_of(tally: &BTreeMap<usize, usize>) -> (usize, usize) {
    tally
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)))
        .map_or((1, 0), |(value, count)| (*value, *count))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    // `Date.UTC` reads a year below 100 as 19xx.
    let year = if (0..100).contains(&year) {
        year + 1900
    } else {
        year
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn make_date(year: i64, month: i64, day: i64) -> Option<String> {
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn expand_year(year: i64, digits: usize) -> i64 {
    if digits >= 4 {
        year
    } else if year < 70 {
        2000 + year
    } else {
        1900 + year
    }
}

fn month_of(name: &str) -> Option<i64> {
    Some(match name.to_lowercase().as_str() {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    })
}

fn num(text: &str) -> i64 {
    text.parse().unwrap_or(0)
}

/// `parseCsvDate(raw, order)`: a calendar date read with the declared order.
pub(crate) fn parse_csv_date(raw: &str, order: &str) -> Option<String> {
    let value = js_trim(raw).replace('"', "");
    let value = TIME_SUFFIX.replace(&value, "");
    let value = js_trim(&value);
    if value.is_empty() {
        return None;
    }
    if let Some(c) = COMPACT.captures(value) {
        return make_date(num(&c[1]), num(&c[2]), num(&c[3]));
    }
    if let Some(c) = ISO.captures(value) {
        return make_date(num(&c[1]), num(&c[2]), num(&c[3]));
    }
    if let Some(c) = NUMERIC.captures(value) {
        let a = num(&c[1]);
        let b = num(&c[2]);
        let year = expand_year(num(&c[3]), c[3].len());
        return match order {
            "DMY" => make_date(year, b, a),
            "YMD" => None,
            _ => make_date(year, a, b),
        };
    }
    if let Some(c) = NAMED.captures(value) {
        return month_of(&c[2])
            .and_then(|month| make_date(expand_year(num(&c[3]), c[3].len()), month, num(&c[1])));
    }
    if let Some(c) = NAMED_FIRST.captures(value) {
        return month_of(&c[1])
            .and_then(|month| make_date(expand_year(num(&c[3]), c[3].len()), month, num(&c[2])));
    }
    None
}

fn is_minus(c: char) -> bool {
    matches!(c, '-' | '\u{2212}' | '\u{2013}')
}

/// `/^\d+(\.\d*)?$|^\.\d+$/`
fn plain_decimal(text: &str) -> bool {
    match text.split_once('.') {
        None => !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
        Some((whole, fraction)) => {
            whole.bytes().all(|b| b.is_ascii_digit())
                && fraction.bytes().all(|b| b.is_ascii_digit())
                && (!whole.is_empty() || !fraction.is_empty())
        }
    }
}

/// `parseCsvAmount(raw, format)`: parentheses, a leading or trailing minus
/// and a DR suffix are negative.
pub(crate) fn parse_csv_amount(raw: &str, decimal: &str, thousands: &str) -> Option<f64> {
    let mut s: String = js_trim(raw)
        .replace('"', "")
        .chars()
        .filter(|c| !is_space(*c) && *c != '\u{a0}')
        .collect();
    if s.is_empty() {
        return None;
    }
    let mut negative = false;
    if s.starts_with('(') && s.ends_with(')') && s.len() >= 2 {
        negative = true;
        s = s[1..s.len() - 1].to_owned();
    }
    s = CURRENCY.replace_all(&s, "").into_owned();
    let lower = s.to_ascii_lowercase();
    if lower.ends_with("dr") {
        negative = true;
        s.truncate(s.len() - 2);
    } else if lower.ends_with("cr") {
        s.truncate(s.len() - 2);
    }
    if s.starts_with(is_minus) {
        negative = true;
        s = s.chars().skip(1).collect();
    } else if let Some(rest) = s.strip_prefix('+') {
        s = rest.to_owned();
    }
    if s.ends_with(is_minus) {
        negative = true;
        s.pop();
    }
    s.retain(|c| !matches!(c, '$' | '€' | '£' | '¥'));
    if !thousands.is_empty() && thousands != " " && thousands != decimal {
        s = s.replace(thousands, "");
    }
    if decimal == "," {
        s = s.replacen(',', ".", 1);
    }
    if !plain_decimal(&s) {
        return None;
    }
    let value = weldsuite_books_domain::js::parse_float(&s);
    if !value.is_finite() {
        return None;
    }
    Some(if negative { -value } else { value })
}

fn normalize_header(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut out = String::new();
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '#' {
            if gap {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push(' ');
    }
    js_trim(&out).to_owned()
}

/// `resolveColumn(ref, headers, label, problems)`.
fn resolve_column(
    reference: Option<&Value>,
    headers: Option<&[String]>,
    label: &str,
    problems: &mut Vec<String>,
) -> Option<usize> {
    match reference? {
        Value::Number(n) => n.as_u64().and_then(|n| usize::try_from(n).ok()),
        Value::String(name) if name.is_empty() => None,
        Value::String(name) => {
            if let Some(headers) = headers {
                let wanted = normalize_header(name);
                if let Some(at) = headers.iter().position(|h| normalize_header(h) == wanted) {
                    return Some(at);
                }
            }
            if name.bytes().all(|b| b.is_ascii_digit()) {
                return name.parse().ok();
            }
            problems.push(format!(
                "{label} column \"{name}\" was not found in the header row"
            ));
            None
        }
        _ => None,
    }
}

/// `cell.replace(/^0+(?=\d)/, '')`
fn strip_leading_zeros(value: &str) -> String {
    let zeros = value.bytes().take_while(|b| *b == b'0').count();
    if zeros == 0 {
        return value.to_owned();
    }
    let next_is_digit = value.as_bytes().get(zeros).is_some_and(u8::is_ascii_digit);
    let drop = if next_is_digit { zeros } else { zeros - 1 };
    value[drop..].to_owned()
}

/// `parseCsvWithFormat(content, format)`: rows that don't read are reported
/// and skipped.
#[allow(clippy::too_many_lines)] // mirrors parseCsvWithFormat step by step
pub(crate) fn parse_with_format(content: &str, format: &Value) -> ParseResult {
    let mut result = ParseResult::new("csv");
    let delimiter = format["delimiter"]
        .as_str()
        .and_then(|d| d.chars().next())
        .unwrap_or_else(|| detect_delimiter(content));
    let records = read_records(content, delimiter);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let skip = format["skipRows"].as_f64().unwrap_or(0.0).max(0.0) as usize;
    let has_header = format["hasHeader"].as_bool().unwrap_or(false);
    let header = if has_header { records.get(skip) } else { None };
    if has_header && header.is_none() {
        result.errors.push(ParseIssue::new(
            "The file has no header row after the skipped rows",
        ));
        return result;
    }
    let headers: Option<Vec<String>> =
        header.map(|h| h.cells.iter().map(|c| js_trim(c).to_owned()).collect());
    let rows = records
        .get(skip + usize::from(has_header)..)
        .unwrap_or_default();

    let cols = &format["columns"];
    let mut problems = Vec::new();
    let mut column = |key: &str, label: &str| {
        resolve_column(cols.get(key), headers.as_deref(), label, &mut problems)
    };
    let date = column("date", "Date");
    let description = column("description", "Description");
    let amount = column("amount", "Amount");
    let debit = column("debit", "Debit");
    let credit = column("credit", "Credit");
    let check_number = column("checkNumber", "Check number");
    let payee = column("payee", "Payee");
    let reference = column("reference", "Reference");
    if date.is_none() {
        problems.push("A date column is required".to_owned());
    }
    if amount.is_none() && debit.is_none() && credit.is_none() {
        problems.push("An amount, or a debit and credit column, is required".to_owned());
    }
    if !problems.is_empty() {
        result
            .errors
            .extend(problems.into_iter().map(ParseIssue::new));
        return result;
    }
    let decimal = format["decimalSeparator"].as_str().unwrap_or(".");
    let thousands = format["thousandsSeparator"].as_str().unwrap_or("");
    let order = format["dateFormat"].as_str().unwrap_or("MDY");
    let cell = |cells: &[String], at: Option<usize>| -> String {
        at.and_then(|at| cells.get(at))
            .map(|c| js_trim(c).to_owned())
            .unwrap_or_default()
    };

    for record in rows {
        let cells = &record.cells;
        let line = record.line;
        let date_text = cell(cells, date);
        let Some(iso) = parse_csv_date(&date_text, order) else {
            if !date_text.is_empty() {
                result.errors.push(ParseIssue::at(
                    line,
                    format!("Unreadable date \"{date_text}\""),
                ));
            }
            continue;
        };
        let amount_text = cell(cells, amount);
        let signed = if !amount_text.is_empty() {
            parse_csv_amount(&amount_text, decimal, thousands)
        } else if debit.is_some() || credit.is_some() {
            let out_text = cell(cells, debit);
            let in_text = cell(cells, credit);
            if out_text.is_empty() && in_text.is_empty() {
                continue;
            }
            let out = if out_text.is_empty() {
                Some(0.0)
            } else {
                parse_csv_amount(&out_text, decimal, thousands)
            };
            let into = if in_text.is_empty() {
                Some(0.0)
            } else {
                parse_csv_amount(&in_text, decimal, thousands)
            };
            match (out, into) {
                (Some(out), Some(into)) => Some(into.abs() - out.abs()),
                _ => None,
            }
        } else {
            continue;
        };
        let Some(signed) = signed else {
            let shown = [amount_text.clone(), cell(cells, debit), cell(cells, credit)]
                .into_iter()
                .find(|t| !t.is_empty())
                .unwrap_or_default();
            result.errors.push(ParseIssue::at(
                line,
                format!("Unreadable amount in \"{shown}\""),
            ));
            continue;
        };
        let described = clean_text(Some(&cell(cells, description)));
        let payee_text = clean_text(Some(&cell(cells, payee)));
        let check = strip_leading_zeros(&cell(cells, check_number));
        let reference_text = cell(cells, reference);
        result.transactions.push(Txn {
            date: iso,
            description: if described.is_empty() {
                payee_text.clone()
            } else {
                described
            },
            amount: weldsuite_books_domain::js::math_round(signed * 100.0) / 100.0,
            counterparty_name: (!payee_text.is_empty()).then_some(payee_text),
            reference: (!reference_text.is_empty()).then_some(reference_text),
            check_number: (!check.is_empty()).then_some(check),
            raw_data: Some(json!({ "format": "csv", "line": line })),
            ..Txn::default()
        });
    }
    if !result.transactions.is_empty() {
        result.set_date_range();
    }
    result
}

// ── Proposing a layout ──────────────────────────────────────────────────────

fn synonyms(field: &str) -> &'static [&'static str] {
    match field {
        "date" => &[
            "date",
            "posted date",
            "posting date",
            "post date",
            "transaction date",
            "trans date",
            "booking date",
            "effective date",
            "settlement date",
            "completed date",
        ],
        "amount" => &["amount", "transaction amount", "amt", "net amount"],
        "debit" => &[
            "debit",
            "debits",
            "debit amount",
            "withdrawal",
            "withdrawals",
            "money out",
            "paid out",
            "payments out",
            "charges",
        ],
        "credit" => &[
            "credit",
            "credits",
            "credit amount",
            "deposit",
            "deposits",
            "money in",
            "paid in",
        ],
        "checkNumber" => &[
            "check number",
            "check no",
            "check #",
            "check num",
            "checknumber",
            "check or slip #",
            "cheque number",
            "cheque no",
            "cheque",
            "check",
            "chk no",
            "chk #",
        ],
        "reference" => &[
            "reference",
            "reference number",
            "ref",
            "ref no",
            "transaction id",
            "trans id",
            "fitid",
            "confirmation",
            "confirmation number",
        ],
        "description" => &[
            "description",
            "transaction description",
            "original description",
            "extended description",
            "memo",
            "details",
            "narrative",
            "payee description",
        ],
        _ => &["payee", "merchant", "counterparty", "vendor", "name"],
    }
}

fn match_header(headers: &[String], field: &str, taken: &[usize]) -> Option<usize> {
    let normalized: Vec<String> = headers.iter().map(|h| normalize_header(h)).collect();
    for synonym in synonyms(field) {
        if let Some(at) = normalized
            .iter()
            .enumerate()
            .position(|(i, h)| !taken.contains(&i) && h == synonym)
        {
            return Some(at);
        }
    }
    for synonym in synonyms(field) {
        let wanted = format!(" {synonym} ");
        if let Some(at) = normalized
            .iter()
            .enumerate()
            .position(|(i, h)| !taken.contains(&i) && format!(" {h} ").contains(&wanted))
        {
            return Some(at);
        }
    }
    None
}

fn looks_like_date(value: &str) -> bool {
    parse_csv_date(value, "MDY").is_some() || parse_csv_date(value, "DMY").is_some()
}

/// The cell without signs, currency, parentheses, spaces, and a DR / CR.
fn numeric_core(value: &str) -> String {
    let v: String = js_trim(value)
        .chars()
        .filter(|c| {
            !(matches!(c, '(' | ')' | '$' | '€' | '£' | '¥' | '+') || is_minus(*c) || is_space(*c))
        })
        .collect();
    let lower = v.to_ascii_lowercase();
    if lower.ends_with("dr") || lower.ends_with("cr") {
        v[..v.len() - 2].to_owned()
    } else {
        v
    }
}

/// `/^\d[\d.,]*$/`
fn looks_like_number(value: &str) -> bool {
    let v = numeric_core(value);
    v.starts_with(|c: char| c.is_ascii_digit())
        && v.chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
}

/// `/^\d[\d.,]*[.,]\d{1,2}$/`
fn looks_like_money(value: &str) -> bool {
    let v = numeric_core(value);
    if !looks_like_number(&v) {
        return false;
    }
    let Some(mark) = v.rfind(['.', ',']) else {
        return false;
    };
    let decimals = &v[mark + 1..];
    mark >= 1 && (1..=2).contains(&decimals.len()) && decimals.bytes().all(|b| b.is_ascii_digit())
}

fn detect_date_order(cells: &[String]) -> (&'static str, bool) {
    let mut first_over = false;
    let mut second_over = false;
    let mut year_first = false;
    let mut numeric = false;
    for raw in cells {
        let value = TIME_TAIL.replace(js_trim(raw), "");
        if YEAR_FIRST.is_match(&value) {
            year_first = true;
            continue;
        }
        let Some(c) = NUMERIC.captures(&value) else {
            continue;
        };
        numeric = true;
        if num(&c[1]) > 12 {
            first_over = true;
        }
        if num(&c[2]) > 12 {
            second_over = true;
        }
    }
    if !numeric {
        return (if year_first { "YMD" } else { "MDY" }, false);
    }
    if first_over && !second_over {
        return ("DMY", false);
    }
    if second_over && !first_over {
        return ("MDY", false);
    }
    ("MDY", true)
}

fn detect_number_format(cells: &[String]) -> (&'static str, &'static str) {
    let mut comma = 0;
    let mut dot = 0;
    let mut space_thousands = false;
    for raw in cells {
        let v: String = raw
            .chars()
            .filter(|c| {
                !(matches!(c, '(' | ')' | '$' | '€' | '£' | '¥' | '+')
                    || is_minus(*c)
                    || c.is_ascii_alphabetic())
            })
            .collect();
        let v = js_trim(&v);
        let chars: Vec<char> = v.chars().collect();
        if chars.windows(5).any(|w| {
            w[0].is_ascii_digit()
                && matches!(w[1], ' ' | '\u{a0}')
                && w[2..].iter().all(char::is_ascii_digit)
        }) {
            space_thousands = true;
        }
        let s: String = v
            .chars()
            .filter(|c| !is_space(*c) && *c != '\u{a0}')
            .collect();
        let tail_decimals = |mark: char| {
            s.rfind(mark).is_some_and(|at| {
                let rest = &s[at + 1..];
                (1..=2).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit())
            })
        };
        if tail_decimals(',') {
            comma += 1;
        } else if tail_decimals('.') {
            dot += 1;
        }
    }
    let thousands_dot = if space_thousands { " " } else { "." };
    let thousands_comma = if space_thousands { " " } else { "," };
    if comma > dot {
        (",", thousands_dot)
    } else {
        (".", thousands_comma)
    }
}

/// `detectCsvFormat(sample)`: a proposed layout (`CsvFormatProposal`).
#[allow(clippy::too_many_lines)] // mirrors detectCsvFormat step by step
pub(crate) fn detect_csv_format(sample: &str) -> Value {
    let delimiter = detect_delimiter(strip_bom(sample));
    let all = read_records(sample, delimiter);
    let mut warnings: Vec<&str> = Vec::new();

    let mut widths: BTreeMap<usize, usize> = BTreeMap::new();
    for record in &all {
        if record.cells.len() >= 2 {
            *widths.entry(record.cells.len()).or_insert(0) += 1;
        }
    }
    let modal_width = if widths.is_empty() {
        0
    } else {
        modal_of(&widths).0
    };
    let skip_rows = all
        .iter()
        .position(|r| r.cells.len() == modal_width)
        .unwrap_or(0);
    let body = &all[skip_rows.min(all.len())..];
    let first: Vec<String> = body.first().map(|r| r.cells.clone()).unwrap_or_default();
    let has_header = !first.is_empty()
        && !first
            .iter()
            .any(|c| looks_like_date(js_trim(c)) || looks_like_number(c));
    let headers: Vec<String> = if has_header {
        first.iter().map(|c| js_trim(c).to_owned()).collect()
    } else {
        (1..=first.len()).map(|i| format!("Column {i}")).collect()
    };
    let rows: Vec<&Vec<String>> = body
        .iter()
        .skip(usize::from(has_header))
        .map(|r| &r.cells)
        .collect();
    let mut cache: HashMap<usize, Vec<String>> = HashMap::new();
    let mut column_cells = |at: usize| -> Vec<String> {
        cache
            .entry(at)
            .or_insert_with(|| {
                rows.iter()
                    .take(200)
                    .map(|r| r.get(at).map(|c| js_trim(c).to_owned()).unwrap_or_default())
                    .filter(|c| !c.is_empty())
                    .collect()
            })
            .clone()
    };

    let mut taken: Vec<usize> = Vec::new();
    let pick = |field: &str, taken: &mut Vec<usize>| -> Option<usize> {
        let at = if has_header {
            match_header(&headers, field, taken)
        } else {
            None
        };
        if let Some(at) = at {
            taken.push(at);
        }
        at
    };
    let mut date = pick("date", &mut taken);
    let mut amount = pick("amount", &mut taken);
    let debit = if amount.is_none() {
        pick("debit", &mut taken)
    } else {
        None
    };
    let credit = if amount.is_none() {
        pick("credit", &mut taken)
    } else {
        None
    };
    let check_number = pick("checkNumber", &mut taken);
    let reference = pick("reference", &mut taken);
    let mut description = pick("description", &mut taken);
    let payee = pick("payee", &mut taken);

    if !has_header || date.is_none() {
        let guess = (0..headers.len()).find(|i| {
            if taken.contains(i) {
                return false;
            }
            let cells = column_cells(*i);
            !cells.is_empty() && cells.iter().all(|c| looks_like_date(c))
        });
        if date.is_none()
            && let Some(guess) = guess
        {
            date = Some(guess);
            taken.push(guess);
        }
    }
    if amount.is_none() && debit.is_none() && credit.is_none() {
        let guess = (0..headers.len()).find(|i| {
            if taken.contains(i) {
                return false;
            }
            let cells = column_cells(*i);
            !cells.is_empty() && cells.iter().all(|c| looks_like_money(c))
        });
        if let Some(guess) = guess {
            amount = Some(guess);
            taken.push(guess);
        }
    }
    if description.is_none() {
        let mut free: Vec<usize> = (0..headers.len()).filter(|i| !taken.contains(i)).collect();
        let lengths: HashMap<usize, usize> = free
            .iter()
            .map(|i| (*i, column_cells(*i).join("").encode_utf16().count()))
            .collect();
        free.sort_by(|a, b| lengths[b].cmp(&lengths[a]));
        description = payee.or_else(|| free.first().copied());
    }

    let amount_cells: Vec<String> = [amount, debit, credit]
        .into_iter()
        .flatten()
        .flat_map(&mut column_cells)
        .collect();
    let (decimal, thousands) = detect_number_format(&amount_cells);
    let date_cells = date.map(&mut column_cells).unwrap_or_default();
    let (order, ambiguous) = detect_date_order(&date_cells);

    let negative_style = if amount.is_none() && (debit.is_some() || credit.is_some()) {
        "debit_credit_columns"
    } else if amount_cells.iter().any(|c| c.contains('(')) {
        "parentheses"
    } else if amount_cells.iter().any(|c| {
        let t = js_trim(c);
        let mut chars = t.chars().rev();
        chars.next() == Some('-') && chars.next().is_some_and(|d| d.is_ascii_digit())
    }) {
        "trailing_minus"
    } else {
        "minus"
    };

    if date.is_none() {
        warnings.push("No date column found; pick one");
    }
    if amount.is_none() && debit.is_none() && credit.is_none() {
        warnings.push("No amount column found; pick one");
    }
    if ambiguous {
        warnings.push("Every date could be month-first or day-first; confirm the order");
    }
    if !has_header {
        warnings.push("No header row found; columns are given by position");
    }

    let reference_of = |at: Option<usize>| -> Option<Value> {
        at.map(|at| {
            if has_header {
                headers.get(at).map_or(Value::Null, |h| json!(h))
            } else {
                json!(at)
            }
        })
    };
    let mut columns = Map::new();
    columns.insert("date".to_owned(), reference_of(date).unwrap_or(json!(0)));
    columns.insert(
        "description".to_owned(),
        reference_of(description).unwrap_or_else(|| {
            if has_header {
                headers.get(1).map_or(json!(1), |h| json!(h))
            } else {
                json!(1)
            }
        }),
    );
    for (key, at) in [
        ("amount", amount),
        ("debit", debit),
        ("credit", credit),
        ("checkNumber", check_number),
    ] {
        if let Some(value) = reference_of(at) {
            columns.insert(key.to_owned(), value);
        }
    }
    if payee.is_some()
        && payee != description
        && let Some(value) = reference_of(payee)
    {
        columns.insert("payee".to_owned(), value);
    }
    if let Some(value) = reference_of(reference) {
        columns.insert("reference".to_owned(), value);
    }
    if !columns.contains_key("amount")
        && !columns.contains_key("debit")
        && !columns.contains_key("credit")
    {
        let fallback = if has_header {
            headers.get(2).map_or(json!(2), |h| json!(h))
        } else {
            json!(2)
        };
        columns.insert("amount".to_owned(), fallback);
    }
    let sample_rows: Vec<Value> = rows.iter().take(8).map(|r| json!(r)).collect();
    json!({
        "format": {
            "dateFormat": order,
            "decimalSeparator": decimal,
            "thousandsSeparator": thousands,
            "negativeStyle": negative_style,
            "columns": columns,
            "hasHeader": has_header,
            "skipRows": skip_rows,
            "delimiter": delimiter.to_string(),
        },
        "headers": headers,
        "sampleRows": sample_rows,
        "dateOrderAmbiguous": ambiguous,
        "warnings": warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_honour_quotes() {
        let records = read_records("a,\"b,c\"\r\n\"x\"\"y\",\"multi\nline\"\n\n,\n", ',');
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].cells, vec!["a", "b,c"]);
        assert_eq!(records[1].cells, vec!["x\"y", "multi\nline"]);
        assert_eq!(records[1].line, 2);
    }

    #[test]
    fn dates_and_amounts() {
        assert_eq!(
            parse_csv_date("1/15/2024 12:00:00 AM", "MDY").as_deref(),
            Some("2024-01-15")
        );
        assert_eq!(
            parse_csv_date("15/1/2024", "DMY").as_deref(),
            Some("2024-01-15")
        );
        assert_eq!(parse_csv_date("2/30/2024", "MDY"), None);
        assert_eq!(
            parse_csv_date("15 Jan 2024", "MDY").as_deref(),
            Some("2024-01-15")
        );
        assert_eq!(
            parse_csv_date("Jan. 15, 24", "MDY").as_deref(),
            Some("2024-01-15")
        );
        assert_eq!(parse_csv_amount("(1,234.50)", ".", ","), Some(-1234.5));
        assert_eq!(parse_csv_amount("1.234,50-", ",", "."), Some(-1234.5));
        assert_eq!(parse_csv_amount("$12.00 DR", ".", ","), Some(-12.0));
        assert_eq!(parse_csv_amount("abc", ".", ","), None);
        assert_eq!(strip_leading_zeros("0012"), "12");
        assert_eq!(strip_leading_zeros("000"), "0");
        assert_eq!(strip_leading_zeros("00a"), "0a");
    }

    #[test]
    fn proposes_a_us_layout() {
        let sample = "Posted Date,Description,Amount,Check Number\n01/15/2026,ACME CORP,1250.00,\n01/16/2026,CHECK 1042,-75.25,1042\n";
        let proposal = detect_csv_format(sample);
        assert_eq!(proposal["format"]["hasHeader"], json!(true));
        assert_eq!(proposal["format"]["columns"]["date"], json!("Posted Date"));
        assert_eq!(proposal["format"]["columns"]["amount"], json!("Amount"));
        assert_eq!(
            proposal["format"]["columns"]["checkNumber"],
            json!("Check Number")
        );
        assert_eq!(proposal["format"]["dateFormat"], json!("MDY"));
        assert_eq!(proposal["dateOrderAmbiguous"], json!(false));
        let parsed = parse_with_format(sample, &proposal["format"]);
        assert_eq!(parsed.transactions.len(), 2);
        assert_eq!(parsed.transactions[1].check_number.as_deref(), Some("1042"));
        assert_eq!(parsed.transactions[1].amount, -75.25);
    }
}
