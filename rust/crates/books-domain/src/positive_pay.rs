//! Positive Pay issued-check files (`us-compliance/positive-pay`): the checks
//! a company wrote (and voided) in a date range, in a bank's layout. Two
//! generic formats (CSV, fixed width) and a preset per bank; every column,
//! date and amount format, delimiter and width can be overridden per bank
//! account.

use serde_json::{Map, Value, json};

use crate::dates::{is_iso_date, parse_iso};
use crate::js::{math_round, slice_utf16, utf16_len};

/// `POSITIVE_PAY_FORMATS` ids.
pub const POSITIVE_PAY_FORMAT_IDS: [&str; 6] = [
    "generic_csv",
    "generic_fixed",
    "bofa",
    "chase",
    "wells_fargo",
    "us_bank",
];

/// `POSITIVE_PAY_FORMATS` as the routes answer it.
pub fn positive_pay_formats_json() -> Value {
    json!([
        {
            "id": "generic_csv",
            "label": "Generic CSV",
            "kind": "csv",
            "documentation": "generic",
            "needsBankSpec": false,
            "note": "Account number, check number, issue date, amount, payee and void flag, comma separated with a header row. Columns, date and amount format are configurable.",
        },
        {
            "id": "generic_fixed",
            "label": "Generic fixed width",
            "kind": "fixed",
            "documentation": "generic",
            "needsBankSpec": false,
            "note": "Account (12), check number (10), amount in cents (12), date MMDDYYYY (8), payee (40) and a void flag (1), no header. Field order and widths are configurable.",
        },
        {
            "id": "bofa",
            "label": "Bank of America (CashPro)",
            "kind": "csv",
            "documentation": "none",
            "needsBankSpec": true,
            "note": "Template: the issue file specification is not public. Set the columns to the layout Bank of America gave you.",
        },
        {
            "id": "chase",
            "label": "Chase (ACCESS)",
            "kind": "csv",
            "documentation": "none",
            "needsBankSpec": true,
            "note": "Template: Chase's issue file layout is not public. Set the columns to the layout Chase gave you.",
        },
        {
            "id": "wells_fargo",
            "label": "Wells Fargo (CEO)",
            "kind": "csv",
            "documentation": "none",
            "needsBankSpec": true,
            "note": "Template: Wells Fargo's issue file layout is not public. Set the columns to the layout Wells Fargo gave you.",
        },
        {
            "id": "us_bank",
            "label": "U.S. Bank",
            "kind": "fixed",
            "documentation": "third_party",
            "needsBankSpec": true,
            "note": "Fixed length: account (12, zero filled), check number (10, zero filled), amount (12, two implied decimals), date MMDDYYYY, action IS or CN, payee 1 (40), payee 2 (40, optional). From a third-party ERP help page, not from U.S. Bank: confirm it before use.",
            "sourceUrl": "https://support.storis.com/helpRevisions/StorisWebHelp98/Payables/Process_Checks/Actions_and_Field_Details/Bank_Check_File_Format_-_US_Bank.htm",
        },
    ])
}

/// `isPositivePayFormat(value)`.
pub fn is_positive_pay_format(value: &str) -> bool {
    POSITIVE_PAY_FORMAT_IDS.contains(&value)
}

/// The fields a column can hold.
pub const POSITIVE_PAY_FIELDS: [&str; 9] = [
    "account_number",
    "check_number",
    "issue_date",
    "amount",
    "payee",
    "void_flag",
    "void_date",
    "action_code",
    "blank",
];

/// The date formats.
pub const POSITIVE_PAY_DATE_FORMATS: [&str; 6] = [
    "MMDDYYYY",
    "MM/DD/YYYY",
    "YYYYMMDD",
    "YYYY-MM-DD",
    "MMDDYY",
    "MM/DD/YY",
];

/// `PositivePayColumn`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PositivePayColumn {
    pub field: String,
    pub header: Option<String>,
    pub width: Option<usize>,
    /// `left` or `right`.
    pub align: Option<String>,
    /// `" "` or `"0"`.
    pub pad: Option<String>,
    pub literal: Option<String>,
}

impl PositivePayColumn {
    fn of(field: &str, header: Option<&str>, width: Option<usize>) -> Self {
        Self {
            field: field.to_owned(),
            header: header.map(str::to_owned),
            width,
            ..Self::default()
        }
    }
}

