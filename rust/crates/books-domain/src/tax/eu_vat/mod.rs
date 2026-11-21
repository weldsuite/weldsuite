//! EU destination VAT (OSS) and B2B reverse charge in the WeldBooks tax
//! engine (ADR COM-014).
//!
//! - [`rates`]: the versioned rate table (`data/eu_vat_rates.json`), by
//!   country, [`VatCategory`] and date.
//! - [`decide`]: the pure calculation: the [`EuTreatment`] of a sale and the
//!   net, tax and gross of each line, with gross-price mode.
//! - [`destination`]: the database side: the entity's country, its `oss`
//!   registration, VIES, and the `calculate_document_tax`-shaped result.
//!
//! The treatments:
//!
//! | Seller / buyer | Treatment | Rate |
//! |---|---|---|
//! | same country | `domestic` | seller's |
//! | other member state, VIES-valid VAT number | `reverse_charge` | 0% |
//! | other member state, consumer (or number rejected, or VIES down), OSS registered | `oss` | destination's |
//! | other member state, consumer (or number rejected, or VIES down), no OSS | `seller_rate_cross_border` | seller's |
//! | outside the EU | `outside_eu` | 0% |

pub mod decide;
pub mod destination;
pub mod rates;

pub use decide::{
    BuyerVat, DestinationInput, DestinationLine, EuTreatment, EuVatLine, EuVatResult, SupplyKind,
    ZeroRatedGross, calculate, decide_treatment, tax_in_gross, tax_on_net,
};
pub use destination::{EuTaxArgs, EuVatError, calculate_eu_destination_tax};
pub use rates::{
    RateError, VatCategory, is_eu_member, latest_rate_bps, member_states, rate_bps, source,
    standard_rate_bps, today, vat_prefix,
};

/// The category of a line: the variant's when it has one, else the product's.
/// `None` when the stored text is not a category.
pub fn effective_category(
    product_category: &str,
    variant_category: Option<&str>,
) -> Option<VatCategory> {
    VatCategory::parse(
        variant_category
            .filter(|c| !c.is_empty())
            .unwrap_or(product_category),
    )
}

#[cfg(test)]
mod tests;
