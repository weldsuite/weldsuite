//! `/api/orders`: sales orders. Every write goes through
//! `weldsuite_commerce_domain::orders::write` (ADR COM-010); this file reads
//! and validates requests, presents rows and publishes the entity events.
//!
//! - VAT comes from the WeldBooks engine for the seller entity (ADR COM-014,
//!   `weldsuite_commerce_domain::vat`): when an order is placed, and when
//!   staff edit an editable order. An order that is no longer editable keeps
//!   its VAT (409 `ORDER_TAX_LOCKED` on `POST /:id/recalculate-tax`). A store's
//!   order keeps the store's own tax and reads `vatTreatment: "imported"`.
//! - `POST /` accepts an `Idempotency-Key` header (or `idempotencyKey` in the
//!   body): a retry answers with the first order and writes nothing.
//! - Addresses are stored with `region`; rows an import wrote with `state`
//!   read back with `region` too.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ORDER_CANCELLED, ORDER_COMPLETED, ORDER_CREATED, ORDER_PAID, ORDER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{ORDERS_CREATE, ORDERS_READ, ORDERS_UPDATE};
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_commerce_domain::orders::lines::LineInput;
use weldsuite_commerce_domain::orders::plan::{self, QuoteInput};
use weldsuite_commerce_domain::orders::write::{self, NewOrder, Patch, Payment};
use weldsuite_commerce_domain::orders::{self as domain_orders};
use weldsuite_commerce_domain::vat::{Buyer, Taxation, country_of};
use weldsuite_kit::validation::{
    Field, Format, Issues, Number, Presence, Text, js_date_parse, js_iso_from_millis,
};
use weldsuite_kit::{Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::query_set;
use crate::wire::{
    amount, body_or_empty, invalid, iso, read_address, read_currency, read_date, read_money,
    read_text, refuse,
};
use crate::{Caller, CommerceState, Refusal, internal, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ORDERS_READ]);
    let update = || gate.require([ORDERS_UPDATE]);
    // One `route` per method: `route_layer` wraps every method already
    // chained on its `MethodRouter`, so chaining GET and PATCH would make
    // the GET need both permissions.
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(gate.require([ORDERS_CREATE])))
        .route(
            "/quote",
            post(quote).route_layer(gate.require([ORDERS_CREATE])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(patch_order).route_layer(update()))
        .route("/{id}/cancel", post(cancel).route_layer(update()))
        .route("/{id}/approve", post(approve).route_layer(update()))
        .route("/{id}/reject", post(reject).route_layer(update()))
        .route("/{id}/mark-paid", post(mark_paid).route_layer(update()))
        .route(
            "/{id}/recalculate-tax",
            post(recalculate_tax).route_layer(update()),
        )
        .merge(crate::payments::order_routes(gate))
}

// ── presenting ──────────────────────────────────────────────────────────────

const FIELDS_OF_SUMMARY: &str = "jsonb_build_object(\
    'id', o.id, 'orderNumber', o.order_number, 'status', o.status, \
    'paymentStatus', coalesce(o.payment_status, 'pending'), \
    'fulfillmentStatus', coalesce(o.fulfillment_status, 'unfulfilled'), \
    'approvalStatus', o.approval_status, 'source', coalesce(o.source, 'web'), \
    'channelId', o.channel_id, 'customerName', o.customer_name, \
    'customerEmail', o.customer_email, 'personId', o.person_id, \
    'companyId', pa.company_id, 'companyName', co.display_name, \
    'currency', coalesce(o.currency, 'EUR'), 'total', o.total::text, \
    'itemCount', coalesce(o.item_count, 0), 'totalQuantity', coalesce(o.total_quantity, 0), \
    'amountPaid', (select coalesce(sum(p.amount), 0)::text from commerce_payments p \
        where p.order_id = o.id and p.status = 'paid'), \
    'amountRefunded', (select coalesce(sum(r.amount), 0)::text from commerce_refunds r \
        where r.order_id = o.id and r.status = 'refunded'), \
    'createdAt', to_jsonb(o.created_at), 'updatedAt', to_jsonb(o.updated_at))";

const FROM_SUMMARY: &str = " from orders o \
    left join parties pa on pa.id = o.counterparty_id \
    left join companies co on co.id = pa.company_id";

fn summary(mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        for key in ["createdAt", "updatedAt"] {
            let stamp = iso(fields.get(key).unwrap_or(&Value::Null));
            fields.insert(key.to_owned(), stamp);
        }
        let placed = fields.get("createdAt").cloned().unwrap_or(Value::Null);
        fields.insert("placedAt".to_owned(), placed);
    }
    row
}

