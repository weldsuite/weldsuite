//! Finalizing an invoice or credit note
//! (`services/accounting-invoice-finalize.ts`): enforce the jurisdiction's
//! invoice requirements, then post it. Used by `POST /:id/finalize`, `PATCH
//! /:id/send` on a draft and auto-finalizing recurring invoices.
//!
//! US sales tax: the draft is recalculated first (the tax that posts is
//! today's answer), refused without an address or while the engine is down,
//! and recorded with a provider engine after posting (a failure there is
//! kept in `tax_warnings`, never undoes the ledger).

use serde_json::{Map, Value, json};
use weldsuite_books_domain::compliance::{
    collect_invoice_tax_categories, get_contact_vat_number, validate_invoice_for_finalize,
};
use weldsuite_books_domain::document_posting::{PostInvoiceOptions, load_entity, post_invoice};
use weldsuite_books_domain::sales_tax::document_tax::{
    Runtime, load_sales_tax_entity, uses_sales_tax,
};
use weldsuite_books_domain::sales_tax::errors::{SalesTaxError, engine_unavailable};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES};
use weldsuite_books_domain::tax::{GstSupply, SupplyArgs, TaxError, resolve_gst_supply};
use weldsuite_books_domain::{books_row, js};
use weldsuite_db::PgPool;
use weldsuite_ports::OutboundHttp;

use crate::credit_notes::{CreditApplication, apply_credit_note_on_finalize};
use crate::errors::SalesError;
use crate::persist::{owned, recalculate_stored_invoice, text};
use crate::provider_sync::{ProviderSync, sync_invoice_with_provider};

/// `FinalizeResult`.
pub(crate) struct Finalized {
    pub journal_entry_id: Option<String>,
    pub entry_number: Option<String>,
    pub already_posted: bool,
    pub warnings: Vec<String>,
    pub tax_sync: Option<ProviderSync>,
    pub credit_applied: Option<CreditApplication>,
}

/// The live invoice `id`, as Drizzle returns it.
pub(crate) async fn load_invoice(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(invoices),
        " from invoices t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| INVOICES.js(row)))
}

/// The live lines of an invoice, in the database's order (no `order by`,
/// as TypeScript asks) or by `sort_order`.
pub(crate) async fn load_items(
    db: &PgPool,
    invoice_id: &str,
    sorted: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = if sorted {
        sqlx::query_scalar(concat!(
            "select ",
            books_row!(invoice_items),
            " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null order by t.sort_order"
        ))
        .bind(invoice_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            books_row!(invoice_items),
            " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null"
        ))
        .bind(invoice_id)
        .fetch_all(db)
        .await?
    };
    Ok(INVOICE_ITEMS.js_rows(rows))
}

/// `gstSplitMissing(invoice)`: GST charged at a slab rate that was not
/// split (no place of supply).
fn gst_split_missing(invoice: &Value) -> bool {
    invoice["taxBreakdown"].as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            js::js_number_value(row.get("taxRate")) > 0.0
                && !js::truthy(row.get("component"))
                && !js::truthy(row.get("selfAssessed"))
                && row.get("taxCategoryCode").and_then(Value::as_str) != Some("reverse_charge")
        })
    })
}

/// `enforceCompliance(db, invoice, gstSupply)`: the warnings, or the
/// refusal.
async fn enforce_compliance(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    invoice: &Value,
    gst: Option<&GstSupply>,
) -> Result<Vec<String>, SalesError> {
    let entity = load_entity(db, text(invoice, "entityId").unwrap_or_default()).await?;
    let id = text(invoice, "id").unwrap_or_default();
    let categories = collect_invoice_tax_categories(db, id).await?;
    let mut compliance =
        validate_invoice_for_finalize(db, http, &entity, invoice, &categories).await?;
    if gst.is_some() && text(invoice, "type") != Some("credit_note") && gst_split_missing(invoice) {
        compliance.errors.push("GST is charged but the place of supply is unknown, so it can't be split into CGST + SGST or IGST. Choose the place of supply on the invoice (or add the customer's GSTIN or address state) before finalizing.".to_owned());
    }
    if !compliance.ok() {
        return Err(SalesError::Compliance {
            message: compliance.errors.join(" "),
            missing_fields: compliance.missing_entity_fields,
        });
    }
    Ok(compliance.warnings)
}

/// `bookingSnapshot(db, invoice, gstSupply)`: the buyer's tax id and place
/// of supply as they were when the invoice was booked.
async fn booking_snapshot(
    db: &PgPool,
    invoice: &Value,
    gst: Option<&GstSupply>,
) -> Result<Map<String, Value>, sqlx::Error> {
    let mut snapshot = Map::new();
    let number = match owned(invoice, "contactTaxNumber") {
        Some(number) => Some(number),
        None => get_contact_vat_number(db, text(invoice, "contactId"))
            .await?
            .map(|v| weldsuite_books_domain::jurisdictions::js_trim(&v).to_owned())
            .filter(|v| !v.is_empty()),
    };
    snapshot.insert("contactTaxNumber".into(), json!(number));
    if let Some(gst) = gst {
        snapshot.insert("placeOfSupply".into(), json!(gst.place_of_supply));
    }
    Ok(snapshot)
}

