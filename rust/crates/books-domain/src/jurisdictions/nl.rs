//! The Netherlands (`jurisdictions/nl`): BTW and `KvK` numbers, the names of
//! the seeded rates the lazy rate update renames or adds.

use super::{DATA, TaxIdValidation, strip};

/// The Belastingdienst's account for what is paid on a return (BTW,
/// loonheffing, the other taxes it collects), as an IBAN without spaces. A
/// payment out to it that names a VAT return is booked to VAT payable by the
/// automatic bank matching.
pub const TAX_AUTHORITY_IBANS: &[&str] = &["NL86INGB0002445588"];

/// Whether `iban` (any spacing and case) is the tax authority's.
pub fn is_tax_authority_iban(iban: &str) -> bool {
    let normalized = strip(iban, &[]).to_uppercase();
    TAX_AUTHORITY_IBANS.contains(&normalized.as_str())
}

/// Whether a payment's description names a VAT return: an *aangifte*,
/// *btw* or *omzetbelasting* reference.
pub fn names_vat_return(description: &str) -> bool {
    let lower = description.to_lowercase();
    ["aangifte", "btw", "omzetbelasting"]
        .iter()
        .any(|word| lower.contains(word))
}

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
