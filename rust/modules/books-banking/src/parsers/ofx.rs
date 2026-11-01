//! OFX / QFX / QBO statements (`bank-parsers/ofx.ts`): OFX 1.x (SGML,
//! leaf elements without closing tags) and 2.x (XML). Amounts are signed
//! from the account holder's side already, so nothing is flipped.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::{
    ParseIssue, ParseResult, StatementAccount, Txn, clean_text, fixed2, js_trim,
    occurrence_counter, ofx_element_at, select_section, synthetic_external_id,
};

/// Elements that hold other elements; an empty-valued tag outside this list
/// is a blank leaf.
const AGGREGATES: &[&str] = &[
    "OFX",
    "SIGNONMSGSRSV1",
    "SONRS",
    "STATUS",
    "FI",
    "BANKMSGSRSV1",
    "STMTTRNRS",
    "STMTRS",
    "BANKACCTFROM",
    "BANKACCTTO",
    "BANKTRANLIST",
    "STMTTRN",
    "CREDITCARDMSGSRSV1",
    "CCSTMTTRNRS",
    "CCSTMTRS",
    "CCACCTFROM",
    "CCACCTTO",
    "LEDGERBAL",
    "AVAILBAL",
    "PAYEE",
    "BALLIST",
    "BAL",
    "INVSTMTMSGSRSV1",
    "INVSTMTTRNRS",
    "INVSTMTRS",
    "INVACCTFROM",
    "INVTRANLIST",
    "LOANMSGSRSV1",
    "SECLISTMSGSRSV1",
    "BANKMSGSET",
    "CREDITCARDMSGSET",
];

static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<(/?)([A-Za-z][A-Za-z0-9_.]*)\s*>([^<]*)").expect("tag pattern"));
static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&(#x[0-9a-f]+|#[0-9]+|[a-z]+);").expect("entity pattern"));

#[derive(Debug, Default)]
struct Node {
    name: String,
    value: Option<String>,
    children: Vec<usize>,
}

struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    fn child(&self, node: Option<usize>, name: &str) -> Option<usize> {
        let node = node?;
        self.nodes[node]
            .children
            .iter()
            .copied()
            .find(|c| self.nodes[*c].name == name)
    }

    /// `text(node, name)`: a child's non-empty value.
    fn text(&self, node: Option<usize>, name: &str) -> Option<String> {
        self.child(node, name)
            .and_then(|c| self.nodes[c].value.clone())
            .filter(|v| !v.is_empty())
    }

    /// `findAll`: every descendant called `name`, depth first.
    fn find_all(&self, node: usize, name: &str, found: &mut Vec<usize>) {
        for child in &self.nodes[node].children {
            if self.nodes[*child].name == name {
                found.push(*child);
            }
            self.find_all(*child, name, found);
        }
    }
}

/// `decodeEntities`; a code point past U+10FFFF throws, as
/// `String.fromCodePoint` does.
fn decode_entities(text: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut last = 0;
    for caps in ENTITY.captures_iter(text) {
        let whole = caps.get(0).expect("match");
        out.push_str(&text[last..whole.start()]);
        last = whole.end();
        let body = &caps[1];
        let code = if body.starts_with("#x") || body.starts_with("#X") {
            Some(parse_radix(&body[2..], 16))
        } else {
            body.strip_prefix('#').map(|digits| parse_radix(digits, 10))
        };
        match code {
            Some(code) => {
                if !(0.0..=1_114_111.0).contains(&code) {
                    return Err(format!(
                        "Invalid code point {}",
                        weldsuite_books_domain::js::number_text(code)
                    ));
                }
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let code = code as u32;
                out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
            }
            None => match body.to_lowercase().as_str() {
                "amp" => out.push('&'),
                "lt" => out.push('<'),
                "gt" => out.push('>'),
                "quot" => out.push('"'),
                "apos" => out.push('\''),
                _ => out.push_str(whole.as_str()),
            },
        }
    }
    out.push_str(&text[last..]);
    Ok(out)
}

/// `Number.parseInt(digits, radix)` of a run of valid digits, as a double.
fn parse_radix(digits: &str, radix: u32) -> f64 {
    digits.chars().fold(0.0, |total, c| {
        total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    })
}

