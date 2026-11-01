//! BAI2 cash-management files (`bank-parsers/bai2.ts`): 01 file header, 02
//! group header, 03 account and balances, 16 detail, 88 continuation, 49
//! account trailer. Amounts are cents; detail type codes 100-399 are
//! credits, 400-699 debits.

use serde_json::json;

use super::{
    ParseIssue, ParseResult, StatementAccount, Txn, clean_text, fixed2, js_trim,
    occurrence_counter, select_section, strip_bom, synthetic_external_id,
};

/// Common detail type codes, used when the bank sends no text.
fn type_label(code: &str) -> Option<&'static str> {
    Some(match code {
        "108" => "Credit",
        "115" => "Lockbox deposit",
        "142" => "ACH credit received",
        "165" => "Preauthorized ACH credit",
        "174" => "Other deposit",
        "175" => "Check deposit",
        "195" => "Incoming money transfer",
        "275" => "Online banking deposit",
        "399" => "Miscellaneous credit",
        "408" => "Debit",
        "451" => "ACH debit received",
        "475" => "Check paid",
        "495" => "Outgoing money transfer",
        "501" => "Preauthorized ACH debit",
        "555" => "Debit in lieu of check",
        "698" => "Miscellaneous fee",
        "699" => "Miscellaneous debit",
        _ => return None,
    })
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `parseBai2Date`: `YYMMDD` as `20YY-MM-DD`.
pub(crate) fn parse_bai2_date(value: Option<&str>) -> Option<String> {
    let value = js_trim(value.unwrap_or_default());
    if value.len() != 6 || !all_digits(value) {
        return None;
    }
    let month: u32 = value[2..4].parse().ok()?;
    let day: u32 = value[4..6].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("20{}-{}-{}", &value[..2], &value[2..4], &value[4..6]))
}

/// `parseBai2Amount`: cents, or a decimal when the bank sends one.
pub(crate) fn parse_bai2_amount(value: Option<&str>) -> Option<f64> {
    let trimmed = js_trim(value.unwrap_or_default());
    if trimmed.is_empty() {
        return None;
    }
    let body = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if all_digits(body) {
        let cents = weldsuite_books_domain::js::parse_float(trimmed);
        return Some(cents / 100.0);
    }
    if let Some((whole, fraction)) = body.split_once('.')
        && whole.bytes().all(|b| b.is_ascii_digit())
        && all_digits(fraction)
    {
        return Some(weldsuite_books_domain::js::parse_float(trimmed));
    }
    None
}

struct Record {
    code: String,
    fields: Vec<String>,
    line: usize,
}

/// `body.replace(/\/\s*$/, '')`
fn drop_terminator(body: &str) -> &str {
    let trimmed = body.trim_end_matches(super::is_space);
    trimmed.strip_suffix('/').unwrap_or(body)
}

/// `readRecords`: physical lines joined into records.
fn read_records(content: &str) -> Vec<Record> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut records = Vec::new();
    let mut open: Option<(String, String, usize)> = None;
    let close = |open: &mut Option<(String, String, usize)>, records: &mut Vec<Record>| {
        if let Some((code, body, line)) = open.take() {
            let body = drop_terminator(&body);
            records.push(Record {
                code,
                fields: body.split(',').map(str::to_owned).collect(),
                line,
            });
        }
    };
    for (index, raw) in normalized.split('\n').enumerate() {
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        let record_start = line.len() >= 3
            && line.as_bytes()[..2].iter().all(u8::is_ascii_digit)
            && line.as_bytes()[2] == b',';
        if line.starts_with("88,") && open.is_some() {
            if let Some((_, body, _)) = &mut open {
                *body = format!("{},{}", drop_terminator(body), &line[3..]);
            }
        } else if record_start {
            close(&mut open, &mut records);
            open = Some((line[..2].to_owned(), line.to_owned(), index + 1));
        } else if let Some((_, body, _)) = &mut open {
            body.push_str(line);
        }
    }
    close(&mut open, &mut records);
    records
}

fn field(fields: &[String], at: usize) -> &str {
    fields.get(at).map_or("", String::as_str)
}

/// `fundsExtra`: the extra fields a funds-availability type brings along.
fn funds_extra(fields: &[String], at: usize, funds_type: &str) -> usize {
    match funds_type.to_uppercase().as_str() {
        "S" => 3,
        "V" => 2,
        "D" => {
            let raw = fields.get(at).map_or("0", String::as_str);
            match weldsuite_books_domain::js::parse_int(raw) {
                Some(count) => 1 + usize::try_from(count.max(0)).unwrap_or(0) * 2,
                None => 1,
            }
        }
        _ => 0,
    }
}

