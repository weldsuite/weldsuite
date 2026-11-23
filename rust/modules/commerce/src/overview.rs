//! `/api/commerce/overview`: the numbers the WeldCommerce overview page
//! shows. Each section needs its own read permission; a caller with only one
//! of `products:read` and `orders:read` gets that section and `null` for the
//! others.
//!
//! Orders here are every row in `orders`, whatever their source: native,
//! manual and imported from Shopify or WooCommerce (ADR COM-010).

use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{
    Alias, Asterisk, Expr, Func, IntoCondition, IntoIden, Order, Query, SelectStatement,
};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbBackend, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::permission_keys::{ORDERS_READ, PRODUCTS_READ};
use weldsuite_db::orm;
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{orders, products};

use crate::args::utc_now_sql;
use crate::{Caller, CommerceState, internal};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/overview",
        get(overview).route_layer(gate.require([ORDERS_READ, PRODUCTS_READ])),
    )
}

/// Order statuses that are not a sale (connectors write both spellings of
/// cancelled). Replenishment reads demand with the same rule.
const NOT_A_SALE: [&str; 3] = ["cancelled", "canceled", "failed"];

/// `count(*)::int`.
fn count_all() -> Expr {
    Func::cast_as(Func::count(Expr::col(Asterisk)), "int").into()
}

/// `count(*) filter (where condition)::int`, as `count(case when … then 1
/// end)`.
fn count_where(condition: impl IntoCondition) -> Expr {
    Func::cast_as(Func::count(Expr::case(condition, 1)), "int").into()
}

/// `coalesce(t.column, fallback)`.
fn or_default<C: IntoIden>(table: impl IntoIden, column: C, fallback: &str) -> Expr {
    Func::coalesce([Expr::col((table, column)), Expr::val(fallback)]).into()
}

