//! `/api/wms-activity`: the read-only WMS activity log (`activity_logs`):
//! the list with counts per activity type, a period summary, and the
//! activity of one entity, of one user, and the most recent.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::INVENTORY_READ;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::Data;
use weldsuite_kit::validation::js_date_iso;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_body, sliced};
use crate::crud::cursor_failed;
use crate::js::{js_limit, query_param, query_set, sql_limit, sql_limit_of};
use crate::tables::ACTIVITY_LOGS;
use crate::{Caller, StashState, internal};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([INVENTORY_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/summary", get(summary).route_layer(read()))
        .route(
            "/entity/{entity_type}/{entity_id}",
            get(entity).route_layer(read()),
        )
        .route("/user/{user_id}", get(user).route_layer(read()))
        .route("/recent", get(recent).route_layer(read()))
}

macro_rules! conditions {
    () => {
        "(not $1::boolean or (t.description like $2 or t.entity_id like $2)) \
         and (not $3::boolean or t.activity_type = $4) and (not $5::boolean or t.entity_type = $6) \
         and (not $7::boolean or t.entity_id = $8) and (not $9::boolean or t.user_id = $10) \
         and (not $11::boolean or t.warehouse_id = $12) \
         and (not $13::boolean or t.created_at >= $14::timestamp) \
         and (not $15::boolean or t.created_at <= $16::timestamp) \
         and (not $17::boolean or (t.created_at < $18::timestamp or (t.created_at = $18::timestamp and t.id < $19)))"
    };
}

const LIST_SQL: &str = concat!(
    "select to_jsonb(t) from activity_logs t where ",
    conditions!(),
    " order by t.created_at desc, t.id desc limit $20"
);

const COUNT_SQL: &str = concat!("select count(*) from activity_logs t where ", conditions!());

const COUNTS_SQL: &str = "select jsonb_build_object('total', count(*)::int, \
    'create', count(*) filter (where t.activity_type = 'create')::int, \
    'update', count(*) filter (where t.activity_type = 'update')::int, \
    'delete', count(*) filter (where t.activity_type = 'delete')::int, \
    'receive', count(*) filter (where t.activity_type = 'receive')::int, \
    'ship', count(*) filter (where t.activity_type = 'ship')::int, \
    'pick', count(*) filter (where t.activity_type = 'pick')::int, \
    'pack', count(*) filter (where t.activity_type = 'pack')::int, \
    'adjust', count(*) filter (where t.activity_type = 'adjust')::int, \
    'transfer', count(*) filter (where t.activity_type = 'transfer')::int) from activity_logs t";

/// A filter that is set and not `all`.
fn set_not_all(query: Option<&str>, name: &str) -> Option<String> {
    query_set(query, name).filter(|value| value != "all")
}

/// `new Date(q.x)` of a set date filter: its `toISOString()`, or `Err` for
/// an Invalid Date, whose `toISOString()` throws inside the route's `try`.
fn date_filter(query: Option<&str>, name: &str) -> Result<Option<String>, ()> {
    match query_set(query, name) {
        None => Ok(None),
        Some(text) => js_date_iso(&text).map(Some).ok_or(()),
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let message = "Failed to list activity logs";
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 50.0, 100.0);
    let search = query_set(query, "search").map(|search| format!("%{search}%"));
    let activity_type = set_not_all(query, "activityType");
    let entity_type = set_not_all(query, "entityType");
    let entity_id = query_set(query, "entityId");
    let user_id = query_set(query, "userId");
    let warehouse = set_not_all(query, "warehouseId");
    let from = date_filter(query, "dateFrom");
    let to = date_filter(query, "dateTo");
    let cursor_given = query_set(query, "cursor");
    let cursor = match &cursor_given {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("activity_logs"), cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let (Ok(from), Ok(to)) = (from, to) else {
        return internal(&"Invalid time value", message);
    };
    let texts = [
        search,
        activity_type,
        entity_type,
        entity_id,
        user_id,
        warehouse,
        from,
        to,
    ];
    let mut on: Vec<bool> = texts.iter().map(Option::is_some).collect();
    on.push(cursor.is_some());
    let args = |on: &[bool]| {
        let mut args = Vec::new();
        for (value, on) in texts.iter().zip(on) {
            args.push(Arg::Bool(*on));
            args.push(Arg::Text(value.clone()));
        }
        args.push(Arg::Bool(on[texts.len()]));
        args.push(Arg::opt(cursor.as_ref().map(|(at, _)| at.as_str())));
        args.push(Arg::opt(cursor.as_ref().map(|(_, id)| id.as_str())));
        args
    };
    let mut page = args(&on);
    page.push(Arg::Int(sql_limit(limit)));
    let count_on = sliced(on.clone(), cursor_given.is_some());
    let rows: Vec<Value> = match bind_scalar(sqlx::query_scalar(LIST_SQL), page)
        .fetch_all(&caller.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return internal(&error, message),
    };
    let total: i64 = match bind_scalar(sqlx::query_scalar(COUNT_SQL), args(&count_on))
        .fetch_one(&caller.db)
        .await
    {
        Ok(total) => total,
        Err(error) => return internal(&error, message),
    };
    let counts: Value = match sqlx::query_scalar(COUNTS_SQL).fetch_one(&caller.db).await {
        Ok(counts) => counts,
        Err(error) => return internal(&error, message),
    };
    page_body(
        rows.into_iter().map(|row| ACTIVITY_LOGS.js(row)).collect(),
        limit,
        total,
        "counts",
        counts,
    )
}

async fn summary(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let warehouse = set_not_all(query, "warehouseId");
    // `const { period = '7d' } = c.req.query()`: an empty value stays empty.
    let period = query_param(query, "period").unwrap_or_else(|| "7d".to_owned());
    let now = OffsetDateTime::now_utc();
    let days = match period.as_str() {
        "1d" => 1,
        "30d" => 30,
        _ => 7,
    };
    let start = now - time::Duration::days(days);
    let (start, end) = (iso_timestamp(start), iso_timestamp(now));
    let row: Result<Value, _> = sqlx::query_scalar(
        "select jsonb_build_object('totalActivities', count(*)::int, \
         'receives', count(*) filter (where t.activity_type = 'receive')::int, \
         'shipments', count(*) filter (where t.activity_type = 'ship')::int, \
         'picks', count(*) filter (where t.activity_type = 'pick')::int, \
         'packs', count(*) filter (where t.activity_type = 'pack')::int, \
         'adjustments', count(*) filter (where t.activity_type = 'adjust')::int, \
         'transfers', count(*) filter (where t.activity_type = 'transfer')::int, \
         'uniqueUsers', count(distinct t.user_id)::int) from activity_logs t \
         where t.created_at >= $1::timestamp and (not $2::boolean or t.warehouse_id = $3)",
    )
    .bind(&start)
    .bind(warehouse.is_some())
    .bind(warehouse)
    .fetch_one(&caller.db)
    .await;
    match row {
        Ok(Value::Object(counts)) => {
            let mut body = Map::new();
            body.insert("period".to_owned(), json!(period));
            body.insert("startDate".to_owned(), json!(start));
            body.insert("endDate".to_owned(), json!(end));
            body.extend(counts);
            Data(Value::Object(body)).into_response()
        }
        Ok(_) => Data(json!({})).into_response(),
        Err(error) => internal(&error, "Failed to fetch activity summary"),
    }
}

/// `Math.min(rawLimit ? Number.parseInt(rawLimit, 10) : fallback, max)` as
/// a statement LIMIT (`.limit(limit)`).
fn plain_limit(query: Option<&str>, fallback: f64, max: f64) -> Option<i64> {
    sql_limit_of(js_limit(
        query_param(query, "limit").as_deref(),
        fallback,
        max,
    ))
}

fn rows_of(rows: Result<Vec<Value>, sqlx::Error>, message: &str) -> Response {
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|row| ACTIVITY_LOGS.js(row))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, message),
    }
}

