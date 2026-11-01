//! `/api/bills` (`routes/bills/index.ts`): purchase bills. Numbered per
//! entity, taxed server-side (`books_domain::tax`), approved by posting them
//! (Dr expense and input tax / Cr payable), rejected by reversing that. Only
//! drafts are edited or deleted; every mutation is written to the
//! accounting audit log.

mod body;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, HeaderValue};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::contacts::{document_contact_fields, with_contact_names};
use weldsuite_books_domain::document_posting::{post_bill, update_with_entry};
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
    resolve_requested_entity_id,
};
use weldsuite_books_domain::fx::{RateQuery, draft_rate};
use weldsuite_books_domain::guards::{AuditInput, PostingLockKind, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, json_of, no_content, now, ok, paged, reply,
    validate,
};
use weldsuite_books_domain::js::{js_date, js_date_millis, number_text, parse_float};
use weldsuite_books_domain::posting::{
    PostError, ReverseArgs, assert_dimensions_belong_to_entity, reverse_journal_entry,
};
use weldsuite_books_domain::roles::{PromoteTo, promote_accounting_role};
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, DocumentKind, IssueDate, Runtime, load_sales_tax_entity, uses_sales_tax,
};
use weldsuite_books_domain::tables::{BILL_ITEMS, BILLS, DOCUMENTS, PAYMENTS};
use weldsuite_books_domain::tax::gst::{is_gst_entity, resolve_gst_bill_supply};
use weldsuite_books_domain::tax::{
    CalculatedDocumentTax, Direction, DocumentTaxItem, TaxArgs, calculate_document_tax,
    has_document_tax_hook,
};
use weldsuite_catalogs::entity_events::{
    BILL_CREATED, BILL_DELETED, BILL_UPDATED, JOURNAL_ENTRY_CREATED,
};
use weldsuite_kit::validation::{Field, Issues};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use body::{BillBody, BillLine, read_bill};

use crate::ocr::{line_items_for_bill, normalize_ocr_result};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("bills:read")))
        .route("/", post(create).route_layer(need("bills:create")))
        .route(
            "/from-document/{document_id}",
            post(from_document).route_layer(need("bills:create")),
        )
        .route("/{id}", get(detail).route_layer(need("bills:read")))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need("bills:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("bills:delete")),
        )
        .route(
            "/{id}/attachments/{index}",
            get(attachment).route_layer(need("bills:read")),
        )
        .route(
            "/{id}/approve",
            patch(approve).route_layer(need("bills:update")),
        )
        .route(
            "/{id}/reject",
            patch(reject).route_layer(need("bills:update")),
        )
        .with_state(state)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|v| !v.is_empty())
}

/// `accountingErrorResponse`: closed periods, lock dates, posting rules and
/// tax refusals are the user's to fix (400, or the sales tax code).
fn post_refusal(error: PostError) -> Refusal {
    match error.user_message() {
        Some(message) => Refusal::bad_request(message),
        None => match error {
            PostError::Database(error) => Refusal::Database(error),
            other => Refusal::Internal(other.to_string()),
        },
    }
}

/// The live bill `id`.
async fn find_bill(db: &sqlx::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bills),
        " from bills t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| BILLS.js(row)))
}

async fn live_items(
    db: &sqlx::PgPool,
    bill_id: &str,
    sorted: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = if sorted {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bill_items),
            " from bill_items t where t.bill_id = $1 and t.deleted_at is null order by t.sort_order"
        ))
        .bind(bill_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bill_items),
            " from bill_items t where t.bill_id = $1 and t.deleted_at is null"
        ))
        .bind(bill_id)
        .fetch_all(db)
        .await?
    };
    Ok(BILL_ITEMS.js_rows(rows))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(list_bills(&caller, &q).await, "Failed to fetch bills")
}

/// `new Date(q.x)` of a filter: `None` when absent, `Err` when invalid
/// (Drizzle's `toISOString` throws: the route's 500).
fn date_filter(q: &Query, key: &str) -> Result<Option<String>, Refusal> {
    match q.present(key) {
        None => Ok(None),
        Some(raw) => js_date(raw)
            .map(Some)
            .ok_or_else(|| Refusal::Internal(format!("invalid {key}"))),
    }
}

/// The list filters: entity, status, contact, issue-date range and search
/// (number, name, reference, or the contact's own name).
macro_rules! bills_where {
    () => {
        "t.deleted_at is null and t.entity_id = $1 \n         and ($2::text is null or t.status = $2) \n         and ($3::text is null or t.contact_id = $3) \n         and ($4::timestamp is null or t.issue_date >= $4::timestamp) \n         and ($5::timestamp is null or t.issue_date <= $5::timestamp) \n         and ($6::text is null or t.bill_number like $6 or t.contact_name like $6 or t.external_reference like $6 \n              or t.contact_id in (select p.id from parties p where p.display_name like $6))"
    };
}

