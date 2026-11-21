//! Orders. [`write`] is the only way an order and its items are created or
//! changed (ADR COM-010): the commerce routes and the connector ingest both
//! go through it, so numbering, totals, discount redemptions and the edit
//! rules live in one place. It never writes `fulfilled_quantity` or
//! `fulfillment_status` (WeldStash owns them, STASH-001/006) and reserves no
//! stock.

pub mod lines;
pub mod plan;
pub mod write;

use serde_json::Value;
use sqlx::PgConnection;

use crate::status::{self, Facts};
use crate::tables::{ORDER_ITEMS, ORDERS};

/// An order row and its items, as Drizzle reads them.
#[derive(Debug, Clone)]
pub struct Stored {
    pub order: Value,
    pub items: Vec<Value>,
}

impl Stored {
    /// The text of a property of the order.
    #[must_use]
    pub fn text(&self, key: &str) -> Option<&str> {
        self.order.get(key).and_then(Value::as_str)
    }

    /// Items and customer may still change.
    #[must_use]
    pub fn editable(&self) -> bool {
        editable(&self.order, &self.items)
    }

    /// The order may still be cancelled.
    #[must_use]
    pub fn cancellable(&self) -> bool {
        cancellable(&self.order, &self.items)
    }
}

fn facts<'a>(order: &'a Value, items: &[Value]) -> Facts<'a> {
    Facts {
        status: order
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending"),
        payment_status: order
            .get("paymentStatus")
            .and_then(Value::as_str)
            .unwrap_or("pending"),
        any_fulfilled: items.iter().any(|item| {
            item.get("fulfilledQuantity")
                .and_then(Value::as_i64)
                .is_some_and(|n| n > 0)
        }),
    }
}

/// `editable` of the API: not cancelled or completed, not paid, nothing
/// fulfilled, and not an order a store sync owns (`external_order_id`): the
/// store's next sync would write the change away.
#[must_use]
pub fn editable(order: &Value, items: &[Value]) -> bool {
    let synced = order
        .get("externalOrderId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    !synced && status::editable(facts(order, items))
}

/// `cancellable` of the API: not cancelled or completed, nothing fulfilled.
#[must_use]
pub fn cancellable(order: &Value, items: &[Value]) -> bool {
    status::cancellable(facts(order, items))
}

/// The live order `id` with its items, in creation order; `lock` holds the
/// order row until the transaction ends.
///
/// # Errors
/// A failed statement.
pub async fn load(
    conn: &mut PgConnection,
    id: &str,
    lock: bool,
) -> Result<Option<Stored>, sqlx::Error> {
    let sql = if lock {
        ORDERS
            .select_live
            .replace(" limit 1", " limit 1 for update of t")
    } else {
        ORDERS.select_live.to_owned()
    };
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let items = items(conn, id).await?;
    Ok(Some(Stored {
        order: ORDERS.js(row),
        items,
    }))
}

/// The items of an order in creation order.
///
/// # Errors
/// A failed statement.
pub async fn items(conn: &mut PgConnection, order_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {} from order_items t where t.order_id = $1 order by t.created_at asc, t.id asc",
        ORDER_ITEMS.row
    )))
    .bind(order_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|row| ORDER_ITEMS.js(row)).collect())
}
