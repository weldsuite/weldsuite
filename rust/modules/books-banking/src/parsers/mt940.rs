//! MT940 (SWIFT) statements (`bank-parsers/mt940.ts`), as the Dutch banks
//! (ING, ABN AMRO, Rabobank) write them.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use super::{ParseIssue, ParseResult, Txn, js_trim};

static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:([0-9]{2}[A-Z]?):(.*)$").expect("tag pattern"));
static LINE61: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{6})([0-9]{4})?(R?[CD])([A-Z]?)([0-9]+,[0-9]*)([SNF])([0-9]{3})(.*)$")
        .expect(":61: pattern")
});
static BALANCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([CD])([0-9]{6})([A-Z]{3})([0-9]+,[0-9]*)$").expect("balance pattern")
});
static IBAN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7,})").expect("iban pattern"));
static IBAN_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)([A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7,})(?-u:\b)").expect("iban pattern")
});
static CNTP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/CNTP/([^/]*)/([^/]*)/([^/]*)/([^/]*)/").expect("cntp pattern")
});
static EREF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/EREF/([^/]+)").expect("eref"));
static MARF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/MARF/([^/]+)").expect("marf"));
static PREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(?:PREF|KREF)/([^/]+)").expect("pref"));
static STRUCTURED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/[A-Z]{4}/[^/]*").expect("structured"));
static ING_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r">([0-9]{2})").expect("ing code"));

struct Tag {
    code: String,
    value: String,
    line: usize,
}

/// `content.split(/(?=^:20:)/m)` without the blank parts.
fn split_statements(content: &str) -> Vec<&str> {
    let mut starts = vec![0];
    for (at, _) in content.match_indices(":20:") {
        if at > 0 && content.as_bytes()[at - 1] == b'\n' {
            starts.push(at);
        }
    }
    starts.push(content.len());
    starts
        .windows(2)
        .map(|w| &content[w[0]..w[1]])
        .filter(|part| !js_trim(part).is_empty())
        .collect()
}

fn collect_tags(lines: &[&str]) -> Vec<Tag> {
    let mut tags = Vec::new();
    let mut current: Option<Tag> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = TAG.captures(line) {
            if let Some(tag) = current.take() {
                tags.push(tag);
            }
            current = Some(Tag {
                code: caps[1].to_owned(),
                value: caps[2].to_owned(),
                line: i + 1,
            });
        } else if let Some(tag) = &mut current
            && !js_trim(line).is_empty()
            && !line.starts_with('-')
        {
            tag.value.push('\n');
            tag.value.push_str(line);
        }
    }
    if let Some(tag) = current {
        tags.push(tag);
    }
    tags
}

fn parse_balance(value: &str) -> Option<f64> {
    let caps = BALANCE.captures(value)?;
    let amount = weldsuite_books_domain::js::parse_float(&caps[4].replacen(',', ".", 1));
    Some(if &caps[1] == "D" { -amount } else { amount })
}

fn parse_date(yymmdd: &str) -> Option<String> {
    if yymmdd.len() < 6 {
        return None;
    }
    let yy = weldsuite_books_domain::js::parse_int(&yymmdd[..2])?;
    let mm = &yymmdd[2..4];
    let dd = &yymmdd[4..6];
    let year = if yy < 80 { 2000 + yy } else { 1900 + yy };
    let month = weldsuite_books_domain::js::parse_int(mm).unwrap_or(0);
    let day = weldsuite_books_domain::js::parse_int(dd).unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{year}-{mm}-{dd}"))
}

fn extract_iban(value: &str) -> Option<String> {
    let cleaned: String = value.chars().filter(|c| !super::is_space(*c)).collect();
    IBAN.captures(&cleaned).map(|caps| caps[1].to_owned())
}

#[derive(Default)]
struct Info {
    description: String,
    counterparty_name: Option<String>,
    counterparty_iban: Option<String>,
    counterparty_bic: Option<String>,
    reference: Option<String>,
    end_to_end_id: Option<String>,
    mandate_id: Option<String>,
}

/// `/\/REMI\/(?:USTD\/\/)?([^/]*(?:\/[^/]*)*?)(?=\/[A-Z]{4}\/|$)/`: the
/// remittance text runs segment by segment until the next `/XXXX/` field
/// or the end.
fn remittance(text: &str) -> Option<String> {
    let at = text.find("/REMI/")?;
    let mut rest = &text[at + "/REMI/".len()..];
    if let Some(after) = rest.strip_prefix("USTD//") {
        rest = after;
    }
    let mut end = rest.find('/').unwrap_or(rest.len());
    loop {
        let tail = &rest[end..];
        if tail.is_empty() || starts_with_field(tail) {
            return Some(rest[..end].to_owned());
        }
        // One more `/segment`.
        let next = tail[1..].find('/').map_or(rest.len(), |i| end + 1 + i);
        end = next;
    }
}

