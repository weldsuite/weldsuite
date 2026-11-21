//! `POST /replenishment/purchase-orders`: turn plans into draft purchase
//! orders, one per supplier and warehouse.
//!
//! Each plan becomes a line: the quantity sent for it (rounded up to the
//! product supplier's minimum order and pack size with
//! [`round_order_qty`]) or its suggested quantity; the product supplier's
//! name and SKU, else the product's (and variant's); the product supplier's
//! unit cost, else the variant's or product's cost price, else 0; amounts as
//! the purchase order line routes work them out. The supplier is the plan's
//! product supplier while it is live, else the item's preferred one now.
//! A header gets the supplier's (or product supplier's) currency, an
//! expected date of today plus the longest lead time of its lines, a fresh
//! `PO-YYYYMMDD-XXXX` number and totals from its lines. The plans move to
//! `ordered` with the purchase order's id, all in one transaction; each
//! purchase order publishes `purchase_order` `created`.
//!
//! Plans that can't be ordered are skipped with a reason: `not_found`,
//! `already_ordered`, `no_supplier` or `zero_quantity`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::{Duration, OffsetDateTime};
use weldsuite_catalogs::entity_events::{EventName, PURCHASE_ORDER_CREATED};
use weldsuite_catalogs::permission_keys::PURCHASE_ORDERS_CREATE;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::demand::{Link, choose_link, ymd};
use super::engine::{MAX_QUANTITY, round_order_qty};
use super::routes::{id_text, whole};
use super::settings::load_settings;
use crate::po_number::generate_po_numbers;
use crate::po_totals::recompute_po_totals;
use crate::purchase_order_items::{Figures, line_amounts};
use crate::{Caller, Refusal, StashState, now, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/purchase-orders",
        post(create).route_layer(gate.require([PURCHASE_ORDERS_CREATE])),
    )
}

/// The body: `{ planIds: string[] (1–500), quantities?: { [planId]: int ≥ 1 } }`.
#[derive(Debug, Default)]
struct Body {
    plan_ids: Vec<String>,
    quantities: HashMap<String, i64>,
}

fn read_body(issues: &mut Issues, body: &Map<String, Value>) -> Body {
    let plan_ids = issues.list(
        body,
        "planIds",
        Presence::Required,
        Some(1),
        Some(500),
        |issues, item| issues.item_text(item, id_text()),
    );
    let quantities = issues.nested(body, "quantities", Presence::Optional, |issues, fields| {
        let mut out = HashMap::new();
        for key in fields.keys() {
            if let Some(quantity) = issues
                .whole_number(fields, key, Presence::Required, whole(1, MAX_QUANTITY))
                .into_option()
            {
                out.insert(key.clone(), quantity);
            }
        }
        out
    });
    Body {
        plan_ids: plan_ids.into_option().unwrap_or_default(),
        quantities: quantities.into_option().unwrap_or_default(),
    }
}

/// A plan as the route reads it, locked.
#[derive(Debug, Clone)]
struct PlanRow {
    id: String,
    product_id: String,
    variant_id: Option<String>,
    warehouse_id: String,
    warehouse_name: Option<String>,
    suggested_qty: i64,
    review_status: String,
    lead_time_days: Option<i64>,
    product_supplier_id: Option<String>,
    product_name: Option<String>,
    product_sku: Option<String>,
    variant_name: Option<String>,
    variant_sku: Option<String>,
    cost: Option<f64>,
}

type PlanTuple = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    i64,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
);

/// A live product supplier's terms and its live supplier.
#[derive(Debug, Clone)]
struct Terms {
    supplier_sku: Option<String>,
    supplier_product_name: Option<String>,
    currency: Option<String>,
    supplier_name: Option<String>,
    supplier_currency: Option<String>,
}

type TermsTuple = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