/// `PositivePayConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositivePayConfig {
    /// `csv` or `fixed`.
    pub fixed: bool,
    pub columns: Vec<PositivePayColumn>,
    pub date_format: String,
    /// `implied_decimal` (cents) or `decimal`.
    pub implied_decimal: bool,
    pub delimiter: String,
    pub header: bool,
    pub quote_all: bool,
    pub issue_flag: String,
    pub void_flag: String,
    pub action_issue: String,
    pub action_void: String,
    pub payee_max_length: Option<usize>,
    pub uppercase_payee: bool,
    pub line_ending: String,
}

/// `Partial<PositivePayConfig>`: a bank account's overrides, each key only
/// when stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PositivePayOverrides {
    pub fixed: Option<bool>,
    pub columns: Option<Vec<PositivePayColumn>>,
    pub date_format: Option<String>,
    pub implied_decimal: Option<bool>,
    pub delimiter: Option<String>,
    pub header: Option<bool>,
    pub quote_all: Option<bool>,
    pub issue_flag: Option<String>,
    pub void_flag: Option<String>,
    pub action_issue: Option<String>,
    pub action_void: Option<String>,
    pub payee_max_length: Option<usize>,
    pub uppercase_payee: Option<bool>,
    pub line_ending: Option<String>,
}

fn generic_csv() -> PositivePayConfig {
    PositivePayConfig {
        fixed: false,
        columns: vec![
            PositivePayColumn::of("account_number", Some("Account Number"), None),
            PositivePayColumn::of("check_number", Some("Check Number"), None),
            PositivePayColumn::of("issue_date", Some("Issue Date"), None),
            PositivePayColumn::of("amount", Some("Amount"), None),
            PositivePayColumn::of("payee", Some("Payee"), None),
            PositivePayColumn::of("void_flag", Some("Void"), None),
        ],
        date_format: "MM/DD/YYYY".to_owned(),
        implied_decimal: false,
        delimiter: ",".to_owned(),
        header: true,
        quote_all: false,
        issue_flag: String::new(),
        void_flag: "V".to_owned(),
        action_issue: "IS".to_owned(),
        action_void: "CN".to_owned(),
        payee_max_length: None,
        uppercase_payee: false,
        line_ending: "\r\n".to_owned(),
    }
}

fn generic_fixed() -> PositivePayConfig {
    PositivePayConfig {
        fixed: true,
        columns: vec![
            PositivePayColumn::of("account_number", None, Some(12)),
            PositivePayColumn::of("check_number", None, Some(10)),
            PositivePayColumn::of("amount", None, Some(12)),
            PositivePayColumn::of("issue_date", None, Some(8)),
            PositivePayColumn::of("payee", None, Some(40)),
            PositivePayColumn::of("void_flag", None, Some(1)),
        ],
        date_format: "MMDDYYYY".to_owned(),
        implied_decimal: true,
        delimiter: ",".to_owned(),
        header: false,
        quote_all: false,
        issue_flag: " ".to_owned(),
        void_flag: "V".to_owned(),
        action_issue: "IS".to_owned(),
        action_void: "CN".to_owned(),
        payee_max_length: Some(40),
        uppercase_payee: false,
        line_ending: "\r\n".to_owned(),
    }
}

fn us_bank() -> PositivePayConfig {
    PositivePayConfig {
        columns: vec![
            PositivePayColumn::of("account_number", None, Some(12)),
            PositivePayColumn::of("check_number", None, Some(10)),
            PositivePayColumn::of("amount", None, Some(12)),
            PositivePayColumn::of("issue_date", None, Some(8)),
            PositivePayColumn::of("action_code", None, Some(2)),
            PositivePayColumn::of("payee", None, Some(40)),
            PositivePayColumn::of("blank", None, Some(40)),
        ],
        uppercase_payee: false,
        ..generic_fixed()
    }
}

