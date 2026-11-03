//! Writing a tax calculation onto an invoice and its lines, and
//! recalculating a stored draft (`services/sales-tax/persist.ts`). Shared by
//! the invoice routes, finalize and recurring generation, so every path
//! stores the same columns.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js;
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, DocumentKind, IssueDate, Runtime,
};
use weldsuite_books_domain::sales_tax::errors::{DocumentError, SalesTaxError, address_required};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES};
use weldsuite_books_domain::tax::{
    CalculatedDocumentTax, DocumentTaxItem, GstSupply, TaxArgs, TaxError, calculate_document_tax,
    untaxed_document_tax,
};
use weldsuite_db::PgPool;

/// `ENGINE_UNAVAILABLE_WARNING`.
pub(crate) const ENGINE_UNAVAILABLE_WARNING: &str = "tax_engine_unavailable";

/// Warning codes of the last provider sync; replaced, never stacked.
const SYNC_WARNING_PREFIXES: [&str; 4] = [
    "commit_failed",
    "reverse_failed",
    "reverse_unsupported",
    "reverse_skipped",
];

pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

pub(crate) fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

fn object(row: &Value, key: &str) -> Option<Value> {
    row.get(key).filter(|v| !v.is_null()).cloned()
}

/// `invoiceKind(invoice)`.
pub(crate) fn invoice_kind(kind: Option<&str>) -> DocumentKind {
    match kind {
        Some("credit_note") => DocumentKind::CreditMemo,
        Some("proforma") => DocumentKind::Estimate,
        _ => DocumentKind::Invoice,
    }
}

/// `invoiceDocumentContext(invoice)` of a stored (or about to be stored)
/// invoice row.
pub(crate) fn invoice_document_context(invoice: &Value) -> DocumentContext {
    DocumentContext {
        kind: invoice_kind(text(invoice, "type")),
        document_id: owned(invoice, "id"),
        document_number: owned(invoice, "invoiceNumber"),
        contact_id: owned(invoice, "contactId"),
        issue_date: IssueDate::Instant(owned(invoice, "issueDate").unwrap_or_default()),
        currency: owned(invoice, "currency"),
        billing_address: object(invoice, "billingAddress"),
        shipping_address: object(invoice, "shippingAddress"),
        delivery_address: None,
        ship_from_address: object(invoice, "shipFromAddress"),
        marketplace_facilitated: invoice
            .get("marketplaceFacilitated")
            .and_then(Value::as_bool),
        fiscal_data: object(invoice, "fiscalData"),
        original_invoice_id: owned(invoice, "creditNoteForInvoiceId"),
    }
}

/// `invoiceItemToTaxItem(item)` of a stored line row.
pub(crate) fn invoice_item_to_tax_item(item: &Value) -> DocumentTaxItem {
    DocumentTaxItem {
        id: owned(item, "id"),
        description: owned(item, "description"),
        quantity: Some(owned(item, "quantity").unwrap_or_else(|| "1".into())),
        unit_price: owned(item, "unitPrice").unwrap_or_default(),
        discount_percent: Some(owned(item, "discountPercent").unwrap_or_else(|| "0".into())),
        sort_order: item.get("sortOrder").and_then(Value::as_f64),
        product_id: owned(item, "productId"),
        tax_rate_id: owned(item, "taxRateId"),
        tax_rate: owned(item, "taxRate"),
        tax_code: owned(item, "taxCode"),
        tax_use: owned(item, "taxUse"),
        tax_included: item.get("taxIncluded").and_then(Value::as_bool),
        tax_override_amount: owned(item, "taxOverrideAmount"),
        tax_override_reason: owned(item, "taxOverrideReason"),
        ncm: owned(item, "ncm"),
        cfop: owned(item, "cfop"),
        fiscal_data: object(item, "fiscalData"),
        ..DocumentTaxItem::default()
    }
}

fn opt(value: Option<&String>) -> Value {
    value.map_or(Value::Null, |v| Value::String(v.clone()))
}

/// `invoiceTaxColumns(calc)`: the header columns, as invoice properties.
pub(crate) fn invoice_tax_columns(calc: &CalculatedDocumentTax) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("subtotal".into(), json!(calc.subtotal));
    out.insert("discountTotal".into(), json!(calc.discount_total));
    out.insert("taxTotal".into(), json!(calc.tax_total));
    out.insert("total".into(), json!(calc.total));
    out.insert(
        "taxBreakdown".into(),
        Value::Array(calc.tax_breakdown.clone()),
    );
    if let Some(warnings) = &calc.tax_warnings {
        out.insert("taxWarnings".into(), json!(warnings));
    }
    if let Some(meta) = &calc.sales_tax {
        out.insert("taxEngine".into(), json!(meta.engine));
        out.insert("taxEngineRef".into(), opt(meta.engine_ref.as_ref()));
        out.insert("taxCalculatedAt".into(), json!(meta.calculated_at));
        out.insert("taxWarnings".into(), json!(meta.warnings));
        out.insert(
            "marketplaceFacilitated".into(),
            json!(meta.marketplace_facilitated),
        );
    }
    out
}

/// `itemTaxColumns(calc, index)`, as line properties.
pub(crate) fn item_tax_columns(calc: &CalculatedDocumentTax, index: usize) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(p) = calc.processed_items.get(index) {
        out.insert("taxRateId".into(), opt(p.tax_rate_id.as_ref()));
        out.insert("taxRate".into(), opt(p.tax_rate.as_ref()));
        out.insert("taxAmount".into(), json!(p.tax_amount));
        out.insert("lineTotal".into(), json!(p.line_total));
        out.insert("lineTotalWithTax".into(), json!(p.line_total_with_tax));
    }
    out
}

