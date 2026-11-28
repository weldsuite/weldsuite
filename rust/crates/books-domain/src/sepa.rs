//! SEPA credit-transfer files for paying supplier bills (Rust only, edition
//! feature `books-sepa-batches`).
//!
//! The file is **pain.001.001.03** (`CustomerCreditTransferInitiationV03`):
//! the version every Dutch and Belgian bank takes in its bulk-payment upload
//! (ING, Rabobank, ABN AMRO, KBC, Belfius, bunq and the Dutch accounting
//! packages all export it). pain.001.001.09 is newer and is not yet accepted
//! everywhere, and nothing here needs what it adds (structured addresses,
//! LEI), so the batch stays on .03 until a bank refuses it.
//!
//! One `PmtInf` holds the debtor and the execution date and one
//! `CdtTrfInfo` each bill. `BtchBookg` is `false`: the bank books every
//! transfer as its own debit, so each bank line carries one bill's amount
//! and the matcher can link it to its bill one to one.
//!
//! Text follows the EPC's restricted Latin character set: accents are
//! stripped, anything else outside `a-z A-Z 0-9 / - ? : ( ) . , ' + space`
//! becomes a space, and fields are cut at the schema's lengths (names 70,
//! remittance 140, ids 35). Amounts are written from whole cents, so the
//! control sum is exact.

use std::fmt::Write as _;

use unicode_normalization::UnicodeNormalization;

/// The schema this module writes.
pub const PAIN_001_NAMESPACE: &str = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03";

/// What can stop a file from being made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SepaError {
    /// A batch without a transfer.
    Empty,
    /// An amount that is not a positive sum of at most two decimals.
    Amount(String),
    /// An IBAN that is not valid (checksum or country length).
    Iban(String),
    /// A currency other than EUR.
    Currency(String),
    /// An execution date that is not `yyyy-mm-dd`.
    Date(String),
}

impl std::fmt::Display for SepaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("A SEPA batch needs at least one transfer."),
            Self::Amount(amount) => write!(f, "{amount} is not an amount a transfer can have."),
            Self::Iban(iban) => write!(f, "{iban} is not a valid IBAN."),
            Self::Currency(currency) => {
                write!(f, "SEPA transfers are in EUR; {currency} is not allowed.")
            }
            Self::Date(date) => write!(f, "{date} is not a date (yyyy-mm-dd)."),
        }
    }
}

impl std::error::Error for SepaError {}

/// The account the money leaves.
#[derive(Debug, Clone)]
pub struct Debtor {
    pub name: String,
    pub iban: String,
    pub bic: Option<String>,
}

/// One transfer: a supplier's bill.
#[derive(Debug, Clone)]
pub struct Transfer {
    /// Reaches the bank line as the end-to-end id (the bill's number).
    pub end_to_end_id: String,
    /// Decimal text, at most two decimals (`"1210.50"`).
    pub amount: String,
    pub currency: String,
    pub creditor_name: String,
    pub creditor_iban: String,
    pub creditor_bic: Option<String>,
    /// Unstructured remittance information: the supplier's invoice number.
    pub remittance: String,
}

/// A whole file.
#[derive(Debug, Clone)]
pub struct CreditTransferFile {
    /// Message and payment-information id (the batch's id).
    pub message_id: String,
    /// `yyyy-mm-ddThh:mm:ss`.
    pub created_at: String,
    /// `yyyy-mm-dd`: the day the bank should execute the transfers.
    pub execution_date: String,
    pub debtor: Debtor,
    pub transfers: Vec<Transfer>,
}

