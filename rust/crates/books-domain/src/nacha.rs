//! NACHA ACH files for vendor payment runs (`us-compliance/nacha`): the
//! builder (credits to vendors' bank accounts, one batch per SEC header
//! code, an optional offsetting debit per batch, prenotes, Same Day ACH)
//! and a verifier that re-reads a file the way a bank's intake would.
//!
//! 94-character records, blocking factor 10: 1 File Header, 5 Batch Header,
//! 6 Entry Detail, 7 Addenda (type 05), 8 Batch Control, 9 File Control.
//! Trace numbers are the ODFI's 8 digits plus a 7-digit sequence that keeps
//! counting across the batches of one file. "PAYROLL" and "PURCHASE" are
//! reserved entry descriptions.

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::dates::{
    add_days, format_iso, is_iso_date, last_weekday_of_month, nth_weekday_of_month, parse_iso,
    weekday_of,
};
use crate::js::to_fixed;

/// The SEC codes a vendor run pays with (`CCD+` is a CCD entry with one
/// addenda record).
pub const NACHA_SEC_CODES: [&str; 4] = ["PPD", "CCD", "CCD+", "CTX"];

pub const NACHA_RECORD_LENGTH: usize = 94;
pub const NACHA_BLOCKING_FACTOR: usize = 10;
/// Largest amount of one entry: 10 digits of cents.
pub const NACHA_MAX_AMOUNT_CENTS: i64 = 9_999_999_999;
/// Addenda records one CTX entry can carry (a 4-digit count).
pub const NACHA_MAX_CTX_ADDENDA: usize = 9_999;
pub const NACHA_ADDENDA_TEXT_LENGTH: usize = 80;
/// Settlement time written to the descriptor when a same-day file does not
/// name one.
pub const DEFAULT_SAME_DAY_SETTLEMENT: &str = "1700";

/// `sameDayLimitDollars(date)`: $1M a payment, $10M from 17 September 2027.
pub fn same_day_limit_dollars(date: &str) -> i64 {
    if date >= "2027-09-17" {
        10_000_000
    } else {
        1_000_000
    }
}

// ── Issues ──────────────────────────────────────────────────────────────────

/// `NachaIssue`: an error stops the file, a warning rides along with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NachaIssue {
    pub error: bool,
    pub code: &'static str,
    pub message: String,
    pub payment_id: Option<String>,
    pub field: Option<String>,
}

impl NachaIssue {
    /// The issue as TypeScript serializes it (`paymentId` and `field` only
    /// when set).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "severity".to_owned(),
            Value::String(if self.error { "error" } else { "warning" }.to_owned()),
        );
        out.insert("code".to_owned(), Value::String(self.code.to_owned()));
        out.insert("message".to_owned(), Value::String(self.message.clone()));
        if let Some(id) = &self.payment_id {
            out.insert("paymentId".to_owned(), Value::String(id.clone()));
        }
        if let Some(field) = &self.field {
            out.insert("field".to_owned(), Value::String(field.clone()));
        }
        Value::Object(out)
    }
}

#[derive(Default)]
struct Collector {
    errors: Vec<NachaIssue>,
    warnings: Vec<NachaIssue>,
}

impl Collector {
    fn push(
        &mut self,
        error: bool,
        code: &'static str,
        message: String,
        field: Option<&str>,
        payment_id: Option<&str>,
    ) {
        let issue = NachaIssue {
            error,
            code,
            message,
            payment_id: payment_id.map(str::to_owned),
            field: field.map(str::to_owned),
        };
        if error {
            self.errors.push(issue);
        } else {
            self.warnings.push(issue);
        }
    }

    fn error(
        &mut self,
        code: &'static str,
        message: impl Into<String>,
        field: Option<&str>,
        payment_id: Option<&str>,
    ) {
        self.push(true, code, message.into(), field, payment_id);
    }

    fn warn(
        &mut self,
        code: &'static str,
        message: impl Into<String>,
        field: Option<&str>,
        payment_id: Option<&str>,
    ) {
        self.push(false, code, message.into(), field, payment_id);
    }
}

// ── Routing numbers, text and dates ─────────────────────────────────────────

const ABA_WEIGHTS: [u32; 9] = [3, 7, 1, 3, 7, 1, 3, 7, 1];

fn all_digits(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_digit())
}

/// `abaChecksumValid(routingNumber)`: weights 3, 7, 1 repeating over the
/// nine digits, the sum divisible by 10.
pub fn aba_checksum_valid(routing_number: &str) -> bool {
    if !all_digits(routing_number, 9) {
        return false;
    }
    let sum: u32 = routing_number
        .bytes()
        .zip(ABA_WEIGHTS)
        .map(|(digit, weight)| u32::from(digit - b'0') * weight)
        .sum();
    sum % 10 == 0
}

/// `companyIdFromEin(ein)`: "1" plus the 9-digit EIN; `None` where
/// TypeScript throws (not 9 digits).
pub fn company_id_from_ein(ein: &str) -> Option<String> {
    let digits: String = ein.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 9).then(|| format!("1{digits}"))
}

/// `text.normalize('NFD').replace(/[̀-ͯ]/g, '')`.
fn strip_accents(text: &str) -> String {
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect()
}

/// The characters every ODFI accepts (upper case).
fn ach_allowed(c: char) -> bool {
    c.is_ascii_uppercase()
        || c.is_ascii_digit()
        || matches!(
            c,
            ' ' | '.'
                | ','
                | '&'
                | '\''
                | '#'
                | '('
                | ')'
                | '@'
                | '-'
                | '/'
                | '$'
                | '%'
                | '+'
                | ':'
                | ';'
                | '?'
                | '!'
        )
}

/// `sanitizeAchText(text)`: upper case, accents removed, anything outside
/// the characters every ODFI accepts turned into a space, runs of spaces
/// collapsed, trimmed.
pub fn sanitize_ach_text(text: &str) -> String {
    let upper = strip_accents(text).to_uppercase();
    let mut out = String::with_capacity(upper.len());
    for c in upper.chars() {
        let c = if ach_allowed(c) { c } else { ' ' };
        if c == ' ' && out.ends_with(' ') {
            continue;
        }
        out.push(c);
    }
    out.trim_matches(' ').to_owned()
}

/// `sanitizeAddenda(text)`: addenda keep the X12 delimiters and any other
/// printable ASCII; every UTF-16 unit outside it becomes a space.
fn sanitize_addenda(text: &str) -> String {
    let upper = strip_accents(text).to_uppercase();
    let mut out = String::with_capacity(upper.len());
    for c in upper.chars() {
        if (' '..='~').contains(&c) {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push(' ');
            }
        }
    }
    out
}

fn yymmdd(date: &str) -> String {
    let p = parse_iso(date).unwrap_or(crate::dates::DateParts { y: 2000, m: 1, d: 1 });
    format!("{:02}{:02}{:02}", p.y.rem_euclid(100), p.m, p.d)
}

