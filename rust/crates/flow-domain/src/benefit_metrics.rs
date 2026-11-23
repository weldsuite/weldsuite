//! The benefit metric catalogue (`@weldsuite/flow-domain/benefit-metrics`,
//! FLOW-014): a fixed set of measures, each one read-only aggregate over an
//! indexed month range of other modules' tables in the same tenant database.
//! Writing nothing outside WeldFlow, it is not subject to the rule that writes
//! go through the owning module's domain.
//!
//! ```text
//! key                            reads                value (unit)
//! desk_tickets_by_tag            helpdesk_tickets     tickets created in the month with the tag (tickets)
//! commerce_repeat_online_share   orders               share of the month's repeat orders placed online (%)
//! books_days_to_pay              invoices             average days from issue to payment of invoices paid in the month (days)
//! books_supplier_cost            bills                cost billed by one supplier in the 12 months ending with the month (amount)
//! time_hours_per_week_by_tag     time_entries + tasks hours logged on tasks with the tag, per week of the month (hours)
//! manual                         nothing              typed in
//! ```
//!
//! A metric answers the value as text (the numeric column's form), or `None`
//! when the month has nothing to measure. The queries are the TypeScript ones
//! (`benefit-metrics.ts`): same windows, filters and rounding (Postgres's
//! `round(…)::text`), so both backends store the same text.

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, PaginatorTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Date, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, orm_error};
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{bills, helpdesk_tickets, orders, tasks, time_entries};

use crate::js::{
    civil_from_days, days_from_civil, iso_from_millis, offset_of_millis, timestamp_of_millis,
    utf16_len,
};

/// `BENEFIT_METRICS`.
pub const BENEFIT_METRICS: [&str; 6] = [
    "manual",
    "desk_tickets_by_tag",
    "commerce_repeat_online_share",
    "books_days_to_pay",
    "books_supplier_cost",
    "time_hours_per_week_by_tag",
];

/// `DEFAULT_ONLINE_SOURCES`: the storefront and the customer portal.
pub const DEFAULT_ONLINE_SOURCES: [&str; 2] = ["web", "b2b_portal"];

/// `COST_BILL_STATUSES`: approved, partly paid and paid bills count as cost.
pub const COST_BILL_STATUSES: [&str; 3] = ["approved", "partial", "paid"];

/// `METRIC_CATALOGUE[metric].unit`: the unit a benefit gets when it has none
/// of its own. `None` for an unknown metric as well.
pub fn metric_unit(metric: &str) -> Option<&'static str> {
    match metric {
        "desk_tickets_by_tag" => Some("tickets"),
        "commerce_repeat_online_share" => Some("%"),
        "books_days_to_pay" => Some("days"),
        "time_hours_per_week_by_tag" => Some("hours"),
        _ => None,
    }
}

/// `isMetric(value)`.
pub fn is_metric(value: &str) -> bool {
    BENEFIT_METRICS.contains(&value)
}

/// `metricIsMeasured(metric)`: whether the monthly sweep measures it (every
/// metric of the catalogue but `manual`).
pub fn metric_is_measured(metric: &str) -> bool {
    is_metric(metric) && metric != "manual"
}

// ── Parameters ──────────────────────────────────────────────────────────────

/// `z.string().trim().min(1).max(max)` / `z.string().min(1).max(max)`.
fn string_param(value: &Value, trim: bool, max: usize) -> Option<String> {
    let text = value.as_str()?;
    let text = if trim { js_trim(text) } else { text };
    (utf16_len(text) >= 1 && utf16_len(text) <= max).then(|| text.to_owned())
}

