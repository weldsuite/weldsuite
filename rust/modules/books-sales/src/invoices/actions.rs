//! The invoice lifecycle routes: send, cancel / write off, finalize, the
//! provider tax sync, duplicate, credit note, recording a payment (or a
//! refund) and applying a credit note.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bad_debt::write_off_invoice;
use weldsuite_books_domain::contacts::document_contact_fields;
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency,
};
use weldsuite_books_domain::fx::{RateQuery, draft_rate};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, now, now_ms, ok, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::payments::{AllocationInput, RecordPaymentInput, record_payment};
use weldsuite_books_domain::sales_tax::document_tax::{load_sales_tax_entity, uses_sales_tax};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES};
use weldsuite_books_domain::tax::{TaxArgs, calculate_document_tax};
use weldsuite_catalogs::entity_events::{
    INVOICE_CREATED, INVOICE_UPDATED, JOURNAL_ENTRY_CREATED, PAYMENT_CREATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Presence;

use super::{event_data, fields_of, js_date, total_or_zero};
use crate::body::read_record_payment;
use crate::credit_notes::{CreditApplication, apply_credit_note};
use crate::errors::SalesError;
use crate::finalize::{FinalizeOptions, finalize_invoice, load_invoice, load_items};
use crate::invoices::write::runtime;
use crate::persist::{
    invoice_document_context, invoice_item_to_tax_item, invoice_tax_columns, item_tax_columns,
    owned, text,
};
use crate::provider_sync::sync_invoice_with_provider;

/// `computeChanges(old, new)` (`updatedAt` ignored): the keys whose JSON
/// differs.
fn compute_changes(old: &Value, new: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut changes = Map::new();
    for (key, value) in new {
        if key == "updatedAt" {
            continue;
        }
        let before = old.get(key).cloned().unwrap_or(Value::Null);
        if before != *value {
            changes.insert(key.clone(), change(before, value.clone()));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

/// `auditCreditApplication(c, db, entityId, applied)`: both sides.
pub(crate) async fn audit_credit_application(
    caller: &Caller,
    entity_id: Option<&str>,
    applied: &CreditApplication,
) {
    for (document, other) in [
        (&applied.credit_note_id, &applied.invoice_id),
        (&applied.invoice_id, &applied.credit_note_id),
    ] {
        let mut changes = Map::new();
        changes.insert(
            "creditApplied".into(),
            change(
                Value::Null,
                json!({ "amount": js::to_fixed(applied.amount, 2), "with": other }),
            ),
        );
        write_accounting_audit(
            caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: entity_id,
                entity_type: "invoice",
                entity_id: document,
                action: "credit_applied",
                changes: Some(changes),
            },
        )
        .await;
    }
}

fn finalize_options<'a>(
    caller: &Caller,
    rt: &'a weldsuite_books_domain::sales_tax::document_tax::Runtime,
    mark_sent: bool,
) -> FinalizeOptions<'a> {
    FinalizeOptions {
        user_id: caller.user().map(str::to_owned),
        mark_sent,
        runtime: rt,
        http: rt.http.as_ref(),
    }
}

// ── PATCH /:id/send ─────────────────────────────────────────────────────────

pub(crate) async fn send(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        send_invoice(&caller, &state, &id)
            .await
            .map_err(Refusal::from),
        "Failed to send invoice",
    )
}