/// Federal Reserve holidays: a holiday on a Sunday closes the Monday; one on
/// a Saturday closes nothing.
fn fed_holidays(year: i64) -> Vec<String> {
    const MON: i64 = 1;
    const THU: i64 = 4;
    let fixed = |m: i64, d: i64| -> Option<String> {
        let date = format_iso(year, m, d);
        match weekday_of(&date) {
            Some(6) => None,
            Some(0) => add_days(&date, 1),
            _ => Some(date),
        }
    };
    [
        fixed(1, 1),
        Some(nth_weekday_of_month(year, 1, MON, 3)),
        Some(nth_weekday_of_month(year, 2, MON, 3)),
        Some(last_weekday_of_month(year, 5, MON)),
        fixed(6, 19),
        fixed(7, 4),
        Some(nth_weekday_of_month(year, 9, MON, 1)),
        Some(nth_weekday_of_month(year, 10, MON, 2)),
        fixed(11, 11),
        Some(nth_weekday_of_month(year, 11, THU, 4)),
        fixed(12, 25),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// `isAchBankingDay(date)`: a weekday that is not a Federal Reserve holiday.
pub fn is_ach_banking_day(date: &str) -> bool {
    let Some(weekday) = weekday_of(date) else {
        return false;
    };
    if weekday == 0 || weekday == 6 {
        return false;
    }
    let year = parse_iso(date).map_or(0, |p| p.y);
    !fed_holidays(year).iter().any(|d| d == date)
        && !fed_holidays(year + 1).iter().any(|d| d == date)
}

/// `nextAchBankingDay(date)`: the date itself when it is a banking day,
/// otherwise the next one.
pub fn next_ach_banking_day(date: &str) -> String {
    let mut current = date.to_owned();
    while !is_ach_banking_day(&current) {
        match add_days(&current, 1) {
            Some(next) => current = next,
            None => break,
        }
    }
    current
}

/// `suggestEffectiveEntryDate(requested, fileDate, sameDay)`: the file's own
/// date for Same Day ACH, otherwise the requested date, never earlier than
/// the next banking day after the file is made.
pub fn suggest_effective_entry_date(requested: &str, file_date: &str, same_day: bool) -> String {
    if same_day {
        return next_ach_banking_day(file_date);
    }
    let earliest = next_ach_banking_day(&add_days(file_date, 1).unwrap_or_default());
    next_ach_banking_day(if requested < earliest.as_str() {
        &earliest
    } else {
        requested
    })
}

/// `buildRmrSegments(items)`: one X12 RMR segment per invoice
/// (`RMR*IV*INV-1042**1250.00\`).
pub fn build_rmr_segments(items: &[(String, f64)]) -> String {
    items
        .iter()
        .map(|(reference, amount)| {
            let cleaned: String = reference
                .chars()
                .map(|c| if matches!(c, '*' | '\\' | '~') { ' ' } else { c })
                .collect();
            format!(
                "RMR*IV*{}**{}\\",
                weldsuite_kit::validation::js_trim(&cleaned),
                to_fixed(*amount, 2)
            )
        })
        .collect()
}

// ── Field formatting ────────────────────────────────────────────────────────

/// `alpha(value, length)`: cut or space-padded (ASCII by construction).
fn alpha(value: &str, length: usize) -> String {
    let units: Vec<char> = value.chars().collect();
    if units.len() >= length {
        units[..length].iter().collect()
    } else {
        format!("{value}{}", " ".repeat(length - units.len()))
    }
}

/// `numeric(value, length)`: zero-padded; `Err` where TypeScript throws.
fn numeric(value: i64, length: usize) -> Result<String, String> {
    let text = value.to_string();
    if text.len() > length {
        return Err(format!("{value} does not fit in {length} digits"));
    }
    Ok(format!("{text:0>length$}"))
}

fn assert_line(line: String) -> Result<String, String> {
    if line.chars().count() == NACHA_RECORD_LENGTH {
        Ok(line)
    } else {
        Err(format!(
            "NACHA record is {} characters: {line}",
            line.chars().count()
        ))
    }
}

/// `{ credit, prenote, debit }` transaction codes of an account type.
fn transaction_codes(savings: bool) -> (&'static str, &'static str, &'static str) {
    if savings {
        ("32", "33", "37")
    } else {
        ("22", "23", "27")
    }
}

/// `n.toLocaleString('en-US')` of a whole number.
fn grouped(n: i64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A vendor credit (or prenote) of a file.
#[derive(Debug, Clone, Default)]
pub struct NachaPayment {
    pub id: String,
    /// `secCode`; the file's default when `None`.
    pub sec_code: Option<String>,
    pub name: String,
    pub routing_number: String,
    pub account_number: String,
    /// `checking` or `savings`.
    pub savings: bool,
    /// Dollars; ignored for a prenote.
    pub amount: f64,
    pub prenote: bool,
    pub identification: Option<String>,
    pub payment_info: Option<String>,
}

/// The originator's own account, debited by a balanced file's offset entry.
#[derive(Debug, Clone, Default)]
pub struct NachaOffsetAccount {
    pub routing_number: String,
    pub account_number: String,
    pub savings: bool,
    pub name: Option<String>,
    pub identification: Option<String>,
}

/// `NachaOriginator`.
#[derive(Debug, Clone, Default)]
pub struct NachaOriginator {
    pub immediate_destination: String,
    pub immediate_destination_name: String,
    pub immediate_origin: String,
    pub immediate_origin_name: String,
    pub company_name: String,
    pub company_identification: String,
    pub odfi_routing_number: Option<String>,
    pub reference_code: Option<String>,
    pub company_discretionary_data: Option<String>,
    pub offset_account: Option<NachaOffsetAccount>,
}

/// `NachaFileInput`.
#[derive(Debug, Clone, Default)]
pub struct NachaFileInput {
    pub originator: NachaOriginator,
    pub payments: Vec<NachaPayment>,
    pub effective_entry_date: String,
    /// `fileCreation.date`.
    pub file_date: String,
    /// `fileCreation.time`, `HHMM`.
    pub file_time: Option<String>,
    pub file_id_modifier: Option<String>,
    pub default_sec_code: Option<String>,
    pub entry_description: Option<String>,
    pub balanced: bool,
    pub same_day: bool,
    /// `sameDay: { settlementTime }`.
    pub same_day_settlement: Option<String>,
    pub descriptive_date: Option<String>,
    pub starting_batch_number: Option<i64>,
    pub starting_trace_sequence: Option<i64>,
    /// `\r\n` unless `\n`.
    pub lf_only: bool,
}

/// `NachaTrace`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NachaTrace {
    /// `None` for an offsetting entry.
    pub payment_id: Option<String>,
    pub kind: &'static str,
    pub trace_number: String,
    pub batch_number: i64,
}

/// `NachaBatchSummary`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NachaBatchSummary {
    pub batch_number: i64,
    pub sec_code: &'static str,
    pub service_class_code: i64,
    pub entry_addenda_count: i64,
    pub entry_hash: String,
    pub total_debit_cents: i64,
    pub total_credit_cents: i64,
}

/// `NachaBuildSuccess`.
#[derive(Debug, Clone)]
pub struct NachaBuilt {
    pub content: String,
    pub lines: Vec<String>,
    pub record_count: usize,
    pub block_count: usize,
    pub batch_count: usize,
    pub entry_addenda_count: i64,
    pub entry_hash: String,
    pub total_debit_cents: i64,
    pub total_credit_cents: i64,
    pub batches: Vec<NachaBatchSummary>,
    pub traces: Vec<NachaTrace>,
    pub warnings: Vec<NachaIssue>,
}

/// `NachaBuildFailure`: every problem, no file.
#[derive(Debug, Clone)]
pub struct NachaRefused {
    pub errors: Vec<NachaIssue>,
    pub warnings: Vec<NachaIssue>,
}

/// Why [`build_nacha_file`] made no file.
#[derive(Debug, Clone)]
pub enum NachaBuildError {
    /// `ok: false`.
    Refused(NachaRefused),
    /// A record that came out the wrong length (TypeScript throws).
    Broken(String),
}

#[derive(Debug, Clone)]
struct PreparedEntry {
    kind: &'static str,
    payment_id: Option<String>,
    sec_header: &'static str,
    transaction_code: &'static str,
    rdfi: String,
    check_digit: String,
    account: String,
    cents: i64,
    identification: String,
    name: String,
    addenda: Vec<String>,
}

/// `textField(raw, length, issues, field, trimCode, paymentId)`.
fn text_field(
    raw: &str,
    length: usize,
    issues: &mut Collector,
    field: &str,
    trim_code: &'static str,
    payment_id: Option<&str>,
) -> String {
    let clean = sanitize_ach_text(raw);
    // Accents and case are normalised silently; anything else that had to go is worth a warning.
    if strip_accents(raw)
        .chars()
        .any(|c| !(ach_allowed(c) || c.is_ascii_lowercase()))
    {
        issues.warn(
            "text_sanitized",
            format!("{field} had characters ACH does not allow; they were replaced with spaces"),
            Some(field),
            payment_id,
        );
    }
    if clean.len() > length {
        issues.warn(
            trim_code,
            format!("{field} is longer than {length} characters and was trimmed"),
            Some(field),
            payment_id,
        );
        return clean[..length].trim_end().to_owned();
    }
    clean
}

fn valid_routing(
    value: &str,
    issues: &mut Collector,
    field: &str,
    payment_id: Option<&str>,
) -> bool {
    if !all_digits(value, 9) {
        issues.error(
            "invalid_routing_format",
            format!("{field} must be 9 digits"),
            Some(field),
            payment_id,
        );
        return false;
    }
    if !aba_checksum_valid(value) {
        issues.error(
            "invalid_routing_checksum",
            format!("{field} {value} fails the ABA checksum"),
            Some(field),
            payment_id,
        );
        return false;
    }
    true
}

/// `cleanAccount(value)`: whitespace out, upper case, 1 to 17 of A-Z, 0-9, `-`.
fn clean_account(value: &str) -> Option<String> {
    let account: String = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let fits = (1..=17).contains(&account.chars().count())
        && account
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-');
    fits.then_some(account)
}

/// `/^([01]\d|2[0-3])[0-5]\d$/`.
fn valid_time(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 4
        && b.iter().all(u8::is_ascii_digit)
        && (b[0] <= b'1' || (b[0] == b'2' && b[1] <= b'3'))
        && b[2] <= b'5'
}

/// `chunkAddenda(text)`: 80-character pieces (the text is ASCII by now).
fn chunk_addenda(text: &str) -> Vec<String> {
    text.as_bytes()
        .chunks(NACHA_ADDENDA_TEXT_LENGTH)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}

fn batch_sec_of(sec: &str) -> &'static str {
    match sec {
        "PPD" => "PPD",
        "CTX" => "CTX",
        _ => "CCD",
    }
}