/// `BENEFIT_METRIC_PARAMS[metric]`: the parameters checked as the strict Zod
/// object does, with text trimmed; `None` when they do not fit.
fn read_params(metric: &str, params: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    let allowed: &[&str] = match metric {
        "desk_tickets_by_tag" | "time_hours_per_week_by_tag" => &["tag"],
        "commerce_repeat_online_share" => &["sources"],
        "books_supplier_cost" => &["supplierId"],
        _ => &[],
    };
    if params.keys().any(|key| !allowed.contains(&key.as_str())) {
        return None;
    }
    match metric {
        "desk_tickets_by_tag" | "time_hours_per_week_by_tag" => {
            let tag = string_param(params.get("tag")?, true, 100)?;
            out.insert("tag".to_owned(), json!(tag));
        }
        "commerce_repeat_online_share" => {
            if let Some(sources) = params.get("sources") {
                let items = sources.as_array()?;
                if items.is_empty() || items.len() > 20 {
                    return None;
                }
                let read: Option<Vec<String>> = items
                    .iter()
                    .map(|item| string_param(item, true, 50))
                    .collect();
                out.insert("sources".to_owned(), json!(read?));
            }
        }
        "books_supplier_cost" => {
            let id = string_param(params.get("supplierId")?, false, 255)?;
            out.insert("supplierId".to_owned(), json!(id));
        }
        _ => {}
    }
    Some(out)
}

/// `metricParamsError(metric, params)`: the parameters a benefit stores for its
/// metric, checked and cleaned, or the message of the 400.
pub fn metric_params_error(metric: &str, params: &Map<String, Value>) -> Result<Value, String> {
    if !is_metric(metric) {
        return Err(format!("Unknown metric '{metric}'"));
    }
    read_params(metric, params)
        .map(Value::Object)
        .ok_or_else(|| format!("Invalid parameters for the '{metric}' metric"))
}

// ── Months ──────────────────────────────────────────────────────────────────

const DAY_MS: i64 = 86_400_000;

/// A `YYYY-MM` month in UTC (`MonthRange`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonthRange {
    pub period: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub days: i64,
}

fn month_start_ms(year: i64, month0: i64) -> i64 {
    // Months past 11 or before 0 roll over, as `Date.UTC` does.
    let year = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    days_from_civil(year, month, 1) * DAY_MS
}

/// The year and 1-based month of an instant (UTC).
fn year_month(ms: i64) -> (i64, i64) {
    let (year, month, _) = civil_from_days(ms.div_euclid(DAY_MS));
    (year, month)
}

/// `periodOf(date)`: `2026-10`.
pub fn period_of(ms: i64) -> String {
    let (year, month) = year_month(ms);
    format!("{year:04}-{month:02}")
}

/// `previousPeriod(now)`: the month before the one `now` falls in.
pub fn previous_period(now_ms: i64) -> String {
    let (year, month) = year_month(now_ms);
    period_of(month_start_ms(year, month - 2))
}

/// `nextMonthStart(now)`: the first instant of the month after the one `now`
/// falls in (UTC), in milliseconds.
pub fn next_month_start_ms(now_ms: i64) -> i64 {
    let (year, month) = year_month(now_ms);
    month_start_ms(year, month)
}

/// `monthRange(period)`.
pub fn month_range(period: &str) -> MonthRange {
    let mut parts = period.split('-');
    let year: i64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(1970);
    let month: i64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(1);
    let start_ms = month_start_ms(year, month - 1);
    let end_ms = month_start_ms(year, month);
    MonthRange {
        period: period.to_owned(),
        start_ms,
        end_ms,
        days: (end_ms - start_ms) / DAY_MS,
    }
}

/// `isFuturePeriod(period, now)`: a month after the one `now` falls in.
pub fn is_future_period(period: &str, now_ms: i64) -> bool {
    period > period_of(now_ms).as_str()
}

fn iso(ms: i64) -> String {
    iso_from_millis(ms).unwrap_or_default()
}

/// `$n::timestamp` of `iso(ms)`.
fn at(ms: i64) -> Option<PrimitiveDateTime> {
    timestamp_of_millis(ms)
}