/// `value` as EPC text, cut at `max` characters.
pub fn sepa_text(value: &str, max: usize) -> String {
    let mut out = String::with_capacity(value.len().min(max));
    for c in value.nfd().filter(|c| !is_combining(*c)) {
        let c = match c {
            'ß' => {
                out.push('s');
                's'
            }
            'æ' | 'Æ' => 'a',
            'ø' | 'Ø' => 'o',
            'đ' | 'Đ' => 'd',
            'ł' | 'Ł' => 'l',
            other => other,
        };
        let allowed = c.is_ascii_alphanumeric()
            || matches!(
                c,
                '/' | '-' | '?' | ':' | '(' | ')' | '.' | ',' | '\'' | '+' | ' '
            );
        // Control characters and tabs are not text; other symbols are a gap.
        out.push(if allowed { c } else { ' ' });
        if out.chars().count() >= max {
            break;
        }
    }
    let trimmed = out.trim();
    trimmed.chars().take(max).collect()
}

fn is_combining(c: char) -> bool {
    ('\u{0300}'..='\u{036f}').contains(&c)
}

/// An identifier (`MsgId`, `EndToEndId`): the same character set without
/// spaces, at most 35 characters, never empty.
pub fn sepa_id(value: &str, fallback: &str) -> String {
    let id: String = sepa_text(value, 35)
        .chars()
        .map(|c| if c == ' ' { '-' } else { c })
        .collect();
    if id.is_empty() {
        sepa_text(fallback, 35).replace(' ', "-")
    } else {
        id
    }
}

/// `amount` in whole cents; `None` unless it is a positive decimal with at
/// most two decimals.
pub fn to_cents(amount: &str) -> Option<i64> {
    let amount = amount.trim();
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
    // `12.500` is as good as `12.50`; `12.505` is not an amount.
    let fraction = fraction.trim_end_matches('0');
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty())
        || fraction.len() > 2
        || !digits(whole)
        || !digits(fraction)
    {
        return None;
    }
    let whole: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let fraction_cents: i64 = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<i64>().ok()? * 10,
        _ => fraction.parse().ok()?,
    };
    let cents = whole.checked_mul(100)?.checked_add(fraction_cents)?;
    (cents > 0).then_some(cents)
}

/// Whole cents as the `12.34` the schema wants.
pub fn from_cents(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
        && (1..=12).contains(&date[5..7].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&date[8..10].parse::<u32>().unwrap_or(0))
}

fn bic_of(value: Option<&str>) -> Option<String> {
    let bic: String = value?
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let b = bic.as_bytes();
    ((b.len() == 8 || b.len() == 11)
        && b[..6].iter().all(u8::is_ascii_alphabetic)
        && b[6..].iter().all(u8::is_ascii_alphanumeric))
    .then_some(bic)
}

/// What the file's header and the batch's total say: `(count, cents)`.
pub fn control_totals(transfers: &[Transfer]) -> Result<(usize, i64), SepaError> {
    let mut sum: i64 = 0;
    for transfer in transfers {
        let cents =
            to_cents(&transfer.amount).ok_or_else(|| SepaError::Amount(transfer.amount.clone()))?;
        sum = sum
            .checked_add(cents)
            .ok_or_else(|| SepaError::Amount(transfer.amount.clone()))?;
    }
    Ok((transfers.len(), sum))
}

/// The group header: the message, its size and the initiating party.
fn group_header(
    xml: &mut String,
    id: &str,
    created: &str,
    count: usize,
    control: &str,
    name: &str,
) {
    let _ = write!(
        xml,
        "    <GrpHdr>\n      <MsgId>{}</MsgId>\n      <CreDtTm>{}</CreDtTm>\n      <NbOfTxs>{count}</NbOfTxs>\n      <CtrlSum>{control}</CtrlSum>\n      <InitgPty><Nm>{}</Nm></InitgPty>\n    </GrpHdr>\n",
        escape(id),
        escape(created),
        escape(name),
    );
}

