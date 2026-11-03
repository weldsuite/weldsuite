//! `POST /`, `PUT|PATCH /:id`, `DELETE /:id`: drafts are created with the
//! server-side tax calculation, edited (re-taxed when their lines or, for US
//! and Indian/Brazilian entities, the facts their tax depends on change) and
//! deleted; anything past draft is immutable.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::contacts::document_contact_fields;
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::fx::{RateQuery, draft_rate, is_foreign_currency};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, now, ok, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::posting::assert_dimensions_belong_to_entity;
use weldsuite_books_domain::roles::{PromoteTo, promote_accounting_role};
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, IssueDate, Runtime, load_sales_tax_entity, uses_sales_tax,
};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES};
use weldsuite_books_domain::tax::{
    DocumentTaxItem, GstSupply, SupplyArgs, TaxArgs, has_document_tax_hook, is_gst_entity,
    resolve_gst_supply,
};
use weldsuite_catalogs::entity_events::{INVOICE_CREATED, INVOICE_DELETED, INVOICE_UPDATED};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use super::{fields_of, js_date, total_or_zero};
use crate::body::{InvoiceInput, LineInput, read_invoice};
use crate::errors::SalesError;
use crate::finalize::{load_invoice, load_items};
use crate::persist::{
    Drafted, calculate_draft_tax, engine_unavailable_warning, invoice_document_context,
    invoice_item_to_tax_item, invoice_kind, invoice_tax_columns, item_tax_columns,
    merge_sync_warning, text,
};
use crate::templates::template_belongs_to_entity;

/// The runtime the sales tax engines get (`salesTaxRuntimeFromEnv(c.env)`).
pub(crate) fn runtime(caller: &Caller, state: &BooksState) -> Runtime {
    Runtime {
        keyring: caller.keyring(state),
        http: caller.http(state),
    }
}

fn or_null(value: Option<&String>) -> Value {
    value
        .filter(|v| !v.is_empty())
        .map_or(Value::Null, |v| json!(v))
}

/// `field ?? null` of a nullish body field.
fn field_value(field: &Field<Value>) -> Value {
    match field {
        Field::Set(value) => value.clone(),
        _ => Value::Null,
    }
}

/// A body line as the tax calculation reads it (`{ ...item, id, sortOrder }`).
pub(crate) fn line_tax_item(item: &LineInput, id: &str, index: usize) -> DocumentTaxItem {
    DocumentTaxItem {
        quantity: Some(item.quantity.clone()),
        unit_price: item.unit_price.clone(),
        discount_percent: Some(item.discount_percent.clone()),
        tax_rate: item.tax_rate.clone(),
        tax_rate_id: item.tax_rate_id.clone(),
        id: Some(id.to_owned()),
        description: Some(item.description.clone()),
        #[allow(clippy::cast_precision_loss)]
        sort_order: Some(item.sort_order.unwrap_or(index as f64)),
        product_id: item.product_id.clone(),
        tax_code: item.tax_code.clone(),
        tax_use: item.tax_use.clone(),
        tax_included: item.tax_included,
        tax_override_amount: item.tax_override_amount.clone(),
        tax_override_reason: item.tax_override_reason.clone(),
        accrue_use_tax: None,
        original_line_id: item.original_line_id.clone(),
        ncm: item.ncm.clone(),
        cfop: item.cfop.clone(),
        fiscal_data: item.fiscal_data.clone(),
    }
}