/// `$n::date` of `iso(ms).slice(0, 10)`.
fn day(ms: i64) -> Option<Date> {
    offset_of_millis(ms).map(time::OffsetDateTime::date)
}

/// `round(value, places)::text`.
fn rounded_text(value: impl Into<Expr>, places: i32) -> Expr {
    sea_orm::ExprTrait::cast_as(Func::round_with_precision(value.into(), places), "text")
}

/// `jsonb_column @> '["tag"]'`.
fn tagged(column: impl sea_orm::sea_query::IntoColumnRef, tag: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::contains(Expr::col(column), json!([tag]))
}

// ── Measuring ───────────────────────────────────────────────────────────────

fn text_param(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `measureMetric(db, metric, params, period)`: one aggregate query, the value
/// as text, or `None` when there is nothing to measure that month (and always
/// for `manual` and an unknown metric).
pub async fn measure_metric(
    db: &PgPool,
    metric: &str,
    params: &Value,
    period: &str,
) -> Result<Option<String>, DbErr> {
    let range = month_range(period);
    match metric {
        "desk_tickets_by_tag" => desk_tickets_by_tag(db, params, &range).await,
        "commerce_repeat_online_share" => commerce_repeat_online_share(db, params, &range).await,
        "books_days_to_pay" => books_days_to_pay(db, &range).await,
        "books_supplier_cost" => books_supplier_cost(db, params, &range).await,
        "time_hours_per_week_by_tag" => time_hours_per_week_by_tag(db, params, &range).await,
        _ => Ok(None),
    }
}

async fn desk_tickets_by_tag(
    db: &PgPool,
    params: &Value,
    range: &MonthRange,
) -> Result<Option<String>, DbErr> {
    use helpdesk_tickets::Column;
    // `count(*)::text`.
    let count = helpdesk_tickets::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .filter(Column::CreatedAt.gte(at(range.start_ms)))
        .filter(Column::CreatedAt.lt(at(range.end_ms)))
        .filter(tagged(
            (helpdesk_tickets::Entity, Column::Tags),
            &text_param(params, "tag"),
        ))
        .count(&orm(db))
        .await?;
    Ok(Some(count.to_string()))
}

/// `exists (select 1 from orders p where p.<buyer> = orders.<buyer> and
/// p.created_at < orders.created_at and p.deleted_at is null and p.status <>
/// 'cancelled')`: the buyer ordered before.
fn ordered_before(buyer: orders::Column) -> Expr {
    use orders::Column;
    use sea_orm::ExprTrait as _;
    let earlier = Alias::new("p");
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from_as(orders::Entity, earlier.clone())
            .cond_where(
                Condition::all()
                    .add(
                        Expr::col((earlier.clone(), buyer))
                            .equals((orders::Entity, buyer)),
                    )
                    .add(
                        Expr::col((earlier.clone(), Column::CreatedAt))
                            .lt(Expr::col((orders::Entity, Column::CreatedAt))),
                    )
                    .add(Expr::col((earlier.clone(), Column::DeletedAt)).is_null())
                    .add(Expr::col((earlier, Column::Status)).ne("cancelled")),
            )
            .to_owned(),
    )
}

