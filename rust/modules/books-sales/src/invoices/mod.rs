//! `/api/invoices` (`routes/invoices/index.ts`): entity-scoped list and
//! detail, server-side tax on create and update, gapless numbers, finalize
//! (one atomic posting), send, cancel / write off, duplicate, credit notes,
//! payments, credit application, the printable HTML and invoices from
//! commerce orders.
//!
//! Integrity rules (administratieplicht): only drafts are edited or deleted,
//! corrections go through credit notes, postings are refused in closed
//! periods and on/before lock dates, every mutation is audited.

pub(crate) mod actions;
pub(crate) mod from_order;
pub(crate) mod pdf;
pub(crate) mod write;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Query;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_books_domain::attachments;
use weldsuite_books_domain::contacts::{with_contact_email, with_contact_names};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, ok, paged, reply};
use weldsuite_books_domain::js::{self, parse_int};
use weldsuite_books_domain::sales_tax::document_tax::{
    CreditLine, OriginalLine, map_credit_items_to_original,
};
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{invoices, parties, payment_allocations, payments};

use crate::finalize::{load_invoice, load_items};
use crate::orm_bridge::sqlx_error;

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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(EntityRecordGuard::table(EntityTable::new("invoices"), "Invoice").layer())
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

/// [`js_date`] as the `timestamp` a filter compares with (the ISO text
/// Drizzle bound, `$n::timestamp`).
pub(crate) fn js_timestamp(text: &str) -> Result<PrimitiveDateTime, Refusal> {
    let iso = js_date(text)?;
    timestamp_of(&iso).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))
}

/// An ISO instant the route holds as text (`toISOString()`), as Postgres
/// read it into a `timestamp` column (`$n::timestamp`: its UTC wall-clock
/// time, to the millisecond). `None` for text that is not one.
pub(crate) fn timestamp_of(iso: &str) -> Option<PrimitiveDateTime> {
    millis_timestamp(js::millis_of(iso)?)
}

/// `new Date(millis)` as Drizzle writes it to a `timestamp` column.
pub(crate) fn millis_timestamp(millis: i64) -> Option<PrimitiveDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .map(utc_timestamp)
}

/// One `new Date()` the route both returns (`toISOString()`) and writes to
/// `timestamp` columns (UTC, to the millisecond, as Drizzle bound it).
pub(crate) fn now_stamped() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (weldsuite_events::iso_timestamp(at), utc_timestamp(at))
}

/// A row as Drizzle returned it: the entity's model, serialized.
pub(crate) fn row_json(model: impl Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// A `numeric(p, S)` value as Postgres prints it (`::text`): exactly `S`
/// decimals, through the entities' own serializer.
pub(crate) fn numeric_text<const S: i64>(value: &BigDecimal) -> String {
    weldsuite_schema::js::Numeric::<S>::serialize(value, serde_json::value::Serializer)
        .ok()
        .and_then(|text| text.as_str().map(str::to_owned))
        .unwrap_or_default()
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
) -> Result<Vec<Value>, DbErr> {
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
        invoices::Entity::find()
            .select_only()
            .column(invoices::Column::Id)
            .column(invoices::Column::InvoiceNumber)
            .filter(invoices::Column::Id.is_in(source_ids))
            .into_tuple()
            .all(&orm(&caller.db))
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

/// The list's filters (`conditions` of `GET /`), with the moment `overdue`
/// compares due dates with.
struct InvoiceFilters<'a> {
    entity_id: &'a str,
    status: Option<&'a str>,
    kind: Option<&'a str>,
    contact_id: Option<&'a str>,
    from: Option<PrimitiveDateTime>,
    to: Option<PrimitiveDateTime>,
    overdue: bool,
    term: Option<&'a str>,
}

impl InvoiceFilters<'_> {
    /// The `where` of the page and of its count; `overdue` is measured
    /// against `now`.
    fn condition(&self, now: PrimitiveDateTime) -> Condition {
        let mut condition = Condition::all()
            .add(invoices::Column::DeletedAt.is_null())
            .add(invoices::Column::EntityId.eq(self.entity_id));
        if let Some(status) = self.status {
            condition = condition.add(invoices::Column::Status.eq(status));
        }
        if let Some(kind) = self.kind {
            condition = condition.add(
                Condition::any()
                    .add(invoices::Column::Type.eq(kind))
                    .add_option(
                        (kind == "invoice").then(|| invoices::Column::Type.ne("credit_note")),
                    ),
            );
        }
        if let Some(contact) = self.contact_id {
            condition = condition.add(invoices::Column::ContactId.eq(contact));
        }
        if let Some(from) = self.from {
            condition = condition.add(invoices::Column::IssueDate.gte(from));
        }
        if let Some(to) = self.to {
            condition = condition.add(invoices::Column::IssueDate.lte(to));
        }
        if self.overdue {
            condition = condition
                .add(invoices::Column::BalanceDue.gt(0))
                .add(invoices::Column::DueDate.lte(now));
        }
        if let Some(term) = self.term {
            // A customer whose current name matches counts too.
            let named = Query::select()
                .column(parties::Column::Id)
                .from(parties::Entity)
                .and_where(parties::Column::DisplayName.like(term))
                .to_owned();
            condition = condition.add(
                Condition::any()
                    .add(invoices::Column::InvoiceNumber.like(term))
                    .add(invoices::Column::ContactName.like(term))
                    .add(invoices::Column::Reference.like(term))
                    .add(invoices::Column::ContactId.in_subquery(named)),
            );
        }
        condition
    }
}

