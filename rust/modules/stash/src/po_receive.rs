//! `POST /api/purchase-orders/:id/receive` (phase 1 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`, ADR STASH-007; Rust only): goods
//! arriving against an `approved`, `ordered` or `partial` purchase order.
//!
//! ```text
//! { idempotencyKey, lines: [{ itemId, quantity, rejected?, locationId?, lotNumber?, expiryDate? }], notes? }
//! ```
//!
//! A line with a product posts `quantity` through the ledger
//! ([`crate::ledger::apply_stock_change_in`], type `received`, source the
//! purchase order) into the purchase order's warehouse, at the line's
//! location (else the line's `destination_location_id`); rejected units and
//! lines without a product only count.
//!
//! 1. A stored receipt with the same `idempotencyKey` answers 200 with what
//!    it stored, and nothing is posted.
//! 2. The checks that need no lock run first, each a 400: the status, each
//!    line (on this purchase order, listed once, within what is still to
//!    come), the warehouse, the locations, and what the ledger would refuse
//!    ([`crate::ledger::check_receipt`]: a managed warehouse, an unknown
//!    product, a missing lot or expiry date).
//! 3. One transaction does the rest: it claims the key (the
//!    `purchase_order_receipts` row), locks the purchase order and checks it
//!    again, adds the quantities to the lines (guarded, so a concurrent
//!    receipt cannot take the same units), posts each line through the
//!    ledger with its audit row and roll-ups
//!    ([`crate::ledger::apply_stock_change_in`]), keeps each line's
//!    `adjustmentIds`, sets the status (`partial`, or `received` with
//!    `received_date` once nothing is left to come) and recomputes the
//!    header totals. Any refusal or failure rolls all of it back: nothing is
//!    posted or recorded, and the same key can be sent again. A request with
//!    the same key arriving meanwhile waits on the key, then replays the
//!    committed receipt or, after a rollback, receives itself.
//! 4. The event goes out, and the answer is 201
//!    `{ receipt, purchaseOrder, items }`.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use weldsuite_catalogs::entity_events::PURCHASE_ORDER_RECEIVED;
use weldsuite_catalogs::permission_keys::ORDERS_UPDATE;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::inventory::date_field;
use crate::ledger::{
    LedgerError, StockChange, apply_stock_change_in, check_receipt, managed_warehouse,
    warehouse_is_managed,
};
use crate::po_actions::{ORDER, event_data, lock_order, receipt_row, require_status};
use crate::po_guard::refuse_odoo_managed;
use crate::po_totals::recompute_po_totals;
use crate::rows::purchase_order_item_row;
use crate::tables::{PURCHASE_ORDER_ITEMS, PURCHASE_ORDERS};
use crate::{Caller, Refusal, StashState, now, validate};

const FAILED: &str = "Failed to receive purchase order";

/// The statuses a purchase order is received from.
const RECEIVABLE: &[&str] = &["approved", "ordered", "partial"];
const NOT_RECEIVABLE: &str =
    "Only an approved, ordered or partially received purchase order can be received";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/{id}/receive",
        post(receive).route_layer(gate.require([ORDERS_UPDATE])),
    )
}

// ── Body ────────────────────────────────────────────────────────────────────

/// A line of the body.
#[derive(Debug, Clone, PartialEq)]
struct LineIn {
    item_id: String,
    quantity: i64,
    rejected: i64,
    location_id: Option<String>,
    lot_number: Option<String>,
    /// `toISOString()` of the expiry date.
    expiry_date: Option<String>,
}

/// The body.
#[derive(Debug, Clone, PartialEq)]
struct ReceiveIn {
    idempotency_key: String,
    lines: Vec<LineIn>,
    notes: Option<String>,
}

const UNITS: Number = Number {
    coerce: false,
    int: true,
    min: Some(0.0),
    max: Some(1_000_000.0),
};

/// An empty string as not sent.
fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