async fn commerce_repeat_online_share(
    db: &PgPool,
    params: &Value,
    range: &MonthRange,
) -> Result<Option<String>, DbErr> {
    use orders::Column;
    let sources: Vec<String> = match params.get("sources").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => DEFAULT_ONLINE_SOURCES
            .iter()
            .map(|source| (*source).to_owned())
            .collect(),
    };
    // `count(*) filter (where o.source = any($3)) * 100.0 / nullif(count(*), 0)`.
    let online = Func::count(Expr::case(Column::Source.is_in(sources), 1));
    let all = Func::count(Expr::col(Asterisk));
    let share = sea_orm::ExprTrait::div(
        sea_orm::ExprTrait::mul(
            online,
            sea_orm::ExprTrait::cast_as(Expr::val("100.0"), "numeric"),
        ),
        Func::cust("nullif").arg(all).arg(0),
    );
    // A repeat order: its buyer (the counterparty, else the legacy customer)
    // ordered before.
    let repeat = Condition::any()
        .add(
            Condition::all()
                .add(Column::CounterpartyId.is_not_null())
                .add(ordered_before(Column::CounterpartyId)),
        )
        .add(
            Condition::all()
                .add(Column::CounterpartyId.is_null())
                .add(Column::CustomerId.is_not_null())
                .add(ordered_before(Column::CustomerId)),
        );
    let value: Option<Option<String>> = orders::Entity::find()
        .select_only()
        .expr(rounded_text(share, 4))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.ne("cancelled"))
        .filter(Column::CreatedAt.gte(at(range.start_ms)))
        .filter(Column::CreatedAt.lt(at(range.end_ms)))
        .filter(repeat)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(value.flatten())
}

#[allow(
    clippy::disallowed_methods,
    reason = "an average of extract(epoch from paid_at - issue_date), which SeaQuery cannot \
              write, in Postgres's numeric arithmetic: its rounded text is what \
              benefit-metrics.ts stores"
)]
async fn books_days_to_pay(db: &PgPool, range: &MonthRange) -> Result<Option<String>, DbErr> {
    let (year, month) = year_month(range.start_ms);
    let issued_after = iso(month_start_ms(year - 1, month - 1));
    sqlx::query_scalar(
        "select round(avg(extract(epoch from (paid_at - issue_date)) / 86400.0)::numeric, 4)::text
         from invoices
         where deleted_at is null and type = 'standard' and status = 'paid'
           and paid_at >= $1::timestamp and paid_at < $2::timestamp
           and issue_date >= $3::timestamp",
    )
    .bind(iso(range.start_ms))
    .bind(iso(range.end_ms))
    .bind(issued_after)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

async fn books_supplier_cost(
    db: &PgPool,
    params: &Value,
    range: &MonthRange,
) -> Result<Option<String>, DbErr> {
    use bills::Column;
    let (year, month) = year_month(range.end_ms);
    let from = month_start_ms(year - 1, month - 1);
    let supplier = text_param(params, "supplierId");
    // `round(coalesce(sum(total), 0)::numeric, 2)::text`.
    let total = sea_orm::ExprTrait::cast_as(
        Func::coalesce([
            Expr::from(Func::sum(Expr::col((bills::Entity, Column::Total)))),
            Expr::val(0),
        ]),
        "numeric",
    );
    let value: Option<Option<String>> = bills::Entity::find()
        .select_only()
        .expr(rounded_text(total, 2))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Type.eq("standard"))
        .filter(Column::Status.is_in(COST_BILL_STATUSES))
        .filter(
            Condition::any()
                .add(Column::ContactId.eq(supplier.as_str()))
                .add(Column::CounterpartyId.eq(supplier.as_str())),
        )
        .filter(Column::IssueDate.gte(at(from)))
        .filter(Column::IssueDate.lt(at(range.end_ms)))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(value.flatten())
}

