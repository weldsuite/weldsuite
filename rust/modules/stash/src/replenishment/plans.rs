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
use serde_json::{Map, Value, json};
use time::{Date, Duration, OffsetDateTime};
use weldsuite_catalogs::permission_keys::{INVENTORY_READ, INVENTORY_UPDATE};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::demand::{Item, Planning, plan_items, ymd};
use super::routes::{limit_param, rule_row};
use super::settings::{demand_warehouse, load_settings};
use crate::incoming::parse_date;
use crate::inventory::date_field;
use crate::js::query_set;
use crate::po_actions::or_empty_object;
use crate::{Caller, Refusal, StashState, internal, now, validate};

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

/// A plan with its names, as `{ row, …joined }`.
macro_rules! plan_select {
    () => {
        "select jsonb_build_object('row', to_jsonb(t) || jsonb_build_object( \
           'avg_daily_demand', t.avg_daily_demand::text, 'demand_std_dev', t.demand_std_dev::text, \
           'forecast_30d', t.forecast_30d::text, 'forecast_90d', t.forecast_90d::text, \
           'service_level', t.service_level::text, 'days_of_cover', t.days_of_cover::text, \
           'suggested_value', t.suggested_value::text), \
         'productName', p.name, 'productSku', coalesce(nullif(v.sku, ''), p.sku), \
         'variantName', v.name, 'warehouseName', w.name, \
         'warehouseManagedByConnectionId', w.managed_by_connection_id, \
         'supplierName', s.name, 'currency', coalesce(ps.currency, s.currency), \
         'unitCost', coalesce(ps.unit_cost, v.cost_price, p.cost_price)::text, \
         'minOrderQty', ps.min_order_qty, 'orderMultiple', ps.order_multiple, \
         'sortName', coalesce(p.name, '')) "
    };
}

/// The joins and filters, at `$1`–`$9`: the id, needs reorder, review
/// status, supplier, warehouse, confidence, urgency, today, search.
macro_rules! plan_from {
    () => {
        "from stash_item_plans t \
         left join products p on p.id = t.product_id \
         left join product_variants v on v.id = t.variant_id \
         left join warehouses w on w.id = t.warehouse_id \
         left join product_suppliers ps on ps.id = t.product_supplier_id and ps.deleted_at is null \
         left join suppliers s on s.id = t.supplier_id \
         where ($1::text is null or t.id = $1) \
         and ($2::boolean is not true or (t.suggested_qty > 0 and t.review_status = 'open')) \
         and ($3::text is null or t.review_status = $3) \
         and ($4::text is null or t.supplier_id = $4) \
         and ($5::text is null or t.warehouse_id = $5) \
         and ($6::text is null or t.confidence = $6) \
         and ($7::text is null \
              or ($7::text = 'out_of_stock' and t.on_hand - t.allocated <= 0) \
              or ($7::text = 'lead_time' and t.stockout_date <= $8::date + coalesce(t.lead_time_days, 0)) \
              or ($7::text = 'review' and t.stockout_date <= $8::date + coalesce(t.lead_time_days, 0) \
                  + coalesce(t.review_period_days, 0))) \
         and ($9::text is null or strpos(lower(coalesce(p.name, '')), lower($9)) > 0 \
              or strpos(lower(coalesce(p.sku, '')), lower($9)) > 0 \
              or strpos(lower(coalesce(v.name, '')), lower($9)) > 0 \
              or strpos(lower(coalesce(v.sku, '')), lower($9)) > 0) "
    };
}

/// A page: `$10`–`$14` are the cursor (given, stockout date, name, id) and
/// the limit.
const LIST: &str = concat!(
    plan_select!(),
    plan_from!(),
    "and ($10::boolean is not true or (case when $11::date is null \
       then t.stockout_date is null and (coalesce(p.name, ''), t.id) > ($12::text, $13::text) \
       else (t.stockout_date > $11::date or t.stockout_date is null \
             or (t.stockout_date = $11::date and (coalesce(p.name, ''), t.id) > ($12::text, $13::text))) \
       end)) \
     order by t.stockout_date asc nulls last, coalesce(p.name, '') asc, t.id asc limit $14"
);

const COUNT: &str = concat!("select count(*) ", plan_from!());

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