/// `/^\/[A-Z]{4}\//`
fn starts_with_field(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 6
        && bytes[0] == b'/'
        && bytes[1..5].iter().all(u8::is_ascii_uppercase)
        && bytes[5] == b'/'
}

fn parse_structured(text: &str) -> Info {
    let mut info = Info::default();
    if let Some(caps) = CNTP.captures(text) {
        if !caps[1].is_empty() {
            info.counterparty_iban = Some(js_trim(&caps[1]).to_owned());
        }
        if !caps[2].is_empty() {
            info.counterparty_bic = Some(js_trim(&caps[2]).to_owned());
        }
        if !caps[3].is_empty() {
            info.counterparty_name = Some(js_trim(&caps[3]).to_owned());
        }
    }
    if let Some(remi) = remittance(text) {
        js_trim(&remi).clone_into(&mut info.description);
    }
    if let Some(caps) = EREF.captures(text) {
        info.end_to_end_id = Some(js_trim(&caps[1]).to_owned());
    }
    if let Some(caps) = MARF.captures(text) {
        info.mandate_id = Some(js_trim(&caps[1]).to_owned());
    }
    if let Some(caps) = PREF.captures(text) {
        info.reference = Some(js_trim(&caps[1]).to_owned());
    }
    if info.description.is_empty() {
        let stripped = STRUCTURED.replace_all(text, "");
        let stripped = js_trim(&stripped);
        info.description = if stripped.is_empty() {
            js_trim(text).to_owned()
        } else {
            stripped.to_owned()
        };
    }
    info
}

/// `text.split(/>(\d{2})/)`, read as code / value pairs.
fn parse_ing(text: &str) -> Info {
    let mut info = Info::default();
    let mut fields: Vec<(String, String)> = Vec::new();
    let codes: Vec<regex::Captures<'_>> = ING_CODE.captures_iter(text).collect();
    for (i, caps) in codes.iter().enumerate() {
        let whole = caps.get(0).expect("match");
        let end = codes
            .get(i + 1)
            .map_or(text.len(), |next| next.get(0).expect("match").start());
        let code = caps[1].to_owned();
        let value = js_trim(&text[whole.end()..end]).to_owned();
        match fields.iter_mut().find(|(c, _)| *c == code) {
            // `if (fields[code])`: an empty first value is replaced.
            Some((_, existing)) if !existing.is_empty() => {
                existing.push(' ');
                existing.push_str(&value);
            }
            Some((_, existing)) => *existing = value,
            None => fields.push((code, value)),
        }
    }
    let get = |code: &str| {
        fields
            .iter()
            .find(|(c, v)| c == code && !v.is_empty())
            .map(|(_, v)| v.clone())
    };
    let mut parts = Vec::new();
    if let Some(v) = get("00") {
        parts.push(v);
    }
    for i in 20..=29 {
        if let Some(v) = get(&i.to_string()) {
            parts.push(v);
        }
    }
    js_trim(&parts.join(" ")).clone_into(&mut info.description);
    if let Some(v) = get("31") {
        info.counterparty_iban = Some(v.chars().filter(|c| !super::is_space(*c)).collect());
    }
    if let Some(v) = get("30") {
        info.counterparty_bic = Some(v);
    }
    let names: Vec<String> = ["32", "33"].iter().filter_map(|c| get(c)).collect();
    if !names.is_empty() {
        info.counterparty_name = Some(js_trim(&names.join(" ")).to_owned());
    }
    if let Some(v) = get("34") {
        info.reference = Some(v);
    }
    info
}

fn parse_tag86(value: &str) -> Info {
    let text = value.replace('\n', "");
    if text.contains("/CNTP/") || text.contains("/REMI/") || text.contains("/EREF/") {
        return parse_structured(&text);
    }
    if ING_CODE.is_match(&text) {
        return parse_ing(&text);
    }
    Info {
        description: js_trim(&text).to_owned(),
        counterparty_iban: IBAN_WORD.captures(&text).map(|caps| caps[1].to_owned()),
        ..Info::default()
    }
}