/// What `finalizeInvoice` is told.
pub(crate) struct FinalizeOptions<'a> {
    pub user_id: Option<String>,
    pub mark_sent: bool,
    pub runtime: &'a Runtime,
    pub http: Option<&'a OutboundHttp>,
}

/// `finalizeInvoice(db, invoiceId, opts)`.
#[allow(
    clippy::too_many_lines,
    reason = "finalizeInvoice's steps in its order"
)]
pub(crate) async fn finalize_invoice(
    db: &PgPool,
    invoice_id: &str,
    opts: FinalizeOptions<'_>,
) -> Result<Finalized, SalesError> {
    let Some(stored) = load_invoice(db, invoice_id).await? else {
        return Err(SalesError::posting("Invoice not found"));
    };
    if let Some(entry) = owned(&stored, "journalEntryId") {
        return Ok(Finalized {
            journal_entry_id: Some(entry),
            entry_number: None,
            already_posted: true,
            warnings: Vec::new(),
            tax_sync: None,
            credit_applied: None,
        });
    }
    if text(&stored, "type") == Some("proforma") {
        return Err(SalesError::posting(
            "Pro forma invoices are not booked. Create a standard invoice to finalize.",
        ));
    }

    let mut invoice = stored;
    let mut items = load_items(db, invoice_id, false).await?;
    let mut warnings: Vec<String> = Vec::new();
    let entity_id = text(&invoice, "entityId").unwrap_or_default().to_owned();
    let sales_tax = uses_sales_tax(load_sales_tax_entity(db, &entity_id).await?.as_ref());
    if sales_tax && !items.is_empty() {
        let refreshed =
            recalculate_stored_invoice(db, &invoice, &items, Some(opts.runtime), true, None)
                .await
                .map_err(|error| match error {
                    TaxError::SalesTax(SalesTaxError::Engine(engine)) => {
                        TaxError::SalesTax(engine_unavailable(&engine).into())
                    }
                    other => other,
                })?;
        warnings.extend(
            refreshed
                .calc
                .sales_tax
                .as_ref()
                .map(|meta| meta.warnings.clone())
                .unwrap_or_default(),
        );
        invoice = refreshed.invoice;
        items = refreshed.items;
    }

    // India GST: the split follows the place of supply as it stands now; a credit note keeps its invoice's.
    let gst = resolve_gst_supply(
        db,
        SupplyArgs {
            entity_id: &entity_id,
            contact_id: text(&invoice, "contactId"),
            place_of_supply: text(&invoice, "placeOfSupply"),
            shipping_address: invoice.get("shippingAddress").filter(|v| !v.is_null()),
            billing_address: invoice.get("billingAddress").filter(|v| !v.is_null()),
        },
    )
    .await?;
    if let Some(gst) = gst.as_ref()
        && !items.is_empty()
        && text(&invoice, "type") != Some("credit_note")
    {
        let refreshed =
            recalculate_stored_invoice(db, &invoice, &items, Some(opts.runtime), false, Some(gst))
                .await?;
        invoice = refreshed.invoice;
        items = refreshed.items;
    }

    warnings.extend(enforce_compliance(db, opts.http, &invoice, gst.as_ref()).await?);

    let snapshot = booking_snapshot(db, &invoice, gst.as_ref()).await?;
    let posted = post_invoice(
        db,
        opts.http,
        &invoice,
        &items,
        PostInvoiceOptions {
            user_id: opts.user_id.clone(),
            mark_sent: opts.mark_sent,
            keep_status: false,
            snapshot,
        },
    )
    .await?;

    // afterPosting: a credit note lowers what is open on its invoice; a provider records the document.
    let booked = posted.journal_entry_id.is_some() && !posted.already_posted;
    let mut credit_applied = None;
    if text(&invoice, "type") == Some("credit_note") && booked {
        credit_applied = apply_credit_note_on_finalize(db, invoice_id).await?;
    }
    let mut tax_sync = None;
    if sales_tax && booked {
        let sync = sync_invoice_with_provider(db, invoice_id, opts.runtime).await?;
        if let Some(warning) = &sync.warning {
            warnings.push(warning.clone());
        }
        tax_sync = Some(sync);
    }
    Ok(Finalized {
        journal_entry_id: posted.journal_entry_id,
        entry_number: posted.entry_number,
        already_posted: posted.already_posted,
        warnings,
        tax_sync,
        credit_applied,
    })
}