/// `parseTree`: an element tree from SGML or XML markup.
fn parse_tree(markup: &str) -> Result<Tree, String> {
    let mut nodes = vec![Node {
        name: "#root".to_owned(),
        ..Node::default()
    }];
    let mut stack: Vec<usize> = vec![0];
    for caps in TAG.captures_iter(markup) {
        let name = caps[2].to_ascii_uppercase();
        if !caps[1].is_empty() {
            // A closing tag ends the nearest open aggregate of that name; a
            // leaf's closing tag (XML) has nothing open and is ignored.
            if let Some(at) = (1..stack.len())
                .rev()
                .find(|i| nodes[stack[*i]].name == name)
            {
                stack.truncate(at);
            }
            continue;
        }
        let value = decode_entities(&caps[3])?;
        let value = js_trim(&value).to_owned();
        let id = nodes.len();
        let aggregate = value.is_empty() && AGGREGATES.contains(&name.as_str());
        nodes.push(Node {
            name,
            value: (!value.is_empty()).then_some(value),
            children: Vec::new(),
        });
        let parent = *stack.last().expect("root");
        nodes[parent].children.push(id);
        if aggregate {
            stack.push(id);
        }
    }
    Ok(Tree { nodes })
}

/// `parseOfxDate`: `YYYYMMDD[HHMMSS[.XXX]][TZ]` as a calendar date; the
/// time and zone are dropped, never applied.
pub(crate) fn parse_ofx_date(value: Option<&str>) -> Option<String> {
    let value = js_trim(value?);
    let bytes = value.as_bytes();
    if bytes.len() < 8 || !bytes[..8].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let month: u32 = value[4..6].parse().ok()?;
    let day: u32 = value[6..8].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..8]))
}

/// `parseOfxAmount`: `.` or `,` as the decimal mark, never a thousands
/// separator.
pub(crate) fn parse_ofx_amount(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let mut cleaned: String = js_trim(value)
        .chars()
        .filter(|c| !super::is_space(*c))
        .collect();
    if cleaned.contains(',') && !cleaned.contains('.') {
        cleaned = cleaned.replacen(',', ".", 1);
    }
    if !is_decimal(&cleaned) {
        return None;
    }
    let number = weldsuite_books_domain::js::parse_float(&cleaned);
    number.is_finite().then_some(number)
}

/// `/^[+-]?\d+(\.\d*)?$|^[+-]?\.\d+$/`
fn is_decimal(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    match body.split_once('.') {
        None => !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit()),
        Some((whole, fraction)) => {
            fraction.bytes().all(|b| b.is_ascii_digit())
                && whole.bytes().all(|b| b.is_ascii_digit())
                && !(whole.is_empty() && fraction.is_empty())
        }
    }
}

struct Section {
    account: StatementAccount,
    transactions: Vec<Txn>,
    errors: Vec<ParseIssue>,
    closing_balance: Option<f64>,
    available_balance: Option<f64>,
    balance_date: Option<String>,
}

fn section_account(tree: &Tree, section: usize, is_card: bool) -> StatementAccount {
    let from = tree.child(
        Some(section),
        if is_card {
            "CCACCTFROM"
        } else {
            "BANKACCTFROM"
        },
    );
    let kind = tree.text(from, "ACCTTYPE").map(|t| t.to_uppercase());
    StatementAccount {
        routing_number: tree.text(from, "BANKID"),
        account_number: tree.text(from, "ACCTID"),
        account_type: if is_card {
            Some("credit_card".to_owned())
        } else {
            kind.and_then(|kind| match kind.as_str() {
                "CHECKING" => Some("checking".to_owned()),
                "SAVINGS" => Some("savings".to_owned()),
                "MONEYMRKT" => Some("money_market".to_owned()),
                "CREDITLINE" => Some("line_of_credit".to_owned()),
                _ => None,
            })
        },
        currency: tree.text(Some(section), "CURDEF").map(|c| c.to_uppercase()),
    }
}