fn read_line(issues: &mut Issues, item: &Value) -> Option<LineIn> {
    let fields = issues.object(item)?;
    let item_id = issues.text_with(
        fields,
        "itemId",
        Presence::Required,
        Text::length(Some(1), Some(30)),
    );
    let quantity = issues.whole_number(fields, "quantity", Presence::Required, UNITS);
    let rejected = issues.whole_number(fields, "rejected", Presence::Optional, UNITS);
    let location_id = issues.text_with(
        fields,
        "locationId",
        Presence::Nullish,
        Text::length(None, Some(30)),
    );
    let lot_number = issues.text_with(
        fields,
        "lotNumber",
        Presence::Nullish,
        Text::length(None, Some(100)),
    );
    let expiry_date = date_field(issues, fields, "expiryDate", Presence::Nullish);
    Some(LineIn {
        item_id: item_id.into_option()?,
        quantity: quantity.into_option()?,
        rejected: rejected.into_option().unwrap_or(0),
        location_id: non_empty(location_id.into_option()),
        lot_number: non_empty(lot_number.into_option()),
        expiry_date: expiry_date.into_option(),
    })
}

fn read_receive(issues: &mut Issues, body: &Map<String, Value>) -> Option<ReceiveIn> {
    let key = issues.text_with(
        body,
        "idempotencyKey",
        Presence::Required,
        Text::length(Some(1), Some(100)),
    );
    let lines = issues.list(
        body,
        "lines",
        Presence::Required,
        Some(1),
        Some(500),
        read_line,
    );
    let notes = issues.text_with(body, "notes", Presence::Nullish, Text::default());
    Some(ReceiveIn {
        idempotency_key: key.into_option()?,
        lines: lines.into_option()?,
        notes: non_empty(notes.into_option()),
    })
}

// ── The plan ────────────────────────────────────────────────────────────────

/// A line of the receipt, checked against its purchase order line.
#[derive(Debug, Clone, PartialEq)]
struct Planned {
    item_id: String,
    name: String,
    product_id: Option<String>,
    variant_id: Option<String>,
    quantity: i64,
    rejected: i64,
    /// The body's location, else the line's `destination_location_id`.
    location_id: Option<String>,
    lot_number: Option<String>,
    expiry_date: Option<String>,
    /// The line's unit price: the cost the stock comes in at.
    unit_cost: Option<f64>,
}

impl Planned {
    /// Whether the line moves stock: a product and accepted units.
    fn posts(&self) -> bool {
        self.product_id.is_some() && self.quantity > 0
    }

    /// Whether the line changes anything at all.
    fn counts(&self) -> bool {
        self.quantity + self.rejected > 0
    }
}

fn truthy(row: &Value, key: &str) -> Option<String> {
    crate::js::truthy(row, key).map(str::to_owned)
}

/// Units of a line still to come: ordered less received less rejected.
fn remaining(line: &Value) -> i64 {
    let int = |key: &str| line[key].as_i64().unwrap_or(0);
    (int("quantityOrdered") - int("quantityReceived") - int("quantityRejected")).max(0)
}

/// Check the body's lines against the purchase order's `lines` (rows as
/// Drizzle returns them). `Err` is the 400's message.
fn plan_receipt(lines: &[Value], input: &[LineIn]) -> Result<Vec<Planned>, String> {
    let mut seen = HashSet::new();
    let mut planned = Vec::with_capacity(input.len());
    for line_in in input {
        if !seen.insert(line_in.item_id.as_str()) {
            return Err(format!("Line {} is listed more than once", line_in.item_id));
        }
        let Some(line) = lines
            .iter()
            .find(|line| line["id"].as_str() == Some(line_in.item_id.as_str()))
        else {
            return Err(format!(
                "Line {} is not on this purchase order",
                line_in.item_id
            ));
        };
        let name = line["name"].as_str().unwrap_or_default().to_owned();
        let left = remaining(line);
        let arriving = line_in.quantity + line_in.rejected;
        if arriving > left {
            return Err(format!(
                "Cannot receive {arriving} of {name}: only {left} left to receive"
            ));
        }
        planned.push(Planned {
            item_id: line_in.item_id.clone(),
            name,
            product_id: truthy(line, "productId"),
            variant_id: truthy(line, "variantId"),
            quantity: line_in.quantity,
            rejected: line_in.rejected,
            location_id: line_in
                .location_id
                .clone()
                .or_else(|| truthy(line, "destinationLocationId")),
            lot_number: line_in.lot_number.clone(),
            expiry_date: line_in.expiry_date.clone(),
            unit_cost: line["unitPrice"]
                .as_str()
                .and_then(|price| price.parse::<f64>().ok()),
        });
    }
    if !planned.iter().any(Planned::counts) {
        return Err("Nothing to receive: every line has a quantity of 0".to_owned());
    }
    Ok(planned)
}

