//! WeldBooks product tax codes and their mapping to each provider's codes
//! (`jurisdictions/us/tax-codes.ts`). Products store a WeldBooks code in
//! `products.tax_class`, document lines in `tax_code`; the manual engine keys
//! its rules on it, Stripe Tax and Avalara get their own code. A line may
//! also carry a provider code directly (`txcd_20030000`, `PC040100`), which
//! passes through to its own provider.

use serde_json::{Value, json};

use super::errors::EngineError;
use super::provider::invalid_request;
use super::types::TaxUse;

/// `WELD_TAX_CODES`.
pub const WELD_TAX_CODES: [&str; 12] = [
    "general",
    "saas",
    "digital_goods",
    "services",
    "professional_services",
    "shipping",
    "handling",
    "food_grocery",
    "prepared_food",
    "clothing",
    "prescription_drugs",
    "non_taxable",
];

/// `DEFAULT_WELD_TAX_CODE`: taxable as general tangible goods.
pub const DEFAULT_WELD_TAX_CODE: &str = "general";

/// `isWeldTaxCode(value)`.
pub fn is_weld_tax_code(value: &str) -> bool {
    WELD_TAX_CODES.contains(&value)
}

/// `WELD_TAX_CODE_INFO[code]`: `{ code, label, description, kind }`.
pub fn weld_tax_code_info(code: &str) -> Option<Value> {
    let (label, description, kind) = match code {
        "general" => (
            "General goods",
            "Tangible personal property: physical products that have no special treatment.",
            "goods",
        ),
        "saas" => (
            "Software as a service",
            "Hosted software the customer uses online. Taxable in some states (for example NY, TX, WA, PA, OH) and not in others.",
            "digital",
        ),
        "digital_goods" => (
            "Digital goods",
            "Downloaded software, e-books, music, video and other electronically delivered products.",
            "digital",
        ),
        "services" => (
            "Services",
            "General services. Most states do not tax them; some tax specific kinds.",
            "service",
        ),
        "professional_services" => (
            "Professional services",
            "Consulting, legal, accounting and similar services.",
            "service",
        ),
        "shipping" => (
            "Shipping",
            "Shipping and delivery charges. Taxable in some states when the goods are, and exempt in others when separately stated.",
            "charge",
        ),
        "handling" => (
            "Handling",
            "Handling, packaging and service fees charged with a sale.",
            "charge",
        ),
        "food_grocery" => (
            "Groceries",
            "Food and beverages for home consumption. Exempt or reduced in many states.",
            "goods",
        ),
        "prepared_food" => (
            "Prepared food",
            "Restaurant meals, heated food and food sold with utensils.",
            "goods",
        ),
        "clothing" => (
            "Clothing",
            "Apparel and footwear. Exempt or reduced in some states (for example NJ, PA, MN).",
            "goods",
        ),
        "prescription_drugs" => (
            "Prescription drugs",
            "Drugs sold on a prescription. Exempt in nearly every state.",
            "goods",
        ),
        "non_taxable" => (
            "Non-taxable",
            "Never taxed (for example donations, reimbursements, or items you have confirmed are exempt everywhere you sell).",
            "exempt",
        ),
        _ => return None,
    };
    Some(json!({ "code": code, "label": label, "description": description, "kind": kind }))
}

fn pick(business: &'static str, personal: &'static str, tax_use: TaxUse) -> &'static str {
    match tax_use {
        TaxUse::Business => business,
        TaxUse::Personal => personal,
    }
}

fn stripe_code(code: &str, tax_use: TaxUse) -> Option<&'static str> {
    Some(match code {
        "general" => "txcd_99999999",
        "saas" => pick("txcd_10103001", "txcd_10103000", tax_use),
        "digital_goods" => "txcd_10000000",
        "services" => "txcd_20030000",
        "professional_services" => "txcd_20060000",
        "shipping" => "txcd_92010001",
        "handling" => "txcd_92010004",
        "food_grocery" => "txcd_40040000",
        "prepared_food" => "txcd_40060003",
        "clothing" => "txcd_30011000",
        "prescription_drugs" => "txcd_32020001",
        "non_taxable" => "txcd_00000000",
        _ => return None,
    })
}

