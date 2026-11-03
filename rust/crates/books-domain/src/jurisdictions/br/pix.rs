//! Pix static BR Code (`jurisdictions/br/pix.ts`): the EMV Merchant-Presented
//! QR payload (ID + 2-digit length + value fields, closed by a CRC16/CCITT-FALSE
//! checksum) and its QR code, as `uqr` draws it (Nayuki's QR Code generator,
//! error correction M, no ECC boost, automatic mask, a 2-module quiet zone).

use std::fmt::Write;

use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
use unicode_normalization::UnicodeNormalization;

/// Why a payload can't be built (TypeScript throws).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixError(pub String);

/// UTF-16 length, as JavaScript's `.length`.
fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `field(id, value)`.
fn field(id: &str, value: &str) -> Result<String, PixError> {
    let length = js_len(value);
    if length > 99 {
        return Err(PixError(format!(
            "Pix field {id} is longer than 99 characters"
        )));
    }
    Ok(format!("{id}{length:02}{value}"))
}

/// `value.slice(0, max)` of an ASCII string (a negative end counts from the end).
fn js_slice_to(value: &str, max: i64) -> String {
    let length = i64::try_from(value.len()).unwrap_or(i64::MAX);
    let end = if max < 0 {
        (length + max).max(0)
    } else {
        max.min(length)
    };
    value
        .chars()
        .take(usize::try_from(end).unwrap_or(0))
        .collect()
}

/// `plain(value, max)`: upper and lower case ASCII without accents, in the
/// EMV basic character set, trimmed and cut to `max`.
fn plain(value: &str, max: i64) -> String {
    let kept: String = value
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | ',' | '-' | '/'))
        .collect();
    js_slice_to(kept.trim_matches(' '), max)
}

/// `crc16Ccitt(payload)`: polynomial 0x1021, initial 0xFFFF, no reflection,
/// no final XOR, over the UTF-16 units; four upper-case hex digits.
pub fn crc16_ccitt(payload: &str) -> String {
    let mut crc: u32 = 0xffff;
    for unit in payload.encode_utf16() {
        crc ^= u32::from(unit) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                ((crc << 1) ^ 0x1021) & 0xffff
            } else {
                (crc << 1) & 0xffff
            };
        }
    }
    format!("{crc:04X}")
}

/// `PixPayloadInput`.
#[derive(Debug, Clone, Default)]
pub struct PixPayloadInput {
    /// Pix key: CNPJ/CPF digits, e-mail, +55 phone, or random key (EVP).
    pub key: String,
    /// Receiver name, up to 25 characters.
    pub merchant_name: String,
    /// Receiver city, up to 15 characters.
    pub merchant_city: String,
    /// Amount in BRL; `None` for an open amount.
    pub amount: Option<f64>,
    /// Reference shown to the payer: up to 25 letters and digits, else `***`.
    pub txid: Option<String>,
    /// Free text for the payer.
    pub description: Option<String>,
}

/// `buildPixPayload(input)`.
pub fn build_pix_payload(input: &PixPayloadInput) -> Result<String, PixError> {
    let key = weldsuite_kit::validation::js_trim(&input.key);
    if key.is_empty() {
        return Err(PixError("A Pix key is required".to_owned()));
    }
    let mut account = field("00", "br.gov.bcb.pix")? + &field("01", key)?;
    let description = input
        .description
        .as_deref()
        .filter(|d| !d.is_empty())
        .map_or_else(String::new, |d| {
            plain(d, 72 - i64::try_from(js_len(key)).unwrap_or(0))
        });
    if !description.is_empty() {
        account += &field("02", &description)?;
    }
    let txid: String = input
        .txid
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(25)
        .collect();
    let txid = if txid.is_empty() {
        "***".to_owned()
    } else {
        txid
    };
    let amount = match input.amount {
        Some(amount) if amount > 0.0 => field("54", &crate::js::to_fixed(amount, 2))?,
        _ => String::new(),
    };
    let name = plain(&input.merchant_name, 25);
    let city = plain(&input.merchant_city, 15);
    let mut payload = field("00", "01")?
        + &field("26", &account)?
        + &field("52", "0000")?
        + &field("53", "986")?
        + &amount
        + &field("58", "BR")?
        + &field("59", if name.is_empty() { "N/A" } else { &name })?
        + &field("60", if city.is_empty() { "BRASIL" } else { &city })?
        + &field("62", &field("05", &txid)?)?;
    payload.push_str("6304");
    let crc = crc16_ccitt(&payload);
    Ok(payload + &crc)
}

/// `pixQrMatrix(payload)`: the QR modules (true = dark), a 2-module quiet
/// zone included; error correction M as the BACEN manual recommends.
pub fn pix_qr_matrix(payload: &str) -> Vec<Vec<bool>> {
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
    let border = 2;
    let size = qr.size();
    (-border..size + border)
        .map(|y| {
            (-border..size + border)
                .map(|x| qr.get_module(x, y))
                .collect()
        })
        .collect()
}

/// `pixQrSvg(payload, size)`: the QR code as a self-contained SVG (one path).
pub fn pix_qr_svg(payload: &str, size: u32) -> String {
    let matrix = pix_qr_matrix(payload);
    let n = matrix.len();
    let mut path = String::new();
    for (y, row) in matrix.iter().enumerate() {
        for (x, dark) in row.iter().enumerate() {
            if *dark {
                let _ = write!(path, "M{x} {y}h1v1h-1z");
            }
        }
    }
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {n} {n}\" width=\"{size}\" height=\"{size}\" shape-rendering=\"crispEdges\"><rect width=\"{n}\" height=\"{n}\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs of `buildPixPayload` and `pixQrMatrix` (uqr) in Node
    /// (`tests/fixtures/pix.jsonl`).
    #[test]
    fn payloads_and_matrices_match_typescript() {
        let fixtures = include_str!("../../../tests/fixtures/pix.jsonl");
        let mut seen = 0;
        for line in fixtures.lines().filter(|l| !l.trim().is_empty()) {
            let case: serde_json::Value = serde_json::from_str(line).expect("fixture");
            let input = &case["input"];
            let text = |key: &str| input[key].as_str().map(str::to_owned);
            let built = build_pix_payload(&PixPayloadInput {
                key: text("key").unwrap_or_default(),
                merchant_name: text("merchantName").unwrap_or_default(),
                merchant_city: text("merchantCity").unwrap_or_default(),
                amount: input["amount"].as_f64(),
                txid: text("txid"),
                description: text("description"),
            })
            .expect("payload");
            assert_eq!(built, case["payload"].as_str().expect("payload"));
            let rows: Vec<String> = pix_qr_matrix(&built)
                .iter()
                .map(|row| row.iter().map(|d| if *d { '1' } else { '0' }).collect())
                .collect();
            let expected: Vec<String> = case["rows"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|r| r.as_str().expect("row").to_owned())
                .collect();
            assert_eq!(rows, expected, "{built}");
            assert_eq!(
                u64::try_from(pix_qr_svg(&built, 140).len()).expect("length"),
                case["svgLength"].as_u64().expect("svg length")
            );
            seen += 1;
        }
        assert!(seen >= 4);
    }

    #[test]
    fn checksum_and_refusals() {
        assert_eq!(crc16_ccitt("123456789"), "29B1");
        assert!(
            build_pix_payload(&PixPayloadInput {
                key: "  ".to_owned(),
                ..PixPayloadInput::default()
            })
            .is_err()
        );
    }
}
