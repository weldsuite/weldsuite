//! CAMT.053 (ISO 20022) statements (`bank-parsers/camt053.ts`), read with
//! the worker's own lightweight tag matching (no DOM): the first statement,
//! its balances and entries.

use regex::Regex;

use super::{ParseIssue, ParseResult, Txn, js_trim};

fn escape(tag: &str) -> String {
    regex::escape(tag)
}

fn open_pattern(tag: &str) -> Regex {
    Regex::new(&format!(r"<(?:[a-zA-Z0-9]+:)?{}(?:\s[^>]*)?>", escape(tag))).expect("open pattern")
}

fn close_pattern(tag: &str) -> Regex {
    Regex::new(&format!(r"</(?:[a-zA-Z0-9]+:)?{}>", escape(tag))).expect("close pattern")
}

fn value_pattern(tag: &str) -> Regex {
    let tag = escape(tag);
    Regex::new(&format!(
        r"<(?:[a-zA-Z0-9]+:)?{tag}(?:\s[^>]*)?>([^<]*)</(?:[a-zA-Z0-9]+:)?{tag}>"
    ))
    .expect("value pattern")
}

/// `extractBlock`: the inner content of the first `tag`.
fn block<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = open_pattern(tag).find(xml)?;
    let start = open.end();
    let close = close_pattern(tag).find(&xml[start..])?;
    Some(&xml[start..start + close.start()])
}

/// `extractAllBlocks`: every `tag`'s inner content (opening tags searched
/// one after another, each closed by the next closing tag).
fn all_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let close = close_pattern(tag);
    open_pattern(tag)
        .find_iter(xml)
        .filter_map(|open| {
            let start = open.end();
            close
                .find_at(xml, start)
                .map(|end| &xml[start..end.start()])
        })
        .collect()
}

/// `extractTagValue`: a leaf's trimmed text.
fn value(xml: &str, tag: &str) -> Option<String> {
    value_pattern(tag)
        .captures(xml)
        .map(|caps| js_trim(&caps[1]).to_owned())
}

fn all_values(xml: &str, tag: &str) -> Vec<String> {
    value_pattern(tag)
        .captures_iter(xml)
        .map(|caps| js_trim(&caps[1]).to_owned())
        .collect()
}

/// `a || b` over optional strings (an empty string is falsy).
fn or_else(a: Option<String>, b: impl FnOnce() -> Option<String>) -> Option<String> {
    match a {
        Some(a) if !a.is_empty() => Some(a),
        _ => b(),
    }
}

fn filled(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

#[derive(Default)]
struct Details {
    description: Option<String>,
    counterparty_name: Option<String>,
    counterparty_iban: Option<String>,
    counterparty_bic: Option<String>,
    reference: Option<String>,
    end_to_end_id: Option<String>,
    mandate_id: Option<String>,
    external_id: Option<String>,
}

fn counterparty_block<'a>(
    xml: &'a str,
    is_debit: bool,
    creditor: &str,
    debtor: &str,
) -> Option<&'a str> {
    let pick = |tag: &str| block(xml, tag).filter(|b| !b.is_empty());
    if is_debit {
        pick(creditor).or_else(|| pick(debtor))
    } else {
        pick(debtor).or_else(|| pick(creditor))
    }
}

fn tx_details(tx: &str, is_debit: bool) -> Details {
    let mut details = Details::default();
    if let Some(refs) = block(tx, "Refs") {
        let instr = value(refs, "InstrId");
        details.end_to_end_id = filled(value(refs, "EndToEndId"));
        details.mandate_id = filled(value(refs, "MndtId"));
        details.external_id = filled(value(refs, "AcctSvcrRef"));
        details.reference = instr.filter(|i| !i.is_empty() && i != "NOTPROVIDED");
    }
    let mut structured = None;
    if let Some(rmt) = block(tx, "RmtInf") {
        let unstructured = all_values(rmt, "Ustrd");
        if !unstructured.is_empty() {
            details.description = Some(unstructured.join(" "));
        }
        structured = block(rmt, "Strd")
            .and_then(|s| block(s, "CdtrRefInf"))
            .and_then(|c| filled(value(c, "Ref")));
    }
    details.reference = or_else(details.reference, || structured);
    if let Some(parties) = block(tx, "RltdPties") {
        details.counterparty_name = counterparty_block(parties, is_debit, "Cdtr", "Dbtr")
            .and_then(|p| filled(value(p, "Nm")));
        details.counterparty_iban = counterparty_block(parties, is_debit, "CdtrAcct", "DbtrAcct")
            .and_then(|a| block(a, "Id"))
            .and_then(|id| filled(value(id, "IBAN")));
    }
    details.counterparty_bic = block(tx, "RltdAgts")
        .and_then(|agents| counterparty_block(agents, is_debit, "CdtrAgt", "DbtrAgt"))
        .and_then(|agent| block(agent, "FinInstnId"))
        .and_then(|fin| or_else(value(fin, "BIC"), || value(fin, "BICFI")))
        .filter(|bic| !bic.is_empty());
    details
}