/// `readStatusItems`: the 03 record's type code, amount, count, funds type.
fn read_status_items(fields: &[String]) -> Vec<(String, Option<f64>)> {
    let mut items = Vec::new();
    let mut i = 3;
    while i < fields.len() {
        let type_code = js_trim(field(fields, i)).to_owned();
        if type_code.is_empty() {
            i += 1;
            continue;
        }
        let funds_type = field(fields, i + 3).to_owned();
        items.push((type_code, parse_bai2_amount(fields.get(i + 1).map(String::as_str))));
        i += 4 + funds_extra(fields, i + 4, &funds_type);
    }
    items
}

#[derive(Default)]
struct Section {
    account: StatementAccount,
    transactions: Vec<Txn>,
    opening_balance: Option<f64>,
    closing_balance: Option<f64>,
    available_balance: Option<f64>,
    balance_date: Option<String>,
}

fn is_credit(type_code: &str) -> Option<bool> {
    let code = weldsuite_books_domain::js::parse_int(type_code)?;
    if (100..=399).contains(&code) {
        Some(true)
    } else if (400..=699).contains(&code) {
        Some(false)
    } else {
        None
    }
}

fn read_detail(
    record: &Record,
    as_of: Option<&str>,
    next: &mut impl FnMut(&str) -> usize,
    account_number: &str,
    errors: &mut Vec<ParseIssue>,
) -> Option<Txn> {
    let f = &record.fields;
    let type_code = js_trim(field(f, 1)).to_owned();
    let cents = parse_bai2_amount(f.get(2).map(String::as_str));
    let funds_type = js_trim(field(f, 3)).to_owned();
    let Some(cents) = cents.filter(|_| !type_code.is_empty()) else {
        errors.push(ParseIssue::at(
            record.line,
            "Transaction record without a type code or amount",
        ));
        return None;
    };
    let Some(credit) = is_credit(&type_code) else {
        errors.push(ParseIssue::at(
            record.line,
            format!("Skipped transaction with unsupported type code {type_code}"),
        ));
        return None;
    };
    let mut at = 4;
    let mut value_date = None;
    if funds_type.to_uppercase() == "V" {
        value_date = parse_bai2_date(f.get(4).map(String::as_str));
        at += 2;
    } else {
        at += funds_extra(f, at, &funds_type);
    }
    let bank_reference = clean_text(f.get(at).map(String::as_str));
    let customer_reference = clean_text(f.get(at + 1).map(String::as_str));
    let detail = clean_text(Some(&f.get(at + 2..).map(|rest| rest.join(" ")).unwrap_or_default()));

    let Some(date) = as_of.map(str::to_owned) else {
        errors.push(ParseIssue::at(
            record.line,
            "Transaction record without an as-of date on its group",
        ));
        return None;
    };
    let amount = cents.abs() * if credit { 1.0 } else { -1.0 };
    let description = if detail.is_empty() {
        type_label(&type_code).map_or_else(|| format!("BAI type {type_code}"), str::to_owned)
    } else {
        detail
    };
    let short_digits = |v: &str| (1..=10).contains(&v.len()) && all_digits(v);
    let check_number = (type_code == "475")
        .then(|| {
            if short_digits(&customer_reference) {
                Some(customer_reference.clone())
            } else if short_digits(&bank_reference) {
                Some(bank_reference.clone())
            } else {
                None
            }
        })
        .flatten();
    let amount_text = fixed2(amount);
    let parts = [
        account_number,
        date.as_str(),
        type_code.as_str(),
        amount_text.as_str(),
        bank_reference.as_str(),
        customer_reference.as_str(),
        description.as_str(),
    ];
    let occurrence = next(&parts.join("|"));
    let external_id = synthetic_external_id(
        "bai2",
        &parts.iter().map(|p| Some(*p)).collect::<Vec<_>>(),
        occurrence,
    );
    let non_empty = |v: &str| (!v.is_empty()).then(|| v.to_owned());
    Some(Txn {
        value_date: value_date.filter(|v| *v != date),
        date,
        description,
        amount,
        reference: non_empty(&customer_reference).or_else(|| non_empty(&bank_reference)),
        transaction_code: Some(type_code.clone()),
        check_number,
        external_id: Some(external_id),
        raw_data: Some(json!({
            "format": "bai2",
            "typeCode": type_code,
            "bankReference": non_empty(&bank_reference),
            "customerReference": non_empty(&customer_reference),
        })),
        ..Txn::default()
    })
}