/// `DraftTaxResult`: the calculation, or the engine's failure with the
/// totals without tax.
pub(crate) struct Drafted {
    pub calc: CalculatedDocumentTax,
    /// The engine's message when it could not answer.
    pub failure: Option<String>,
}

impl Drafted {
    pub(crate) fn ok(&self) -> bool {
        self.failure.is_none()
    }
}

/// `calculateDraftTax(db, args)`: an engine failure is a result, so the
/// draft can still be saved (untaxed, flagged).
pub(crate) async fn calculate_draft_tax(
    db: &PgPool,
    args: &TaxArgs<'_>,
) -> Result<Drafted, TaxError> {
    match calculate_document_tax(db, args).await {
        Ok(calc) => Ok(Drafted {
            calc,
            failure: None,
        }),
        Err(TaxError::SalesTax(SalesTaxError::Engine(error))) => Ok(Drafted {
            calc: untaxed_document_tax(args.items),
            failure: Some(error.message),
        }),
        Err(other) => Err(other),
    }
}

/// `engineUnavailableWarning(message)`.
pub(crate) fn engine_unavailable_warning(message: &str) -> String {
    format!("{ENGINE_UNAVAILABLE_WARNING}: {message}")
}

/// `mergeSyncWarning(existing, next)`: the previous provider-sync outcome
/// (and any engine-unavailable note) replaced.
pub(crate) fn merge_sync_warning(existing: Option<&Value>, next: Option<String>) -> Vec<Value> {
    let mut kept: Vec<Value> = existing
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter(|w| {
                    let text = w.as_str().unwrap_or_default();
                    !SYNC_WARNING_PREFIXES.iter().any(|p| text.starts_with(p))
                        && !text.starts_with(ENGINE_UNAVAILABLE_WARNING)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if let Some(next) = next {
        kept.push(Value::String(next));
    }
    kept
}

/// What [`recalculate_stored_invoice`] stored.
pub(crate) struct Recalculated {
    pub invoice: Value,
    pub items: Vec<Value>,
    pub calc: CalculatedDocumentTax,
}

/// `recalculateStoredInvoice(db, invoice, items, runtime, opts)`: the
/// stored draft recalculated and written (header and lines together).
pub(crate) async fn recalculate_stored_invoice(
    db: &PgPool,
    invoice: &Value,
    items: &[Value],
    runtime: Option<&Runtime>,
    for_finalize: bool,
    gst: Option<&GstSupply>,
) -> Result<Recalculated, TaxError> {
    let tax_items: Vec<DocumentTaxItem> = items.iter().map(invoice_item_to_tax_item).collect();
    let doc = invoice_document_context(invoice);
    let entity_id = text(invoice, "entityId").unwrap_or_default().to_owned();
    let mut args = TaxArgs::new(
        &entity_id,
        weldsuite_books_domain::tax::Direction::Sales,
        &tax_items,
    )
    .with_gst(gst);
    args.document = Some(&doc);
    args.runtime = runtime;
    let calc = calculate_document_tax(db, &args).await?;
    if for_finalize && let Some(meta) = &calc.sales_tax {
        // Finalizing posts this tax: a document that can't be taxed properly must not post.
        if meta.address_incomplete {
            return Err(TaxError::SalesTax(address_required().into()));
        }
        if meta.warnings.iter().any(|w| w == "rates_not_configured") {
            return Err(TaxError::SalesTax(
                DocumentError::new(
                    "TAX_RATES_NOT_CONFIGURED",
                    format!(
                        "The entity is registered for sales tax in {}, but no rate is in force there on the invoice date. Add the jurisdictions and rates under Sales tax before finalizing.",
                        meta.ship_to_state.as_deref().unwrap_or("the ship-to state")
                    ),
                )
                .into(),
            ));
        }
    }

    let at = now();
    let mut header = invoice_tax_columns(&calc);
    if let Some(gst) = gst {
        header.insert("placeOfSupply".into(), opt(gst.place_of_supply.as_ref()));
    }
    let paid = js::parse_float(text(invoice, "amountPaid").unwrap_or("0"));
    header.insert(
        "balanceDue".into(),
        json!(js::to_fixed(js::parse_float(&calc.total) - paid, 2)),
    );
    header.insert("updatedAt".into(), json!(at));
    let line_columns: Vec<Map<String, Value>> = (0..items.len())
        .map(|idx| {
            let mut columns = item_tax_columns(&calc, idx);
            columns.insert("updatedAt".into(), json!(at));
            columns
        })
        .collect();

    let invoice_id = text(invoice, "id").unwrap_or_default();
    let mut tx = db.begin().await?;
    INVOICES
        .patch_raw(&mut *tx, invoice_id, INVOICES.values(&header), false)
        .await?;
    for (item, columns) in items.iter().zip(&line_columns) {
        INVOICE_ITEMS
            .patch_raw(
                &mut *tx,
                text(item, "id").unwrap_or_default(),
                INVOICE_ITEMS.values(columns),
                false,
            )
            .await?;
    }
    tx.commit().await?;

    let mut merged = invoice.clone();
    if let Value::Object(fields) = &mut merged {
        fields.extend(header);
    }
    let items = items
        .iter()
        .zip(line_columns)
        .map(|(item, columns)| {
            let mut item = item.clone();
            if let Value::Object(fields) = &mut item {
                fields.extend(columns);
            }
            item
        })
        .collect();
    Ok(Recalculated {
        invoice: merged,
        items,
        calc,
    })
}
