//! `/api/orders` (`commerce-api/src/routes/orders/index.ts`): the flat order
//! surface, its line items, and the sales tax endpoints
//! (`POST /calculate-tax` for a cart, `POST /:id/calculate-tax` for a stored
//! order, and the `calculateTax` flag of `POST` and `PATCH`). The tax
//! engine is WeldBooks' ([`crate::order_tax`]); a failing engine answers 503
//! and writes nothing.
//!
//! Permissions: `orders:read` | `orders:create` | `orders:update` | `orders:delete`.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Filter, Listing, fetch, page_list, write_failed};
use crate::order_tax::{
    Application, LineInput, TaxFailure, TaxInput, TaxOptions, TaxOutcome,
    calculate_order_sales_tax, calculate_order_tax, load_order_tax_items, order_tax_lock_reason,
    persist_order_tax, write_item_tax,
};
use crate::sales_tax::TaxUse;
use crate::tables;
use crate::{Caller, CommerceState, Refusal, all, now, positive, validate};

const ORDER_LIST: (&str, &str) = listing_as!(row_of!(orders); "orders";
    "($2::boolean or t.customer_id = $3::text)",
    "($4::boolean or t.status = $5::text)",
    "($6::boolean or t.fulfillment_status = $7::text)",
    "($8::boolean or t.order_number like $9::text)";
    10, 11, 12; "$13");

const LISTING: Listing = Listing {
    table: &tables::ORDERS,
    filters: &[
        Filter::eq("customerId"),
        Filter::eq("status"),
        Filter::eq("fulfillmentStatus"),
        Filter::like("search"),
    ],
    list_sql: ORDER_LIST.0,
    count_sql: ORDER_LIST.1,
    // `countWhere` is the filters alone.
    slice_count: false,
};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::ORDERS_READ]);
    let create = || gate.require([perm::ORDERS_CREATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_order).route_layer(create()))
        .route("/calculate-tax", post(cart_tax).route_layer(create()))
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::patch(update_order).route_layer(gate.require([perm::ORDERS_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([perm::ORDERS_DELETE])),
        )
        .route("/{id}/items", get(items).route_layer(read()))
        .route("/{id}/calculate-tax", post(order_tax).route_layer(read()))
}

/// A tax calculation's failure as the route answers it.
fn tax_failed(failure: TaxFailure, message: &str) -> Response {
    match failure {
        TaxFailure::Tax(error) => error.respond(),
        TaxFailure::Database(error) => Refusal::Database(error).respond(message),
    }
}

async fn list(
    State(_state): State<CommerceState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    match fetch(LISTING, &caller.db, query.as_deref()).await {
        Ok(fetched) => page_list(fetched.rows, fetched.limit, fetched.total),
        Err(error) => error.respond("Failed to list orders"),
    }
}