const TERMS: &str = "select ps.id, ps.product_id, nullif(ps.variant_id, ''), ps.supplier_id, \
     ps.supplier_sku, ps.supplier_product_name, ps.unit_cost::float8, ps.currency, \
     ps.lead_time_days::bigint, ps.min_order_qty::bigint, ps.order_multiple::bigint, \
     s.name, s.currency, s.default_lead_time_days::bigint \
     from product_suppliers ps join suppliers s on s.id = ps.supplier_id and s.deleted_at is null \
     where ps.deleted_at is null and ps.product_id = any($1) \
     order by ps.product_id, ps.is_preferred desc, ps.created_at, ps.id";

/// One line to write.
#[derive(Debug, Clone)]
struct Line {
    plan_id: String,
    product_id: String,
    variant_id: Option<String>,
    sku: Option<String>,
    name: String,
    quantity: i64,
    unit_price: f64,
    lead_time_days: i64,
    currency: Option<String>,
}

/// One purchase order to write.
#[derive(Debug, Clone)]
struct Order {
    supplier_id: String,
    supplier_name: Option<String>,
    warehouse_id: String,
    warehouse_name: Option<String>,
    lines: Vec<Line>,
}

/// What the route answers and publishes.
struct Outcome {
    orders: Vec<Value>,
    skipped: Vec<Value>,
    events: Vec<(EventName, String, Value)>,
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create purchase orders";
    let body = match validate(&headers, &body, read_body) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match create_orders(&caller, body).await {
        Ok(outcome) => {
            caller.publish_in_order(&state, outcome.events);
            Created(json!({ "purchaseOrders": outcome.orders, "skipped": outcome.skipped }))
                .into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

fn skip(plan_id: &str, reason: &str) -> Value {
    json!({ "planId": plan_id, "reason": reason })
}

/// The line's name: the product supplier's, else the product's (with the
/// variant's), at most 255 characters.
fn line_name(plan: &PlanRow, terms: Option<&Terms>) -> String {
    let own = terms
        .and_then(|terms| terms.supplier_product_name.clone())
        .filter(|name| !name.trim().is_empty());
    let name = own.unwrap_or_else(|| {
        let product = plan
            .product_name
            .clone()
            .unwrap_or_else(|| plan.product_id.clone());
        match plan.variant_name.as_deref().filter(|name| !name.is_empty()) {
            Some(variant) => format!("{product} - {variant}"),
            None => product,
        }
    });
    name.chars().take(255).collect()
}

#[allow(clippy::too_many_lines)] // read, group, write
async fn create_orders(caller: &Caller, body: Body) -> Result<Outcome, Refusal> {
    let db = &caller.db;
    let mut seen = HashSet::new();
    let ids: Vec<String> = body
        .plan_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let settings = load_settings(db).await?;
    let user_id = caller.user_id.clone();
    let quantities = body.quantities;
    let at = now();
    let today = OffsetDateTime::now_utc().date();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let plans = lock_plans(conn, &ids).await?;
            let products: Vec<String> = plans
                .values()
                .map(|plan| plan.product_id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let rows: Vec<TermsTuple> = sqlx::query_as(TERMS)
                .bind(&products)
                .fetch_all(&mut *conn)
                .await?;
            let mut links = Vec::with_capacity(rows.len());
            let mut terms: HashMap<String, Terms> = HashMap::new();
            for (
                id,
                product_id,
                variant_id,
                supplier_id,
                supplier_sku,
                supplier_product_name,
                unit_cost,
                currency,
                lead_time_days,
                min_order_qty,
                order_multiple,
                supplier_name,
                supplier_currency,
                supplier_lead_time_days,
            ) in rows
            {
                terms.insert(
                    id.clone(),
                    Terms {
                        supplier_sku,
                        supplier_product_name,
                        currency,
                        supplier_name,
                        supplier_currency,
                    },
                );
                links.push(Link {
                    id,
                    product_id,
                    variant_id,
                    supplier_id,
                    unit_cost,
                    lead_time_days,
                    min_order_qty,
                    order_multiple: order_multiple.unwrap_or(1).max(1),
                    supplier_lead_time_days,
                });
            }

            let mut skipped = Vec::new();
            let mut orders: Vec<Order> = Vec::new();
            for id in &ids {
                let Some(plan) = plans.get(id) else {
                    skipped.push(skip(id, "not_found"));
                    continue;
                };
                if plan.review_status == "ordered" {
                    skipped.push(skip(id, "already_ordered"));
                    continue;
                }
                let Some(link) = choose_link(
                    &links,
                    &plan.product_id,
                    plan.variant_id.as_deref(),
                    plan.product_supplier_id.as_deref(),
                ) else {
                    skipped.push(skip(id, "no_supplier"));
                    continue;
                };
                let quantity = match quantities.get(id) {
                    Some(wanted) => round_order_qty(
                        *wanted,
                        link.min_order_qty.unwrap_or(0),
                        link.order_multiple,
                    ),
                    None => plan.suggested_qty,
                };
                if quantity <= 0 {
                    skipped.push(skip(id, "zero_quantity"));
                    continue;
                }
                let link_terms = terms.get(&link.id);
                let lead = plan
                    .lead_time_days
                    .or(link.lead_time_days)
                    .or(link.supplier_lead_time_days)
                    .unwrap_or(settings.lead_time_days)
                    .clamp(0, 3650);
                let entry = Line {
                    plan_id: plan.id.clone(),
                    product_id: plan.product_id.clone(),
                    variant_id: plan.variant_id.clone(),
                    sku: link_terms
                        .and_then(|terms| terms.supplier_sku.clone())
                        .filter(|sku| !sku.is_empty())
                        .or_else(|| plan.variant_sku.clone().filter(|sku| !sku.is_empty()))
                        .or_else(|| plan.product_sku.clone()),
                    name: line_name(plan, link_terms),
                    quantity,
                    unit_price: link
                        .unit_cost
                        .or(plan.cost)
                        .filter(|price| price.is_finite() && *price >= 0.0)
                        .unwrap_or(0.0),
                    lead_time_days: lead,
                    currency: link_terms.and_then(|terms| {
                        terms
                            .currency
                            .clone()
                            .filter(|c| !c.is_empty())
                            .or_else(|| terms.supplier_currency.clone())
                    }),
                };
                match orders.iter_mut().find(|order| {
                    order.supplier_id == link.supplier_id && order.warehouse_id == plan.warehouse_id
                }) {
                    Some(order) => order.lines.push(entry),
                    None => orders.push(Order {
                        supplier_id: link.supplier_id.clone(),
                        supplier_name: link_terms.and_then(|terms| terms.supplier_name.clone()),
                        warehouse_id: plan.warehouse_id.clone(),
                        warehouse_name: plan.warehouse_name.clone(),
                        lines: vec![entry],
                    }),
                }
            }

            let numbers = generate_po_numbers(&mut *conn, orders.len()).await?;
            let mut created = Vec::with_capacity(orders.len());
            let mut events = Vec::with_capacity(orders.len());
            for (order, number) in orders.iter().zip(numbers) {
                let row = write_order(&mut *conn, order, &number, &user_id, &at, today).await?;
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                created.push(json!({
                    "id": id,
                    "poNumber": row["poNumber"],
                    "supplierId": order.supplier_id,
                    "supplierName": order.supplier_name,
                    "warehouseId": order.warehouse_id,
                    "lineCount": order.lines.len(),
                    "total": row["total"],
                }));
                events.push((
                    PURCHASE_ORDER_CREATED,
                    id.clone(),
                    json!({
                        "id": id,
                        "poNumber": row["poNumber"],
                        "status": row["status"],
                        "supplierId": order.supplier_id,
                    }),
                ));
            }
            Ok::<_, Refusal>(Outcome {
                orders: created,
                skipped,
                events,
            })
        })
    })
    .await
}

