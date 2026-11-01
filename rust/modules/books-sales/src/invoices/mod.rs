//! `/api/invoices` (`routes/invoices/index.ts`): entity-scoped list and
//! detail, server-side tax on create and update, gapless numbers, finalize
//! (one atomic posting), send, cancel / write off, duplicate, credit notes,
//! payments, credit application, the printable HTML and invoices from
//! commerce orders.
//!
//! Integrity rules (administratieplicht): only drafts are edited or deleted,
//! corrections go through credit notes, postings are refused in closed
//! periods and on/before lock dates, every mutation is audited.

mod actions;
mod from_order;
mod pdf;
pub(crate) mod write;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::contacts::with_contact_names;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now, ok, paged, reply};
use weldsuite_books_domain::js::{self, parse_int};
use weldsuite_books_domain::sales_tax::document_tax::{
    CreditLine, OriginalLine, map_credit_items_to_original,
};
use weldsuite_books_domain::tables::{INVOICES, PAYMENTS};
use weldsuite_books_domain::{attachments, books_row};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::finalize::{load_invoice, load_items};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("invoices:read")))
        .route(
            "/",
            post(write::create).route_layer(need("invoices:create")),
        )
        .route("/{id}", get(detail).route_layer(need("invoices:read")))
        .route(
            "/{id}",
            axum::routing::put(write::update)
                .patch(write::update)
                .route_layer(need("invoices:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(write::remove).route_layer(need("invoices:delete")),
        )
        .route(
            "/{id}/attachments/{index}",
            get(attachment).route_layer(need("invoices:read")),
        )
        .route(
            "/{id}/pdf",
            get(pdf::render).route_layer(need("invoices:read")),
        )
        .route(
            "/{id}/send",
            patch(actions::send).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/status",
            patch(actions::status).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/finalize",
            post(actions::finalize).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/commit-tax",
            post(actions::commit_tax).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/duplicate",
            post(actions::duplicate).route_layer(need("invoices:create")),
        )
        .route(
            "/{id}/credit-note",
            post(actions::credit_note).route_layer(need("invoices:create")),
        )
        .route(
            "/{id}/record-payment",
            post(actions::record_payment_route).route_layer(need("banking:create")),
        )
        .route(
            "/{id}/apply-credit",
            post(actions::apply_credit).route_layer(need("invoices:update")),
        )
        .route(
            "/from-order/{order_id}",
            post(from_order::create).route_layer(need("invoices:create")),
        )
        .with_state(state)
}

/// `publishEntityEvent` data of an invoice change.
pub(crate) fn event_data(invoice: &Value, status: &Value) -> Value {
    json!({
        "id": invoice["id"],
        "invoiceNumber": invoice["invoiceNumber"],
        "status": status,
        "total": total_or_zero(invoice),
        "currency": invoice["currency"],
        "contactId": invoice["contactId"],
    })
}

/// `invoice.total || '0'`.
pub(crate) fn total_or_zero(invoice: &Value) -> Value {
    match invoice.get("total") {
        Some(Value::String(total)) if !total.is_empty() => json!(total),
        _ => json!("0"),
    }
}

/// A `new Date(text)` the route stores or compares: `toISOString()`, or the
/// 500 Drizzle's `toISOString` throws for an invalid date.
pub(crate) fn js_date(text: &str) -> Result<String, Refusal> {
    js::js_date(text).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    reply(list_invoices(&caller).await, "Failed to fetch invoices")
}

/// `withSourceInvoiceNumbers(db, rows)`: the number of the invoice each
/// credit note credits.
async fn with_source_invoice_numbers(
    caller: &Caller,
    rows: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut source_ids: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(id) = row["creditNoteForInvoiceId"]
            .as_str()
            .filter(|id| !id.is_empty())
            && !source_ids.iter().any(|s| s == id)
        {
            source_ids.push(id.to_owned());
        }
    }
    let sources: Vec<(String, Option<String>)> = if source_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, invoice_number from invoices where id = any($1)")
            .bind(&source_ids)
            .fetch_all(&caller.db)
            .await?
    };
    let numbers: HashMap<String, Option<String>> = sources.into_iter().collect();
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let number = row["creditNoteForInvoiceId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .and_then(|id| numbers.get(id).cloned().flatten());
            if let Value::Object(fields) = &mut row {
                fields.insert("creditNoteForInvoiceNumber".into(), json!(number));
            }
            row
        })
        .collect())
}