/// The receipt's `lines` (`PurchaseOrderReceiptLine[]`).
fn receipt_lines(plan: &[Planned], adjustments: &[Vec<String>]) -> Value {
    Value::Array(
        plan.iter()
            .enumerate()
            .map(|(index, line)| {
                json!({
                    "itemId": line.item_id,
                    "quantity": line.quantity,
                    "rejected": line.rejected,
                    "locationId": line.location_id,
                    "lotNumber": line.lot_number,
                    "expiryDate": line.expiry_date,
                    "adjustmentIds": adjustments.get(index).cloned().unwrap_or_default(),
                })
            })
            .collect(),
    )
}

/// Who receives, into which purchase order and warehouse.
struct Receipt<'a> {
    order_id: &'a str,
    po_number: Option<String>,
    warehouse_id: String,
    user_id: &'a str,
    notes: Option<&'a str>,
}

impl Receipt<'_> {
    /// The ledger change a posting line makes.
    fn change(&self, line: &Planned) -> StockChange {
        StockChange {
            product_id: line.product_id.clone().unwrap_or_default(),
            warehouse_id: self.warehouse_id.clone(),
            variant_id: line.variant_id.clone(),
            location_id: line.location_id.clone(),
            lot_number: line.lot_number.clone(),
            delta: line.quantity,
            kind: "received".to_owned(),
            reason: Some(format!(
                "Received on purchase order {}",
                self.po_number.as_deref().unwrap_or(self.order_id)
            )),
            reason_code: None,
            notes: self.notes.map(str::to_owned),
            unit_cost: line.unit_cost,
            batch_number: None,
            expiry_date: line.expiry_date.clone(),
            source_type: Some("purchase_order".to_owned()),
            source_id: Some(self.order_id.to_owned()),
            source_number: self.po_number.clone(),
            performed_by: Some(self.user_id.to_owned()),
        }
    }
}

/// A ledger refusal as the route's 400 (its message and code); a failed
/// statement stays the 500.
fn ledger_refusal(error: LedgerError) -> Refusal {
    match error {
        LedgerError::Stock { code, message } => Refusal::Response(Box::new(
            ApiError::bad_request(message)
                .with_details(json!({ "code": code }))
                .into_response(),
        )),
        LedgerError::Database(error) => Refusal::Database(error),
    }
}

/// The checks of the posting lines, before anything is written: the
/// warehouse, that it isn't managed by another system, the locations, and
/// what the ledger would refuse for each line.
async fn check_postings(
    db: &PgPool,
    receipt: &Receipt<'_>,
    plan: &[Planned],
) -> Result<(), Refusal> {
    let posting: Vec<&Planned> = plan.iter().filter(|line| line.posts()).collect();
    if posting.is_empty() {
        return Ok(());
    }
    if receipt.warehouse_id.is_empty() {
        return Err(Refusal::bad_request(
            "Purchase order has no destination warehouse",
        ));
    }
    if warehouse_is_managed(db, &receipt.warehouse_id).await? {
        return Err(ledger_refusal(managed_warehouse()));
    }
    let locations: Vec<String> = posting
        .iter()
        .filter_map(|line| line.location_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !locations.is_empty() {
        let found: Vec<String> = sqlx::query_scalar(
            "select id from warehouse_locations where id = any($1) and warehouse_id = $2 \
             and deleted_at is null",
        )
        .bind(&locations)
        .bind(&receipt.warehouse_id)
        .fetch_all(db)
        .await?;
        let mut missing: Vec<&String> = locations.iter().filter(|id| !found.contains(id)).collect();
        missing.sort();
        if let Some(location) = missing.first() {
            return Err(Refusal::bad_request(format!(
                "Location {location} is not in the purchase order's warehouse"
            )));
        }
    }
    for line in posting {
        check_receipt(db, &receipt.change(line))
            .await
            .map_err(ledger_refusal)?;
    }
    Ok(())
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// The lines of the purchase order, oldest first (as `GET /:id/items`).
pub(crate) async fn load_items<'e>(
    db: impl sqlx::PgExecutor<'e>,
    order_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        purchase_order_item_row!(),
        " from purchase_order_items t where t.purchase_order_id = $1",
        " order by t.created_at asc, t.id asc"
    ))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PURCHASE_ORDER_ITEMS.js(row))
        .collect())
}

