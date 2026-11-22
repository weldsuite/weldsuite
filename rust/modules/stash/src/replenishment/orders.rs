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
use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, LockType};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType, Order,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationDef,
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::{Duration, OffsetDateTime, PrimitiveDateTime, Time};
use weldsuite_catalogs::entity_events::{EventName, PURCHASE_ORDER_CREATED};
use weldsuite_catalogs::permission_keys::PURCHASE_ORDERS_CREATE;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, generate_id};
use weldsuite_db::{OrmConn, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    product_suppliers, product_variants, products, purchase_order_items, purchase_orders,
    stash_item_plans as plans, suppliers, warehouses,
};

use super::demand::{Link, LinkRow, choose_link, link_query};
use super::engine::{MAX_QUANTITY, round_order_qty};
use super::routes::{id_text, whole};
use super::settings::load_settings;
use crate::po_number::generate_po_numbers;
use crate::po_totals::recompute_po_totals;
use crate::purchase_order_items::{Figures, line_amounts};
use crate::{Caller, Refusal, StashState, validate};

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
    i32,
    String,
    Option<i32>,
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

/// A live product supplier with its live supplier: the link, and the
/// terms a line and its header take.
#[derive(Debug, FromQueryResult)]
struct TermsRow {
    id: String,
    product_id: String,
    variant_id: Option<String>,
    supplier_id: String,
    unit_cost: Option<f64>,
    lead_time_days: Option<i32>,
    min_order_qty: Option<i32>,
    order_multiple: Option<i32>,
    supplier_lead_time_days: Option<i32>,
    supplier_sku: Option<String>,
    supplier_product_name: Option<String>,
    currency: Option<String>,
    supplier_name: Option<String>,
    supplier_currency: Option<String>,
}

/// The live product suppliers of `products` with their terms, preferred
/// first, then oldest.
async fn terms<C: ConnectionTrait>(db: &C, products: &[String]) -> Result<Vec<TermsRow>, DbErr> {
    link_query(products)
        .columns([
            product_suppliers::Column::SupplierSku,
            product_suppliers::Column::SupplierProductName,
            product_suppliers::Column::Currency,
        ])
        .column_as(suppliers::Column::Name, "supplier_name")
        .column_as(suppliers::Column::Currency, "supplier_currency")
        .into_model::<TermsRow>()
        .all(db)
        .await
}

