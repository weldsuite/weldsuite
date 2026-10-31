//! The Netherlands (`jurisdictions/nl`): BTW and KvK numbers, the names of
//! the seeded rates the lazy rate update renames or adds.

use super::{DATA, TaxIdValidation, strip};

/// `validateBtwNumber`: `NL` + 9 digits + `B` + 2 digits.
pub fn validate_btw_number(value: &str) -> TaxIdValidation {
    let normalized = strip(value, &[]).to_uppercase();
    let bytes = normalized.as_bytes();
    let shaped = bytes.len() == 14
        && normalized.starts_with("NL")
        && bytes[2..11].iter().all(u8::is_ascii_digit)
        && bytes[11] == b'B'
        && bytes[12..].iter().all(u8::is_ascii_digit);
    if !shaped {
        return TaxIdValidation::fail("Dutch BTW number must match format NL123456789B01");
    }
    TaxIdValidation::ok(normalized)
}

/// `validateKvk`: 8 digits.
pub fn validate_kvk(value: &str) -> TaxIdValidation {
    let normalized = strip(value, &[]);
    if normalized.len() != 8 || !normalized.bytes().all(|b| b.is_ascii_digit()) {
        return TaxIdValidation::fail("KVK number must be 8 digits");
    }
    TaxIdValidation::ok(normalized)
}

fn name(key: &str) -> &'static str {
    DATA["nl"][key].as_str().unwrap_or_default()
}

/// `NL_EU_SERVICES_RATE_NAME`.
pub fn eu_services_rate_name() -> &'static str {
    name("euServicesRateName")
}

/// `NL_ICL_GOODS_RATE_NAME`.
pub fn icl_goods_rate_name() -> &'static str {
    name("iclGoodsRateName")
}

/// `NL_LEGACY_EU_RATE_NAME`.
pub fn legacy_eu_rate_name() -> &'static str {
    name("legacyEuRateName")
}