/// `buildItemRecords(entityId, invoiceId, itemIds, items, calc)`.
pub(crate) fn item_records(
    entity_id: &str,
    invoice_id: &str,
    ids: &[String],
    items: &[LineInput],
    calc: &weldsuite_books_domain::tax::CalculatedDocumentTax,
) -> Vec<Value> {
    let at = now();
    items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let mut row = Map::new();
            row.insert("id".into(), json!(ids[idx]));
            row.insert("entityId".into(), json!(entity_id));
            row.insert("invoiceId".into(), json!(invoice_id));
            row.insert("description".into(), json!(item.description));
            row.insert(
                "quantity".into(),
                json!(if item.quantity.is_empty() {
                    "1"
                } else {
                    item.quantity.as_str()
                }),
            );
            row.insert("unitPrice".into(), json!(item.unit_price));
            row.insert("unit".into(), or_null(item.unit.as_ref()));
            row.insert(
                "discountPercent".into(),
                json!(if item.discount_percent.is_empty() {
                    "0"
                } else {
                    item.discount_percent.as_str()
                }),
            );
            row.extend(item_tax_columns(calc, idx));
            row.insert("accountId".into(), or_null(item.account_id.as_ref()));
            row.insert("productId".into(), or_null(item.product_id.as_ref()));
            row.insert("period".into(), item.period.clone().unwrap_or(Value::Null));
            #[allow(clippy::cast_precision_loss)]
            row.insert(
                "sortOrder".into(),
                js::number_value(item.sort_order.unwrap_or(idx as f64)),
            );
            row.insert("taxCode".into(), or_null(item.tax_code.as_ref()));
            row.insert("hsnSac".into(), or_null(item.hsn_sac.as_ref()));
            row.insert("ncm".into(), or_null(item.ncm.as_ref()));
            row.insert("cfop".into(), or_null(item.cfop.as_ref()));
            row.insert(
                "fiscalData".into(),
                item.fiscal_data.clone().unwrap_or(Value::Null),
            );
            row.insert("taxUse".into(), or_null(item.tax_use.as_ref()));
            row.insert(
                "taxIncluded".into(),
                json!(item.tax_included.unwrap_or(false)),
            );
            row.insert("taxOverrideAmount".into(), json!(item.tax_override_amount));
            row.insert("taxOverrideReason".into(), json!(item.tax_override_reason));
            row.insert("classId".into(), or_null(item.class_id.as_ref()));
            row.insert("locationId".into(), or_null(item.location_id.as_ref()));
            row.insert("createdAt".into(), json!(at));
            row.insert("updatedAt".into(), json!(at));
            Value::Object(row)
        })
        .collect()
}