fn parse_transaction(
    tree: &Tree,
    txn: usize,
    index: usize,
    next: &mut impl FnMut(&str) -> usize,
    errors: &mut Vec<ParseIssue>,
) -> Option<Txn> {
    let date = parse_ofx_date(tree.text(Some(txn), "DTPOSTED").as_deref());
    let amount = parse_ofx_amount(tree.text(Some(txn), "TRNAMT").as_deref());
    let (Some(date), Some(amount)) = (date.clone(), amount) else {
        errors.push(ParseIssue::new(format!(
            "Transaction {}: missing or unreadable {}",
            index + 1,
            if date.is_some() { "TRNAMT" } else { "DTPOSTED" }
        )));
        return None;
    };

    let name = tree
        .text(Some(txn), "NAME")
        .or_else(|| tree.text(tree.child(Some(txn), "PAYEE"), "NAME"))
        .or_else(|| tree.text(Some(txn), "EXTDNAME"));
    let memo = tree.text(Some(txn), "MEMO");
    let mut parts: Vec<String> = Vec::new();
    if let Some(name) = &name {
        parts.push(clean_text(Some(name)));
    }
    if let Some(memo) = &memo {
        let same = name.as_ref().is_some_and(|name| {
            clean_text(Some(memo)).to_lowercase() == clean_text(Some(name)).to_lowercase()
        });
        if !same {
            parts.push(clean_text(Some(memo)));
        }
    }
    let name = name.map(|n| clean_text(Some(&n)));
    let description = parts.join(" - ");
    let kind = tree.text(Some(txn), "TRNTYPE").map(|t| t.to_uppercase());
    let check_number = tree.text(Some(txn), "CHECKNUM");
    let reference = tree
        .text(Some(txn), "REFNUM")
        .or_else(|| tree.text(Some(txn), "SRVRTID"));

    let fitid = tree.text(Some(txn), "FITID");
    let amount_text = fixed2(amount);
    let external_id = if let Some(fitid) = &fitid {
        let occurrence = next(&format!("fitid|{fitid}"));
        if occurrence > 1 {
            format!("{fitid}#{occurrence}")
        } else {
            fitid.clone()
        }
    } else {
        let key = [
            date.as_str(),
            amount_text.as_str(),
            name.as_deref().unwrap_or_default(),
            description.as_str(),
        ]
        .join("|");
        let occurrence = next(&key);
        synthetic_external_id(
            "ofx",
            &[
                Some(&date),
                Some(&amount_text),
                name.as_deref(),
                Some(&description),
                check_number.as_deref(),
            ],
            occurrence,
        )
    };

    let value_date = parse_ofx_date(
        tree.text(Some(txn), "DTUSER")
            .or_else(|| tree.text(Some(txn), "DTAVAIL"))
            .as_deref(),
    )
    .filter(|value| *value != date);
    let mut raw = Map::new();
    raw.insert("format".to_owned(), json!("ofx"));
    if let Some(kind) = &kind {
        raw.insert("trnType".to_owned(), json!(kind));
    }
    raw.insert("fitid".to_owned(), json!(fitid));
    let description = if description.is_empty() {
        kind.clone().unwrap_or_default()
    } else {
        description
    };
    Some(Txn {
        date,
        value_date,
        description,
        amount,
        counterparty_name: name,
        reference,
        transaction_code: kind,
        check_number,
        external_id: Some(external_id),
        raw_data: Some(Value::Object(raw)),
        ..Txn::default()
    })
}

fn parse_section(tree: &Tree, node: usize, is_card: bool) -> Section {
    let account = section_account(tree, node, is_card);
    let mut errors = Vec::new();
    let mut next = occurrence_counter();
    let mut transactions = Vec::new();
    if let Some(list) = tree.child(Some(node), "BANKTRANLIST") {
        let lines: Vec<usize> = tree.nodes[list]
            .children
            .iter()
            .copied()
            .filter(|c| tree.nodes[*c].name == "STMTTRN")
            .collect();
        for (index, txn) in lines.into_iter().enumerate() {
            if let Some(parsed) = parse_transaction(tree, txn, index, &mut next, &mut errors) {
                transactions.push(parsed);
            }
        }
    }
    let ledger = tree.child(Some(node), "LEDGERBAL");
    let available = tree.child(Some(node), "AVAILBAL");
    Section {
        account,
        transactions,
        errors,
        closing_balance: parse_ofx_amount(tree.text(ledger, "BALAMT").as_deref()),
        available_balance: parse_ofx_amount(tree.text(available, "BALAMT").as_deref()),
        balance_date: parse_ofx_date(tree.text(ledger, "DTASOF").as_deref()),
    }
}