async fn list_bills(caller: &Caller, q: &Query) -> Reply {
    let page =
        weldsuite_books_domain::js::parse_int(q.present("page").unwrap_or("1")).map(|p| p.max(1));
    let size = weldsuite_books_domain::js::parse_int(q.present("pageSize").unwrap_or("25"))
        .map(|s| s.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let (Some(page), Some(size)) = (page, size) else {
        return Err(Refusal::Internal("page or pageSize is NaN".to_owned()));
    };
    let from = date_filter(q, "from")?;
    let to = date_filter(q, "to")?;
    let search = q.present("search").map(|s| format!("%{s}%"));
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bills),
        " from bills t where ",
        bills_where!(),
        " order by t.issue_date desc, t.created_at desc, t.id desc limit $7 offset $8"
    ))
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("contactId"))
    .bind(&from)
    .bind(&to)
    .bind(&search)
    .bind(size)
    .bind((page - 1) * size)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from bills t where ",
        bills_where!()
    ))
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("contactId"))
    .bind(&from)
    .bind(&to)
    .bind(&search)
    .fetch_one(&caller.db)
    .await?;
    let rows = with_contact_names(&caller.db, BILLS.js_rows(rows)).await?;
    Ok(paged(rows, total, page * size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(bill) = find_bill(db, &id).await? else {
            return Err(Refusal::not_found("Bill", &id));
        };
        let items = live_items(db, &id, true).await?;
        let payments: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(payments),
            " from payments t where t.bill_id = $1 and t.deleted_at is null order by t.date desc"
        ))
        .bind(&id)
        .fetch_all(db)
        .await?;
        let mut named = with_contact_names(db, vec![bill]).await?;
        let mut view = named
            .pop()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        view.insert("items".into(), Value::Array(items));
        view.insert("payments".into(), Value::Array(PAYMENTS.js_rows(payments)));
        Ok(ok(Value::Object(view)))
    }
    .await;
    reply(result, "Failed to fetch bill")
}

// ── GET /:id/attachments/:index ─────────────────────────────────────────────

/// `isWorkspaceObjectKey(key, ...ids)`.
fn is_workspace_object_key(key: &str, ids: &[Option<&str>]) -> bool {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(owner), Some(_)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let valid_owner = !owner.is_empty()
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    weldsuite_ports::is_safe_key(key) && valid_owner && ids.contains(&Some(owner))
}

async fn attachment(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, index)): Path<(String, String)>,
) -> Response {
    let result: Reply = async {
        let keys: Option<Option<Value>> = sqlx::query_scalar(
            "select to_jsonb(attachment_keys) from bills where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(keys) = keys else {
            return Err(Refusal::not_found("Bill", &id));
        };
        stream_document_attachment(&caller, &state, keys.as_ref(), &index).await
    }
    .await;
    reply(result, "Failed to download attachment")
}