/// `taxAddress(shipping, billing)`: the country and state of the address
/// that decides place of supply.
pub(crate) fn tax_address(
    shipping: Option<&Value>,
    billing: Option<&Value>,
) -> (Option<String>, Option<String>) {
    let address = normalize_postal_address(shipping).or_else(|| normalize_postal_address(billing));
    let field = |key: &str| {
        address
            .as_ref()
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    (field("country"), field("state"))
}

/// The dimension pairs of body lines.
pub(crate) fn dimensions(items: &[LineInput]) -> Vec<(Option<String>, Option<String>)> {
    items
        .iter()
        .map(|i| (i.class_id.clone(), i.location_id.clone()))
        .collect()
}

/// `new Date(text).getTime()` for an exchange-rate lookup, or the 500 a
/// foreign document's invalid date throws there.
fn rate_millis(text: &str, base: &str, currency: &str) -> Result<i64, Refusal> {
    match js::js_date_millis(text) {
        Some(millis) => Ok(millis),
        None if is_foreign_currency(base, Some(currency)) => {
            Err(Refusal::Internal("Invalid time value".to_owned()))
        }
        None => Ok(0),
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_invoice(issues, b, false)) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to create invoice"),
    };
    reply(
        create_invoice(&caller, &state, input)
            .await
            .map_err(Refusal::from),
        "Failed to create invoice",
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "the route's steps in its order: numbering, rate, tax, rows, audit, event"
)]
async fn create_invoice(
    caller: &Caller,
    state: &BooksState,
    data: InvoiceInput,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.").into());
    };
    if let Field::Set(template_id) = &data.template_id
        && !template_id.is_empty()
        && !template_belongs_to_entity(db, template_id, &entity_id).await?
    {
        return Err(
            Refusal::bad_request("Invoice template not found for this accounting entity").into(),
        );
    }
    let invoice_number = next_entity_number(db, &entity_id, SequenceType::Invoice)
        .await?
        .formatted;
    let base_currency = resolve_entity_base_currency(db, &entity_id).await?;
    let currency = data
        .currency
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| base_currency.clone());
    let issue_text = data.issue_date.clone().unwrap_or_default();
    let typed = match &data.exchange_rate {
        Field::Set(rate) => Some(json!(rate)),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    };
    let http = caller.http(state);
    let exchange_rate = draft_rate(
        db,
        http.as_ref(),
        RateQuery {
            base_currency: &base_currency,
            currency: &currency,
            at_millis: rate_millis(&issue_text, &base_currency, &currency)?,
            typed: typed.as_ref(),
            use_feed: true,
        },
    )
    .await?;

    let billing = normalize_postal_address(data.billing_address.as_set());
    let shipping = normalize_postal_address(data.shipping_address.as_set());
    let ship_from = normalize_postal_address(data.ship_from_address.as_set());
    let items = data.items.clone().unwrap_or_default();
    assert_dimensions_belong_to_entity(db, &entity_id, &dimensions(&items)).await?;

    let invoice_id = generate_id("inv");
    let item_ids: Vec<String> = items.iter().map(|_| generate_id("ili")).collect();
    let contact_id = data.contact_id.clone().unwrap_or_default();
    let gst = resolve_gst_supply(
        db,
        SupplyArgs {
            entity_id: &entity_id,
            contact_id: Some(&contact_id),
            place_of_supply: data.place_of_supply.as_set().map(String::as_str),
            shipping_address: shipping.as_ref(),
            billing_address: billing.as_ref(),
        },
    )
    .await?;
    let tax_items: Vec<DocumentTaxItem> = items
        .iter()
        .enumerate()
        .map(|(idx, item)| line_tax_item(item, &item_ids[idx], idx))
        .collect();
    let issue_iso = js::js_date(&issue_text);
    let doc = DocumentContext {
        kind: invoice_kind(data.kind.as_deref()),
        document_id: Some(invoice_id.clone()),
        document_number: Some(invoice_number.clone()),
        contact_id: Some(contact_id.clone()),
        issue_date: IssueDate::Instant(issue_iso.clone().unwrap_or_default()),
        currency: Some(currency.clone()),
        billing_address: billing.clone(),
        shipping_address: shipping.clone(),
        delivery_address: None,
        ship_from_address: ship_from.clone(),
        marketplace_facilitated: data.marketplace_facilitated,
        fiscal_data: data.fiscal_data.as_set().cloned(),
        original_invoice_id: data.credit_note_for_invoice_id.clone(),
    };
    let (country, province) = tax_address(shipping.as_ref(), billing.as_ref());
    let rt = runtime(caller, state);
    let mut args = TaxArgs::new(
        &entity_id,
        weldsuite_books_domain::tax::Direction::Sales,
        &tax_items,
    );
    args.buyer_country = country.as_deref();
    args.billing_province = province.as_deref();
    let args = args.with_gst(gst.as_ref());
    let drafted = calculate_draft_tax(
        db,
        &TaxArgs {
            document: Some(&doc),
            runtime: Some(&rt),
            ..args
        },
    )
    .await?;
    let totals = &drafted.calc;
    let status = data.status.clone().unwrap_or_else(|| "draft".to_owned());
    let contact = document_contact_fields(
        db,
        Some(&contact_id),
        data.contact_name.as_deref(),
        data.contact_email.as_deref(),
    )
    .await?;
    let issue_iso = js_date(&issue_text)?;
    let due_iso = js_date(data.due_date.as_deref().unwrap_or_default())?;
    let at = now();
    let mut invoice = Map::new();
    invoice.insert("id".into(), json!(invoice_id));
    invoice.insert("entityId".into(), json!(entity_id));
    invoice.insert("invoiceNumber".into(), json!(invoice_number));
    invoice.insert(
        "type".into(),
        json!(data.kind.as_deref().unwrap_or("standard")),
    );
    invoice.insert("status".into(), json!(status));
    invoice.insert("contactId".into(), json!(contact_id));
    invoice.insert("contactName".into(), json!(contact.name));
    invoice.insert("contactEmail".into(), json!(contact.email));
    invoice.insert("issueDate".into(), json!(issue_iso));
    invoice.insert("dueDate".into(), json!(due_iso));
    invoice.insert("currency".into(), json!(currency));
    invoice.insert("exchangeRate".into(), json!(exchange_rate));
    invoice.extend(invoice_tax_columns(totals));
    if let Some(message) = &drafted.failure {
        invoice.insert(
            "taxWarnings".into(),
            json!([engine_unavailable_warning(message)]),
        );
    }
    invoice.insert("amountPaid".into(), json!("0"));
    invoice.insert("balanceDue".into(), json!(totals.balance_due));
    invoice.insert(
        "paymentTermsDays".into(),
        data.payment_terms_days
            .filter(|d| *d != 0.0 && !d.is_nan())
            .map_or(Value::Null, js::number_value),
    );
    invoice.insert("reference".into(), or_null(data.reference.as_ref()));
    invoice.insert("notes".into(), or_null(data.notes.as_ref()));
    invoice.insert(
        "internalNotes".into(),
        or_null(data.internal_notes.as_ref()),
    );
    invoice.insert("billingAddress".into(), json!(billing));
    invoice.insert("shippingAddress".into(), json!(shipping));
    invoice.insert("shipFromAddress".into(), json!(ship_from));
    invoice.insert(
        "placeOfSupply".into(),
        json!(gst.as_ref().and_then(|g| g.place_of_supply.clone())),
    );
    invoice.insert("fiscalData".into(), field_value(&data.fiscal_data));
    invoice.insert(
        "marketplaceFacilitated".into(),
        json!(data.marketplace_facilitated.unwrap_or(false)),
    );
    invoice.insert(
        "revenueAccountId".into(),
        or_null(data.revenue_account_id.as_ref()),
    );
    invoice.insert("templateId".into(), or_null(data.template_id.as_set()));
    invoice.insert(
        "creditNoteForInvoiceId".into(),
        or_null(data.credit_note_for_invoice_id.as_ref()),
    );
    invoice.insert("createdBy".into(), json!(caller.user_id));
    invoice.insert("createdAt".into(), json!(at));
    invoice.insert("updatedAt".into(), json!(at));

    let records = item_records(&entity_id, &invoice_id, &item_ids, &items, totals);
    let mut tx = db.begin().await?;
    INVOICES
        .insert_raw(&mut *tx, INVOICES.values(&invoice))
        .await?;
    for record in &records {
        INVOICE_ITEMS
            .insert_raw(&mut *tx, INVOICE_ITEMS.values(&fields_of(record)))
            .await?;
    }
    tx.commit().await?;

    promote_accounting_role(db, &contact_id, PromoteTo::Customer).await?;
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "invoice",
            entity_id: &invoice_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_CREATED,
        &invoice_id,
        json!({
            "id": invoice_id,
            "invoiceNumber": invoice_number,
            "status": status,
            "total": totals.total,
            "currency": currency,
            "contactId": contact_id,
            "issueDate": invoice["issueDate"],
            "dueDate": invoice["dueDate"],
        }),
    );
    invoice.insert("items".into(), Value::Array(records));
    Ok(created(Value::Object(invoice)))
}