async fn send_invoice(
    caller: &Caller,
    state: &BooksState,
    id: &str,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id).into());
    };
    let current = text(&invoice, "status").unwrap_or_default().to_owned();
    if current == "cancelled" {
        return Err(Refusal::bad_request("A cancelled invoice cannot be sent").into());
    }
    let at = now();
    let mut journal_entry_id = invoice["journalEntryId"].clone();
    if current == "draft" {
        let rt = runtime(caller, state);
        let finalized = finalize_invoice(db, id, finalize_options(caller, &rt, true)).await?;
        journal_entry_id = json!(finalized.journal_entry_id);
    } else {
        sqlx::query(
            "update invoices set sent_at = $1::timestamp, \
             status = case when $2 then 'sent' else status end, updated_at = $1::timestamp where id = $3",
        )
        .bind(&at)
        .bind(current == "finalized")
        .bind(id)
        .execute(db)
        .await?;
    }
    let status = if current == "draft" || current == "finalized" {
        "sent".to_owned()
    } else {
        current.clone()
    };
    let mut changes = Map::new();
    changes.insert("status".into(), change(json!(current), json!(status)));
    if journal_entry_id != invoice["journalEntryId"] {
        changes.insert(
            "journalEntryId".into(),
            change(Value::Null, journal_entry_id.clone()),
        );
    }
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&invoice, "entityId"),
            entity_type: "invoice",
            entity_id: id,
            action: "sent",
            changes: Some(changes),
        },
    )
    .await;
    let mut after = Map::new();
    after.insert("status".into(), json!(status));
    after.insert("sentAt".into(), json!(at));
    let data = event_data(&invoice, &json!(status));
    match compute_changes(&invoice, &after) {
        Some(changes) => caller.publish_changes(state, INVOICE_UPDATED, id, data, changes),
        None => caller.publish(state, INVOICE_UPDATED, id, data),
    }
    let mut out = fields_of(&invoice);
    out.insert("status".into(), json!(status));
    out.insert("sentAt".into(), json!(at));
    out.insert("journalEntryId".into(), journal_entry_id);
    Ok(ok(Value::Object(out)))
}

// ── PATCH /:id/status ───────────────────────────────────────────────────────

pub(crate) async fn status(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let wanted = match validate(&headers, &body, |issues, b| {
        issues
            .choice(
                b,
                "status",
                Presence::Required,
                &["cancelled", "uncollectible"],
            )
            .into_option()
    }) {
        Ok(Some(status)) => status,
        Ok(None) => {
            return Refusal::Internal("status".into()).respond("Failed to update invoice status");
        }
        Err(refusal) => return refusal.respond("Failed to update invoice status"),
    };
    reply(
        change_status(&caller, &state, &id, &wanted)
            .await
            .map_err(Refusal::from),
        "Failed to update invoice status",
    )
}

/// `statusChangeRefusal(invoice, newStatus)`.
fn status_refusal(invoice: &Value, wanted: &str) -> Option<&'static str> {
    let booked = js::truthy(invoice.get("journalEntryId"));
    if wanted == "cancelled" {
        return booked.then_some("This invoice is booked and cannot be cancelled. Create a credit note (POST /:id/credit-note) to correct it.");
    }
    if text(invoice, "type") == Some("credit_note") {
        return Some(
            "A credit note is money owed to the customer, not by them: apply it to an invoice or refund it instead of writing it off.",
        );
    }
    if !booked {
        return Some("Only a finalized invoice can be written off as uncollectible");
    }
    if js::parse_float(text(invoice, "balanceDue").unwrap_or("0")) <= 0.0
        || js::parse_float(text(invoice, "balanceDue").unwrap_or("0")).is_nan()
    {
        return Some("This invoice has no open balance to write off");
    }
    None
}

async fn change_status(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    wanted: &str,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id).into());
    };
    if text(&invoice, "status") == Some(wanted) {
        return Ok(ok(invoice));
    }
    if let Some(refusal) = status_refusal(&invoice, wanted) {
        return Err(Refusal::bad_request(refusal).into());
    }
    let mut journal_entry_id: Option<String> = None;
    let mut vat_relief = 0.0;
    if wanted == "cancelled" {
        sqlx::query(
            "update invoices set status = 'cancelled', updated_at = $1::timestamp where id = $2",
        )
        .bind(now())
        .bind(id)
        .execute(db)
        .await?;
    } else {
        let (posted, relief) =
            write_off_invoice(db, &invoice, caller.user().map(str::to_owned), None).await?;
        journal_entry_id = posted.journal_entry_id;
        vat_relief = relief;
    }
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(invoice["status"].clone(), json!(wanted)),
    );
    if let Some(entry) = &journal_entry_id {
        changes.insert("writeOffEntryId".into(), change(Value::Null, json!(entry)));
    }
    if vat_relief > 0.0 {
        changes.insert(
            "vatRelief".into(),
            change(Value::Null, js::number_value(vat_relief)),
        );
    }
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&invoice, "entityId"),
            entity_type: "invoice",
            entity_id: id,
            action: if wanted == "uncollectible" {
                "written_off"
            } else {
                "updated"
            },
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_UPDATED,
        id,
        event_data(&invoice, &json!(wanted)),
    );
    let mut out = fields_of(&invoice);
    out.insert("status".into(), json!(wanted));
    if wanted == "uncollectible" {
        out.insert("balanceDue".into(), json!("0.00"));
        out.insert("writeOffEntryId".into(), json!(journal_entry_id));
        out.insert("vatRelief".into(), js::number_value(vat_relief));
    }
    Ok(ok(Value::Object(out)))
}