/// The plans `ids`, locked for the transaction.
async fn lock_plans(
    conn: &mut PgConnection,
    ids: &[String],
) -> Result<HashMap<String, PlanRow>, sqlx::Error> {
    let rows: Vec<PlanTuple> = sqlx::query_as(
        "select t.id, t.product_id, nullif(t.variant_id, ''), t.warehouse_id, w.name, \
         t.suggested_qty::bigint, t.review_status, t.lead_time_days::bigint, t.product_supplier_id, \
         p.name, p.sku, v.name, v.sku, coalesce(v.cost_price, p.cost_price)::float8 \
         from stash_item_plans t \
         left join products p on p.id = t.product_id \
         left join product_variants v on v.id = t.variant_id \
         left join warehouses w on w.id = t.warehouse_id \
         where t.id = any($1) order by t.id for update of t",
    )
    .bind(ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                product_id,
                variant_id,
                warehouse_id,
                warehouse_name,
                suggested_qty,
                review_status,
                lead_time_days,
                product_supplier_id,
                product_name,
                product_sku,
                variant_name,
                variant_sku,
                cost,
            )| {
                (
                    id.clone(),
                    PlanRow {
                        id,
                        product_id,
                        variant_id,
                        warehouse_id,
                        warehouse_name,
                        suggested_qty,
                        review_status,
                        lead_time_days,
                        product_supplier_id,
                        product_name,
                        product_sku,
                        variant_name,
                        variant_sku,
                        cost,
                    },
                )
            },
        )
        .collect())
}