async fn detail(
    State(_state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to fetch order";
    match tables::ORDERS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

/// Line items in insertion (`id`) order.
async fn items(
    State(_state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to list order items";
    let found: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from orders where id = $1 and deleted_at is null limit 1")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await;
    match found {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(order_items),
        " from order_items t where t.order_id = $1 order by t.id"
    ))
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => all(rows
            .into_iter()
            .map(|row| tables::ORDER_ITEMS.js(row))
            .collect()),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

// ---------------------------------------------------------------------------
// Bodies (`calculate-tax-schemas.ts`, `createOrderSchema`)
// ---------------------------------------------------------------------------

fn is_iso_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
}

/// `isoDaySchema.optional()`.
fn read_date(issues: &mut Issues, fields: &Map<String, Value>) -> Option<String> {
    issues
        .pattern(
            fields,
            "date",
            Presence::Optional,
            None,
            None,
            is_iso_day,
            "Expected YYYY-MM-DD",
        )
        .into_option()
}

/// `taxUseSchema.optional()`.
fn read_use(issues: &mut Issues, fields: &Map<String, Value>) -> Option<TaxUse> {
    issues
        .choice(
            fields,
            "customerUse",
            Presence::Optional,
            &["business", "personal"],
        )
        .into_option()
        .and_then(|u| TaxUse::parse(&u))
}

/// `taxAddressSchema.nullish()`: the address, its unknown keys stripped.
fn read_address(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<Value> {
    const FIELDS: [(&str, usize); 10] = [
        ("line1", 255),
        ("line2", 255),
        ("street", 255),
        ("houseNumber", 30),
        ("city", 120),
        ("state", 100),
        ("province", 100),
        ("postalCode", 20),
        ("country", 100),
        ("county", 120),
    ];
    issues
        .nested(fields, key, Presence::Nullish, |issues, address| {
            let mut kept = Map::new();
            for (name, max) in FIELDS {
                issues.text_with(
                    address,
                    name,
                    Presence::Nullish,
                    Text::length(None, Some(max)),
                );
                if let Some(value) = address.get(name) {
                    kept.insert(name.to_owned(), value.clone());
                }
            }
            Value::Object(kept)
        })
        .into_option()
}

/// `taxLineSchema`.
fn read_line(issues: &mut Issues, item: &Value) -> Option<LineInput> {
    let line = issues.object(item)?;
    let before = issues.count();
    let line_id = issues.text_with(
        line,
        "lineId",
        Presence::Required,
        Text::length(Some(1), Some(60)),
    );
    let product_id = issues.text_with(
        line,
        "productId",
        Presence::Nullish,
        Text::length(None, Some(30)),
    );
    let amount = issues.number(
        line,
        "amount",
        Presence::Required,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    positive(issues, line, "quantity", Presence::Optional, false);
    let tax_code = issues.text_with(
        line,
        "taxCode",
        Presence::Nullish,
        Text::length(None, Some(50)),
    );
    let tax_included = issues.boolean(line, "taxIncluded", Presence::Optional);
    if issues.count() > before {
        return None;
    }
    Some(LineInput {
        line_id: line_id.into_option()?,
        product_id: product_id.into_option(),
        amount: amount.into_option()?,
        tax_code: tax_code.into_option(),
        tax_included: tax_included.into_option().unwrap_or(false),
    })
}

/// `calculateCartTaxSchema`.
fn read_cart(issues: &mut Issues, fields: &Map<String, Value>) -> TaxInput {
    let lines = issues
        .list(
            fields,
            "lines",
            Presence::Required,
            None,
            Some(500),
            read_line,
        )
        .into_option()
        .unwrap_or_default();
    let shipping_amount = issues
        .number(
            fields,
            "shippingAmount",
            Presence::Optional,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option();
    let ship_to = read_address(issues, fields, "shipTo");
    let bill_to = read_address(issues, fields, "billTo");
    let customer_party_id = issues
        .text_with(
            fields,
            "customerPartyId",
            Presence::Nullish,
            Text::length(None, Some(30)),
        )
        .into_option();
    let customer_use = read_use(issues, fields);
    let date = read_date(issues, fields);
    let currency = match issues.text_with(fields, "currency", Presence::Optional, Text::default()) {
        Field::Set(currency) => {
            issues.string_length("currency", 3, currency.encode_utf16().count());
            currency
        }
        _ => "USD".to_owned(),
    };
    let marketplace_facilitated = issues
        .boolean(fields, "marketplaceFacilitated", Presence::Optional)
        .into_option()
        .unwrap_or(false);
    TaxInput {
        order_id: None,
        lines,
        shipping_amount: shipping_amount.unwrap_or(0.0),
        ship_to,
        bill_to,
        customer_party_id,
        customer_use,
        date,
        currency,
        marketplace_facilitated,
        tax_exempt: false,
        extra_warnings: Vec::new(),
    }
}

/// `calculateOrderTaxSchema`: `apply` and the options.
fn read_order_tax(issues: &mut Issues, fields: &Map<String, Value>) -> (bool, TaxOptions) {
    let apply = issues
        .boolean(fields, "apply", Presence::Optional)
        .into_option()
        == Some(true);
    let date = read_date(issues, fields);
    let customer_use = read_use(issues, fields);
    let marketplace_facilitated = issues
        .boolean(fields, "marketplaceFacilitated", Presence::Optional)
        .into_option()
        .unwrap_or(false);
    (
        apply,
        TaxOptions {
            date,
            customer_use,
            marketplace_facilitated,
        },
    )
}

/// `createOrderSchema` (`.passthrough()`; `updateOrderSchema` is the same,
/// every field already optional): the body as it came.
fn read_order(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    issues.text_with(
        fields,
        "orderNumber",
        Presence::Optional,
        Text::length(None, Some(100)),
    );
    issues.text_with(fields, "customerId", Presence::Nullish, Text::default());
    issues.text_with(fields, "websiteId", Presence::Nullish, Text::default());
    issues.text_with(
        fields,
        "status",
        Presence::Optional,
        Text::length(None, Some(30)),
    );
    issues.text_with(
        fields,
        "currency",
        Presence::Optional,
        Text::length(None, Some(10)),
    );
    for key in ["subtotal", "taxTotal", "total"] {
        issues.string_or_number(fields, key, Presence::Optional);
    }
    fields.clone()
}

// ---------------------------------------------------------------------------
// Tax endpoints
// ---------------------------------------------------------------------------

/// `POST /calculate-tax`: prices a cart or draft; nothing is written.
async fn cart_tax(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to calculate tax";
    let input = match validate(&headers, &body, read_cart) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let keyring = caller.overrides.keyring(&state);
    match calculate_order_sales_tax(&caller.db, &keyring, &input).await {
        Ok(outcome) => Data(Value::Object(outcome.response())).into_response(),
        Err(failure) => tax_failed(failure, FAILED),
    }
}

/// The order event's data: `{ id, orderNumber, status, total, currency, customerId, customerEmail }`.
fn order_event(id: &str, fields: [(&str, Option<Value>); 6]) -> Value {
    let mut data = Map::new();
    data.insert("id".to_owned(), json!(id));
    for (key, value) in fields {
        if let Some(value) = value {
            data.insert(key.to_owned(), value);
        }
    }
    Value::Object(data)
}

/// `POST /:id/calculate-tax`: recalculates a stored order; with `apply`
/// (needs `orders:update`) writes it. A paid or cancelled order can be
/// previewed, not applied.
async fn order_tax(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to calculate order tax";
    let (apply, options) = match validate(&headers, &body, read_order_tax) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if apply && !caller.can(perm::ORDERS_UPDATE) {
        return ApiError::forbidden()
            .with_message("You do not have permission to apply tax to an order")
            .into_response();
    }
    let order = match tables::ORDERS.find_live(&caller.db, &id).await {
        Ok(Some(Value::Object(order))) => order,
        Ok(_) => return Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    if apply && let Some(locked) = order_tax_lock_reason(&order) {
        return locked_response(locked);
    }
    let items = match load_order_tax_items(&caller.db, &id).await {
        Ok(items) => items,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let keyring = caller.overrides.keyring(&state);
    let (outcome, application) =
        match calculate_order_tax(&caller.db, &keyring, &order, &items, &options).await {
            Ok(calculated) => calculated,
            Err(failure) => return tax_failed(failure, FAILED),
        };
    let mut response = outcome.response();
    let application = match application {
        Some(application) if apply => application,
        _ => {
            response.insert("applied".to_owned(), json!(false));
            return Data(Value::Object(response)).into_response();
        }
    };
    if let Err(error) = persist_order_tax(&caller.db, &id, &application).await {
        return Refusal::Database(error).respond(FAILED);
    }
    let field = |key: &str| Some(order.get(key).cloned().unwrap_or(Value::Null));
    caller.publish(
        &state,
        ev::COMMERCE_ORDER_UPDATED,
        &id,
        &order_event(
            &id,
            [
                ("orderNumber", field("orderNumber")),
                ("status", field("status")),
                ("total", Some(json!(application.total))),
                ("currency", field("currency")),
                ("customerId", field("customerId")),
                ("customerEmail", field("customerEmail")),
            ],
        ),
    );
    response.insert("applied".to_owned(), json!(true));
    response.insert("order".to_owned(), application.applied(&id));
    Data(Value::Object(response)).into_response()
}

/// 409 `ORDER_TAX_LOCKED`.
fn locked_response(message: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": { "code": "ORDER_TAX_LOCKED", "message": message } })),
    )
        .into_response()
}

/// `{ id, tax, order? }` or `{ id }`.
fn written(id: &str, tax: Option<&TaxOutcome>, application: Option<&Application>) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(id));
    if let Some(tax) = tax {
        out.insert("tax".to_owned(), Value::Object(tax.response()));
        if let Some(application) = application {
            out.insert("order".to_owned(), application.applied(id));
        }
    }
    Value::Object(out)
}

/// `<prefix>-<Date.now() base 36>-<4 random base-36 characters>` (`ORD-…`, `RMA-…`).
pub(crate) fn numbered(prefix: &str) -> String {
    const BASE36_UPPER: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let millis = u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(0);
    let mut stamp = Vec::new();
    let mut n = millis;
    loop {
        stamp.push(BASE36_UPPER[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    stamp.reverse();
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).unwrap_or_default();
    let random: String = bytes
        .iter()
        .map(|b| char::from(BASE36_UPPER[usize::from(*b) % 36]))
        .collect();
    format!("{prefix}-{}-{random}", String::from_utf8_lossy(&stamp))
}

async fn create_order(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create order";
    let mut data = match validate(&headers, &body, read_order) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    // `calculateTax` is a request flag, not an order column.
    let calculate = data.remove("calculateTax") == Some(Value::Bool(true));
    let id = generate_id("ord");
    let now = now();
    let number = match data.get("orderNumber") {
        Some(Value::String(number)) if !number.is_empty() => number.clone(),
        _ => numbered("ORD"),
    };

    // Tax first: an engine failure refuses the order instead of storing it with a guessed tax.
    let mut tax: Option<TaxOutcome> = None;
    let mut application: Option<Application> = None;
    if calculate {
        let mut subject = data.clone();
        subject.insert("id".to_owned(), json!(id));
        subject.insert("createdAt".to_owned(), json!(now));
        let keyring = caller.overrides.keyring(&state);
        match calculate_order_tax(&caller.db, &keyring, &subject, &[], &TaxOptions::default()).await
        {
            Ok((outcome, applied)) => {
                tax = Some(outcome);
                application = applied;
            }
            Err(failure) => return tax_failed(failure, FAILED),
        }
    }

    let t = &tables::ORDERS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(id));
    values.extend(t.values(&data));
    if let Some(application) = &application {
        for (prop, value) in application.order_fields() {
            t.set(&mut values, prop, value);
        }
    }
    t.set(&mut values, "orderNumber", json!(number));
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = t
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, FAILED);
    }
    let total = application
        .as_ref()
        .map(|a| json!(a.total))
        .or_else(|| data.get("total").cloned());
    caller.publish(
        &state,
        ev::COMMERCE_ORDER_CREATED,
        &id,
        &order_event(
            &id,
            [
                ("orderNumber", Some(json!(number))),
                ("status", data.get("status").cloned()),
                ("total", total),
                ("currency", data.get("currency").cloned()),
                ("customerId", data.get("customerId").cloned()),
                ("customerEmail", data.get("customerEmail").cloned()),
            ],
        ),
    );
    Created(written(&id, tax.as_ref(), None)).into_response()
}

async fn update_order(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update order";
    let mut data = match validate(&headers, &body, read_order) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let calculate = data.remove("calculateTax") == Some(Value::Bool(true));
    let existing = match tables::ORDERS.find_live(&caller.db, &id).await {
        Ok(Some(Value::Object(existing))) => existing,
        Ok(_) => return Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let mut update = Map::new();
    update.insert("updatedAt".to_owned(), json!(now()));
    update.extend(data.iter().map(|(k, v)| (k.clone(), v.clone())));
    // A body `updatedAt` is a string, which Drizzle cannot write.
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };

    // Tax first, on the order as it will be after this write.
    let mut tax: Option<TaxOutcome> = None;
    let mut application: Option<Application> = None;
    if calculate {
        if let Some(locked) = order_tax_lock_reason(&existing) {
            return locked_response(locked);
        }
        let items = match load_order_tax_items(&caller.db, &id).await {
            Ok(items) => items,
            Err(error) => return Refusal::Database(error).respond(FAILED),
        };
        let mut subject = existing.clone();
        subject.extend(update.iter().map(|(k, v)| (k.clone(), v.clone())));
        let keyring = caller.overrides.keyring(&state);
        match calculate_order_tax(
            &caller.db,
            &keyring,
            &subject,
            &items,
            &TaxOptions::default(),
        )
        .await
        {
            Ok((outcome, applied)) => {
                tax = Some(outcome);
                application = applied;
            }
            Err(failure) => return tax_failed(failure, FAILED),
        }
        if let Some(application) = &application {
            for (prop, value) in application.order_fields() {
                update.insert(prop.to_owned(), value);
            }
        }
    }

    let t = &tables::ORDERS;
    let values = t.values(&update);
    let written_ok = match &application {
        Some(application) => {
            async {
                let mut tx = caller
                    .db
                    .begin()
                    .await
                    .map_err(crate::table::WriteError::Database)?;
                t.patch(&mut *tx, &id, values, true, trusted).await?;
                write_item_tax(&mut tx, application)
                    .await
                    .map_err(crate::table::WriteError::Database)?;
                tx.commit()
                    .await
                    .map_err(crate::table::WriteError::Database)
            }
            .await
        }
        None => t
            .patch(&caller.db, &id, values, true, trusted)
            .await
            .map(|_| ()),
    };
    if let Err(error) = written_ok {
        return write_failed(&error, FAILED);
    }
    let either = |key: &str| {
        Some(
            update
                .get(key)
                .filter(|v| !v.is_null())
                .or_else(|| existing.get(key))
                .cloned()
                .unwrap_or(Value::Null),
        )
    };
    let stored = |key: &str| Some(existing.get(key).cloned().unwrap_or(Value::Null));
    caller.publish(
        &state,
        ev::COMMERCE_ORDER_UPDATED,
        &id,
        &order_event(
            &id,
            [
                ("orderNumber", stored("orderNumber")),
                ("status", either("status")),
                ("total", either("total")),
                ("currency", either("currency")),
                ("customerId", stored("customerId")),
                ("customerEmail", stored("customerEmail")),
            ],
        ),
    );
    Data(written(&id, tax.as_ref(), application.as_ref())).into_response()
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete order";
    let existing = match tables::ORDERS.find_live(&caller.db, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return Refusal::not_found("Order", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    if let Err(error) = crate::crud::soft_delete(&caller.db, &tables::ORDERS, &id).await {
        return write_failed(&error, FAILED);
    }
    let number = existing.get("orderNumber").cloned().unwrap_or(Value::Null);
    caller.publish(
        &state,
        ev::COMMERCE_ORDER_DELETED,
        &id,
        &json!({ "id": id, "orderNumber": number }),
    );
    NoContent.into_response()
}