/// `{ ...row, productName, … }`, and the row's sort name.
fn plan_item(joined: &Value) -> (Value, String) {
    let mut row = match weldsuite_db::js_row(joined.get("row").cloned().unwrap_or(Value::Null)) {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    for key in [
        "productName",
        "productSku",
        "variantName",
        "warehouseName",
        "warehouseManagedByConnectionId",
        "supplierName",
        "currency",
        "unitCost",
        "minOrderQty",
        "orderMultiple",
    ] {
        row.insert(
            key.to_owned(),
            joined.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    let sort_name = joined["sortName"].as_str().unwrap_or_default().to_owned();
    (Value::Object(row), sort_name)
}

fn today() -> Date {
    OffsetDateTime::now_utc().date()
}

/// A page of plans, and the cursor after it.
async fn page(
    db: &weldsuite_db::PgPool,
    filters: &Filters,
    cursor: Option<&Cursor>,
    limit: i64,
) -> Result<(Vec<Value>, Option<String>, bool), sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(LIST)
        .bind(filters.id.as_deref())
        .bind(filters.needs_reorder)
        .bind(filters.status.as_deref())
        .bind(filters.supplier_id.as_deref())
        .bind(filters.warehouse_id.as_deref())
        .bind(filters.confidence.as_deref())
        .bind(filters.urgency.as_deref())
        .bind(ymd(today()))
        .bind(filters.search.as_deref())
        .bind(cursor.is_some())
        .bind(cursor.and_then(|cursor| cursor.stockout_date.as_deref()))
        .bind(cursor.map(|cursor| cursor.name.as_str()))
        .bind(cursor.map(|cursor| cursor.id.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let mut items = Vec::with_capacity(rows.len());
    let mut next = None;
    for joined in rows.iter().take(usize::try_from(limit).unwrap_or(0)) {
        let (item, name) = plan_item(joined);
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
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
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
    let total: Result<i64, _> = sqlx::query_scalar(COUNT)
        .bind(filters.id.as_deref())
        .bind(filters.needs_reorder)
        .bind(filters.status.as_deref())
        .bind(filters.supplier_id.as_deref())
        .bind(filters.warehouse_id.as_deref())
        .bind(filters.confidence.as_deref())
        .bind(filters.urgency.as_deref())
        .bind(ymd(today()))
        .bind(filters.search.as_deref())
        .fetch_one(&caller.db)
        .await;
    let total = match total {
        Ok(total) => u64::try_from(total).unwrap_or(0),
        Err(error) => return internal(&error, FAILED),
    };
    match page(&caller.db, &filters, cursor.as_ref(), limit).await {
        Ok((items, next, has_more)) => {
            List::new(items, Pagination::new(total, has_more, next)).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch plan";
    match plan_detail(&caller.db, &id).await {
        Ok(data) => Data(data).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `{ plan, rule, productSupplier }`.
async fn plan_detail(db: &weldsuite_db::PgPool, id: &str) -> Result<Value, Refusal> {
    let Some(plan) = find_plan(db, id).await? else {
        return Err(Refusal::not_found(RESOURCE, id));
    };
    let rule: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        rule_row!(),
        " from stash_reorder_rules r where r.item_key = $1"
    ))
    .bind(plan["itemKey"].as_str().unwrap_or_default())
    .fetch_optional(db)
    .await?;
    let product_supplier = match plan["productSupplierId"].as_str() {
        Some(link) => crate::product_suppliers::find_item(db, link).await?,
        None => None,
    };
    Ok(json!({
        "plan": plan,
        "rule": rule.map(weldsuite_db::js_row),
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
async fn plan_demand(db: &weldsuite_db::PgPool, id: &str) -> Result<Value, Refusal> {
    let row: Option<(String, Option<String>, String)> = sqlx::query_as(
        "select product_id, nullif(variant_id, ''), warehouse_id from stash_item_plans where id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((product_id, variant_id, warehouse_id)) = row else {
        return Err(Refusal::not_found(RESOURCE, id));
    };
    let settings = load_settings(db).await?;
    let planning = Planning {
        today: today(),
        demand_warehouse: demand_warehouse(db, &settings).await?,
        settings,
    };
    let item = Item {
        product_id,
        variant_id,
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
    let changed: Result<Option<String>, _> = sqlx::query_scalar(
        "update stash_item_plans set review_status = 'dismissed', dismissed_until = $2::timestamp, \
         dismissed_by = $3, dismissed_qty = suggested_qty, updated_at = $4::timestamp \
         where id = $1 and review_status <> 'ordered' returning id",
    )
    .bind(&id)
    .bind(&until)
    .bind(&caller.user_id)
    .bind(now())
    .fetch_optional(&caller.db)
    .await;
    answer_review(&caller, &id, changed, FAILED).await
}

async fn restore(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to restore plan";
    let changed: Result<Option<String>, _> = sqlx::query_scalar(
        "update stash_item_plans set review_status = case when suggested_qty > 0 then 'open' \
         else 'none' end, dismissed_until = null, dismissed_by = null, dismissed_qty = null, \
         updated_at = $2::timestamp where id = $1 and review_status <> 'ordered' returning id",
    )
    .bind(&id)
    .bind(now())
    .fetch_optional(&caller.db)
    .await;
    answer_review(&caller, &id, changed, FAILED).await
}

/// The plan after a review change; the 400 for an ordered plan, the 404.
async fn answer_review(
    caller: &Caller,
    id: &str,
    changed: Result<Option<String>, sqlx::Error>,
    failed: &str,
) -> Response {
    let found = match changed {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => return internal(&error, failed),
    };
    match find_plan(&caller.db, id).await {
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
