//! SEPA credit transfers for net salaries and the payroll tax (`sepa.ts`):
//! a pain.001.001.09 file.

use std::fmt::Write as _;

use serde::Deserialize;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::documents::GeneratedFile;
use crate::js::{is_integer, math_round, number_text};
use crate::types::PayrollIssue;

pub const PAIN_001_NAMESPACE: &str = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";
const BELASTINGDIENST_ING: &str = "NL86INGB0002445588";
const BELASTINGDIENST_RABOBANK: &str = "NL04RABO0200112244";

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SepaParty {
    pub name: String,
    pub iban: String,
    #[serde(default)]
    pub bic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SepaSalaryPayment {
    pub end_to_end_id: String,
    pub creditor: SepaParty,
    pub amount_cents: f64,
    pub remittance: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SepaTaxPayment {
    pub amount_cents: f64,
    pub betalingskenmerk: String,
    #[serde(default)]
    pub creditor: Option<SepaParty>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SepaSalaryBatchInput {
    pub message_id: String,
    pub created_at: String,
    pub execution_date: String,
    pub debtor: SepaParty,
    pub salaries: Vec<SepaSalaryPayment>,
    #[serde(default)]
    pub tax: Option<SepaTaxPayment>,
}

/// `belastingdienstAccount(executionDate)`.
pub fn belastingdienst_account(execution_date: &str) -> SepaParty {
    let iban = if execution_date < "2026-05-01" {
        BELASTINGDIENST_ING
    } else {
        BELASTINGDIENST_RABOBANK
    };
    SepaParty {
        name: "Belastingdienst".into(),
        iban: iban.into(),
        bic: None,
    }
}

/// `normalizeIban(iban)`.
pub fn normalize_iban(iban: &str) -> String {
    iban.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{feff}')
        .collect::<String>()
        .to_uppercase()
}

/// `isValidIban(iban)`.
pub fn is_valid_iban(iban: &str) -> bool {
    let s = normalize_iban(iban);
    let b = s.as_bytes();
    let shape = (5..=34).contains(&b.len())
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..4].iter().all(u8::is_ascii_digit)
        && b[4..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !shape {
        return false;
    }
    if s.starts_with("NL")
        && !(b.len() == 18
            && b[4..8].iter().all(u8::is_ascii_uppercase)
            && b[8..].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    let rearranged = format!("{}{}", &s[4..], &s[..4]);
    let mut remainder: u32 = 0;
    for ch in rearranged.chars() {
        let digits = if ch.is_ascii_uppercase() {
            (u32::from(ch) - 55).to_string()
        } else {
            ch.to_string()
        };
        for d in digits.chars() {
            remainder = (remainder * 10 + d.to_digit(10).unwrap_or(0)) % 97;
        }
    }
    remainder == 1
}

/// `isValidBetalingskenmerk(reference)`.
pub fn is_valid_betalingskenmerk(reference: &str) -> bool {
    let s: String = reference
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '.' && *c != '\u{feff}')
        .collect();
    if s.len() != 16 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let d: Vec<i64> = s.bytes().map(|b| i64::from(b - b'0')).collect();
    let weights = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1];
    let sum: i64 = (0..15)
        .map(|i| d[15 - i] * weights[i % weights.len()])
        .sum();
    let check = 11 - (sum % 11);
    d[0] == match check {
        10 => 1,
        11 => 0,
        c => c,
    }
}

fn valid_amount(cents: f64) -> bool {
    is_integer(cents) && (1.0..=99_999_999_999.0).contains(&cents)
}

const NON_EEA_SEPA: [&str; 7] = ["CH", "GB", "SM", "VA", "MC", "AD", "GI"];

/// `/^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/`.
fn is_bic(bic: &str) -> bool {
    let b = bic.as_bytes();
    if b.len() != 8 && b.len() != 11 {
        return false;
    }
    b[..6].iter().all(u8::is_ascii_uppercase)
        && (b[6].is_ascii_uppercase() || (b'2'..=b'9').contains(&b[6]))
        && ((b[7].is_ascii_uppercase() && b[7] != b'O') || b[7].is_ascii_digit())
        && b[8..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn latin_extra(c: char) -> Option<&'static str> {
    Some(match c {
        'ß' => "ss",
        'ø' => "o",
        'Ø' => "O",
        'æ' => "ae",
        'Æ' => "AE",
        'œ' => "oe",
        'Œ' => "OE",
        'ł' => "l",
        'Ł' => "L",
        'đ' => "d",
        'Đ' => "D",
        'þ' => "th",
        'Þ' => "Th",
        _ => return None,
    })
}

/// `toSepaText(text, max)`: the SEPA Latin character set.
pub fn to_sepa_text(text: &str, max: usize) -> String {
    let mut ascii = String::new();
    for c in text.nfd() {
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
        match latin_extra(c) {
            Some(s) => ascii.push_str(s),
            None if c == '&' => ascii.push('+'),
            None => ascii.push(c),
        }
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || "/-?:().,'+ ".contains(c);
    let replaced: String = ascii
        .chars()
        .map(|c| if allowed(c) { c } else { ' ' })
        .collect();
    let mut collapsed = String::new();
    let mut space = false;
    for c in replaced.chars() {
        if c == ' ' {
            if !space {
                collapsed.push(' ');
            }
            space = true;
        } else {
            collapsed.push(c);
            space = false;
        }
    }
    collapsed.trim().chars().take(max).collect()
}

fn to_sepa_id(text: &str, max: usize) -> String {
    let t = to_sepa_text(text, max);
    let mut out = String::new();
    let mut slashes = 0;
    for c in t.chars() {
        if c == '/' {
            slashes += 1;
            if slashes == 1 {
                out.push('/');
            }
        } else {
            slashes = 0;
            out.push(c);
        }
    }
    let trimmed = out.trim_matches('/');
    trimmed.replace(' ', "-").chars().take(max).collect()
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn amount(cents: f64) -> String {
    let sign = if cents < 0.0 { "-" } else { "" };
    let abs = math_round(cents).abs();
    format!(
        "{sign}{}.{:0>2}",
        number_text((abs / 100.0).floor()),
        number_text(abs % 100.0)
    )
}

enum Content {
    Text(String),
    Children(Vec<Node>),
}

struct Node {
    name: &'static str,
    content: Content,
    attrs: Vec<(&'static str, String)>,
}

fn text(name: &'static str, value: impl Into<String>) -> Node {
    Node {
        name,
        content: Content::Text(value.into()),
        attrs: vec![],
    }
}

fn parent(name: &'static str, children: Vec<Node>) -> Node {
    Node {
        name,
        content: Content::Children(children),
        attrs: vec![],
    }
}

fn render(node: &Node, depth: usize) -> String {
    let pad = "  ".repeat(depth);
    let mut a = String::new();
    for (k, v) in &node.attrs {
        let _ = write!(a, " {k}=\"{}\"", escape_xml(v));
    }
    match &node.content {
        Content::Text(t) => format!("{pad}<{}{a}>{}</{}>", node.name, escape_xml(t), node.name),
        Content::Children(children) => {
            let inner: Vec<String> = children.iter().map(|c| render(c, depth + 1)).collect();
            format!(
                "{pad}<{}{a}>\n{}\n{pad}</{}>",
                node.name,
                inner.join("\n"),
                node.name
            )
        }
    }
}

fn agent(bic: Option<&str>) -> Node {
    let b: String = bic
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if b.is_empty() {
        parent(
            "FinInstnId",
            vec![parent("Othr", vec![text("Id", "NOTPROVIDED")])],
        )
    } else {
        parent("FinInstnId", vec![text("BICFI", b)])
    }
}

fn bic_of(party: &SepaParty) -> Option<&str> {
    party.bic.as_deref().filter(|b| !b.is_empty())
}

fn is_iso_date(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`.
fn is_timestamp_prefix(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() >= 19
        && is_iso_date(&t[..10])
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
}

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

/// The file and the issues that block it.
#[derive(Debug, Clone, PartialEq)]
pub struct SepaBatch {
    pub file: GeneratedFile,
    pub issues: Vec<PayrollIssue>,
}

/// `buildSepaSalaryBatch(input)`.
pub fn build_sepa_salary_batch(input: &SepaSalaryBatchInput) -> SepaBatch {
    let mut issues: Vec<PayrollIssue> = vec![];
    let err = |issues: &mut Vec<PayrollIssue>, code: &str, params: Option<Vec<(&str, Value)>>| {
        let issue = PayrollIssue::error(code);
        issues.push(match params {
            Some(p) => issue.with(&p),
            None => issue,
        });
    };
    let check_party =
        |issues: &mut Vec<PayrollIssue>, p: &SepaParty, role: &str, e2e: Option<&str>| {
            let with_ref = |mut params: Vec<(&'static str, Value)>| {
                if let Some(id) = e2e {
                    params.push(("endToEndId", json!(id)));
                }
                params
            };
            if !is_valid_iban(&p.iban) {
                err(
                    issues,
                    "invalid_iban",
                    Some(with_ref(vec![("role", json!(role))])),
                );
            }
            if let Some(bic) = bic_of(p) {
                let normalised: String = bic
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>()
                    .to_uppercase();
                if !is_bic(&normalised) {
                    err(
                        issues,
                        "invalid_bic",
                        Some(with_ref(vec![("role", json!(role))])),
                    );
                }
            }
            if to_sepa_text(&p.name, 70).is_empty() {
                err(
                    issues,
                    "missing_account_holder",
                    Some(with_ref(vec![("role", json!(role))])),
                );
            }
        };
    check_party(&mut issues, &input.debtor, "debtor", None);
    if !is_iso_date(&input.execution_date) {
        err(
            &mut issues,
            "invalid_execution_date",
            Some(vec![("executionDate", json!(input.execution_date))]),
        );
    }
    if !is_timestamp_prefix(&input.created_at) {
        err(
            &mut issues,
            "invalid_created_at",
            Some(vec![("createdAt", json!(input.created_at))]),
        );
    }
    let mut ids: Vec<String> = vec![];
    let mut salary_tx: Vec<Node> = vec![];
    let mut salary_total = 0.0;
    for s in &input.salaries {
        check_party(&mut issues, &s.creditor, "employee", Some(&s.end_to_end_id));
        let country: String = normalize_iban(&s.creditor.iban).chars().take(2).collect();
        if NON_EEA_SEPA.contains(&country.as_str()) {
            issues.push(PayrollIssue::warning("non_eea_creditor").with(&[
                ("endToEndId", json!(s.end_to_end_id)),
                ("country", json!(country)),
            ]));
        }
        let e2e = to_sepa_id(&s.end_to_end_id, 35);
        let mut usable = true;
        if e2e.is_empty() {
            err(
                &mut issues,
                "invalid_end_to_end_id",
                Some(vec![("endToEndId", json!(s.end_to_end_id))]),
            );
            usable = false;
        } else if ids.contains(&e2e) {
            err(
                &mut issues,
                "duplicate_end_to_end_id",
                Some(vec![("endToEndId", json!(s.end_to_end_id))]),
            );
            usable = false;
        }
        ids.push(e2e.clone());
        if !valid_amount(s.amount_cents) {
            err(
                &mut issues,
                "invalid_amount",
                Some(vec![
                    ("endToEndId", json!(s.end_to_end_id)),
                    ("amountCents", n(s.amount_cents)),
                ]),
            );
            usable = false;
        }
        if !usable {
            continue;
        }
        salary_total += s.amount_cents;
        let mut children = vec![
            parent("PmtId", vec![text("EndToEndId", e2e)]),
            parent(
                "Amt",
                vec![Node {
                    name: "InstdAmt",
                    content: Content::Text(amount(s.amount_cents)),
                    attrs: vec![("Ccy", "EUR".into())],
                }],
            ),
        ];
        if bic_of(&s.creditor).is_some() {
            children.push(parent("CdtrAgt", vec![agent(bic_of(&s.creditor))]));
        }
        children.push(parent(
            "Cdtr",
            vec![text("Nm", to_sepa_text(&s.creditor.name, 70))],
        ));
        children.push(parent(
            "CdtrAcct",
            vec![parent(
                "Id",
                vec![text("IBAN", normalize_iban(&s.creditor.iban))],
            )],
        ));
        children.push(parent(
            "RmtInf",
            vec![text("Ustrd", to_sepa_text(&s.remittance, 140))],
        ));
        salary_tx.push(parent("CdtTrfTxInf", children));
    }
    let msg_id = to_sepa_id(&input.message_id, 35);
    if msg_id.is_empty() {
        err(&mut issues, "invalid_message_id", None);
    }
    let debtor_nodes = || {
        vec![
            parent(
                "ReqdExctnDt",
                vec![text("Dt", input.execution_date.clone())],
            ),
            parent(
                "Dbtr",
                vec![text("Nm", to_sepa_text(&input.debtor.name, 70))],
            ),
            parent(
                "DbtrAcct",
                vec![parent(
                    "Id",
                    vec![text("IBAN", normalize_iban(&input.debtor.iban))],
                )],
            ),
            parent("DbtrAgt", vec![agent(bic_of(&input.debtor))]),
            text("ChrgBr", "SLEV"),
        ]
    };
    let msg_head: String = msg_id.chars().take(31).collect();
    let pmt_inf = |suffix: &str, purpose: &str, txs: Vec<Node>, total: f64, batch: bool| {
        let mut children = vec![
            text("PmtInfId", format!("{msg_head}-{suffix}")),
            text("PmtMtd", "TRF"),
            text("BtchBookg", if batch { "true" } else { "false" }),
            text("NbOfTxs", txs.len().to_string()),
            text("CtrlSum", amount(total)),
            parent(
                "PmtTpInf",
                vec![
                    parent("SvcLvl", vec![text("Cd", "SEPA")]),
                    parent("CtgyPurp", vec![text("Cd", purpose.to_owned())]),
                ],
            ),
        ];
        children.extend(debtor_nodes());
        children.extend(txs);
        parent("PmtInf", children)
    };
    let mut payments = vec![];
    let mut tx_count = salary_tx.len();
    let mut total = salary_total;
    if !salary_tx.is_empty() {
        payments.push(pmt_inf("SAL", "SALA", salary_tx, salary_total, true));
    }
    if let Some(tax) = &input.tax {
        let creditor = tax
            .creditor
            .clone()
            .unwrap_or_else(|| belastingdienst_account(&input.execution_date));
        check_party(&mut issues, &creditor, "tax", None);
        if !is_valid_betalingskenmerk(&kenmerk_of(&tax.betalingskenmerk)) {
            err(
                &mut issues,
                "invalid_betalingskenmerk",
                Some(vec![("betalingskenmerk", json!(tax.betalingskenmerk))]),
            );
        }
        if input.execution_date.as_str() >= "2027-01-01"
            && normalize_iban(&creditor.iban) == BELASTINGDIENST_ING
        {
            err(
                &mut issues,
                "outdated_tax_account",
                Some(vec![("iban", json!(BELASTINGDIENST_ING))]),
            );
        }
        if !valid_amount(tax.amount_cents) {
            err(
                &mut issues,
                "invalid_amount",
                Some(vec![
                    ("endToEndId", json!("tax")),
                    ("amountCents", n(tax.amount_cents)),
                ]),
            );
        }
    }
    if let Some(tax) = input.tax.as_ref().filter(|t| valid_amount(t.amount_cents)) {
        let creditor = tax
            .creditor
            .clone()
            .unwrap_or_else(|| belastingdienst_account(&input.execution_date));
        let kenmerk = kenmerk_of(&tax.betalingskenmerk);
        let msg26: String = msg_id.chars().take(26).collect();
        let tail: String = {
            let units: Vec<char> = kenmerk.chars().collect();
            units[units.len().saturating_sub(6)..].iter().collect()
        };
        let mut children = vec![
            parent(
                "PmtId",
                vec![text(
                    "EndToEndId",
                    to_sepa_id(&format!("{msg26}-LH{tail}"), 35),
                )],
            ),
            parent(
                "Amt",
                vec![Node {
                    name: "InstdAmt",
                    content: Content::Text(amount(tax.amount_cents)),
                    attrs: vec![("Ccy", "EUR".into())],
                }],
            ),
        ];
        if bic_of(&creditor).is_some() {
            children.push(parent("CdtrAgt", vec![agent(bic_of(&creditor))]));
        }
        children.push(parent(
            "Cdtr",
            vec![text("Nm", to_sepa_text(&creditor.name, 70))],
        ));
        children.push(parent(
            "CdtrAcct",
            vec![parent(
                "Id",
                vec![text("IBAN", normalize_iban(&creditor.iban))],
            )],
        ));
        children.push(parent(
            "RmtInf",
            vec![parent(
                "Strd",
                vec![parent(
                    "CdtrRefInf",
                    vec![
                        parent(
                            "Tp",
                            vec![
                                parent("CdOrPrtry", vec![text("Cd", "SCOR")]),
                                text("Issr", "CUR"),
                            ],
                        ),
                        text("Ref", kenmerk),
                    ],
                )],
            )],
        ));
        payments.push(pmt_inf(
            "TAX",
            "TAXS",
            vec![parent("CdtTrfTxInf", children)],
            tax.amount_cents,
            false,
        ));
        tx_count += 1;
        total += tax.amount_cents;
    }
    if payments.is_empty() {
        err(&mut issues, "empty_batch", None);
    }
    let mut initiation = vec![parent(
        "GrpHdr",
        vec![
            text("MsgId", msg_id.clone()),
            text(
                "CreDtTm",
                input.created_at.chars().take(19).collect::<String>(),
            ),
            text("NbOfTxs", tx_count.to_string()),
            text("CtrlSum", amount(total)),
            parent(
                "InitgPty",
                vec![text("Nm", to_sepa_text(&input.debtor.name, 70))],
            ),
        ],
    )];
    initiation.extend(payments);
    let doc = Node {
        name: "Document",
        content: Content::Children(vec![parent("CstmrCdtTrfInitn", initiation)]),
        attrs: vec![("xmlns", PAIN_001_NAMESPACE.into())],
    };
    SepaBatch {
        file: GeneratedFile {
            file_name: format!("salarissen-{}-{msg_id}.xml", input.execution_date),
            content_type: "application/xml".into(),
            content: format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{}\n",
                render(&doc, 0)
            ),
        },
        issues,
    }
}

/// `betalingskenmerk.replace(/[\s.]/g, '')`.
fn kenmerk_of(reference: &str) -> String {
    reference
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '.' && *c != '\u{feff}')
        .collect()
}
