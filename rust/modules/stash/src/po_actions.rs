//! The purchase order status actions (phase 1 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`; Rust only, the TypeScript
//! stash-api has none of them):
//!
//! ```text
//! POST /:id/approve        draft | pending            -> approved
//! POST /:id/mark-ordered   approved                   -> ordered
//! POST /:id/cancel         draft | pending | approved | ordered, nothing received -> cancelled
//! POST /:id/close          partial | received         -> closed
//! GET  /:id/receipts       the receipts, newest first
//! ```
//!
//! (`POST /:id/receive` is [`crate::po_receive`].) Each action locks the
//! purchase order row, refuses one sent to Odoo ([`crate::po_guard`]) and a
//! status it doesn't start from (400), changes the status, recomputes the
//! header totals ([`crate::po_totals`]) and publishes the `purchase_order`
//! event named after it, all or nothing. The answer is the purchase order
//! row. The CRUD PATCH still writes any status, as TypeScript's does.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use weldsuite_catalogs::entity_events::{
    EventName, PURCHASE_ORDER_APPROVED, PURCHASE_ORDER_CANCELLED, PURCHASE_ORDER_CLOSED,
    PURCHASE_ORDER_ORDERED,
};
use weldsuite_catalogs::permission_keys::{PURCHASE_ORDERS_READ, PURCHASE_ORDERS_UPDATE};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::inventory::date_field;
use crate::po_guard::refuse_odoo_managed;
use crate::po_totals::recompute_po_totals;
use crate::rows::purchase_order_row;
use crate::tables::PURCHASE_ORDERS;
use crate::{Caller, Refusal, StashState, internal, now, validate};

/// `error.notFound(c, 'Purchase order', id)`.
pub(crate) const ORDER: &str = "Purchase order";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([PURCHASE_ORDERS_UPDATE]);
    Router::new()
        .route("/{id}/approve", post(approve).route_layer(update()))
        .route(
            "/{id}/mark-ordered",
            post(mark_ordered).route_layer(update()),
        )
        .route("/{id}/cancel", post(cancel).route_layer(update()))
        .route("/{id}/close", post(close).route_layer(update()))
        .route(
            "/{id}/receipts",
            get(receipts).route_layer(gate.require([PURCHASE_ORDERS_READ])),
        )
}

// ── Shared by the actions (and receive) ─────────────────────────────────────

/// The live purchase order `id`, locked for the rest of the transaction,
/// or the 404.
pub(crate) async fn lock_order(conn: &mut PgConnection, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        purchase_order_row!(),
        " from purchase_orders t where t.id = $1 and t.deleted_at is null for update"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(PURCHASE_ORDERS.js(row)),
        None => Err(Refusal::not_found(ORDER, id)),
    }
}

/// The purchase order's status (`draft` when the column is somehow null).
pub(crate) fn status_of(order: &Value) -> &str {
    order["status"].as_str().unwrap_or("draft")
}

/// The 400 for a status the action doesn't start from: `refused`, then
/// the status the purchase order is in.
pub(crate) fn require_status(order: &Value, from: &[&str], refused: &str) -> Result<(), Refusal> {
    let status = status_of(order);
    if from.contains(&status) {
        return Ok(());
    }
    Err(Refusal::bad_request(format!(
        "{refused} (this one is {status})"
    )))
}