/// `streamDocumentAttachment(c, { attachmentKeys, index })`.
async fn stream_document_attachment(
    caller: &Caller,
    state: &BooksState,
    keys: Option<&Value>,
    raw_index: &str,
) -> Reply {
    // `Number(param)`: an integer of zero or more.
    let index = weldsuite_kit::validation::js_number(raw_index);
    if !(index.is_finite() && index.fract() == 0.0 && index >= 0.0) {
        return Err(Refusal::bad_request("Invalid attachment index"));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let position = index as usize;
    let key = keys
        .and_then(Value::as_array)
        .and_then(|keys| keys.get(position))
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty());
    let Some(key) = key else {
        return Err(Refusal::not_found("Attachment", &number_text(index)));
    };
    let Some(org) = caller
        .clerk_org_id
        .as_deref()
        .map(weldsuite_books_domain::jurisdictions::js_trim)
        .filter(|o| !o.is_empty())
    else {
        return Err(ApiError::org_required().into());
    };
    if !is_workspace_object_key(key, &[Some(org), Some(caller.workspace_id.as_str())]) {
        return Err(Refusal::forbidden("Attachment is outside this workspace"));
    }
    let buckets = caller.buckets(state);
    let Some(private) = buckets.private.clone().or_else(|| buckets.public.clone()) else {
        return Err(Refusal::from(
            ApiError::internal().with_message("Storage is not configured"),
        ));
    };
    let public = buckets.private.as_ref().and(buckets.public.as_deref());
    let object = weldsuite_ports::get_stored(private.as_ref(), public, key)
        .await
        .map_err(|error| Refusal::Internal(format!("{error:?}")))?;
    let Some(object) = object else {
        return Err(Refusal::not_found("Attachment", key));
    };
    let file_name = key
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("attachment")
        .replace('"', "");
    let mut response = object.bytes.into_response();
    let headers = response.headers_mut();
    if let Some(content_type) = object.info.content_type.as_deref()
        && let Ok(value) = HeaderValue::from_str(content_type)
    {
        headers.insert(http::header::CONTENT_TYPE, value);
    }
    if let Some(etag) = object.info.etag.as_deref()
        && let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\""))
    {
        headers.insert(http::header::ETAG, value);
    }
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{file_name}\"")) {
        headers.insert(http::header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `billValidationHook`: the issues as `path: message`, joined.
fn read_body(
    headers: &HeaderMap,
    raw: &Bytes,
    partial: bool,
    hooked: bool,
) -> Result<BillBody, Refusal> {
    let body = json_of(headers, raw)?;
    let mut issues = Issues::default();
    let bill = issues
        .object(&body)
        .map(|fields| read_bill(&mut issues, fields, partial));
    if let Err(invalid) = issues.finish() {
        if hooked {
            return Err(Refusal::bad_request(
                crate::accounting_contacts::hook_message(&invalid),
            ));
        }
        return Err(Refusal::Response(Box::new(invalid.into_response())));
    }
    bill.ok_or_else(|| Refusal::bad_request("Invalid request body"))
}

/// The tax items of new lines (ids first: the use tax rows refer to them).
fn tax_items(lines: &[BillLine], ids: &[String]) -> Vec<DocumentTaxItem> {
    lines
        .iter()
        .zip(ids)
        .enumerate()
        .map(|(index, (line, id))| DocumentTaxItem {
            quantity: Some(line.quantity.clone()),
            unit_price: line.unit_price.clone(),
            discount_percent: Some(line.discount_percent.clone()),
            tax_rate: line.tax_rate.clone(),
            tax_rate_id: line.tax_rate_id.clone(),
            id: Some(id.clone()),
            description: Some(line.description.clone()),
            #[allow(clippy::cast_precision_loss)]
            sort_order: Some(line.sort_order.unwrap_or(index as f64)),
            product_id: line.product_id.clone(),
            tax_code: line.tax_code.clone(),
            accrue_use_tax: line.accrue_use_tax,
            ncm: line.ncm.clone(),
            cfop: line.cfop.clone(),
            fiscal_data: line.fiscal_data.clone(),
            ..DocumentTaxItem::default()
        })
        .collect()
}

/// `billItemToTaxItem(item)`: a saved line, taxed again.
fn stored_tax_item(item: &Value) -> DocumentTaxItem {
    let opt = |key: &str| text(item, key).map(str::to_owned);
    DocumentTaxItem {
        quantity: Some(opt("quantity").unwrap_or_else(|| "1".to_owned())),
        unit_price: opt("unitPrice").unwrap_or_default(),
        discount_percent: Some(opt("discountPercent").unwrap_or_else(|| "0".to_owned())),
        tax_rate: opt("taxRate"),
        tax_rate_id: opt("taxRateId"),
        id: opt("id"),
        description: opt("description"),
        sort_order: item.get("sortOrder").and_then(Value::as_f64),
        product_id: opt("productId"),
        tax_code: opt("taxCode"),
        accrue_use_tax: item.get("accrueUseTax").and_then(Value::as_bool),
        ncm: opt("ncm"),
        cfop: opt("cfop"),
        fiscal_data: item.get("fiscalData").filter(|v| !v.is_null()).cloned(),
        ..DocumentTaxItem::default()
    }
}

/// `storedBillLines(db, billId)`: the saved lines as line input.
fn stored_line(item: &Value) -> BillLine {
    let opt = |key: &str| text(item, key).map(str::to_owned);
    BillLine {
        description: opt("description").unwrap_or_default(),
        quantity: opt("quantity").unwrap_or_else(|| "1".to_owned()),
        unit_price: opt("unitPrice").unwrap_or_default(),
        unit: opt("unit"),
        discount_percent: opt("discountPercent").unwrap_or_else(|| "0".to_owned()),
        tax_rate_id: opt("taxRateId"),
        tax_rate: None,
        account_id: opt("accountId"),
        sort_order: item.get("sortOrder").and_then(Value::as_f64),
        product_id: opt("productId"),
        tax_code: opt("taxCode"),
        accrue_use_tax: Some(
            item.get("accrueUseTax")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        form_1099_box: opt("form1099Box"),
        ncm: opt("ncm"),
        cfop: opt("cfop"),
        fiscal_data: item.get("fiscalData").filter(|v| !v.is_null()).cloned(),
        class_id: opt("classId"),
        location_id: opt("locationId"),
    }
}

/// `billDocumentContext(bill)`.
fn bill_context(bill: &Value) -> DocumentContext {
    let opt = |key: &str| text(bill, key).map(str::to_owned);
    let json_of = |key: &str| bill.get(key).filter(|v| !v.is_null()).cloned();
    DocumentContext {
        kind: DocumentKind::Bill,
        document_id: opt("id"),
        document_number: opt("billNumber"),
        contact_id: opt("contactId"),
        issue_date: IssueDate::Instant(opt("issueDate").unwrap_or_default()),
        currency: opt("currency"),
        billing_address: json_of("vendorAddress"),
        shipping_address: None,
        delivery_address: json_of("deliveryAddress"),
        ship_from_address: None,
        marketplace_facilitated: None,
        fiscal_data: json_of("fiscalData"),
        original_invoice_id: None,
    }
}

fn runtime(caller: &Caller, state: &BooksState) -> Runtime {
    Runtime {
        keyring: caller.keyring(state),
        http: caller.http(state),
    }
}

/// `buildBillItemRecords(entityId, billId, itemIds, items, processedItems)`.
fn item_records(
    entity_id: &str,
    bill_id: &str,
    ids: &[String],
    lines: &[BillLine],
    totals: &CalculatedDocumentTax,
    now: &str,
) -> Vec<Value> {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let processed = totals.processed_items.get(index);
            let some = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
            json!({
                "id": ids[index],
                "entityId": entity_id,
                "billId": bill_id,
                "description": line.description,
                "quantity": if line.quantity.is_empty() { "1" } else { line.quantity.as_str() },
                "unitPrice": line.unit_price,
                "unit": some(&line.unit),
                "discountPercent": if line.discount_percent.is_empty() { "0" } else { line.discount_percent.as_str() },
                "taxRateId": processed.and_then(|p| p.tax_rate_id.clone()),
                "taxRate": processed.and_then(|p| p.tax_rate.clone()),
                "taxAmount": processed.map(|p| p.tax_amount.clone()),
                "lineTotal": processed.map(|p| p.line_total.clone()),
                "lineTotalWithTax": processed.map(|p| p.line_total_with_tax.clone()),
                "accountId": some(&line.account_id),
                "productId": some(&line.product_id),
                "sortOrder": line.sort_order.map_or_else(|| json!(index), weldsuite_books_domain::js::number_value),
                "taxCode": some(&line.tax_code),
                "accrueUseTax": line.accrue_use_tax.unwrap_or(false),
                "form1099Box": some(&line.form_1099_box),
                "ncm": some(&line.ncm),
                "cfop": some(&line.cfop),
                "fiscalData": line.fiscal_data.clone(),
                "classId": some(&line.class_id),
                "locationId": some(&line.location_id),
                "createdAt": now,
                "updatedAt": now,
            })
        })
        .collect()
}

fn dimension_lines(lines: &[BillLine]) -> Vec<(Option<String>, Option<String>)> {
    lines
        .iter()
        .map(|l| (l.class_id.clone(), l.location_id.clone()))
        .collect()
}

/// The totals a calculation adds to the bill (`...billTotals`).
fn totals_of(totals: &CalculatedDocumentTax) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("subtotal".into(), json!(totals.subtotal));
    out.insert("discountTotal".into(), json!(totals.discount_total));
    out.insert("taxTotal".into(), json!(totals.tax_total));
    out.insert("total".into(), json!(totals.total));
    out.insert("balanceDue".into(), json!(totals.balance_due));
    if let Some(warnings) = &totals.tax_warnings {
        out.insert("taxWarnings".into(), json!(warnings));
    }
    out
}

