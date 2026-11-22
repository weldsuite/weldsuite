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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{ORDERS_READ, PRODUCTS_READ};
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

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
macro_rules! not_a_sale {
    () => {
        "('cancelled', 'canceled', 'failed')"
    };
}

const PRODUCTS_SQL: &str = "select jsonb_build_object( \
     'total', count(*)::int, \
     'active', count(*) filter (where p.status = 'active')::int, \
     'draft', count(*) filter (where p.status = 'draft')::int) \
     from products p where p.deleted_at is null";

const ORDERS_SQL: &str = concat!(
    "select jsonb_build_object( \
     'total', count(*)::int, \
     'open', count(*) filter (where o.status in ('pending', 'processing', 'on_hold'))::int, \
     'awaitingFulfilment', count(*) filter (where o.status not in ",
    not_a_sale!(),
    " and o.status not in ('completed', 'refunded') \
       and coalesce(o.fulfillment_status, 'unfulfilled') in ('unfulfilled', 'picking', 'partial'))::int, \
     'unpaid', count(*) filter (where o.status not in ",
    not_a_sale!(),
    " and coalesce(o.payment_status, 'pending') <> 'paid')::int) \
     from orders o where o.deleted_at is null"
);

/// Revenue of the last 30 days per currency, as decimal strings (numeric
/// columns are never floats here), biggest first.
const REVENUE_SQL: &str = concat!(
    "select coalesce(jsonb_agg(jsonb_build_object( \
         'currency', r.currency, 'orders', r.orders, 'revenue', r.revenue::text) \
         order by r.revenue desc, r.currency), '[]'::jsonb) \
     from (select coalesce(o.currency, 'EUR') as currency, count(*)::int as orders, \
                  coalesce(sum(o.total), 0)::numeric(18, 2) as revenue \
           from orders o \
           where o.deleted_at is null and o.status not in ",
    not_a_sale!(),
    " and o.created_at >= (now() at time zone 'utc') - interval '30 days' \
           group by 1) r"
);

/// The five newest orders. Timestamps are stored in UTC without a zone, as
/// Drizzle writes them.
const RECENT_SQL: &str = "select coalesce(jsonb_agg(jsonb_build_object( \
         'id', r.id, 'orderNumber', r.order_number, 'source', r.source, \
         'status', r.status, 'paymentStatus', r.payment_status, \
         'fulfillmentStatus', r.fulfillment_status, 'currency', r.currency, \
         'total', r.total::text, 'customerName', r.customer_name, \
         'createdAt', to_char(r.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
         order by r.created_at desc, r.id desc), '[]'::jsonb) \
     from (select * from orders o where o.deleted_at is null \
           order by o.created_at desc, o.id desc limit 5) r";

async fn overview(caller: Caller) -> Response {
    let mut body = Map::new();

    if caller.permissions.has_any(&[PRODUCTS_READ]) {
        match sqlx::query_scalar::<_, Value>(PRODUCTS_SQL)
            .fetch_one(&caller.db)
            .await
        {
            Ok(products) => body.insert("products".to_owned(), products),
            Err(error) => return internal(&error, "Failed to load the product counts"),
        };
    } else {
        body.insert("products".to_owned(), Value::Null);
    }

    if caller.permissions.has_any(&[ORDERS_READ]) {
        let orders = sqlx::query_scalar::<_, Value>(ORDERS_SQL)
            .fetch_one(&caller.db)
            .await;
        let revenue = sqlx::query_scalar::<_, Value>(REVENUE_SQL)
            .fetch_one(&caller.db)
            .await;
        let recent = sqlx::query_scalar::<_, Value>(RECENT_SQL)
            .fetch_one(&caller.db)
            .await;
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