/// `getPositivePayConfig(format, overrides)`.
pub fn get_positive_pay_config(format: &str, o: &PositivePayOverrides) -> PositivePayConfig {
    let preset = match format {
        "generic_fixed" => generic_fixed(),
        "us_bank" => us_bank(),
        _ => generic_csv(),
    };
    PositivePayConfig {
        fixed: o.fixed.unwrap_or(preset.fixed),
        columns: o.columns.clone().unwrap_or(preset.columns),
        date_format: o.date_format.clone().unwrap_or(preset.date_format),
        implied_decimal: o.implied_decimal.unwrap_or(preset.implied_decimal),
        delimiter: o.delimiter.clone().unwrap_or(preset.delimiter),
        header: o.header.unwrap_or(preset.header),
        quote_all: o.quote_all.unwrap_or(preset.quote_all),
        issue_flag: o.issue_flag.clone().unwrap_or(preset.issue_flag),
        void_flag: o.void_flag.clone().unwrap_or(preset.void_flag),
        action_issue: o.action_issue.clone().unwrap_or(preset.action_issue),
        action_void: o.action_void.clone().unwrap_or(preset.action_void),
        payee_max_length: o.payee_max_length.or(preset.payee_max_length),
        uppercase_payee: o.uppercase_payee.unwrap_or(preset.uppercase_payee),
        line_ending: o.line_ending.clone().unwrap_or(preset.line_ending),
    }
}

/// `PositivePayCheck`.
#[derive(Debug, Clone)]
pub struct PositivePayCheck {
    pub check_number: String,
    pub issue_date: String,
    /// Dollars.
    pub amount: f64,
    pub payee: String,
    pub voided: bool,
    pub void_date: Option<String>,
    pub account_number: Option<String>,
}

/// `PositivePayIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositivePayIssue {
    pub error: bool,
    pub code: &'static str,
    pub message: String,
    pub check_number: Option<String>,
}

impl PositivePayIssue {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "severity".to_owned(),
            json!(if self.error { "error" } else { "warning" }),
        );
        out.insert("code".to_owned(), json!(self.code));
        out.insert("message".to_owned(), json!(self.message));
        if let Some(number) = &self.check_number {
            out.insert("checkNumber".to_owned(), json!(number));
        }
        Value::Object(out)
    }
}

/// `PositivePaySuccess`.
#[derive(Debug, Clone)]
pub struct PositivePayFile {
    pub content: String,
    pub file_name: String,
    pub format: String,
    pub record_count: usize,
    pub issue_count: usize,
    pub void_count: usize,
    pub total_issued_cents: i64,
    pub total_voided_cents: i64,
    pub warnings: Vec<PositivePayIssue>,
}

/// `PositivePayFailure`.
#[derive(Debug, Clone)]
pub struct PositivePayRefused {
    pub errors: Vec<PositivePayIssue>,
    pub warnings: Vec<PositivePayIssue>,
}

/// `formatPositivePayDate(date, format)`.
pub fn format_positive_pay_date(date: &str, format: &str) -> String {
    let p = parse_iso(date).unwrap_or(crate::dates::DateParts { y: 0, m: 0, d: 0 });
    let yyyy = format!("{:04}", p.y);
    let mm = format!("{:02}", p.m);
    let dd = format!("{:02}", p.d);
    let yy = &yyyy[2..];
    match format {
        "MMDDYYYY" => format!("{mm}{dd}{yyyy}"),
        "YYYYMMDD" => format!("{yyyy}{mm}{dd}"),
        "YYYY-MM-DD" => format!("{yyyy}-{mm}-{dd}"),
        "MMDDYY" => format!("{mm}{dd}{yy}"),
        "MM/DD/YY" => format!("{mm}/{dd}/{yy}"),
        _ => format!("{mm}/{dd}/{yyyy}"),
    }
}

fn format_amount(cents: i64, implied_decimal: bool) -> String {
    if implied_decimal {
        return cents.to_string();
    }
    format!("{}.{:02}", cents.div_euclid(100), cents.rem_euclid(100))
}

