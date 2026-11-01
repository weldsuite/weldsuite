//! The buyer's invoice as printable HTML (`services/commerce-portal-invoices.ts`).
//!
//! TypeScript renders it with WeldBooks' invoice generator
//! (`@weldsuite/books-domain/accounting-invoice-html`: the jurisdiction
//! adapters' labels, `Intl` money and date formats, designed invoice
//! templates, Pix codes). That generator is not ported yet; it belongs to
//! the WeldBooks port. Until then the route finds the invoice as the worker
//! does (a draft, another party's invoice or one whose entity is gone is a
//! 404) and answers 503 for the document itself.

use weldsuite_db::PgPool;

/// What the portal can hand out for an invoice.
pub(crate) enum InvoiceDocument {
    /// Not the party's, a draft, or its entity is gone.
    NotFound,
    /// The invoice and its entity are there; the renderer is not.
    Unavailable,
}

/// `renderPortalInvoiceHtml(db, invoiceId, partyId)` up to the render.
pub(crate) async fn portal_invoice_document(
    db: &PgPool,
    invoice_id: &str,
    party_id: &str,
) -> Result<InvoiceDocument, sqlx::Error> {
    let Some(invoice) = crate::portal_public::load_portal_invoice(db, invoice_id, party_id).await? else {
        return Ok(InvoiceDocument::NotFound);
    };
    let entity_id = invoice
        .get("entityId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let entity: Option<String> =
        sqlx::query_scalar("select id from entities where id = $1 and deleted_at is null limit 1")
            .bind(&entity_id)
            .fetch_optional(db)
            .await?;
    Ok(if entity.is_some() {
        InvoiceDocument::Unavailable
    } else {
        InvoiceDocument::NotFound
    })
}