/// The payment information up to the first transfer: the debtor, its
/// account and bank, the execution date.
fn payment_info_start(
    xml: &mut String,
    file: &CreditTransferFile,
    id: &str,
    count: usize,
    control: &str,
    name: &str,
) {
    let _ = write!(
        xml,
        "    <PmtInf>\n      <PmtInfId>{}</PmtInfId>\n      <PmtMtd>TRF</PmtMtd>\n      <BtchBookg>false</BtchBookg>\n      <NbOfTxs>{count}</NbOfTxs>\n      <CtrlSum>{control}</CtrlSum>\n      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>\n      <ReqdExctnDt>{}</ReqdExctnDt>\n      <Dbtr><Nm>{}</Nm></Dbtr>\n      <DbtrAcct><Id><IBAN>{}</IBAN></Id></DbtrAcct>\n",
        escape(id),
        file.execution_date,
        escape(name),
        crate::identifiers::normalize_iban(&file.debtor.iban),
    );
    match bic_of(file.debtor.bic.as_deref()) {
        Some(bic) => {
            let _ = writeln!(
                xml,
                "      <DbtrAgt><FinInstnId><BIC>{bic}</BIC></FinInstnId></DbtrAgt>"
            );
        }
        None => xml.push_str(
            "      <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>\n",
        ),
    }
    xml.push_str("      <ChrgBr>SLEV</ChrgBr>\n");
}

/// One credit transfer: the bill's number as end-to-end id, the amount, the
/// supplier and its account, the invoice number as remittance.
fn transfer(xml: &mut String, transfer: &Transfer) -> Result<(), SepaError> {
    let cents =
        to_cents(&transfer.amount).ok_or_else(|| SepaError::Amount(transfer.amount.clone()))?;
    let _ = write!(
        xml,
        "      <CdtTrfTxInf>\n        <PmtId><EndToEndId>{}</EndToEndId></PmtId>\n        <Amt><InstdAmt Ccy=\"EUR\">{}</InstdAmt></Amt>\n",
        escape(&sepa_id(&transfer.end_to_end_id, "NOTPROVIDED")),
        from_cents(cents),
    );
    if let Some(bic) = bic_of(transfer.creditor_bic.as_deref()) {
        let _ = writeln!(
            xml,
            "        <CdtrAgt><FinInstnId><BIC>{bic}</BIC></FinInstnId></CdtrAgt>"
        );
    }
    let _ = write!(
        xml,
        "        <Cdtr><Nm>{}</Nm></Cdtr>\n        <CdtrAcct><Id><IBAN>{}</IBAN></Id></CdtrAcct>\n",
        escape(&sepa_text(&transfer.creditor_name, 70)),
        crate::identifiers::normalize_iban(&transfer.creditor_iban),
    );
    let remittance = sepa_text(&transfer.remittance, 140);
    if !remittance.is_empty() {
        let _ = writeln!(
            xml,
            "        <RmtInf><Ustrd>{}</Ustrd></RmtInf>",
            escape(&remittance)
        );
    }
    xml.push_str("      </CdtTrfTxInf>\n");
    Ok(())
}