/// `parseBai2(content, { accountLast4 })`.
pub(crate) fn parse(content: &str, account_last4: Option<&str>) -> ParseResult {
    let mut result = ParseResult::new("bai2");
    let records = read_records(strip_bom(content));
    if !records.iter().any(|r| r.code == "01") {
        result
            .errors
            .push(ParseIssue::new("Not a BAI2 file: no 01 file header record"));
        return result;
    }
    let mut sections: Vec<Section> = Vec::new();
    let mut errors = Vec::new();
    let mut next = occurrence_counter();
    let mut as_of: Option<String> = None;
    let mut group_currency: Option<String> = None;
    let mut open = false;
    for record in &records {
        let f = &record.fields;
        match record.code.as_str() {
            "02" => {
                as_of = parse_bai2_date(f.get(4).map(String::as_str));
                group_currency = Some(js_trim(field(f, 6)).to_uppercase()).filter(|c| !c.is_empty());
            }
            "03" => {
                let number = js_trim(field(f, 1)).to_owned();
                let currency = Some(js_trim(field(f, 2)).to_uppercase())
                    .filter(|c| !c.is_empty())
                    .or_else(|| group_currency.clone());
                let mut section = Section {
                    account: StatementAccount {
                        account_number: (!number.is_empty()).then_some(number),
                        currency,
                        ..StatementAccount::default()
                    },
                    balance_date: as_of.clone(),
                    ..Section::default()
                };
                for (code, amount) in read_status_items(f) {
                    let Some(amount) = amount else { continue };
                    match code.as_str() {
                        "010" => section.opening_balance = Some(amount),
                        "015" => section.closing_balance = Some(amount),
                        "045" => section.available_balance = Some(amount),
                        _ => {}
                    }
                }
                sections.push(section);
                open = true;
            }
            "16" => {
                if !open {
                    errors.push(ParseIssue::at(record.line, "Transaction record outside an account"));
                    continue;
                }
                if let Some(section) = sections.last_mut() {
                    let number = section.account.account_number.clone().unwrap_or_default();
                    if let Some(txn) = read_detail(record, as_of.as_deref(), &mut next, &number, &mut errors) {
                        section.transactions.push(txn);
                    }
                }
            }
            "49" => open = false,
            _ => {}
        }
    }
    if sections.is_empty() {
        result
            .errors
            .push(ParseIssue::new("No account records (03) found in this BAI2 file"));
        return result;
    }
    result.accounts = Some(sections.iter().map(|s| s.account.clone()).collect());
    let Some(at) = select_section(
        &sections,
        |s| s.account.account_number.as_deref(),
        account_last4,
        &mut result.errors,
    ) else {
        return result;
    };
    let selected = sections.swap_remove(at);
    result.currency.clone_from(&selected.account.currency);
    result.account = Some(selected.account);
    result.transactions = selected.transactions;
    result.errors.extend(errors);
    result.opening_balance = selected.opening_balance;
    result.closing_balance = selected.closing_balance;
    result.available_balance = selected.available_balance;
    result.balance_date = selected.balance_date;
    if !result.transactions.is_empty() {
        result.set_date_range();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_prior_day_file() {
        let file = "01,121000248,WELD,260301,0800,1,,,2/\n02,WELD,121000248,1,260228,,USD,2/\n03,9988776655,USD,010,150000,,,015,250000,,/\n16,475,12500,,0000001042,1042/\n16,142,22500,,REF1,,ACME CORP\n88,INV 2001/\n49,500000,3/\n98,500000,1,5/\n99,500000,1,7/\n";
        let result = parse(file, None);
        assert_eq!(result.transactions.len(), 2);
        let check = &result.transactions[0];
        assert_eq!(check.amount, -125.0);
        assert_eq!(check.check_number.as_deref(), Some("1042"));
        assert_eq!(check.description, "Check paid");
        let credit = &result.transactions[1];
        assert_eq!(credit.amount, 225.0);
        assert_eq!(credit.description, "ACME CORP INV 2001");
        assert_eq!(result.opening_balance, Some(1500.0));
        assert_eq!(result.closing_balance, Some(2500.0));
        assert_eq!(result.balance_date.as_deref(), Some("2026-02-28"));
    }

    #[test]
    fn amounts_and_dates() {
        assert_eq!(parse_bai2_amount(Some("12345")), Some(123.45));
        assert_eq!(parse_bai2_amount(Some("-1.5")), Some(-1.5));
        assert_eq!(parse_bai2_amount(Some("1.")), None);
        assert_eq!(parse_bai2_date(Some("261301")), None);
    }
}