#[allow(clippy::too_many_lines)] // `prepareEntries`, step for step
fn prepare_entries(
    input: &NachaFileInput,
    issues: &mut Collector,
    file_date: &str,
) -> Vec<PreparedEntry> {
    let default_sec = input.default_sec_code.as_deref().unwrap_or("CCD");
    let same_day_limit = same_day_limit_dollars(file_date);
    let mut entries = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for payment in &input.payments {
        let id = payment.id.as_str();
        if seen.contains(&id) {
            issues.error(
                "duplicate_payment_id",
                format!("Payment id {id} appears twice"),
                None,
                Some(id),
            );
        }
        seen.push(id);
        let sec = payment.sec_code.as_deref().unwrap_or(default_sec);
        if !NACHA_SEC_CODES.contains(&sec) {
            issues.error(
                "invalid_sec_code",
                format!("Unsupported SEC code {sec}"),
                Some("secCode"),
                Some(id),
            );
            continue;
        }
        let prenote = payment.prenote;
        let routing_ok = valid_routing(&payment.routing_number, issues, "routingNumber", Some(id));
        let account = clean_account(&payment.account_number);
        if account.is_none() {
            issues.error(
                "invalid_account_number",
                "The account number must be 1 to 17 letters, digits or hyphens",
                Some("accountNumber"),
                Some(id),
            );
        }
        let mut cents = 0_i64;
        if prenote {
            if payment.amount != 0.0 {
                issues.warn(
                    "prenote_amount_ignored",
                    "A prenote carries no amount; it was written as $0.00",
                    Some("amount"),
                    Some(id),
                );
            }
        } else if !payment.amount.is_finite() || payment.amount <= 0.0 {
            issues.error(
                "invalid_amount",
                "The amount must be greater than zero",
                Some("amount"),
                Some(id),
            );
        } else {
            let rounded = crate::js::math_round(payment.amount * 100.0);
            #[allow(clippy::cast_possible_truncation)]
            {
                cents = rounded as i64;
            }
            #[allow(clippy::cast_precision_loss)]
            if (payment.amount * 100.0 - rounded).abs() > 1e-6 {
                issues.error(
                    "invalid_amount",
                    "The amount has more than two decimals",
                    Some("amount"),
                    Some(id),
                );
            } else if cents > NACHA_MAX_AMOUNT_CENTS {
                issues.error(
                    "amount_exceeds_maximum",
                    "The amount is more than 99,999,999.99",
                    Some("amount"),
                    Some(id),
                );
            } else if input.same_day && payment.amount > same_day_limit as f64 {
                issues.error(
                    "same_day_limit_exceeded",
                    format!(
                        "Same Day ACH is limited to {} a payment",
                        grouped(same_day_limit)
                    ),
                    Some("amount"),
                    Some(id),
                );
            }
        }
        let name_length = if sec == "CTX" { 16 } else { 22 };
        let name = text_field(
            &payment.name,
            name_length,
            issues,
            "name",
            "name_trimmed",
            Some(id),
        );
        if name.is_empty() {
            issues.error(
                "missing_name",
                "The vendor name is required",
                Some("name"),
                Some(id),
            );
        }
        let identification = text_field(
            payment.identification.as_deref().unwrap_or_default(),
            15,
            issues,
            "identification",
            "identification_trimmed",
            Some(id),
        );
        let mut addenda: Vec<String> = Vec::new();
        let raw_info = payment
            .payment_info
            .as_deref()
            .map(weldsuite_kit::validation::js_trim)
            .unwrap_or_default();
        let info = if raw_info.is_empty() {
            String::new()
        } else {
            sanitize_addenda(raw_info)
        };
        if prenote {
            if !info.is_empty() {
                issues.warn(
                    "prenote_addenda_ignored",
                    "A prenote carries no addenda",
                    Some("paymentInfo"),
                    Some(id),
                );
            }
        } else if sec == "CCD+" {
            if info.is_empty() {
                issues.error(
                    "missing_payment_info",
                    "CCD+ needs payment related information for its addenda record",
                    Some("paymentInfo"),
                    Some(id),
                );
            } else {
                if info.len() > NACHA_ADDENDA_TEXT_LENGTH {
                    issues.warn(
                        "addenda_trimmed",
                        "CCD+ carries one addenda of 80 characters; the rest was cut",
                        Some("paymentInfo"),
                        Some(id),
                    );
                }
                addenda.push(info[..info.len().min(NACHA_ADDENDA_TEXT_LENGTH)].to_owned());
            }
        } else if sec == "CTX" {
            let chunks = chunk_addenda(&info);
            if chunks.len() > NACHA_MAX_CTX_ADDENDA {
                issues.error(
                    "too_many_addenda",
                    "A CTX entry carries at most 9999 addenda records",
                    Some("paymentInfo"),
                    Some(id),
                );
            }
            addenda.extend(chunks);
        } else if sec == "PPD" && !info.is_empty() {
            if info.len() > NACHA_ADDENDA_TEXT_LENGTH {
                issues.warn(
                    "addenda_trimmed",
                    "PPD carries one addenda of 80 characters; the rest was cut",
                    Some("paymentInfo"),
                    Some(id),
                );
            }
            addenda.push(info[..info.len().min(NACHA_ADDENDA_TEXT_LENGTH)].to_owned());
        } else if sec == "CCD" && !info.is_empty() {
            issues.warn(
                "addenda_ignored",
                "CCD carries no addenda; use CCD+ to send payment information",
                Some("paymentInfo"),
                Some(id),
            );
        }
        let Some(account) = account.filter(|_| routing_ok) else {
            continue;
        };
        let (credit, prenote_code, _) = transaction_codes(payment.savings);
        entries.push(PreparedEntry {
            kind: if prenote { "prenote" } else { "payment" },
            payment_id: Some(id.to_owned()),
            sec_header: batch_sec_of(sec),
            transaction_code: if prenote { prenote_code } else { credit },
            rdfi: payment.routing_number[..8].to_owned(),
            check_digit: payment.routing_number[8..9].to_owned(),
            account,
            cents,
            identification,
            name,
            addenda,
        });
    }
    entries
}