fn transaction_code(entry: &str) -> Option<String> {
    let domain = block(entry, "BkTxCd").and_then(|code| block(code, "Domn"))?;
    let code = value(domain, "Cd");
    let family = block(domain, "Fmly");
    let family_code = family.and_then(|f| value(f, "Cd"));
    let sub_family = family.and_then(|f| value(f, "SubFmlyCd"));
    Some(
        [code, family_code, sub_family]
            .into_iter()
            .flatten()
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>()
            .join("-"),
    )
}

fn parse_entry(entry: &str) -> Option<Txn> {
    let date = filled(block(entry, "BookgDt").and_then(|b| value(b, "Dt")))?;
    let value_date = filled(block(entry, "ValDt").and_then(|b| value(b, "Dt")));
    let amount = match value(entry, "Amt") {
        Some(text) if !text.is_empty() => weldsuite_books_domain::js::parse_float(&text),
        _ => 0.0,
    };
    let indicator = value(entry, "CdtDbtInd");
    let is_debit = indicator.as_deref() == Some("DBIT");
    let signed = if is_debit {
        -amount.abs()
    } else {
        amount.abs()
    };
    let code = transaction_code(entry);
    let details = block(entry, "NtryDtls")
        .and_then(|d| block(d, "TxDtls"))
        .map(|tx| tx_details(tx, is_debit))
        .unwrap_or_default();
    let description =
        or_else(details.description, || value(entry, "AddtlNtryInf")).unwrap_or_default();
    let external_id = filled(or_else(details.external_id, || value(entry, "AcctSvcrRef")));
    let end_to_end_id = details.end_to_end_id.filter(|e| e != "NOTPROVIDED");
    Some(Txn {
        date,
        value_date,
        description,
        amount: signed,
        counterparty_name: details.counterparty_name,
        counterparty_iban: details.counterparty_iban,
        counterparty_bic: details.counterparty_bic,
        reference: details.reference,
        transaction_code: code,
        end_to_end_id,
        mandate_id: details.mandate_id,
        external_id,
        ..Txn::default()
    })
}

/// `parseCAMT053(content)`.
pub(crate) fn parse(content: &str) -> ParseResult {
    let mut result = ParseResult::new("camt053");
    let xml = content.replace("\r\n", "\n").replace('\r', "\n");
    let statements = all_blocks(&xml, "Stmt");
    let Some(statement) = statements.first() else {
        result
            .errors
            .push(ParseIssue::new("No Stmt blocks found in CAMT.053 document"));
        return result;
    };
    if let Some(iban) = block(statement, "Acct").and_then(|a| filled(value(a, "IBAN"))) {
        result.account_iban = Some(iban);
    }
    for balance in all_blocks(statement, "Bal") {
        let kind =
            block(balance, "Tp").and_then(|tp| or_else(value(tp, "Cd"), || value(tp, "Prtry")));
        let Some(amount) = value(balance, "Amt") else {
            continue;
        };
        let amount = weldsuite_books_domain::js::parse_float(&amount);
        let signed = if value(balance, "CdtDbtInd").as_deref() == Some("DBIT") {
            -amount
        } else {
            amount
        };
        match kind.as_deref() {
            Some("OPBD" | "PRCD") => result.opening_balance = Some(signed),
            Some("CLBD") => result.closing_balance = Some(signed),
            _ => {}
        }
    }
    for entry in all_blocks(statement, "Ntry") {
        if let Some(txn) = parse_entry(entry) {
            result.transactions.push(txn);
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
    fn reads_the_first_statement() {
        let xml = r#"<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">950.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="EUR">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-01-05</Dt></BookgDt><ValDt><Dt>2026-01-06</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId><InstrId>INS-1</InstrId></Refs>
<RltdPties><Cdtr><Nm>Energie BV</Nm></Cdtr><CdtrAcct><Id><IBAN>NL02RABO0123456789</IBAN></Id></CdtrAcct></RltdPties>
<RmtInf><Ustrd>Factuur</Ustrd><Ustrd>2026-01</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>"#;
        let result = parse(xml);
        assert_eq!(result.account_iban.as_deref(), Some("NL91ABNA0417164300"));
        assert_eq!(result.opening_balance, Some(1000.0));
        assert_eq!(result.closing_balance, Some(950.0));
        let txn = &result.transactions[0];
        assert_eq!(txn.amount, -50.0);
        assert_eq!(txn.value_date.as_deref(), Some("2026-01-06"));
        assert_eq!(txn.transaction_code.as_deref(), Some("PMNT-ICDT-ESCT"));
        assert_eq!(txn.description, "Factuur 2026-01");
        assert_eq!(txn.counterparty_name.as_deref(), Some("Energie BV"));
        assert_eq!(txn.counterparty_iban.as_deref(), Some("NL02RABO0123456789"));
        assert_eq!(txn.reference.as_deref(), Some("INS-1"));
        assert_eq!(txn.end_to_end_id, None);
    }
}
