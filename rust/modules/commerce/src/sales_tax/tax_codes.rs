//! `@weldsuite/books-domain/jurisdictions/us/tax-codes` (what commerce reads
//! of it) and products' `tax-schemas.ts`: WeldBooks' own tax codes and the
//! provider code shapes a product or an order line may carry.

/// `WELD_TAX_CODES`.
pub(crate) const WELD_TAX_CODES: &[&str] = &[
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

/// `DEFAULT_WELD_TAX_CODE`.
pub(crate) const DEFAULT_WELD_TAX_CODE: &str = "general";

/// `isWeldTaxCode(value)`.
pub(crate) fn is_weld_tax_code(value: &str) -> bool {
    WELD_TAX_CODES.contains(&value)
}

/// `isStripeTaxCode(value)`: `/^txcd_\d{8}$/`.
pub(crate) fn is_stripe_tax_code(value: &str) -> bool {
    value
        .strip_prefix("txcd_")
        .is_some_and(|digits| digits.len() == 8 && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `isAvalaraTaxCode(value)`: `/^[A-Z]{1,2}[A-Z0-9]{0,10}$/` with a digit,
/// or `NT`.
#[allow(dead_code)] // the order sales tax reads it
pub(crate) fn is_avalara_tax_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    // The pattern backtracks: one or two leading letters, then up to ten
    // uppercase letters or digits.
    let shaped = !bytes.is_empty()
        && bytes[0].is_ascii_uppercase()
        && bytes.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && bytes.len() <= 12
        && letters >= 1;
    shaped && (bytes.iter().any(u8::is_ascii_digit) || value == "NT")
}

/// Products' stricter Avalara shape: `/^[A-Z]{1,2}\d{6,7}$/`.
fn is_product_avalara_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    let digits = bytes.len() - letters;
    (1..=2).contains(&letters) && (6..=7).contains(&digits) && bytes[letters..].iter().all(u8::is_ascii_digit)
}

/// `isAcceptedProductTaxClass(value)` (products' `tax-schemas.ts`).
pub(crate) fn is_accepted_product_tax_class(value: &str) -> bool {
    is_weld_tax_code(value) || is_stripe_tax_code(value) || is_product_avalara_code(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_codes() {
        assert!(is_accepted_product_tax_class("saas"));
        assert!(is_accepted_product_tax_class("txcd_20030000"));
        assert!(is_accepted_product_tax_class("P0000000"));
        assert!(is_accepted_product_tax_class("SW054000"));
        assert!(!is_accepted_product_tax_class("txcd_123"));
        assert!(!is_accepted_product_tax_class("luxury"));
        assert!(!is_accepted_product_tax_class("ABC123456"));
        assert!(is_avalara_tax_code("NT"));
        assert!(is_avalara_tax_code("PC040100"));
        assert!(!is_avalara_tax_code("ABC"));
        assert!(!is_avalara_tax_code("pc1"));
    }
}