// ── POST /:id/finalize ──────────────────────────────────────────────────────

pub(crate) async fn finalize(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        finalize_route(&caller, &state, &id)
            .await
            .map_err(Refusal::from),
        "Failed to finalize invoice",
    )
}

async fn finalize_route(
    caller: &Caller,
    state: &BooksState,
    id: &str,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id).into());
    };
    if text(&invoice, "status") != Some("draft") {
        return Err(Refusal::bad_request("Can only finalize draft invoices").into());
    }
    let rt = runtime(caller, state);
    let result = finalize_invoice(db, id, finalize_options(caller, &rt, false)).await?;
    for warning in &result.warnings {
        tracing::warn!("[books-api/invoices] finalize warning for {id}: {warning}");
    }
    let mut changes = Map::new();
    changes.insert("status".into(), change(json!("draft"), json!("finalized")));
    changes.insert(
        "journalEntryId".into(),
        change(Value::Null, json!(result.journal_entry_id)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&invoice, "entityId"),
            entity_type: "invoice",
            entity_id: id,
            action: "finalized",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_UPDATED,
        id,
        event_data(&invoice, &json!("finalized")),
    );
    if let Some(entry) = result
        .journal_entry_id
        .as_deref()
        .filter(|_| !result.already_posted)
    {
        caller.publish(
            state,
            JOURNAL_ENTRY_CREATED,
            entry,
            json!({
                "id": entry,
                "sourceType": if text(&invoice, "type") == Some("credit_note") { "credit_note" } else { "invoice" },
                "sourceId": id,
            }),
        );
    }
    if let Some(applied) = &result.credit_applied {
        audit_credit_application(caller, text(&invoice, "entityId"), applied).await;
    }
    Ok(ok(json!({
        "invoiceId": id,
        "journalEntryId": result.journal_entry_id,
        "entryNumber": result.entry_number,
        "creditApplied": result.credit_applied.as_ref().map(CreditApplication::to_json),
        "status": "finalized",
        "warnings": result.warnings,
        "taxSync": result.tax_sync.as_ref().map(crate::provider_sync::ProviderSync::to_json),
    })))
}

// ── POST /:id/commit-tax ────────────────────────────────────────────────────

pub(crate) async fn commit_tax(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let Some(invoice) = load_invoice(db, &id).await? else {
                return Err(SalesError::from(Refusal::not_found("Invoice", &id)));
            };
            let rt = runtime(&caller, &state);
            let result = sync_invoice_with_provider(db, &id, &rt).await?;
            let mut changes = Map::new();
            changes.insert("status".into(), change(Value::Null, json!(result.status)));
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: text(&invoice, "entityId"),
                    entity_type: "invoice",
                    entity_id: &id,
                    action: "tax_synced",
                    changes: Some(changes),
                },
            )
            .await;
            caller.publish(
                &state,
                INVOICE_UPDATED,
                &id,
                event_data(&invoice, &invoice["status"]),
            );
            Ok(ok(result.to_json()))
        }
        .await
        .map_err(Refusal::from),
        "Failed to record the invoice with the tax provider",
    )
}

// ── POST /:id/duplicate ─────────────────────────────────────────────────────

pub(crate) async fn duplicate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        duplicate_invoice(&caller, &state, &id).await,
        "Failed to duplicate invoice",
    )
}

/// A copy of each line under a new id; the old id → new id pairs.
fn copied_items(
    items: &[Value],
    invoice_id: &str,
    at: &str,
) -> (Vec<Value>, Vec<(String, String)>) {
    let mut ids = Vec::new();
    let copies = items
        .iter()
        .map(|item| {
            let mut copy = fields_of(item);
            let new_id = generate_id("ili");
            ids.push((
                text(item, "id").unwrap_or_default().to_owned(),
                new_id.clone(),
            ));
            copy.insert("id".into(), json!(new_id));
            copy.insert("invoiceId".into(), json!(invoice_id));
            copy.insert("createdAt".into(), json!(at));
            copy.insert("updatedAt".into(), json!(at));
            Value::Object(copy)
        })
        .collect();
    (copies, ids)
}

