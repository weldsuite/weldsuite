//! The Dutch bank CSV exports (ING, ABN AMRO, Rabobank) and the generic
//! header-matched layout (`bank-parsers/csv.ts`). Every other CSV takes an
//! explicit layout (`csv_layout`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use super::{ParseIssue, ParseResult, Txn, is_space, js_trim};

static IBAN_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)([A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7,})(?-u:\b)").expect("iban pattern")
});
static ABN_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Z][A-Za-z\s.'-]+?)(?:\s{2,}|\s?[A-Z]{2}[0-9]{2})").expect("name pattern")
});
static REFERENCE16: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)([0-9]{16})(?-u:\b)").expect("reference pattern"));
static KEYWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:kenmerk|ref(?:erentie)?|reference)[:\s]*([A-Z0-9-]+)")
        .expect("keyword pattern")
});

/// `detectCSVFormat(headerLine, dataLine)`.
fn detect(header: &str, data: &str) -> &'static str {
    let lower = header.to_lowercase();
    if lower.contains("naam / omschrijving")
        || lower.contains("af bij")
        || lower.contains("mutatiesoort")
    {
        return "ing";
    }
    let account_like = |cell: &str| {
        let cell = js_trim(cell);
        (cell.len() >= 9 && cell.bytes().all(|b| b.is_ascii_digit())) || iban_start(cell)
    };
    if header.contains('\t') && !header.starts_with('"') {
        let tabs: Vec<&str> = header.split('\t').collect();
        if tabs.len() >= 7 && account_like(tabs[0]) {
            return "abn";
        }
    }
    if lower.contains("iban")
        && (lower.contains("tegenrekening iban") || lower.contains("naam tegenpartij"))
    {
        return "rabo";
    }
    if data.contains('\t') {
        let tabs: Vec<&str> = data.split('\t').collect();
        if tabs.len() >= 7 && iban_start(js_trim(tabs[0])) {
            return "abn";
        }
    }
    "generic"
}

/// `/^[A-Z]{2}\d{2}/`
fn iban_start(cell: &str) -> bool {
    let b = cell.as_bytes();
    b.len() >= 4
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..4].iter().all(u8::is_ascii_digit)
}

fn lines_of(content: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    js_trim(&normalized)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

/// `knownBankCsv(content)`.
pub(crate) fn known_bank_csv(content: &str) -> Option<&'static str> {
    let lines = lines_of(content);
    if lines.len() < 2 {
        return None;
    }
    match detect(&lines[0], &lines[1]) {
        "generic" => None,
        known => Some(known),
    }
}

/// `parseCSVLine(line, separator)`: quoted fields, doubled quotes.
fn split_line(line: &str, separator: char) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted && c == '"' {
            if chars.get(i + 1) == Some(&'"') {
                current.push('"');
                i += 2;
            } else {
                quoted = false;
                i += 1;
            }
        } else if !quoted && c == '"' {
            quoted = true;
            i += 1;
        } else if !quoted && c == separator {
            fields.push(std::mem::take(&mut current));
            i += 1;
        } else {
            current.push(c);
            i += 1;
        }
    }
    fields.push(current);
    fields
}

fn detect_separator(line: &str) -> char {
    let count = |c: char| line.chars().filter(|x| *x == c).count();
    let (commas, semicolons, tabs) = (count(','), count(';'), count('\t'));
    if tabs > commas && tabs > semicolons {
        '\t'
    } else if semicolons > commas {
        ';'
    } else {
        ','
    }
}

fn headers_of(line: &str, separator: char) -> Vec<String> {
    split_line(line, separator)
        .iter()
        .map(|h| js_trim(&h.to_lowercase()).to_owned())
        .collect()
}

/// `findColumn(headers, candidates)`: an exact header first, then one that
/// contains a candidate; `None` is -1.
fn find_column(headers: &[String], candidates: &[&str]) -> Option<usize> {
    candidates
        .iter()
        .find_map(|c| headers.iter().position(|h| h == c))
        .or_else(|| {
            candidates
                .iter()
                .find_map(|c| headers.iter().position(|h| h.contains(c)))
        })
}