// ── PUT / PATCH /:id ────────────────────────────────────────────────────────

pub(crate) async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_invoice(issues, b, true)) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to update invoice"),
    };
    reply(
        update_invoice(&caller, &state, &id, input, &body)
            .await
            .map_err(Refusal::from),
        "Failed to update invoice",
    )
}

/// The body fields that were sent (`data[field] !== undefined`).
fn sent(body: &Bytes) -> Map<String, Value> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// `buildInvoiceFieldUpdates(data)` (+ `applyAddressUpdates`).
fn field_updates(data: &InvoiceInput) -> Result<Map<String, Value>, Refusal> {
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    if let Some(contact) = data.contact_id.as_ref().filter(|c| !c.is_empty()) {
        update.insert("contactId".into(), json!(contact));
    }
    if let Some(name) = &data.contact_name {
        update.insert("contactName".into(), json!(name));
    }
    if let Some(email) = &data.contact_email {
        update.insert("contactEmail".into(), json!(email));
    }
    if let Some(date) = data.issue_date.as_ref().filter(|d| !d.is_empty()) {
        update.insert("issueDate".into(), json!(js_date(date)?));
    }
    if let Some(date) = data.due_date.as_ref().filter(|d| !d.is_empty()) {
        update.insert("dueDate".into(), json!(js_date(date)?));
    }
    if let Some(currency) = data.currency.as_ref().filter(|c| !c.is_empty()) {
        update.insert("currency".into(), json!(currency));
    }
    if let Some(days) = data.payment_terms_days {
        update.insert("paymentTermsDays".into(), js::number_value(days));
    }
    if let Some(reference) = &data.reference {
        update.insert("reference".into(), json!(reference));
    }
    if let Some(notes) = &data.notes {
        update.insert("notes".into(), json!(notes));
    }
    if let Some(notes) = &data.internal_notes {
        update.insert("internalNotes".into(), json!(notes));
    }
    for (key, field) in [
        ("billingAddress", &data.billing_address),
        ("shippingAddress", &data.shipping_address),
        ("shipFromAddress", &data.ship_from_address),
    ] {
        if !field.is_absent() {
            update.insert(key.into(), json!(normalize_postal_address(field.as_set())));
        }
    }
    if let Some(flag) = data.marketplace_facilitated {
        update.insert("marketplaceFacilitated".into(), json!(flag));
    }
    if let Some(account) = &data.revenue_account_id {
        update.insert("revenueAccountId".into(), json!(account));
    }
    if !data.template_id.is_absent() {
        update.insert("templateId".into(), json!(data.template_id.as_set()));
    }
    if !data.fiscal_data.is_absent() {
        update.insert("fiscalData".into(), field_value(&data.fiscal_data));
    }
    Ok(update)
}