const BATCH_ORDER: [&str; 3] = ["PPD", "CCD", "CTX"];

/// `buildNachaFile(input)`: the file, or every issue that stops it.
#[allow(clippy::too_many_lines)] // the builder, step for step
pub fn build_nacha_file(input: &NachaFileInput) -> Result<NachaBuilt, NachaBuildError> {
    let mut issues = Collector::default();
    let originator = &input.originator;
    if input.payments.is_empty() {
        issues.error(
            "no_payments",
            "A file needs at least one payment",
            None,
            None,
        );
    }
    if !is_iso_date(&input.file_date) {
        issues.error(
            "invalid_file_date",
            "The file creation date must be YYYY-MM-DD",
            Some("fileCreation.date"),
            None,
        );
    }
    let file_time = input.file_time.as_deref();
    if let Some(time) = file_time
        && !valid_time(time)
    {
        issues.error(
            "invalid_file_time",
            "The file creation time must be HHMM",
            Some("fileCreation.time"),
            None,
        );
    }
    if !is_iso_date(&input.effective_entry_date) {
        issues.error(
            "invalid_effective_date",
            "The effective entry date must be YYYY-MM-DD",
            Some("effectiveEntryDate"),
            None,
        );
    }
    let file_date = if is_iso_date(&input.file_date) {
        input.file_date.as_str()
    } else {
        "2000-01-01"
    };
    let modifier = input.file_id_modifier.as_deref().unwrap_or("A");
    if !(modifier.len() == 1
        && modifier
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
    {
        issues.error(
            "invalid_file_id_modifier",
            "The file ID modifier is one letter A-Z or digit 0-9",
            Some("fileIdModifier"),
            None,
        );
    }
    valid_routing(
        &originator.immediate_destination,
        &mut issues,
        "immediateDestination",
        None,
    );
    let odfi_routing = originator
        .odfi_routing_number
        .clone()
        .unwrap_or_else(|| originator.immediate_destination.clone());
    if originator.odfi_routing_number.is_some() {
        valid_routing(&odfi_routing, &mut issues, "odfiRoutingNumber", None);
    }
    let origin_raw: String = originator
        .immediate_origin
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let immediate_origin = if all_digits(&origin_raw, 9) {
        format!(" {origin_raw}")
    } else {
        origin_raw
    };
    if !(immediate_origin.len() == 10
        && immediate_origin
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b' '))
    {
        issues.error(
            "invalid_immediate_origin",
            "The immediate origin is a 10-character company ID or a 9-digit routing number",
            Some("immediateOrigin"),
            None,
        );
    }
    let company_raw: String = originator
        .company_identification
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_uppercase();
    let company_id = if all_digits(&company_raw, 9) {
        format!("1{company_raw}")
    } else {
        company_raw
    };
    if !(company_id.len() == 10
        && company_id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
    {
        issues.error(
            "invalid_company_identification",
            "The company identification is 10 characters (identifier code plus ID)",
            Some("companyIdentification"),
            None,
        );
    }
    let description = text_field(
        input.entry_description.as_deref().unwrap_or("VENDOR PAY"),
        10,
        &mut issues,
        "entryDescription",
        "description_trimmed",
        None,
    );
    if description == "PAYROLL" || description == "PURCHASE" {
        issues.error(
            "reserved_entry_description",
            format!(
                "\"{description}\" is reserved by Nacha and cannot describe a vendor payment run"
            ),
            Some("entryDescription"),
            None,
        );
    }
    let same_day = input.same_day || input.same_day_settlement.is_some();
    let mut same_day_time = DEFAULT_SAME_DAY_SETTLEMENT.to_owned();
    if let Some(time) = &input.same_day_settlement {
        same_day_time.clone_from(time);
        if !valid_time(time) {
            issues.error(
                "invalid_same_day_time",
                "The same-day settlement time must be HHMM",
                Some("sameDay.settlementTime"),
                None,
            );
        }
    }
    let effective = input.effective_entry_date.as_str();
    if is_iso_date(effective) {
        if same_day && effective != file_date {
            issues.warn(
                "same_day_effective_date_mismatch",
                "A Same Day ACH file carries its own date as the effective entry date",
                None,
                None,
            );
        }
        if !same_day && effective <= file_date {
            issues.warn(
                "effective_date_not_after_file_date",
                "An effective entry date on or before the file date is processed as Same Day ACH or rejected",
                None,
                None,
            );
        }
        if !is_ach_banking_day(effective) {
            issues.warn(
                "effective_date_not_banking_day",
                "The effective entry date is not a banking day; settlement moves to the next one",
                None,
                None,
            );
        }
    }
    let destination_name = text_field(
        &originator.immediate_destination_name,
        23,
        &mut issues,
        "immediateDestinationName",
        "name_trimmed",
        None,
    );
    let origin_name = text_field(
        &originator.immediate_origin_name,
        23,
        &mut issues,
        "immediateOriginName",
        "name_trimmed",
        None,
    );
    let company_name = text_field(
        &originator.company_name,
        16,
        &mut issues,
        "companyName",
        "name_trimmed",
        None,
    );
    let discretionary = text_field(
        originator
            .company_discretionary_data
            .as_deref()
            .unwrap_or_default(),
        20,
        &mut issues,
        "companyDiscretionaryData",
        "description_trimmed",
        None,
    );
    let reference = text_field(
        originator.reference_code.as_deref().unwrap_or_default(),
        8,
        &mut issues,
        "referenceCode",
        "description_trimmed",
        None,
    );
    let descriptive_date = if same_day {
        format!("SD{same_day_time}")
    } else {
        text_field(
            input.descriptive_date.as_deref().unwrap_or_default(),
            6,
            &mut issues,
            "descriptiveDate",
            "description_trimmed",
            None,
        )
    };

    let mut offset_entry: Option<PreparedEntry> = None;
    if input.balanced {
        match &originator.offset_account {
            None => issues.error(
                "missing_offset_account",
                "A balanced file needs the originator's offset account",
                Some("offsetAccount"),
                None,
            ),
            Some(offset) => {
                let routing_ok = valid_routing(
                    &offset.routing_number,
                    &mut issues,
                    "offsetAccount.routingNumber",
                    None,
                );
                let account = clean_account(&offset.account_number);
                if account.is_none() {
                    issues.error(
                        "invalid_account_number",
                        "The offset account number must be 1 to 17 letters, digits or hyphens",
                        Some("offsetAccount.accountNumber"),
                        None,
                    );
                }
                if let Some(account) = account.filter(|_| routing_ok) {
                    let identification = text_field(
                        offset.identification.as_deref().unwrap_or_default(),
                        15,
                        &mut issues,
                        "offsetAccount.identification",
                        "identification_trimmed",
                        None,
                    );
                    let name = text_field(
                        offset
                            .name
                            .as_deref()
                            .unwrap_or(originator.company_name.as_str()),
                        22,
                        &mut issues,
                        "offsetAccount.name",
                        "name_trimmed",
                        None,
                    );
                    offset_entry = Some(PreparedEntry {
                        kind: "offset",
                        payment_id: None,
                        sec_header: "CCD",
                        transaction_code: transaction_codes(offset.savings).2,
                        rdfi: offset.routing_number[..8].to_owned(),
                        check_digit: offset.routing_number[8..9].to_owned(),
                        account,
                        cents: 0,
                        identification,
                        name,
                        addenda: Vec::new(),
                    });
                }
            }
        }
    }

    let entries = prepare_entries(input, &mut issues, file_date);
    let first_trace = input.starting_trace_sequence.unwrap_or(1);
    let batches_needed = BATCH_ORDER
        .iter()
        .filter(|code| entries.iter().any(|e| e.sec_header == **code))
        .count();
    let entry_total = i64::try_from(
        entries.len()
            + if offset_entry.is_some() {
                batches_needed
            } else {
                0
            },
    )
    .unwrap_or(i64::MAX);
    if first_trace < 1 || first_trace + entry_total - 1 > 9_999_999 {
        issues.error(
            "file_too_large",
            "The trace sequence would run past 9,999,999",
            Some("startingTraceSequence"),
            None,
        );
    }
    if !issues.errors.is_empty() {
        return Err(NachaBuildError::Refused(NachaRefused {
            errors: issues.errors,
            warnings: issues.warnings,
        }));
    }
    write_file(
        input,
        Fields {
            odfi: odfi_routing.get(..8).unwrap_or_default().to_owned(),
            immediate_origin,
            company_id,
            description,
            descriptive_date,
            destination_name,
            origin_name,
            company_name,
            discretionary,
            reference,
            modifier: modifier.to_owned(),
            file_date: file_date.to_owned(),
        },
        entries,
        offset_entry,
        issues.warnings,
    )
    .map_err(NachaBuildError::Broken)
}

/// What the builder settled before writing the records.
struct Fields {
    odfi: String,
    immediate_origin: String,
    company_id: String,
    description: String,
    descriptive_date: String,
    destination_name: String,
    origin_name: String,
    company_name: String,
    discretionary: String,
    reference: String,
    modifier: String,
    file_date: String,
}

#[allow(clippy::too_many_lines)] // the records, in file order
fn write_file(
    input: &NachaFileInput,
    f: Fields,
    entries: Vec<PreparedEntry>,
    offset_entry: Option<PreparedEntry>,
    warnings: Vec<NachaIssue>,
) -> Result<NachaBuilt, String> {
    let odfi = f.odfi.as_str();
    let mut lines: Vec<String> = Vec::new();
    let mut traces = Vec::new();
    let mut batches = Vec::new();
    let mut trace_sequence = input.starting_trace_sequence.unwrap_or(1);
    let mut batch_number = input.starting_batch_number.unwrap_or(1);
    let mut file_hash_parts: i64 = 0;
    let mut file_debit: i64 = 0;
    let mut file_credit: i64 = 0;
    let mut file_entry_addenda: i64 = 0;

    lines.push(assert_line(format!(
        "101 {}{}{}{}{}094101{}{}{}",
        input.originator.immediate_destination,
        alpha(&f.immediate_origin, 10),
        yymmdd(&f.file_date),
        alpha(input.file_time.as_deref().unwrap_or_default(), 4),
        f.modifier,
        alpha(&f.destination_name, 23),
        alpha(&f.origin_name, 23),
        alpha(&f.reference, 8),
    ))?);

    for sec_code in BATCH_ORDER {
        let group: Vec<&PreparedEntry> = entries.iter().filter(|e| e.sec_header == sec_code).collect();
        if group.is_empty() {
            continue;
        }
        let credit_cents: i64 = group.iter().map(|e| e.cents).sum();
        let mut batch_entries: Vec<PreparedEntry> = group.into_iter().cloned().collect();
        if let Some(offset) = &offset_entry
            && credit_cents > 0
        {
            batch_entries.push(PreparedEntry {
                cents: credit_cents,
                ..offset.clone()
            });
        }
        let has_debit = batch_entries.iter().any(|e| e.kind == "offset");
        let service_class: i64 = if has_debit { 200 } else { 220 };
        let batch_no = numeric(batch_number, 7)?;
        lines.push(assert_line(format!(
            "5{service_class}{}{}{}{sec_code}{}{}{}   1{odfi}{batch_no}",
            alpha(&f.company_name, 16),
            alpha(&f.discretionary, 20),
            alpha(&f.company_id, 10),
            alpha(&f.description, 10),
            alpha(&f.descriptive_date, 6),
            yymmdd(&input.effective_entry_date),
        ))?);

        let mut entry_addenda_count: i64 = 0;
        let mut debit_cents: i64 = 0;
        let mut batch_credit: i64 = 0;
        let mut hash: i64 = 0;
        for entry in &batch_entries {
            let trace = format!("{odfi}{}", numeric(trace_sequence, 7)?);
            trace_sequence += 1;
            let amount = numeric(entry.cents, 10)?;
            let indicator = if entry.addenda.is_empty() { '0' } else { '1' };
            if sec_code == "CTX" {
                lines.push(assert_line(format!(
                    "6{}{}{}{}{amount}{}{}{}    {indicator}{trace}",
                    entry.transaction_code,
                    entry.rdfi,
                    entry.check_digit,
                    alpha(&entry.account, 17),
                    alpha(&entry.identification, 15),
                    numeric(i64::try_from(entry.addenda.len()).unwrap_or(0), 4)?,
                    alpha(&entry.name, 16),
                ))?);
            } else {
                lines.push(assert_line(format!(
                    "6{}{}{}{}{amount}{}{}  {indicator}{trace}",
                    entry.transaction_code,
                    entry.rdfi,
                    entry.check_digit,
                    alpha(&entry.account, 17),
                    alpha(&entry.identification, 15),
                    alpha(&entry.name, 22),
                ))?);
            }
            entry_addenda_count += 1;
            for (index, text) in entry.addenda.iter().enumerate() {
                lines.push(assert_line(format!(
                    "705{}{}{}",
                    alpha(text, NACHA_ADDENDA_TEXT_LENGTH),
                    numeric(i64::try_from(index + 1).unwrap_or(0), 4)?,
                    &trace[8..],
                ))?);
                entry_addenda_count += 1;
            }
            hash += entry.rdfi.parse::<i64>().unwrap_or(0);
            if entry.kind == "offset" {
                debit_cents += entry.cents;
            } else {
                batch_credit += entry.cents;
            }
            traces.push(NachaTrace {
                payment_id: entry.payment_id.clone(),
                kind: entry.kind,
                trace_number: trace,
                batch_number,
            });
        }
        let batch_hash = hash % 10_000_000_000;
        lines.push(assert_line(format!(
            "8{service_class}{}{}{}{}{}{}{}{odfi}{batch_no}",
            numeric(entry_addenda_count, 6)?,
            numeric(batch_hash, 10)?,
            numeric(debit_cents, 12)?,
            numeric(batch_credit, 12)?,
            alpha(&f.company_id, 10),
            " ".repeat(19),
            " ".repeat(6),
        ))?);
        batches.push(NachaBatchSummary {
            batch_number,
            sec_code,
            service_class_code: service_class,
            entry_addenda_count,
            entry_hash: numeric(batch_hash, 10)?,
            total_debit_cents: debit_cents,
            total_credit_cents: batch_credit,
        });
        batch_number += 1;
        file_hash_parts += batch_hash;
        file_debit += debit_cents;
        file_credit += batch_credit;
        file_entry_addenda += entry_addenda_count;
    }

    let file_hash = file_hash_parts % 10_000_000_000;
    let records_before_control = lines.len() + 1;
    let block_count = records_before_control.div_ceil(NACHA_BLOCKING_FACTOR);
    lines.push(assert_line(format!(
        "9{}{}{}{}{}{}{}",
        numeric(i64::try_from(batches.len()).unwrap_or(0), 6)?,
        numeric(i64::try_from(block_count).unwrap_or(0), 6)?,
        numeric(file_entry_addenda, 8)?,
        numeric(file_hash, 10)?,
        numeric(file_debit, 12)?,
        numeric(file_credit, 12)?,
        " ".repeat(39),
    ))?);
    while !lines.len().is_multiple_of(NACHA_BLOCKING_FACTOR) {
        lines.push("9".repeat(NACHA_RECORD_LENGTH));
    }
    let line_ending = if input.lf_only { "\n" } else { "\r\n" };
    let content = format!("{}{line_ending}", lines.join(line_ending));
    Ok(NachaBuilt {
        content,
        record_count: lines.len(),
        lines,
        block_count,
        batch_count: batches.len(),
        entry_addenda_count: file_entry_addenda,
        entry_hash: numeric(file_hash, 10)?,
        total_debit_cents: file_debit,
        total_credit_cents: file_credit,
        batches,
        traces,
        warnings,
    })
}

// ── Verifier ────────────────────────────────────────────────────────────────

/// `NachaVerification`.
#[derive(Debug, Clone)]
pub struct NachaVerification {
    pub ok: bool,
    pub issues: Vec<NachaIssue>,
    pub batch_count: i64,
    pub entry_addenda_count: i64,
    pub entry_hash: String,
    pub total_debit_cents: f64,
    pub total_credit_cents: f64,
}

const KNOWN_TRANSACTION_CODES: [&str; 12] = [
    "22", "23", "24", "27", "28", "29", "32", "33", "34", "37", "38", "39",
];
const PRENOTE_CODES: [&str; 4] = ["23", "28", "33", "38"];
const DEBIT_CODES: [&str; 4] = ["27", "28", "37", "38"];

struct OpenBatch {
    header: String,
    entries: i64,
    hash: f64,
    debit: f64,
    credit: f64,
    last_entry_trace: Option<String>,
    last_entry_addenda_indicator: bool,
    addenda_seen: i64,
    expected_addenda: Option<f64>,
}

/// `line.slice(a, b)` of an ASCII record.
fn cut(line: &str, from: usize, to: usize) -> &str {
    line.get(from..to.min(line.len())).unwrap_or_default()
}

/// `Number(text)`.
fn num(text: &str) -> f64 {
    weldsuite_kit::validation::js_number(text)
}

fn padded(n: f64, width: usize) -> String {
    format!("{:0>width$}", crate::js::number_text(n))
}

/// `verifyNachaFile(content)`: record lengths and order, counts, entry
/// hashes, totals, trace numbers, addenda numbering and the padding.
#[allow(clippy::too_many_lines)] // the verifier, record type by record type
pub fn verify_nacha_file(content: &str) -> NachaVerification {
    let mut issues: Vec<NachaIssue> = Vec::new();
    let mut err = |code: &'static str, message: String| {
        issues.push(NachaIssue {
            error: true,
            code,
            message,
            payment_id: None,
            field: None,
        });
    };
    let mut lines: Vec<&str> = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    while lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        err("record_count", "The file is empty".to_owned());
        return NachaVerification {
            ok: false,
            issues,
            batch_count: 0,
            entry_addenda_count: 0,
            entry_hash: "0".repeat(10),
            total_debit_cents: 0.0,
            total_credit_cents: 0.0,
        };
    }
    let length = |line: &str| crate::js::utf16_len(line);
    for (index, line) in lines.iter().enumerate() {
        if length(line) != NACHA_RECORD_LENGTH {
            err(
                "record_length",
                format!(
                    "Line {} is {} characters, not {NACHA_RECORD_LENGTH}",
                    index + 1,
                    length(line)
                ),
            );
        } else if line.chars().any(|c| !(' '..='~').contains(&c)) {
            err(
                "invalid_character",
                format!("Line {} has a character outside printable ASCII", index + 1),
            );
        }
    }
    if !lines.len().is_multiple_of(NACHA_BLOCKING_FACTOR) {
        err(
            "blocking",
            format!(
                "The file has {} records, not a multiple of {NACHA_BLOCKING_FACTOR}",
                lines.len()
            ),
        );
    }
    if !lines[0].starts_with('1') {
        err(
            "record_order",
            "The file must start with a file header (record type 1)".to_owned(),
        );
    }
    let mut batches: i64 = 0;
    let mut total_entry_addenda: i64 = 0;
    let mut total_hash: f64 = 0.0;
    let mut total_debit: f64 = 0.0;
    let mut total_credit: f64 = 0.0;
    let mut batch: Option<OpenBatch> = None;
    let mut file_control_at: Option<usize> = None;
    let padding = "9".repeat(NACHA_RECORD_LENGTH);
    let close_entry = |b: &OpenBatch, err: &mut dyn FnMut(&'static str, String)| {
        if b.last_entry_addenda_indicator && b.addenda_seen == 0 {
            err(
                "addenda_sequence",
                "An entry flags an addenda record but none follows".to_owned(),
            );
        }
        if let Some(expected) = b.expected_addenda {
            #[allow(clippy::cast_precision_loss)]
            if expected != b.addenda_seen as f64 {
                err(
                    "addenda_sequence",
                    format!(
                        "A CTX entry announces {} addenda records but {} follow",
                        crate::js::number_text(expected),
                        b.addenda_seen
                    ),
                );
            }
        }
    };
    for i in 1..lines.len() {
        let line = lines[i];
        let n = i + 1;
        if length(line) != NACHA_RECORD_LENGTH || !line.is_ascii() {
            continue;
        }
        if file_control_at.is_some() {
            if line != padding {
                err(
                    "blocking",
                    format!("Line {n} after the file control is not a padding record"),
                );
            }
            continue;
        }
        match &line[..1] {
            "5" => {
                if batch.is_some() {
                    err(
                        "record_order",
                        format!("Line {n}: a batch header opens before the previous batch closed"),
                    );
                }
                batch = Some(OpenBatch {
                    header: line.to_owned(),
                    entries: 0,
                    hash: 0.0,
                    debit: 0.0,
                    credit: 0.0,
                    last_entry_trace: None,
                    last_entry_addenda_indicator: false,
                    addenda_seen: 0,
                    expected_addenda: None,
                });
            }
            "6" => {
                let Some(b) = batch.as_mut() else {
                    err(
                        "record_order",
                        format!("Line {n}: an entry detail outside a batch"),
                    );
                    continue;
                };
                close_entry(b, &mut err);
                let code = cut(line, 1, 3);
                let rdfi = cut(line, 3, 11);
                let check = cut(line, 11, 12);
                let cents = num(cut(line, 29, 39));
                let sec = cut(&b.header, 50, 53).to_owned();
                let trace = cut(line, 79, 94).to_owned();
                let indicator = cut(line, 78, 79) == "1";
                if !KNOWN_TRANSACTION_CODES.contains(&code) {
                    err(
                        "transaction_code",
                        format!("Line {n}: transaction code {code} is not valid"),
                    );
                }
                if !aba_checksum_valid(&format!("{rdfi}{check}")) {
                    err(
                        "invalid_routing_checksum",
                        format!("Line {n}: routing {rdfi}{check} fails the ABA checksum"),
                    );
                }
                if cents == 0.0 && !PRENOTE_CODES.contains(&code) {
                    err(
                        "transaction_code",
                        format!("Line {n}: a zero-dollar entry must be a prenote"),
                    );
                }
                if cents > 0.0 && PRENOTE_CODES.contains(&code) {
                    err(
                        "transaction_code",
                        format!("Line {n}: a prenote must be zero dollars"),
                    );
                }
                if cut(&trace, 0, 8) != cut(&b.header, 79, 87) {
                    err(
                        "trace_number",
                        format!("Line {n}: trace number does not start with the ODFI identification"),
                    );
                }
                if let Some(last) = &b.last_entry_trace
                    && trace.as_str() <= last.as_str()
                {
                    err(
                        "trace_number",
                        format!("Line {n}: trace numbers must ascend within a batch"),
                    );
                }
                b.last_entry_trace = Some(trace);
                b.last_entry_addenda_indicator = indicator;
                b.addenda_seen = 0;
                b.expected_addenda = (sec == "CTX").then(|| num(cut(line, 54, 58)));
                b.entries += 1;
                b.hash += num(rdfi);
                if DEBIT_CODES.contains(&code) {
                    b.debit += cents;
                } else {
                    b.credit += cents;
                }
            }
            "7" => {
                let Some(b) = batch.as_mut().filter(|b| b.last_entry_trace.is_some()) else {
                    err(
                        "record_order",
                        format!("Line {n}: an addenda record without an entry"),
                    );
                    continue;
                };
                b.entries += 1;
                b.addenda_seen += 1;
                if cut(line, 1, 3) != "05" {
                    err(
                        "addenda_sequence",
                        format!(
                            "Line {n}: addenda type code {} is not 05",
                            cut(line, 1, 3)
                        ),
                    );
                }
                #[allow(clippy::cast_precision_loss)]
                if num(cut(line, 83, 87)) != b.addenda_seen as f64 {
                    err(
                        "addenda_sequence",
                        format!("Line {n}: addenda sequence number is out of order"),
                    );
                }
                let last = b.last_entry_trace.clone().unwrap_or_default();
                if cut(line, 87, 94) != cut(&last, 8, 15) {
                    err(
                        "addenda_sequence",
                        format!("Line {n}: addenda entry detail sequence does not match its entry"),
                    );
                }
                if !b.last_entry_addenda_indicator {
                    err(
                        "addenda_sequence",
                        format!("Line {n}: addenda follows an entry that does not flag one"),
                    );
                }
            }
            "8" => {
                let Some(b) = batch.take() else {
                    err(
                        "record_order",
                        format!("Line {n}: a batch control without a batch header"),
                    );
                    continue;
                };
                close_entry(&b, &mut err);
                let hash_sum = b.hash % 10_000_000_000.0;
                #[allow(clippy::cast_precision_loss)]
                if num(cut(line, 4, 10)) != b.entries as f64 {
                    err(
                        "record_count",
                        format!(
                            "Line {n}: batch control counts {} records, found {}",
                            crate::js::number_text(num(cut(line, 4, 10))),
                            b.entries
                        ),
                    );
                }
                if num(cut(line, 10, 20)) != hash_sum {
                    err(
                        "entry_hash",
                        format!(
                            "Line {n}: batch entry hash is {}, expected {}",
                            cut(line, 10, 20),
                            padded(hash_sum, 10)
                        ),
                    );
                }
                if num(cut(line, 20, 32)) != b.debit {
                    err(
                        "control_total",
                        format!("Line {n}: batch debit total does not match its entries"),
                    );
                }
                if num(cut(line, 32, 44)) != b.credit {
                    err(
                        "control_total",
                        format!("Line {n}: batch credit total does not match its entries"),
                    );
                }
                if cut(line, 1, 4) != cut(&b.header, 1, 4) {
                    err(
                        "control_total",
                        format!("Line {n}: batch control service class differs from the header"),
                    );
                }
                if cut(line, 44, 54) != cut(&b.header, 40, 50) {
                    err(
                        "control_total",
                        format!(
                            "Line {n}: batch control company identification differs from the header"
                        ),
                    );
                }
                if cut(line, 79, 94) != cut(&b.header, 79, 94) {
                    err(
                        "control_total",
                        format!(
                            "Line {n}: batch control ODFI and batch number differ from the header"
                        ),
                    );
                }
                batches += 1;
                total_entry_addenda += b.entries;
                total_hash += hash_sum;
                total_debit += b.debit;
                total_credit += b.credit;
            }
            "9" => {
                if batch.is_some() {
                    err(
                        "record_order",
                        format!("Line {n}: the file control comes before the batch closed"),
                    );
                }
                file_control_at = Some(i);
                if line == padding {
                    err(
                        "record_order",
                        format!("Line {n}: padding where the file control should be"),
                    );
                    continue;
                }
                let blocks = lines.len().div_ceil(NACHA_BLOCKING_FACTOR);
                let expected_blocks = (i + 1).div_ceil(NACHA_BLOCKING_FACTOR);
                let hash_sum = total_hash % 10_000_000_000.0;
                #[allow(clippy::cast_precision_loss)]
                {
                    if num(cut(line, 1, 7)) != batches as f64 {
                        err(
                            "record_count",
                            format!(
                                "File control counts {} batches, found {batches}",
                                crate::js::number_text(num(cut(line, 1, 7)))
                            ),
                        );
                    }
                    if num(cut(line, 7, 13)) != expected_blocks as f64 {
                        err(
                            "blocking",
                            format!(
                                "File control block count is {}, expected {expected_blocks}",
                                crate::js::number_text(num(cut(line, 7, 13)))
                            ),
                        );
                    }
                    if blocks != expected_blocks {
                        err(
                            "blocking",
                            "The padding after the file control does not fill the last block exactly"
                                .to_owned(),
                        );
                    }
                    if num(cut(line, 13, 21)) != total_entry_addenda as f64 {
                        err(
                            "record_count",
                            format!(
                                "File control counts {} entry and addenda records, found {total_entry_addenda}",
                                crate::js::number_text(num(cut(line, 13, 21)))
                            ),
                        );
                    }
                }
                if num(cut(line, 21, 31)) != hash_sum {
                    err(
                        "entry_hash",
                        format!(
                            "File entry hash is {}, expected {}",
                            cut(line, 21, 31),
                            padded(hash_sum, 10)
                        ),
                    );
                }
                if num(cut(line, 31, 43)) != total_debit {
                    err(
                        "control_total",
                        "File debit total does not match the batches".to_owned(),
                    );
                }
                if num(cut(line, 43, 55)) != total_credit {
                    err(
                        "control_total",
                        "File credit total does not match the batches".to_owned(),
                    );
                }
            }
            other => err(
                "record_order",
                format!("Line {n}: unknown record type {other}"),
            ),
        }
    }
    if file_control_at.is_none() {
        err(
            "record_order",
            "The file has no file control record".to_owned(),
        );
    }
    if batch.is_some() {
        err("record_order", "The last batch was never closed".to_owned());
    }
    NachaVerification {
        ok: issues.is_empty(),
        entry_hash: padded(total_hash % 10_000_000_000.0, 10),
        issues,
        batch_count: batches,
        entry_addenda_count: total_entry_addenda,
        total_debit_cents: total_debit,
        total_credit_cents: total_credit,
    }
}