fn some_text(value: Option<&String>) -> Value {
    value
        .filter(|v| !v.is_empty())
        .map_or(Value::Null, |v| json!(v))
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let data = match read_body(&headers, &raw, false, true) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(""),
    };
    reply(
        create_bill(&caller, &state, data).await,
        "Failed to create bill",
    )
}

#[allow(clippy::too_many_lines)] // the route's steps, as TypeScript has them
async fn create_bill(caller: &Caller, state: &BooksState, data: BillBody) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_requested_entity_id(caller, data.entity_id.as_deref()).await?
    else {
        return Err(Refusal::bad_request(match data.entity_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => format!("Accounting entity {id} does not exist in this workspace."),
            None => "No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.".to_owned(),
        }));
    };
    let bill_number = match &data.bill_number {
        Some(number) => number.clone(),
        None => {
            next_entity_number(db, &entity_id, SequenceType::Bill)
                .await?
                .formatted
        }
    };
    let base_currency = resolve_entity_base_currency(db, &entity_id).await?;
    let currency = data
        .currency
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| base_currency.clone());
    let issue_raw = data.issue_date.clone().unwrap_or_default();
    let due_raw = data.due_date.clone().unwrap_or_default();
    let (Some(issue_date), Some(due_date)) = (js_date(&issue_raw), js_date(&due_raw)) else {
        return Err(Refusal::Internal("Invalid time value".to_owned()));
    };
    let typed = data.exchange_rate.as_set().map(|r| json!(r));
    let exchange_rate = draft_rate(
        db,
        caller.http(state).as_ref(),
        RateQuery {
            base_currency: &base_currency,
            currency: &currency,
            at_millis: js_date_millis(&issue_raw).unwrap_or(0),
            typed: typed.as_ref(),
            use_feed: true,
        },
    )
    .await?;

    let bill_id = generate_id("bil");
    let lines = data.items.clone().unwrap_or_default();
    let item_ids: Vec<String> = lines.iter().map(|_| generate_id("bli")).collect();
    let items = tax_items(&lines, &item_ids);
    assert_dimensions_belong_to_entity(db, &entity_id, &dimension_lines(&lines))
        .await
        .map_err(post_refusal)?;
    let delivery = normalize_postal_address(data.delivery_address.as_set());
    let vendor = normalize_postal_address(data.vendor_address.as_set());
    let gst = resolve_gst_bill_supply(db, &entity_id, data.contact_id.as_deref(), vendor.as_ref())
        .await?;
    let runtime = runtime(caller, state);
    let document = DocumentContext {
        kind: DocumentKind::Bill,
        document_id: Some(bill_id.clone()),
        document_number: Some(bill_number.clone()),
        contact_id: data.contact_id.clone(),
        issue_date: IssueDate::Instant(issue_date.clone()),
        currency: Some(currency.clone()),
        billing_address: vendor.clone(),
        shipping_address: None,
        delivery_address: delivery.clone(),
        ship_from_address: None,
        marketplace_facilitated: None,
        fiscal_data: data.fiscal_data.as_set().cloned(),
        original_invoice_id: None,
    };
    let mut args = TaxArgs::new(&entity_id, Direction::Purchase, &items).with_gst(gst.as_ref());
    args.runtime = Some(&runtime);
    args.document = Some(&document);
    let totals = calculate_document_tax(db, &args)
        .await
        .map_err(Refusal::from)?;
    let contact = document_contact_fields(
        db,
        data.contact_id.as_deref(),
        data.contact_name.as_deref(),
        None,
    )
    .await?;

    let now = now();
    let mut bill = Map::new();
    bill.insert("id".into(), json!(bill_id));
    bill.insert("entityId".into(), json!(entity_id));
    bill.insert("billNumber".into(), json!(bill_number));
    bill.insert("type".into(), json!("standard"));
    bill.insert("status".into(), json!("draft"));
    bill.insert("contactId".into(), json!(data.contact_id));
    bill.insert("contactName".into(), json!(contact.name));
    bill.insert("issueDate".into(), json!(issue_date));
    bill.insert("dueDate".into(), json!(due_date));
    bill.insert("currency".into(), json!(currency));
    bill.insert("exchangeRate".into(), json!(exchange_rate));
    bill.extend(totals_of(&totals));
    bill.insert("taxBreakdown".into(), json!(totals.tax_breakdown));
    bill.insert("amountPaid".into(), json!("0"));
    bill.insert(
        "externalReference".into(),
        some_text(data.external_reference.as_ref()),
    );
    bill.insert("reference".into(), some_text(data.reference.as_ref()));
    bill.insert("notes".into(), some_text(data.notes.as_ref()));
    bill.insert(
        "internalNotes".into(),
        some_text(data.internal_notes.as_ref()),
    );
    bill.insert(
        "expenseAccountId".into(),
        some_text(data.expense_account_id.as_ref()),
    );
    bill.insert(
        "vendorAddress".into(),
        vendor.clone().unwrap_or(Value::Null),
    );
    bill.insert(
        "deliveryAddress".into(),
        delivery.clone().unwrap_or(Value::Null),
    );
    bill.insert(
        "fiscalData".into(),
        data.fiscal_data.as_set().cloned().unwrap_or(Value::Null),
    );
    bill.insert(
        "sourceDocumentId".into(),
        some_text(data.source_document_id.as_ref()),
    );
    bill.insert("approvalStatus".into(), json!("pending"));
    bill.insert("createdBy".into(), json!(caller.user_id));
    bill.insert("createdAt".into(), json!(now));
    bill.insert("updatedAt".into(), json!(now));
    BILLS.insert_raw(db, BILLS.values(&bill)).await?;

    let records = item_records(&entity_id, &bill_id, &item_ids, &lines, &totals, &now);
    for record in &records {
        if let Value::Object(record) = record {
            BILL_ITEMS.insert_raw(db, BILL_ITEMS.values(record)).await?;
        }
    }
    if let Some(document_id) = data.source_document_id.as_deref().filter(|d| !d.is_empty()) {
        sqlx::query(
            "update documents set status = 'linked', linked_entity_type = 'bill', linked_entity_id = $2, \
             updated_at = $3::timestamp where id = $1",
        )
        .bind(document_id)
        .bind(&bill_id)
        .bind(weldsuite_books_domain::http::now())
        .execute(db)
        .await?;
    }
    if let Some(contact_id) = data.contact_id.as_deref() {
        promote_accounting_role(db, contact_id, PromoteTo::Supplier).await?;
    }
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "bill",
            entity_id: &bill_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        BILL_CREATED,
        &bill_id,
        json!({
            "id": bill_id,
            "billNumber": bill_number,
            "status": "draft",
            "total": bill.get("total").cloned().unwrap_or(Value::Null),
            "currency": currency,
            "contactId": data.contact_id,
            "issueDate": issue_raw,
            "dueDate": due_raw,
        }),
    );
    bill.insert("items".into(), Value::Array(records));
    Ok(created(Value::Object(bill)))
}