/// The stored receipt with this idempotency key.
async fn find_receipt(db: &PgPool, key: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from purchase_order_receipts t where t.idempotency_key = $1 limit 1",
    )
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(row.map(receipt_row))
}

/// `{ receipt, purchaseOrder, items }` for the receipt `receipt_id`.
async fn result(db: &PgPool, order_id: &str, receipt_id: &str) -> Result<Value, Refusal> {
    let receipt: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from purchase_order_receipts t where t.id = $1")
            .bind(receipt_id)
            .fetch_optional(db)
            .await?;
    let order = PURCHASE_ORDERS.find_live(db, order_id).await?;
    let items = load_items(db, order_id).await?;
    Ok(json!({
        "receipt": receipt.map(receipt_row),
        "purchaseOrder": order,
        "items": items,
    }))
}

/// A stored receipt answering a repeated key: its result, or the 409 when
/// the key was used for another purchase order.
async fn replay(db: &PgPool, order_id: &str, receipt: &Value) -> Result<Received, Refusal> {
    if receipt["purchaseOrderId"].as_str() != Some(order_id) {
        return Err(ApiError::conflict(
            "This idempotency key was already used for another purchase order",
        )
        .into());
    }
    let receipt_id = receipt["id"].as_str().unwrap_or_default();
    Ok(Received::Replayed(result(db, order_id, receipt_id).await?))
}

// ── Writing ─────────────────────────────────────────────────────────────────

/// After the line updates: `received` (and `received_date`) once no line
/// has anything left to come, else `partial`.
const FINISH: &str = "update purchase_orders t set \
    status = case when exists (select 1 from purchase_order_items i where i.purchase_order_id = t.id \
      and i.quantity_ordered - coalesce(i.quantity_received, 0) - coalesce(i.quantity_rejected, 0) > 0) \
      then 'partial' else 'received' end, \
    received_date = case when exists (select 1 from purchase_order_items i where i.purchase_order_id = t.id \
      and i.quantity_ordered - coalesce(i.quantity_received, 0) - coalesce(i.quantity_rejected, 0) > 0) \
      then t.received_date else $2::timestamp end, \
    updated_at = $2::timestamp where t.id = $1";

/// What the transaction writes.
struct Write {
    order_id: String,
    receipt_id: String,
    key: String,
    plan: Vec<Planned>,
    /// The ledger change of each posting line, by its index in `plan`.
    changes: Vec<Option<StockChange>>,
    user_id: String,
    notes: Option<String>,
    now: String,
}

/// How the transaction ended.
enum Written {
    /// The receipt is stored and its stock posted.
    Done,
    /// A request with the same key stored its receipt first.
    Taken,
}

/// Add a line's units, unless a concurrent receipt took them.
async fn add_units(
    conn: &mut PgConnection,
    order_id: &str,
    line: &Planned,
    now: &str,
) -> Result<(), Refusal> {
    let updated: Option<String> = sqlx::query_scalar(
        "update purchase_order_items set quantity_received = coalesce(quantity_received, 0) + $3, \
         quantity_rejected = coalesce(quantity_rejected, 0) + $4, \
         quantity_pending = greatest(quantity_ordered - (coalesce(quantity_received, 0) + $3), 0), \
         last_received_date = $5::timestamp, updated_at = $5::timestamp \
         where id = $1 and purchase_order_id = $2 \
         and quantity_ordered - coalesce(quantity_received, 0) - coalesce(quantity_rejected, 0) >= $3 + $4 \
         returning id",
    )
    .bind(&line.item_id)
    .bind(order_id)
    .bind(line.quantity)
    .bind(line.rejected)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await?;
    if updated.is_none() {
        return Err(Refusal::bad_request(format!(
            "Cannot receive {} of {}: another receipt was saved for it first",
            line.quantity + line.rejected,
            line.name
        )));
    }
    Ok(())
}

