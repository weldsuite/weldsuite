//! Orders. [`write`] is the only way an order and its items are created or
//! changed (ADR COM-010): the commerce routes and the connector ingest both
//! go through it, so numbering, totals, discount redemptions and the edit
//! rules live in one place. It never writes `fulfilled_quantity` or
//! `fulfillment_status` (WeldStash owns them, STASH-001/006) and reserves no
//! stock.

pub mod lines;
pub mod plan;
pub mod write;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value};
use sqlx::PgConnection;
use weldsuite_books_domain::table::Table;
use weldsuite_schema::tenant::{order_items, orders};

use crate::db;
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

/// A row as [`Table::js`] reads one: the entity's JSON (Drizzle's shape),
/// cut to `table`'s properties in its order, so a column the entity has and
/// the generated table does not (`orders.guest_access_token_hash`) stays out.
fn drizzle(table: &Table, row: Result<Value, serde_json::Error>) -> Result<Value, DbErr> {
    let Value::Object(mut row) = row.map_err(|error| DbErr::Json(error.to_string()))? else {
        return Err(DbErr::Json(format!("{} row is not an object", table.name)));
    };
    let mut out = Map::with_capacity(table.columns.len());
    for column in table.columns {
        let value = row.remove(column.prop).unwrap_or(Value::Null);
        out.insert(column.prop.to_owned(), value);
    }
    Ok(Value::Object(out))
}

/// The live order `id` with its items, in creation order; `lock` holds the
/// order row until the transaction ends.
///
/// # Errors
/// A failed statement.
pub async fn load(conn: &mut PgConnection, id: &str, lock: bool) -> Result<Option<Stored>, DbErr> {
    let mut query =
        orders::Entity::find_by_id(id.to_owned()).filter(orders::Column::DeletedAt.is_null());
    if lock {
        query = query.lock_exclusive();
    }
    let Some(row) = query.one(&db::on(conn)).await? else {
        return Ok(None);
    };
    let items = items(conn, id).await?;
    Ok(Some(Stored {
        order: drizzle(&ORDERS, serde_json::to_value(&row))?,
        items,
    }))
}

/// The items of an order in creation order.
///
/// # Errors
/// A failed statement.
pub async fn items(conn: &mut PgConnection, order_id: &str) -> Result<Vec<Value>, DbErr> {
    order_items::Entity::find()
        .filter(order_items::Column::OrderId.eq(order_id))
        .order_by_asc(order_items::Column::CreatedAt)
        .order_by_asc(order_items::Column::Id)
        .all(&db::on(conn))
        .await?
        .iter()
        .map(|row| drizzle(&ORDER_ITEMS, serde_json::to_value(row)))
        .collect()
}