// ── POST /from-document/:documentId ─────────────────────────────────────────

async fn from_document(caller: Caller, Path(document_id): Path<String>) -> Response {
    let result: Reply = async {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(documents),
            " from documents t where t.id = $1 and t.deleted_at is null limit 1"
        ))
        .bind(&document_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(doc) = row.map(|row| DOCUMENTS.js(row)) else {
            return Err(Refusal::not_found("Document", &document_id));
        };
        let Some(stored) = doc.get("ocrResult").filter(|v| !v.is_null()) else {
            return Err(Refusal::bad_request("Document has not been processed yet"));
        };
        let ocr = normalize_ocr_result(stored);
        let truthy = |value: &Value| match value {
            Value::Null | Value::Bool(false) => Value::Null,
            Value::String(s) if s.is_empty() => Value::Null,
            other => other.clone(),
        };
        Ok(ok(json!({
            "contactName": truthy(&ocr["vendor"]["name"]),
            "externalReference": truthy(&ocr["invoiceNumber"]),
            "issueDate": truthy(&ocr["invoiceDate"]),
            "dueDate": truthy(&ocr["dueDate"]),
            "currency": truthy(&ocr["currency"]),
            "items": line_items_for_bill(&ocr),
            "subtotal": ocr["subtotal"],
            "taxTotal": ocr["totalTax"],
            "total": ocr["total"],
            "sourceDocumentId": document_id,
            "matchedContactId": doc.get("matchedContactId").cloned().unwrap_or(Value::Null),
            "confidence": ocr["confidence"],
        })))
    }
    .await;
    reply(result, "Failed to create bill from document")
}

// ── PATCH /:id/approve ──────────────────────────────────────────────────────

/// `refreshBillUseTax(db, bill, items, runtime)`: a US bill's use tax
/// recalculated for what is saved now.
async fn refresh_bill_use_tax(
    db: &sqlx::PgPool,
    bill: &Value,
    items: &[Value],
    runtime: &Runtime,
) -> Result<Value, Refusal> {
    let accrues = items
        .iter()
        .any(|i| i.get("accrueUseTax").and_then(Value::as_bool) == Some(true));
    let entity_id = text(bill, "entityId").unwrap_or_default();
    if !accrues || !uses_sales_tax(load_sales_tax_entity(db, entity_id).await?.as_ref()) {
        return Ok(bill.clone());
    }
    let tax_items: Vec<DocumentTaxItem> = items.iter().map(stored_tax_item).collect();
    let document = bill_context(bill);
    let mut args = TaxArgs::new(entity_id, Direction::Purchase, &tax_items);
    args.document = Some(&document);
    args.runtime = Some(runtime);
    let calc = calculate_document_tax(db, &args)
        .await
        .map_err(Refusal::from)?;
    sqlx::query("update bills set tax_breakdown = $2, updated_at = $3::timestamp where id = $1")
        .bind(text(bill, "id").unwrap_or_default())
        .bind(json!(calc.tax_breakdown))
        .bind(now())
        .execute(db)
        .await?;
    let mut ready = bill.clone();
    ready["taxBreakdown"] = json!(calc.tax_breakdown);
    Ok(ready)
}

