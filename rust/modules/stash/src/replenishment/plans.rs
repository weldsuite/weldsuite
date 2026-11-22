//! `/replenishment/plans`: the planning run's output, one row per item,
//! with the names and supplier terms the Reorder screen shows.
//!
//! The list is ordered by stockout date (none last), product name and id,
//! and paged with an opaque cursor (base64url of
//! `[stockoutDate | null, productName, id]`); a cursor that doesn't read
//! answers the first page. `productSku` is the variant's SKU when it has
//! one, and `unitCost` the price a draft purchase order would use (the
//! product supplier's cost, else the variant's or product's cost price).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, NullOrdering};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, FromQueryResult, JoinType,
    Order, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
};
use serde_json::{Map, Value, json};
use time::{Date, Duration, OffsetDateTime};
use weldsuite_catalogs::permission_keys::{INVENTORY_READ, INVENTORY_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    product_suppliers, product_variants, products, stash_item_plans as plans, stash_reorder_rules,
    suppliers, warehouses,
};

use super::demand::{Item, Planning, plan_items, ymd};
use super::routes::limit_param;
use super::settings::{demand_warehouse, load_settings, model_json};
use crate::incoming::parse_date;
use crate::inventory::date_field;
use crate::js::query_set;
use crate::po_actions::or_empty_object;
use crate::{Caller, Refusal, StashState, internal, validate};

const RESOURCE: &str = "Plan";

/// Weeks of history on the demand chart.
const HISTORY_WEEKS: i64 = 52;

/// Weeks of forecast on the demand chart.
const FORECAST_WEEKS: i64 = 13;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([INVENTORY_READ]);
    let update = || gate.require([INVENTORY_UPDATE]);
    Router::new()
        .route("/plans", get(list).route_layer(read()))
        .route("/plans/{id}", get(detail).route_layer(read()))
        .route("/plans/{id}/demand", get(demand).route_layer(read()))
        .route("/plans/{id}/dismiss", post(dismiss).route_layer(update()))
        .route("/plans/{id}/restore", post(restore).route_layer(update()))
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// `leftJoin(<table>, eq(<table>.id, t.<column>))`.
fn left_join<E: EntityTrait>(related: E, from: plans::Column, to: E::Column) -> RelationDef {
    plans::Entity::belongs_to(related).from(from).to(to).into()
}

/// The plans with the products, variants, warehouses, live product
/// suppliers and suppliers they name.
fn joined() -> Select<plans::Entity> {
    let product_supplier = plans::Entity::belongs_to(product_suppliers::Entity)
        .from(plans::Column::ProductSupplierId)
        .to(product_suppliers::Column::Id)
        .on_condition(|_, right| {
            Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
                right,
                product_suppliers::Column::DeletedAt,
            ))))
        })
        .into();
    plans::Entity::find()
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
        .join(JoinType::LeftJoin, product_supplier)
        .join(
            JoinType::LeftJoin,
            left_join(
                suppliers::Entity,
                plans::Column::SupplierId,
                suppliers::Column::Id,
            ),
        )
}

/// `coalesce(p.name, '')`, the list's sort name.
fn sort_name() -> Expr {
    Func::coalesce([
        Expr::col((products::Entity, products::Column::Name)),
        Expr::val(""),
    ])
    .into()
}

/// `strpos(lower(coalesce(<column>, '')), lower($search)) > 0`.
fn contains_text(column: Expr, search: &str) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::from(
        Func::cust("strpos")
            .arg(Func::lower(Func::coalesce([column, Expr::val("")])))
            .arg(Func::lower(Expr::val(search))),
    )
    .gt(0)
}