/// The invoice fields a US draft's tax depends on besides its lines.
const TAX_INPUT_FIELDS: [&str; 7] = [
    "contactId",
    "issueDate",
    "currency",
    "billingAddress",
    "shippingAddress",
    "shipFromAddress",
    "marketplaceFacilitated",
];

/// The fields an Indian (or Brazilian) draft's tax depends on besides its lines.
const GST_INPUT_FIELDS: [&str; 6] = [
    "contactId",
    "billingAddress",
    "shippingAddress",
    "placeOfSupply",
    "issueDate",
    "fiscalData",
];

/// `data[field] !== undefined` for the fields Zod kept.
fn given(data: &InvoiceInput, sent: &Map<String, Value>, field: &str) -> bool {
    match field {
        "billingAddress" => !data.billing_address.is_absent(),
        "shippingAddress" => !data.shipping_address.is_absent(),
        "shipFromAddress" => !data.ship_from_address.is_absent(),
        "placeOfSupply" => !data.place_of_supply.is_absent(),
        "fiscalData" => !data.fiscal_data.is_absent(),
        other => sent.get(other).is_some(),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the route's steps in its order: checks, fields, rate, contact, re-tax, write, audit"
)]
async fn update_invoice(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: InvoiceInput,
    body: &Bytes,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let sent = sent(body);
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id).into());
    };
    if text(&invoice, "status") != Some("draft") {
        return Err(Refusal::bad_request("Only draft invoices can be edited — finalized invoices are immutable. Corrections go through a credit note (POST /:id/credit-note).").into());
    }
    let entity_id = text(&invoice, "entityId").unwrap_or_default().to_owned();
    if let Field::Set(template_id) = &data.template_id
        && !template_id.is_empty()
        && !template_belongs_to_entity(db, template_id, &entity_id).await?
    {
        return Err(
            Refusal::bad_request("Invoice template not found for this accounting entity").into(),
        );
    }

    let mut update = field_updates(&data)?;

    // applyInvoiceExchangeRate: a typed rate, another currency or issue date.
    let currency_changed = data
        .currency
        .as_ref()
        .is_some_and(|c| Some(c.as_str()) != text(&invoice, "currency"));
    let issue_changed = data.issue_date.as_ref().is_some_and(|date| {
        js::js_date_millis(date) != text(&invoice, "issueDate").and_then(js::js_date_millis)
            || js::js_date_millis(date).is_none()
    });
    if !data.exchange_rate.is_absent() || currency_changed || issue_changed {
        let base = resolve_entity_base_currency(db, &entity_id).await?;
        // `Map[key]` panics on a missing key: `get` reads it as undefined.
        let currency = update
            .get("currency")
            .and_then(Value::as_str)
            .or_else(|| text(&invoice, "currency"))
            .unwrap_or(&base)
            .to_owned();
        let rate_date = update
            .get("issueDate")
            .and_then(Value::as_str)
            .or_else(|| text(&invoice, "issueDate"))
            .unwrap_or_default()
            .to_owned();
        let typed = match &data.exchange_rate {
            Field::Set(rate) => Some(json!(rate)),
            Field::Null => Some(Value::Null),
            Field::Absent => None,
        };
        let http = caller.http(state);
        let rate = draft_rate(
            db,
            http.as_ref(),
            RateQuery {
                base_currency: &base,
                currency: &currency,
                at_millis: rate_millis(&rate_date, &base, &currency)?,
                typed: typed.as_ref(),
                use_feed: true,
            },
        )
        .await?;
        update.insert("exchangeRate".into(), json!(rate));
    }

    let contact_changed = data
        .contact_id
        .as_ref()
        .is_some_and(|c| !c.is_empty() && Some(c.as_str()) != text(&invoice, "contactId"));
    // applyInvoiceContactSnapshot
    if contact_changed || !js::truthy(invoice.get("contactName")) {
        let (kept_name, kept_email) = if contact_changed {
            (None, None)
        } else {
            (
                text(&invoice, "contactName").map(str::to_owned),
                text(&invoice, "contactEmail").map(str::to_owned),
            )
        };
        let contact_id = data
            .contact_id
            .clone()
            .or_else(|| text(&invoice, "contactId").map(str::to_owned));
        let fields = document_contact_fields(
            db,
            contact_id.as_deref(),
            data.contact_name.as_deref().or(kept_name.as_deref()),
            data.contact_email.as_deref().or(kept_email.as_deref()),
        )
        .await?;
        update.insert("contactName".into(), json!(fields.name));
        update.insert("contactEmail".into(), json!(fields.email));
    }

    let sales_tax_entity = uses_sales_tax(load_sales_tax_entity(db, &entity_id).await?.as_ref());
    // India's place of supply and Brazil's document tax depend on the customer and the document.
    let gst_entity =
        is_gst_entity(db, &entity_id).await? || has_document_tax_hook(db, &entity_id).await?;
    let retax = data.items.is_some()
        || (sales_tax_entity && TAX_INPUT_FIELDS.iter().any(|f| given(&data, &sent, f)))
        || (gst_entity && GST_INPUT_FIELDS.iter().any(|f| given(&data, &sent, f)));

    let mut new_items: Option<Vec<Value>> = None;
    let mut stored_item_tax: Vec<(String, Map<String, Value>)> = Vec::new();
    if retax {
        let (items, stored) = retax_draft(
            caller,
            state,
            &invoice,
            &data,
            &mut update,
            contact_changed,
            gst_entity,
        )
        .await?;
        new_items = items;
        stored_item_tax = stored;
    }

    // Replace the lines and update the header together.
    let replaced_at = now();
    let mut tx = db.begin().await?;
    if let Some(items) = &new_items {
        sqlx::query(
            "update invoice_items set deleted_at = $1::timestamp \
             where invoice_id = $2 and deleted_at is null",
        )
        .bind(&replaced_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        for item in items {
            INVOICE_ITEMS
                .insert_raw(&mut *tx, INVOICE_ITEMS.values(&fields_of(item)))
                .await?;
        }
    }
    for (item_id, columns) in &stored_item_tax {
        let mut line = columns.clone();
        line.insert("updatedAt".into(), json!(replaced_at));
        INVOICE_ITEMS
            .patch_raw(&mut *tx, item_id, INVOICE_ITEMS.values(&line), false)
            .await?;
    }
    INVOICES
        .patch_raw(&mut *tx, id, INVOICES.values(&update), false)
        .await?;
    tx.commit().await?;

    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "invoice",
            entity_id: id,
            action: "updated",
            changes: None,
        },
    )
    .await;
    let total = update
        .get("total")
        .cloned()
        .unwrap_or_else(|| match invoice.get("total") {
            Some(Value::Null) | None => json!("0"),
            Some(total) => total.clone(),
        });
    caller.publish(
        state,
        INVOICE_UPDATED,
        id,
        json!({
            "id": id,
            "invoiceNumber": invoice["invoiceNumber"],
            "status": invoice["status"],
            "total": total,
            "currency": update.get("currency").cloned().unwrap_or_else(|| invoice["currency"].clone()),
            "contactId": update.get("contactId").cloned().unwrap_or_else(|| invoice["contactId"].clone()),
        }),
    );
    let mut out = fields_of(&invoice);
    out.extend(update);
    if let Some(items) = new_items {
        out.insert("items".into(), Value::Array(items));
    }
    Ok(ok(Value::Object(out)))
}