fn csv_cell(value: &str, config: &PositivePayConfig) -> String {
    let needs_quotes = config.quote_all
        || value.contains(config.delimiter.as_str())
        || value.contains(['"', '\r', '\n']);
    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn pad_to(value: &str, width: usize, pad: &str, right: bool) -> String {
    let length = utf16_len(value);
    if length >= width || pad.is_empty() {
        return value.to_owned();
    }
    let filler: String = pad.repeat(width - length).chars().take(width - length).collect();
    if right {
        format!("{filler}{value}")
    } else {
        format!("{value}{filler}")
    }
}

fn fixed_cell(value: &str, column: &PositivePayColumn) -> String {
    let width = column.width.unwrap_or(0);
    let numeric = matches!(
        column.field.as_str(),
        "account_number" | "check_number" | "amount"
    );
    let right = column
        .align
        .as_deref()
        .map_or(numeric, |align| align == "right");
    let pad = column
        .pad
        .clone()
        .unwrap_or_else(|| if numeric { "0" } else { " " }.to_owned());
    let clipped = if utf16_len(value) > width {
        slice_utf16(value, width)
    } else {
        value.to_owned()
    };
    pad_to(&clipped, width, &pad, right)
}

fn compare_check_numbers(a: &str, b: &str) -> std::cmp::Ordering {
    if a.len() == b.len() {
        crate::js::locale_compare(a, b)
    } else {
        a.len().cmp(&b.len())
    }
}

struct Entry<'a> {
    check: &'a PositivePayCheck,
    check_number: String,
    cents: i64,
    voided: bool,
}