/// `parseOfx(content, { format, accountLast4 })`.
pub(crate) fn parse(content: &str, format: &str, account_last4: Option<&str>) -> ParseResult {
    let mut result = ParseResult::new(format);
    let Some(start) = ofx_element_at(content) else {
        result
            .errors
            .push(ParseIssue::new("No <OFX> document found in this file"));
        return result;
    };
    let tree = match parse_tree(&content[start..]) {
        Ok(tree) => tree,
        Err(message) => {
            result.errors.push(ParseIssue::new(format!(
                "Unexpected OFX parse error: {message}"
            )));
            return result;
        }
    };
    let mut nodes = Vec::new();
    tree.find_all(0, "STMTRS", &mut nodes);
    let mut sections: Vec<Section> = nodes
        .into_iter()
        .map(|n| parse_section(&tree, n, false))
        .collect();
    let mut cards = Vec::new();
    tree.find_all(0, "CCSTMTRS", &mut cards);
    sections.extend(cards.into_iter().map(|n| parse_section(&tree, n, true)));
    if sections.is_empty() {
        result.errors.push(ParseIssue::new(
            "No bank or credit card statement found in this OFX file",
        ));
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
    result.errors.extend(selected.errors);
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

    const SGML: &str = "OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<STMTRS>\n<CURDEF>usd\n<BANKACCTFROM>\n<BANKID>021000021\n<ACCTID>123456789\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>\n<BANKTRANLIST>\n<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20260215120000.000[-5:EST]\n<TRNAMT>-42.10\n<FITID>F1\n<CHECKNUM>1042\n<NAME>ACME &amp; CO\n<MEMO>Acme &amp; Co\n</STMTTRN>\n<STMTTRN>\n<TRNTYPE>CREDIT\n<DTPOSTED>20260201\n<TRNAMT>100,5\n<NAME>Client\n<MEMO>Invoice 7\n</STMTTRN>\n<STMTTRN>\n<DTPOSTED>2026\n<TRNAMT>1\n</STMTTRN>\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>958.40\n<DTASOF>20260228\n</LEDGERBAL>\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n";

    #[test]
    fn reads_an_sgml_statement() {
        let result = parse(SGML, "ofx", None);
        assert_eq!(result.transactions.len(), 2);
        let first = &result.transactions[0];
        assert_eq!(first.date, "2026-02-15");
        assert_eq!(first.amount, -42.1);
        assert_eq!(first.description, "ACME & CO");
        assert_eq!(first.check_number.as_deref(), Some("1042"));
        assert_eq!(first.external_id.as_deref(), Some("F1"));
        let second = &result.transactions[1];
        assert_eq!(second.amount, 100.5);
        assert_eq!(second.description, "Client - Invoice 7");
        assert!(
            second
                .external_id
                .as_deref()
                .is_some_and(|id| id.starts_with("ofx:"))
        );
        assert_eq!(result.closing_balance, Some(958.4));
        assert_eq!(result.currency.as_deref(), Some("USD"));
        assert_eq!(
            result
                .account
                .as_ref()
                .and_then(|a| a.account_type.as_deref()),
            Some("checking")
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(
            result.errors[0].message,
            "Transaction 3: missing or unreadable DTPOSTED"
        );
        assert_eq!(
            result.date_range,
            Some(("2026-02-01".to_owned(), "2026-02-15".to_owned()))
        );
    }

    #[test]
    fn amounts_and_dates() {
        assert_eq!(parse_ofx_amount(Some(" -1,5 ")), Some(-1.5));
        assert_eq!(parse_ofx_amount(Some("1,234.56")), None);
        assert_eq!(parse_ofx_amount(Some(".5")), Some(0.5));
        assert_eq!(parse_ofx_amount(Some("5.")), Some(5.0));
        assert_eq!(parse_ofx_amount(Some(".")), None);
        assert_eq!(parse_ofx_date(Some("20261301")), None);
        assert_eq!(
            parse_ofx_date(Some("20260131235959")).as_deref(),
            Some("2026-01-31")
        );
    }
}