fn avalara_code(code: &str, tax_use: TaxUse) -> Option<&'static str> {
    Some(match code {
        "general" => "P0000000",
        "saas" => pick("SW054002", "SW054000", tax_use),
        "digital_goods" => "D0000000",
        "services" => "S0000000",
        "professional_services" => "SP140000",
        "shipping" => "FR020100",
        "handling" => "OH010000",
        "food_grocery" => "PF050001",
        "prepared_food" => "PA0010000",
        "clothing" => pick("PC030100", "PC040100", tax_use),
        "prescription_drugs" => "PH050102",
        "non_taxable" => "NT",
        _ => return None,
    })
}

/// `isStripeTaxCode(value)`: `/^txcd_\d{8}$/`.
pub fn is_stripe_tax_code(value: &str) -> bool {
    value.len() == 13
        && value.starts_with("txcd_")
        && value[5..].bytes().all(|b| b.is_ascii_digit())
}

/// `isAvalaraTaxCode(value)`: `/^[A-Z]{1,2}[A-Z0-9]{0,10}$/` with a digit,
/// or `NT`.
pub fn is_avalara_tax_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 12 {
        return false;
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return false;
    }
    // One or two letters first: the first character is a letter, and the
    // rest (at most ten after the leading letters) letters or digits.
    if !bytes[0].is_ascii_uppercase() {
        return false;
    }
    let leading = if bytes.len() > 1 && bytes[1].is_ascii_uppercase() {
        2
    } else {
        1
    };
    // `[A-Z]{1,2}[A-Z0-9]{0,10}`: up to 12 in all, and any split works when
    // the second char is a letter; with one letter the rest is at most 10.
    if leading == 1 && bytes.len() > 11 {
        return false;
    }
    value == "NT" || bytes.iter().any(u8::is_ascii_digit)
}

/// `toStripeTaxCode(code, use)`: a `txcd_` code passes through, an empty
/// code is general goods, anything else unknown is refused.
pub fn to_stripe_tax_code(code: &str, tax_use: TaxUse) -> Result<String, EngineError> {
    if let Some(mapped) = stripe_code(code, tax_use) {
        return Ok(mapped.to_owned());
    }
    if is_stripe_tax_code(code) {
        return Ok(code.to_owned());
    }
    if crate::jurisdictions::js_trim(code).is_empty() {
        return Ok(pick("txcd_99999999", "txcd_99999999", tax_use).to_owned());
    }
    Err(invalid_request(format!(
        "No Stripe tax code is mapped for \"{code}\""
    )))
}

/// `toAvalaraTaxCode(code, use)`.
pub fn to_avalara_tax_code(code: &str, tax_use: TaxUse) -> Result<String, EngineError> {
    if let Some(mapped) = avalara_code(code, tax_use) {
        return Ok(mapped.to_owned());
    }
    if is_avalara_tax_code(code) {
        return Ok(code.to_owned());
    }
    if crate::jurisdictions::js_trim(code).is_empty() {
        return Ok("P0000000".to_owned());
    }
    Err(invalid_request(format!(
        "No Avalara tax code is mapped for \"{code}\""
    )))
}

/// `normalizeWeldTaxCode(value)`.
pub fn normalize_weld_tax_code(value: Option<&str>) -> &str {
    match value {
        Some(code) if is_weld_tax_code(code) => code,
        _ => DEFAULT_WELD_TAX_CODE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_codes() {
        assert!(is_stripe_tax_code("txcd_20030000"));
        assert!(!is_stripe_tax_code("txcd_2003000"));
        assert!(is_avalara_tax_code("PC040100"));
        assert!(is_avalara_tax_code("NT"));
        assert!(is_avalara_tax_code("P0000000"));
        assert!(is_avalara_tax_code("PA0010000"));
        assert!(!is_avalara_tax_code("general"));
        assert!(!is_avalara_tax_code("ABC"));
        assert!(!is_avalara_tax_code("1A"));
        assert_eq!(
            to_stripe_tax_code("saas", TaxUse::Personal).as_deref(),
            Ok("txcd_10103000")
        );
        assert_eq!(
            to_avalara_tax_code("clothing", TaxUse::Business).as_deref(),
            Ok("PC030100")
        );
        assert_eq!(
            to_avalara_tax_code(" ", TaxUse::Business).as_deref(),
            Ok("P0000000")
        );
        assert_eq!(
            to_stripe_tax_code("whatever", TaxUse::Business).map_err(|e| e.message),
            Err("No Stripe tax code is mapped for \"whatever\"".to_owned())
        );
    }
}