/// The pain.001.001.03 document.
pub fn credit_transfer_xml(file: &CreditTransferFile) -> Result<String, SepaError> {
    if file.transfers.is_empty() {
        return Err(SepaError::Empty);
    }
    if !valid_date(&file.execution_date) {
        return Err(SepaError::Date(file.execution_date.clone()));
    }
    if !crate::identifiers::is_valid_iban(&file.debtor.iban) {
        return Err(SepaError::Iban(file.debtor.iban.clone()));
    }
    for each in &file.transfers {
        if each.currency != "EUR" {
            return Err(SepaError::Currency(each.currency.clone()));
        }
        if !crate::identifiers::is_valid_iban(&each.creditor_iban) {
            return Err(SepaError::Iban(each.creditor_iban.clone()));
        }
    }
    let (count, sum) = control_totals(&file.transfers)?;
    let control = from_cents(sum);
    let message_id = sepa_id(&file.message_id, "WELDSUITE");
    let debtor_name = sepa_text(&file.debtor.name, 70);
    let created: String = file.created_at.chars().take(19).collect();

    let mut xml = String::with_capacity(1024 + count * 640);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let _ = write!(
        xml,
        "<Document xmlns=\"{PAIN_001_NAMESPACE}\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n  <CstmrCdtTrfInitn>\n"
    );
    group_header(
        &mut xml,
        &message_id,
        &created,
        count,
        &control,
        &debtor_name,
    );
    payment_info_start(&mut xml, file, &message_id, count, &control, &debtor_name);
    for each in &file.transfers {
        transfer(&mut xml, each)?;
    }
    xml.push_str("    </PmtInf>\n  </CstmrCdtTrfInitn>\n</Document>\n");
    Ok(xml)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn file() -> CreditTransferFile {
        CreditTransferFile {
            message_id: "pru_abc123".to_owned(),
            created_at: "2026-11-27T21:05:09.123Z".to_owned(),
            execution_date: "2026-12-01".to_owned(),
            debtor: Debtor {
                name: "Müller & Zonen B.V.".to_owned(),
                iban: "NL91 ABNA 0417 1643 00".to_owned(),
                bic: Some("abnanl2a".to_owned()),
            },
            transfers: vec![
                Transfer {
                    end_to_end_id: "BILL-2026-0001".to_owned(),
                    amount: "1210.50".to_owned(),
                    currency: "EUR".to_owned(),
                    creditor_name: "Café Zoë <Amsterdam>".to_owned(),
                    creditor_iban: "NL02 ABNA 0123 4567 89".to_owned(),
                    creditor_bic: None,
                    remittance: "Factuur 2026/118".to_owned(),
                },
                Transfer {
                    end_to_end_id: "BILL-2026-0002".to_owned(),
                    amount: "0.07".to_owned(),
                    currency: "EUR".to_owned(),
                    creditor_name: "Lieferant GmbH".to_owned(),
                    creditor_iban: "DE89370400440532013000".to_owned(),
                    creditor_bic: Some("COBADEFFXXX".to_owned()),
                    remittance: String::new(),
                },
            ],
        }
    }

    #[test]
    fn amounts_are_whole_cents() {
        assert_eq!(to_cents("1210.50"), Some(121_050));
        assert_eq!(to_cents("12"), Some(1200));
        assert_eq!(to_cents("12.5"), Some(1250));
        assert_eq!(to_cents("12.500"), Some(1250));
        assert_eq!(to_cents("0.07"), Some(7));
        assert_eq!(to_cents("12.505"), None);
        assert_eq!(to_cents("0"), None);
        assert_eq!(to_cents("-5.00"), None);
        assert_eq!(to_cents("abc"), None);
        assert_eq!(to_cents(""), None);
        assert_eq!(from_cents(7), "0.07");
        assert_eq!(from_cents(121_050), "1210.50");
    }

    #[test]
    fn text_is_the_epc_character_set() {
        assert_eq!(sepa_text("Café Zoë & Zonen", 70), "Cafe Zoe   Zonen");
        assert_eq!(sepa_text("  Straße 5 ", 70), "Strasse 5");
        assert_eq!(sepa_text("abcdef", 3), "abc");
        assert_eq!(sepa_id("Bill 2026/1", "x"), "Bill-2026/1");
        assert_eq!(sepa_id("", "fallback"), "fallback");
        assert_eq!(sepa_id(&"x".repeat(80), "f").len(), 35);
    }

    #[test]
    fn the_file_has_the_pain_001_structure() {
        let xml = credit_transfer_xml(&file()).unwrap();
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("xmlns=\"urn:iso:std:iso:20022:tech:xsd:pain.001.001.03\""));
        for tag in [
            "CstmrCdtTrfInitn",
            "GrpHdr",
            "MsgId",
            "CreDtTm",
            "InitgPty",
            "PmtInf",
            "PmtInfId",
            "PmtMtd",
            "ReqdExctnDt",
            "Dbtr",
            "DbtrAcct",
            "DbtrAgt",
            "ChrgBr",
        ] {
            assert!(xml.contains(&format!("<{tag}>")), "missing <{tag}>");
            assert!(xml.contains(&format!("</{tag}>")), "missing </{tag}>");
        }
        assert!(xml.contains("<PmtMtd>TRF</PmtMtd>"));
        assert!(xml.contains("<Cd>SEPA</Cd>"));
        assert!(xml.contains("<CreDtTm>2026-11-27T21:05:09</CreDtTm>"));
        assert!(xml.contains("<ReqdExctnDt>2026-12-01</ReqdExctnDt>"));
        assert!(xml.contains("<IBAN>NL91ABNA0417164300</IBAN>"));
        assert!(xml.contains("<BIC>ABNANL2A</BIC>"));
        // The names and the remittance in the EPC character set.
        assert!(xml.contains("<Nm>Muller   Zonen B.V.</Nm>"));
        assert!(xml.contains("<Nm>Cafe Zoe  Amsterdam</Nm>"));
        assert!(xml.contains("<Ustrd>Factuur 2026/118</Ustrd>"));
        // Nothing to say about the second bill: no empty remittance element.
        assert_eq!(xml.matches("<Ustrd>").count(), 1);
        assert_eq!(xml.matches("<CdtTrfTxInf>").count(), 2);
        assert_eq!(xml.matches("</CdtTrfTxInf>").count(), 2);
        // The creditor's bank is written only when it is known.
        assert_eq!(xml.matches("<CdtrAgt>").count(), 1);
        assert!(xml.contains("<BIC>COBADEFFXXX</BIC>"));
    }

    #[test]
    fn the_control_sum_and_count_add_up() {
        let xml = credit_transfer_xml(&file()).unwrap();
        // 1210.50 + 0.07, in the group header and in the payment information.
        assert_eq!(xml.matches("<CtrlSum>1210.57</CtrlSum>").count(), 2);
        assert_eq!(xml.matches("<NbOfTxs>2</NbOfTxs>").count(), 2);
        assert!(xml.contains("<InstdAmt Ccy=\"EUR\">1210.50</InstdAmt>"));
        assert!(xml.contains("<InstdAmt Ccy=\"EUR\">0.07</InstdAmt>"));
        assert_eq!(control_totals(&file().transfers), Ok((2, 121_057)));
        assert!(xml.contains("<BtchBookg>false</BtchBookg>"));
    }

    #[test]
    fn the_end_to_end_ids_are_the_bill_numbers() {
        let xml = credit_transfer_xml(&file()).unwrap();
        assert!(xml.contains("<EndToEndId>BILL-2026-0001</EndToEndId>"));
        assert!(xml.contains("<EndToEndId>BILL-2026-0002</EndToEndId>"));
    }

    #[test]
    fn a_debtor_without_a_bic_is_not_provided() {
        let mut f = file();
        f.debtor.bic = None;
        let xml = credit_transfer_xml(&f).unwrap();
        assert!(xml.contains("<Othr><Id>NOTPROVIDED</Id></Othr>"));
        assert!(!xml.contains("<DbtrAgt><FinInstnId><BIC>"));
    }

    #[test]
    fn what_cannot_be_paid_is_refused() {
        let mut empty = file();
        empty.transfers.clear();
        assert_eq!(credit_transfer_xml(&empty), Err(SepaError::Empty));
        let mut dollars = file();
        dollars.transfers[0].currency = "USD".to_owned();
        assert_eq!(
            credit_transfer_xml(&dollars),
            Err(SepaError::Currency("USD".to_owned()))
        );
        let mut iban = file();
        iban.transfers[1].creditor_iban = "NL00ABNA0123456789".to_owned();
        assert!(matches!(
            credit_transfer_xml(&iban),
            Err(SepaError::Iban(_))
        ));
        let mut debtor = file();
        debtor.debtor.iban = "nonsense".to_owned();
        assert!(matches!(
            credit_transfer_xml(&debtor),
            Err(SepaError::Iban(_))
        ));
        let mut amount = file();
        amount.transfers[0].amount = "10.123".to_owned();
        assert!(matches!(
            credit_transfer_xml(&amount),
            Err(SepaError::Amount(_))
        ));
        let mut date = file();
        date.execution_date = "01-12-2026".to_owned();
        assert!(matches!(
            credit_transfer_xml(&date),
            Err(SepaError::Date(_))
        ));
    }
}
