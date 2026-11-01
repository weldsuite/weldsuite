//! `GET /:id/pdf`: the printable HTML invoice, with the invoice's designed
//! template (else the entity's default, else the built-in layout), the
//! legally required statements and the buyer's VAT number.

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderValue};
use serde_json::{Map, Value};
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::compliance::{
    build_compliance_notices, collect_invoice_tax_categories, get_contact_vat_number,
    invoice_uses_reverse_charge,
};
use weldsuite_books_domain::contacts::load_contact_snapshot;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now, reply};
use weldsuite_books_domain::invoice_html::{
    FiscalDocument, InvoiceRenderData, RenderItem, generate_invoice_html,
    generate_templated_invoice_html,
};
use weldsuite_books_domain::tables::ENTITIES;

use crate::finalize::{load_invoice, load_items};
use crate::persist::{owned, text};
use crate::templates::resolve_invoice_template;

pub(crate) async fn render(
    caller: Caller,
    State(_state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        render_invoice(&caller, &id).await,
        "Failed to generate invoice document",
    )
}

fn filled(row: &Value, key: &str) -> Option<String> {
    owned(row, key).filter(|v| !v.is_empty())
}

/// Brazil: the authorised NF-e / NFS-e of the invoice (`brInvoiceRenderExtras`).
async fn fiscal_document(
    db: &weldsuite_db::PgPool,
    entity: &Value,
    invoice_id: &str,
) -> Result<Option<FiscalDocument>, sqlx::Error> {
    if entity["jurisdictionCode"] != "BR" {
        return Ok(None);
    }
    let doc: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select kind, number, access_key from fiscal_documents \
         where source_id = $1 and status = 'authorized' order by created_at desc limit 1",
    )
    .bind(invoice_id)
    .fetch_optional(db)
    .await?;
    Ok(doc.map(|(kind, number, access_key)| FiscalDocument {
        label: match kind.as_str() {
            "nfe" => "NF-e".to_owned(),
            "nfse" | "nfsen" => "NFS-e".to_owned(),
            other => other.to_uppercase(),
        },
        number,
        access_key,
    }))
}

async fn render_invoice(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    let items = load_items(db, id, true).await?;
    let entity_id = text(&invoice, "entityId").unwrap_or_default().to_owned();
    let entity: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&entity_id)
    .fetch_optional(db)
    .await?;
    let Some(entity) = entity.map(|e| ENTITIES.js(e)) else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };

    let categories = collect_invoice_tax_categories(db, id).await?;
    let notices = build_compliance_notices(&entity, &categories);
    // An Indian tax invoice names the buyer's GSTIN; elsewhere a reverse-charge invoice does.
    let contact_id = text(&invoice, "contactId");
    let contact_vat = if entity["jurisdictionCode"] == "IN" {
        match owned(&invoice, "contactTaxNumber") {
            Some(number) => Some(number),
            None => get_contact_vat_number(db, contact_id).await?,
        }
    } else if invoice_uses_reverse_charge(&categories) {
        get_contact_vat_number(db, contact_id).await?
    } else {
        None
    };

    // An exempt US sale prints its certificate number.
    let breakdown: Vec<Value> = invoice["taxBreakdown"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut certificate_ids: Vec<String> = Vec::new();
    for row in &breakdown {
        if let Some(id) = row["certificateId"].as_str().filter(|c| !c.is_empty())
            && !certificate_ids.iter().any(|c| c == id)
        {
            certificate_ids.push(id.to_owned());
        }
    }
    let mut certificate_numbers = Map::new();
    if !certificate_ids.is_empty() {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "select id, certificate_number from exemption_certificates where id = any($1)",
        )
        .bind(&certificate_ids)
        .fetch_all(db)
        .await?;
        for (cid, number) in rows {
            certificate_numbers.insert(cid, number.map_or(Value::Null, Value::String));
        }
    }

    // Invoices stored without the contact's name print the contact's own.
    let (snapshot_name, snapshot_email) = if filled(&invoice, "contactName").is_some()
        && filled(&invoice, "contactEmail").is_some()
    {
        (
            owned(&invoice, "contactName"),
            owned(&invoice, "contactEmail"),
        )
    } else {
        let snapshot = load_contact_snapshot(db, contact_id).await?;
        (snapshot.name, snapshot.email)
    };
    let iso_or_now = |key: &str| filled(&invoice, key).unwrap_or_else(now);
    let data = InvoiceRenderData {
        draft: invoice["status"] == "draft",
        certificate_numbers,
        invoice_number: filled(&invoice, "invoiceNumber").unwrap_or_else(|| id.to_owned()),
        kind: filled(&invoice, "type").unwrap_or_else(|| "standard".to_owned()),
        issue_date: iso_or_now("issueDate"),
        due_date: iso_or_now("dueDate"),
        currency: filled(&invoice, "currency")
            .or_else(|| filled(&entity, "baseCurrency"))
            .unwrap_or_else(|| "EUR".to_owned()),
        contact_name: filled(&invoice, "contactName")
            .or(snapshot_name.filter(|n| !n.is_empty()))
            .unwrap_or_default(),
        contact_email: match invoice.get("contactEmail") {
            Some(Value::String(email)) => Some(email.clone()),
            _ => snapshot_email,
        },
        contact_vat_number: contact_vat,
        compliance_notices: notices,
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
        place_of_supply: owned(&invoice, "placeOfSupply"),
        items: items
            .iter()
            .map(|i| RenderItem {
                description: filled(i, "description").unwrap_or_default(),
                hsn_sac: owned(i, "hsnSac"),
                quantity: filled(i, "quantity").unwrap_or_else(|| "1".to_owned()),
                unit_price: filled(i, "unitPrice").unwrap_or_else(|| "0".to_owned()),
                unit: owned(i, "unit"),
                discount_percent: owned(i, "discountPercent"),
                tax_rate: owned(i, "taxRate"),
                line_total: filled(i, "lineTotal").unwrap_or_else(|| "0".to_owned()),
                line_total_with_tax: owned(i, "lineTotalWithTax"),
                tax_amount: owned(i, "taxAmount"),
            })
            .collect(),
        subtotal: filled(&invoice, "subtotal").unwrap_or_else(|| "0".to_owned()),
        discount_total: filled(&invoice, "discountTotal").unwrap_or_else(|| "0".to_owned()),
        tax_total: filled(&invoice, "taxTotal").unwrap_or_else(|| "0".to_owned()),
        total: filled(&invoice, "total").unwrap_or_else(|| "0".to_owned()),
        amount_paid: owned(&invoice, "amountPaid"),
        balance_due: owned(&invoice, "balanceDue"),
        tax_breakdown: breakdown,
        fiscal_document: fiscal_document(db, &entity, id).await?,
    };
    let template = resolve_invoice_template(db, text(&invoice, "templateId"), &entity_id).await?;
    let html = match template {
        Some(template) => generate_templated_invoice_html(&template, &data, &entity),
        None => generate_invoice_html(&data, &entity),
    }
    .map_err(|error| Refusal::Internal(error.0))?;
    let filename = filled(&invoice, "invoiceNumber").unwrap_or_else(|| "invoice".to_owned());
    let mut response = (StatusCode::OK, html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{filename}.html\"")) {
        headers.insert(CONTENT_DISPOSITION, value);
    }
    Ok(response)
}