async fn insert_document(
    db: &weldsuite_db::PgPool,
    row: &Map<String, Value>,
    items: &[Value],
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    INVOICES.insert_raw(&mut *tx, INVOICES.values(row)).await?;
    for item in items {
        INVOICE_ITEMS
            .insert_raw(&mut *tx, INVOICE_ITEMS.values(&fields_of(item)))
            .await?;
    }
    tx.commit().await
}

async fn duplicate_invoice(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    let items = load_items(db, id, false).await?;
    let new_id = generate_id("inv");
    let at = now();
    let at_ms = js::millis_of(&at).unwrap_or_else(now_ms);
    let entity_id = text(&invoice, "entityId").unwrap_or_default().to_owned();
    let credit_note = text(&invoice, "type") == Some("credit_note");
    let number = next_entity_number(
        db,
        &entity_id,
        if credit_note {
            SequenceType::CreditNote
        } else {
            SequenceType::Invoice
        },
    )
    .await?
    .formatted;
    let (copies, ids) = copied_items(&items, &new_id, &at);
    let mut row = fields_of(&invoice);
    let terms = invoice["paymentTermsDays"]
        .as_f64()
        .filter(|d| *d != 0.0)
        .unwrap_or(30.0);
    #[allow(clippy::cast_possible_truncation)]
    let due = js::iso_from_millis(at_ms + (terms * 24.0 * 60.0 * 60.0 * 1000.0) as i64)
        .unwrap_or_else(|| at.clone());
    let base = resolve_entity_base_currency(db, &entity_id).await?;
    let currency = owned(&invoice, "currency").unwrap_or_else(|| base.clone());
    let http = caller.http(state);
    let rate = draft_rate(
        db,
        http.as_ref(),
        RateQuery {
            base_currency: &base,
            currency: &currency,
            at_millis: at_ms,
            typed: None,
            use_feed: true,
        },
    )
    .await?;
    let breakdown: Vec<Value> = invoice["taxBreakdown"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut tax_row| {
            if let Some(line) = tax_row
                .get("lineId")
                .and_then(Value::as_str)
                .filter(|l| !l.is_empty())
            {
                let mapped = ids
                    .iter()
                    .find(|(old, _)| old == line)
                    .map_or_else(|| line.to_owned(), |(_, new)| new.clone());
                tax_row["lineId"] = json!(mapped);
            }
            tax_row
        })
        .collect();
    for (key, value) in [
        ("id", json!(new_id)),
        ("invoiceNumber", json!(number)),
        ("status", json!("draft")),
        ("issueDate", json!(at)),
        ("dueDate", json!(due)),
        ("paidAt", Value::Null),
        ("sentAt", Value::Null),
        ("viewedAt", Value::Null),
        ("amountPaid", json!("0")),
        ("balanceDue", invoice["total"].clone()),
        ("journalEntryId", Value::Null),
        ("exchangeRate", json!(rate)),
        ("originalInvoiceId", json!(id)),
        ("emailHistory", Value::Null),
        ("contactTaxNumber", Value::Null),
        ("taxBreakdown", Value::Array(breakdown)),
        ("taxEngineRef", Value::Null),
        ("taxCalculatedAt", Value::Null),
        ("taxCommittedAt", Value::Null),
        ("taxWarnings", Value::Null),
        ("createdBy", json!(caller.user_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ] {
        row.insert(key.into(), value);
    }
    insert_document(db, &row, &copies).await?;
    let mut changes = Map::new();
    changes.insert("originalInvoiceId".into(), change(Value::Null, json!(id)));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "invoice",
            entity_id: &new_id,
            action: "created",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_CREATED,
        &new_id,
        json!({
            "id": new_id,
            "status": "draft",
            "total": total_or_zero(&invoice),
            "currency": invoice["currency"],
            "contactId": invoice["contactId"],
        }),
    );
    Ok(created(json!({ "id": new_id, "invoiceNumber": number })))
}

// ── POST /:id/credit-note ───────────────────────────────────────────────────

pub(crate) async fn credit_note(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        create_credit_note(&caller, &state, &id)
            .await
            .map_err(Refusal::from),
        "Failed to create credit note",
    )
}