/// The list's filters, `today` for the urgency.
fn conditions(filters: &Filters, today: Date) -> Condition {
    use sea_orm::ExprTrait as _;
    let col = |column: plans::Column| Expr::col((plans::Entity, column));
    let mut condition = Condition::all();
    if let Some(id) = &filters.id {
        condition = condition.add(plans::Column::Id.eq(id.as_str()));
    }
    if filters.needs_reorder {
        condition = condition
            .add(plans::Column::SuggestedQty.gt(0))
            .add(plans::Column::ReviewStatus.eq("open"));
    }
    for (value, column) in [
        (&filters.status, plans::Column::ReviewStatus),
        (&filters.supplier_id, plans::Column::SupplierId),
        (&filters.warehouse_id, plans::Column::WarehouseId),
        (&filters.confidence, plans::Column::Confidence),
    ] {
        if let Some(value) = value {
            condition = condition.add(column.eq(value.as_str()));
        }
    }
    // `$today::date + coalesce(lead_time_days, 0)`.
    let lead_time_end = || {
        Expr::val(today).add(Func::coalesce([
            col(plans::Column::LeadTimeDays),
            Expr::val(0),
        ]))
    };
    match filters.urgency.as_deref() {
        Some("out_of_stock") => {
            condition = condition.add(
                col(plans::Column::OnHand)
                    .sub(col(plans::Column::Allocated))
                    .lte(0),
            );
        }
        Some("lead_time") => {
            condition = condition.add(col(plans::Column::StockoutDate).lte(lead_time_end()));
        }
        Some("review") => {
            condition = condition.add(
                col(plans::Column::StockoutDate).lte(lead_time_end().add(Func::coalesce([
                    col(plans::Column::ReviewPeriodDays),
                    Expr::val(0),
                ]))),
            );
        }
        _ => {}
    }
    if let Some(search) = &filters.search {
        condition = condition.add(
            Condition::any()
                .add(contains_text(
                    Expr::col((products::Entity, products::Column::Name)),
                    search,
                ))
                .add(contains_text(
                    Expr::col((products::Entity, products::Column::Sku)),
                    search,
                ))
                .add(contains_text(
                    Expr::col((product_variants::Entity, product_variants::Column::Name)),
                    search,
                ))
                .add(contains_text(
                    Expr::col((product_variants::Entity, product_variants::Column::Sku)),
                    search,
                )),
        );
    }
    condition
}

/// After `cursor` in the list's order: `(stockoutDate nulls last, sortName,
/// id)`.
fn after(cursor: &Cursor) -> Condition {
    use sea_orm::ExprTrait as _;
    let stockout = || Expr::col((plans::Entity, plans::Column::StockoutDate));
    let later_name = Expr::tuple([sort_name(), Expr::col((plans::Entity, plans::Column::Id))])
        .gt(Expr::tuple([
            Expr::val(cursor.name.as_str()),
            Expr::val(cursor.id.as_str()),
        ]));
    match &cursor.stockout_date {
        None => Condition::all().add(stockout().is_null()).add(later_name),
        Some(day) => {
            let day = || Expr::val(day.as_str()).cast_as("date");
            Condition::any()
                .add(stockout().gt(day()))
                .add(stockout().is_null())
                .add(Condition::all().add(stockout().eq(day())).add(later_name))
        }
    }
}

/// A plan with the names and terms the list shows.
#[derive(Debug, FromQueryResult)]
struct Joined {
    #[sea_orm(nested)]
    plan: plans::Model,
    joined_product_name: Option<String>,
    joined_product_sku: Option<String>,
    joined_variant_name: Option<String>,
    joined_warehouse_name: Option<String>,
    joined_warehouse_managed_by: Option<String>,
    joined_supplier_name: Option<String>,
    joined_currency: Option<String>,
    joined_unit_cost: Option<String>,
    joined_min_order_qty: Option<i32>,
    joined_order_multiple: Option<i32>,
    joined_sort_name: String,
}

impl Joined {
    /// `select({ row: t, productName: p.name, … })`.
    fn query(filters: &Filters, today: Date) -> Select<plans::Entity> {
        use sea_orm::ExprTrait as _;
        let unit_cost = Func::coalesce([
            Expr::col((product_suppliers::Entity, product_suppliers::Column::UnitCost)),
            Expr::col((product_variants::Entity, product_variants::Column::CostPrice)),
            Expr::col((products::Entity, products::Column::CostPrice)),
        ]);
        joined()
            .column_as(products::Column::Name, "joined_product_name")
            .column_as(
                Expr::from(Func::coalesce([
                    Expr::from(
                        Func::cust("nullif")
                            .arg(Expr::col((
                                product_variants::Entity,
                                product_variants::Column::Sku,
                            )))
                            .arg(""),
                    ),
                    Expr::col((products::Entity, products::Column::Sku)),
                ])),
                "joined_product_sku",
            )
            .column_as(product_variants::Column::Name, "joined_variant_name")
            .column_as(warehouses::Column::Name, "joined_warehouse_name")
            .column_as(
                warehouses::Column::ManagedByConnectionId,
                "joined_warehouse_managed_by",
            )
            .column_as(suppliers::Column::Name, "joined_supplier_name")
            .column_as(
                Expr::from(Func::coalesce([
                    Expr::col((product_suppliers::Entity, product_suppliers::Column::Currency)),
                    Expr::col((suppliers::Entity, suppliers::Column::Currency)),
                ])),
                "joined_currency",
            )
            .column_as(Expr::from(unit_cost).cast_as("text"), "joined_unit_cost")
            .column_as(
                product_suppliers::Column::MinOrderQty,
                "joined_min_order_qty",
            )
            .column_as(
                product_suppliers::Column::OrderMultiple,
                "joined_order_multiple",
            )
            .column_as(sort_name(), "joined_sort_name")
            .filter(conditions(filters, today))
    }