async fn time_hours_per_week_by_tag(
    db: &PgPool,
    params: &Value,
    range: &MonthRange,
) -> Result<Option<String>, DbErr> {
    use time_entries::Column;
    let days = i32::try_from(range.days).unwrap_or(30);
    // `round(coalesce(sum(te.duration), 0)::numeric * 7 / (60 * days), 4)::text`.
    let minutes = sea_orm::ExprTrait::cast_as(
        Func::coalesce([
            Expr::from(Func::sum(Expr::col((time_entries::Entity, Column::Duration)))),
            Expr::val(0),
        ]),
        "numeric",
    );
    let per_week = sea_orm::ExprTrait::div(
        sea_orm::ExprTrait::mul(minutes, 7),
        sea_orm::ExprTrait::mul(Expr::val(60), days),
    );
    let task = time_entries::Entity::belongs_to(tasks::Entity)
        .from(Column::TaskId)
        .to(tasks::Column::Id)
        .into();
    let value: Option<Option<String>> = time_entries::Entity::find()
        .select_only()
        .expr(rounded_text(per_week, 4))
        .join(JoinType::InnerJoin, task)
        .filter(Column::DeletedAt.is_null())
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(Column::Status.ne("rejected"))
        .filter(Column::Date.gte(day(range.start_ms)))
        .filter(Column::Date.lt(day(range.end_ms)))
        .filter(tagged(
            (tasks::Entity, tasks::Column::Tags),
            &text_param(params, "tag"),
        ))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(value.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn knows_which_metrics_are_measured_and_checks_their_parameters() {
        assert!(!metric_is_measured("manual"));
        assert!(metric_is_measured("desk_tickets_by_tag"));
        assert!(!metric_is_measured("nope"));
        assert_eq!(
            metric_params_error(
                "desk_tickets_by_tag",
                &params(&json!({ "tag": "  order status " }))
            ),
            Ok(json!({ "tag": "order status" }))
        );
        assert_eq!(
            metric_params_error("desk_tickets_by_tag", &params(&json!({}))),
            Err("Invalid parameters for the 'desk_tickets_by_tag' metric".to_owned())
        );
        assert!(
            metric_params_error(
                "desk_tickets_by_tag",
                &params(&json!({ "tag": "x", "extra": 1 }))
            )
            .is_err()
        );
        assert_eq!(
            metric_params_error(
                "books_supplier_cost",
                &params(&json!({ "supplierId": "con_1" }))
            ),
            Ok(json!({ "supplierId": "con_1" }))
        );
        assert!(
            metric_params_error(
                "commerce_repeat_online_share",
                &params(&json!({ "sources": [] }))
            )
            .is_err()
        );
        assert_eq!(
            metric_params_error(
                "commerce_repeat_online_share",
                &params(&json!({ "sources": [" web "] }))
            ),
            Ok(json!({ "sources": ["web"] }))
        );
        assert_eq!(
            metric_params_error("commerce_repeat_online_share", &params(&json!({}))),
            Ok(json!({}))
        );
        assert_eq!(
            metric_params_error("manual", &params(&json!({}))),
            Ok(json!({}))
        );
        assert!(metric_params_error("manual", &params(&json!({ "a": 1 }))).is_err());
        assert_eq!(
            metric_params_error("mystery", &params(&json!({}))),
            Err("Unknown metric 'mystery'".to_owned())
        );
        assert_eq!(metric_unit("books_days_to_pay"), Some("days"));
        assert_eq!(metric_unit("books_supplier_cost"), None);
        assert_eq!(metric_unit("manual"), None);
    }

    #[test]
    fn works_in_whole_utc_months() {
        let now = 1_793_676_600_000; // 2026-11-03T03:30:00Z
        assert_eq!(period_of(now), "2026-11");
        assert_eq!(previous_period(now), "2026-10");
        assert_eq!(previous_period(1_798_761_600_000), "2026-12"); // 2027-01-01T00:00:00Z
        assert_eq!(iso(next_month_start_ms(now)), "2026-12-01T00:00:00.000Z");
        assert_eq!(
            iso(next_month_start_ms(1_798_761_599_000)),
            "2027-01-01T00:00:00.000Z"
        ); // 2026-12-31T23:59:59Z
        let range = month_range("2026-02");
        assert_eq!(
            (iso(range.start_ms), iso(range.end_ms), range.days),
            (
                "2026-02-01T00:00:00.000Z".to_owned(),
                "2026-03-01T00:00:00.000Z".to_owned(),
                28
            )
        );
        assert!(is_future_period("2026-12", now));
        assert!(!is_future_period("2026-11", now));
        assert_eq!(
            day(month_range("2026-10").end_ms),
            Date::from_calendar_date(2026, time::Month::November, 1).ok()
        );
    }
}
