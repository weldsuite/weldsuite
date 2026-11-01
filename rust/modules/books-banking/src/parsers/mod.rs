//! Bank statement files (`services/bank-parsers/*`): OFX / QFX / QBO, BAI2,
//! MT940, CAMT.053, the Dutch bank CSV exports and CSV with an explicit
//! layout, read into one shape ([`ParseResult`]) the import routes write.
//!
//! JavaScript semantics are kept where they show: keys a parser leaves
//! `undefined` are absent from the JSON, numbers print as JavaScript prints
//! them, and dates are calendar dates (`YYYY-MM-DD`) never shifted by a time
//! zone.

mod bai2;
mod camt053;
mod csv;
pub(crate) mod csv_layout;
mod ids;
mod mt940;
mod ofx;

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::number_value;

pub(crate) use ids::{occurrence_counter, synthetic_external_id};

/// `ParsedBankTransaction`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Txn {
    /// `YYYY-MM-DD`.
    pub(crate) date: String,
    pub(crate) value_date: Option<String>,
    pub(crate) description: String,
    /// Signed from the account holder's side: money in positive.
    pub(crate) amount: f64,
    pub(crate) running_balance: Option<f64>,
    pub(crate) counterparty_name: Option<String>,
    pub(crate) counterparty_iban: Option<String>,
    pub(crate) counterparty_bic: Option<String>,
    pub(crate) reference: Option<String>,
    pub(crate) transaction_code: Option<String>,
    pub(crate) check_number: Option<String>,
    pub(crate) end_to_end_id: Option<String>,
    pub(crate) mandate_id: Option<String>,
    pub(crate) external_id: Option<String>,
    pub(crate) raw_data: Option<Value>,
}

impl Txn {
    /// The object as `JSON.stringify` writes it (`undefined` keys left out).
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("date".to_owned(), json!(self.date));
        put(&mut out, "valueDate", self.value_date.as_ref());
        out.insert("description".to_owned(), json!(self.description));
        out.insert("amount".to_owned(), number_value(self.amount));
        if let Some(balance) = self.running_balance {
            out.insert("runningBalance".to_owned(), number_value(balance));
        }
        put(
            &mut out,
            "counterpartyName",
            self.counterparty_name.as_ref(),
        );
        put(
            &mut out,
            "counterpartyIban",
            self.counterparty_iban.as_ref(),
        );
        put(&mut out, "counterpartyBic", self.counterparty_bic.as_ref());
        put(&mut out, "reference", self.reference.as_ref());
        put(&mut out, "transactionCode", self.transaction_code.as_ref());
        put(&mut out, "checkNumber", self.check_number.as_ref());
        put(&mut out, "endToEndId", self.end_to_end_id.as_ref());
        put(&mut out, "mandateId", self.mandate_id.as_ref());
        put(&mut out, "externalId", self.external_id.as_ref());
        if let Some(raw) = &self.raw_data {
            out.insert("rawData".to_owned(), raw.clone());
        }
        Value::Object(out)
    }
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), Value::String(value.clone()));
    }
}

/// `ParsedStatementAccount`.
#[derive(Debug, Clone, Default)]
pub(crate) struct StatementAccount {
    pub(crate) account_number: Option<String>,
    pub(crate) routing_number: Option<String>,
    pub(crate) account_type: Option<String>,
    pub(crate) currency: Option<String>,
}

impl StatementAccount {
    /// `{ ...account, accountNumber: undefined, accountNumberLast4 }` as the
    /// preview answers it.
    pub(crate) fn masked_json(&self) -> Value {
        let mut out = Map::new();
        put(&mut out, "routingNumber", self.routing_number.as_ref());
        put(&mut out, "accountType", self.account_type.as_ref());
        put(&mut out, "currency", self.currency.as_ref());
        if let Some(number) = &self.account_number {
            let units: Vec<u16> = number.encode_utf16().collect();
            let last = String::from_utf16_lossy(&units[units.len().saturating_sub(4)..]);
            out.insert("accountNumberLast4".to_owned(), Value::String(last));
        }
        Value::Object(out)
    }
}

/// One parse problem: `{ line?, message }`.
#[derive(Debug, Clone)]
pub(crate) struct ParseIssue {
    pub(crate) line: Option<usize>,
    pub(crate) message: String,
}

impl ParseIssue {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            line: None,
            message: message.into(),
        }
    }

    pub(crate) fn at(line: usize, message: impl Into<String>) -> Self {
        Self {
            line: Some(line),
            message: message.into(),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        match self.line {
            Some(line) => json!({ "line": line, "message": self.message }),
            None => json!({ "message": self.message }),
        }
    }
}

