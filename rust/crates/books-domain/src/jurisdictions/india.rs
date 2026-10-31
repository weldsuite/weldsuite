//! India (`jurisdictions/in`): GSTIN and PAN checks, GST state codes.

use super::{DATA, TaxIdValidation, strip};

const GSTIN_ALPHABET: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// `normalizeGstin`: without whitespace and hyphens, upper case.
pub fn normalize_gstin(value: &str) -> String {
    strip(value, &['-']).to_uppercase()
}

/// `/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/`.
fn is_gstin_shape(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 15
        && b[0..2].iter().all(u8::is_ascii_digit)
        && b[2..7].iter().all(u8::is_ascii_uppercase)
        && b[7..11].iter().all(u8::is_ascii_digit)
        && b[11].is_ascii_uppercase()
        && (b[12].is_ascii_uppercase() || (b'1'..=b'9').contains(&b[12]))
        && b[13] == b'Z'
        && (b[14].is_ascii_uppercase() || b[14].is_ascii_digit())
}

/// `/^[A-Z]{5}\d{4}[A-Z]$/`.
fn is_pan_shape(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[0..5].iter().all(u8::is_ascii_uppercase)
        && b[5..9].iter().all(u8::is_ascii_digit)
        && b[9].is_ascii_uppercase()
}

/// `isValidGstStateCode(code)`.
pub fn is_valid_gst_state_code(code: &str) -> bool {
    DATA["in"]["gstStateCodes"]
        .as_array()
        .is_some_and(|codes| codes.iter().any(|c| c.as_str() == Some(code)))
}

/// `extractStateCodeFromGstin(gstin)`: its first two digits.
pub fn extract_state_code_from_gstin(gstin: &str) -> Option<String> {
    let normalized = normalize_gstin(gstin);
    let head: String = normalized.chars().take(2).collect();
    (head.len() == 2 && head.bytes().all(|b| b.is_ascii_digit())).then_some(head)
}

/// `gstinCheckCharacter(first14)`.
pub fn gstin_check_character(first14: &str) -> char {
    let mut sum: i64 = 0;
    for (i, c) in first14.chars().take(14).enumerate() {
        let value = GSTIN_ALPHABET
            .find(c)
            .and_then(|v| i64::try_from(v).ok())
            .unwrap_or(-1);
        let product = value * if i % 2 == 0 { 1 } else { 2 };
        sum += product.div_euclid(36) + product.rem_euclid(36);
    }
    let index = usize::try_from((36 - sum.rem_euclid(36)) % 36).unwrap_or(0);
    GSTIN_ALPHABET.chars().nth(index).unwrap_or('0')
}

/// `validateGstin(value, { pan })`.
pub fn validate_gstin(value: &str, pan: Option<&str>) -> TaxIdValidation {
    let normalized = normalize_gstin(value);
    if !is_gstin_shape(&normalized) {
        return TaxIdValidation::fail("GSTIN must be 15 characters (e.g. 27AAPFU0939F1ZV)");
    }
    let state = &normalized[..2];
    if !is_valid_gst_state_code(state) {
        return TaxIdValidation::fail(format!(
            "GSTIN has an invalid state code '{state}' (valid codes are 01-38 and 97)"
        ));
    }
    if !normalized[14..].starts_with(gstin_check_character(&normalized[..14])) {
        return TaxIdValidation::fail("GSTIN check digit is wrong: check the number for a typo");
    }
    let pan = pan
        .filter(|p| !p.is_empty())
        .map(|p| strip(p, &[]).to_uppercase())
        .unwrap_or_default();
    if !pan.is_empty() && is_pan_shape(&pan) && normalized[2..12] != pan {
        return TaxIdValidation::fail(format!(
            "GSTIN contains PAN {}, which does not match the PAN {pan}",
            &normalized[2..12]
        ));
    }
    TaxIdValidation::ok(normalized)
}

/// `validatePan(value)`.
pub fn validate_pan(value: &str) -> TaxIdValidation {
    let normalized = strip(value, &[]).to_uppercase();
    if !is_pan_shape(&normalized) {
        return TaxIdValidation::fail("PAN must match format AAAAA9999A");
    }
    TaxIdValidation::ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_a_gstin() {
        assert!(validate_gstin("27AAPFU0939F1ZV", None).valid);
        assert!(!validate_gstin("27AAPFU0939F1ZX", None).valid);
        assert_eq!(
            extract_state_code_from_gstin("27aapfu0939f1zv").as_deref(),
            Some("27")
        );
    }
}