/// `retaxInvoiceDraft(...)`: the new lines (or the stored lines' new tax
/// columns); the header columns land in `update`.
#[allow(
    clippy::too_many_lines,
    reason = "retaxInvoiceDraft with the lines it loads, as written"
)]
async fn retax_draft(
    caller: &Caller,
    state: &BooksState,
    invoice: &Value,
    data: &InvoiceInput,
    update: &mut Map<String, Value>,
    contact_changed: bool,
    gst_entity: bool,
) -> Result<(Option<Vec<Value>>, Vec<(String, Map<String, Value>)>), SalesError> {
    let db = &caller.db;
    let id = text(invoice, "id").unwrap_or_default().to_owned();
    let entity_id = text(invoice, "entityId").unwrap_or_default().to_owned();
    let mut effective = fields_of(invoice);
    effective.extend(update.clone());
    let effective = Value::Object(effective);

    // loadDraftTaxLines
    let stored = if data.items.is_some() {
        Vec::new()
    } else {
        load_items(db, &id, true).await?
    };
    let (item_ids, tax_items): (Vec<String>, Vec<DocumentTaxItem>) = match &data.items {
        Some(items) => {
            let ids: Vec<String> = items.iter().map(|_| generate_id("ili")).collect();
            let tax = items
                .iter()
                .enumerate()
                .map(|(idx, item)| line_tax_item(item, &ids[idx], idx))
                .collect();
            (ids, tax)
        }
        None => (
            stored
                .iter()
                .map(|i| text(i, "id").unwrap_or_default().to_owned())
                .collect(),
            stored.iter().map(invoice_item_to_tax_item).collect(),
        ),
    };
    if let Some(items) = &data.items {
        assert_dimensions_belong_to_entity(db, &entity_id, &dimensions(items)).await?;
    }

    let place = match &data.place_of_supply {
        Field::Set(place) => Some(place.clone()),
        Field::Null => None,
        Field::Absent if contact_changed => None,
        Field::Absent => text(invoice, "placeOfSupply").map(str::to_owned),
    };
    let shipping = effective.get("shippingAddress").filter(|v| !v.is_null());
    let billing = effective.get("billingAddress").filter(|v| !v.is_null());
    let gst: Option<GstSupply> = if gst_entity {
        resolve_gst_supply(
            db,
            SupplyArgs {
                entity_id: &entity_id,
                contact_id: text(&effective, "contactId"),
                place_of_supply: place.as_deref(),
                shipping_address: shipping,
                billing_address: billing,
            },
        )
        .await?
    } else {
        None
    };
    if let Some(gst) = &gst {
        update.insert("placeOfSupply".into(), json!(gst.place_of_supply));
    }
    let (country, province) = tax_address(shipping, billing);
    let doc = invoice_document_context(&effective);
    let rt = runtime(caller, state);
    let mut args = TaxArgs::new(
        &entity_id,
        weldsuite_books_domain::tax::Direction::Sales,
        &tax_items,
    );
    args.buyer_country = country.as_deref();
    args.billing_province = province.as_deref();
    let args = args.with_gst(gst.as_ref());
    let drafted: Drafted = calculate_draft_tax(
        db,
        &TaxArgs {
            document: Some(&doc),
            runtime: Some(&rt),
            ..args
        },
    )
    .await?;

    let mut new_items = None;
    let mut stored_tax = Vec::new();
    if drafted.ok() || data.items.is_some() {
        // With new lines a failed calculation leaves them untaxed and flagged.
        update.extend(invoice_tax_columns(&drafted.calc));
        if let Some(message) = &drafted.failure {
            update.insert("taxEngine".into(), Value::Null);
            update.insert("taxEngineRef".into(), Value::Null);
            update.insert("taxCalculatedAt".into(), Value::Null);
            update.insert(
                "taxWarnings".into(),
                json!([engine_unavailable_warning(message)]),
            );
        }
        let paid = js::parse_float(
            text(invoice, "amountPaid")
                .filter(|p| !p.is_empty())
                .unwrap_or("0"),
        );
        update.insert(
            "balanceDue".into(),
            json!(js::number_text(js::parse_float(&drafted.calc.total) - paid)),
        );
        if let Some(items) = &data.items {
            new_items = Some(item_records(
                &entity_id,
                &id,
                &item_ids,
                items,
                &drafted.calc,
            ));
        } else {
            for (idx, item) in stored.iter().enumerate() {
                stored_tax.push((
                    text(item, "id").unwrap_or_default().to_owned(),
                    item_tax_columns(&drafted.calc, idx),
                ));
            }
        }
    } else if let Some(message) = &drafted.failure {
        // Unchanged lines keep their last calculation.
        update.insert(
            "taxWarnings".into(),
            Value::Array(merge_sync_warning(
                invoice.get("taxWarnings"),
                Some(engine_unavailable_warning(message)),
            )),
        );
    }
    Ok((new_items, stored_tax))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        delete_invoice(&caller, &state, &id).await,
        "Failed to delete invoice",
    )
}

async fn delete_invoice(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    if text(&invoice, "status") != Some("draft") {
        return Err(Refusal::bad_request(
            "Only draft invoices can be deleted — finalized invoices are immutable. Corrections go through a credit note (POST /:id/credit-note).",
        ));
    }
    let at = now();
    sqlx::query(
        "update invoices set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
    )
    .bind(&at)
    .bind(id)
    .execute(db)
    .await?;
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&invoice, "entityId"),
            entity_type: "invoice",
            entity_id: id,
            action: "deleted",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_DELETED,
        id,
        json!({
            "id": id,
            "invoiceNumber": invoice["invoiceNumber"],
            "status": invoice["status"],
            "total": total_or_zero(&invoice),
        }),
    );
    Ok(ok(json!({ "message": "Invoice deleted" })))
}