/// `BankFileParseResult`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ParseResult {
    pub(crate) format: String,
    pub(crate) account_iban: Option<String>,
    pub(crate) account: Option<StatementAccount>,
    pub(crate) accounts: Option<Vec<StatementAccount>>,
    pub(crate) currency: Option<String>,
    pub(crate) opening_balance: Option<f64>,
    pub(crate) closing_balance: Option<f64>,
    pub(crate) available_balance: Option<f64>,
    pub(crate) balance_date: Option<String>,
    pub(crate) date_range: Option<(String, String)>,
    pub(crate) transactions: Vec<Txn>,
    pub(crate) errors: Vec<ParseIssue>,
}

impl ParseResult {
    pub(crate) fn new(format: &str) -> Self {
        Self {
            format: format.to_owned(),
            ..Self::default()
        }
    }

    /// `{ from, to }` of the transactions' dates (string order is date order).
    pub(crate) fn set_date_range(&mut self) {
        let mut dates: Vec<&String> = self.transactions.iter().map(|t| &t.date).collect();
        dates.sort();
        if let (Some(first), Some(last)) = (dates.first(), dates.last()) {
            self.date_range = Some(((*first).clone(), (*last).clone()));
        }
    }

    pub(crate) fn date_range_json(&self) -> Value {
        match &self.date_range {
            Some((from, to)) => json!({ "from": from, "to": to }),
            None => Value::Null,
        }
    }

    pub(crate) fn errors_json(&self) -> Value {
        Value::Array(self.errors.iter().map(ParseIssue::to_json).collect())
    }
}

/// `CsvFormatRequiredError`: a CSV without a known bank layout and no
/// explicit one; carries the proposed layout.
#[derive(Debug, Clone)]
pub(crate) struct CsvFormatRequired {
    pub(crate) message: String,
    pub(crate) proposal: Value,
}

/// `BankParseOptions`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ParseOptions {
    pub(crate) file_name: Option<String>,
    /// The parsed `CsvFormat`, as the schema read it.
    pub(crate) csv_format: Option<Value>,
    pub(crate) account_last4: Option<String>,
}

/// `content.replace(/^﻿/, '')`.
pub(crate) fn strip_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

/// `/\.([A-Za-z0-9]+)$/` of the file name, lower-cased.
fn extension_of(file_name: Option<&str>) -> String {
    let name = file_name.unwrap_or_default();
    let tail: String = name
        .chars()
        .rev()
        .take_while(char::is_ascii_alphanumeric)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let before = &name[..name.len() - tail.len()];
    if !tail.is_empty() && before.ends_with('.') {
        tail.to_ascii_lowercase()
    } else {
        String::new()
    }
}

/// `parseBankFile(content, format, options)`: detect the format (or take the
/// forced one) and parse.
pub(crate) fn parse_bank_file(
    content: &str,
    format: Option<&str>,
    options: &ParseOptions,
) -> Result<ParseResult, CsvFormatRequired> {
    let text = strip_bom(content);
    let mut detected = format.map_or_else(
        || detect_format(text, options.file_name.as_deref()).to_owned(),
        str::to_owned,
    );
    if detected == "ofx" {
        let extension = extension_of(options.file_name.as_deref());
        if extension == "qfx" || extension == "qbo" {
            detected = extension;
        }
    }
    let last4 = options.account_last4.as_deref();
    Ok(match detected.as_str() {
        "mt940" => mt940::parse(text),
        "camt053" => camt053::parse(text),
        "ofx" | "qfx" | "qbo" => ofx::parse(text, &detected, last4),
        "bai2" => bai2::parse(text, last4),
        _ => return parse_csv(text, options),
    })
}

fn parse_csv(content: &str, options: &ParseOptions) -> Result<ParseResult, CsvFormatRequired> {
    if let Some(format) = &options.csv_format {
        return Ok(csv_layout::parse_with_format(content, format));
    }
    if csv::known_bank_csv(content).is_some() {
        return Ok(csv::parse(content));
    }
    Err(CsvFormatRequired {
        message: "This CSV has no known bank layout. Confirm the date order, number format and columns, then import again.".to_owned(),
        proposal: csv_layout::detect_csv_format(content),
    })
}

