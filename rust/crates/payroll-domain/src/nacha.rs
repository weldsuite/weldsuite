//! A NACHA (ACH) PPD credit file for US net pay (`nacha.ts`).

use serde::Deserialize;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::PayrollError;
use crate::documents::GeneratedFile;
use crate::js::{is_integer, number_of, number_text};
use crate::types::PayrollIssue;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NachaOriginator {
    pub company_name: String,
    pub company_id: String,
    pub odfi_routing: String,
    pub odfi_name: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NachaCredit {
    pub individual_id: String,
    pub individual_name: String,
    pub routing_number: String,
    pub account_number: String,
    pub account_type: String,
    pub amount_cents: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NachaOffset {
    pub routing_number: String,
    pub account_number: String,
    pub account_type: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NachaFileInput {
    pub originator: NachaOriginator,
    pub effective_date: String,
    pub created_at: String,
    #[serde(default)]
    pub file_id_modifier: Option<String>,
    #[serde(default)]
    pub entry_description: Option<String>,
    pub credits: Vec<NachaCredit>,
    #[serde(default)]
    pub balanced_offset: Option<NachaOffset>,
}

const RECORD_LENGTH: usize = 94;
const BLOCKING_FACTOR: usize = 10;
const MAX_ENTRY_CENTS: f64 = 9_999_999_999.0;

/// `isValidRoutingNumber(routingNumber)`.
pub fn is_valid_routing_number(routing: &str) -> bool {
    if routing.len() != 9 || !routing.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let d: Vec<u32> = routing.bytes().map(|b| u32::from(b - b'0')).collect();
    let prefix = d[0] * 10 + d[1];
    let known = (1..=12).contains(&prefix)
        || (21..=32).contains(&prefix)
        || (61..=72).contains(&prefix)
        || prefix == 80;
    if !known {
        return false;
    }
    let sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    sum.is_multiple_of(10)
}

/// `normalizeAccountNumber(accountNumber)`.
pub fn normalize_account_number(account: &str) -> Option<String> {
    let compact: String = account
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{feff}')
        .collect();
    let ok = (1..=17).contains(&compact.len())
        && compact
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok.then(|| compact.to_uppercase())
}

/// `text(value)`: NACHA's character set, one space per UTF-16 unit refused.
fn text(value: &str) -> String {
    let stripped: String = value
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    let mut out = String::new();
    for c in stripped.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() || " .,&'/()-".contains(c) {
            out.push(c);
        } else {
            out.push_str(&" ".repeat(c.len_utf16()));
        }
    }
    out
}

fn alpha(value: &str, length: usize) -> String {
    let t: String = text(value).chars().take(length).collect();
    format!("{t:<length$}")
}

fn numeric(value: f64, length: usize) -> String {
    let s = number_text(value.trunc());
    if s.len() > length {
        s[s.len() - length..].to_owned()
    } else {
        format!("{s:0>length$}")
    }
}

fn yymmdd(iso: &str) -> String {
    let part = |a: usize, b: usize| iso.get(a..b).unwrap_or("").to_owned();
    format!("{}{}{}", part(2, 4), part(5, 7), part(8, 10))
}

struct Entry {
    transaction_code: &'static str,
    routing_number: String,
    account_number: String,
    amount_cents: f64,
    individual_id: String,
    individual_name: String,
}

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

fn is_modifier(m: &str) -> bool {
    m.len() == 1
        && m.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// `/T(\d{2}):(\d{2})/` on the creation time.
fn hhmm(created: &str) -> Option<String> {
    let b = created.as_bytes();
    (0..b.len().saturating_sub(5)).find_map(|i| {
        let w = &b[i..i + 6];
        (w[0] == b'T'
            && w[1].is_ascii_digit()
            && w[2].is_ascii_digit()
            && w[3] == b':'
            && w[4].is_ascii_digit()
            && w[5].is_ascii_digit())
        .then(|| format!("{}{}", &created[i + 1..i + 3], &created[i + 4..i + 6]))
    })
}

/// The file and the issues that block it.
#[derive(Debug, Clone, PartialEq)]
pub struct NachaFile {
    pub file: GeneratedFile,
    pub issues: Vec<PayrollIssue>,
}

/// `buildNachaFile(input)`.
pub fn build_nacha_file(input: &NachaFileInput) -> Result<NachaFile, PayrollError> {
    let mut issues: Vec<PayrollIssue> = vec![];
    let o = &input.originator;
    let incomplete =
        |field: &str| PayrollIssue::error("employer_incomplete").with(&[("field", json!(field))]);
    if !is_valid_routing_number(&o.odfi_routing) {
        issues.push(incomplete("odfiRouting"));
    }
    let company_id = crate::js::js_trim(&o.company_id).to_owned();
    let id_len = company_id.encode_utf16().count();
    if id_len == 0 || id_len > 10 {
        issues.push(incomplete("companyId"));
    }
    if crate::js::js_trim(&o.company_name).is_empty() {
        issues.push(incomplete("companyName"));
    }
    let modifier = input
        .file_id_modifier
        .clone()
        .unwrap_or_else(|| "A".into())
        .to_uppercase();
    if !is_modifier(&modifier) {
        issues.push(incomplete("fileIdModifier"));
    }
    let mut entries: Vec<Entry> = vec![];
    for credit in &input.credits {
        let id = json!(credit.individual_id);
        if !is_valid_routing_number(&credit.routing_number) {
            issues
                .push(PayrollIssue::error("invalid_routing_number").with(&[("individualId", id)]));
            continue;
        }
        let Some(account) = normalize_account_number(&credit.account_number) else {
            issues
                .push(PayrollIssue::error("invalid_account_number").with(&[("individualId", id)]));
            continue;
        };
        if !is_integer(credit.amount_cents) || credit.amount_cents < 0.0 {
            issues.push(PayrollIssue::error("negative_net_pay").with(&[
                ("individualId", id),
                ("amountCents", n(credit.amount_cents)),
            ]));
            continue;
        }
        if credit.amount_cents == 0.0 {
            issues.push(PayrollIssue::warning("net_pay_zero").with(&[("individualId", id)]));
            continue;
        }
        if credit.amount_cents > MAX_ENTRY_CENTS {
            issues.push(PayrollIssue::error("invalid_amount").with(&[
                ("individualId", id),
                ("amountCents", n(credit.amount_cents)),
            ]));
            continue;
        }
        entries.push(Entry {
            transaction_code: if credit.account_type == "savings" {
                "32"
            } else {
                "22"
            },
            routing_number: credit.routing_number.clone(),
            account_number: account,
            amount_cents: credit.amount_cents,
            individual_id: credit.individual_id.clone(),
            individual_name: credit.individual_name.clone(),
        });
    }
    let total_credit = entries.iter().fold(0.0, |s, e| s + e.amount_cents);
    let mut total_debit = 0.0;
    if let (Some(offset), false) = (input.balanced_offset.as_ref(), entries.is_empty()) {
        let account = normalize_account_number(&offset.account_number);
        if !is_valid_routing_number(&offset.routing_number) {
            issues.push(incomplete("offsetRoutingNumber"));
        } else if account.is_none() {
            issues.push(incomplete("offsetAccountNumber"));
        } else if total_credit > MAX_ENTRY_CENTS {
            issues.push(
                PayrollIssue::error("invalid_amount")
                    .with(&[("field", json!("offset")), ("amountCents", n(total_credit))]),
            );
        } else {
            total_debit = total_credit;
            entries.push(Entry {
                transaction_code: if offset.account_type == "savings" {
                    "37"
                } else {
                    "27"
                },
                routing_number: offset.routing_number.clone(),
                account_number: account.unwrap_or_default(),
                amount_cents: total_credit,
                individual_id: "OFFSET".into(),
                individual_name: o.company_name.clone(),
            });
        }
    }
    let service_class = if total_debit > 0.0 { "200" } else { "220" };
    let routing_digits: String = o
        .odfi_routing
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let odfi8: String = format!("{routing_digits:0<9}").chars().take(8).collect();
    let created = &input.created_at;
    let created_date: String = created.chars().take(10).collect();
    let company_id10 = alpha(&company_id, 10);
    let description = {
        let d = crate::js::js_trim(&text(
            input.entry_description.as_deref().unwrap_or("PAYROLL"),
        ))
        .to_owned();
        if d.starts_with("PAYROLL") {
            d
        } else {
            "PAYROLL".to_owned()
        }
    };
    let modifier_out = if is_modifier(&modifier) {
        modifier.clone()
    } else {
        "A".into()
    };
    let routing_number = if routing_digits.is_empty() {
        0.0
    } else {
        number_of(&routing_digits)
    };
    let mut records: Vec<String> = vec![];
    records.push(format!(
        "101 {}{:>10}{}{}{}094{}1{}{}{}",
        numeric(routing_number, 9),
        crate::js::js_trim(&company_id10),
        yymmdd(&created_date),
        hhmm(created).unwrap_or_else(|| "0000".into()),
        modifier_out,
        numeric(BLOCKING_FACTOR as f64, 2),
        alpha(&o.odfi_name, 23),
        alpha(&o.company_name, 23),
        " ".repeat(8),
    ));
    records.push(format!(
        "5{service_class}{}{}{company_id10}PPD{}{}{}{}1{odfi8}{}",
        alpha(&o.company_name, 16),
        " ".repeat(20),
        alpha(&description, 10),
        " ".repeat(6),
        yymmdd(&input.effective_date),
        " ".repeat(3),
        numeric(1.0, 7),
    ));
    let mut entry_hash = 0.0;
    for (i, e) in entries.iter().enumerate() {
        let rdfi8: String = e.routing_number.chars().take(8).collect();
        entry_hash += number_of(&rdfi8);
        records.push(format!(
            "6{}{rdfi8}{}{:<17}{}{}{}  0{odfi8}{}",
            e.transaction_code,
            e.routing_number.get(8..9).unwrap_or(""),
            e.account_number,
            numeric(e.amount_cents, 10),
            alpha(&e.individual_id, 15),
            alpha(&e.individual_name, 22),
            numeric((i + 1) as f64, 7),
        ));
    }
    let hash10 = numeric(entry_hash % 10_000_000_000.0, 10);
    records.push(format!(
        "8{service_class}{}{hash10}{}{}{company_id10}{}{}{odfi8}{}",
        numeric(entries.len() as f64, 6),
        numeric(total_debit, 12),
        numeric(total_credit, 12),
        " ".repeat(19),
        " ".repeat(6),
        numeric(1.0, 7),
    ));
    let block_count = (records.len() + 1).div_ceil(BLOCKING_FACTOR);
    records.push(format!(
        "9{}{}{}{hash10}{}{}{}",
        numeric(1.0, 6),
        numeric(block_count as f64, 6),
        numeric(entries.len() as f64, 8),
        numeric(total_debit, 12),
        numeric(total_credit, 12),
        " ".repeat(39),
    ));
    while !records.len().is_multiple_of(BLOCKING_FACTOR) {
        records.push("9".repeat(RECORD_LENGTH));
    }
    for r in &records {
        let len = r.encode_utf16().count();
        if len != RECORD_LENGTH {
            return Err(PayrollError::new(format!(
                "NACHA record of {len} characters: {r}"
            )));
        }
    }
    Ok(NachaFile {
        file: GeneratedFile {
            file_name: format!(
                "payroll-{}-{modifier_out}.ach",
                created_date.replace('-', "")
            ),
            content_type: "text/plain".into(),
            content: format!("{}\n", records.join("\n")),
        },
        issues,
    })
}