/// The data of a `purchase_order` action event: the header's identity and
/// status, then what the action adds.
pub(crate) fn event_data(order: &Value, extra: &[(&str, Value)]) -> Value {
    let mut data = Map::new();
    for key in ["id", "poNumber", "status", "supplierId", "warehouseId"] {
        data.insert(
            key.to_owned(),
            order.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    for (key, value) in extra {
        data.insert((*key).to_owned(), value.clone());
    }
    Value::Object(data)
}

// ── The status actions ──────────────────────────────────────────────────────

/// One status action.
struct Action {
    from: &'static [&'static str],
    /// The start of the 400 for any other status.
    refused: &'static str,
    /// The route's 500.
    failed: &'static str,
    event: EventName,
}

const APPROVE: Action = Action {
    from: &["draft", "pending"],
    refused: "Only a draft or pending purchase order can be approved",
    failed: "Failed to approve purchase order",
    event: PURCHASE_ORDER_APPROVED,
};

const MARK_ORDERED: Action = Action {
    from: &["approved"],
    refused: "Only an approved purchase order can be marked as ordered",
    failed: "Failed to mark purchase order as ordered",
    event: PURCHASE_ORDER_ORDERED,
};

const CANCEL: Action = Action {
    from: &["draft", "pending", "approved", "ordered"],
    refused: "Only a draft, pending, approved or ordered purchase order can be cancelled",
    failed: "Failed to cancel purchase order",
    event: PURCHASE_ORDER_CANCELLED,
};

const CLOSE: Action = Action {
    from: &["partial", "received"],
    refused: "Only a partially or fully received purchase order can be closed",
    failed: "Failed to close purchase order",
    event: PURCHASE_ORDER_CLOSED,
};

/// What an action writes once its checks pass.
enum Change {
    Approve {
        user_id: String,
    },
    MarkOrdered {
        order_date: String,
        expected_date: Option<String>,
    },
    Cancel,
    Close,
}

impl Change {
    /// What the event carries besides the header.
    fn event_extra(&self, order: &Value) -> Vec<(&'static str, Value)> {
        match self {
            Self::Approve { user_id } => vec![("approvedBy", json!(user_id))],
            Self::MarkOrdered { .. } => vec![
                ("orderDate", order["orderDate"].clone()),
                ("expectedDate", order["expectedDate"].clone()),
            ],
            Self::Cancel | Self::Close => Vec::new(),
        }
    }
}

/// Write `change` on the locked purchase order `id`.
async fn apply(
    conn: &mut PgConnection,
    id: &str,
    change: &Change,
    now: &str,
) -> Result<(), Refusal> {
    match change {
        Change::Approve { user_id } => {
            sqlx::query(
                "update purchase_orders set status = 'approved', approved_by = $2, \
                 approved_at = $3::timestamp, updated_at = $3::timestamp where id = $1",
            )
            .bind(id)
            .bind(user_id)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
        Change::MarkOrdered {
            order_date,
            expected_date,
        } => {
            sqlx::query(
                "update purchase_orders set status = 'ordered', order_date = $2::timestamp, \
                 expected_date = coalesce($3::timestamp, expected_date), \
                 updated_at = $4::timestamp where id = $1",
            )
            .bind(id)
            .bind(order_date)
            .bind(expected_date.as_deref())
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
        Change::Cancel => {
            let received: i64 = sqlx::query_scalar(
                "select coalesce(sum(coalesce(quantity_received, 0) + coalesce(quantity_rejected, 0)), 0)::bigint \
                 from purchase_order_items where purchase_order_id = $1",
            )
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
            if received > 0 {
                return Err(Refusal::bad_request(
                    "A purchase order with received units cannot be cancelled",
                ));
            }
            sqlx::query(
                "update purchase_orders set status = 'cancelled', updated_at = $2::timestamp where id = $1",
            )
            .bind(id)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
        Change::Close => {
            sqlx::query(
                "update purchase_orders set status = 'closed', updated_at = $2::timestamp where id = $1",
            )
            .bind(id)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

/// Run `action` on the purchase order `id`: lock, check, write, recompute
/// the totals, in one transaction; then the event and the row.
async fn run(
    state: &StashState,
    caller: &Caller,
    id: String,
    action: &'static Action,
    change: Change,
) -> Response {
    let at = now();
    let result = weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let order = lock_order(conn, &id).await?;
            refuse_odoo_managed(&order)?;
            require_status(&order, action.from, action.refused)?;
            apply(conn, &id, &change, &at).await?;
            let order = recompute_po_totals(&mut *conn, &id, &at)
                .await?
                .ok_or_else(|| Refusal::not_found(ORDER, &id))?;
            Ok::<_, Refusal>((order, change))
        })
    })
    .await;
    match result {
        Ok((order, change)) => {
            let id = order["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(
                state,
                action.event,
                &id,
                &event_data(&order, &change.event_extra(&order)),
            );
            Data(order).into_response()
        }
        Err(refusal) => refusal.respond(action.failed),
    }
}

async fn approve(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let change = Change::Approve {
        user_id: caller.user_id.clone(),
    };
    run(&state, &caller, id, &APPROVE, change).await
}

/// `{ orderDate?, expectedDate? }` (ISO dates; null reads as not sent). An
/// empty body is `{}`.
fn read_mark_ordered(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> (Option<String>, Option<String>) {
    let order_date = date_field(issues, body, "orderDate", Presence::Nullish);
    let expected_date = date_field(issues, body, "expectedDate", Presence::Nullish);
    (order_date.into_option(), expected_date.into_option())
}

/// An empty body as `{}`, so a bodiless action reads as no fields.
pub(crate) fn or_empty_object(body: Bytes) -> Bytes {
    if body.iter().all(u8::is_ascii_whitespace) {
        Bytes::from_static(b"{}")
    } else {
        body
    }
}

async fn mark_ordered(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (order_date, expected_date) =
        match validate(&headers, &or_empty_object(body), read_mark_ordered) {
            Ok(dates) => dates,
            Err(refusal) => return refusal.respond(MARK_ORDERED.failed),
        };
    let change = Change::MarkOrdered {
        order_date: order_date.unwrap_or_else(now),
        expected_date,
    };
    run(&state, &caller, id, &MARK_ORDERED, change).await
}

async fn cancel(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    run(&state, &caller, id, &CANCEL, Change::Cancel).await
}

async fn close(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    run(&state, &caller, id, &CLOSE, Change::Close).await
}

// ── Receipts ────────────────────────────────────────────────────────────────

/// A `purchase_order_receipts` row as Drizzle returns it.
pub(crate) fn receipt_row(row: Value) -> Value {
    weldsuite_db::js_row(row)
}

async fn receipts(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list purchase order receipts";
    match PURCHASE_ORDERS.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found(ORDER, &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    }
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from purchase_order_receipts t where t.purchase_order_id = $1 \
         order by t.received_at desc, t.created_at desc, t.id desc",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(
                rows.into_iter().map(receipt_row).collect(),
                Pagination::new(total, false, None),
            )
            .into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_outside_the_list_is_a_400() {
        let order = json!({ "status": "received" });
        assert!(require_status(&order, CLOSE.from, CLOSE.refused).is_ok());
        let Err(Refusal::Response(response)) =
            require_status(&order, APPROVE.from, APPROVE.refused)
        else {
            panic!("expected a refusal");
        };
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_event_carries_the_header_and_the_extra() {
        let order = json!({
            "id": "po_1", "poNumber": "PO-1", "status": "approved",
            "supplierId": "sup_1", "warehouseId": null, "total": "10.00",
        });
        assert_eq!(
            event_data(&order, &[("approvedBy", json!("user_1"))]),
            json!({
                "id": "po_1", "poNumber": "PO-1", "status": "approved",
                "supplierId": "sup_1", "warehouseId": null, "approvedBy": "user_1",
            })
        );
    }

    #[test]
    fn an_empty_body_reads_as_an_empty_object() {
        assert_eq!(&or_empty_object(Bytes::new())[..], b"{}");
        assert_eq!(&or_empty_object(Bytes::from_static(b"  \n"))[..], b"{}");
        assert_eq!(
            &or_empty_object(Bytes::from_static(b"{\"a\":1}"))[..],
            b"{\"a\":1}"
        );
    }
}
