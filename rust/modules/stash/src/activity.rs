//! `/api/wms-activity`: the read-only WMS activity log (`activity_logs`):
//! the list with counts per activity type, a period summary, and the
//! activity of one entity, of one user, and the most recent.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use sea_orm::sea_query::{Asterisk, Expr, Func, Order, SelectStatement};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::INVENTORY_READ;
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::Data;
use weldsuite_kit::validation::js_date_iso;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::activity_logs::{Column, Entity};

use crate::args::{
    CursorRow, all_on, before, cursor_row, limit_plus_one, page_body, pushed, sliced, table_count,
    table_rows, timestamp_of,
};
use crate::crud::cursor_failed;
use crate::js::{js_limit, query_param, query_set, sql_limit_of};
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

/// `count(*)` of the rows of `activity_type`.
fn of_type(activity_type: &str) -> Expr {
    Func::count(Expr::case(Column::ActivityType.eq(activity_type), 1)).into()
}

/// The counts per activity type of the whole log.
async fn counts(db: &PgPool) -> Result<Value, DbErr> {
    let mut select = Entity::find()
        .select_only()
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total");
    for kind in [
        "create", "update", "delete", "receive", "ship", "pick", "pack", "adjust", "transfer",
    ] {
        select = select.column_as(of_type(kind), kind);
    }
    Ok(select
        .into_json()
        .one(&orm(db))
        .await?
        .unwrap_or_else(|| json!({})))
}

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
    let from = date_filter(query, "dateFrom");
    let to = date_filter(query, "dateTo");
    let cursor_given = query_set(query, "cursor");
    let cursor = match &cursor_given {
        Some(cursor) => {
            match cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let (Ok(from), Ok(to)) = (from, to) else {
        return internal(&"Invalid time value", message);
    };
    let read = async {
        let slots = list_conditions(query, from.as_deref(), to.as_deref(), cursor.as_ref())?;
        let on = pushed(&slots);
        let count_on = sliced(on.clone(), cursor_given.is_some());
        let mut page = ACTIVITY_LOGS.entity.select();
        page.cond_where(all_on(&slots, &on))
            .order_by((Entity, Column::CreatedAt), Order::Desc)
            .order_by((Entity, Column::Id), Order::Desc);
        limit_plus_one(&mut page, limit);
        let mut counted = ACTIVITY_LOGS.entity.select();
        counted.cond_where(all_on(&slots, &count_on));
        let rows = table_rows(&caller.db, &ACTIVITY_LOGS, &page).await?;
        let total = table_count(&caller.db, &ACTIVITY_LOGS, &counted).await?;
        let counts = counts(&caller.db).await?;
        Ok::<_, DbErr>((rows, total, counts))
    };
    match read.await {
        Ok((rows, total, counts)) => page_body(rows, limit, total, "counts", counts),
        Err(error) => internal(&error, message),
    }
}

/// The list's conditions in push order: search, activity type, entity
/// type, entity, user, warehouse, from, to, then the cursor.
fn list_conditions(
    query: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    cursor: Option<&CursorRow>,
) -> Result<Vec<Option<Condition>>, DbErr> {
    let eq = |value: Option<String>, column: Column| {
        value.map(|value| Condition::all().add(column.eq(value)))
    };
    let search = query_set(query, "search").map(|search| {
        let term = format!("%{search}%");
        Condition::any()
            .add(Column::Description.like(term.as_str()))
            .add(Column::EntityId.like(term.as_str()))
    });
    let from = from.map(timestamp_of).transpose()?;
    let to = to.map(timestamp_of).transpose()?;
    Ok(vec![
        search,
        eq(set_not_all(query, "activityType"), Column::ActivityType),
        eq(set_not_all(query, "entityType"), Column::EntityType),
        eq(query_set(query, "entityId"), Column::EntityId),
        eq(query_set(query, "userId"), Column::UserId),
        eq(set_not_all(query, "warehouseId"), Column::WarehouseId),
        from.map(|from| Condition::all().add(Column::CreatedAt.gte(from))),
        to.map(|to| Condition::all().add(Column::CreatedAt.lte(to))),
        cursor.map(|cursor| before(Column::CreatedAt, Column::Id, cursor)),
    ])
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
    let mut select = Entity::find().select_only().column_as(
        Expr::from(Func::count(Expr::col(Asterisk))),
        "totalActivities",
    );
    for (key, kind) in [
        ("receives", "receive"),
        ("shipments", "ship"),
        ("picks", "pick"),
        ("packs", "pack"),
        ("adjustments", "adjust"),
        ("transfers", "transfer"),
    ] {
        select = select.column_as(of_type(kind), key);
    }
    let mut select = select
        .column_as(
            Expr::from(Func::count_distinct(Expr::col(Column::UserId))),
            "uniqueUsers",
        )
        .filter(Column::CreatedAt.gte(utc_timestamp(start)));
    if let Some(warehouse) = warehouse {
        select = select.filter(Column::WarehouseId.eq(warehouse));
    }
    match select.into_json().one(&orm(&caller.db)).await {
        Ok(Some(Value::Object(counts))) => {
            let mut body = Map::new();
            body.insert("period".to_owned(), json!(period));
            body.insert("startDate".to_owned(), json!(iso_timestamp(start)));
            body.insert("endDate".to_owned(), json!(iso_timestamp(now)));
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

/// The newest rows a statement built on the log's `select()` matches,
/// `limit` of them.
async fn newest(
    db: &PgPool,
    condition: Condition,
    limit: Option<i64>,
) -> Result<Vec<Value>, DbErr> {
    let mut select: SelectStatement = ACTIVITY_LOGS.entity.select();
    select
        .cond_where(condition)
        .order_by((Entity, Column::CreatedAt), Order::Desc);
    if let Some(limit) = limit {
        select.limit(u64::try_from(limit).unwrap_or(0));
    }
    table_rows(db, &ACTIVITY_LOGS, &select).await
}

fn rows_of(rows: Result<Vec<Value>, DbErr>, message: &str) -> Response {
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, message),
    }
}

async fn entity(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Response {
    let condition = Condition::all()
        .add(Column::EntityType.eq(entity_type))
        .add(Column::EntityId.eq(entity_id));
    let rows = newest(
        &caller.db,
        condition,
        plain_limit(query.as_deref(), 50.0, 100.0),
    )
    .await;
    rows_of(rows, "Failed to fetch entity activity")
}

async fn user(caller: Caller, Path(user_id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let condition = Condition::all().add(Column::UserId.eq(user_id));
    let rows = newest(
        &caller.db,
        condition,
        plain_limit(query.as_deref(), 50.0, 100.0),
    )
    .await;
    rows_of(rows, "Failed to fetch user activity")
}

async fn recent(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let warehouse = set_not_all(query.as_deref(), "warehouseId");
    let condition = warehouse.map_or_else(Condition::all, |warehouse| {
        Condition::all().add(Column::WarehouseId.eq(warehouse))
    });
    let rows = newest(
        &caller.db,
        condition,
        plain_limit(query.as_deref(), 20.0, 50.0),
    )
    .await;
    rows_of(rows, "Failed to fetch recent activity")
}