async fn list_invoices(caller: &Caller) -> Reply {
    let q = caller.query();
    let page = parse_int(q.present("page").unwrap_or("1"));
    let page_size = parse_int(q.present("pageSize").unwrap_or("25")).map(|n| n.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let (Some(page), Some(page_size)) = (page, page_size) else {
        return Err(Refusal::Internal("page is NaN".to_owned()));
    };
    let from = q.present("from").map(js_date).transpose()?;
    let to = q.present("to").map(js_date).transpose()?;
    let overdue = q.get("overdue") == Some("true");
    let term = q.present("search").map(|s| format!("%{s}%"));
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(invoices),
        " from invoices t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.status = $2) \
         and ($3::text is null or t.type = $3) \
         and ($4::text is null or t.contact_id = $4) \
         and ($5::timestamp is null or t.issue_date >= $5::timestamp) \
         and ($6::timestamp is null or t.issue_date <= $6::timestamp) \
         and (not $7 or (t.balance_due::numeric > 0 and t.due_date <= $8::timestamp)) \
         and ($9::text is null or (t.invoice_number like $9 or t.contact_name like $9 or t.reference like $9 \
           or t.contact_id in (select p.id from parties p where p.display_name like $9))) \
         order by t.issue_date desc, t.created_at desc, t.id desc limit $10 offset $11"
    ))
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("type"))
    .bind(q.present("contactId"))
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(overdue)
    .bind(now())
    .bind(term.as_deref())
    .bind(page_size)
    .bind((page - 1) * page_size)
    .fetch_all(&caller.db)
    .await?;
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from invoices t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.status = $2) \
         and ($3::text is null or t.type = $3) \
         and ($4::text is null or t.contact_id = $4) \
         and ($5::timestamp is null or t.issue_date >= $5::timestamp) \
         and ($6::timestamp is null or t.issue_date <= $6::timestamp) \
         and (not $7 or (t.balance_due::numeric > 0 and t.due_date <= $8::timestamp)) \
         and ($9::text is null or (t.invoice_number like $9 or t.contact_name like $9 or t.reference like $9 \
           or t.contact_id in (select p.id from parties p where p.display_name like $9)))",
    )
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("type"))
    .bind(q.present("contactId"))
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(overdue)
    .bind(now())
    .bind(term.as_deref())
    .fetch_one(&caller.db)
    .await?;
    let total = i64::from(total);
    let named = with_contact_names(&caller.db, INVOICES.js_rows(rows)).await?;
    let named = with_source_invoice_numbers(caller, named).await?;
    Ok(paged(named, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        invoice_detail(&caller, &id).await,
        "Failed to fetch invoice",
    )
}