async fn approve(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(bill) = find_bill(db, &id).await? else {
            return Err(Refusal::not_found("Bill", &id));
        };
        if filled(&bill, "journalEntryId").is_some() {
            // Already approved and posted: approving again is a no-op.
            return Ok(ok(bill));
        }
        if text(&bill, "status") == Some("cancelled")
            || text(&bill, "approvalStatus") == Some("rejected")
        {
            return Err(Refusal::bad_request(
                "A rejected bill cannot be approved. Create a new bill instead.",
            ));
        }
        let items = live_items(db, &id, false).await?;
        let ready = refresh_bill_use_tax(db, &bill, &items, &runtime(&caller, &state)).await?;
        let user = caller.user().map(str::to_owned);
        let posted = post_bill(
            db,
            caller.http(&state).as_ref(),
            &ready,
            &items,
            user.clone(),
            false,
        )
        .await
        .map_err(post_refusal)?;
        let mut changes = Map::new();
        changes.insert(
            "approvalStatus".into(),
            json!({ "old": bill.get("approvalStatus"), "new": "approved" }),
        );
        changes.insert(
            "status".into(),
            json!({ "old": bill.get("status"), "new": "approved" }),
        );
        changes.insert(
            "journalEntryId".into(),
            json!({ "old": null, "new": posted.journal_entry_id }),
        );
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: text(&bill, "entityId"),
                entity_type: "bill",
                entity_id: &id,
                action: "approved",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            BILL_UPDATED,
            &id,
            json!({
                "id": id,
                "billNumber": bill.get("billNumber"),
                "status": "approved",
                "total": filled(&bill, "total").unwrap_or("0"),
                "currency": bill.get("currency"),
                "contactId": bill.get("contactId"),
            }),
        );
        if let Some(entry) = posted.journal_entry_id.as_deref()
            && !posted.already_posted
        {
            caller.publish(
                &state,
                JOURNAL_ENTRY_CREATED,
                entry,
                json!({ "id": entry, "sourceType": "bill", "sourceId": id }),
            );
        }
        let mut view = bill.as_object().cloned().unwrap_or_default();
        view.insert("approvalStatus".into(), json!("approved"));
        view.insert("status".into(), json!("approved"));
        view.insert("approvedBy".into(), json!(user));
        view.insert("journalEntryId".into(), json!(posted.journal_entry_id));
        Ok(ok(Value::Object(view)))
    }
    .await;
    reply(result, "Failed to approve bill")
}

// ── PATCH /:id/reject ───────────────────────────────────────────────────────

#[allow(clippy::too_many_lines)] // the route's steps, as TypeScript has them
async fn reject(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let reason = match validate(&headers, &raw, |issues, body| {
        issues.string(body, "reason", true, Some(1), None)
    }) {
        Ok(reason) => reason.unwrap_or_default(),
        Err(refusal) => return refusal.respond(""),
    };
    let result: Reply = async {
        let db = &caller.db;
        let Some(bill) = find_bill(db, &id).await? else {
            return Err(Refusal::not_found("Bill", &id));
        };
        if parse_float(text(&bill, "amountPaid").unwrap_or("0")) > 0.0 {
            return Err(Refusal::bad_request(
                "This bill has payments. Void the payments before rejecting it.",
            ));
        }
        let now = now();
        let user = caller.user().map(str::to_owned);
        let mut set = Map::new();
        set.insert("approvalStatus".into(), json!("rejected"));
        set.insert("status".into(), json!("cancelled"));
        set.insert("rejectedBy".into(), json!(user));
        set.insert("rejectedAt".into(), json!(now));
        set.insert("rejectionReason".into(), json!(reason));
        set.insert("updatedAt".into(), json!(now));
        let mut reversal_id = None;
        if let Some(entry) = filled(&bill, "journalEntryId") {
            let reversal = reverse_journal_entry(
                db,
                ReverseArgs {
                    entry_id: entry.to_owned(),
                    date: now.clone(),
                    created_by: user.clone(),
                    lock_kind: Some(PostingLockKind::Purchase),
                    description: Some(format!(
                        "Rejected bill {}",
                        text(&bill, "billNumber").unwrap_or(&id)
                    )),
                    also_write: vec![update_with_entry(&BILLS, id.clone(), set.clone(), None)],
                    ..ReverseArgs::default()
                },
            )
            .await
            .map_err(post_refusal)?;
            reversal_id = reversal.journal_entry_id;
        } else {
            BILLS.patch_raw(db, &id, BILLS.values(&set), false).await?;
        }
        let mut changes = Map::new();
        changes.insert(
            "approvalStatus".into(),
            json!({ "old": bill.get("approvalStatus"), "new": "rejected" }),
        );
        changes.insert(
            "status".into(),
            json!({ "old": bill.get("status"), "new": "cancelled" }),
        );
        changes.insert(
            "rejectionReason".into(),
            json!({ "old": bill.get("rejectionReason"), "new": reason }),
        );
        if let Some(reversal) = &reversal_id {
            changes.insert(
                "reversalEntryId".into(),
                json!({ "old": null, "new": reversal }),
            );
        }
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: text(&bill, "entityId"),
                entity_type: "bill",
                entity_id: &id,
                action: "rejected",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            BILL_UPDATED,
            &id,
            json!({
                "id": id,
                "billNumber": bill.get("billNumber"),
                "status": "cancelled",
                "total": filled(&bill, "total").unwrap_or("0"),
                "currency": bill.get("currency"),
                "contactId": bill.get("contactId"),
            }),
        );
        let mut view = bill.as_object().cloned().unwrap_or_default();
        view.insert("approvalStatus".into(), json!("rejected"));
        view.insert("status".into(), json!("cancelled"));
        Ok(ok(Value::Object(view)))
    }
    .await;
    reply(result, "Failed to reject bill")
}

// ── PUT/PATCH /:id ──────────────────────────────────────────────────────────

