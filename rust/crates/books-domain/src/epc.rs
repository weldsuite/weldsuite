//! The EPC069-12 QR code ("`GiroCode`", SEPA Credit Transfer) of an invoice:
//! the text a banking app reads to fill in a transfer of the open balance.
//!
//! Twelve lines, `\n` apart: `BCD`, version `002`, character set `1` (UTF-8),
//! `SCT`, the BIC (optional in version 002, left empty when unknown), the
//! beneficiary's name (70 characters at most), the IBAN, `EUR` and the amount
//! (999999999.99 at most), the purpose (empty), the structured remittance
//! (empty) and the unstructured remittance (140 characters at most). The
//! whole payload is at most 331 bytes. Euro only: the scheme has no other
//! currency. The last line (information for the payer) is left out, as the
//! specification allows.

use crate::identifiers::{is_valid_iban, normalize_iban};
use crate::sepa::sepa_text;

/// The largest payload the specification allows, in bytes.
pub const MAX_BYTES: usize = 331;
const MAX_NAME: usize = 70;
const MAX_REMITTANCE: usize = 140;
/// 999999999.99 in cents.
const MAX_CENTS: i64 = 99_999_999_999;

/// What the code pays.
#[derive(Debug, Clone)]
pub struct EpcTransfer<'a> {
    /// The beneficiary: the selling entity.
    pub name: &'a str,
    pub iban: &'a str,
    pub bic: Option<&'a str>,
    /// The open balance, in cents.
    pub amount_cents: i64,
    /// Unstructured remittance: the invoice number.
    pub remittance: &'a str,
}

/// A BIC is 8 or 11 letters and digits; anything else is left out (version
/// 002 does not need it).
fn bic_of(raw: Option<&str>) -> String {
    let bic: String = raw
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if matches!(bic.len(), 8 | 11) && bic.chars().all(|c| c.is_ascii_alphanumeric()) {
        bic
    } else {
        String::new()
    }
}

/// `EUR` and the amount: `EUR121.00`.
fn amount_text(cents: i64) -> String {
    format!("EUR{}.{:02}", cents / 100, cents % 100)
}

/// The payload, or `None` when there is nothing valid to pay: no name, an IBAN
/// that is not one, an amount of zero or less, or one above the scheme's
/// limit.
pub fn payload(transfer: &EpcTransfer<'_>) -> Option<String> {
    if !(1..=MAX_CENTS).contains(&transfer.amount_cents) || !is_valid_iban(transfer.iban) {
        return None;
    }
    let mut name = sepa_text(transfer.name, MAX_NAME);
    if name.is_empty() {
        return None;
    }
    let mut remittance = sepa_text(transfer.remittance, MAX_REMITTANCE);
    let iban = normalize_iban(transfer.iban);
    let bic = bic_of(transfer.bic);
    let amount = amount_text(transfer.amount_cents);
    let build = |name: &str, remittance: &str| {
        format!("BCD\n002\n1\nSCT\n{bic}\n{name}\n{iban}\n{amount}\n\n\n{remittance}")
    };
    // `sepa_text` yields ASCII, so the limits above already keep it under 331
    // bytes; this holds the bound whatever the fields become.
    while build(&name, &remittance).len() > MAX_BYTES && !remittance.is_empty() {
        remittance.pop();
    }
    while build(&name, &remittance).len() > MAX_BYTES && name.len() > 1 {
        name.pop();
    }
    let payload = build(&name, &remittance);
    (payload.len() <= MAX_BYTES).then_some(payload)
}

/// The QR code of `payload` as rows of dark modules, error correction level M
/// (the EPC's recommendation), no quiet zone; empty when it does not fit.
pub fn matrix(payload: &str) -> Vec<Vec<bool>> {
    use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
    let segments = QrSegment::make_segments(payload);
    let Ok(qr) = QrCode::encode_segments_advanced(
        &segments,
        QrCodeEcc::Medium,
        Version::MIN,
        Version::MAX,
        None,
        false,
    ) else {
        return Vec::new();
    };
    let size = qr.size();
    (0..size)
        .map(|y| (0..size).map(|x| qr.get_module(x, y)).collect())
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    const IBAN: &str = "NL91 ABNA 0417 1643 00";

    fn transfer<'a>(name: &'a str, remittance: &'a str, cents: i64) -> EpcTransfer<'a> {
        EpcTransfer {
            name,
            iban: IBAN,
            bic: None,
            amount_cents: cents,
            remittance,
        }
    }

    #[test]
    fn the_payload_follows_the_specification() {
        let text = payload(&transfer("Acme B.V.", "F-2026-001", 12100)).unwrap();
        assert_eq!(
            text,
            "BCD\n002\n1\nSCT\n\nAcme B.V.\nNL91ABNA0417164300\nEUR121.00\n\n\nF-2026-001"
        );
        assert_eq!(text.split('\n').count(), 11);
    }

    #[test]
    fn a_bic_is_written_when_it_is_one() {
        let mut t = transfer("Acme", "F-1", 5);
        t.bic = Some(" abnanl2a ");
        assert!(payload(&t).unwrap().contains("\nSCT\nABNANL2A\nAcme\n"));
        assert!(payload(&t).unwrap().contains("\nEUR0.05\n"));
        t.bic = Some("not a bic");
        assert!(payload(&t).unwrap().contains("\nSCT\n\nAcme\n"));
    }

    #[test]
    fn the_name_and_the_remittance_are_cut() {
        let name = "N".repeat(100);
        let remittance = "R".repeat(300);
        let text = payload(&transfer(&name, &remittance, 100)).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[5].len(), 70);
        assert_eq!(lines[10].len(), 140);
        assert!(text.len() <= MAX_BYTES);
    }

    #[test]
    fn amounts_are_formatted_and_bounded() {
        assert_eq!(amount_text(1), "EUR0.01");
        assert_eq!(amount_text(123_456), "EUR1234.56");
        assert_eq!(amount_text(MAX_CENTS), "EUR999999999.99");
        assert!(payload(&transfer("A", "B", MAX_CENTS)).is_some());
        assert!(payload(&transfer("A", "B", MAX_CENTS + 1)).is_none());
        assert!(payload(&transfer("A", "B", 0)).is_none());
        assert!(payload(&transfer("A", "B", -5)).is_none());
    }

    #[test]
    fn nothing_without_a_name_or_a_valid_iban() {
        assert!(payload(&transfer("  ", "B", 100)).is_none());
        let mut t = transfer("A", "B", 100);
        t.iban = "NL00 NOPE";
        assert!(payload(&t).is_none());
    }

    #[test]
    fn the_matrix_is_a_square_qr_code() {
        let text = payload(&transfer("Acme B.V.", "F-2026-001", 12100)).unwrap();
        let m = matrix(&text);
        assert!(m.len() >= 21);
        assert!(m.iter().all(|row| row.len() == m.len()));
        // The finder pattern's corners are dark.
        assert!(m[0][0] && m[0][6] && m[6][0]);
    }
}