impl TermsRow {
    /// The link, and the terms by its id.
    fn split(self) -> (Link, Terms) {
        let terms = Terms {
            supplier_sku: self.supplier_sku,
            supplier_product_name: self.supplier_product_name,
            currency: self.currency,
            supplier_name: self.supplier_name,
            supplier_currency: self.supplier_currency,
        };
        let link = LinkRow {
            id: self.id,
            product_id: self.product_id,
            variant_id: self.variant_id,
            supplier_id: self.supplier_id,
            unit_cost: self.unit_cost,
            lead_time_days: self.lead_time_days,
            min_order_qty: self.min_order_qty,
            order_multiple: self.order_multiple,
            supplier_lead_time_days: self.supplier_lead_time_days,
        }
        .link();
        (link, terms)
    }
}

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
    let settings = load_settings(&orm(db)).await?;
    let user_id = caller.user_id.clone();
    let quantities = body.quantities;
    let at = OffsetDateTime::now_utc();
    let today = at.date();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let (plans, rows) = {
                let orm = OrmConn::new(&mut *conn);
                let plans = lock_plans(&orm, &ids).await?;
                let products: Vec<String> = plans
                    .values()
                    .map(|plan| plan.product_id.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();
                (plans, terms(&orm, &products).await?)
            };
            let mut links = Vec::with_capacity(rows.len());
            let mut terms: HashMap<String, Terms> = HashMap::new();
            for row in rows {
                let (link, link_terms) = row.split();
                terms.insert(link.id.clone(), link_terms);
                links.push(link);
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
                let row = write_order(&mut *conn, order, &number, &user_id, at).await?;
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

/// `leftJoin(<table>, eq(<table>.id, t.<column>))`.
fn left_join<E: EntityTrait>(related: E, from: plans::Column, to: E::Column) -> RelationDef {
    plans::Entity::belongs_to(related).from(from).to(to).into()
}

/// The plans `ids`, locked for the transaction (`for update of t`), with
/// the names and cost price their lines take (the cost as a float).
async fn lock_plans<C: ConnectionTrait>(
    db: &C,
    ids: &[String],
) -> Result<HashMap<String, PlanRow>, DbErr> {
    use sea_orm::ExprTrait as _;
    let cost = Func::coalesce([
        Expr::col((product_variants::Entity, product_variants::Column::CostPrice)),
        Expr::col((products::Entity, products::Column::CostPrice)),
    ]);
    let mut query = plans::Entity::find()
        .select_only()
        .columns([
            plans::Column::Id,
            plans::Column::ProductId,
            plans::Column::VariantId,
            plans::Column::WarehouseId,
        ])
        .column_as(warehouses::Column::Name, "warehouse_name")
        .columns([
            plans::Column::SuggestedQty,
            plans::Column::ReviewStatus,
            plans::Column::LeadTimeDays,
            plans::Column::ProductSupplierId,
        ])
        .column_as(products::Column::Name, "product_name")
        .column_as(products::Column::Sku, "product_sku")
        .column_as(product_variants::Column::Name, "variant_name")
        .column_as(product_variants::Column::Sku, "variant_sku")
        .column_as(Expr::from(cost).cast_as("float8"), "cost")
        .join(
            JoinType::LeftJoin,
            left_join(products::Entity, plans::Column::ProductId, products::Column::Id),
        )
        .join(
            JoinType::LeftJoin,
            left_join(
                product_variants::Entity,
                plans::Column::VariantId,
                product_variants::Column::Id,
            ),
        )
        .join(
            JoinType::LeftJoin,
            left_join(
                warehouses::Entity,
                plans::Column::WarehouseId,
                warehouses::Column::Id,
            ),
        )
        .filter(plans::Column::Id.is_in(ids.iter().map(String::as_str)))
        .order_by(plans::Column::Id, Order::Asc);
    QueryTrait::query(&mut query).lock_with_tables(LockType::Update, [plans::Entity]);
    let rows: Vec<PlanTuple> = query.into_tuple().all(db).await?;
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
                        // `nullif(t.variant_id, '')`.
                        variant_id: variant_id.filter(|variant| !variant.is_empty()),
                        warehouse_id,
                        warehouse_name,
                        suggested_qty: i64::from(suggested_qty),
                        review_status,
                        lead_time_days: lead_time_days.map(i64::from),
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
    at: OffsetDateTime,
) -> Result<Value, Refusal> {
    let id = generate_id("po");
    let stamp = utc_timestamp(at);
    let lead = order
        .lines
        .iter()
        .map(|line| line.lead_time_days)
        .max()
        .unwrap_or(0);
    // `<today + lead>T00:00:00.000`.
    let expected = PrimitiveDateTime::new(at.date() + Duration::days(lead), Time::MIDNIGHT);
    let currency = order.lines.iter().find_map(|line| line.currency.clone());
    {
        let orm = OrmConn::new(&mut *conn);
        purchase_orders::Entity::insert(purchase_orders::ActiveModel {
            id: Set(id.clone()),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            po_number: Set(number.to_owned()),
            supplier_id: Set(Some(order.supplier_id.clone())),
            supplier_name: Set(order.supplier_name.clone()),
            warehouse_id: Set(Some(order.warehouse_id.clone())),
            warehouse_name: Set(order.warehouse_name.clone()),
            status: Set("draft".to_owned()),
            expected_date: Set(Some(expected)),
            currency: Set(Some(currency.unwrap_or_else(|| "USD".to_owned()))),
            created_by: Set(Some(user_id.to_owned())),
            ..Default::default()
        })
        .exec_without_returning(&orm)
        .await?;
        insert_lines(&orm, &id, stamp, &order.lines).await?;
    }
    let row = recompute_po_totals(&mut *conn, &id, &iso_timestamp(at))
        .await?
        .ok_or_else(|| Refusal::from(ApiError::internal()))?;
    let plan_ids: Vec<String> = order
        .lines
        .iter()
        .map(|line| line.plan_id.clone())
        .collect();
    plans::Entity::update_many()
        .col_expr(plans::Column::ReviewStatus, Expr::val("ordered"))
        .col_expr(plans::Column::PurchaseOrderId, Expr::val(id.as_str()))
        .col_expr(
            plans::Column::DismissedUntil,
            Expr::val(None::<PrimitiveDateTime>),
        )
        .col_expr(plans::Column::DismissedBy, Expr::val(None::<String>))
        .col_expr(plans::Column::DismissedQty, Expr::val(None::<i32>))
        .col_expr(plans::Column::UpdatedAt, Expr::val(stamp))
        .filter(plans::Column::Id.is_in(plan_ids))
        .exec(&OrmConn::new(&mut *conn))
        .await?;
    Ok(row)
}

/// A numeric column's text (`line_amounts`) as its value.
fn numeric(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text).map_err(|error| DbErr::Custom(format!("{text}: {error}")))
}

/// An `integer` column's value.
fn int4(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Custom(format!("{value}: integer out of range")))
}

/// The lines of the purchase order `order_id`, in one statement, with
/// their amounts as the line routes work them out.
async fn insert_lines<C: ConnectionTrait>(
    db: &C,
    order_id: &str,
    at: PrimitiveDateTime,
    lines: &[Line],
) -> Result<(), DbErr> {
    let mut rows = Vec::with_capacity(lines.len());
    for line in lines {
        let amounts = line_amounts(Figures {
            quantity_ordered: line.quantity,
            quantity_received: 0,
            unit_price: line.unit_price,
            discount_percent: 0.0,
            tax_percent: 0.0,
        });
        rows.push(purchase_order_items::ActiveModel {
            id: Set(generate_id("poi")),
            purchase_order_id: Set(order_id.to_owned()),
            created_at: Set(at),
            updated_at: Set(at),
            product_id: Set(Some(line.product_id.clone())),
            variant_id: Set(line.variant_id.clone()),
            sku: Set(line.sku.clone()),
            name: Set(line.name.clone()),
            quantity_ordered: Set(int4(line.quantity)?),
            quantity_received: Set(Some(0)),
            quantity_rejected: Set(Some(0)),
            quantity_pending: Set(Some(int4(amounts.quantity_pending)?)),
            unit_price: Set(numeric(&amounts.unit_price)?),
            discount_percent: Set(Some(numeric(&amounts.discount_percent)?)),
            discount_amount: Set(Some(numeric(&amounts.discount_amount)?)),
            tax_percent: Set(Some(numeric(&amounts.tax_percent)?)),
            tax_amount: Set(Some(numeric(&amounts.tax_amount)?)),
            total: Set(numeric(&amounts.total)?),
            ..Default::default()
        });
    }
    if rows.is_empty() {
        return Ok(());
    }
    purchase_order_items::Entity::insert_many(rows)
        .exec_without_returning(db)
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
