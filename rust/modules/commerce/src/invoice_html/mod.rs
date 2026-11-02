//! The buyer's invoice as printable HTML (`services/commerce-portal-invoices.ts`):
//! WeldBooks' built-in invoice layout ([`weldsuite_books_domain::invoice_html`]),
//! so portal documents match WeldBooks' own. A draft, another party's
//! invoice or one whose entity is gone is not found.

use serde_json::Value;
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::compliance::{
    build_compliance_notices, collect_invoice_tax_categories, get_contact_vat_number,
    invoice_uses_reverse_charge,
};
use weldsuite_books_domain::invoice_html::{InvoiceRenderData, RenderItem, generate_invoice_html};
use weldsuite_books_domain::tables::{ENTITIES, INVOICE_ITEMS};
use weldsuite_db::PgPool;

/// What the portal hands out for an invoice.
pub(crate) enum InvoiceDocument {
    /// Not the party's, a draft, or its entity is gone.
    NotFound,
    /// The document and its file name.
    Html { html: String, filename: String },
}

/// Why the document could not be made: a statement, or the generator (an
/// entity in a jurisdiction without an invoice adapter). Both are the
/// route's 500.
#[derive(Debug)]
pub(crate) enum InvoiceDocumentError {
    Database(sqlx::Error),
    Render(String),
}

impl std::fmt::Display for InvoiceDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Render(message) => f.write_str(message),
        }
    }
}

impl From<sqlx::Error> for InvoiceDocumentError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `row[key] || fallback`: an empty string falls through too.
fn or(row: &Value, key: &str, fallback: &str) -> String {
    text(row, key)
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

/// `row[key] ?? undefined`.
fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

/// `renderPortalInvoiceHtml(db, invoiceId, partyId)`.
pub(crate) async fn portal_invoice_document(
    db: &PgPool,
    invoice_id: &str,
    party_id: &str,
) -> Result<InvoiceDocument, InvoiceDocumentError> {
    let Some(invoice) = crate::portal_public::load_portal_invoice(db, invoice_id, party_id).await?
    else {
        return Ok(InvoiceDocument::NotFound);
    };
    let items: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(invoice_items),
        " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null order by t.sort_order"
    ))
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    let items = INVOICE_ITEMS.js_rows(items);
    let entity: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(text(&invoice, "entityId").unwrap_or_default())
    .fetch_optional(db)
    .await?;
    let Some(entity) = entity.map(|e| ENTITIES.js(e)) else {
        return Ok(InvoiceDocument::NotFound);
    };

    let categories = collect_invoice_tax_categories(db, invoice_id).await?;
    let compliance_notices = build_compliance_notices(&entity, &categories);
    let contact_vat_number = if invoice_uses_reverse_charge(&categories) {
        get_contact_vat_number(db, text(&invoice, "contactId")).await?
    } else {
        None
    };

    let iso_or_now = |key: &str| {
        text(&invoice, key)
            .filter(|v| !v.is_empty())
            .map_or_else(crate::now, str::to_owned)
    };
    let data = InvoiceRenderData {
        invoice_number: or(&invoice, "invoiceNumber", invoice_id),
        kind: or(&invoice, "type", "standard"),
        issue_date: iso_or_now("issueDate"),
        due_date: iso_or_now("dueDate"),
        currency: text(&invoice, "currency")
            .filter(|c| !c.is_empty())
            .or_else(|| text(&entity, "baseCurrency").filter(|c| !c.is_empty()))
            .unwrap_or("EUR")
            .to_owned(),
        contact_name: or(&invoice, "contactName", ""),
        contact_email: owned(&invoice, "contactEmail"),
        contact_vat_number,
        compliance_notices,
        billing_address: invoice
            .get("billingAddress")
            .filter(|v| !v.is_null())
            .cloned(),
        shipping_address: invoice
            .get("shippingAddress")
            .filter(|v| !v.is_null())
            .cloned(),
        reference: owned(&invoice, "reference"),
        notes: owned(&invoice, "notes"),
        items: items
            .iter()
            .map(|i| RenderItem {
                description: or(i, "description", ""),
                quantity: or(i, "quantity", "1"),
                unit_price: or(i, "unitPrice", "0"),
                unit: owned(i, "unit"),
                discount_percent: owned(i, "discountPercent"),
                tax_rate: owned(i, "taxRate"),
                line_total: or(i, "lineTotal", "0"),
                line_total_with_tax: owned(i, "lineTotalWithTax"),
                tax_amount: owned(i, "taxAmount"),
                hsn_sac: None,
            })
            .collect(),
        subtotal: or(&invoice, "subtotal", "0"),
        discount_total: or(&invoice, "discountTotal", "0"),
        tax_total: or(&invoice, "taxTotal", "0"),
        total: or(&invoice, "total", "0"),
        amount_paid: owned(&invoice, "amountPaid"),
        balance_due: owned(&invoice, "balanceDue"),
        tax_breakdown: invoice["taxBreakdown"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        ..InvoiceRenderData::default()
    };
    let html = generate_invoice_html(&data, &entity)
        .map_err(|error| InvoiceDocumentError::Render(error.0))?;
    Ok(InvoiceDocument::Html {
        html,
        filename: format!("{}.html", or(&invoice, "invoiceNumber", "invoice")),
    })
}