/// `limit` and `offset` of a page; a negative offset fails as Postgres
/// refuses it.
pub(crate) fn page_window(page: i64, page_size: i64) -> Result<(u64, u64), Refusal> {
    let refused = |what: &str| Refusal::Internal(format!("{what} must not be negative"));
    let limit = u64::try_from(page_size).map_err(|_| refused("LIMIT"))?;
    let offset = u64::try_from((page - 1) * page_size).map_err(|_| refused("OFFSET"))?;
    Ok((limit, offset))
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
    let from = q.present("from").map(js_timestamp).transpose()?;
    let to = q.present("to").map(js_timestamp).transpose()?;
    let term = q.present("search").map(|s| format!("%{s}%"));
    let filters = InvoiceFilters {
        entity_id: &entity_id,
        status: q.present("status"),
        // `type=invoice` is every invoice that is not a credit note (standard,
        // proforma, correction): the invoice list, next to the credit notes list.
        kind: q.present("type"),
        contact_id: q.present("contactId"),
        from,
        to,
        overdue: q.get("overdue") == Some("true"),
        term: term.as_deref(),
    };
    let (limit, offset) = page_window(page, page_size)?;
    let db = orm(&caller.db);
    let rows = invoices::Entity::find()
        .filter(filters.condition(utc_now()))
        .order_by_desc(invoices::Column::IssueDate)
        .order_by_desc(invoices::Column::CreatedAt)
        .order_by_desc(invoices::Column::Id)
        .limit(limit)
        .offset(offset)
        .all(&db)
        .await
        .map_err(sqlx_error)?;
    let total = invoices::Entity::find()
        .filter(filters.condition(utc_now()))
        .count(&db)
        .await
        .map_err(sqlx_error)?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlx_error)?;
    let named = with_contact_names(&caller.db, rows).await?;
    let named = with_source_invoice_numbers(caller, named)
        .await
        .map_err(sqlx_error)?;
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
    let Some(invoice) = load_invoice(db, id).await.map_err(sqlx_error)? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    let items = load_items(db, id, true).await.map_err(sqlx_error)?;

    // A credit memo's lines say which invoice line they credit.
    let credit_for = invoice["creditNoteForInvoiceId"]
        .as_str()
        .filter(|s| !s.is_empty());
    let item_rows: Vec<Value> = match credit_for {
        Some(original) if invoice["type"] == "credit_note" => {
            let originals = load_items(db, original, false)
                .await
                .map_err(sqlx_error)?;
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
    let allocations: Vec<(String, BigDecimal)> = payment_allocations::Entity::find()
        .select_only()
        .column(payment_allocations::Column::PaymentId)
        .column(payment_allocations::Column::Amount)
        .filter(payment_allocations::Column::InvoiceId.eq(id))
        .filter(payment_allocations::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(sqlx_error)?;
    let allocated_ids: Vec<String> = allocations.iter().map(|(p, _)| p.clone()).collect();
    let payment_rows = payments::Entity::find()
        .filter(payments::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(payments::Column::InvoiceId.eq(id))
                // `id = any('{}')` matches nothing.
                .add_option(
                    (!allocated_ids.is_empty()).then(|| payments::Column::Id.is_in(allocated_ids)),
                ),
        )
        .order_by_desc(payments::Column::Date)
        .all(&orm(db))
        .await
        .map_err(sqlx_error)?;
    let mut allocated: HashMap<String, String> = HashMap::new();
    for (payment, amount) in allocations {
        allocated.insert(payment, numeric_text::<2>(&amount));
    }
    let payments: Vec<Value> = payment_rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlx_error)?
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
    // Stored without the contact's name or email: the contact's current ones (the send dialog shows the email).
    let named = with_contact_names(db, vec![invoice.clone()])
        .await?
        .pop()
        .unwrap_or(invoice);
    let mut named = with_contact_email(db, named).await?;

    // Credit notes issued against this invoice.
    let credit_notes: Vec<Value> = if named["type"] == "credit_note" {
        Vec::new()
    } else {
        let rows = invoices::Entity::find()
            .select_only()
            .column(invoices::Column::Id)
            .column(invoices::Column::InvoiceNumber)
            .column(invoices::Column::Status)
            .column(invoices::Column::IssueDate)
            .column(invoices::Column::Total)
            .filter(invoices::Column::CreditNoteForInvoiceId.eq(id))
            .filter(invoices::Column::DeletedAt.is_null())
            .order_by_asc(invoices::Column::IssueDate)
            .into_model::<CreditNoteRow>()
            .all(&orm(db))
            .await
            .map_err(sqlx_error)?;
        rows.into_iter()
            .map(row_json)
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlx_error)?
    };
    if let Value::Object(fields) = &mut named {
        fields.insert("items".into(), Value::Array(item_rows));
        fields.insert("payments".into(), Value::Array(payments));
        fields.insert("creditNotes".into(), Value::Array(credit_notes));
    }
    Ok(ok(named))
}

/// A credit note of an invoice: id, number, status, issue date (as
/// `toISOString()`), total (as text).
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditNoteRow {
    id: String,
    invoice_number: Option<String>,
    status: String,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    issue_date: PrimitiveDateTime,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    total: Option<BigDecimal>,
}

// ── GET /:id/attachments/:index ─────────────────────────────────────────────

async fn attachment(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, index)): Path<(String, String)>,
) -> Response {
    reply(
        async {
            let keys: Option<Option<Value>> = invoices::Entity::find_by_id(id.clone())
                .select_only()
                .column(invoices::Column::AttachmentKeys)
                .filter(invoices::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await
                .map_err(sqlx_error)?;
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
