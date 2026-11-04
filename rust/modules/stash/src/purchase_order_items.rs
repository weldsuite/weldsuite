//! `/api/purchase-orders/:id/items`: the lines of a purchase order and the
//! `WeldFlow` project each one's cost belongs to (FLOW-019;
//! `routes/purchase-orders/index.ts`, `services/purchase-order-items.ts`).
//!
//! ```text
//! GET    /:id/items            the lines, oldest first
//! POST   /:id/items            add a line
//! PATCH  /:id/items/:itemId    change a line
//! DELETE /:id/items/:itemId    remove a line
//! ```
//!
//! The server works out a line's amounts in whole cents, so both backends
//! write the same text. Each change publishes `purchase_order` `updated`,
//! as the header's own update does; the purchase order's totals are not
//! recomputed.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::PURCHASE_ORDER_UPDATED;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::write_failed;
use crate::rows::purchase_order_item_row;
use crate::tables::{PURCHASE_ORDER_ITEMS, PURCHASE_ORDERS};
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

const ORDER: &str = "Purchase order";
const LINE: &str = "Purchase order line";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/{id}/items", get(list).route_layer(need("orders:read")))
        .route(
            "/{id}/items",
            post(create).route_layer(need("orders:create")),
        )
        .route(
            "/{id}/items/{item_id}",
            patch(update).route_layer(need("orders:update")),
        )
        .route(
            "/{id}/items/{item_id}",
            delete(remove).route_layer(need("orders:delete")),
        )
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/// A line's figures: whole units, at most two decimals for prices and
/// percentages.
#[derive(Debug, Clone, Copy)]
struct Figures {
    quantity_ordered: i64,
    quantity_received: i64,
    unit_price: f64,
    discount_percent: f64,
    tax_percent: f64,
}

/// What the server fills from a line's figures (`lineAmounts`).
#[derive(Debug, PartialEq, Eq)]
struct Amounts {
    unit_price: String,
    discount_percent: String,
    tax_percent: String,
    discount_amount: String,
    tax_amount: String,
    total: String,
    quantity_pending: i64,
}