/// The posting lines' indexes in the order they post: by bucket (product,
/// variant, location, lot), so two receipts of the same products lock the
/// buckets and roll-ups the same way round.
fn posting_order(changes: &[Option<StockChange>]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..changes.len())
        .filter(|index| changes[*index].is_some())
        .collect();
    order.sort_by_key(|index| {
        changes[*index].as_ref().map(|change| {
            (
                change.product_id.clone(),
                change.variant_id.clone(),
                change.location_id.clone(),
                change.lot_number.clone(),
            )
        })
    });
    order
}

/// The whole receipt in one transaction: claim the key, lock the purchase
/// order and check it again, add the units, post every line through the
/// ledger (audit rows and roll-ups included), keep the adjustment ids, set
/// the status and the totals. Any refusal or failed statement rolls all of
/// it back, so nothing is posted or recorded and the key stays free.
async fn write_receipt(db: &PgPool, write: Write) -> Result<Written, Refusal> {
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            // A request with the same key that is still running holds it:
            // this insert waits until that one commits (then this is a
            // replay) or rolls back (then the key is ours).
            let inserted: Option<String> = sqlx::query_scalar(
                "insert into purchase_order_receipts (id, created_at, purchase_order_id, \
                 idempotency_key, lines, received_at, received_by, received_by_name, notes) \
                 values ($1, $2::timestamp, $3, $4, $5, $2::timestamp, $6, null, $7) \
                 on conflict (idempotency_key) do nothing returning id",
            )
            .bind(&write.receipt_id)
            .bind(&write.now)
            .bind(&write.order_id)
            .bind(&write.key)
            .bind(receipt_lines(&write.plan, &[]))
            .bind(&write.user_id)
            .bind(write.notes.as_deref())
            .fetch_optional(&mut *conn)
            .await?;
            if inserted.is_none() {
                return Ok(Written::Taken);
            }
            let order = lock_order(conn, &write.order_id).await?;
            refuse_odoo_managed(&order)?;
            require_status(&order, RECEIVABLE, NOT_RECEIVABLE)?;
            for line in write.plan.iter().filter(|line| line.counts()) {
                add_units(conn, &write.order_id, line, &write.now).await?;
            }
            let mut adjustments = vec![Vec::new(); write.plan.len()];
            for index in posting_order(&write.changes) {
                if let Some(change) = &write.changes[index] {
                    let posted = apply_stock_change_in(conn, change)
                        .await
                        .map_err(ledger_refusal)?;
                    adjustments[index] = vec![posted.adjustment_id];
                }
            }
            sqlx::query("update purchase_order_receipts set lines = $2 where id = $1")
                .bind(&write.receipt_id)
                .bind(receipt_lines(&write.plan, &adjustments))
                .execute(&mut *conn)
                .await?;
            sqlx::query(FINISH)
                .bind(&write.order_id)
                .bind(&write.now)
                .execute(&mut *conn)
                .await?;
            recompute_po_totals(&mut *conn, &write.order_id, &write.now).await?;
            Ok::<_, Refusal>(Written::Done)
        })
    })
    .await
}

/// How a receive ended.
enum Received {
    /// A new receipt: the answer and the event's data.
    New(Value, Value),
    /// A repeated key: the stored receipt's answer.
    Replayed(Value),
}