async fn entity(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Response {
    let rows = sqlx::query_scalar(
        "select to_jsonb(t) from activity_logs t where t.entity_type = $1 and t.entity_id = $2 \
         order by t.created_at desc limit $3",
    )
    .bind(entity_type)
    .bind(entity_id)
    .bind(plain_limit(query.as_deref(), 50.0, 100.0))
    .fetch_all(&caller.db)
    .await;
    rows_of(rows, "Failed to fetch entity activity")
}

async fn user(caller: Caller, Path(user_id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let rows = sqlx::query_scalar(
        "select to_jsonb(t) from activity_logs t where t.user_id = $1 order by t.created_at desc limit $2",
    )
    .bind(user_id)
    .bind(plain_limit(query.as_deref(), 50.0, 100.0))
    .fetch_all(&caller.db)
    .await;
    rows_of(rows, "Failed to fetch user activity")
}

async fn recent(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let warehouse = set_not_all(query.as_deref(), "warehouseId");
    let rows = sqlx::query_scalar(
        "select to_jsonb(t) from activity_logs t where (not $1::boolean or t.warehouse_id = $2) \
         order by t.created_at desc limit $3",
    )
    .bind(warehouse.is_some())
    .bind(warehouse)
    .bind(plain_limit(query.as_deref(), 20.0, 50.0))
    .fetch_all(&caller.db)
    .await;
    rows_of(rows, "Failed to fetch recent activity")
}