/// `buildBillHeaderPatch(db, bill, data)`.
#[allow(clippy::too_many_lines)] // the patch, field by field as TypeScript builds it
async fn header_patch(
    caller: &Caller,
    state: &BooksState,
    bill: &Value,
    data: &BillBody,
) -> Result<Map<String, Value>, Refusal> {
    let db = &caller.db;
    let mut set = Map::new();
    set.insert("updatedAt".into(), json!(now()));
    if let Some(contact) = data.contact_id.as_deref().filter(|c| !c.is_empty()) {
        set.insert("contactId".into(), json!(contact));
    }
    if let Some(name) = &data.contact_name {
        set.insert("contactName".into(), json!(name));
    }
    // `applyBillContactName`: another supplier, or a draft without a name.
    let contact_changed = data
        .contact_id
        .as_deref()
        .is_some_and(|c| !c.is_empty() && Some(c) != text(bill, "contactId"));
    if contact_changed || filled(bill, "contactName").is_none() {
        let typed_name = data.contact_name.clone().or_else(|| {
            (!contact_changed)
                .then(|| text(bill, "contactName").map(str::to_owned))
                .flatten()
        });
        let contact_id = data
            .contact_id
            .as_deref()
            .or_else(|| text(bill, "contactId"));
        let fields = document_contact_fields(db, contact_id, typed_name.as_deref(), None).await?;
        set.insert("contactName".into(), json!(fields.name));
    }
    if let Some(issue) = data.issue_date.as_deref().filter(|d| !d.is_empty()) {
        let iso =
            js_date(issue).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
        set.insert("issueDate".into(), json!(iso));
    }
    if let Some(due) = data.due_date.as_deref().filter(|d| !d.is_empty()) {
        let iso = js_date(due).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
        set.insert("dueDate".into(), json!(iso));
    }
    if let Some(currency) = data.currency.as_deref().filter(|c| !c.is_empty()) {
        set.insert("currency".into(), json!(currency));
    }
    // `applyBillExchangeRate`.
    let currency_changed = data
        .currency
        .as_deref()
        .is_some_and(|c| Some(c) != text(bill, "currency"));
    let issue_changed = data
        .issue_date
        .as_deref()
        .is_some_and(|d| js_date_millis(d) != text(bill, "issueDate").and_then(js_date_millis));
    if !data.exchange_rate.is_absent() || currency_changed || issue_changed {
        let entity_id = text(bill, "entityId").unwrap_or_default();
        let base = resolve_entity_base_currency(db, entity_id).await?;
        let currency = text(&Value::Object(set.clone()), "currency")
            .or_else(|| text(bill, "currency"))
            .unwrap_or(&base)
            .to_owned();
        let at = text(&Value::Object(set.clone()), "issueDate")
            .or_else(|| text(bill, "issueDate"))
            .and_then(js_date_millis)
            .unwrap_or(0);
        let typed = data.exchange_rate.as_set().map(|r| json!(r));
        let rate = draft_rate(
            db,
            caller.http(state).as_ref(),
            RateQuery {
                base_currency: &base,
                currency: &currency,
                at_millis: at,
                typed: typed.as_ref(),
                use_feed: true,
            },
        )
        .await?;
        set.insert("exchangeRate".into(), json!(rate));
    }
    // `billTextFieldsPatch`.
    for (key, value) in [
        ("externalReference", &data.external_reference),
        ("reference", &data.reference),
        ("notes", &data.notes),
        ("internalNotes", &data.internal_notes),
    ] {
        if let Some(value) = value {
            set.insert(key.into(), json!(value));
        }
    }
    if let Some(account) = &data.expense_account_id {
        set.insert("expenseAccountId".into(), some_text(Some(account)));
    }
    for (key, field) in [
        ("vendorAddress", &data.vendor_address),
        ("deliveryAddress", &data.delivery_address),
    ] {
        if !field.is_absent() {
            set.insert(
                key.into(),
                normalize_postal_address(field.as_set()).unwrap_or(Value::Null),
            );
        }
    }
    match &data.fiscal_data {
        Field::Absent => {}
        Field::Null => {
            set.insert("fiscalData".into(), Value::Null);
        }
        Field::Set(fiscal) => {
            set.insert("fiscalData".into(), fiscal.clone());
        }
    }
    Ok(set)
}

/// `{ ...bill, ...updateData }`.
fn effective(bill: &Value, set: &Map<String, Value>) -> Value {
    let mut merged = bill.as_object().cloned().unwrap_or_default();
    merged.extend(set.clone());
    Value::Object(merged)
}

/// `replaceBillItems(c, db, bill, items, updateData)`.
async fn replace_items(
    caller: &Caller,
    state: &BooksState,
    bill: &Value,
    lines: &[BillLine],
    set: &mut Map<String, Value>,
) -> Result<Vec<Value>, Refusal> {
    let db = &caller.db;
    let entity_id = text(bill, "entityId").unwrap_or_default().to_owned();
    let bill_id = text(bill, "id").unwrap_or_default().to_owned();
    let ids: Vec<String> = lines.iter().map(|_| generate_id("bli")).collect();
    let items = tax_items(lines, &ids);
    assert_dimensions_belong_to_entity(db, &entity_id, &dimension_lines(lines))
        .await
        .map_err(post_refusal)?;
    let merged = effective(bill, set);
    let gst = resolve_gst_bill_supply(
        db,
        &entity_id,
        text(&merged, "contactId"),
        merged.get("vendorAddress").filter(|v| !v.is_null()),
    )
    .await?;
    let runtime = runtime(caller, state);
    let document = bill_context(&merged);
    let mut args = TaxArgs::new(&entity_id, Direction::Purchase, &items).with_gst(gst.as_ref());
    args.runtime = Some(&runtime);
    args.document = Some(&document);
    let totals = calculate_document_tax(db, &args)
        .await
        .map_err(Refusal::from)?;
    set.extend(totals_of(&totals));
    set.insert("taxBreakdown".into(), json!(totals.tax_breakdown));
    let paid = parse_float(filled(bill, "amountPaid").unwrap_or("0"));
    set.insert(
        "balanceDue".into(),
        json!(number_text(parse_float(&totals.total) - paid)),
    );
    let now = now();
    Ok(item_records(
        &entity_id, &bill_id, &ids, lines, &totals, &now,
    ))
}

