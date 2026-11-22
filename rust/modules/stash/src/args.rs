//! Statement parameters and the cursor-paged lists every route file shares.
//!
//! A list pushes its conditions in the TypeScript route's order: each one
//! is a slot that is on or off, and its count drops the last one that is
//! on when a `?cursor=` was given ([`sliced`]). The conditions are typed
//! ones on the entity's columns; [`Arg`] and [`bind_scalar`] are what the
//! route files still written in SQL bind their slots with.

use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::SelectStatement;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use sqlx::Postgres;
use sqlx::postgres::PgArguments;
use sqlx::query::QueryScalar;
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};

use crate::table::Table;

/// One statement parameter.
#[derive(Debug, Clone)]
pub(crate) enum Arg {
    Bool(bool),
    Text(Option<String>),
    Int(Option<i64>),
}

impl Arg {
    pub(crate) fn text(value: impl Into<String>) -> Self {
        Self::Text(Some(value.into()))
    }

    pub(crate) fn opt(value: Option<&str>) -> Self {
        Self::Text(value.map(str::to_owned))
    }
}

/// Bind `args` in order onto a statement answering one column.
pub(crate) fn bind_scalar<O>(
    mut query: QueryScalar<'_, Postgres, O, PgArguments>,
    args: Vec<Arg>,
) -> QueryScalar<'_, Postgres, O, PgArguments> {
    for arg in args {
        query = match arg {
            Arg::Bool(flag) => query.bind(flag),
            Arg::Text(text) => query.bind(text),
            Arg::Int(number) => query.bind(number),
        };
    }
    query
}

/// The conditions of a count: with a `?cursor=`, TypeScript counts with
/// `conditions.slice(0, -1)`, which drops the cursor condition, or the last
/// condition that was pushed when the cursor row is gone.
pub(crate) fn sliced(mut on: Vec<bool>, cursor_given: bool) -> Vec<bool> {
    if cursor_given && let Some(last) = on.iter().rposition(|on| *on) {
        on[last] = false;
    }
    on
}

/// The conditions of `slots` that are on, in push order, as one `and(…)`.
pub(crate) fn all_on(slots: &[Option<Condition>], on: &[bool]) -> Condition {
    slots
        .iter()
        .zip(on)
        .filter(|(_, on)| **on)
        .filter_map(|(slot, _)| slot.clone())
        .fold(Condition::all(), Condition::add)
}

/// Which slots are on: those that were pushed.
pub(crate) fn pushed(slots: &[Option<Condition>]) -> Vec<bool> {
    slots.iter().map(Option::is_some).collect()
}

/// The keyset operands of a cursor row: its `createdAt` as JavaScript read
/// it (milliseconds) and its id.
pub(crate) type CursorRow = (PrimitiveDateTime, String);

/// One `new Date()` the route both writes as JSON (`toISOString()`) and
/// binds to `timestamp` columns (UTC, to the millisecond, as Drizzle bound
/// it).
pub(crate) fn now_stamped() -> (String, PrimitiveDateTime) {
    let at = time::OffsetDateTime::now_utc();
    (
        weldsuite_events::iso_timestamp(at),
        weldsuite_db::utc_timestamp(at),
    )
}

/// A `timestamp` as JavaScript reads it: to the millisecond.
pub(crate) fn millis(at: PrimitiveDateTime) -> PrimitiveDateTime {
    weldsuite_db::utc_timestamp(at.assume_utc())
}

/// A `timestamp` as `toISOString()` writes it.
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `$n::timestamp` of a `toISOString()` the route holds
/// (`2026-10-29T07:00:00.123Z`): Postgres keeps the wall clock and drops the
/// `Z`. `Err` is the failed cast (the route's 500).
pub(crate) fn timestamp_of(text: &str) -> Result<PrimitiveDateTime, DbErr> {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    PrimitiveDateTime::parse(text, format).map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{text}\""
        ))
    })
}

/// `select createdAt, id from <table> where id = cursor limit 1`: the
/// keyset operands, `None` when the row is gone (or has no `createdAt`,
/// `if (cur?.createdAt)`). The lookup runs before the route's `try`.
pub(crate) async fn cursor_row<E: EntityTrait>(
    db: &PgPool,
    created_at: E::Column,
    id: E::Column,
    cursor: &str,
) -> Result<Option<CursorRow>, DbErr> {
    let row: Option<(Option<PrimitiveDateTime>, String)> = E::find()
        .select_only()
        .column(created_at)
        .column(id)
        .filter(id.eq(cursor))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.and_then(|(at, id)| Some((millis(at?), id))))
}