/// `buildPositivePayFile(checks, options)`: the issue file for a date range,
/// or every problem found.
#[allow(clippy::too_many_lines)] // the builder, step for step
pub fn build_positive_pay_file(
    checks: &[PositivePayCheck],
    format: &str,
    account_number: &str,
    from: Option<&str>,
    to: Option<&str>,
    overrides: &PositivePayOverrides,
) -> Result<PositivePayFile, PositivePayRefused> {
    let config = get_positive_pay_config(format, overrides);
    let mut errors: Vec<PositivePayIssue> = Vec::new();
    let mut warnings: Vec<PositivePayIssue> = Vec::new();
    let issue = |list: &mut Vec<PositivePayIssue>,
                 error: bool,
                 code: &'static str,
                 message: String,
                 check_number: Option<&str>| {
        list.push(PositivePayIssue {
            error,
            code,
            message,
            check_number: check_number.map(str::to_owned),
        });
    };
    let from = from.filter(|f| !f.is_empty());
    let to = to.filter(|t| !t.is_empty());
    if from.is_some_and(|f| !is_iso_date(f)) || to.is_some_and(|t| !is_iso_date(t)) {
        issue(
            &mut errors,
            true,
            "invalid_range",
            "The date range must be YYYY-MM-DD".to_owned(),
            None,
        );
    } else if let (Some(f), Some(t)) = (from, to)
        && t < f
    {
        issue(
            &mut errors,
            true,
            "invalid_range",
            "The range ends before it starts".to_owned(),
            None,
        );
    }
    if config.fixed {
        for column in &config.columns {
            if column.width.is_none_or(|w| w < 1) {
                issue(
                    &mut errors,
                    true,
                    "missing_width",
                    format!("Fixed column {} needs a width", column.field),
                    None,
                );
            }
        }
    }
    let in_range =
        |date: &str| from.is_none_or(|f| date >= f) && to.is_none_or(|t| date <= t);
    let mut records: Vec<Entry<'_>> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for check in checks {
        let check_number = weldsuite_kit::validation::js_trim(&check.check_number).to_owned();
        let label = (!check_number.is_empty()).then_some(check_number.as_str());
        if !is_iso_date(&check.issue_date)
            || check.void_date.as_deref().is_some_and(|d| !is_iso_date(d))
        {
            issue(
                &mut errors,
                true,
                "invalid_date",
                "Dates must be YYYY-MM-DD".to_owned(),
                label,
            );
            continue;
        }
        let void_date = check
            .voided
            .then(|| check.void_date.clone().unwrap_or_else(|| check.issue_date.clone()));
        let issued_in_range = in_range(&check.issue_date);
        let voided_in_range = void_date.as_deref().is_some_and(in_range);
        if !issued_in_range && !voided_in_range {
            continue;
        }
        if check_number.is_empty() || !check_number.bytes().all(|b| b.is_ascii_digit()) {
            issue(
                &mut errors,
                true,
                "invalid_check_number",
                "A check number is digits only".to_owned(),
                label,
            );
            continue;
        }
        let rounded = math_round(check.amount * 100.0);
        #[allow(clippy::cast_possible_truncation)]
        let cents = rounded as i64;
        if !check.amount.is_finite()
            || check.amount <= 0.0
            || (check.amount * 100.0 - rounded).abs() > 1e-6
        {
            issue(
                &mut errors,
                true,
                "invalid_amount",
                "The amount must be greater than zero with at most two decimals".to_owned(),
                label,
            );
            continue;
        }
        let key = format!(
            "{check_number}{}",
            check.account_number.as_deref().unwrap_or_default()
        );
        if seen.contains(&key) {
            issue(
                &mut errors,
                true,
                "duplicate_check_number",
                format!("Check {check_number} appears twice"),
                label,
            );
        }
        seen.push(key);
        // A check voided by the end of the range is marked void, whatever the range started with.
        let voided = void_date
            .as_deref()
            .is_some_and(|d| to.is_none_or(|t| d <= t));
        records.push(Entry {
            check,
            check_number,
            cents,
            voided,
        });
    }
    if errors.is_empty() && records.is_empty() {
        issue(
            &mut errors,
            true,
            "no_checks",
            "No checks were issued or voided in this range".to_owned(),
            None,
        );
    }
    records.sort_by(|a, b| compare_check_numbers(&a.check_number, &b.check_number));

    let mut lines: Vec<String> = Vec::new();
    if !config.fixed && config.header {
        lines.push(
            config
                .columns
                .iter()
                .map(|c| csv_cell(c.header.as_deref().unwrap_or(&c.field), &config))
                .collect::<Vec<_>>()
                .join(&config.delimiter),
        );
    }
    let width_of = |field: &str| {
        config
            .columns
            .iter()
            .find(|c| c.field == field)
            .and_then(|c| c.width)
    };
    for record in &records {
        let check = record.check;
        let check_number = record.check_number.as_str();
        let account: String = check
            .account_number
            .as_deref()
            .unwrap_or(account_number)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if account.is_empty()
            || !account
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            issue(
                &mut errors,
                true,
                "invalid_account_number",
                "The account number is digits, letters and hyphens only".to_owned(),
                Some(check_number),
            );
            continue;
        }
        if config.fixed {
            if let Some(width) = width_of("account_number")
                && account.len() > width
            {
                issue(
                    &mut errors,
                    true,
                    "account_number_too_long",
                    format!("The account number is wider than the {width}-character column"),
                    Some(check_number),
                );
                continue;
            }
            if let Some(width) = width_of("check_number")
                && check_number.len() > width
            {
                issue(
                    &mut errors,
                    true,
                    "check_number_too_long",
                    format!("Check {check_number} is wider than the {width}-character column"),
                    Some(check_number),
                );
                continue;
            }
        }
        let collapsed = collapse_line_breaks(&check.payee);
        let mut payee = weldsuite_kit::validation::js_trim(&collapsed).to_owned();
        if config.uppercase_payee {
            payee = payee.to_uppercase();
        }
        if payee.is_empty() {
            issue(
                &mut warnings,
                false,
                "missing_payee",
                "The check has no payee name".to_owned(),
                Some(check_number),
            );
        }
        let limit = config
            .payee_max_length
            .or_else(|| if config.fixed { width_of("payee") } else { None });
        if let Some(limit) = limit
            && utf16_len(&payee) > limit
        {
            issue(
                &mut warnings,
                false,
                "payee_trimmed",
                format!("The payee is longer than {limit} characters and was cut"),
                Some(check_number),
            );
            payee = slice_utf16(&payee, limit).trim_end().to_owned();
        }
        let void_date = check
            .voided
            .then(|| check.void_date.clone().unwrap_or_else(|| check.issue_date.clone()));
        let value = |column: &PositivePayColumn| -> String {
            match column.field.as_str() {
                "account_number" => account.clone(),
                "check_number" => check_number.to_owned(),
                "issue_date" => format_positive_pay_date(&check.issue_date, &config.date_format),
                "amount" => format_amount(record.cents, config.implied_decimal),
                "payee" => payee.clone(),
                "void_flag" => if record.voided {
                    config.void_flag.clone()
                } else {
                    config.issue_flag.clone()
                },
                "void_date" => match (&void_date, record.voided) {
                    (Some(date), true) => format_positive_pay_date(date, &config.date_format),
                    _ => String::new(),
                },
                "action_code" => if record.voided {
                    config.action_void.clone()
                } else {
                    config.action_issue.clone()
                },
                _ => column.literal.clone().unwrap_or_default(),
            }
        };
        if config.fixed {
            lines.push(
                config
                    .columns
                    .iter()
                    .map(|c| fixed_cell(&value(c), c))
                    .collect::<String>(),
            );
        } else {
            lines.push(
                config
                    .columns
                    .iter()
                    .map(|c| csv_cell(&value(c), &config))
                    .collect::<Vec<_>>()
                    .join(&config.delimiter),
            );
        }
    }
    if !errors.is_empty() {
        return Err(PositivePayRefused { errors, warnings });
    }
    let last = to.map_or_else(
        || {
            records
                .iter()
                .fold("0000-00-00".to_owned(), |latest, r| {
                    if r.check.issue_date > latest {
                        r.check.issue_date.clone()
                    } else {
                        latest
                    }
                })
        },
        str::to_owned,
    );
    let tail: String = account_number
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let tail = &tail[tail.len().saturating_sub(4)..];
    let issued: Vec<&Entry<'_>> = records.iter().filter(|r| !r.voided).collect();
    let voids: Vec<&Entry<'_>> = records.iter().filter(|r| r.voided).collect();
    Ok(PositivePayFile {
        content: format!(
            "{}{}",
            lines.join(&config.line_ending),
            config.line_ending
        ),
        file_name: format!(
            "positive-pay-{}-{}.{}",
            if tail.is_empty() { "account" } else { tail },
            if is_iso_date(&last) { last.as_str() } else { "file" },
            if config.fixed { "txt" } else { "csv" }
        ),
        format: format.to_owned(),
        record_count: records.len(),
        issue_count: issued.len(),
        void_count: voids.len(),
        total_issued_cents: issued.iter().map(|r| r.cents).sum(),
        total_voided_cents: voids.iter().map(|r| r.cents).sum(),
        warnings,
    })
}