/// `applyBillTaxChanges(c, db, bill, data, updateData)`: new lines, or the
/// saved ones taxed again when the change moves their tax.
async fn apply_tax_changes(
    caller: &Caller,
    state: &BooksState,
    bill: &Value,
    data: &BillBody,
    set: &mut Map<String, Value>,
) -> Result<Option<Vec<Value>>, Refusal> {
    let db = &caller.db;
    let entity_id = text(bill, "entityId").unwrap_or_default().to_owned();
    let bill_id = text(bill, "id").unwrap_or_default().to_owned();
    if let Some(lines) = &data.items {
        return replace_items(caller, state, bill, lines, set)
            .await
            .map(Some);
    }
    let fiscal_moves = !data.fiscal_data.is_absent()
        || !data.vendor_address.is_absent()
        || data.contact_id.is_some()
        || data.issue_date.is_some();
    if fiscal_moves && has_document_tax_hook(db, &entity_id).await? {
        let lines: Vec<BillLine> = live_items(db, &bill_id, true)
            .await?
            .iter()
            .map(stored_line)
            .collect();
        return replace_items(caller, state, bill, &lines, set)
            .await
            .map(Some);
    }
    let use_tax_moves = !data.delivery_address.is_absent()
        || data.issue_date.is_some()
        || data.contact_id.is_some();
    if use_tax_moves && uses_sales_tax(load_sales_tax_entity(db, &entity_id).await?.as_ref()) {
        let stored = live_items(db, &bill_id, false).await?;
        if stored
            .iter()
            .any(|i| i.get("accrueUseTax").and_then(Value::as_bool) == Some(true))
        {
            let merged = effective(bill, set);
            let items: Vec<DocumentTaxItem> = stored.iter().map(stored_tax_item).collect();
            let runtime = runtime(caller, state);
            let document = bill_context(&merged);
            let mut args = TaxArgs::new(&entity_id, Direction::Purchase, &items);
            args.runtime = Some(&runtime);
            args.document = Some(&document);
            let calc = calculate_document_tax(db, &args)
                .await
                .map_err(Refusal::from)?;
            set.insert("taxBreakdown".into(), json!(calc.tax_breakdown));
        }
        return Ok(None);
    }
    let gst_moves = !data.vendor_address.is_absent() || data.contact_id.is_some();
    if gst_moves && is_gst_entity(db, &entity_id).await? {
        let stored = live_items(db, &bill_id, false).await?;
        if stored.is_empty() {
            return Ok(None);
        }
        let merged = effective(bill, set);
        let gst = resolve_gst_bill_supply(
            db,
            &entity_id,
            text(&merged, "contactId"),
            merged.get("vendorAddress").filter(|v| !v.is_null()),
        )
        .await?;
        let items: Vec<DocumentTaxItem> = stored.iter().map(stored_tax_item).collect();
        let args = TaxArgs::new(&entity_id, Direction::Purchase, &items).with_gst(gst.as_ref());
        let calc = calculate_document_tax(db, &args)
            .await
            .map_err(Refusal::from)?;
        set.insert("taxBreakdown".into(), json!(calc.tax_breakdown));
    }
    Ok(None)
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let data = match read_body(&headers, &raw, true, false) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(""),
    };
    reply(
        update_bill(&caller, &state, &id, data).await,
        "Failed to update bill",
    )
}

async fn update_bill(caller: &Caller, state: &BooksState, id: &str, data: BillBody) -> Reply {
    let db = &caller.db;
    let Some(bill) = find_bill(db, id).await? else {
        return Err(Refusal::not_found("Bill", id));
    };
    if text(&bill, "status") != Some("draft") {
        return Err(Refusal::bad_request("Can only edit draft bills"));
    }
    let mut set = header_patch(caller, state, &bill, &data).await?;
    let new_items = apply_tax_changes(caller, state, &bill, &data, &mut set).await?;

    let mut tx = db.begin().await?;
    BILLS
        .patch_raw(&mut *tx, id, BILLS.values(&set), false)
        .await?;
    if let Some(items) = &new_items {
        sqlx::query("update bill_items set deleted_at = $2::timestamp where bill_id = $1 and deleted_at is null")
            .bind(id)
            .bind(now())
            .execute(&mut *tx)
            .await?;
        for item in items {
            if let Value::Object(item) = item {
                BILL_ITEMS
                    .insert_raw(&mut *tx, BILL_ITEMS.values(item))
                    .await?;
            }
        }
    }
    tx.commit().await?;

    let changes: Map<String, Value> = set
        .iter()
        .filter(|(key, _)| key.as_str() != "updatedAt" && key.as_str() != "taxBreakdown")
        .map(|(key, value)| {
            (
                key.clone(),
                json!({ "old": bill.get(key).cloned().unwrap_or(Value::Null), "new": value }),
            )
        })
        .collect();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&bill, "entityId"),
            entity_type: "bill",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        BILL_UPDATED,
        id,
        json!({
            "id": id,
            "billNumber": bill.get("billNumber"),
            "status": filled(&bill, "status").unwrap_or("draft"),
            "total": set.get("total").and_then(Value::as_str).or_else(|| text(&bill, "total")).unwrap_or("0"),
            "currency": set.get("currency").or_else(|| bill.get("currency")),
            "contactId": data.contact_id.as_deref().or_else(|| text(&bill, "contactId")),
        }),
    );
    let mut view = bill.as_object().cloned().unwrap_or_default();
    view.extend(set);
    if let Some(items) = new_items {
        view.insert("items".into(), Value::Array(items));
    }
    Ok(ok(Value::Object(view)))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(bill) = find_bill(db, &id).await? else {
            return Err(Refusal::not_found("Bill", &id));
        };
        if text(&bill, "status") != Some("draft") {
            return Err(Refusal::bad_request("Can only delete draft bills"));
        }
        let now = now();
        sqlx::query(
            "update bills set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(db)
        .await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: text(&bill, "entityId"),
                entity_type: "bill",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(
            &state,
            BILL_DELETED,
            &id,
            json!({
                "id": id,
                "billNumber": bill.get("billNumber"),
                "status": filled(&bill, "status").unwrap_or("draft"),
                "total": filled(&bill, "total").unwrap_or("0"),
            }),
        );
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete bill")
}