/// Insert `order` as a draft with its lines, total it, and mark its plans
/// ordered. The purchase order row.
async fn write_order(
    conn: &mut PgConnection,
    order: &Order,
    number: &str,
    user_id: &str,
    at: &str,
    today: time::Date,
) -> Result<Value, Refusal> {
    let id = generate_id("po");
    let lead = order
        .lines
        .iter()
        .map(|line| line.lead_time_days)
        .max()
        .unwrap_or(0);
    let expected = format!("{}T00:00:00.000", ymd(today + Duration::days(lead)));
    let currency = order.lines.iter().find_map(|line| line.currency.clone());
    sqlx::query(
        "insert into purchase_orders (id, created_at, updated_at, po_number, supplier_id, \
         supplier_name, warehouse_id, warehouse_name, status, expected_date, currency, created_by) \
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, 'draft', $8::timestamp, \
         coalesce($9, 'USD'), $10)",
    )
    .bind(&id)
    .bind(at)
    .bind(number)
    .bind(&order.supplier_id)
    .bind(order.supplier_name.as_deref())
    .bind(&order.warehouse_id)
    .bind(order.warehouse_name.as_deref())
    .bind(&expected)
    .bind(currency.as_deref())
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    insert_lines(conn, &id, at, &order.lines).await?;
    let row = recompute_po_totals(&mut *conn, &id, at)
        .await?
        .ok_or_else(|| Refusal::from(ApiError::internal()))?;
    let plan_ids: Vec<String> = order
        .lines
        .iter()
        .map(|line| line.plan_id.clone())
        .collect();
    sqlx::query(
        "update stash_item_plans set review_status = 'ordered', purchase_order_id = $2, \
         dismissed_until = null, dismissed_by = null, dismissed_qty = null, \
         updated_at = $3::timestamp where id = any($1)",
    )
    .bind(&plan_ids)
    .bind(&id)
    .bind(at)
    .execute(&mut *conn)
    .await?;
    Ok(row)
}