async fn create_credit_note(
    caller: &Caller,
    state: &BooksState,
    id: &str,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id).into());
    };
    if text(&invoice, "type") == Some("credit_note") {
        return Err(Refusal::bad_request("A credit note cannot itself be credited").into());
    }
    if text(&invoice, "status") == Some("draft") {
        return Err(Refusal::bad_request(
            "A draft invoice can simply be edited or deleted — no credit note needed",
        )
        .into());
    }
    let items = load_items(db, id, false).await?;
    let entity_id = text(&invoice, "entityId").unwrap_or_default().to_owned();
    let number = next_entity_number(db, &entity_id, SequenceType::CreditNote)
        .await?
        .formatted;
    let new_id = generate_id("inv");
    let at = now();
    let contact = document_contact_fields(
        db,
        text(&invoice, "contactId"),
        text(&invoice, "contactName"),
        text(&invoice, "contactEmail"),
    )
    .await?;
    let mut row = fields_of(&invoice);
    for (key, value) in [
        ("contactName", json!(contact.name)),
        ("contactEmail", json!(contact.email)),
        ("id", json!(new_id)),
        ("invoiceNumber", json!(number)),
        ("type", json!("credit_note")),
        ("status", json!("draft")),
        ("issueDate", json!(at)),
        ("dueDate", json!(at)),
        ("creditNoteForInvoiceId", json!(id)),
        ("paidAt", Value::Null),
        ("sentAt", Value::Null),
        ("viewedAt", Value::Null),
        ("amountPaid", json!("0")),
        ("balanceDue", invoice["total"].clone()),
        ("journalEntryId", Value::Null),
        ("emailHistory", Value::Null),
        ("taxEngineRef", Value::Null),
        ("taxCommittedAt", Value::Null),
        ("taxWarnings", Value::Null),
        ("createdBy", json!(caller.user_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ] {
        row.insert(key.into(), value);
    }
    let (mut copies, _) = copied_items(&items, &new_id, &at);

    // US sales tax: the memo reverses the invoice's tax line by line at its own rates.
    if js::truthy(invoice.get("taxEngine"))
        && uses_sales_tax(load_sales_tax_entity(db, &entity_id).await?.as_ref())
    {
        let tax_items: Vec<_> = copies.iter().map(invoice_item_to_tax_item).collect();
        let doc = invoice_document_context(&Value::Object(row.clone()));
        let mut args = TaxArgs::new(
            &entity_id,
            weldsuite_books_domain::tax::Direction::Sales,
            &tax_items,
        );
        args.document = Some(&doc);
        let calc = calculate_document_tax(db, &args).await?;
        row.extend(invoice_tax_columns(&calc));
        row.insert("balanceDue".into(), json!(calc.total));
        for (idx, copy) in copies.iter_mut().enumerate() {
            if let Value::Object(fields) = copy {
                fields.extend(item_tax_columns(&calc, idx));
            }
        }
    }
    insert_document(db, &row, &copies).await?;
    let mut changes = Map::new();
    changes.insert(
        "creditNoteForInvoiceId".into(),
        change(Value::Null, json!(id)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "invoice",
            entity_id: &new_id,
            action: "credit_note",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_CREATED,
        &new_id,
        json!({
            "id": new_id,
            "invoiceNumber": number,
            "status": "draft",
            "total": total_or_zero(&invoice),
            "currency": invoice["currency"],
            "contactId": invoice["contactId"],
        }),
    );
    Ok(created(json!({ "id": new_id, "invoiceNumber": number })))
}

// ── POST /:id/record-payment ────────────────────────────────────────────────

pub(crate) async fn record_payment_route(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_record_payment) {
        Ok(Some(data)) => data,
        Ok(None) => return Refusal::Internal("body".into()).respond("Failed to record payment"),
        Err(refusal) => return refusal.respond("Failed to record payment"),
    };
    reply(
        async {
            let db = &caller.db;
            let Some(invoice) = load_invoice(db, &id).await? else {
                return Err(SalesError::from(Refusal::not_found("Invoice", &id)));
            };
            let amount = js::parse_float(&data.amount);
            let refund = text(&invoice, "type") == Some("credit_note");
            let date = js_date(&data.date)?;
            let http = caller.http(&state);
            let result = record_payment(
                db,
                http.as_ref(),
                RecordPaymentInput {
                    entity_id: text(&invoice, "entityId").unwrap_or_default().to_owned(),
                    received: !refund,
                    amount,
                    currency: owned(&invoice, "currency"),
                    exchange_rate: data.exchange_rate.clone(),
                    date,
                    payment_method: data.payment_method.clone(),
                    check_number: data.check_number.clone(),
                    deposit_to: if refund { None } else { data.deposit_to.clone() },
                    reference: data.reference.clone(),
                    notes: data.notes.clone(),
                    contact_id: owned(&invoice, "contactId"),
                    bank_account_id: data.bank_account_id.clone(),
                    allocations: vec![AllocationInput {
                        invoice_id: Some(id.clone()),
                        bill_id: None,
                        amount,
                    }],
                    user_id: caller.user().map(str::to_owned),
                    ..RecordPaymentInput::default()
                },
            )
            .await?;
            let updated: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(
                "select amount_paid::text, balance_due::text, status from invoices where id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(db)
            .await?;
            let (paid, balance, status) = match updated {
                Some((paid, balance, status)) => (json!(paid), json!(balance), json!(status)),
                None => (Value::Null, Value::Null, Value::Null),
            };
            let mut changes = Map::new();
            changes.insert("amountPaid".into(), change(invoice["amountPaid"].clone(), paid.clone()));
            changes.insert("status".into(), change(invoice["status"].clone(), status.clone()));
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: text(&invoice, "entityId"),
                    entity_type: "invoice",
                    entity_id: &id,
                    action: if refund { "refund_recorded" } else { "payment_recorded" },
                    changes: Some(changes),
                },
            )
            .await;
            caller.publish(
                &state,
                PAYMENT_CREATED,
                &result.payment_id,
                json!({
                    "id": result.payment_id,
                    "invoiceId": id,
                    "amount": data.amount,
                    "date": data.date,
                    "method": data.payment_method,
                }),
            );
            Ok(created(json!({
                "paymentId": result.payment_id,
                "journalEntryId": result.journal_entry_id,
                "amountPaid": paid,
                "balanceDue": balance,
                "status": status,
            })))
        }
        .await
        .map_err(Refusal::from),
        "Failed to record payment",
    )
}