/// `or(lt(t.createdAt, at), and(eq(t.createdAt, at), lt(t.id, id)))`.
pub(crate) fn before<C: ColumnTrait>(created_at: C, id: C, (at, cursor_id): &CursorRow) -> Condition {
    Condition::any().add(created_at.lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(id.lt(cursor_id.as_str())),
    )
}

/// `.limit(limit + 1)` on a statement: none when JavaScript's limit is `NaN`
/// or below `-1` (Drizzle leaves the LIMIT out).
pub(crate) fn limit_plus_one(select: &mut SelectStatement, limit: f64) {
    if let Some(limit) = crate::js::sql_limit(limit) {
        select.limit(u64::try_from(limit).unwrap_or(0));
    }
}

/// The rows of a statement built on `table.entity.select()`, as Drizzle
/// returns them.
pub(crate) async fn table_rows(
    db: &PgPool,
    table: &Table,
    select: &SelectStatement,
) -> Result<Vec<Value>, DbErr> {
    let rows = table.entity.rows(&orm(db), select).await?;
    Ok(rows.into_iter().map(|row| table.drizzle(row)).collect())
}

/// `count(*)` of the rows a statement built on `table.entity.select()`
/// matches.
pub(crate) async fn table_count(
    db: &PgPool,
    table: &Table,
    select: &SelectStatement,
) -> Result<i64, DbErr> {
    table.entity.count(&orm(db), select).await
}

/// The keyset operands of a cursor row read by its `createdAt`: the time as
/// JavaScript read it (milliseconds) and the id. `None` when the row is gone
/// or has no `createdAt` (`if (cur?.createdAt)`). For the route files still
/// written in SQL.
pub(crate) async fn created_cursor(
    db: &PgPool,
    sql: &'static str,
    cursor: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?;
    Ok(row.and_then(|(created_at, id)| {
        created_at
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .map(|stamp| (stamp, id))
    }))
}

/// `select createdAt, id from <table> where id = $1 limit 1`.
macro_rules! cursor_sql {
    ($table:literal) => {
        concat!(
            "select to_jsonb(t.created_at)#>>'{}', t.id from \"",
            $table,
            "\" t where t.id = $1 limit 1"
        )
    };
}
pub(crate) use cursor_sql;

/// `hasMore = rows.length > limit`, `data = hasMore ? rows.slice(0, limit) :
/// rows`, `nextCursor = hasMore && data.length > 0 ? last.id : null`.
pub(crate) fn page_of(rows: Vec<Value>, limit: f64) -> (Vec<Value>, bool, Option<String>) {
    // `rows.length > limit` is false for a NaN limit.
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data = if has_more {
        #[allow(clippy::cast_possible_truncation)]
        crate::js::js_slice(rows, limit as i64)
    } else {
        rows
    };
    let cursor = if has_more {
        data.last()
            .and_then(|row| crate::js::text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    (data, has_more, cursor)
}

/// `cursorPagination(totalCount, hasMore, nextCursor)`.
pub(crate) fn pagination(
    total: i64,
    has_more: bool,
    cursor: Option<String>,
) -> weldsuite_kit::Pagination {
    weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor)
}

/// `list(c, data, cursorPagination(totalCount, hasMore, nextCursor))` from a
/// `limit + 1` page.
pub(crate) fn page_list(rows: Vec<Value>, limit: f64, total: i64) -> Response {
    let (data, has_more, cursor) = page_of(rows, limit);
    weldsuite_kit::List::new(data, pagination(total, has_more, cursor)).into_response()
}

/// `c.json({ data, pagination, <extra>: value })` from a `limit + 1` page.
pub(crate) fn page_body(
    rows: Vec<Value>,
    limit: f64,
    total: i64,
    extra: &str,
    value: Value,
) -> Response {
    let (data, has_more, cursor) = page_of(rows, limit);
    let mut body = serde_json::Map::new();
    body.insert("data".to_owned(), Value::Array(data));
    body.insert(
        "pagination".to_owned(),
        serde_json::to_value(pagination(total, has_more, cursor)).unwrap_or(Value::Null),
    );
    body.insert(extra.to_owned(), value);
    axum::Json(Value::Object(body)).into_response()
}