/// `parseDate(value)`: YYYYMMDD, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD.
fn parse_date(value: &str) -> Option<String> {
    let trimmed = js_trim(value).replace('"', "");
    if trimmed.is_empty() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if trimmed.len() == 8 && digits(&trimmed) {
        return Some(format!(
            "{}-{}-{}",
            &trimmed[..4],
            &trimmed[4..6],
            &trimmed[6..]
        ));
    }
    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|p| digits(p))
    {
        return Some(format!("{}-{}-{}", parts[0], parts[1], parts[2]));
    }
    let dmy: Vec<&str> = trimmed.split(['-', '/']).collect();
    if dmy.len() == 3
        && (1..=2).contains(&dmy[0].len())
        && (1..=2).contains(&dmy[1].len())
        && dmy[2].len() == 4
        && dmy.iter().all(|p| digits(p))
    {
        return Some(format!("{}-{:0>2}-{:0>2}", dmy[2], dmy[1], dmy[0]));
    }
    let ymd: Vec<&str> = trimmed.split('/').collect();
    if ymd.len() == 3
        && ymd[0].len() == 4
        && ymd[1].len() == 2
        && ymd[2].len() == 2
        && ymd.iter().all(|p| digits(p))
    {
        return Some(format!("{}-{}-{}", ymd[0], ymd[1], ymd[2]));
    }
    None
}

/// `parseAmount(value)`: Dutch or US separators; unreadable is 0.
fn parse_amount(value: &str) -> f64 {
    let cleaned = js_trim(value).replace('"', "");
    if cleaned.is_empty() {
        return 0.0;
    }
    let mut cleaned: String = cleaned
        .chars()
        .filter(|c| !matches!(c, '€' | '$' | '£') && !is_space(*c))
        .collect();
    if cleaned.contains(',') && cleaned.contains('.') {
        let last_comma = cleaned.rfind(',').unwrap_or(0);
        let last_dot = cleaned.rfind('.').unwrap_or(0);
        if last_comma > last_dot {
            cleaned = cleaned.replace('.', "").replacen(',', ".", 1);
        } else {
            cleaned = cleaned.replace(',', "");
        }
    } else if cleaned.contains(',') {
        cleaned = cleaned.replacen(',', ".", 1);
    }
    let number = weldsuite_books_domain::js::parse_float(&cleaned);
    if number.is_nan() { 0.0 } else { number }
}

/// `extractReferenceFromText`: a 16-digit betalingskenmerk, or a keyword's.
fn reference_from_text(text: &str) -> Option<String> {
    if let Some(caps) = REFERENCE16.captures(text) {
        return Some(caps[1].to_owned());
    }
    KEYWORD.captures(text).map(|caps| caps[1].to_owned())
}

fn cell(fields: &[String], column: Option<usize>) -> Option<&str> {
    column.and_then(|c| fields.get(c)).map(String::as_str)
}