// ── POST /:id/apply-credit ──────────────────────────────────────────────────

pub(crate) async fn apply_credit(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        let invoice = issues.text(b, "invoiceId", Presence::Optional, None, Some(30));
        let amount = issues.text(b, "amount", Presence::Optional, None, None);
        (invoice.into_option(), amount.into_option())
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to apply the credit note"),
    };
    reply(
        apply_credit_route(&caller, &state, &id, data)
            .await
            .map_err(Refusal::from),
        "Failed to apply the credit note",
    )
}

async fn apply_credit_route(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    (invoice_id, amount): (Option<String>, Option<String>),
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let amount = amount.map(|a| js::parse_float(&a));
    if let Some(amount) = amount
        && !(amount > 0.0)
    {
        return Err(Refusal::bad_request("The amount must be greater than zero").into());
    }
    let Some(applied) = apply_credit_note(db, id, invoice_id.as_deref(), amount).await? else {
        return Err(Refusal::bad_request(
            "Nothing left to apply: the credit note or the invoice has no open balance",
        )
        .into());
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoices),
        " from invoices t where t.id = any($1)"
    ))
    .bind(vec![id.to_owned(), applied.invoice_id.clone()])
    .fetch_all(db)
    .await?;
    let rows = INVOICES.js_rows(rows);
    let note = rows
        .iter()
        .find(|r| r["id"] == id)
        .cloned()
        .unwrap_or(Value::Null);
    audit_credit_application(caller, text(&note, "entityId"), &applied).await;
    for doc in &rows {
        caller.publish(
            state,
            INVOICE_UPDATED,
            doc["id"].as_str().unwrap_or_default(),
            event_data(doc, &doc["status"]),
        );
    }
    let mut out = applied.to_json();
    out["amount"] = json!(js::to_fixed(applied.amount, 2));
    out["creditNote"] = json!({ "balanceDue": note["balanceDue"], "status": note["status"] });
    Ok(ok(out))
}