/// `detectFormat(content, fileName)`.
pub(crate) fn detect_format(content: &str, file_name: Option<&str>) -> &'static str {
    let trimmed = content.trim_start_matches(is_space);
    // Lines as a multiline `^` sees them.
    let lines: Vec<&str> = trimmed
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .collect();
    if trimmed.starts_with(":20:")
        || lines
            .iter()
            .any(|l| l.starts_with(":60F:") || l.starts_with(":60M:"))
    {
        return "mt940";
    }
    if trimmed.contains("<BkToCstmrStmt")
        || trimmed.contains("<Document")
        || trimmed.contains("camt.053")
    {
        return "camt053";
    }
    let units: Vec<u16> = trimmed.encode_utf16().take(600).collect();
    let head = String::from_utf16_lossy(&units);
    if starts_with_ignore_case(trimmed, "OFXHEADER:")
        || contains_ofx_instruction(&head)
        || contains_ofx_element(trimmed)
    {
        let extension = extension_of(file_name);
        return match extension.as_str() {
            "qfx" => "qfx",
            "qbo" => "qbo",
            _ => "ofx",
        };
    }
    // `/^01,[^\n]*\/\s*$/m` and `/^0[23],/m`
    let header = lines
        .iter()
        .any(|l| l.starts_with("01,") && l.trim_end_matches(is_space).ends_with('/'));
    if header
        && lines
            .iter()
            .any(|l| l.starts_with("02,") || l.starts_with("03,"))
    {
        return "bai2";
    }
    "csv"
}

/// JavaScript's `\s`.
pub(crate) fn is_space(c: char) -> bool {
    weldsuite_books_domain::jurisdictions::is_js_space(c)
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// `/<\?OFX\b/i`.
fn contains_ofx_instruction(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("<?ofx").any(|(at, m)| {
        lower[at + m.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
    })
}

/// `/<OFX[\s>]/i`.
pub(crate) fn contains_ofx_element(text: &str) -> bool {
    ofx_element_at(text).is_some()
}

/// Where `/<OFX[\s>]/i` first matches (`content.search(...)`), in bytes.
pub(crate) fn ofx_element_at(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("<ofx").find_map(|(at, m)| {
        lower[at + m.len()..]
            .chars()
            .next()
            .filter(|c| *c == '>' || is_space(*c))
            .map(|_| at)
    })
}

/// `cleanText`: whitespace runs collapsed to one space, trimmed.
pub(crate) fn clean_text(value: Option<&str>) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in value.unwrap_or_default().chars() {
        if is_space(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// JavaScript's `.trim()`.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_space)
}

/// `last4(value)` of the OFX and BAI2 readers: letters and digits only,
/// the last four lower-cased, when there are four.
pub(crate) fn last4_of(value: Option<&str>) -> Option<String> {
    let cleaned: Vec<char> = value
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    (cleaned.len() >= 4).then(|| {
        cleaned[cleaned.len() - 4..]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase()
    })
}

/// `amount.toFixed(2)`.
pub(crate) fn fixed2(amount: f64) -> String {
    weldsuite_books_domain::js::to_fixed(amount, 2)
}

/// `selectSection`: the only section, or the one whose account ends in
/// `account_last4`; otherwise the error saying why none was picked.
pub(crate) fn select_section<T>(
    sections: &[T],
    account_number: impl Fn(&T) -> Option<&str>,
    account_last4: Option<&str>,
    errors: &mut Vec<ParseIssue>,
) -> Option<usize> {
    if sections.len() == 1 {
        return Some(0);
    }
    let wanted = account_last4.map(str::to_lowercase);
    if let Some(wanted) = &wanted
        && let Some(at) = sections
            .iter()
            .position(|s| last4_of(account_number(s)).as_deref() == Some(wanted.as_str()))
    {
        return Some(at);
    }
    let ends = sections
        .iter()
        .map(|s| last4_of(account_number(s)).unwrap_or_else(|| "?".to_owned()))
        .collect::<Vec<_>>()
        .join(", ");
    let count = sections.len();
    errors.push(ParseIssue::new(match wanted {
        Some(wanted) => {
            format!("This file holds {count} accounts (ending {ends}); none ends in {wanted}")
        }
        None => format!(
            "This file holds {count} accounts (ending {ends}); set the account number on the bank account so the right one can be picked"
        ),
    }));
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_are_detected_from_the_content() {
        assert_eq!(detect_format(":20:STMT\n:25:NL91", None), "mt940");
        assert_eq!(
            detect_format("<?xml?><Document><BkToCstmrStmt>", None),
            "camt053"
        );
        assert_eq!(detect_format("OFXHEADER:100\n<OFX>", Some("a.qfx")), "qfx");
        assert_eq!(
            detect_format("<?OFX OFXHEADER=\"200\"?>\n<OFX>", None),
            "ofx"
        );
        assert_eq!(
            detect_format("01,ABC,DEF,260301,0800,1,,,2/\n02,X,Y,1,260228/\n", None),
            "bai2"
        );
        assert_eq!(detect_format("Date,Amount\n1/2/2026,3.00", None), "csv");
    }

    #[test]
    fn extensions_and_text() {
        assert_eq!(extension_of(Some("Statement.QFX")), "qfx");
        assert_eq!(extension_of(Some("noext")), "");
        assert_eq!(clean_text(Some("  a \n b\t ")), "a b");
        assert_eq!(last4_of(Some("12-34 5678")).as_deref(), Some("5678"));
        assert_eq!(last4_of(Some("12")), None);
    }
}