    /// `{ ...row, productName, … }`, and the row's sort name.
    fn into_item(self) -> Result<(Value, String), DbErr> {
        let mut row = match model_json!(&self.plan)? {
            Value::Object(row) => row,
            _ => Map::new(),
        };
        for (key, value) in [
            ("productName", json!(self.joined_product_name)),
            ("productSku", json!(self.joined_product_sku)),
            ("variantName", json!(self.joined_variant_name)),
            ("warehouseName", json!(self.joined_warehouse_name)),
            (
                "warehouseManagedByConnectionId",
                json!(self.joined_warehouse_managed_by),
            ),
            ("supplierName", json!(self.joined_supplier_name)),
            ("currency", json!(self.joined_currency)),
            ("unitCost", json!(self.joined_unit_cost)),
            ("minOrderQty", json!(self.joined_min_order_qty)),
            ("orderMultiple", json!(self.joined_order_multiple)),
        ] {
            row.insert(key.to_owned(), value);
        }
        Ok((Value::Object(row), self.joined_sort_name))
    }
}

/// The filters of a list (all `None` for a lookup by id).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Filters {
    pub(crate) id: Option<String>,
    pub(crate) needs_reorder: bool,
    pub(crate) status: Option<String>,
    pub(crate) supplier_id: Option<String>,
    pub(crate) warehouse_id: Option<String>,
    pub(crate) confidence: Option<String>,
    pub(crate) urgency: Option<String>,
    pub(crate) search: Option<String>,
}

/// Where the last page ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Cursor {
    pub(crate) stockout_date: Option<String>,
    pub(crate) name: String,
    pub(crate) id: String,
}

impl Cursor {
    pub(crate) fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(json!([self.stockout_date, self.name, self.id]).to_string())
    }

    /// `None` for anything that isn't a cursor this route issued.
    pub(crate) fn decode(text: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(text.trim()).ok()?;
        let Value::Array(parts) = serde_json::from_slice::<Value>(&bytes).ok()? else {
            return None;
        };
        let [stockout, name, id] = parts.as_slice() else {
            return None;
        };
        let stockout_date = match stockout {
            Value::Null => None,
            Value::String(day) if parse_date(day).is_some() => Some(day.clone()),
            _ => return None,
        };
        Some(Self {
            stockout_date,
            name: name.as_str()?.to_owned(),
            id: id.as_str().filter(|id| !id.is_empty())?.to_owned(),
        })
    }
}

fn today() -> Date {
    OffsetDateTime::now_utc().date()
}

/// A page of plans, and the cursor after it.
async fn page(
    db: &DatabaseConnection,
    filters: &Filters,
    cursor: Option<&Cursor>,
    limit: i64,
) -> Result<(Vec<Value>, Option<String>, bool), DbErr> {
    let mut query = Joined::query(filters, today());
    if let Some(cursor) = cursor {
        query = query.filter(after(cursor));
    }
    let rows = query
        .order_by_with_nulls(plans::Column::StockoutDate, Order::Asc, NullOrdering::Last)
        .order_by(sort_name(), Order::Asc)
        .order_by(plans::Column::Id, Order::Asc)
        .limit(u64::try_from(limit + 1).ok())
        .into_model::<Joined>()
        .all(db)
        .await?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let mut items = Vec::with_capacity(rows.len());
    let mut next = None;
    for joined in rows.into_iter().take(usize::try_from(limit).unwrap_or(0)) {
        let (item, name) = joined.into_item()?;
        next = Some(Cursor {
            stockout_date: item["stockoutDate"].as_str().map(str::to_owned),
            name,
            id: item["id"].as_str().unwrap_or_default().to_owned(),
        });
        items.push(item);
    }
    let cursor = if has_more {
        next.map(|cursor| cursor.encode())
    } else {
        None
    };
    Ok((items, cursor, has_more))
}