fn credit_line(item: &Value) -> CreditLine<'_> {
    CreditLine {
        id: item["id"].as_str().unwrap_or_default(),
        description: item["description"].as_str(),
        unit_price: item["unitPrice"].as_str().unwrap_or_default(),
        sort_order: item["sortOrder"].as_f64(),
        original_line_id: None,
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the detail with its lines, payments and credit notes, as the route reads them"
)]
async fn invoice_detail(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(invoice) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    let items = load_items(db, id, true).await?;

    // A credit memo's lines say which invoice line they credit.
    let credit_for = invoice["creditNoteForInvoiceId"]
        .as_str()
        .filter(|s| !s.is_empty());
    let item_rows: Vec<Value> = match credit_for {
        Some(original) if invoice["type"] == "credit_note" => {
            let originals = load_items(db, original, false).await?;
            let credit_lines: Vec<CreditLine<'_>> = items.iter().map(credit_line).collect();
            let original_lines: Vec<OriginalLine<'_>> = originals
                .iter()
                .map(|o| OriginalLine {
                    id: o["id"].as_str().unwrap_or_default(),
                    description: o["description"].as_str(),
                    unit_price: o["unitPrice"].as_str().unwrap_or_default(),
                    sort_order: o["sortOrder"].as_f64(),
                })
                .collect();
            let mapping = map_credit_items_to_original(&credit_lines, &original_lines);
            items
                .iter()
                .map(|item| {
                    let mut item = item.clone();
                    let original = mapping
                        .iter()
                        .find(|(credit, _)| Some(credit.as_str()) == item["id"].as_str())
                        .and_then(|(_, original)| original.clone());
                    item["originalLineId"] = json!(original);
                    item
                })
                .collect()
        }
        _ => items,
    };

    // Payments that settle this invoice: directly, or through an allocation.
    let allocations: Vec<(String, String)> = sqlx::query_as(
        "select payment_id, amount::text from payment_allocations \
         where invoice_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let allocated_ids: Vec<String> = allocations.iter().map(|(p, _)| p.clone()).collect();
    let payment_rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(payments),
        " from payments t where t.deleted_at is null and (t.invoice_id = $1 or t.id = any($2)) \
         order by t.date desc"
    ))
    .bind(id)
    .bind(&allocated_ids)
    .fetch_all(db)
    .await?;
    let mut allocated: HashMap<String, String> = HashMap::new();
    for (payment, amount) in allocations {
        allocated.insert(payment, amount);
    }
    let payments: Vec<Value> = PAYMENTS
        .js_rows(payment_rows)
        .into_iter()
        .map(|mut payment| {
            let amount = payment["id"]
                .as_str()
                .and_then(|pid| allocated.get(pid).cloned())
                .map_or_else(|| payment["amount"].clone(), Value::String);
            payment["allocatedAmount"] = amount;
            payment
        })
        .collect();
    let mut named = with_contact_names(db, vec![invoice.clone()])
        .await?
        .pop()
        .unwrap_or(invoice);

    // Credit notes issued against this invoice.
    let credit_notes: Vec<Value> = if named["type"] == "credit_note" {
        Vec::new()
    } else {
        let rows: Vec<CreditNoteRow> = sqlx::query_as(
            "select id, invoice_number, status, \
             to_char(issue_date, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), total::text \
             from invoices where credit_note_for_invoice_id = $1 and deleted_at is null \
             order by issue_date",
        )
        .bind(id)
        .fetch_all(db)
        .await?;
        rows.into_iter()
            .map(|(cid, number, status, issue_date, total)| {
                json!({ "id": cid, "invoiceNumber": number, "status": status, "issueDate": issue_date, "total": total })
            })
            .collect()
    };
    if let Value::Object(fields) = &mut named {
        fields.insert("items".into(), Value::Array(item_rows));
        fields.insert("payments".into(), Value::Array(payments));
        fields.insert("creditNotes".into(), Value::Array(credit_notes));
    }
    Ok(ok(named))
}

/// A credit note of an invoice: id, number, status, issue date, total.
type CreditNoteRow = (String, Option<String>, String, String, Option<String>);

// ── GET /:id/attachments/:index ─────────────────────────────────────────────

async fn attachment(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, index)): Path<(String, String)>,
) -> Response {
    reply(
        async {
            let keys: Option<Option<Value>> = sqlx::query_scalar(
                "select attachment_keys from invoices where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(keys) = keys else {
                return Err(Refusal::not_found("Invoice", &id));
            };
            attachments::stream_document_attachment(&caller, &state, keys.as_ref(), &index).await
        }
        .await,
        "Failed to download attachment",
    )
}

/// A row's `Map`, for routes that spread one (`{ ...invoice, ... }`).
pub(crate) fn fields_of(row: &Value) -> Map<String, Value> {
    row.as_object().cloned().unwrap_or_default()
}