/// `{ total, active, draft }` of the live products.
async fn product_counts(db: &DatabaseConnection) -> Result<Value, DbErr> {
    let row: Option<(i32, i32, i32)> = products::Entity::find()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(count_where(products::Column::Status.eq("active")), "active")
        .column_as(count_where(products::Column::Status.eq("draft")), "draft")
        .filter(products::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    let (total, active, draft) = row.unwrap_or_default();
    Ok(json!({ "total": total, "active": active, "draft": draft }))
}

/// `{ total, open, awaitingFulfilment, unpaid }` of the live orders.
async fn order_counts(db: &DatabaseConnection) -> Result<Value, DbErr> {
    let sale = || orders::Column::Status.is_not_in(NOT_A_SALE);
    let fulfilment = or_default(
        orders::Entity,
        orders::Column::FulfillmentStatus,
        "unfulfilled",
    );
    let payment = or_default(orders::Entity, orders::Column::PaymentStatus, "pending");
    let row: Option<(i32, i32, i32, i32)> = orders::Entity::find()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(
            count_where(orders::Column::Status.is_in(["pending", "processing", "on_hold"])),
            "open",
        )
        .column_as(
            count_where(
                Condition::all()
                    .add(sale())
                    .add(orders::Column::Status.is_not_in(["completed", "refunded"]))
                    .add(sea_orm::ExprTrait::is_in(
                        fulfilment,
                        ["unfulfilled", "picking", "partial"],
                    )),
            ),
            "awaiting",
        )
        .column_as(
            count_where(
                Condition::all()
                    .add(sale())
                    .add(sea_orm::ExprTrait::ne(payment, "paid")),
            ),
            "unpaid",
        )
        .filter(orders::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    let (total, open, awaiting, unpaid) = row.unwrap_or_default();
    Ok(json!({
        "total": total,
        "open": open,
        "awaitingFulfilment": awaiting,
        "unpaid": unpaid,
    }))
}

/// Revenue of the last 30 days in one currency.
#[derive(Debug, FromQueryResult, Serialize)]
struct Revenue {
    currency: String,
    orders: i32,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    revenue: BigDecimal,
}

/// `sum(total)` and `count(*)` of the last 30 days' sales per currency
/// (none is EUR), biggest first.
fn revenue_statement() -> SelectStatement {
    let sales = Query::select()
        .expr_as(
            or_default(orders::Entity, orders::Column::Currency, "EUR"),
            Alias::new("currency"),
        )
        .column(orders::Column::Total)
        .from(orders::Entity)
        .and_where(orders::Column::DeletedAt.is_null())
        .and_where(orders::Column::Status.is_not_in(NOT_A_SALE))
        .and_where(sea_orm::ExprTrait::gte(
            Expr::col((orders::Entity, orders::Column::CreatedAt)),
            sea_orm::ExprTrait::sub(
                utc_now_sql(),
                sea_orm::ExprTrait::cast_as(Expr::val("30 days"), "interval"),
            ),
        ))
        .to_owned();
    let r = Alias::new("r");
    let summed: Expr = Func::coalesce([
        Expr::from(Func::sum(Expr::col((r.clone(), orders::Column::Total)))),
        Expr::val(0),
    ])
    .into();
    Query::select()
        .column((r.clone(), Alias::new("currency")))
        .expr_as(count_all(), Alias::new("orders"))
        .expr_as(
            Func::cast_as(summed, Alias::new("numeric(18, 2)")),
            Alias::new("revenue"),
        )
        .from_subquery(sales, r.clone())
        .group_by_col((r, Alias::new("currency")))
        .order_by(Alias::new("revenue"), Order::Desc)
        .order_by(Alias::new("currency"), Order::Asc)
        .to_owned()
}

/// Revenue of the last 30 days per currency, as decimal strings (numeric
/// columns are never floats here), biggest first.
async fn revenue(db: &DatabaseConnection) -> Result<Value, DbErr> {
    let rows = Revenue::find_by_statement(DbBackend::Postgres.build(&revenue_statement()))
        .all(db)
        .await?;
    serde_json::to_value(rows).map_err(|error| DbErr::Json(error.to_string()))
}

/// One of the five newest orders. Timestamps are stored in UTC without a
/// zone, as Drizzle writes them.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recent {
    id: String,
    order_number: String,
    source: Option<String>,
    status: String,
    payment_status: Option<String>,
    fulfillment_status: Option<String>,
    currency: Option<String>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    total: BigDecimal,
    customer_name: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
}

/// The five newest orders.
async fn recent(db: &DatabaseConnection) -> Result<Value, DbErr> {
    let rows: Vec<Recent> = orders::Entity::find()
        .select_only()
        .columns([
            orders::Column::Id,
            orders::Column::OrderNumber,
            orders::Column::Source,
            orders::Column::Status,
            orders::Column::PaymentStatus,
            orders::Column::FulfillmentStatus,
            orders::Column::Currency,
            orders::Column::Total,
            orders::Column::CustomerName,
            orders::Column::CreatedAt,
        ])
        .filter(orders::Column::DeletedAt.is_null())
        .order_by_desc(orders::Column::CreatedAt)
        .order_by_desc(orders::Column::Id)
        .limit(5)
        .into_model()
        .all(db)
        .await?;
    serde_json::to_value(rows).map_err(|error| DbErr::Json(error.to_string()))
}

async fn overview(caller: Caller) -> Response {
    let mut body = Map::new();

    if caller.permissions.has_any(&[PRODUCTS_READ]) {
        match product_counts(&orm(&caller.db)).await {
            Ok(products) => body.insert("products".to_owned(), products),
            Err(error) => return internal(&error, "Failed to load the product counts"),
        };
    } else {
        body.insert("products".to_owned(), Value::Null);
    }

    if caller.permissions.has_any(&[ORDERS_READ]) {
        let db = orm(&caller.db);
        let orders = order_counts(&db).await;
        let revenue = revenue(&db).await;
        let recent = recent(&db).await;
        match (orders, revenue, recent) {
            (Ok(orders), Ok(revenue), Ok(recent)) => {
                body.insert("orders".to_owned(), orders);
                body.insert("revenueLast30Days".to_owned(), revenue);
                body.insert("recentOrders".to_owned(), recent);
            }
            (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
                return internal(&error, "Failed to load the order counts");
            }
        }
    } else {
        for key in ["orders", "revenueLast30Days", "recentOrders"] {
            body.insert(key.to_owned(), Value::Null);
        }
    }

    Data(json!(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The currency is coalesced before it is grouped (an order without one
    /// counts as EUR), as the subquery the TypeScript-era SQL grouped did.
    #[test]
    fn revenue_groups_the_coalesced_currency() {
        assert_eq!(
            DbBackend::Postgres.build(&revenue_statement()).sql,
            r#"SELECT "r"."currency", CAST(COUNT(*) AS int) AS "orders", CAST(COALESCE(SUM("r"."total"), $1) AS numeric(18, 2)) AS "revenue" FROM (SELECT COALESCE("orders"."currency", $2) AS "currency", "total" FROM "orders" WHERE "orders"."deleted_at" IS NULL AND "orders"."status" NOT IN ($3, $4, $5) AND "orders"."created_at" >= timezone($6, now()) - CAST($7 AS interval)) AS "r" GROUP BY "r"."currency" ORDER BY "revenue" DESC, "currency" ASC"#
        );
    }
}