/// `optionalText`: the cell, `None` when absent or empty.
fn optional_text(fields: &[String], column: Option<usize>) -> Option<String> {
    cell(fields, column)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn without_spaces(value: &str) -> String {
    value.chars().filter(|c| !is_space(*c)).collect()
}

fn optional_iban(fields: &[String], column: Option<usize>) -> Option<String> {
    cell(fields, column)
        .map(without_spaces)
        .filter(|v| !v.is_empty())
}

fn optional_date(fields: &[String], column: Option<usize>) -> Option<String> {
    column.and_then(|_| parse_date(cell(fields, column).unwrap_or_default()))
}

fn optional_balance(fields: &[String], column: Option<usize>) -> Option<f64> {
    cell(fields, column)
        .filter(|v| !v.is_empty())
        .map(parse_amount)
}

fn amount_or_zero(fields: &[String], column: Option<usize>) -> f64 {
    match column {
        Some(_) => parse_amount(
            cell(fields, column)
                .filter(|v| !v.is_empty())
                .unwrap_or("0"),
        ),
        None => 0.0,
    }
}

fn required_date(
    fields: &[String],
    column: Option<usize>,
    line: usize,
    result: &mut ParseResult,
) -> Option<String> {
    let raw = cell(fields, column).unwrap_or_default();
    let date = parse_date(raw);
    if date.is_none() {
        let shown = cell(fields, column).map_or("undefined", |v| v);
        result
            .errors
            .push(ParseIssue::at(line, format!("Invalid date: {shown}")));
    }
    date
}

fn raw(format: &str, line: usize) -> serde_json::Value {
    json!({ "format": format, "line": line })
}

fn apply_iban_from_first_row(
    result: &mut ParseResult,
    lines: &[String],
    separator: char,
    column: Option<usize>,
) {
    let Some(column) = column else { return };
    if lines.len() <= 1 {
        return;
    }
    if let Some(value) = split_line(&lines[1], separator)
        .get(column)
        .filter(|v| !v.is_empty())
    {
        result.account_iban = Some(without_spaces(value));
    }
}

fn parse_rows(
    lines: &[String],
    start: usize,
    result: &mut ParseResult,
    mut row: impl FnMut(&str, usize, &mut ParseResult) -> Option<Txn>,
) {
    for (i, line) in lines.iter().enumerate().skip(start) {
        if js_trim(line).is_empty() {
            continue;
        }
        if let Some(txn) = row(line, i + 1, result) {
            result.transactions.push(txn);
        }
    }
}

fn parse_ing(lines: &[String], result: &mut ParseResult) {
    let separator = detect_separator(&lines[0]);
    let headers = headers_of(&lines[0], separator);
    let date = find_column(&headers, &["datum"]);
    let name = find_column(&headers, &["naam / omschrijving", "naam/omschrijving"]);
    let account = find_column(&headers, &["rekening"]);
    let counter = find_column(&headers, &["tegenrekening"]);
    let code = find_column(&headers, &["code"]);
    let af_bij = find_column(&headers, &["af bij"]);
    let amount = find_column(&headers, &["bedrag (eur)", "bedrag"]);
    let description = find_column(&headers, &["mededelingen"]);
    if date.is_none() || amount.is_none() {
        result.errors.push(ParseIssue::new(
            "Could not identify required ING CSV columns",
        ));
        return;
    }
    apply_iban_from_first_row(result, lines, separator, account);
    parse_rows(lines, 1, result, |line, number, result| {
        let fields = split_line(line, separator);
        let date = required_date(&fields, date, number, result)?;
        let mut value = parse_amount(
            cell(&fields, amount)
                .filter(|v| !v.is_empty())
                .unwrap_or("0"),
        );
        if af_bij.is_some() {
            let direction =
                js_trim(&cell(&fields, af_bij).unwrap_or_default().to_lowercase()).to_owned();
            value = if direction == "af" {
                -value.abs()
            } else {
                value.abs()
            };
        }
        let text = optional_text(&fields, description).unwrap_or_default();
        Some(Txn {
            date,
            reference: reference_from_text(&text),
            description: text,
            amount: value,
            counterparty_name: optional_text(&fields, name),
            counterparty_iban: optional_iban(&fields, counter),
            transaction_code: optional_text(&fields, code),
            raw_data: Some(raw("ing", number)),
            ..Txn::default()
        })
    });
}

fn parse_abn(lines: &[String], result: &mut ParseResult) {
    parse_rows(lines, 0, result, |line, number, result| {
        let fields: Vec<String> = line.split('\t').map(|f| js_trim(f).to_owned()).collect();
        if fields.len() < 7 {
            result.errors.push(ParseIssue::at(
                number,
                format!(
                    "Expected at least 7 tab-separated fields, got {}",
                    fields.len()
                ),
            ));
            return None;
        }
        if number == 1 && !fields[0].is_empty() {
            result.account_iban = Some(without_spaces(&fields[0]));
        }
        let Some(date) = parse_date(&fields[2]) else {
            result.errors.push(ParseIssue::at(
                number,
                format!("Invalid date: {}", fields[2]),
            ));
            return None;
        };
        let description = fields.get(7).cloned().unwrap_or_default();
        let iban = IBAN_WORD
            .captures(&description)
            .map(|caps| caps[1].to_owned());
        let name = ABN_NAME
            .captures(&description)
            .map(|caps| js_trim(&caps[1]).to_owned());
        Some(Txn {
            date,
            value_date: parse_date(&fields[5]),
            amount: parse_amount(&fields[6]),
            running_balance: (!fields[4].is_empty()).then(|| parse_amount(&fields[4])),
            counterparty_name: name,
            counterparty_iban: iban,
            reference: reference_from_text(&description),
            description,
            raw_data: Some(raw("abn", number)),
            ..Txn::default()
        })
    });
}

fn parse_rabo(lines: &[String], result: &mut ParseResult) {
    let separator = detect_separator(&lines[0]);
    let h = headers_of(&lines[0], separator);
    let iban = find_column(&h, &["iban/bban", "iban"]);
    let date = find_column(&h, &["datum", "boekdatum", "date"]);
    let value_date = find_column(&h, &["rentedatum", "value date"]);
    let amount = find_column(&h, &["bedrag", "amount"]);
    let counter_name = find_column(&h, &["naam tegenpartij", "tegenpartij"]);
    let counter_iban = find_column(&h, &["tegenrekening iban", "tegenrekening"]);
    let counter_bic = find_column(&h, &["bic tegenpartij"]);
    let descriptions = [
        find_column(&h, &["omschrijving-1", "omschrijving", "description"]),
        find_column(&h, &["omschrijving-2"]),
        find_column(&h, &["omschrijving-3"]),
    ];
    let reference = find_column(&h, &["betalingskenmerk", "payment reference"]);
    let code = find_column(&h, &["code"]);
    let end_to_end = find_column(&h, &["id van de transactie", "end to end id"]);
    let mandate = find_column(&h, &["machtigingsid", "mandate id"]);
    let balance = find_column(&h, &["saldo na trn", "balance after"]);
    if date.is_none() || amount.is_none() {
        result.errors.push(ParseIssue::new(
            "Could not identify required Rabobank CSV columns",
        ));
        return;
    }
    apply_iban_from_first_row(result, lines, separator, iban);
    parse_rows(lines, 1, result, |line, number, result| {
        let fields = split_line(line, separator);
        let date = required_date(&fields, date, number, result)?;
        let description = descriptions
            .iter()
            .filter_map(|column| optional_text(&fields, *column))
            .collect::<Vec<_>>()
            .join(" ");
        Some(Txn {
            date,
            value_date: optional_date(&fields, value_date),
            description: js_trim(&description).to_owned(),
            amount: parse_amount(
                cell(&fields, amount)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("0"),
            ),
            running_balance: optional_balance(&fields, balance),
            counterparty_name: optional_text(&fields, counter_name),
            counterparty_iban: optional_iban(&fields, counter_iban),
            counterparty_bic: optional_text(&fields, counter_bic),
            reference: optional_text(&fields, reference),
            transaction_code: optional_text(&fields, code),
            end_to_end_id: optional_text(&fields, end_to_end),
            mandate_id: optional_text(&fields, mandate),
            raw_data: Some(raw("rabo", number)),
            ..Txn::default()
        })
    });
}

fn parse_generic(lines: &[String], result: &mut ParseResult) {
    let separator = detect_separator(&lines[0]);
    let h = headers_of(&lines[0], separator);
    let date = find_column(
        &h,
        &[
            "date",
            "datum",
            "boekdatum",
            "booking date",
            "transaction date",
        ],
    );
    let value_date = find_column(&h, &["value date", "rentedatum", "valutering"]);
    let description = find_column(
        &h,
        &[
            "description",
            "omschrijving",
            "mededelingen",
            "memo",
            "narrative",
        ],
    );
    let amount = find_column(&h, &["amount", "bedrag", "transaction amount"]);
    let credit = find_column(&h, &["credit", "bij", "credit amount"]);
    let debit = find_column(&h, &["debit", "af", "debit amount"]);
    let balance = find_column(&h, &["balance", "saldo", "running balance"]);
    let counter_name = find_column(
        &h,
        &["counterparty", "naam", "name", "beneficiary", "tegenpartij"],
    );
    let counter_iban = find_column(&h, &["counterparty iban", "tegenrekening", "account"]);
    let reference = find_column(&h, &["reference", "referentie", "betalingskenmerk"]);
    if date.is_none() {
        result
            .errors
            .push(ParseIssue::new("Could not identify date column in CSV"));
        return;
    }
    if amount.is_none() && credit.is_none() && debit.is_none() {
        result.errors.push(ParseIssue::new(
            "Could not identify amount column(s) in CSV",
        ));
        return;
    }
    parse_rows(lines, 1, result, |line, number, result| {
        let fields = split_line(line, separator);
        let date = required_date(&fields, date, number, result)?;
        let value = if amount.is_some() {
            parse_amount(
                cell(&fields, amount)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("0"),
            )
        } else {
            amount_or_zero(&fields, credit) - amount_or_zero(&fields, debit)
        };
        Some(Txn {
            date,
            value_date: optional_date(&fields, value_date),
            description: optional_text(&fields, description).unwrap_or_default(),
            amount: value,
            running_balance: optional_balance(&fields, balance),
            counterparty_name: optional_text(&fields, counter_name),
            counterparty_iban: optional_iban(&fields, counter_iban),
            reference: optional_text(&fields, reference),
            raw_data: Some(raw("generic", number)),
            ..Txn::default()
        })
    });
}

/// `parseCSV(content)`.
pub(crate) fn parse(content: &str) -> ParseResult {
    let mut result = ParseResult::new("csv");
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = js_trim(&normalized);
    if normalized.is_empty() {
        result.errors.push(ParseIssue::new("Empty CSV file"));
        return result;
    }
    let lines: Vec<String> = normalized.split('\n').map(str::to_owned).collect();
    if lines.len() < 2 {
        result
            .errors
            .push(ParseIssue::new("CSV file has no data rows"));
        return result;
    }
    match detect(&lines[0], &lines[1]) {
        "ing" => parse_ing(&lines, &mut result),
        "abn" => parse_abn(&lines, &mut result),
        "rabo" => parse_rabo(&lines, &mut result),
        _ => parse_generic(&lines, &mut result),
    }
    if !result.transactions.is_empty() {
        result.set_date_range();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_ing_export() {
        let file = "\"Datum\",\"Naam / Omschrijving\",\"Rekening\",\"Tegenrekening\",\"Code\",\"Af Bij\",\"Bedrag (EUR)\",\"Mutatiesoort\",\"Mededelingen\"\n\"20260105\",\"Energie BV\",\"NL91INGB0001234567\",\"NL02RABO0123456789\",\"IC\",\"Af\",\"25,50\",\"Incasso\",\"Kenmerk: ABC-1 Factuur\"\n";
        assert_eq!(known_bank_csv(file), Some("ing"));
        let result = parse(file);
        assert_eq!(result.account_iban.as_deref(), Some("NL91INGB0001234567"));
        let txn = &result.transactions[0];
        assert_eq!(txn.amount, -25.5);
        assert_eq!(txn.date, "2026-01-05");
        assert_eq!(txn.reference.as_deref(), Some("ABC-1"));
        assert_eq!(txn.counterparty_name.as_deref(), Some("Energie BV"));
    }

    #[test]
    fn dates_and_amounts() {
        assert_eq!(parse_date("5-1-2026").as_deref(), Some("2026-01-05"));
        assert_eq!(parse_date("2026/01/05").as_deref(), Some("2026-01-05"));
        assert_eq!(parse_date("01/05/26"), None);
        assert_eq!(parse_amount("1.234,56"), 1234.56);
        assert_eq!(parse_amount("1,234.56"), 1234.56);
        assert_eq!(parse_amount("€ -12,5"), -12.5);
        assert_eq!(parse_amount("abc"), 0.0);
    }
}