fn parse_transaction(tag61: &Tag, tag86: Option<&Tag>, errors: &mut Vec<ParseIssue>) -> Option<Txn> {
    let line = tag61.value.replace('\n', "");
    let Some(caps) = LINE61.captures(&line) else {
        let head = String::from_utf16_lossy(&line.encode_utf16().take(80).collect::<Vec<_>>());
        errors.push(ParseIssue::at(tag61.line, format!("Cannot parse :61: line: {head}")));
        return None;
    };
    let date_text = &caps[1];
    let Some(date) = parse_date(date_text) else {
        errors.push(ParseIssue::at(
            tag61.line,
            format!("Invalid date in :61: line: {date_text}"),
        ));
        return None;
    };
    let value_date = caps
        .get(2)
        .and_then(|entry| parse_date(&format!("{}{}", &date_text[..2], entry.as_str())));
    let amount = weldsuite_books_domain::js::parse_float(&caps[5].replacen(',', ".", 1));
    let indicator = &caps[3];
    let signed = if indicator == "D" || indicator == "RD" {
        -amount
    } else {
        amount
    };
    let remainder = &caps[8];
    let parts: Vec<&str> = remainder.split("//").collect();
    let mut reference = parts
        .first()
        .map(|r| js_trim(r))
        .filter(|r| !r.is_empty() && *r != "NONREF")
        .map(str::to_owned);
    let external_id = parts.get(1).map(|r| js_trim(r).to_owned());

    let mut txn = Txn {
        date,
        value_date,
        amount: signed,
        transaction_code: Some(caps[7].to_owned()),
        external_id,
        ..Txn::default()
    };
    if let Some(tag86) = tag86 {
        let info = parse_tag86(&tag86.value);
        txn.description = info.description;
        txn.counterparty_name = info.counterparty_name;
        txn.counterparty_iban = info.counterparty_iban;
        txn.counterparty_bic = info.counterparty_bic;
        txn.end_to_end_id = info.end_to_end_id;
        txn.mandate_id = info.mandate_id;
        if info.reference.is_some() && reference.is_none() {
            reference = info.reference;
        }
        if !tag86.value.is_empty() {
            txn.raw_data = Some(json!({ "tag86": tag86.value }));
        }
    }
    txn.reference = reference;
    Some(txn)
}

/// `parseMT940(content)`.
pub(crate) fn parse(content: &str) -> ParseResult {
    let mut result = ParseResult::new("mt940");
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    for statement in split_statements(&normalized) {
        let lines: Vec<&str> = statement.split('\n').collect();
        let tags = collect_tags(&lines);
        if let Some(iban) = tags
            .iter()
            .find(|t| t.code == "25")
            .and_then(|t| extract_iban(&t.value))
        {
            result.account_iban = Some(iban);
        }
        if let Some(opening) = tags
            .iter()
            .find(|t| t.code == "60F" || t.code == "60M")
            .and_then(|t| parse_balance(&t.value))
        {
            result.opening_balance = Some(opening);
        }
        if let Some(closing) = tags
            .iter()
            .find(|t| t.code == "62F" || t.code == "62M")
            .and_then(|t| parse_balance(&t.value))
        {
            result.closing_balance = Some(closing);
        }
        for (i, tag) in tags.iter().enumerate() {
            if tag.code != "61" {
                continue;
            }
            let tag86 = tags.get(i + 1).filter(|next| next.code == "86");
            if let Some(txn) = parse_transaction(tag, tag86, &mut result.errors) {
                result.transactions.push(txn);
            }
        }
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
    fn reads_an_abn_style_statement() {
        let file = ":20:ABN AMRO BANK NV\n:25:NL91ABNA0417164300\n:28:00001/1\n:60F:C260101EUR1000,00\n:61:2601020102D25,50N071NONREF//BREF1\n:86:/CNTP/NL02RABO0123456789/RABONL2U/Energie BV/AMSTERDAM//REMI/USTD//Factuur 2026-01/EREF/E2E-1/\n:61:2601030103C100,00N078INV-7\n:86:>00SEPA OVERBOEKING>20Factuur>20 7>31NL02 RABO 0123 4567 89>32Klant\n:62F:C260103EUR1074,50\n-";
        let result = parse(file);
        assert_eq!(result.account_iban.as_deref(), Some("NL91ABNA0417164300"));
        assert_eq!(result.opening_balance, Some(1000.0));
        assert_eq!(result.closing_balance, Some(1074.5));
        assert_eq!(result.transactions.len(), 2);
        let debit = &result.transactions[0];
        assert_eq!(debit.amount, -25.5);
        assert_eq!(debit.counterparty_name.as_deref(), Some("Energie BV"));
        assert_eq!(debit.description, "Factuur 2026-01");
        assert_eq!(debit.end_to_end_id.as_deref(), Some("E2E-1"));
        assert_eq!(debit.external_id.as_deref(), Some("BREF1"));
        assert_eq!(debit.reference, None);
        let credit = &result.transactions[1];
        assert_eq!(credit.reference.as_deref(), Some("INV-7"));
        assert_eq!(credit.description, "SEPA OVERBOEKING Factuur 7");
        assert_eq!(credit.counterparty_iban.as_deref(), Some("NL02RABO0123456789"));
        assert_eq!(credit.counterparty_name.as_deref(), Some("Klant"));
    }

    #[test]
    fn remittance_runs_to_the_next_field() {
        assert_eq!(remittance("/REMI/a/b/EREF/x").as_deref(), Some("a/b"));
        assert_eq!(remittance("/REMI/USTD//text").as_deref(), Some("text"));
        assert_eq!(remittance("/REMI/").as_deref(), Some(""));
    }
}