/// The lines of the purchase order `order_id`, in one statement, with
/// their amounts as the line routes work them out.
async fn insert_lines(
    conn: &mut PgConnection,
    order_id: &str,
    at: &str,
    lines: &[Line],
) -> Result<(), sqlx::Error> {
    let mut ids = Vec::new();
    let mut products = Vec::new();
    let mut variants: Vec<Option<String>> = Vec::new();
    let mut skus: Vec<Option<String>> = Vec::new();
    let mut names = Vec::new();
    let mut quantities = Vec::new();
    let mut pending = Vec::new();
    let mut prices = Vec::new();
    let mut discount_percents = Vec::new();
    let mut discounts = Vec::new();
    let mut tax_percents = Vec::new();
    let mut taxes = Vec::new();
    let mut totals = Vec::new();
    for line in lines {
        let amounts = line_amounts(Figures {
            quantity_ordered: line.quantity,
            quantity_received: 0,
            unit_price: line.unit_price,
            discount_percent: 0.0,
            tax_percent: 0.0,
        });
        ids.push(generate_id("poi"));
        products.push(line.product_id.clone());
        variants.push(line.variant_id.clone());
        skus.push(line.sku.clone());
        names.push(line.name.clone());
        quantities.push(line.quantity);
        pending.push(amounts.quantity_pending);
        prices.push(amounts.unit_price);
        discount_percents.push(amounts.discount_percent);
        discounts.push(amounts.discount_amount);
        tax_percents.push(amounts.tax_percent);
        taxes.push(amounts.tax_amount);
        totals.push(amounts.total);
    }
    sqlx::query(
        "insert into purchase_order_items (id, purchase_order_id, created_at, updated_at, \
         product_id, variant_id, sku, name, quantity_ordered, quantity_received, \
         quantity_rejected, quantity_pending, unit_price, discount_percent, discount_amount, \
         tax_percent, tax_amount, total) \
         select u.id, $1, $2::timestamp, $2::timestamp, u.product_id, u.variant_id, u.sku, \
         u.name, u.quantity, 0, 0, u.pending, u.unit_price::numeric, u.discount_percent::numeric, \
         u.discount_amount::numeric, u.tax_percent::numeric, u.tax_amount::numeric, \
         u.total::numeric \
         from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int8[], \
         $9::int8[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], \
         $15::text[]) with ordinality as u(id, product_id, variant_id, sku, name, quantity, \
         pending, unit_price, discount_percent, discount_amount, tax_percent, tax_amount, total, n) \
         order by u.n",
    )
    .bind(order_id)
    .bind(at)
    .bind(&ids)
    .bind(&products)
    .bind(&variants)
    .bind(&skus)
    .bind(&names)
    .bind(&quantities)
    .bind(&pending)
    .bind(&prices)
    .bind(&discount_percents)
    .bind(&discounts)
    .bind(&tax_percents)
    .bind(&taxes)
    .bind(&totals)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(variant: Option<&str>) -> PlanRow {
        PlanRow {
            id: "iplan_1".to_owned(),
            product_id: "prod_1".to_owned(),
            variant_id: variant.map(str::to_owned),
            warehouse_id: "wh_1".to_owned(),
            warehouse_name: None,
            suggested_qty: 10,
            review_status: "open".to_owned(),
            lead_time_days: None,
            product_supplier_id: None,
            product_name: Some("Lamp".to_owned()),
            product_sku: Some("LAMP".to_owned()),
            variant_name: variant.map(|_| "Red".to_owned()),
            variant_sku: None,
            cost: None,
        }
    }

    #[test]
    fn a_line_is_named_after_the_supplier_then_the_product() {
        assert_eq!(line_name(&plan(None), None), "Lamp");
        assert_eq!(line_name(&plan(Some("var_1")), None), "Lamp - Red");
        let terms = Terms {
            supplier_sku: None,
            supplier_product_name: Some("LMP-30 lamp".to_owned()),
            currency: None,
            supplier_name: None,
            supplier_currency: None,
        };
        assert_eq!(line_name(&plan(None), Some(&terms)), "LMP-30 lamp");
    }

    #[test]
    fn the_body_reads_plan_ids_and_quantities() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let fields = body.as_object().cloned().unwrap_or_default();
            let read = read_body(&mut issues, &fields);
            (read, issues.is_empty())
        };
        let (body, ok) = read(json!({ "planIds": ["a", "b"], "quantities": { "a": 4 } }));
        assert!(ok);
        assert_eq!(body.plan_ids, vec!["a", "b"]);
        assert_eq!(body.quantities.get("a"), Some(&4));
        assert!(!read(json!({ "planIds": [] })).1);
        assert!(!read(json!({ "planIds": ["a"], "quantities": { "a": 0 } })).1);
        assert!(!read(json!({ "planIds": ["a"], "quantities": { "a": 1.5 } })).1);
    }
}
