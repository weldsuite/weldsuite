//! Placeholder: the buyer-scoped invoice HTML (`services/commerce-portal-invoices.ts`
//! over `@weldsuite/books-domain/accounting-invoice-html`). Filled in by its port.

use weldsuite_db::PgPool;

/// A rendered invoice document.
#[allow(dead_code)]
pub(crate) struct RenderedInvoice {
    pub(crate) html: String,
    pub(crate) filename: String,
}

/// `renderPortalInvoiceHtml(db, invoiceId, partyId)`: `None` when the invoice
/// is not the party's, is a draft, or its entity is gone.
#[allow(dead_code)]
pub(crate) async fn render_portal_invoice_html(
    db: &PgPool,
    invoice_id: &str,
    party_id: &str,
) -> Result<Option<RenderedInvoice>, sqlx::Error> {
    let _ = (db, invoice_id, party_id);
    Ok(None)
}