/// The plan `id` in the list's shape.
pub(crate) async fn find_plan(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let filters = Filters {
        id: Some(id.to_owned()),
        ..Filters::default()
    };
    Ok(page(db, &filters, None, 1).await?.0.into_iter().next())
}

/// A query value that must be one of `options`.
fn choice(query: Option<&str>, key: &str, options: &[&str]) -> Result<Option<String>, ApiError> {
    match query_set(query, key) {
        Some(value) if !options.contains(&value.as_str()) => Err(ApiError::bad_request(format!(
            "{key} must be one of: {}",
            options.join(", ")
        ))),
        value => Ok(value),
    }
}

/// The list's filters from its query.
fn read_filters(query: Option<&str>) -> Result<Filters, ApiError> {
    Ok(Filters {
        id: None,
        needs_reorder: query_set(query, "needsReorder").as_deref() == Some("true"),
        status: choice(query, "status", &["none", "open", "dismissed", "ordered"])?,
        supplier_id: query_set(query, "supplierId"),
        warehouse_id: query_set(query, "warehouseId"),
        confidence: choice(query, "confidence", &["none", "low", "ok"])?,
        urgency: choice(query, "urgency", &["out_of_stock", "lead_time", "review"])?,
        search: query_set(query, "search")
            .map(|search| search.trim().to_owned())
            .filter(|search| !search.is_empty()),
    })
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list plans";
    let query = query.as_deref();
    let filters = match read_filters(query) {
        Ok(filters) => filters,
        Err(error) => return error.into_response(),
    };
    let limit = limit_param(query, 50, 200);
    let cursor = query_set(query, "cursor").and_then(|text| Cursor::decode(&text));
    let db = orm(&caller.db);
    let total = joined()
        .filter(conditions(&filters, today()))
        .count(&db)
        .await;
    let total = match total {
        Ok(total) => total,
        Err(error) => return internal(&error, FAILED),
    };
    match page(&db, &filters, cursor.as_ref(), limit).await {
        Ok((items, next, has_more)) => {
            List::new(items, Pagination::new(total, has_more, next)).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch plan";
    match plan_detail(&orm(&caller.db), &caller.db, &id).await {
        Ok(data) => Data(data).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `{ plan, rule, productSupplier }`.
async fn plan_detail(db: &DatabaseConnection, pool: &PgPool, id: &str) -> Result<Value, Refusal> {
    let Some(plan) = find_plan(db, id).await? else {
        return Err(Refusal::not_found(RESOURCE, id));
    };
    let rule = stash_reorder_rules::Entity::find()
        .filter(
            stash_reorder_rules::Column::ItemKey.eq(plan["itemKey"].as_str().unwrap_or_default()),
        )
        .one(db)
        .await?
        .map(|rule| model_json!(rule))
        .transpose()?;
    let product_supplier = match plan["productSupplierId"].as_str() {
        Some(link) => crate::product_suppliers::find_item(pool, link).await?,
        None => None,
    };
    Ok(json!({
        "plan": plan,
        "rule": rule,
        "productSupplier": product_supplier,
    }))
}

// ── The demand chart ────────────────────────────────────────────────────────

/// Monday of `date`'s week.
pub(crate) fn monday(date: Date) -> Date {
    date - Duration::days(i64::from(date.weekday().number_days_from_monday()))
}

/// Weekly demand for the [`HISTORY_WEEKS`] weeks up to this one (Monday
/// starts, UTC): `series[0]` is `series_start`, the last entry yesterday.
pub(crate) fn history_weeks(today: Date, series_start: Date, series: &[i64]) -> Vec<(Date, i64)> {
    let this_week = monday(today);
    (0..HISTORY_WEEKS)
        .rev()
        .map(|back| {
            let week = this_week - Duration::weeks(back);
            let quantity = (0..7)
                .map(|day| week + Duration::days(day))
                .filter(|date| *date < today && *date >= series_start)
                .filter_map(|date| {
                    usize::try_from((date - series_start).whole_days())
                        .ok()
                        .and_then(|index| series.get(index))
                })
                .copied()
                .fold(0_i64, i64::saturating_add);
            (week, quantity)
        })
        .collect()
}

/// The forecast in [`FORECAST_WEEKS`] weeks from this one (`daily[0]` is
/// today; this week counts from today on). Empty without a forecast.
pub(crate) fn forecast_weeks(today: Date, daily: &[f64]) -> Vec<(Date, f64)> {
    if daily.is_empty() {
        return Vec::new();
    }
    let this_week = monday(today);
    let mut weeks: Vec<(Date, f64)> = (0..FORECAST_WEEKS)
        .map(|ahead| (this_week + Duration::weeks(ahead), 0.0))
        .collect();
    for (offset, quantity) in daily.iter().enumerate() {
        let date = today + Duration::days(i64::try_from(offset).unwrap_or(i64::MAX));
        let week = (monday(date) - this_week).whole_weeks();
        if let Some(slot) = usize::try_from(week)
            .ok()
            .and_then(|week| weeks.get_mut(week))
        {
            slot.1 += quantity;
        }
    }
    for week in &mut weeks {
        week.1 = (week.1 * 100.0).round() / 100.0;
    }
    weeks
}

async fn demand(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch plan demand";
    match plan_demand(&caller.db, &id).await {
        Ok(data) => Data(data).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The item's weekly history and forecast, worked out again from today's
/// numbers (the forecast as the engine makes it).
async fn plan_demand(db: &PgPool, id: &str) -> Result<Value, Refusal> {
    let conn = orm(db);
    let row: Option<(String, Option<String>, String)> = plans::Entity::find()
        .select_only()
        .columns([
            plans::Column::ProductId,
            plans::Column::VariantId,
            plans::Column::WarehouseId,
        ])
        .filter(plans::Column::Id.eq(id))
        .into_tuple()
        .one(&conn)
        .await?;
    let Some((product_id, variant_id, warehouse_id)) = row else {
        return Err(Refusal::not_found(RESOURCE, id));
    };
    let settings = load_settings(&conn).await?;
    let planning = Planning {
        today: today(),
        demand_warehouse: demand_warehouse(&conn, &settings).await?,
        settings,
    };
    let item = Item {
        product_id,
        // `nullif(variant_id, '')`.
        variant_id: variant_id.filter(|variant| !variant.is_empty()),
        warehouse_id,
    };
    let planned = plan_items(db, &planning, vec![item]).await?;
    let Some(plan) = planned.first() else {
        return Err(Refusal::not_found(RESOURCE, id));
    };
    let history: Vec<Value> = history_weeks(planning.today, planning.series_start(), &plan.series)
        .into_iter()
        .map(|(week, quantity)| json!({ "weekStart": ymd(week), "quantity": quantity }))
        .collect();
    let forecast: Vec<Value> = forecast_weeks(planning.today, &plan.output.daily_forecast)
        .into_iter()
        .map(|(week, quantity)| json!({ "weekStart": ymd(week), "quantity": quantity }))
        .collect();
    Ok(json!({ "history": history, "forecast": forecast }))
}

// ── Review ──────────────────────────────────────────────────────────────────

/// The 400 for a plan on a purchase order.
const ORDERED: &str = "This plan is already on a purchase order";

async fn dismiss(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to dismiss plan";
    let until = match validate(&headers, &or_empty_object(body), |issues, body| {
        date_field(issues, body, "until", Presence::Optional).into_option()
    }) {
        Ok(until) => until,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let until =
        until.unwrap_or_else(|| iso_timestamp(OffsetDateTime::now_utc() + Duration::days(7)));
    let db = orm(&caller.db);
    let changed = {
        use sea_orm::ExprTrait as _;
        plans::Entity::update_many()
            .col_expr(plans::Column::ReviewStatus, Expr::val("dismissed"))
            // `$2::timestamp`: the date as Postgres reads it.
            .col_expr(
                plans::Column::DismissedUntil,
                Expr::val(until).cast_as("timestamp"),
            )
            .col_expr(
                plans::Column::DismissedBy,
                Expr::val(caller.user_id.as_str()),
            )
            .col_expr(
                plans::Column::DismissedQty,
                Expr::col(plans::Column::SuggestedQty),
            )
            .col_expr(plans::Column::UpdatedAt, Expr::val(utc_now()))
            .filter(plans::Column::Id.eq(&id))
            .filter(plans::Column::ReviewStatus.ne("ordered"))
            .exec(&db)
            .await
            .map(|done| done.rows_affected > 0)
    };
    answer_review(&db, &id, changed, FAILED).await
}

async fn restore(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to restore plan";
    let db = orm(&caller.db);
    let changed = plans::Entity::update_many()
        .col_expr(
            plans::Column::ReviewStatus,
            Expr::case(plans::Column::SuggestedQty.gt(0), "open")
                .finally("none")
                .into(),
        )
        .col_expr(
            plans::Column::DismissedUntil,
            Expr::val(None::<time::PrimitiveDateTime>),
        )
        .col_expr(plans::Column::DismissedBy, Expr::val(None::<String>))
        .col_expr(plans::Column::DismissedQty, Expr::val(None::<i32>))
        .col_expr(plans::Column::UpdatedAt, Expr::val(utc_now()))
        .filter(plans::Column::Id.eq(&id))
        .filter(plans::Column::ReviewStatus.ne("ordered"))
        .exec(&db)
        .await
        .map(|done| done.rows_affected > 0);
    answer_review(&db, &id, changed, FAILED).await
}

/// The plan after a review change; the 400 for an ordered plan, the 404.
async fn answer_review(
    db: &DatabaseConnection,
    id: &str,
    changed: Result<bool, DbErr>,
    failed: &str,
) -> Response {
    let found = match changed {
        Ok(found) => found,
        Err(error) => return internal(&error, failed),
    };
    match find_plan(db, id).await {
        Ok(Some(_)) if !found => Refusal::bad_request(ORDERED).respond(failed),
        Ok(Some(plan)) => Data(plan).into_response(),
        Ok(None) => Refusal::not_found(RESOURCE, id).respond(failed),
        Err(error) => internal(&error, failed),
    }
}

#[cfg(test)]
mod tests {
    use time::Month;

    use super::*;

    fn date(month: Month, day: u8) -> Date {
        Date::from_calendar_date(2026, month, day).expect("date")
    }

    #[test]
    fn the_cursor_round_trips_and_refuses_strangers() {
        let cursor = Cursor {
            stockout_date: Some("2026-12-01".to_owned()),
            name: "Lamp Ø 30".to_owned(),
            id: "iplan_1".to_owned(),
        };
        assert_eq!(Cursor::decode(&cursor.encode()), Some(cursor));
        let none = Cursor {
            stockout_date: None,
            name: String::new(),
            id: "iplan_2".to_owned(),
        };
        assert_eq!(Cursor::decode(&none.encode()), Some(none));
        assert_eq!(Cursor::decode("not a cursor"), None);
        let wrong_date = URL_SAFE_NO_PAD.encode(r#"["soon","a","b"]"#);
        assert_eq!(Cursor::decode(&wrong_date), None);
        let short = URL_SAFE_NO_PAD.encode(r#"[null,"a"]"#);
        assert_eq!(Cursor::decode(&short), None);
    }

    #[test]
    fn weeks_start_on_monday() {
        // 2026-11-18 is a Wednesday.
        assert_eq!(monday(date(Month::November, 18)), date(Month::November, 16));
        assert_eq!(monday(date(Month::November, 16)), date(Month::November, 16));
        assert_eq!(monday(date(Month::November, 22)), date(Month::November, 16));
    }

    #[test]
    fn the_history_sums_days_into_weeks_up_to_yesterday() {
        let today = date(Month::November, 18);
        let start = today - Duration::days(730);
        let mut series = vec![0_i64; 730];
        // Monday and Tuesday of this week, and last Sunday.
        series[728] = 2; // 2026-11-16
        series[729] = 3; // 2026-11-17
        series[727] = 5; // 2026-11-15
        let weeks = history_weeks(today, start, &series);
        assert_eq!(weeks.len(), 52);
        assert_eq!(weeks[51], (date(Month::November, 16), 5));
        assert_eq!(weeks[50], (date(Month::November, 9), 5));
        assert_eq!(weeks[0].0, date(Month::November, 16) - Duration::weeks(51));
        assert_eq!(weeks.iter().map(|week| week.1).sum::<i64>(), 10);
    }

    #[test]
    fn the_forecast_fills_thirteen_weeks_from_today() {
        let today = date(Month::November, 18);
        let weeks = forecast_weeks(today, &[1.0; 91]);
        assert_eq!(weeks.len(), 13);
        // Wednesday to Sunday of this week.
        assert_eq!(weeks[0], (date(Month::November, 16), 5.0));
        assert_eq!(weeks[1], (date(Month::November, 23), 7.0));
        assert_eq!(weeks[12].1, 7.0);
        assert_eq!(forecast_weeks(today, &[]), Vec::<(Date, f64)>::new());
    }

    #[test]
    fn unknown_filter_values_are_refused() {
        assert!(read_filters(Some("urgency=soon")).is_err());
        let filters =
            read_filters(Some("needsReorder=true&status=open&search=%20lamp%20")).expect("filters");
        assert!(filters.needs_reorder);
        assert_eq!(filters.status.as_deref(), Some("open"));
        assert_eq!(filters.search.as_deref(), Some("lamp"));
    }
}
