//! `isAcceptedProductTaxClass` (`routes/products/tax-schemas.ts`): a
//! product's tax class is a WeldSuite tax code, a Stripe Tax code or an
//! Avalara product code. The tax codes themselves are WeldBooks'
//! ([`weldsuite_books_domain::sales_tax::tax_codes`]).

use weldsuite_books_domain::sales_tax::tax_codes::{is_stripe_tax_code, is_weld_tax_code};

/// `/^[A-Z]{1,2}\d{6,7}$/`: an Avalara product tax code.
fn is_product_avalara_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    let digits = bytes.len() - letters;
    (1..=2).contains(&letters)
        && (6..=7).contains(&digits)
        && bytes[letters..].iter().all(u8::is_ascii_digit)
}

/// `isAcceptedProductTaxClass(value)`.
pub(crate) fn is_accepted_product_tax_class(value: &str) -> bool {
    is_weld_tax_code(value) || is_stripe_tax_code(value) || is_product_avalara_code(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_product_tax_classes() {
        assert!(is_accepted_product_tax_class("saas"));
        assert!(is_accepted_product_tax_class("txcd_20030000"));
        assert!(is_accepted_product_tax_class("P0000000"));
        assert!(is_accepted_product_tax_class("SW054000"));
        assert!(!is_accepted_product_tax_class("txcd_123"));
        assert!(!is_accepted_product_tax_class("luxury"));
        assert!(!is_accepted_product_tax_class("ABC123456"));
    }
}
