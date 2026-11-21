//! Statement parameters and the cursor-paged list of the products route.
//!
//! sqlx takes literal SQL only, so a list statement has one slot per
//! condition the TypeScript route may push (`(not $n::boolean or cond)`),
//! switched on or off by a parameter, and [`Arg`] lists the parameters in
//! statement order.

use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::Postgres;
use sqlx::postgres::PgArguments;
use sqlx::query::QueryScalar;
use weldsuite_db::PgPool;

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

/// The keyset operands of a cursor row read by its `createdAt`: the time as
/// JavaScript read it (milliseconds) and the id. `None` when the row is gone
/// or has no `createdAt` (`if (cur?.createdAt)`).
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

/// `list(c, data, cursorPagination(totalCount, hasMore, nextCursor))` from a
/// `limit + 1` page.
pub(crate) fn page_list(rows: Vec<Value>, limit: f64, total: i64) -> Response {
    let (data, has_more, cursor) = page_of(rows, limit);
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}