/// The issues as JSON, in order.
pub fn issues_json(issues: &[NachaIssue]) -> Value {
    Value::Array(issues.iter().map(NachaIssue::to_json).collect())
}

/// A trace's JSON (tests and logs).
pub fn trace_json(trace: &NachaTrace) -> Value {
    json!({
        "paymentId": trace.payment_id,
        "kind": trace.kind,
        "traceNumber": trace.trace_number,
        "batchNumber": trace.batch_number,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> NachaFileInput {
        NachaFileInput {
            originator: NachaOriginator {
                immediate_destination: "021000021".to_owned(),
                immediate_destination_name: "JPMorgan Chase".to_owned(),
                immediate_origin: "1123456789".to_owned(),
                immediate_origin_name: "Runs Studio, LLC".to_owned(),
                company_name: "Runs Studio".to_owned(),
                company_identification: "1123456789".to_owned(),
                ..NachaOriginator::default()
            },
            payments: vec![
                NachaPayment {
                    id: "pay_1".to_owned(),
                    sec_code: Some("CCD+".to_owned()),
                    name: "Alpha Roofing LLC".to_owned(),
                    routing_number: "121000248".to_owned(),
                    account_number: "5550001111".to_owned(),
                    amount: 1250.5,
                    payment_info: Some(build_rmr_segments(&[
                        ("A-1".to_owned(), 1000.0),
                        ("A-2".to_owned(), 250.5),
                    ])),
                    ..NachaPayment::default()
                },
                NachaPayment {
                    id: "pay_2".to_owned(),
                    sec_code: Some("PPD".to_owned()),
                    name: "Foxtrot Partners".to_owned(),
                    routing_number: "011000015".to_owned(),
                    account_number: "3330004444".to_owned(),
                    savings: true,
                    amount: 120.0,
                    ..NachaPayment::default()
                },
            ],
            effective_entry_date: "2026-11-05".to_owned(),
            file_date: "2026-11-02".to_owned(),
            file_time: Some("0930".to_owned()),
            ..NachaFileInput::default()
        }
    }

    #[test]
    fn a_file_verifies() {
        let built = build_nacha_file(&input()).expect("the file");
        assert_eq!(built.record_count % 10, 0);
        assert!(built.lines.iter().all(|line| line.len() == 94));
        assert_eq!(built.total_credit_cents, 137_050);
        assert_eq!(built.batch_count, 2);
        let verified = verify_nacha_file(&built.content);
        assert!(verified.ok, "{:?}", verified.issues);
        assert_eq!(verified.total_credit_cents, 137_050.0);
        assert!(built.lines[0].starts_with("101 021000021"));
    }

    #[test]
    fn a_balanced_file_debits_the_offset_account() {
        let mut balanced = input();
        balanced.balanced = true;
        balanced.originator.offset_account = Some(NachaOffsetAccount {
            routing_number: "021000021".to_owned(),
            account_number: "000123456789".to_owned(),
            ..NachaOffsetAccount::default()
        });
        let built = build_nacha_file(&balanced).expect("the file");
        assert_eq!(built.total_debit_cents, built.total_credit_cents);
        assert!(verify_nacha_file(&built.content).ok);
    }

    #[test]
    fn problems_stop_the_file() {
        let mut bad = input();
        bad.payments[0].routing_number = "121000249".to_owned();
        bad.entry_description = Some("payroll".to_owned());
        let Err(NachaBuildError::Refused(refused)) = build_nacha_file(&bad) else {
            panic!("refused");
        };
        let codes: Vec<&str> = refused.errors.iter().map(|e| e.code).collect();
        assert_eq!(
            codes,
            ["reserved_entry_description", "invalid_routing_checksum"]
        );
    }

    #[test]
    fn helpers() {
        assert!(aba_checksum_valid("021000021"));
        assert!(!aba_checksum_valid("021000022"));
        assert_eq!(company_id_from_ein("12-3456789").as_deref(), Some("1123456789"));
        assert_eq!(sanitize_ach_text("  Café  & Co. <x>"), "CAFE & CO. X");
        assert!(!is_ach_banking_day("2026-11-26"));
        assert!(!is_ach_banking_day("2026-11-07"));
        assert_eq!(suggest_effective_entry_date("2026-11-01", "2026-11-02", false), "2026-11-03");
        assert_eq!(next_ach_banking_day("2026-12-25"), "2026-12-28");
        assert_eq!(grouped(1_000_000), "1,000,000");
    }
}