async fn receive_order(caller: &Caller, id: &str, input: ReceiveIn) -> Result<Received, Refusal> {
    let db = &caller.db;
    let Some(order) = PURCHASE_ORDERS.find_live(db, id).await? else {
        return Err(Refusal::not_found(ORDER, id));
    };
    if let Some(stored) = find_receipt(db, &input.idempotency_key).await? {
        return replay(db, id, &stored).await;
    }
    refuse_odoo_managed(&order)?;
    require_status(&order, RECEIVABLE, NOT_RECEIVABLE)?;
    let lines = load_items(db, id).await?;
    let plan = plan_receipt(&lines, &input.lines).map_err(Refusal::bad_request)?;
    let receipt = Receipt {
        order_id: id,
        po_number: truthy(&order, "poNumber"),
        warehouse_id: truthy(&order, "warehouseId").unwrap_or_default(),
        user_id: &caller.user_id,
        notes: input.notes.as_deref(),
    };
    check_postings(db, &receipt, &plan).await?;
    let receipt_id = generate_id("porc");
    let changes = plan
        .iter()
        .map(|line| line.posts().then(|| receipt.change(line)))
        .collect();
    let written = write_receipt(
        db,
        Write {
            order_id: id.to_owned(),
            receipt_id: receipt_id.clone(),
            key: input.idempotency_key.clone(),
            plan: plan.clone(),
            changes,
            user_id: caller.user_id.clone(),
            notes: input.notes.clone(),
            now: now(),
        },
    )
    .await?;
    if let Written::Taken = written {
        let stored = find_receipt(db, &input.idempotency_key)
            .await?
            .ok_or_else(|| Refusal::from(ApiError::internal()))?;
        return replay(db, id, &stored).await;
    }
    let answer = result(db, id, &receipt_id).await?;
    let event = event_data(
        &answer["purchaseOrder"],
        &[
            ("receiptId", json!(receipt_id)),
            (
                "lines",
                Value::Array(
                    plan.iter()
                        .map(|line| {
                            json!({
                                "itemId": line.item_id,
                                "productId": line.product_id,
                                "variantId": line.variant_id,
                                "quantity": line.quantity,
                                "rejected": line.rejected,
                            })
                        })
                        .collect(),
                ),
            ),
        ],
    );
    Ok(Received::New(answer, event))
}