/// An address as the API writes it: `region`, where an import wrote `state`.
fn address(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut out = fields.clone();
            if let Some(state) = out.remove("state")
                && !out.contains_key("region")
            {
                out.insert("region".to_owned(), state);
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}

fn text_or_null(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// A percentage as text with two decimals (`"21.00"`); null stays null.
fn percent(value: Option<&Value>) -> Value {
    let number = match value {
        Some(Value::String(text)) => text.parse::<f64>().ok(),
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    };
    number.map_or(Value::Null, |n| json!(format!("{n:.2}")))
}

/// The VAT per rate as the API writes it: `{ rate, base, amount }`.
fn tax_lines(order: &Value) -> Value {
    let lines = order
        .get("taxLines")
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .map(|line| {
                    json!({
                        "rate": percent(line.get("rate")),
                        "base": amount(line.get("base").unwrap_or(&Value::Null), "0.00"),
                        "amount": amount(line.get("price").unwrap_or(&Value::Null), "0.00"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!(lines)
}

/// `vatTreatment`: as stored, `"imported"` for a store's order that has
/// none (the store's own tax stands), else null.
fn vat_treatment(order: &Value) -> Value {
    match order.get("vatTreatment").filter(|v| !v.is_null()) {
        Some(stored) => stored.clone(),
        None if order
            .get("externalOrderId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty()) =>
        {
            json!("imported")
        }
        None => Value::Null,
    }
}

fn item(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "productId": text_or_null(row, "productId"),
        "variantId": text_or_null(row, "variantId"),
        "sku": text_or_null(row, "sku"),
        "name": row["name"],
        "variantName": row.pointer("/properties/variantName").cloned().unwrap_or(Value::Null),
        "imageUrl": text_or_null(row, "imageUrl"),
        "quantity": row["quantity"],
        "fulfilledQuantity": row.get("fulfilledQuantity").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)),
        "unitPrice": amount(&row["unitPrice"], "0.00"),
        "discountAmount": amount(&row["discountAmount"], "0.00"),
        "taxAmount": amount(&row["taxAmount"], "0.00"),
        "taxRate": percent(row.get("taxRate")),
        "vatCategory": text_or_null(row, "vatCategory"),
        "total": amount(&row["total"], "0.00"),
    })
}

/// The order of the API from its row, items, the company behind its
/// counterparty and the invoice made from it.
#[allow(
    clippy::too_many_lines,
    reason = "one entry per property of the API's order"
)]
fn present(
    order: &Value,
    items: &[Value],
    company: Option<(String, Option<String>)>,
    invoice: Option<Value>,
    (paid, refunded): (Cents, Cents),
    approval: Value,
) -> Value {
    let (company_id, company_name) = company.map_or((Value::Null, Value::Null), |(id, name)| {
        (json!(id), json!(name))
    });
    let text = |key: &str| text_or_null(order, key);
    let created = iso(order.get("createdAt").unwrap_or(&Value::Null));
    let date = |key: &str| order.get(key).map_or(Value::Null, iso);
    Value::Object(
        [
            ("id", json!(order["id"])),
            ("orderNumber", json!(order["orderNumber"])),
            ("status", json!(order["status"])),
            (
                "paymentStatus",
                json!(
                    order
                        .get("paymentStatus")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!("pending"))
                ),
            ),
            (
                "fulfillmentStatus",
                json!(
                    order
                        .get("fulfillmentStatus")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!("unfulfilled"))
                ),
            ),
            ("approvalStatus", json!(order["approvalStatus"])),
            ("approval", approval),
            (
                "source",
                json!(
                    order
                        .get("source")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!("web"))
                ),
            ),
            ("channelId", json!(text("channelId"))),
            ("customerName", json!(text("customerName"))),
            ("customerEmail", json!(text("customerEmail"))),
            ("personId", json!(text("personId"))),
            ("companyId", json!(company_id)),
            ("companyName", json!(company_name)),
            (
                "currency",
                json!(
                    order
                        .get("currency")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!("EUR"))
                ),
            ),
            ("total", json!(amount(&order["total"], "0.00"))),
            (
                "itemCount",
                json!(
                    order
                        .get("itemCount")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!(0))
                ),
            ),
            (
                "totalQuantity",
                json!(
                    order
                        .get("totalQuantity")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!(0))
                ),
            ),
            ("placedAt", json!(created)),
            ("createdAt", json!(created)),
            ("updatedAt", json!(date("updatedAt"))),
            ("items", json!(items.iter().map(item).collect::<Vec<_>>())),
            ("subtotal", json!(amount(&order["subtotal"], "0.00"))),
            (
                "discountTotal",
                json!(amount(&order["discountTotal"], "0.00")),
            ),
            (
                "shippingTotal",
                json!(amount(&order["shippingTotal"], "0.00")),
            ),
            ("taxTotal", json!(amount(&order["taxTotal"], "0.00"))),
            (
                "pricesIncludeTax",
                json!(
                    order
                        .get("pricesIncludeTax")
                        .cloned()
                        .unwrap_or(json!(false))
                ),
            ),
            ("discountCode", json!(text("discountCode"))),
            ("discountId", json!(text("discountId"))),
            (
                "billingAddress",
                json!(order.get("billingAddress").map_or(Value::Null, address)),
            ),
            (
                "shippingAddress",
                json!(order.get("shippingAddress").map_or(Value::Null, address)),
            ),
            ("customerPhone", json!(text("customerPhone"))),
            ("customerReference", json!(text("customerReference"))),
            ("customerNote", json!(text("customerNote"))),
            ("internalNote", json!(text("internalNote"))),
            ("destinationCountry", json!(text("destinationCountry"))),
            ("buyerVatNumber", json!(text("buyerVatNumber"))),
            ("vatTreatment", vat_treatment(order)),
            (
                "viesUnavailable",
                json!(
                    order
                        .pointer("/metadata/viesUnavailable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                ),
            ),
            (
                "vatRelief",
                amount(
                    order.pointer("/metadata/vatRelief").unwrap_or(&Value::Null),
                    "0.00",
                ),
            ),
            ("taxLines", tax_lines(order)),
            ("paymentMethod", json!(text("paymentMethod"))),
            ("paymentReference", json!(text("paymentReference"))),
            ("paidAt", json!(date("paidAt"))),
            ("cancelledAt", json!(date("cancelledAt"))),
            ("cancelReason", json!(text("cancelReason"))),
            ("completedAt", json!(date("completedAt"))),
            ("externalOrderId", json!(text("externalOrderId"))),
            (
                "tags",
                json!(
                    order
                        .get("tags")
                        .filter(|v| v.is_array())
                        .cloned()
                        .unwrap_or(json!([]))
                ),
            ),
            ("amountPaid", json!(money::format(paid))),
            ("amountRefunded", json!(money::format(refunded))),
            ("metadata", public_metadata(order)),
            ("invoice", json!(invoice.unwrap_or(Value::Null))),
            ("editable", json!(domain_orders::editable(order, items))),
            (
                "cancellable",
                json!(domain_orders::cancellable(order, items)),
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect(),
    )
}

/// The metadata keys the API shows: what the screens read, nothing else an
/// import or integration may have written there.
fn public_metadata(order: &Value) -> Value {
    let mut shown = Map::new();
    if let Some(Value::Object(metadata)) = order.get("metadata") {
        for key in [
            "invoiceError",
            "overpaid",
            "viesUnavailable",
            "vatRelief",
            "shippingVat",
        ] {
            if let Some(value) = metadata.get(key) {
                shown.insert(key.to_owned(), value.clone());
            }
        }
    }
    Value::Object(shown)
}

/// The order `id` as the API presents it, on any connection.
pub(crate) async fn fetch(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let mut conn = db.acquire().await?;
    let Some(stored) = domain_orders::load(&mut conn, id, false).await? else {
        return Ok(None);
    };
    let company: Option<(String, Option<String>)> = sqlx::query_as(
        "select pa.company_id, co.display_name from parties pa \
         join companies co on co.id = pa.company_id \
         where pa.id = $1 and pa.company_id is not null limit 1",
    )
    .bind(stored.text("counterpartyId"))
    .fetch_optional(&mut *conn)
    .await?;
    let invoice: Option<(String, Option<String>, String)> = sqlx::query_as(
        "select id, invoice_number, status from invoices \
         where commerce_order_id = $1 and deleted_at is null \
         order by created_at desc, id desc limit 1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let invoice =
        invoice.map(|(id, number, status)| json!({ "id": id, "number": number, "status": status }));
    let amounts = weldsuite_commerce_domain::payments::service::amounts(&mut conn, id).await?;
    let approval = weldsuite_commerce_domain::approvals::approval_view(
        &mut conn,
        id,
        stored.order.get("metadata"),
    )
    .await?;
    Ok(Some(present(
        &stored.order,
        &stored.items,
        company,
        invoice,
        amounts,
        approval,
    )))
}

/// The event data of an order.
pub(crate) fn event(order: &Value) -> Value {
    json!({
        "id": order["id"],
        "orderNumber": order["orderNumber"],
        "status": order["status"],
        "paymentStatus": order["paymentStatus"],
        "total": order["total"],
        "currency": order["currency"],
        "customerName": order["customerName"],
        "customerEmail": order["customerEmail"],
        "personId": order["personId"],
        "companyId": order["companyId"],
        "source": order["source"],
    })
}

// ── list ────────────────────────────────────────────────────────────────────

/// Params `$1..$11`: search, status, payment status, fulfillment status,
/// source, channel, company, person, from, to (exclusive), approval status.
const WHERE_SQL: &str = " where o.deleted_at is null \
    and ($1::text is null or o.order_number ilike $1 or o.customer_name ilike $1 \
         or o.customer_email ilike $1 or o.external_order_id ilike $1) \
    and ($2::text is null or o.status = $2) \
    and ($3::text is null or o.payment_status = $3) \
    and ($4::text is null or o.fulfillment_status = $4) \
    and ($5::text is null or o.source = $5) \
    and ($6::text is null or o.channel_id = $6) \
    and ($7::text is null or pa.company_id = $7) \
    and ($8::text is null or o.person_id = $8) \
    and ($9::text is null or o.created_at >= $9::timestamp) \
    and ($10::text is null or o.created_at < $10::timestamp) and ($11::text is null or o.approval_status = $11)";

/// `(column, descending)` of a `sort`.
fn sort_of(sort: &str) -> Option<(&'static str, bool)> {
    Some(match sort {
        "createdAt" => ("o.created_at", false),
        "-createdAt" => ("o.created_at", true),
        "total" => ("o.total", false),
        "-total" => ("o.total", true),
        "orderNumber" => ("o.order_number", false),
        _ => return None,
    })
}

fn like(value: &str) -> String {
    format!("%{}%", crate::rules::like_literal(value))
}

/// A `from` / `to` day or instant as Postgres reads it; `to` is exclusive,
/// so a bare day takes the whole day.
fn bound(text: &str, upper: bool) -> Option<String> {
    let millis = js_date_parse(text)?;
    let end = if upper {
        millis
            + if text.trim().len() == 10 {
                86_400_000.0
            } else {
                1.0
            }
    } else {
        millis
    };
    js_iso_from_millis(end)
}

#[allow(
    clippy::too_many_lines,
    reason = "the filters, the keyset and the page"
)]
async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list orders";
    let query = query.as_deref();
    let param = |name: &str| query_set(query, name);
    let sort = param("sort").unwrap_or_else(|| "-createdAt".to_owned());
    let Some((column, descending)) = sort_of(&sort) else {
        return invalid("sort", "Unknown sort").respond(FAILED);
    };
    let mut from = None;
    let mut to = None;
    for (name, upper, slot) in [("from", false, &mut from), ("to", true, &mut to)] {
        if let Some(text) = param(name) {
            match bound(&text, upper) {
                Some(stamp) => *slot = Some(stamp),
                None => return invalid(name, "Must be an ISO date").respond(FAILED),
            }
        }
    }
    let limit = weldsuite_kit::parse_limit(param("limit").as_deref(), 50, 100);
    let search = param("search").map(|s| like(&s));
    let operator = if descending { "<" } else { ">" };
    let direction = if descending { "desc" } else { "asc" };
    let keyset = format!(
        " and ($12::text is null or not exists (select 1 from orders where id = $12) \
           or (({column}, o.id) {operator} (select {c}, c.id from orders c where c.id = $12)))",
        c = column.replace("o.", "c."),
    );
    let select = format!(
        "select {FIELDS_OF_SUMMARY}{FROM_SUMMARY}{WHERE_SQL}{keyset} \
         order by {column} {direction}, o.id {direction} limit $13"
    );
    let count = format!("select count(*){FROM_SUMMARY}{WHERE_SQL}");
    let cursor = param("cursor");
    macro_rules! bind_filters {
        ($q:expr) => {
            $q.bind(search.as_deref())
                .bind(param("status"))
                .bind(param("paymentStatus"))
                .bind(param("fulfillmentStatus"))
                .bind(param("source"))
                .bind(param("channelId"))
                .bind(param("companyId"))
                .bind(param("personId"))
                .bind(from.as_deref())
                .bind(to.as_deref())
                .bind(param("approvalStatus"))
        };
    }
    let rows: Result<Vec<Value>, sqlx::Error> =
        bind_filters!(sqlx::query_scalar(sqlx::AssertSqlSafe(select)))
            .bind(cursor.as_deref())
            .bind(i64::from(limit) + 1)
            .fetch_all(&caller.db)
            .await;
    let total: Result<i64, sqlx::Error> =
        bind_filters!(sqlx::query_scalar(sqlx::AssertSqlSafe(count)))
            .fetch_one(&caller.db)
            .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => weldsuite_kit::Page::of(
            rows.into_iter().map(summary).collect(),
            usize::try_from(limit).unwrap_or(50),
            |row: &Value| row["id"].as_str().unwrap_or_default(),
        )
        .into_list(u64::try_from(total).unwrap_or(0))
        .into_response(),
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch order";
    match fetch(&caller.db, &id).await {
        Ok(Some(order)) => Data(order).into_response(),
        Ok(None) => Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

// ── request bodies ──────────────────────────────────────────────────────────

fn read_id(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Field<String> {
    issues.text_with(
        fields,
        key,
        Presence::Nullish,
        Text::trimmed(Some(1), Some(30)),
    )
}

fn read_email(issues: &mut Issues, fields: &Map<String, Value>) -> Field<String> {
    let rules = Text {
        trim: true,
        format: Some(Format::Email),
        max: Some(255),
        ..Text::default()
    };
    match issues.text_with(fields, "customerEmail", Presence::Nullish, rules) {
        Field::Set(text) if text.is_empty() => Field::Null,
        other => other,
    }
}

fn read_items(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Vec<LineInput>> {
    issues
        .list(
            fields,
            "items",
            Presence::Optional,
            Some(1),
            Some(500),
            |issues, raw| {
                let item = issues.object(raw)?;
                let before = issues.count();
                let id = read_id(issues, item, "id").into_option();
                let variant_id = read_id(issues, item, "variantId").into_option();
                let product_id = read_id(issues, item, "productId").into_option();
                let name = read_text(issues, item, "name", 255).into_option();
                let quantity = issues
                    .whole_number(
                        item,
                        "quantity",
                        Presence::Required,
                        Number {
                            min: Some(1.0),
                            max: Some(100_000.0),
                            ..Number::default()
                        },
                    )
                    .into_option();
                let unit_price =
                    read_money(issues, item, "unitPrice", Presence::Nullish).into_option();
                if issues.count() > before {
                    return None;
                }
                let free = variant_id.is_none() && product_id.is_none() && id.is_none();
                if free && (name.is_none() || unit_price.is_none()) {
                    issues.custom_here(
                        "A line names a variant or product, or has a name and a unitPrice",
                    );
                    return None;
                }
                Some(LineInput {
                    id,
                    product_id,
                    variant_id,
                    name,
                    quantity: quantity?,
                    unit_price,
                })
            },
        )
        .into_option()
}

/// What the create and quote bodies share.
struct OrderBody {
    company_id: Option<String>,
    person_id: Option<String>,
    customer_name: Option<String>,
    customer_email: Option<String>,
    customer_phone: Option<String>,
    currency: String,
    items: Vec<LineInput>,
    discount_code: Option<String>,
    shipping: Cents,
    billing_address: Option<Value>,
    shipping_address: Option<Value>,
    customer_reference: Option<String>,
    customer_note: Option<String>,
    internal_note: Option<String>,
    prices_include_tax: bool,
    buyer_vat_number: Option<String>,
    status: String,
    tags: Vec<String>,
    idempotency_key: Option<String>,
}

fn read_vat_number(issues: &mut Issues, fields: &Map<String, Value>) -> Field<String> {
    read_text(issues, fields, "buyerVatNumber", 50)
}

fn read_tags(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Vec<String>> {
    issues
        .list(
            fields,
            "tags",
            Presence::Optional,
            None,
            Some(50),
            |issues, tag| issues.item_text(tag, Text::trimmed(Some(1), Some(50))),
        )
        .into_option()
}

fn read_order(issues: &mut Issues, fields: &Map<String, Value>) -> OrderBody {
    OrderBody {
        company_id: read_id(issues, fields, "companyId").into_option(),
        person_id: read_id(issues, fields, "personId").into_option(),
        customer_name: read_text(issues, fields, "customerName", 255).into_option(),
        customer_email: read_email(issues, fields).into_option(),
        customer_phone: read_text(issues, fields, "customerPhone", 50).into_option(),
        currency: read_currency(issues, fields, Presence::Required)
            .into_option()
            .unwrap_or_default(),
        items: read_items(issues, fields).unwrap_or_default(),
        discount_code: read_text(issues, fields, "discountCode", 100).into_option(),
        shipping: read_money(issues, fields, "shippingTotal", Presence::Nullish)
            .into_option()
            .unwrap_or(0),
        billing_address: read_address(issues, fields, "billingAddress").into_option(),
        shipping_address: read_address(issues, fields, "shippingAddress").into_option(),
        customer_reference: read_text(issues, fields, "customerReference", 100).into_option(),
        customer_note: read_text(issues, fields, "customerNote", 5000).into_option(),
        internal_note: read_text(issues, fields, "internalNote", 5000).into_option(),
        prices_include_tax: issues
            .boolean(fields, "pricesIncludeTax", Presence::Optional)
            .into_option()
            .unwrap_or(true),
        buyer_vat_number: read_vat_number(issues, fields).into_option(),
        status: issues
            .choice(
                fields,
                "status",
                Presence::Optional,
                &["pending", "confirmed"],
            )
            .into_option()
            .unwrap_or_else(|| "confirmed".to_owned()),
        tags: read_tags(issues, fields).unwrap_or_default(),
        idempotency_key: read_text(issues, fields, "idempotencyKey", 100).into_option(),
    }
}

fn line_json(
    line: &weldsuite_commerce_domain::orders::lines::Line,
    discount: Cents,
    total: Cents,
    vat: Option<&weldsuite_commerce_domain::vat::VatLine>,
) -> Value {
    json!({
        "variantId": line.variant_id,
        "productId": line.product_id,
        "sku": line.sku,
        "name": line.name,
        "variantName": line.variant_name,
        "quantity": line.quantity,
        "unitPrice": money::format(line.unit_price),
        "discountAmount": money::format(discount),
        "taxRate": vat.map(|v| weldsuite_commerce_domain::vat::rate_percent(v.rate_bps)),
        "taxAmount": money::format(vat.map_or(0, |v| v.tax)),
        "vatCategory": vat.map_or(line.vat_category.as_str(), |v| v.category),
        "total": money::format(total),
        "problem": line.problem,
    })
}

/// `POST /quote`: the order priced, nothing written. One line per item, in
/// the request's order; a bad code is `discountProblem`, not an error.
async fn quote(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to quote order";
    let body = match validate(&headers, &body, read_order) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let shipping_country = country_of(body.shipping_address.as_ref());
    let billing_country = country_of(body.billing_address.as_ref());
    let result = async {
        let mut conn = caller.db.acquire().await.map_err(refuse_db)?;
        plan::quote(
            &mut conn,
            &QuoteInput {
                tax: Taxation {
                    http: state.http.as_ref(),
                },
                buyer: Buyer {
                    prices_include_tax: body.prices_include_tax,
                    shipping_country: shipping_country.as_deref(),
                    billing_country: billing_country.as_deref(),
                    vat_number: body.buyer_vat_number.as_deref(),
                },
                currency: &body.currency,
                lines: &body.items,
                discount_code: body.discount_code.as_deref(),
                shipping: body.shipping,
                company_id: body.company_id.as_deref(),
                person_id: body.person_id.as_deref(),
                email: body.customer_email.as_deref(),
            },
        )
        .await
    }
    .await;
    match result {
        Ok(quote) => {
            let plan = &quote.plan;
            let vat = plan.vat.as_ref();
            Data(json!({
                "currency": body.currency,
                "lines": quote.lines.iter().enumerate()
                    .map(|(index, line)| line_json(
                        line,
                        plan.line_discounts[index],
                        plan.line_total(&quote.lines, index),
                        vat.and_then(|v| v.lines.get(index)),
                    ))
                    .collect::<Vec<_>>(),
                "vatTreatment": vat.map(|v| v.treatment),
                "destinationCountry": vat.map(|v| v.destination_country.clone()),
                "viesUnavailable": vat.is_some_and(|v| v.vies_unavailable),
                "pricesIncludeTax": body.prices_include_tax,
                "vatRelief": money::format(vat.map_or(0, |v| v.vat_relief)),
                "taxLines": vat.map(|v| v.tax_lines.iter().map(|t| json!({
                    "rate": weldsuite_commerce_domain::vat::rate_percent(t.rate_bps),
                    "base": money::format(t.base),
                    "amount": money::format(t.amount),
                })).collect::<Vec<_>>()).unwrap_or_default(),
                "subtotal": money::format(plan.totals.subtotal),
                "discountTotal": money::format(plan.totals.discount_total),
                "shippingTotal": money::format(plan.totals.shipping_total),
                "taxTotal": money::format(plan.totals.tax_total),
                "total": money::format(plan.totals.total),
                "discount": plan.discount.as_ref().map(|d| json!({
                    "id": d.id, "code": d.code, "type": d.kind, "value": d.value,
                })),
                "discountProblem": plan.discount_problem.map(weldsuite_commerce_domain::discount::Problem::as_str),
            }))
            .into_response()
        }
        Err(error) => refuse(error).respond(FAILED),
    }
}

/// A failed connection checkout as the domain's database error.
fn refuse_db(error: sqlx::Error) -> weldsuite_commerce_domain::Error {
    weldsuite_commerce_domain::Error::from(error)
}

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create order";
    let body = match validate(&headers, &body, read_order) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
        .or(body.idempotency_key.clone());
    if key.as_ref().is_some_and(|k| k.chars().count() > 100) {
        return invalid("idempotencyKey", "At most 100 characters").respond(FAILED);
    }
    let new = NewOrder {
        source: "manual".to_owned(),
        channel_id: None,
        currency: body.currency,
        company_id: body.company_id,
        person_id: body.person_id,
        customer_name: body.customer_name,
        customer_email: body.customer_email,
        customer_phone: body.customer_phone,
        lines: body.items,
        discount_code: body.discount_code,
        shipping: body.shipping,
        billing_address: body.billing_address,
        shipping_address: body.shipping_address,
        customer_reference: body.customer_reference,
        customer_note: body.customer_note,
        internal_note: body.internal_note,
        prices_include_tax: body.prices_include_tax,
        buyer_vat_number: body.buyer_vat_number,
        status: body.status,
        tags: body.tags,
        created_by: caller.user_id.clone(),
        idempotency_key: key,
    };
    let created = async {
        let mut tx = caller.db.begin().await?;
        let tax = Taxation {
            http: state.http.as_ref(),
        };
        let created = write::create(&mut tx, &tax, &new).await.map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(created)
    }
    .await;
    match created {
        Ok(created) => {
            if !created.replayed
                && let Ok(Some(order)) = fetch(&caller.db, &created.id).await
            {
                caller.publish(&state, ORDER_CREATED, &created.id, &event(&order));
            }
            Created(json!({ "id": created.id, "orderNumber": created.order_number }))
                .into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

fn read_patch(issues: &mut Issues, fields: &Map<String, Value>) -> Patch {
    let shipping_total =
        read_money(issues, fields, "shippingTotal", Presence::Optional).into_option();
    Patch {
        billing_address: read_address(issues, fields, "billingAddress"),
        shipping_address: read_address(issues, fields, "shippingAddress"),
        customer_reference: read_text(issues, fields, "customerReference", 100),
        customer_note: read_text(issues, fields, "customerNote", 5000),
        internal_note: read_text(issues, fields, "internalNote", 5000),
        tags: read_tags(issues, fields),
        status: issues
            .choice(
                fields,
                "status",
                Presence::Optional,
                &["pending", "confirmed", "processing", "completed"],
            )
            .into_option(),
        company_id: read_id(issues, fields, "companyId"),
        person_id: read_id(issues, fields, "personId"),
        customer_name: read_text(issues, fields, "customerName", 255),
        customer_email: read_email(issues, fields),
        customer_phone: read_text(issues, fields, "customerPhone", 50),
        shipping_total,
        discount_code: read_text(issues, fields, "discountCode", 100),
        buyer_vat_number: read_vat_number(issues, fields),
        prices_include_tax: issues
            .boolean(fields, "pricesIncludeTax", Presence::Optional)
            .into_option(),
        items: read_items(issues, fields),
    }
}

async fn patch_order(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update order";
    let (headers, body) = body_or_empty(&headers, &body);
    let patch = match validate(&headers, &body, read_patch) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let done = async {
        let mut tx = caller.db.begin().await?;
        let tax = Taxation {
            http: state.http.as_ref(),
        };
        let done = write::update(&mut tx, &tax, &id, &patch)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(done)
    }
    .await;
    match done {
        Ok(done) => {
            respond_with_order(
                &state,
                &caller,
                &id,
                &[ORDER_UPDATED],
                done.completed.then_some(ORDER_COMPLETED),
                FAILED,
            )
            .await
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The order after a write, with its events published.
async fn respond_with_order(
    state: &CommerceState,
    caller: &Caller,
    id: &str,
    events: &[weldsuite_catalogs::entity_events::EventName],
    extra: Option<weldsuite_catalogs::entity_events::EventName>,
    failed: &str,
) -> Response {
    match fetch(&caller.db, id).await {
        Ok(Some(order)) => {
            let data = event(&order);
            for name in events.iter().copied().chain(extra) {
                caller.publish(state, name, id, &data);
            }
            Data(order).into_response()
        }
        Ok(None) => Refusal::not_found("Order", id).respond(failed),
        Err(error) => internal(&error, failed),
    }
}

/// `POST /:id/recalculate-tax`: the VAT of an editable order again, nothing
/// else changed. 409 `ORDER_TAX_LOCKED` once the order is not editable.
async fn recalculate_tax(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to recalculate the VAT of the order";
    let done = async {
        let mut tx = caller.db.begin().await?;
        let tax = Taxation {
            http: state.http.as_ref(),
        };
        write::recalculate(&mut tx, &tax, &id)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(())
    }
    .await;
    match done {
        Ok(()) => respond_with_order(&state, &caller, &id, &[ORDER_UPDATED], None, FAILED).await,
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn cancel(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to cancel order";
    let (headers, body) = body_or_empty(&headers, &body);
    let reason = match validate(&headers, &body, |issues, fields| {
        read_text(issues, fields, "reason", 500).into_option()
    }) {
        Ok(reason) => reason,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let done = async {
        let mut tx = caller.db.begin().await?;
        write::cancel(&mut tx, &id, reason.as_deref())
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(())
    }
    .await;
    match done {
        Ok(()) => respond_with_order(&state, &caller, &id, &[ORDER_CANCELLED], None, FAILED).await,
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn mark_paid(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to mark order paid";
    let (headers, body) = body_or_empty(&headers, &body);
    let payment = match validate(&headers, &body, |issues, fields| Payment {
        paid_at: read_date(issues, fields, "paidAt", Presence::Nullish).into_option(),
        method: read_text(issues, fields, "paymentMethod", 100).into_option(),
        reference: read_text(issues, fields, "paymentReference", 255).into_option(),
    }) {
        Ok(payment) => payment,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let done = async {
        let mut tx = caller.db.begin().await?;
        write::mark_paid(&mut tx, &id, &payment)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(())
    }
    .await;
    match done {
        Ok(()) => respond_with_order(&state, &caller, &id, &[ORDER_PAID], None, FAILED).await,
        Err(refusal) => refusal.respond(FAILED),
    }
}

// ── approvals ───────────────────────────────────────────────────────────────

/// The staff member as an approval keeps them: `{ userId, name, email }`,
/// the name read from the master `users` table when the server has one.
async fn staff_actor(caller: &Caller) -> Value {
    let found: Option<(Option<String>, Option<String>, String)> = match &caller.registry {
        Some(master) => {
            sqlx::query_as("select first_name, last_name, email from users where id = $1")
                .bind(&caller.user_id)
                .fetch_optional(master)
                .await
                .ok()
                .flatten()
        }
        None => None,
    };
    let (name, email) = found.map_or((None, None), |(first, last, email)| {
        let name = [first.as_deref(), last.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        (Some(name).filter(|n| !n.trim().is_empty()), Some(email))
    });
    json!({
        "userId": caller.user_id,
        "name": name.or_else(|| email.clone()).unwrap_or_else(|| caller.user_id.clone()),
        "email": email,
    })
}

/// Approve or reject a pending order as staff (an override of the company's
/// approvers): `{ comment? }`, 409 `NOT_PENDING` when it is not pending.
async fn decide_as_staff(
    state: CommerceState,
    caller: Caller,
    id: String,
    headers: HeaderMap,
    body: Bytes,
    approve: bool,
) -> Response {
    const FAILED: &str = "Failed to decide the order's approval";
    let (headers, body) = body_or_empty(&headers, &body);
    let comment = match validate(&headers, &body, |issues, fields| {
        read_text(issues, fields, "comment", 2000).into_option()
    }) {
        Ok(comment) => comment,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let staff = staff_actor(&caller).await;
    let by = weldsuite_commerce_domain::approvals::Decider {
        person_id: None,
        staff: Some(staff.clone()),
    };
    let decided = async {
        let mut tx = caller.db.begin().await?;
        let decided = weldsuite_commerce_domain::approvals::decide(
            &mut tx,
            &id,
            approve,
            comment.as_deref(),
            &by,
        )
        .await
        .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(decided)
    }
    .await;
    let decided = match decided {
        Ok(decided) => decided,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let follow = crate::decide::Followup {
        db: &caller.db,
        events: &state.events,
        ctx: &caller.events,
        config: &state.payments,
        http: state.http.as_ref(),
        mail: &state.mail,
        workspace_id: &caller.workspace_id,
        user_id: &caller.user_id,
        locale: weldsuite_emails::EmailLocale::En,
    };
    crate::decide::after_decision(
        &follow,
        &decided,
        comment.as_deref(),
        staff["name"].as_str(),
    )
    .await;
    match fetch(&caller.db, &id).await {
        Ok(Some(order)) => Data(order).into_response(),
        Ok(None) => Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

async fn approve(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    decide_as_staff(state, caller, id, headers, body, true).await
}

async fn reject(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    decide_as_staff(state, caller, id, headers, body, false).await
}
