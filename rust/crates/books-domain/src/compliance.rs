//! Invoice compliance (`@weldsuite/books-domain/accounting-compliance`): the
//! buyer's VAT number, the tax categories of an invoice, the notices the law
//! wants printed, and the finalize checks (mandatory identifiers, buyer name,
//! KOR, reverse charge).

use std::collections::BTreeSet;

use weldsuite_db::PgPool;

/// `getContactVatNumber(db, partyId)`: parties carry no tax ids, the
/// company row they wrap does.
pub async fn get_contact_vat_number(
    db: &PgPool,
    party_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(party_id) = party_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let company: Option<Option<String>> =
        sqlx::query_scalar("select company_id from parties where id = $1 limit 1")
            .bind(party_id)
            .fetch_optional(db)
            .await?;
    let Some(company_id) = company.flatten().filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let vat: Option<Option<String>> =
        sqlx::query_scalar("select vat_number from companies where id = $1 limit 1")
            .bind(company_id)
            .fetch_optional(db)
            .await?;
    Ok(vat.flatten())
}

/// `collectInvoiceTaxCategories(db, invoiceId)`: the distinct tax category
/// codes of the invoice's live lines.
pub async fn collect_invoice_tax_categories(
    db: &PgPool,
    invoice_id: &str,
) -> Result<BTreeSet<String>, sqlx::Error> {
    let codes: Vec<Option<String>> = sqlx::query_scalar(
        "select r.tax_category_code from tax_rates r where r.id in ( \
           select i.tax_rate_id from invoice_items i \
           where i.invoice_id = $1 and i.deleted_at is null and i.tax_rate_id <> '')",
    )
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    Ok(codes
        .into_iter()
        .flatten()
        .filter(|code| !code.is_empty())
        .collect())
}

/// `invoiceUsesReverseCharge(categories)`.
pub fn invoice_uses_reverse_charge(categories: &BTreeSet<String>) -> bool {
    ["reverse_charge", "eu_b2b_service", "eu_b2b_goods"]
        .iter()
        .any(|code| categories.contains(*code))
}