async fn receive(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_receive) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(FAILED),
    };
    match receive_order(&caller, &id, input).await {
        Ok(Received::New(answer, event)) => {
            caller.publish(&state, PURCHASE_ORDER_RECEIVED, &id, &event);
            Created(answer).into_response()
        }
        Ok(Received::Replayed(answer)) => Data(answer).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, product: Option<&str>, ordered: i64, received: i64, rejected: i64) -> Value {
        json!({
            "id": id, "name": format!("Item {id}"), "productId": product, "variantId": null,
            "quantityOrdered": ordered, "quantityReceived": received, "quantityRejected": rejected,
            "unitPrice": "2.50", "destinationLocationId": "loc_default",
        })
    }

    fn line_in(id: &str, quantity: i64, rejected: i64) -> LineIn {
        LineIn {
            item_id: id.to_owned(),
            quantity,
            rejected,
            location_id: None,
            lot_number: None,
            expiry_date: None,
        }
    }

    fn read(body: &Value) -> Result<Option<ReceiveIn>, Vec<Value>> {
        let mut issues = Issues::default();
        let read = issues
            .object(body)
            .and_then(|fields| read_receive(&mut issues, fields));
        match issues.finish() {
            Ok(()) => Ok(read),
            Err(invalid) => Err(invalid.issues().to_vec()),
        }
    }

    #[test]
    fn reads_the_body() {
        let body = read(&json!({
            "idempotencyKey": "k1",
            "lines": [
                { "itemId": "poi_1", "quantity": 3, "rejected": 1, "locationId": "loc_1",
                  "lotNumber": "L-1", "expiryDate": "2027-01-31" },
                { "itemId": "poi_2", "quantity": 0, "locationId": "", "lotNumber": null },
            ],
            "notes": "dock 2",
        }))
        .expect("valid")
        .expect("read");
        assert_eq!(body.idempotency_key, "k1");
        assert_eq!(body.notes.as_deref(), Some("dock 2"));
        assert_eq!(
            body.lines[0],
            LineIn {
                item_id: "poi_1".to_owned(),
                quantity: 3,
                rejected: 1,
                location_id: Some("loc_1".to_owned()),
                lot_number: Some("L-1".to_owned()),
                expiry_date: Some("2027-01-31T00:00:00.000Z".to_owned()),
            }
        );
        assert_eq!(body.lines[1], line_in("poi_2", 0, 0));
    }

    #[test]
    fn refuses_a_bad_body() {
        for body in [
            json!({ "lines": [{ "itemId": "a", "quantity": 1 }] }),
            json!({ "idempotencyKey": "", "lines": [{ "itemId": "a", "quantity": 1 }] }),
            json!({ "idempotencyKey": "x".repeat(101), "lines": [{ "itemId": "a", "quantity": 1 }] }),
            json!({ "idempotencyKey": "k", "lines": [] }),
            json!({ "idempotencyKey": "k", "lines": [{ "itemId": "a", "quantity": -1 }] }),
            json!({ "idempotencyKey": "k", "lines": [{ "itemId": "a", "quantity": 1.5 }] }),
            json!({ "idempotencyKey": "k", "lines": [{ "itemId": "a", "quantity": 1, "rejected": -2 }] }),
            json!({ "idempotencyKey": "k", "lines": [{ "quantity": 1 }] }),
            json!({ "idempotencyKey": "k", "lines": [{ "itemId": "a", "quantity": 1, "expiryDate": "soon" }] }),
        ] {
            assert!(read(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn plans_the_lines_with_their_product_cost_and_location() {
        let lines = [
            line("poi_1", Some("prod_1"), 10, 4, 1),
            line("poi_2", None, 2, 0, 0),
        ];
        let plan =
            plan_receipt(&lines, &[line_in("poi_1", 3, 2), line_in("poi_2", 0, 1)]).expect("plan");
        assert_eq!(plan[0].product_id.as_deref(), Some("prod_1"));
        assert_eq!(plan[0].location_id.as_deref(), Some("loc_default"));
        assert_eq!(plan[0].unit_cost, Some(2.5));
        assert!(plan[0].posts());
        assert!(!plan[1].posts());
        assert!(plan[1].counts());
    }

    #[test]
    fn refuses_more_than_is_left_unknown_and_repeated_lines_and_nothing() {
        let lines = [line("poi_1", Some("prod_1"), 10, 4, 1)];
        assert_eq!(
            plan_receipt(&lines, &[line_in("poi_1", 5, 1)]),
            Err("Cannot receive 6 of Item poi_1: only 5 left to receive".to_owned())
        );
        assert!(plan_receipt(&lines, &[line_in("poi_1", 4, 1)]).is_ok());
        assert_eq!(
            plan_receipt(&lines, &[line_in("poi_9", 1, 0)]),
            Err("Line poi_9 is not on this purchase order".to_owned())
        );
        assert_eq!(
            plan_receipt(&lines, &[line_in("poi_1", 1, 0), line_in("poi_1", 1, 0)]),
            Err("Line poi_1 is listed more than once".to_owned())
        );
        assert_eq!(
            plan_receipt(&lines, &[line_in("poi_1", 0, 0)]),
            Err("Nothing to receive: every line has a quantity of 0".to_owned())
        );
    }

    #[test]
    fn a_line_over_received_by_hand_has_nothing_left() {
        assert_eq!(remaining(&line("a", None, 2, 5, 0)), 0);
        assert_eq!(remaining(&line("a", None, 5, 2, 1)), 2);
    }

    #[test]
    fn the_receipt_lines_keep_the_adjustments() {
        let lines = [line("poi_1", Some("prod_1"), 10, 0, 0)];
        let plan = plan_receipt(&lines, &[line_in("poi_1", 2, 0)]).expect("plan");
        assert_eq!(
            receipt_lines(&plan, &[vec!["adj_1".to_owned()]]),
            json!([{
                "itemId": "poi_1", "quantity": 2, "rejected": 0, "locationId": "loc_default",
                "lotNumber": null, "expiryDate": null, "adjustmentIds": ["adj_1"],
            }])
        );
        assert_eq!(receipt_lines(&plan, &[])[0]["adjustmentIds"], json!([]));
    }
}
