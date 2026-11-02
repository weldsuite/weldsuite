//! Cursor lists (`lib/list-helpers.ts`, `lib/pagination.ts`): newest first
//! on `(created_at, id)`, the cursor is the last row's id, and a cursor that
//! names no row starts from the first page.
//!
//! [`list_sql!`] builds a list's two statements, at compile time, from the
//! table, the row expression and the filter. The statements share three
//! parameters: `$1` the cursor, `$2` the page size plus one, `$3` the
//! filters as one `jsonb` object (`$3->>'projectId'`), so every list binds
//! the same way whatever it filters on.

use axum::Json;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, query_values};

use crate::session::database_error;

/// `DEFAULT_LIMIT` and `MAX_LIMIT` of `lib/pagination.ts`.
pub(crate) const DEFAULT_LIMIT: i64 = 50;
pub(crate) const MAX_LIMIT: i64 = 200;

/// The page and count statements of a cursor list. `$table` is the table,
/// `$row` the JSON of one row of it (aliased `t`), `$filter` a condition on
/// `t` that may read `$3`.
macro_rules! list_sql {
    ($table:literal, $row:literal, $filter:literal) => {
        (
            concat!(
                "with cursor_row as (select date_trunc('milliseconds', created_at) as ts, id from ",
                $table,
                " where id = $1 limit 1) select ",
                $row,
                " from ",
                $table,
                " t where (",
                $filter,
                ") and (not exists (select 1 from cursor_row) or t.created_at < (select ts from cursor_row) \
                 or (t.created_at = (select ts from cursor_row) and t.id < (select id from cursor_row))) \
                 order by t.created_at desc, t.id desc limit $2"
            ),
            concat!(
                "select count(*) from ",
                $table,
                " t where (",
                $filter,
                ") and ($1::text is null or true) and ($2::bigint is null or true)"
            ),
        )
    };
}
pub(crate) use list_sql;

/// The query every list reads (`cursor`, `limit`). A route with filters
/// reads them from the same `query_values` with the same `issues`.
pub(crate) struct ListQuery {
    pub(crate) cursor: Option<String>,
    pub(crate) limit: i64,
}

impl ListQuery {
    /// `cursor: z.string().optional()`, `limit: z.coerce.number().min(1).max(200).optional()`;
    /// then [`Issues::finish`].
    pub(crate) fn read(issues: &mut Issues, raw_query: Option<&str>) -> Self {
        let fields = query_values(raw_query);
        let cursor = issues
            .text(&fields, "cursor", Presence::Optional, None, None)
            .into_option();
        let limit = issues
            .number(
                &fields,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: false,
                    min: Some(1.0),
                    max: Some(MAX_LIMIT as f64),
                },
            )
            .into_option();
        Self {
            cursor,
            limit: clamp_limit(limit),
        }
    }
}

/// `clampLimit`: missing or not positive is the default, else floored and
/// capped.
pub(crate) fn clamp_limit(raw: Option<f64>) -> i64 {
    match raw {
        Some(n) if n.is_finite() && n > 0.0 => {
            #[allow(clippy::cast_possible_truncation)] // floored and capped at 200
            let n = n.floor().min(MAX_LIMIT as f64) as i64;
            n
        }
        _ => DEFAULT_LIMIT,
    }
}

/// One page of a list as `list(c, data, cursorPagination(...))` answers it.
pub(crate) async fn list_page(
    db: &PgPool,
    (page_sql, count_sql): (&'static str, &'static str),
    query: &ListQuery,
    filters: &Value,
) -> Result<Response, ApiError> {
    list_page_mapped(db, (page_sql, count_sql), query, filters, js_row).await
}

/// [`list_page`] with each row mapped (`mapRow`).
pub(crate) async fn list_page_mapped(
    db: &PgPool,
    (page_sql, count_sql): (&'static str, &'static str),
    query: &ListQuery,
    filters: &Value,
    map: impl Fn(Value) -> Value,
) -> Result<Response, ApiError> {
    let probe = query.limit + 1;
    let mut rows: Vec<Value> = sqlx::query_scalar(page_sql)
        .bind(query.cursor.as_deref())
        .bind(probe)
        .bind(filters)
        .fetch_all(db)
        .await
        .map_err(|error| database_error(&error))?;
    let total: i64 = sqlx::query_scalar(count_sql)
        .bind(query.cursor.as_deref())
        .bind(probe)
        .bind(filters)
        .fetch_one(db)
        .await
        .map_err(|error| database_error(&error))?;
    let limit = usize::try_from(query.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row.get("id"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let data: Vec<Value> = rows.into_iter().map(map).collect();
    Ok(Json(json!({
        "data": data,
        "pagination": { "totalCount": total, "hasMore": has_more, "cursor": cursor },
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_clamp_like_clamp_limit() {
        assert_eq!(clamp_limit(None), 50);
        assert_eq!(clamp_limit(Some(0.0)), 50);
        assert_eq!(clamp_limit(Some(7.9)), 7);
        assert_eq!(clamp_limit(Some(500.0)), 200);
    }

    #[test]
    fn list_statements_are_literal() {
        let (page, count) = list_sql!("project_goals", "to_jsonb(t)", "t.deleted_at is null");
        assert!(page.contains("from project_goals t where (t.deleted_at is null)"));
        assert!(count.starts_with("select count(*) from project_goals t"));
    }
}