/// `text.replace(/[\r\n]+/g, ' ')`.
fn collapse_line_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(number: &str, date: &str, amount: f64, voided: Option<&str>) -> PositivePayCheck {
        PositivePayCheck {
            check_number: number.to_owned(),
            issue_date: date.to_owned(),
            amount,
            payee: "Charlie Supply".to_owned(),
            voided: voided.is_some(),
            void_date: voided.map(str::to_owned),
            account_number: None,
        }
    }

    #[test]
    fn a_csv_file() {
        let file = build_positive_pay_file(
            &[
                check("1002", "2026-11-03", 80.0, None),
                check("1001", "2026-11-02", 300.0, Some("2026-11-04")),
            ],
            "generic_csv",
            "000123456789",
            None,
            None,
            &PositivePayOverrides::default(),
        )
        .expect("file");
        assert_eq!(
            file.content,
            "Account Number,Check Number,Issue Date,Amount,Payee,Void\r\n000123456789,1001,11/02/2026,300.00,Charlie Supply,V\r\n000123456789,1002,11/03/2026,80.00,Charlie Supply,\r\n"
        );
        assert_eq!(file.file_name, "positive-pay-6789-2026-11-03.csv");
        assert_eq!((file.issue_count, file.void_count), (1, 1));
    }

    #[test]
    fn a_fixed_file() {
        let file = build_positive_pay_file(
            &[check("1001", "2026-11-02", 300.0, None)],
            "us_bank",
            "000123456789",
            None,
            Some("2026-11-30"),
            &PositivePayOverrides::default(),
        )
        .expect("file");
        assert_eq!(
            file.content,
            format!(
                "000123456789000000100100000003000011022026IS{}{}\r\n",
                format!("{:<40}", "Charlie Supply"),
                " ".repeat(40)
            )
        );
        assert_eq!(file.file_name, "positive-pay-6789-2026-11-30.txt");
    }

    #[test]
    fn nothing_in_range() {
        let refused = build_positive_pay_file(
            &[check("1001", "2026-11-02", 300.0, None)],
            "generic_csv",
            "1",
            Some("2026-12-01"),
            None,
            &PositivePayOverrides::default(),
        )
        .expect_err("refused");
        assert_eq!(refused.errors[0].code, "no_checks");
    }
}