/// `Math.round` for the non-negative values here.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `centsText`: whole cents as the numeric column text (`12345` -> `123.45`).
fn cents_text(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// `twoDecimalText`: a value typed with at most two decimals, as column text.
#[allow(clippy::cast_possible_truncation)] // bounded by the schema (<= 1e7 * 100)
fn two_decimal_text(value: f64) -> String {
    cents_text(js_round(value * 100.0) as i64)
}

/// `lineAmounts(line)`: quantity x unit price, less the discount percentage,
/// plus tax on what is left; every step rounds to the cent.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)] // bounded by the schema
fn line_amounts(line: Figures) -> Amounts {
    let gross = line.quantity_ordered as f64 * js_round(line.unit_price * 100.0);
    let discount = js_round((gross * line.discount_percent) / 100.0);
    let net = gross - discount;
    let tax = js_round((net * line.tax_percent) / 100.0);
    Amounts {
        unit_price: two_decimal_text(line.unit_price),
        discount_percent: two_decimal_text(line.discount_percent),
        tax_percent: two_decimal_text(line.tax_percent),
        discount_amount: cents_text(discount as i64),
        tax_amount: cents_text(tax as i64),
        total: cents_text((net + tax) as i64),
        quantity_pending: (line.quantity_ordered - line.quantity_received).max(0),
    }
}

// ── Body ────────────────────────────────────────────────────────────────────

/// The line schema (`createPurchaseOrderItemSchema`, or its `.partial()`).
#[derive(Default)]
struct LineBody {
    product_id: Field<String>,
    variant_id: Field<String>,
    sku: Field<String>,
    name: Field<String>,
    description: Field<String>,
    quantity_ordered: Field<i64>,
    quantity_received: Field<i64>,
    quantity_rejected: Field<i64>,
    unit_price: Field<f64>,
    discount_percent: Field<f64>,
    tax_percent: Field<f64>,
    notes: Field<String>,
    project_id: Field<String>,
}

/// `.refine(twoDecimals, 'Use at most two decimals')`, right after the
/// field's own checks: it runs on a value that failed `min` or `max` too.
fn two_decimals(issues: &mut Issues, body: &Body, key: &str) {
    if let Some(Value::Number(n)) = body.get(key) {
        let value = n.as_f64().unwrap_or(f64::NAN);
        if value.is_finite() && (value * 100.0 - js_round(value * 100.0)).abs() >= 1e-6 {
            issues.custom(key, "Use at most two decimals");
        }
    }
}

fn read_line(issues: &mut Issues, body: &Body, partial: bool) -> LineBody {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let len = |min: Option<usize>, max: Option<usize>| Text::length(min, max);
    let product_id = issues.text_with(body, "productId", Presence::Nullish, len(None, Some(30)));
    let variant_id = issues.text_with(body, "variantId", Presence::Nullish, len(None, Some(30)));
    let sku = issues.text_with(body, "sku", Presence::Nullish, len(None, Some(100)));
    let name = issues.text_with(body, "name", required, len(Some(1), Some(255)));
    let description = issues.text_with(body, "description", Presence::Nullish, len(None, None));
    let whole = |issues: &mut Issues, key: &str, presence: Presence, min: f64, max: f64| {
        issues.whole_number(
            body,
            key,
            presence,
            Number {
                min: Some(min),
                max: Some(max),
                ..Number::default()
            },
        )
    };
    let quantity_ordered = whole(
        issues,
        "quantityOrdered",
        Presence::Optional,
        1.0,
        1_000_000.0,
    );
    let quantity_received = whole(
        issues,
        "quantityReceived",
        Presence::Optional,
        0.0,
        1_000_000.0,
    );
    let quantity_rejected = whole(
        issues,
        "quantityRejected",
        Presence::Optional,
        0.0,
        1_000_000.0,
    );
    let price = |issues: &mut Issues, key: &str, presence: Presence, max: f64| {
        let field = issues.number(
            body,
            key,
            presence,
            Number {
                coerce: false,
                int: false,
                min: Some(0.0),
                max: Some(max),
            },
        );
        two_decimals(issues, body, key);
        field
    };
    let unit_price = price(issues, "unitPrice", required, 10_000_000.0);
    let discount_percent = price(issues, "discountPercent", Presence::Optional, 100.0);
    let tax_percent = price(issues, "taxPercent", Presence::Optional, 100.0);
    let notes = issues.text_with(body, "notes", Presence::Nullish, len(None, None));
    let project_id = issues.text_with(body, "projectId", Presence::Nullish, len(None, Some(255)));
    LineBody {
        product_id,
        variant_id,
        sku,
        name,
        description,
        quantity_ordered,
        quantity_received,
        quantity_rejected,
        unit_price,
        discount_percent,
        tax_percent,
        notes,
        project_id,
    }
}

/// A nullable text field as a column value: absent is left out, null is NULL.
fn put_text(out: &mut Body, prop: &str, field: &Field<String>) {
    match field {
        Field::Set(value) => {
            out.insert(prop.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(prop.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `projectId || null`.
fn put_project(out: &mut Body, field: &Field<String>) {
    match field {
        Field::Set(value) if !value.is_empty() => {
            out.insert("projectId".to_owned(), json!(value));
        }
        Field::Set(_) | Field::Null => {
            out.insert("projectId".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// The amounts as the columns they fill.
fn put_amounts(out: &mut Body, amounts: &Amounts) {
    out.insert(
        "quantityPending".to_owned(),
        json!(amounts.quantity_pending),
    );
    out.insert("unitPrice".to_owned(), json!(amounts.unit_price));
    out.insert(
        "discountPercent".to_owned(),
        json!(amounts.discount_percent),
    );
    out.insert("discountAmount".to_owned(), json!(amounts.discount_amount));
    out.insert("taxPercent".to_owned(), json!(amounts.tax_percent));
    out.insert("taxAmount".to_owned(), json!(amounts.tax_amount));
    out.insert("total".to_owned(), json!(amounts.total));
}

/// The props to column names of the table.
fn columns(props: &Body) -> Body {
    let mut values = Map::new();
    for (prop, value) in props {
        PURCHASE_ORDER_ITEMS.set(&mut values, prop, value.clone());
    }
    values
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// The live purchase order, or the 404.
async fn find_order(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    match PURCHASE_ORDERS.find_live(&caller.db, id).await? {
        Some(row) => Ok(row),
        None => Err(Refusal::not_found(ORDER, id)),
    }
}

/// A line of the purchase order, or the 404.
async fn find_line(caller: &Caller, order_id: &str, item_id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        purchase_order_item_row!(),
        " from purchase_order_items t where t.id = $1 and t.purchase_order_id = $2 limit 1"
    ))
    .bind(item_id)
    .bind(order_id)
    .fetch_optional(&caller.db)
    .await?;
    match row {
        Some(row) => Ok(PURCHASE_ORDER_ITEMS.js(row)),
        None => Err(Refusal::not_found(LINE, item_id)),
    }
}

/// The project of a line (FLOW-019) must be a live `WeldFlow` project of this
/// workspace: the column has no foreign key, so this is the only check.
async fn check_project(caller: &Caller, project: &Field<String>) -> Result<(), Refusal> {
    let Field::Set(project_id) = project else {
        return Ok(());
    };
    if project_id.is_empty() {
        return Ok(());
    }
    let found: Option<String> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(project_id)
            .fetch_optional(&caller.db)
            .await?;
    if found.is_none() {
        return Err(Refusal::bad_request(format!(
            "Project {project_id} does not exist"
        )));
    }
    Ok(())
}

/// `publishPurchaseOrderUpdated`: the header's own update event.
fn publish_updated(caller: &Caller, state: &StashState, order: &Value) {
    let id = order["id"].as_str().unwrap_or_default();
    caller.publish(
        state,
        PURCHASE_ORDER_UPDATED,
        id,
        &json!({
            "id": id,
            "poNumber": order["poNumber"],
            "status": order["status"],
            "supplierId": order["supplierId"],
        }),
    );
}

fn figures_of(line: &Value) -> Figures {
    let number = |key: &str| {
        line[key]
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    Figures {
        quantity_ordered: line["quantityOrdered"].as_i64().unwrap_or(0),
        quantity_received: line["quantityReceived"].as_i64().unwrap_or(0),
        unit_price: number("unitPrice"),
        discount_percent: number("discountPercent"),
        tax_percent: number("taxPercent"),
    }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list purchase order lines";
    if let Err(refusal) = find_order(&caller, &id).await {
        return refusal.respond(FAILED);
    }
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(concat!(
        "select ",
        purchase_order_item_row!(),
        " from purchase_order_items t where t.purchase_order_id = $1",
        " order by t.created_at asc, t.id asc"
    ))
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(
                rows.into_iter()
                    .map(|row| PURCHASE_ORDER_ITEMS.js(row))
                    .collect(),
                Pagination::new(total, false, None),
            )
            .into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create purchase order line";
    let data = match validate(&headers, &body, |issues, fields| {
        read_line(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let order = match find_order(&caller, &id).await {
        Ok(order) => order,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if let Err(refusal) = check_project(&caller, &data.project_id).await {
        return refusal.respond(FAILED);
    }
    let quantity_ordered = data.quantity_ordered.as_set().copied().unwrap_or(1);
    let quantity_received = data.quantity_received.as_set().copied().unwrap_or(0);
    let amounts = line_amounts(Figures {
        quantity_ordered,
        quantity_received,
        unit_price: data.unit_price.as_set().copied().unwrap_or(0.0),
        discount_percent: data.discount_percent.as_set().copied().unwrap_or(0.0),
        tax_percent: data.tax_percent.as_set().copied().unwrap_or(0.0),
    });
    let at = now();
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(generate_id("poi")));
    props.insert("purchaseOrderId".to_owned(), json!(id));
    put_text(&mut props, "productId", &data.product_id);
    put_text(&mut props, "variantId", &data.variant_id);
    put_text(&mut props, "sku", &data.sku);
    put_text(&mut props, "name", &data.name);
    put_text(&mut props, "description", &data.description);
    props.insert("quantityOrdered".to_owned(), json!(quantity_ordered));
    props.insert("quantityReceived".to_owned(), json!(quantity_received));
    props.insert(
        "quantityRejected".to_owned(),
        json!(data.quantity_rejected.as_set().copied().unwrap_or(0)),
    );
    put_amounts(&mut props, &amounts);
    put_text(&mut props, "notes", &data.notes);
    put_project(&mut props, &data.project_id);
    props.insert("createdAt".to_owned(), json!(at));
    props.insert("updatedAt".to_owned(), json!(at));
    let row = match PURCHASE_ORDER_ITEMS
        .insert(&caller.db, columns(&props), &["createdAt", "updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, FAILED),
    };
    publish_updated(&caller, &state, &order);
    Created(row).into_response()
}

async fn update(
    State(state): State<StashState>,
    caller: Caller,
    Path((id, item_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update purchase order line";
    let data = match validate(&headers, &body, |issues, fields| {
        read_line(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let order = match find_order(&caller, &id).await {
        Ok(order) => order,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let existing = match find_line(&caller, &id, &item_id).await {
        Ok(line) => line,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if let Err(refusal) = check_project(&caller, &data.project_id).await {
        return refusal.respond(FAILED);
    }
    let before = figures_of(&existing);
    let amounts = line_amounts(Figures {
        quantity_ordered: data
            .quantity_ordered
            .as_set()
            .copied()
            .unwrap_or(before.quantity_ordered),
        quantity_received: data
            .quantity_received
            .as_set()
            .copied()
            .unwrap_or(before.quantity_received),
        unit_price: data
            .unit_price
            .as_set()
            .copied()
            .unwrap_or(before.unit_price),
        discount_percent: data
            .discount_percent
            .as_set()
            .copied()
            .unwrap_or(before.discount_percent),
        tax_percent: data
            .tax_percent
            .as_set()
            .copied()
            .unwrap_or(before.tax_percent),
    });
    let mut props = Map::new();
    put_text(&mut props, "productId", &data.product_id);
    put_text(&mut props, "variantId", &data.variant_id);
    put_text(&mut props, "sku", &data.sku);
    put_text(&mut props, "name", &data.name);
    put_text(&mut props, "description", &data.description);
    for (prop, field) in [
        ("quantityOrdered", &data.quantity_ordered),
        ("quantityReceived", &data.quantity_received),
        ("quantityRejected", &data.quantity_rejected),
    ] {
        if let Field::Set(value) = field {
            props.insert(prop.to_owned(), json!(value));
        }
    }
    put_text(&mut props, "notes", &data.notes);
    put_project(&mut props, &data.project_id);
    put_amounts(&mut props, &amounts);
    props.insert("updatedAt".to_owned(), json!(now()));
    let row = match PURCHASE_ORDER_ITEMS
        .patch(&caller.db, &item_id, columns(&props), false, &["updatedAt"])
        .await
    {
        Ok(Some(row)) => row,
        // The line went between the lookup and the write: nothing to return.
        Ok(None) => return Refusal::not_found(LINE, &item_id).respond(FAILED),
        Err(error) => return write_failed(&error, FAILED),
    };
    publish_updated(&caller, &state, &order);
    Data(row).into_response()
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path((id, item_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete purchase order line";
    let order = match find_order(&caller, &id).await {
        Ok(order) => order,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if let Err(refusal) = find_line(&caller, &id, &item_id).await {
        return refusal.respond(FAILED);
    }
    if let Err(error) = sqlx::query("delete from purchase_order_items where id = $1")
        .bind(&item_id)
        .execute(&caller.db)
        .await
    {
        return internal(&error, FAILED);
    }
    publish_updated(&caller, &state, &order);
    NoContent.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amounts(
        quantity_ordered: i64,
        quantity_received: i64,
        unit_price: f64,
        discount_percent: f64,
        tax_percent: f64,
    ) -> Amounts {
        line_amounts(Figures {
            quantity_ordered,
            quantity_received,
            unit_price,
            discount_percent,
            tax_percent,
        })
    }

    #[test]
    fn works_out_discount_tax_and_total_in_cents() {
        let a = amounts(3, 0, 600.0, 10.0, 21.0);
        assert_eq!(a.unit_price, "600.00");
        assert_eq!(a.discount_percent, "10.00");
        assert_eq!(a.discount_amount, "180.00");
        assert_eq!(a.tax_percent, "21.00");
        assert_eq!(a.tax_amount, "340.20");
        assert_eq!(a.total, "1960.20");
        assert_eq!(a.quantity_pending, 3);
    }

    #[test]
    fn a_plain_line_has_no_discount_and_no_tax() {
        let a = amounts(1, 0, 12.5, 0.0, 0.0);
        assert_eq!(a.total, "12.50");
        assert_eq!(a.discount_amount, "0.00");
        assert_eq!(a.tax_amount, "0.00");
    }

    #[test]
    fn rounds_each_step_to_the_cent_half_up() {
        // 3 x 0.35 = 1.05; 15% off = 0.1575 -> 0.16; net 0.89; 21% tax = 0.1869 -> 0.19.
        let a = amounts(3, 0, 0.35, 15.0, 21.0);
        assert_eq!(a.discount_amount, "0.16");
        assert_eq!(a.tax_amount, "0.19");
        assert_eq!(a.total, "1.08");
    }

    #[test]
    fn pending_is_ordered_less_received_and_never_below_zero() {
        assert_eq!(amounts(4, 1, 1.0, 0.0, 0.0).quantity_pending, 3);
        assert_eq!(amounts(2, 5, 1.0, 0.0, 0.0).quantity_pending, 0);
    }

    #[test]
    fn writes_cents_as_numeric_text() {
        assert_eq!(cents_text(0), "0.00");
        assert_eq!(cents_text(5), "0.05");
        assert_eq!(cents_text(123_456), "1234.56");
        assert_eq!(two_decimal_text(1.1), "1.10");
    }
}
